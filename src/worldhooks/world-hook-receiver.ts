import { createHmac } from "node:crypto";
import type { VerifierInput } from "../webhooks/verifiers.ts";
import { runTrigger, type TriggerDeps } from "../triggers/run-trigger.ts";
import { buildWorldEventWakeEnvelope, capForEscaping } from "../core/wake-envelope.ts";
import { constantTimeEqual } from "../util/crypto.ts";
import { reportFailure } from "../util/errors.ts";
import type { WorldHookRoute, WorldHooksConfig } from "./world-hooks-config.ts";

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
      body: { ok: true; eventId: string; type: string; fireKey: string; threadRef: string; swarm?: string[] };
    }
  | { status: 200; body: { ok: true; eventId: string; type: string; routed: false; duplicate?: true } }
  | { status: 400; body: { error: "bad_request"; message: string } }
  | { status: 401; body: { error: "unauthorized" } };

export interface WorldHookReceiver {
  deliver(req: { headers: VerifierInput["headers"]; rawBody: string }): Promise<WorldHookResult>;
}

export interface WorldHookReceiverDeps extends TriggerDeps {
  config: WorldHooksConfig;
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

export function worldSwarmPlan(event: WorldEvent, route: WorldHookRoute): string | undefined {
  if (!route.swarm) return undefined;
  const spawn = {
    action: "spawn",
    requestId: `world:${event.id}`,
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
    `Then send the world event JSON to all workers with {"action":"send","requestId":"world:${event.id}:event","audience":"all","text":<the event JSON>}.`,
    "Tail replies with GET /v1/swarm?read=1. When every worker has reported, reply with one short summary: who this is, the drafted issue, the drafted follow-up, and which items await human approval before any external send.",
  ].join("\n");
}

export function createWorldHookReceiver(deps: WorldHookReceiverDeps): WorldHookReceiver {
  const { config, ...triggerDeps } = deps;
  return {
    async deliver(req) {
      if (!authorized(config.secret, req.headers, req.rawBody)) return { status: 401, body: { error: "unauthorized" } };
      const event = parseWorldEvent(req.rawBody);
      if (typeof event === "string") return { status: 400, body: { error: "bad_request", message: event } };
      const route = config.routes[event.type];
      if (!route) return { status: 200, body: { ok: true, eventId: event.id, type: event.type, routed: false } };

      const fireKey = `world:${event.type}:${event.id}`;
      if (await triggerDeps.idempotency.committed(fireKey))
        return { status: 200, body: { ok: true, eventId: event.id, type: event.type, routed: false, duplicate: true } };

      const pretty = JSON.stringify(event, null, 2);
      const kept = capForEscaping(pretty, MAX_EVENT_CHARS, "head");
      const payload = kept.length < pretty.length ? `${kept}\n…[truncated]` : kept;
      const swarmPlan = worldSwarmPlan(event, route);
      const input = buildWorldEventWakeEnvelope({
        eventId: event.id,
        eventType: event.type,
        source: event.source,
        at: new Date(),
        action: route.action,
        ...(swarmPlan ? { swarmPlan } : {}),
        payload,
      });

      void runTrigger(triggerDeps, {
        title: `World event: ${event.type}`,
        owner: route.owner,
        ownerScopeId: route.ownerScopeId,
        input,
        securityScreenData: payload,
        fireKey,
        threadRef: fireKey,
        surface: "webhook",
      })
        .then((outcome) => {
          console.log(
            `[worldhooks] ${fireKey} ran=${outcome.ran} status=${outcome.status ?? "-"} session=${outcome.sessionId ?? "-"}${outcome.note ? ` note=${outcome.note}` : ""}`,
          );
        })
        .catch((e: unknown) => reportFailure("worldhooks: fire", e, fireKey));

      return {
        status: 202,
        body: {
          ok: true,
          eventId: event.id,
          type: event.type,
          fireKey,
          threadRef: fireKey,
          ...(route.swarm ? { swarm: route.swarm.workers.map((w) => w.name) } : {}),
        },
      };
    },
  };
}
