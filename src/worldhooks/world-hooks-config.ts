import { readFileSync } from "node:fs";
import { parseScopeId, type ScopeId } from "../types.ts";

export interface WorldSwarmWorker {
  role: string;
  name: string;
  brief: string;
}

export interface WorldHookRoute {
  owner: string;
  ownerScopeId: ScopeId;
  action: string;
  swarm?: { workers: WorldSwarmWorker[] };
}

export interface WorldHooksConfig {
  secret: string;
  routes: Record<string, WorldHookRoute>;
  /** Owner used by WorldWatches and adopted entities that name none; top-level owner/ownerScopeId. */
  defaults: { owner: string; ownerScopeId: ScopeId };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

function parseWorker(value: unknown, where: string): WorldSwarmWorker {
  if (!isObj(value) || !nonEmpty(value.role) || !nonEmpty(value.name) || !nonEmpty(value.brief)) {
    throw new Error(`${where} needs non-empty role, name, and brief`);
  }
  return { role: value.role.trim(), name: value.name.trim(), brief: value.brief.trim() };
}

function parseRoute(type: string, value: unknown, defaults: Record<string, unknown>): WorldHookRoute {
  const where = `WORLD_HOOKS_FILE route ${type}`;
  if (!isObj(value)) throw new Error(`${where} must be an object`);
  const owner = value.owner ?? defaults.owner;
  const ownerScopeId = value.ownerScopeId ?? defaults.ownerScopeId;
  if (!nonEmpty(owner)) throw new Error(`${where} needs an owner principal`);
  if (!nonEmpty(ownerScopeId) || parseScopeId(ownerScopeId as ScopeId).kind === null) {
    throw new Error(`${where} needs a valid ownerScopeId such as personal:<principal>`);
  }
  if (!nonEmpty(value.action)) throw new Error(`${where} needs an action`);
  let swarm: WorldHookRoute["swarm"];
  if (value.swarm !== undefined) {
    if (!isObj(value.swarm) || !Array.isArray(value.swarm.workers) || value.swarm.workers.length === 0) {
      throw new Error(`${where} swarm needs at least one worker`);
    }
    swarm = { workers: value.swarm.workers.map((w, i) => parseWorker(w, `${where} worker ${i}`)) };
  }
  return {
    owner: owner.trim(),
    ownerScopeId: ownerScopeId.trim() as ScopeId,
    action: value.action.trim(),
    ...(swarm ? { swarm } : {}),
  };
}

export function parseWorldHooksConfig(raw: unknown, secret: string): WorldHooksConfig {
  if (!isObj(raw) || !isObj(raw.routes)) throw new Error("WORLD_HOOKS_FILE must contain a routes object");
  const routes: Record<string, WorldHookRoute> = {};
  for (const [type, route] of Object.entries(raw.routes)) routes[type] = parseRoute(type, route, raw);
  const first = Object.values(routes)[0];
  const owner = nonEmpty(raw.owner) ? raw.owner.trim() : (first?.owner ?? "owner");
  const scope = nonEmpty(raw.ownerScopeId) ? (raw.ownerScopeId.trim() as ScopeId) : undefined;
  const ownerScopeId =
    scope && parseScopeId(scope).kind !== null ? scope : (first?.ownerScopeId ?? (`personal:${owner}` as ScopeId));
  return { secret, routes, defaults: { owner, ownerScopeId } };
}

export function loadWorldHooksConfig(env: Record<string, string | undefined>): WorldHooksConfig | undefined {
  const file = env.WORLD_HOOKS_FILE?.trim();
  if (!file) return undefined;
  const secret = env.WORLD_HOOKS_SECRET?.trim();
  if (!secret || secret.length < 16)
    throw new Error("WORLD_HOOKS_FILE requires WORLD_HOOKS_SECRET of at least 16 characters");
  return parseWorldHooksConfig(JSON.parse(readFileSync(file, "utf8")), secret);
}
