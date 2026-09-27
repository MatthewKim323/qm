import { createHmac } from "node:crypto";
import type { VerifierInput } from "../webhooks/verifiers.ts";
import { runTrigger, type TriggerDeps } from "../triggers/run-trigger.ts";
import { buildWorldEventWakeEnvelope, capForEscaping } from "../core/wake-envelope.ts";
import { constantTimeEqual } from "../util/crypto.ts";
import { reportFailure } from "../util/errors.ts";
import type { WorldHookRoute, WorldHooksConfig, WorldSwarmWorker } from "./world-hooks-config.ts";
import type { WorldSwarmTracker } from "./world-swarm-tracker.ts";
import {
  matchesWatch,
  parseWatchSpec,
  specFromInstruction,
  type WorldWatch,
  type WorldWatchStore,
} from "./world-watches.ts";
import {
  adoptionOrders,
  entityEventOrders,
  entityKey,
  entityThread,
  mentionedEntityKeys,
  type EntityKind,
  type WorldEntity,
  type WorldEntityStore,
} from "./world-entities.ts";
import type { ScopeId } from "../types.ts";

export interface WorldEvent {
  id: string;
  type: string;
  ts: string;
  source: string;
  confidence?: number;
  people?: unknown[];
  project?: string | null;
  payload: Record<string, unknown>;
}

export type WorldHookResult =
  | {
      status: 202;
      body: {
        ok: true;
        eventId: string;
        type: string;
        fireKey?: string;
        threadRef?: string;
        swarm?: string[];
        watches?: string[];
        entities?: string[];
        watch?: WorldWatch;
        entity?: WorldEntity;
      };
    }
  | { status: 200; body: { ok: true; eventId: string; type: string; routed: false; duplicate?: true } }
  | { status: 400; body: { error: "bad_request"; message: string } }
  | { status: 401; body: { error: "unauthorized" } };

export interface WorldHookReceiver {
  deliver(req: { headers: VerifierInput["headers"]; rawBody: string }): Promise<WorldHookResult>;
  /** Same bearer / HMAC check as deliver, for the WorldWatch and entity admin routes. */
  authorize(headers: VerifierInput["headers"], rawBody: string): boolean;
  watches?: WorldWatchStore;
  entities?: WorldEntityStore;
  tracker?: WorldSwarmTracker;
  /** The spawn request QM prepared for a routed world event, by its swarm requestId. */
  spawnPlan(requestId: string): WorldSpawnBody | undefined;
  createWatch(body: unknown): Promise<WorldWatch | string>;
  adopt(req: { kind: EntityKind; entityId: string; label: string; via?: "api" | "world"; eventId?: string }): Promise<{
    entity: WorldEntity;
    created: boolean;
  }>;
}

export interface WorldHookReceiverDeps extends TriggerDeps {
  config: WorldHooksConfig;
  tracker?: WorldSwarmTracker;
  watches?: WorldWatchStore;
  entities?: WorldEntityStore;
  /** One model call (QM's harness oneShot) that turns a spoken instruction into a watch spec. */
  oneShot?: (system: string, prompt: string) => Promise<string | undefined>;
}

const MAX_EVENT_CHARS = 16_000;
const EVENT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const EVENT_TYPE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function header(headers: VerifierInput["headers"], name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function authorized(secret: string, headers: VerifierInput["headers"], rawBody: string): boolean {
  const bearer = header(headers, "authorization");
  if (bearer?.startsWith("Bearer ")) return constantTimeEqual(bearer.slice("Bearer ".length).trim(), secret);
  const sig = header(headers, "x-signature");
  if (!sig) return false;
  const hex = sig.startsWith("sha256=") ? sig.slice("sha256=".length) : sig;
  return constantTimeEqual(hex, createHmac("sha256", secret).update(rawBody).digest("hex"));
}

export function parseWorldEvent(rawBody: string): WorldEvent | string {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return "body must be JSON";
  }
  if (!isObj(body)) return "body must be a WorldEvent object";
  if (typeof body.id !== "string" || !EVENT_ID.test(body.id)) return "id must be a short stable event id";
  if (typeof body.type !== "string" || !EVENT_TYPE.test(body.type)) return "type must look like noun.verb";
  if (typeof body.ts !== "string" || Number.isNaN(Date.parse(body.ts))) return "ts must be an ISO timestamp";
  if (typeof body.source !== "string" || !body.source.trim()) return "source is required";
  if (
    body.confidence !== undefined &&
    (typeof body.confidence !== "number" || body.confidence < 0 || body.confidence > 1)
  )
    return "confidence must be between 0 and 1";
  if (body.people !== undefined && !Array.isArray(body.people)) return "people must be an array";
  if (body.project !== undefined && body.project !== null && typeof body.project !== "string")
    return "project must be a string or null";
  if (!isObj(body.payload)) return "payload must be an object";
  return body as unknown as WorldEvent;
}

/** Event JSON carried inside the spawn text; the swarm text cap is 16 KiB. */
const MAX_SPAWN_EVENT_CHARS = 11_000;

/** How a worker reports: once, to the member that spawned it, without waking it for a new turn. */
export const WORKER_REPORT_RULE = [
  'Report to the root exactly once, when your verifying command has passed: POST $AGENT_API_URL/v1/swarm with {"action":"send","requestId":"report","audience":"parent","notify":false,"text":<your report>}. That report ends your work.',
  'If your brief has you message another worker, send it once with that worker\'s id as audience and "notify":false. If your brief has you wait for another worker, make ONE blocking call instead of reading or polling: curl -sS -m 100 -H "x-agent-capability: $AGENT_API_TOKEN" "$AGENT_API_URL/v1/swarm?await=peer&name=<worker name>&waitMs=60000" (it returns {done, messages}); never sleep-loop on ?read=1.',
  "Never contact anyone outside QM; drafts only.",
].join(" ");

export interface WorldSpawnBody {
  action: "spawn";
  requestId: string;
  settings: { textBytes: number };
  contexts: Array<{ group: string; role: string; name: string; brief: string }>;
  text: string;
}

/** The exact spawn request for a routed world event; QM holds it so the root never copies JSON. */
export function worldSpawnBody(
  event: WorldEvent,
  route: { swarm?: { workers: WorldSwarmWorker[] } },
  requestPrefix = "world",
): WorldSpawnBody | undefined {
  if (!route.swarm) return undefined;
  const eventJson = JSON.stringify(event);
  const carried =
    eventJson.length <= MAX_SPAWN_EVENT_CHARS ? eventJson : `${eventJson.slice(0, MAX_SPAWN_EVENT_CHARS)}…[truncated]`;
  return {
    action: "spawn",
    requestId: `${requestPrefix}:${event.id}`,
    settings: { textBytes: 16_384 },
    contexts: route.swarm.workers.map((w) => ({
      group: `world:${event.type}`,
      role: w.role,
      name: w.name,
      brief: w.brief,
    })),
    text: [
      `World event ${event.id} (${event.type}). Do only the role in your brief above; the event is below, so there is nothing to fetch or wait for.`,
      WORKER_REPORT_RULE,
      `<world-event-json>${carried}</world-event-json>`,
    ].join("\n"),
  };
}

export function worldSwarmPlan(
  event: WorldEvent,
  route: { swarm?: { workers: WorldSwarmWorker[] } },
  requestPrefix = "world",
): string | undefined {
  const spawn = worldSpawnBody(event, route, requestPrefix);
  if (!spawn) return undefined;
  const names = spawn.contexts.map((c) => c.name).join(", ");
  return [
    "Run this as a swarm in three steps. The swarm plumbing is already decided; do not explore the swarm API or write spawn JSON yourself.",
    `1) Spawn the ${spawn.contexts.length} workers (${names}) with ONE execute call. QM already holds the full spawn request, world event included, so there is no separate send: curl -sS -m 60 -H "x-agent-capability: $AGENT_API_TOKEN" -H 'content-type: application/json' --data '{"action":"spawn_plan","requestId":"${spawn.requestId}"}' "$AGENT_API_URL/v1/swarm"`,
    `2) Wait for every worker with ONE blocking execute call (timeout_seconds 300; never poll ?read=1, never sleep): curl -sS -m 295 -H "x-agent-capability: $AGENT_API_TOKEN" "$AGENT_API_URL/v1/swarm?await=workers&waitMs=280000". It returns {done, reports, pending}; only if done is false, make the same call once more.`,
    "3) Write your summary artifact and run your verifying command in one execute call, then reply with one short summary of what each worker produced and which items await human approval before any external send.",
  ].join("\n");
}

function eventPayloadText(event: WorldEvent): string {
  const pretty = JSON.stringify(event, null, 2);
  const kept = capForEscaping(pretty, MAX_EVENT_CHARS, "head");
  return kept.length < pretty.length ? `${kept}\n…[truncated]` : kept;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function createWorldHookReceiver(deps: WorldHookReceiverDeps): WorldHookReceiver {
  const { config, tracker, watches, entities, oneShot, ...triggerDeps } = deps;
  const spawnPlans = new Map<string, WorldSpawnBody>();
  const rememberSpawn = (body: WorldSpawnBody | undefined) => {
    if (!body) return;
    spawnPlans.set(body.requestId, body);
    if (spawnPlans.size > 200) spawnPlans.delete(spawnPlans.keys().next().value!);
  };

  interface Fire {
    title: string;
    owner: string;
    ownerScopeId: ScopeId;
    action: string;
    swarmPlan?: string;
    fireKey: string;
    threadRef: string;
    track: boolean;
    workers?: string[];
  }

  async function fire(event: WorldEvent, f: Fire): Promise<boolean> {
    if (await triggerDeps.idempotency.committed(f.fireKey)) return false;
    const payload = eventPayloadText(event);
    const input = buildWorldEventWakeEnvelope({
      eventId: event.id,
      eventType: event.type,
      source: event.source,
      at: new Date(),
      action: f.action,
      ...(f.swarmPlan ? { swarmPlan: f.swarmPlan } : {}),
      payload,
    });
    void runTrigger(triggerDeps, {
      title: f.title,
      owner: f.owner,
      ownerScopeId: f.ownerScopeId,
      input,
      securityScreenData: payload,
      fireKey: f.fireKey,
      threadRef: f.threadRef,
      surface: "webhook",
    })
      .then((outcome) => {
        console.log(
          `[worldhooks] ${f.fireKey} ran=${outcome.ran} status=${outcome.status ?? "-"} session=${outcome.sessionId ?? "-"}${outcome.note ? ` note=${outcome.note}` : ""}`,
        );
      })
      .catch((e: unknown) => reportFailure("worldhooks: fire", e, f.fireKey));
    if (tracker && f.track) {
      const anchor = event.payload.anchor_track_id ?? event.payload.track_id;
      void tracker
        .track({
          fireKey: f.fireKey,
          eventId: event.id,
          type: event.type,
          scopeId: f.ownerScopeId,
          ...(typeof anchor === "number" ? { anchorTrackId: anchor } : {}),
          people: (event.people ?? [])
            .map((p) => {
              if (isObj(p) && typeof p.id === "string") return p.id;
              return typeof p === "string" ? p : "";
            })
            .filter(Boolean),
          project: event.project ?? null,
          ...(f.workers?.length ? { plannedWorkers: f.workers } : {}),
          ...(str(event.payload.feature) ? { feature: str(event.payload.feature)! } : {}),
        })
        .catch((e: unknown) => reportFailure("worldhooks: track", e, f.fireKey));
    }
    return true;
  }

  async function createWatch(
    body: unknown,
    extra: Parameters<typeof parseWatchSpec>[2] = {},
  ): Promise<WorldWatch | string> {
    if (!watches) return "WorldWatches need a durable store";
    const watch = parseWatchSpec(body, config.defaults, extra);
    if (typeof watch === "string") return watch;
    await watches.put(watch);
    console.log(`[worldhooks] watch ${watch.id} created via ${watch.source}: ${JSON.stringify(watch.match)}`);
    return watch;
  }

  async function adopt(req: {
    kind: EntityKind;
    entityId: string;
    label: string;
    via?: "api" | "world";
    eventId?: string;
  }): Promise<{ entity: WorldEntity; created: boolean }> {
    if (!entities) throw new Error("entity adoption needs a durable store");
    const entity: WorldEntity = {
      key: entityKey(req.kind, req.entityId),
      kind: req.kind,
      entityId: req.entityId,
      label: req.label,
      owner: config.defaults.owner,
      ownerScopeId: config.defaults.ownerScopeId,
      threadRef: entityThread(req.kind, req.entityId),
      adoptedAt: Date.now(),
      adoptedVia: req.via ?? "api",
      events: 0,
    };
    const out = await entities.adopt(entity);
    if (out.created) {
      const opening: WorldEvent = {
        id: req.eventId ?? `adopt_${Date.now()}`,
        type: "world.entity_adopted",
        ts: new Date().toISOString(),
        source: req.via === "world" ? "quest3s" : "manual",
        payload: { entity_kind: req.kind, entity_id: req.entityId, label: req.label },
      };
      await fire(opening, {
        title: `Adopted: ${req.label}`,
        owner: entity.owner,
        ownerScopeId: entity.ownerScopeId,
        action: adoptionOrders(out.entity),
        fireKey: `world-entity:${out.entity.key}:adopt`,
        threadRef: out.entity.threadRef,
        track: false,
      });
    }
    return out;
  }

  return {
    watches,
    entities,
    ...(tracker ? { tracker } : {}),
    spawnPlan: (requestId) => spawnPlans.get(requestId),
    authorize: (headers, rawBody) => authorized(config.secret, headers, rawBody),
    createWatch: (body) => createWatch(body),
    adopt,
    async deliver(req) {
      if (!authorized(config.secret, req.headers, req.rawBody)) return { status: 401, body: { error: "unauthorized" } };
      const event = parseWorldEvent(req.rawBody);
      if (typeof event === "string") return { status: 400, body: { error: "bad_request", message: event } };

      // Reality creates watches: "next time Matthew brings up pricing, prep a counter-offer".
      if (event.type === "world.watch_requested" && watches) {
        const instruction = str(event.payload.instruction);
        if (!instruction)
          return { status: 400, body: { error: "bad_request", message: "payload.instruction is required" } };
        const personId = str(event.payload.person_id);
        const { spec, via } = await specFromInstruction(instruction, personId, oneShot);
        const requestedBy = (event.people?.[0] as { id?: unknown } | undefined)?.id;
        const watch = await createWatch(spec, {
          source: "world",
          instruction,
          ...(typeof requestedBy === "string" ? { requestedBy } : {}),
        });
        if (typeof watch === "string") return { status: 400, body: { error: "bad_request", message: watch } };
        console.log(`[worldhooks] watch ${watch.id} spec via ${via}`);
        return { status: 202, body: { ok: true, eventId: event.id, type: event.type, watch } };
      }

      // Reality creates entity agents: a pinch on a tracked person or object.
      if (event.type === "world.entity_adopted" && entities) {
        const kind = event.payload.entity_kind === "object" ? "object" : "person";
        const entityId = str(event.payload.entity_id) ?? str(event.payload.person_id);
        if (!entityId) return { status: 400, body: { error: "bad_request", message: "payload.entity_id is required" } };
        const label = str(event.payload.label) ?? entityId;
        const { entity } = await adopt({ kind, entityId, label, via: "world", eventId: event.id });
        return {
          status: 202,
          body: { ok: true, eventId: event.id, type: event.type, entity, threadRef: entity.threadRef },
        };
      }

      const route: WorldHookRoute | undefined = config.routes[event.type];
      let routedKey: string | undefined;
      let duplicate = false;
      if (route) {
        const fireKey = `world:${event.type}:${event.id}`;
        const swarmPlan = worldSwarmPlan(event, route);
        rememberSpawn(worldSpawnBody(event, route));
        const fired = await fire(event, {
          title: `World event: ${event.type}`,
          owner: route.owner,
          ownerScopeId: route.ownerScopeId,
          action: route.action,
          ...(swarmPlan ? { swarmPlan } : {}),
          fireKey,
          threadRef: fireKey,
          track: true,
          ...(route.swarm ? { workers: route.swarm.workers.map((w) => w.name) } : {}),
        });
        if (fired) routedKey = fireKey;
        else duplicate = true;
      }

      const firedWatches: string[] = [];
      if (watches) {
        for (const watch of await watches.list()) {
          if (!watch.active || !matchesWatch(watch.match, event)) continue;
          const fireKey = `world-watch:${watch.id}:${event.id}`;
          const swarmPlan = worldSwarmPlan(event, watch, `world-watch:${watch.id}`);
          rememberSpawn(worldSpawnBody(event, watch, `world-watch:${watch.id}`));
          const orders = watch.instruction
            ? `${watch.action}\n\n(Standing watch ${watch.id}, set from the owner's words: "${watch.instruction}")`
            : watch.action;
          const fired = await fire(event, {
            title: `World watch: ${watch.instruction ?? watch.id}`,
            owner: watch.owner,
            ownerScopeId: watch.ownerScopeId,
            action: orders,
            ...(swarmPlan ? { swarmPlan } : {}),
            fireKey,
            threadRef: fireKey,
            track: true,
            ...(watch.swarm ? { workers: watch.swarm.workers.map((w) => w.name) } : {}),
          });
          if (!fired) continue;
          await watches.markFired(watch.id, event.id);
          firedWatches.push(watch.id);
        }
      }

      const firedEntities: string[] = [];
      if (entities) {
        for (const key of mentionedEntityKeys(event)) {
          const entity = await entities.get(key);
          if (!entity) continue;
          const fired = await fire(event, {
            title: `Entity: ${entity.label}`,
            owner: entity.owner,
            ownerScopeId: entity.ownerScopeId,
            action: entityEventOrders(entity),
            fireKey: `world-entity:${entity.key}:${event.id}`,
            threadRef: entity.threadRef,
            track: false,
          });
          if (!fired) continue;
          await entities.touch(entity.key, event.id);
          firedEntities.push(entity.key);
        }
      }

      if (!routedKey && !firedWatches.length && !firedEntities.length) {
        return {
          status: 200,
          body: {
            ok: true,
            eventId: event.id,
            type: event.type,
            routed: false,
            ...(duplicate ? { duplicate: true as const } : {}),
          },
        };
      }
      return {
        status: 202,
        body: {
          ok: true,
          eventId: event.id,
          type: event.type,
          ...(routedKey ? { fireKey: routedKey, threadRef: routedKey } : {}),
          ...(routedKey && route?.swarm ? { swarm: route.swarm.workers.map((w) => w.name) } : {}),
          ...(firedWatches.length ? { watches: firedWatches } : {}),
          ...(firedEntities.length ? { entities: firedEntities } : {}),
        },
      };
    },
  };
}
