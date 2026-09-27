import { randomUUID } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import { parseScopeId, type ScopeId } from "../types.ts";
import type { WorldSwarmWorker } from "./world-hooks-config.ts";

/**
 * WorldWatches: standing watches whose predicate runs over WorldEvents instead of a URL or a
 * repository. Every WorldEvent that reaches /world-events is evaluated against the active
 * watches; a match fires the watch's action (and optional swarm) through the same durable
 * trigger path as a WorldHook route, once per watch and event id.
 */

export interface WorldWatchMatch {
  type?: string;
  person_id?: string;
  project?: string;
  /** Every phrase must appear (case-insensitive) somewhere in the event payload. */
  text_contains?: string[];
}

export interface WorldWatch {
  id: string;
  owner: string;
  ownerScopeId: ScopeId;
  match: WorldWatchMatch;
  action: string;
  swarm?: { workers: WorldSwarmWorker[] };
  once: boolean;
  active: boolean;
  createdAt: number;
  fired: number;
  lastFiredAt?: number;
  lastEventId?: string;
  /** Where the watch came from: an API call, or a spoken request perceived by WORLD. */
  source: "api" | "world";
  instruction?: string;
  requestedBy?: string;
}

export interface MatchableEvent {
  id: string;
  type: string;
  people?: unknown[];
  project?: string | null;
  payload: Record<string, unknown>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** Event types a watch never fires on, so a watch cannot trigger itself or a sibling request. */
export const WATCH_EXEMPT_TYPES = new Set(["world.watch_requested", "world.entity_adopted"]);

export function eventPersonIds(event: MatchableEvent): string[] {
  const ids = new Set<string>();
  for (const p of event.people ?? []) {
    if (isObj(p) && nonEmpty(p.id)) ids.add(p.id.toLowerCase());
    else if (nonEmpty(p)) ids.add(p.toLowerCase());
  }
  for (const key of ["person_id", "requested_by", "recipient", "actor"]) {
    const v = event.payload[key];
    if (nonEmpty(v)) ids.add(v.toLowerCase());
  }
  return [...ids];
}

export function matchesWatch(match: WorldWatchMatch, event: MatchableEvent): boolean {
  if (WATCH_EXEMPT_TYPES.has(event.type)) return false;
  if (match.type && match.type !== event.type) {
    if (!match.type.endsWith(".*") || !event.type.startsWith(match.type.slice(0, -1))) return false;
  }
  if (match.person_id && !eventPersonIds(event).includes(match.person_id.toLowerCase())) return false;
  if (match.project && (event.project ?? "").toLowerCase() !== match.project.toLowerCase()) return false;
  if (match.text_contains?.length) {
    const hay = JSON.stringify(event.payload).toLowerCase();
    if (!match.text_contains.every((t) => hay.includes(t.toLowerCase()))) return false;
  }
  return true;
}

function parseMatch(v: unknown): WorldWatchMatch | string {
  if (!isObj(v)) return "match must be an object";
  const out: WorldWatchMatch = {};
  for (const key of ["type", "person_id", "project"] as const) {
    if (v[key] === undefined || v[key] === null) continue;
    if (!nonEmpty(v[key])) return `match.${key} must be a non-empty string`;
    out[key] = (v[key] as string).trim();
  }
  if (v.text_contains !== undefined && v.text_contains !== null) {
    if (!Array.isArray(v.text_contains) || !v.text_contains.every(nonEmpty))
      return "match.text_contains must be an array of non-empty strings";
    out.text_contains = v.text_contains.map((t: string) => t.trim()).slice(0, 8);
  }
  if (!out.type && !out.person_id && !out.project && !out.text_contains?.length)
    return "match needs at least one of type, person_id, project, text_contains";
  return out;
}

export interface WatchDefaults {
  owner: string;
  ownerScopeId: ScopeId;
}

export function parseWatchSpec(
  body: unknown,
  defaults: WatchDefaults,
  extra: Partial<Pick<WorldWatch, "source" | "instruction" | "requestedBy">> = {},
): WorldWatch | string {
  if (!isObj(body)) return "body must be an object";
  const match = parseMatch(body.match);
  if (typeof match === "string") return match;
  if (!nonEmpty(body.action)) return "action is required";
  const owner = nonEmpty(body.owner) ? body.owner.trim() : defaults.owner;
  const scope = nonEmpty(body.ownerScopeId) ? (body.ownerScopeId.trim() as ScopeId) : defaults.ownerScopeId;
  if (parseScopeId(scope).kind === null) return "ownerScopeId must be a valid scope such as personal:<principal>";
  let swarm: WorldWatch["swarm"];
  if (body.swarm !== undefined && body.swarm !== null) {
    const workers = isObj(body.swarm) ? body.swarm.workers : undefined;
    if (!Array.isArray(workers) || !workers.length) return "swarm needs at least one worker";
    const parsed: WorldSwarmWorker[] = [];
    for (const w of workers) {
      if (!isObj(w) || !nonEmpty(w.role) || !nonEmpty(w.name) || !nonEmpty(w.brief))
        return "each swarm worker needs role, name, and brief";
      parsed.push({ role: w.role.trim(), name: w.name.trim(), brief: w.brief.trim() });
    }
    swarm = { workers: parsed };
  }
  return {
    id: `ww_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    owner,
    ownerScopeId: scope,
    match,
    action: body.action.trim().slice(0, 4_000),
    ...(swarm ? { swarm } : {}),
    once: body.once === true,
    active: true,
    createdAt: Date.now(),
    fired: 0,
    source: extra.source ?? "api",
    ...(extra.instruction ? { instruction: extra.instruction } : {}),
    ...(extra.requestedBy ? { requestedBy: extra.requestedBy } : {}),
  };
}

export interface WorldWatchStore {
  list(): Promise<WorldWatch[]>;
  get(id: string): Promise<WorldWatch | null>;
  put(watch: WorldWatch): Promise<void>;
  delete(id: string): Promise<boolean>;
  /** Records one firing; deactivates a once-watch. */
  markFired(id: string, eventId: string): Promise<void>;
}

export function createWorldWatchStore(map: DurableMap<WorldWatch>): WorldWatchStore {
  return {
    async list() {
      return (await map.all()).sort((a, b) => a.createdAt - b.createdAt);
    },
    get: (id) => map.get(id),
    put: (watch) => map.put(watch.id, watch),
    async delete(id) {
      const existing = await map.get(id);
      if (!existing) return false;
      await map.delete(id);
      return true;
    },
    async markFired(id, eventId) {
      const cur = await map.get(id);
      if (!cur) return;
      await map.merge(id, {
        fired: cur.fired + 1,
        lastFiredAt: Date.now(),
        lastEventId: eventId,
        ...(cur.once ? { active: false } : {}),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// world.watch_requested -> watch spec. One model call through QM's own harness,
// with a deterministic fallback so a spoken request never silently vanishes.

export const WATCH_SPEC_PROMPT = [
  "Turn a spoken standing instruction into a JSON watch spec for an event-driven agent system.",
  "The system perceives the physical world and emits WorldEvents of these types:",
  "person.encountered, conversation.completed, decision.detected, commitment.detected,",
  "customer_feedback.detected, feature_request.detected, physical_bug.detected, object.state_changed, object.last_seen.",
  "Every event has people[].id (lowercase person ids), project, and a payload whose text is searchable.",
  "Output ONLY a JSON object, no prose, with keys:",
  '  "match": { "type"?: string, "person_id"?: string, "project"?: string, "text_contains"?: [string] },',
  '  "action": string (standing orders for the agent when the watch fires, imperative, drafts only, never contact anyone),',
  '  "once": boolean (true when the instruction says next time / once; false for always / whenever).',
  "Use the fewest match fields that capture the intent. Use person_id only when a known person id is given.",
  "text_contains holds 1-3 short lowercase keywords (for example pricing, price, cost).",
].join("\n");

export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

const STOP = new Set([
  "next",
  "time",
  "whenever",
  "when",
  "brings",
  "bring",
  "mentions",
  "mention",
  "talks",
  "about",
  "asks",
  "prep",
  "prepare",
  "draft",
  "with",
  "that",
  "this",
  "then",
  "the",
  "and",
  "for",
  "him",
  "her",
  "them",
  "again",
]);

/** Deterministic parse of "next time <person> brings up <topic>, <action>". */
export function fallbackWatchSpec(instruction: string, personId?: string): Record<string, unknown> {
  const lower = instruction.toLowerCase();
  const topic =
    /(?:brings? up|mentions?|talks? about|asks? about|says)\s+([a-z0-9 _-]{2,40}?)(?:[,.;]|\s+(?:prep|draft|then|remind|send|make)\b|$)/.exec(
      lower,
    )?.[1] ?? "";
  const words = topic
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9_-]/g, ""))
    .filter((w) => w.length > 2 && !STOP.has(w))
    .slice(0, 2);
  const action = /,\s*(.+)$/.exec(instruction)?.[1]?.trim() ?? instruction;
  return {
    match: {
      ...(personId ? { person_id: personId } : {}),
      ...(words.length ? { text_contains: words } : {}),
    },
    action: `Standing watch from the owner: "${instruction}". ${action}. Keep everything as drafts; never contact anyone.`,
    once: /\bnext time\b|\bonce\b/.test(lower),
  };
}

export async function specFromInstruction(
  instruction: string,
  personId: string | undefined,
  oneShot: ((system: string, prompt: string) => Promise<string | undefined>) | undefined,
): Promise<{ spec: Record<string, unknown>; via: "model" | "fallback" }> {
  if (oneShot) {
    try {
      const out = await oneShot(
        WATCH_SPEC_PROMPT,
        `Instruction: ${instruction}\n${personId ? `Known person id mentioned: ${personId}\n` : ""}`,
      );
      const parsed = extractJsonObject(out ?? "");
      if (isObj(parsed) && isObj(parsed.match) && nonEmpty(parsed.action)) {
        if (personId && !parsed.match.person_id) parsed.match.person_id = personId;
        return { spec: parsed, via: "model" };
      }
    } catch {
      /* fall back */
    }
  }
  return { spec: fallbackWatchSpec(instruction, personId), via: "fallback" };
}
