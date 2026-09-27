import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createWorldHookReceiver } from "../src/worldhooks/world-hook-receiver.ts";
import { parseWorldHooksConfig } from "../src/worldhooks/world-hooks-config.ts";
import {
  createWorldWatchStore,
  fallbackWatchSpec,
  matchesWatch,
  parseWatchSpec,
  type WorldWatch,
} from "../src/worldhooks/world-watches.ts";
import { createWorldEntityStore, mentionedEntityKeys, type WorldEntity } from "../src/worldhooks/world-entities.ts";
import { parseRecallBlock, learnedLine, type WorldRunReport } from "../src/worldhooks/world-swarm-tracker.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
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
const bearer = (body: unknown) => ({ headers: { authorization: `Bearer ${SECRET}` }, rawBody: JSON.stringify(body) });

function harness(oneShot?: (s: string, p: string) => Promise<string | undefined>) {
  const calls: TurnRequest[] = [];
  const watches = createWorldWatchStore(createMemoryMap<WorldWatch>());
  const entities = createWorldEntityStore(createMemoryMap<WorldEntity>());
  const receiver = createWorldHookReceiver({
    config,
    deliveries: createDeliveryStore(),
    idempotency: createIdempotencyStore(),
    identity: createIdentityService(),
    run: async (req: TurnRequest): Promise<TurnResult> => {
      calls.push(req);
      return { status: "ok", reply: "ok" };
    },
    watches,
    entities,
    ...(oneShot ? { oneShot } : {}),
  });
  return { calls, receiver, watches, entities };
}

const pricing = {
  id: "evt_pricing_1",
  type: "conversation.completed",
  ts: "2026-09-27T21:00:00Z",
  source: "quest3s",
  people: [{ id: "matthew", name: "Matthew", enrolled: true }],
  project: "syla",
  payload: { duration_s: 120, summary: "Matthew pushed back on Pricing for the team plan", speakers: ["matthew"] },
};

test("watch predicates match type, person, project, and text", () => {
  assert.equal(matchesWatch({ person_id: "matthew", text_contains: ["pricing"] }, pricing), true);
  assert.equal(matchesWatch({ person_id: "priya", text_contains: ["pricing"] }, pricing), false);
  assert.equal(matchesWatch({ type: "conversation.*", project: "SYLA" }, pricing), true);
  assert.equal(matchesWatch({ type: "customer_feedback.detected" }, pricing), false);
  assert.equal(matchesWatch({ text_contains: ["pricing", "refund"] }, pricing), false);
  assert.equal(matchesWatch({ text_contains: ["x"] }, { ...pricing, type: "world.watch_requested" }), false);
});

test("watch specs are validated", () => {
  const d = config.defaults;
  assert.equal(typeof parseWatchSpec({ match: {}, action: "x" }, d), "string");
  assert.equal(typeof parseWatchSpec({ match: { person_id: "a" } }, d), "string");
  const ok = parseWatchSpec({ match: { person_id: "matthew" }, action: "prep", once: true }, d);
  assert.ok(typeof ok !== "string");
  assert.equal(ok.ownerScopeId, "personal:stephen");
  assert.equal(ok.once, true);
});

test("a spoken request becomes a watch that fires once on the matching event", async () => {
  const { calls, receiver, watches } = harness(async () =>
    JSON.stringify({
      match: { person_id: "matthew", text_contains: ["pricing"] },
      action: "Prep a counter-offer draft.",
      once: true,
    }),
  );
  const req = await receiver.deliver(
    bearer({
      id: "evt_watch_req",
      type: "world.watch_requested",
      ts: "2026-09-27T20:00:00Z",
      source: "quest3s",
      people: [{ id: "stephen" }],
      payload: { instruction: "next time Matthew brings up pricing, prep a counter-offer", person_id: "matthew" },
    }),
  );
  assert.equal(req.status, 202);
  const watch = req.status === 202 ? req.body.watch : undefined;
  assert.ok(watch);
  assert.equal(watch.source, "world");
  const hit = await receiver.deliver(bearer(pricing));
  assert.equal(hit.status, 202);
  assert.deepEqual(hit.status === 202 && hit.body.watches, [watch.id]);
  await flush();
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.text, /Prep a counter-offer draft/);
  assert.match(calls[0]!.text, /next time Matthew brings up pricing/);
  assert.equal((await watches.get(watch.id))?.active, false);
  const again = await receiver.deliver(bearer({ ...pricing, id: "evt_pricing_2" }));
  assert.equal(again.status, 200);
});

test("without a model the instruction still becomes a watch", () => {
  const spec = fallbackWatchSpec("Next time Matthew brings up pricing, prep a counter-offer", "matthew");
  assert.deepEqual(spec.match, { person_id: "matthew", text_contains: ["pricing"] });
  assert.equal(spec.once, true);
});

test("an adopted entity gets one persistent thread that later events flow into", async () => {
  const { calls, receiver, entities } = harness();
  const adopted = await receiver.deliver(
    bearer({
      id: "evt_pinch_1",
      type: "world.entity_adopted",
      ts: "2026-09-27T20:00:00Z",
      source: "quest3s",
      payload: { entity_kind: "person", entity_id: "matthew", label: "Matthew", track_id: 3 },
    }),
  );
  assert.equal(adopted.status, 202);
  await flush();
  assert.equal(calls.length, 1);
  const thread = calls[0]!.conversation.threadRef;
  const hit = await receiver.deliver(bearer(pricing));
  assert.deepEqual(hit.status === 202 && hit.body.entities, ["person:matthew"]);
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.conversation.threadRef, thread);
  assert.equal((await entities.get("person:matthew"))?.events, 1);
  const readopt = await receiver.adopt({ kind: "person", entityId: "matthew", label: "Matthew" });
  assert.equal(readopt.created, false);
});

test("entity mentions come from people and object payloads", () => {
  assert.deepEqual(mentionedEntityKeys(pricing), ["person:matthew"]);
  assert.deepEqual(mentionedEntityKeys({ id: "e", type: "object.state_changed", payload: { object: "LED-Board" } }), [
    "object:led-board",
  ]);
});

test("recall blocks and run deltas render for the HUD", () => {
  const block = [
    "## A previous session solved a near-identical task: Handle in person customer feedback",
    "Decisive steps last time:",
    "  1. [write] write: context.md",
    "  2. [execute] execute: test -s context.md",
  ].join("\n");
  assert.deepEqual(parseRecallBlock(block), { title: "Handle in person customer feedback", steps: 2 });
  assert.deepEqual(
    parseRecallBlock(
      'A previous session solved a near-identical task ("Add issue.md to world directory").\nVerified by: test -s',
    ),
    { title: "Add issue.md to world directory", steps: 0 },
  );
  const r = (toolCalls: number, turns: number, wallMs: number) =>
    ({ total: { toolCalls, turns, wallMs, toolErrors: 0 } }) as WorldRunReport;
  assert.equal(learnedLine(r(30, 9, 166_000), r(18, 7, 90_000)), "tool calls 30 -> 18 · turns 9 -> 7 · 166s -> 90s");
});

test("world-event turns recall by a stable task line, not by per-event noise", async () => {
  const { procedureTaskLine } = await import("../src/worldhooks/procedure-task.ts");
  const envelope = (id: string, words: string) =>
    [
      `<wake reason="world-event" surface="webhook" world-event-id="${id}" world-event-type="customer_feedback.detected" world-source="quest3s" at="2026-09-27T21:18:57.660Z">`,
      '  <standing-orders note="x">',
      "    A customer gave product feedback in person. Keep drafts under $HOME/world/&lt;event id&gt;/.",
      "",
      "Run this as a swarm. First, spawn exactly these 3 workers",
      "  </standing-orders>",
      '  <event note="y">{&quot;product&quot;: &quot;Canvas&quot;, &quot;feature&quot;: &quot;onboarding&quot;, &quot;feedback&quot;: &quot;' +
        words +
        "&quot;}</event>",
      "</wake>",
    ].join("\n");
  const a = procedureTaskLine(envelope("evt_a", "setup was confusing"));
  const b = procedureTaskLine(envelope("evt_b", "the onboarding was rough"));
  assert.equal(a, b);
  assert.equal(
    a,
    "Handle world event customer_feedback.detected about Canvas onboarding: A customer gave product feedback in person. Keep drafts under $HOME/world/<event id>/.",
  );
  assert.equal(procedureTaskLine("  fix the\nbuild  "), "fix the build");
});
