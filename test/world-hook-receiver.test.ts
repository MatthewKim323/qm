import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createWorldHookReceiver } from "../src/worldhooks/world-hook-receiver.ts";
import { parseWorldHooksConfig } from "../src/worldhooks/world-hooks-config.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import type { TurnRequest, TurnResult } from "../src/types.ts";

const SECRET = "world-hooks-test-secret";
const flush = () => new Promise((r) => setImmediate(r));

const config = parseWorldHooksConfig(
  JSON.parse(readFileSync(new URL("../deploy/worldhooks/world-hooks.json", import.meta.url), "utf8")),
  SECRET,
);

function harness() {
  const calls: TurnRequest[] = [];
  const run = async (req: TurnRequest): Promise<TurnResult> => {
    calls.push(req);
    return { status: "ok", reply: "swarm summary" };
  };
  const receiver = createWorldHookReceiver({
    config,
    deliveries: createDeliveryStore(),
    idempotency: createIdempotencyStore(),
    identity: createIdentityService(),
    run,
  });
  return { calls, receiver };
}

const feedback = {
  id: "evt_01J8WORLDTEST",
  type: "customer_feedback.detected",
  ts: "2026-09-27T20:14:03Z",
  source: "quest3s",
  confidence: 0.91,
  people: [{ id: "alex", name: "Alex", enrolled: true }],
  project: "syla",
  payload: {
    product: "Canvas",
    feature: "onboarding",
    sentiment: "neg",
    feedback: "Canvas setup was confusing",
    buying_signal: "would roll out if onboarding were easier",
  },
};

const bearer = (rawBody: string) => ({ headers: { authorization: `Bearer ${SECRET}` }, rawBody });

test("customer feedback wakes the owner with the three worker swarm plan", async () => {
  const { calls, receiver } = harness();
  const out = await receiver.deliver(bearer(JSON.stringify(feedback)));
  assert.equal(out.status, 202);
  assert.deepEqual(out.status === 202 && out.body.swarm, ["Context", "Product", "Follow-up"]);
  await flush();
  assert.equal(calls.length, 1);
  const req = calls[0]!;
  assert.equal(req.actor.externalId, "stephen");
  assert.equal(req.surface, "webhook");
  assert.equal(req.triggered, true);
  assert.match(req.text, /reason="world-event"/);
  assert.match(req.text, /world-event-type="customer_feedback.detected"/);
  assert.match(req.text, /POST \/v1\/swarm/);
  assert.match(req.text, /"requestId": "world:evt_01J8WORLDTEST"/);
  assert.match(req.text, /Canvas setup was confusing/);
});

test("the same event id fires once", async () => {
  const { calls, receiver } = harness();
  await receiver.deliver(bearer(JSON.stringify(feedback)));
  await flush();
  const again = await receiver.deliver(bearer(JSON.stringify(feedback)));
  assert.equal(again.status, 200);
  assert.equal(calls.length, 1);
});

test("an HMAC signature authorizes; a wrong secret does not", async () => {
  const { receiver } = harness();
  const rawBody = JSON.stringify({ ...feedback, id: "evt_signed" });
  const sig = createHmac("sha256", SECRET).update(rawBody).digest("hex");
  assert.equal((await receiver.deliver({ headers: { "x-signature": `sha256=${sig}` }, rawBody })).status, 202);
  assert.equal((await receiver.deliver({ headers: { authorization: "Bearer nope" }, rawBody })).status, 401);
  assert.equal((await receiver.deliver({ headers: {}, rawBody })).status, 401);
});

test("unrouted types are acknowledged without a turn and malformed events are rejected", async () => {
  const { calls, receiver } = harness();
  const unrouted = await receiver.deliver(bearer(JSON.stringify({ ...feedback, type: "object.last_seen" })));
  assert.equal(unrouted.status, 200);
  const bad = await receiver.deliver(bearer(JSON.stringify({ ...feedback, payload: "nope" })));
  assert.equal(bad.status, 400);
  await flush();
  assert.equal(calls.length, 0);
});
