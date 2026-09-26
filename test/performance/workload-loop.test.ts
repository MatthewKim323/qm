import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { Context, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { environmentNote } from "../../src/core/attachments.ts";
import { createCronStore } from "../../src/cron/cron-store.ts";
import { createIdempotencyStore } from "../../src/idempotency/idempotency-store.ts";
import { createLoopFireService } from "../../src/loops/loop-fire.ts";
import { createLoopItemLedger, loopItemId } from "../../src/loops/item-ledger.ts";
import { createLoopStore } from "../../src/loops/loop-store.ts";
import { createLoopOutputStore } from "../../src/loops/output-store.ts";
import { createShipGrantStore } from "../../src/loops/ship-grant-store.ts";
import { resolveModel } from "../../src/model/pi-models.ts";
import { scopeId, type Loop, type TurnRequest, type TurnResult } from "../../src/types.ts";
import { createMemoryMap } from "../../src/persistence/durable-map.ts";
import { syntheticId } from "./seed.ts";
import { createWorkloadCompanion } from "./workload-companion.ts";
import { createLoopResponder, renderLoopPlanTasks, type LoopPlan, type LoopStage } from "./workload-loop.ts";
import type { NativeShape } from "./workload-native.ts";

const text = "Synthetic durable read for native loop stages";
const token = "qm-perf-loop-test-synthetic-key";
const fixture = {
  schemaVersion: 1,
  fixtureId: "loop-test",
  databaseName: "qm_perf_loop_test",
  profileSha256: "f".repeat(64),
  qualified: false,
};
const shape: NativeShape = {
  name: "loop-read",
  model: "claude-sonnet-5",
  modelCalls: 2,
  toolCalls: 1,
  batches: [1],
  operations: [
    {
      kind: "read",
      path: "shared/loop.txt",
      bytes: Buffer.byteLength(text),
      sha256: createHash("sha256").update(text).digest("hex"),
    },
  ],
  outputBytes: 24,
  repeatedFraction: 0.5,
  delayMs: 0,
  chunkCharacters: 17,
  chunkIntervalMs: 0,
  terminal: "reply",
};
const tools = [
  {
    name: "files",
    description: "Native file read",
    parameters: Type.Object({ action: Type.Literal("read"), path: Type.String() }),
  },
];
const wireTools = [
  { name: "files", input_schema: { properties: { action: { const: "read" }, path: { type: "string" } } } },
];
const provider = {
  schemaVersion: 1 as const,
  fixtureId: fixture.fixtureId,
  model: shape.model,
  tokenEnv: "QM_PERF_TEST_TOKEN",
  host: "127.0.0.1",
  port: 0,
  shapes: [
    {
      name: "frozen",
      modelCalls: 1,
      inputBytes: 64,
      outputBytes: 20,
      delayMs: 0,
      chunkBytes: 20,
      chunkIntervalMs: 0,
      repeatedFraction: 0.5,
    },
  ],
};

async function setup(run: (request: TurnRequest) => Promise<TurnResult>) {
  const backing = createMemoryMap<Loop>();
  const loops = createLoopStore(backing),
    items = createLoopItemLedger(),
    outputs = createLoopOutputStore();
  const fire = createLoopFireService({
    loops,
    items,
    outputs,
    crons: createCronStore(),
    grants: createShipGrantStore(),
    trigger: {
      deliveries: {
        enqueue: async () => {
          throw new Error("No delivery allowed");
        },
      } as never,
      idempotency: createIdempotencyStore(),
      identity: { refresh: async () => {}, classify: () => ({ type: "internal" }) } as never,
      run,
    },
  });
  const plans: LoopPlan[] = [];
  for (const source of ["held", "all", "gmail", "slack"]) {
    const { loop: created } = await loops.create({
      owner: "fixture-actor",
      createdBy: "fixture-actor",
      ownerScopeId: scopeId("personal", "fixture-actor"),
      name: `Fixture ${source}`,
      playbook: "Read the synthetic fixture and prepare held work.",
      successCondition: "Synthetic work is held for review",
      shipActions: [{ action: "draft", gate: "hold" }],
      caps: { maxOpenOutputs: 3, maxItemAttempts: 1 },
      ...(source === "held"
        ? {}
        : {
            surface: source === "all" ? "inbox" : `inbox:${source}`,
            sources: source === "all" ? ["gmail", "slack"] : [source],
          }),
    });
    let loop = created;
    if (source === "held") {
      loop = { ...created, id: syntheticId("loops", 1) };
      await backing.delete(created.id);
      await backing.put(loop.id, loop);
    }
    plans.push({
      definition: loop,
      sourceKey: `[qm-perf-loop:${fixture.fixtureId}:${source}]`,
      occurrences: (source === "held" ? [0, 1, 2] : [0, 1]).map((index) => {
        let stages: LoopStage[] = ["intake"];
        if (source !== "held") stages = ["sync"];
        else if (index !== 1) stages = ["intake", "work", "judge"];
        return {
          id: `fire-${index}`,
          item: source === "held",
          ...(index === 2 ? { sourceKey: `[qm-perf-loop:${fixture.fixtureId}:held-next]` } : {}),
          stages: stages.map((stage) => ({ stage, shape: shape.name })),
        };
      }),
    });
  }
  return { loops, items, outputs, fire, plans };
}

function body(task: string) {
  return { model: shape.model, stream: true, tools: wireTools, messages: [{ role: "user", content: task }] };
}

function continuation(
  request: ReturnType<typeof body>,
  reply: { text: string; tools: Array<{ id: string; name: string; input: unknown }> },
) {
  return {
    ...request,
    messages: [
      ...request.messages,
      {
        role: "assistant",
        content: [{ type: "text", text: reply.text }, ...reply.tools.map((tool) => ({ type: "tool_use", ...tool }))],
      },
      {
        role: "user",
        content: reply.tools.map((tool) => ({ type: "tool_result", tool_use_id: tool.id, content: text })),
      },
    ],
  };
}

test("installed client drives recurring native held and inbox tasks with dedup and a fresh third key", async () => {
  const receipts: Record<string, any>[] = [];
  const contexts = new Map<string, Context>();
  const calls: Array<{ request: TurnRequest; responseIds: string[] }> = [];
  const native = await setup(async (request) => {
    const context: Context = contexts.get(request.conversation.threadRef) ?? { tools, messages: [] };
    contexts.set(request.conversation.threadRef, context);
    context.messages.push({
      role: "user",
      content: `${request.text}\n\n${environmentNote("Synthetic fixture context")}`,
      timestamp: Date.now(),
    });
    const responseIds: string[] = [];
    let reply = "";
    for (let step = 0; step < shape.modelCalls; step++) {
      const answer = await stream(model, context, { apiKey: token, maxTokens: 8192 }).result();
      assert.notEqual(answer.stopReason, "error", answer.errorMessage);
      assert.ok(answer.responseId);
      responseIds.push(answer.responseId);
      context.messages.push(answer);
      const operations = answer.content.filter((block) => block.type === "toolCall");
      assert.equal(operations.length, shape.batches[step] ?? 0);
      for (const operation of operations) {
        assert.equal(operation.name, "files");
        assert.deepEqual(operation.arguments, { action: "read", path: "shared/loop.txt" });
        context.messages.push({
          role: "toolResult",
          toolCallId: operation.id,
          toolName: operation.name,
          content: [{ type: "text", text }],
          isError: false,
          timestamp: Date.now(),
        });
      }
      reply = answer.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
    }
    calls.push({ request, responseIds });
    return { status: "ok", reply, sessionId: `native-stage-${calls.length}` };
  });
  const profile = { ...provider, utilities: [], nativeShapes: [shape], loopPlans: native.plans };
  const companion = await createWorkloadCompanion(profile, provider, fixture, (row) => receipts.push(row), {
    QM_PERF_TEST_TOKEN: token,
  });
  companion.server.listen(0, "127.0.0.1");
  await once(companion.server, "listening");
  const address = companion.server.address();
  assert.ok(address && typeof address !== "string");
  const model = {
    ...resolveModel(shape.model, false)!,
    baseUrl: `http://127.0.0.1:${address.port}`,
  } as Model<"anthropic-messages">;
  try {
    for (const plan of native.plans) {
      const first = await native.fire.fire(plan.definition.id, `${plan.definition.id}:fire-0`);
      assert.notEqual(first.status, "failed", first.note);
      const second = await native.fire.fire(plan.definition.id, `${plan.definition.id}:fire-1`);
      assert.notEqual(second.status, "failed", second.note);
      const prior = calls.length;
      const duplicate = await native.fire.fire(plan.definition.id, `${plan.definition.id}:fire-1`);
      assert.equal(duplicate.note, "duplicate fire key");
      assert.equal(calls.length, prior);
    }
    const held = native.plans[0]!;
    assert.equal((await native.items.byLoop(held.definition.id)).length, 1);
    assert.equal((await native.outputs.awaitingReview(held.definition.id)).length, 1);
    assert.equal(companion.loops!.snapshot().complete, false);
    const third = await native.fire.fire(held.definition.id, `${held.definition.id}:fire-2`);
    assert.equal(third.summary?.enqueued, 1);
    assert.equal(third.summary?.worked, 1);
    assert.equal(third.summary?.ready.length, 1);
    const items = await native.items.byLoop(held.definition.id);
    const outputs = await native.outputs.awaitingReview(held.definition.id);
    assert.equal(items.length, 2);
    assert.deepEqual(
      new Set(items.map((item) => item.id)),
      new Set([held.sourceKey, held.occurrences[2]!.sourceKey!].map((key) => loopItemId(held.definition.id, key))),
    );
    assert.equal(held.definition.id, syntheticId("loops", 1));
    assert.equal(outputs.length, 2);
    assert.equal(outputs[0]!.state, "ready");
    assert.equal(held.definition.shipActions[0]!.gate, "hold");
    assert.equal(calls.length, 13);
    assert.equal(contexts.size, 9);
    assert.equal(new Set(calls.slice(0, 3).map((call) => call.request.conversation.threadRef)).size, 1);
    assert.equal(companion.loops!.snapshot().complete, true);
    await companion.close();
    const accepted = receipts.filter((row) => row.type === "companion-call");
    assert.equal(accepted.length, 26);
    assert.equal(new Set(accepted.map((row) => row.responseId)).size, 26);
    assert.deepEqual(
      new Set(calls.flatMap((call) => call.responseIds)),
      new Set(accepted.map((row) => row.responseId)),
    );
    assert.ok(
      accepted.every(
        (row) => row.error === null && row.loop.responseComplete && row.loop.provisional && row.qualified === false,
      ),
    );
    assert.equal(
      accepted.reduce((count, row) => count + row.native.toolCalls, 0),
      13,
    );
    assert.equal(companion.totals.forwarded, 0);
    for (const plan of native.plans.slice(1)) {
      const starts = accepted.filter((row) => row.loop.loopId === plan.definition.id && row.native.step === 0);
      assert.equal(starts.length, 2);
      assert.equal(starts[0]!.requestSha256, starts[1]!.requestSha256);
      assert.notEqual(starts[0]!.responseId, starts[1]!.responseId);
    }
  } finally {
    await companion.close();
  }
});

test("finite loop admission rejects retries, malformed tasks, budgets and failed responses", async () => {
  const native = await setup(async () => {
    throw new Error("Unused");
  });
  const plan = native.plans[0]!;
  const tasks = await renderLoopPlanTasks(plan);
  for (const modify of [
    (task: string) => task + "\nchanged",
    (task: string) => task + "\n\n<environment>\nvalid\n</environment>\nextra",
    (task: string) => task.replace("[Loop intake]", "[Loop work]"),
  ]) {
    const responder = await createLoopResponder([plan], [shape], fixture.fixtureId);
    assert.throws(() => responder.begin(body(modify(tasks.intake!))), /Unknown|environment/);
    assert.equal(responder.snapshot().failed, true);
  }
  const responder = await createLoopResponder([plan], [shape], fixture.fixtureId);
  const request = body(tasks.intake!);
  const first = responder.begin(request)!;
  assert.equal(responder.snapshot().complete, false);
  first.finish(true);
  assert.throws(() => responder.begin(request), /Duplicate or skipped/);
  assert.equal(responder.snapshot().failed, true);
  const aborted = await createLoopResponder([plan], [shape], fixture.fixtureId);
  aborted.begin(request)!.finish(false);
  assert.throws(() => aborted.begin(request), /poisoned/);
  const concurrent = await createLoopResponder([plan], [shape], fixture.fixtureId);
  const pending = concurrent.begin(request)!;
  assert.throws(() => concurrent.begin(request), /concurrent/);
  pending.finish(true);
  assert.equal(concurrent.snapshot().failed, true);
  const badResult = await createLoopResponder([plan], [shape], fixture.fixtureId);
  const read = badResult.begin(request)!;
  read.finish(true);
  const result = continuation(request, read.reply);
  (result.messages.at(-1)!.content as Array<{ content: string }>)[0]!.content = "changed";
  assert.throws(() => badResult.begin(result), /bytes changed/);
  assert.equal(badResult.snapshot().failed, true);
  const badPlan = structuredClone(plan);
  badPlan.occurrences[1]!.stages.push({ stage: "work", shape: shape.name });
  await assert.rejects(createLoopResponder([badPlan], [shape], fixture.fixtureId), /progression/);
  const sync = native.plans[1]!;
  const noTools = { ...shape, modelCalls: 1, toolCalls: 0, batches: [], operations: [] };
  const finite = await createLoopResponder([sync], [noTools], fixture.fixtureId);
  const syncRequest = body((await renderLoopPlanTasks(sync)).sync!);
  for (let index = 0; index < 2; index++) finite.begin(syncRequest)!.finish(true);
  assert.equal(finite.snapshot().complete, true);
  assert.throws(() => finite.begin(syncRequest), /exhausted/);
  assert.equal(finite.snapshot().complete, false);
  const wrongModel = await createLoopResponder([plan], [shape], fixture.fixtureId);
  assert.throws(() => wrongModel.begin({ ...request, model: "wrong" }), /model/);
  const insufficientDistinct = structuredClone(plan);
  insufficientDistinct.definition.caps!.maxOpenOutputs = 2;
  await assert.rejects(createLoopResponder([insufficientDistinct], [shape], fixture.fixtureId), /distinct held/);
  const malformedId = structuredClone(plan);
  malformedId.definition.id = malformedId.definition.id.toUpperCase();
  await assert.rejects(createLoopResponder([malformedId], [shape], fixture.fixtureId), /native loop ID/);
  const badCap = structuredClone(plan);
  badCap.definition.caps!.maxOpenOutputs = 1;
  await assert.rejects(createLoopResponder([badCap], [shape], fixture.fixtureId), /headroom/);
});

test("aborted accepted HTTP response poisons the plan before another occurrence can start", async () => {
  const native = await setup(async () => {
    throw new Error("Unused");
  });
  const plan = native.plans[1]!;
  const records: Record<string, any>[] = [];
  const delayed = { ...shape, delayMs: 1000 };
  const companion = await createWorkloadCompanion(
    { ...provider, utilities: [], nativeShapes: [delayed], loopPlans: [plan] },
    provider,
    fixture,
    (row) => records.push(row),
    { QM_PERF_TEST_TOKEN: token },
  );
  companion.server.listen(0, "127.0.0.1");
  await once(companion.server, "listening");
  const address = companion.server.address();
  assert.ok(address && typeof address !== "string");
  const request = body((await renderLoopPlanTasks(plan)).sync!);
  const abort = new AbortController();
  const response = fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": token, "content-type": "application/json" },
    body: JSON.stringify(request),
    signal: abort.signal,
  });
  try {
    const deadline = Date.now() + 2000;
    while (!companion.loops!.snapshot().states[0]!.active && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(companion.loops!.snapshot().states[0]!.active, true);
    abort.abort();
    await assert.rejects(response);
    await companion.close();
    assert.equal(companion.loops!.snapshot().failed, true);
    assert.equal(companion.loops!.snapshot().complete, false);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.loop.responseComplete, false);
    assert.ok(records[0]!.error);
  } finally {
    abort.abort();
    await response.catch(() => {});
    await companion.close();
  }
});
