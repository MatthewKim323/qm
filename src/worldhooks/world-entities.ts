import type { DurableMap } from "../persistence/durable-map.ts";
import type { ScopeId } from "../types.ts";
import { eventPersonIds, type MatchableEvent } from "./world-watches.ts";

/**
 * Entity-bound agents: adopting a real person or object (a pinch in the headset, or an API call)
 * gives it one persistent QM thread, `world:entity:<kind>:<id>`. Every later WorldEvent that
 * mentions the entity is delivered into that same thread, so its agent accumulates context
 * across encounters instead of starting cold each time.
 */

export type EntityKind = "person" | "object";

export interface WorldEntity {
  key: string;
  kind: EntityKind;
  entityId: string;
  label: string;
  owner: string;
  ownerScopeId: ScopeId;
  threadRef: string;
  adoptedAt: number;
  adoptedVia: "api" | "world";
  events: number;
  lastEventId?: string;
  lastEventAt?: number;
}

const ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

export const entityKey = (kind: EntityKind, id: string): string => `${kind}:${id.toLowerCase()}`;
export const entityThread = (kind: EntityKind, id: string): string => `world:entity:${kind}:${id.toLowerCase()}`;

export interface AdoptRequest {
  kind: EntityKind;
  entityId: string;
  label: string;
}

export function parseAdopt(body: unknown): AdoptRequest | string {
  if (typeof body !== "object" || body === null) return "body must be an object";
  const b = body as Record<string, unknown>;
  const kind = b.entity_kind;
  if (kind !== "person" && kind !== "object") return "entity_kind must be person or object";
  if (!nonEmpty(b.entity_id) || !ID.test(b.entity_id.trim())) return "entity_id must be a short id";
  const label = nonEmpty(b.label) ? b.label.trim().slice(0, 80) : b.entity_id.trim();
  return { kind, entityId: b.entity_id.trim(), label };
}

/** Entity ids this event mentions, as entity keys. */
export function mentionedEntityKeys(event: MatchableEvent): string[] {
  const keys = new Set(eventPersonIds(event).map((id) => entityKey("person", id)));
  for (const field of ["object", "device", "target"]) {
    const v = event.payload[field];
    if (nonEmpty(v)) keys.add(entityKey("object", v.trim()));
  }
  return [...keys];
}

export interface WorldEntityStore {
  list(): Promise<WorldEntity[]>;
  get(key: string): Promise<WorldEntity | null>;
  /** Creates the entity or returns the existing one (adoption is idempotent). */
  adopt(entity: WorldEntity): Promise<{ entity: WorldEntity; created: boolean }>;
  touch(key: string, eventId: string): Promise<void>;
  release(key: string): Promise<boolean>;
}

export function createWorldEntityStore(map: DurableMap<WorldEntity>): WorldEntityStore {
  return {
    async list() {
      return (await map.all()).sort((a, b) => a.adoptedAt - b.adoptedAt);
    },
    get: (key) => map.get(key),
    async adopt(entity) {
      const before = await map.get(entity.key);
      if (before) return { entity: before, created: false };
      const stored = await map.putIfAbsent(entity.key, entity);
      return { entity: stored, created: stored.adoptedAt === entity.adoptedAt };
    },
    async touch(key, eventId) {
      const cur = await map.get(key);
      if (!cur) return;
      await map.merge(key, { events: cur.events + 1, lastEventId: eventId, lastEventAt: Date.now() });
    },
    async release(key) {
      const cur = await map.get(key);
      if (!cur) return false;
      await map.delete(key);
      return true;
    },
  };
}

export function adoptionOrders(entity: WorldEntity): string {
  const what =
    entity.kind === "person" ? `the person ${entity.label} (id ${entity.entityId})` : `the object ${entity.label}`;
  return [
    `The owner pinched ${what} in the physical world and assigned you to it. You are now the dedicated, long-lived agent for ${entity.label}.`,
    "This thread receives every future world event that mentions them. Keep a running dossier in your own words in this thread: who or what this is, open loops in both directions, what changed since last time, and what the owner should do next.",
    "Reply now with a three line opening dossier from what the event says. On each later event, reply with only what changed and the one next action. Drafts only; never contact anyone.",
  ].join("\n");
}

export function entityEventOrders(entity: WorldEntity): string {
  return `A new world event mentions ${entity.label}, the ${entity.kind} you are dedicated to. Update your dossier in one short reply: what changed, open loops, the one next action. Drafts only; never contact anyone.`;
}
