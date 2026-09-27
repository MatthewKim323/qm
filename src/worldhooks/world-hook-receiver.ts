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

export function worldSwarmPlan(
  event: WorldEvent,
  route: { swarm?: { workers: WorldSwarmWorker[] } },
  requestPrefix = "world",
): string | undefined {
  if (!route.swarm) return undefined;
  const requestId = `${requestPrefix}:${event.id}`;
  const spawn = {
    action: "spawn",
    requestId,
    contexts: route.swarm.workers.map((w) => ({
      group: `world:${event.type}`,
      role: w.role,
      name: w.name,
      brief: w.brief,
    })),
    text: `Handle world event ${event.id} (${event.type}). The swarm root sends you the world event as a swarm message; do only the role in your context brief, and report findings to the root with a swarm send. Never contact anyone outside QM; drafts only.`,
  };
  return [
    `Run this as a swarm. First, spawn exactly these ${route.swarm.workers.length} workers with one call to POST /v1/swarm using this body:`,
    JSON.stringify(spawn, null, 2),
    `Then send the world event JSON to all workers with {"action":"send","requestId":"${requestId}:event","audience":"all","text":<the event JSON>}.`,
    "Tail replies with GET /v1/swarm?read=1. When every worker has reported, reply with one short summary of what each worker produced and which items await human approval before any external send.",
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

  interface Fire {
    title: string;
    owner: string;
    ownerScopeId: ScopeId;
    action: string;
    swarmPlan?: string;
    fireKey: string;
    threadRef: string;
    track: boolean;
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
        const fired = await fire(event, {
          title: `World event: ${event.type}`,
          owner: route.owner,
          ownerScopeId: route.ownerScopeId,
          action: route.action,
          ...(swarmPlan ? { swarmPlan } : {}),
          fireKey,
          threadRef: fireKey,
          track: true,
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
