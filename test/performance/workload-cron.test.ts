import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { Context, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { environmentNote } from "../../src/core/attachments.ts";
import { createCronStore } from "../../src/cron/cron-store.ts";
import { createScheduler } from "../../src/cron/scheduler.ts";
import { createIdempotencyStore } from "../../src/idempotency/idempotency-store.ts";
import { resolveModel } from "../../src/model/pi-models.ts";
import { createMemoryAdvisoryLock } from "../../src/persistence/advisory-lock.ts";
import { createMemoryMap } from "../../src/persistence/durable-map.ts";
import { scopeId, type Cron, type TurnRequest } from "../../src/types.ts";
import { hashId } from "../../src/util/crypto.ts";
import { createWorkloadCompanion } from "./workload-companion.ts";
import { createCronResponder, renderCronPlanTask, type CronPlan } from "./workload-cron.ts";
import type { NativeShape } from "./workload-native.ts";

const text = "Synthetic fixed file for recurring cron proof";
const token = "qm-perf-cron-test-synthetic-token";
const fixture = {
  schemaVersion: 1,
  fixtureId: "cron-test",
  databaseName: "qm_perf_cron_test",
  profileSha256: "e".repeat(64),
  qualified: false,
};
const read = {
  kind: "read" as const,
  path: "shared/cron.txt",
  bytes: Buffer.byteLength(text),
  sha256: createHash("sha256").update(text).digest("hex"),
};
const shape: NativeShape = {
  name: "first",
  model: "claude-sonnet-5",
  modelCalls: 2,
  toolCalls: 1,
  batches: [1],
  operations: [read],
  outputBytes: 24,
  repeatedFraction: 0.5,
  delayMs: 0,
  chunkCharacters: 13,
  chunkIntervalMs: 0,
  terminal: "reply",
};
const second: NativeShape = {
  ...shape,
  name: "second",
  modelCalls: 3,
  toolCalls: 3,
  batches: [1, 2],
  operations: [read, read, read],
};
const tools = [
  {
    name: "files",
    description: "Read fixture",
    parameters: Type.Object({ action: Type.Literal("read"), path: Type.String() }),
  },
];
const wireTools = [{ name: "files", input_schema: tools[0]!.parameters }];
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
      chunkBytes: 10,
      chunkIntervalMs: 0,
      repeatedFraction: 0.5,
    },
  ],
};

async function setup() {
  const backing = createMemoryMap<Cron>();
  const crons = createCronStore(backing);
  const firstFireAt = Date.now() + 1000;
  const generated = await createCronStore().create({
    owner: "fixture-actor",
    createdBy: "fixture-actor",
    ownerScopeId: scopeId("channel", "fixture-channel"),
    destination: { type: "slack", target: "fixture-channel", audienceScopeId: scopeId("channel", "fixture-channel") },
    members: [{ id: "fixture-actor", type: "internal" }],
    schedule: { everyMs: 60_000, firstFireAt },
    action: "Synthetic recurring work",
    title: "Fixture cron",
  });
  const created = { ...generated, id: "perf-cron-115" };
  await backing.put(created.id, created);
  const marker = `[qm-perf-cron:${fixture.fixtureId}:${created.id}]`;
  await crons.update(created.id, { action: `${marker}\nRead only the declared fixture bytes.` });
  await crons.setFireNote(created.id, { at: firstFireAt - 60_000, text: "Bound earlier fixture note" });
  const definition = (await crons.get(created.id))!;
  const plan: CronPlan = {
    definition,
    directoryMembers: [
      { principalId: "fixture-actor", displayName: "Fixture Actor", type: "internal", slackId: "UFIXTURE" },
    ],
    occurrences: [
      { id: "fire-0", shape: shape.name },
      { id: "fire-1", shape: second.name },
      { id: "unoffered", shape: shape.name },
    ],
  };
  return { crons, plan, firstFireAt };
}

function body(task: string) {
  return { model: shape.model, stream: true, tools: wireTools, messages: [{ role: "user", content: task }] };
}

function continuation(
  request: Record<string, unknown>,
  reply: { text: string; tools: Array<{ id: string; name: string; input: unknown }> },
) {
  return {
    ...request,
    messages: [
      ...(request.messages as unknown[]),
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

test("two actual scheduled cron fires use distinct finite shapes and exact stable native task", async () => {
  const { crons, plan, firstFireAt } = await setup();
  const receipts: Record<string, any>[] = [];
  const requests: TurnRequest[] = [];
  const responseIds: string[] = [];
  const companion = await createWorkloadCompanion(
    { ...provider, utilities: [], nativeShapes: [shape, second], cronPlans: [plan] },
    provider,
    fixture,
    (record) => receipts.push(record),
    { QM_PERF_TEST_TOKEN: token },
  );
  companion.server.listen(0, "127.0.0.1");
  await once(companion.server, "listening");
  const address = companion.server.address();
  assert.ok(address && typeof address !== "string");
  const model = {
    ...resolveModel(shape.model, false)!,
    baseUrl: `http://127.0.0.1:${address.port}`,
  } as Model<"anthropic-messages">;
  let clock = firstFireAt;
  const scheduler = createScheduler({
    crons,
    deliveries: {
      enqueue: async () => {
        throw new Error("No delivery permitted");
      },
    } as never,
    idempotency: createIdempotencyStore(),
    identity: { refresh: async () => {}, classify: () => ({ type: "internal" }) } as never,
    lock: createMemoryAdvisoryLock(),
    now: () => clock,
    currentScopeMembers: async () => plan.definition.members!,
    directory: {
      list: async () => plan.directoryMembers,
      get: async () => plan.directoryMembers[0]!,
      channelMember: async () => true,
      groupMember: async () => false,
    },
    run: async (request) => {
      const expected = [shape, second][requests.length]!;
      requests.push(request);
      const context: Context = {
        tools,
        messages: [
          {
            role: "user",
            content: `${request.text}\n\n${environmentNote("Synthetic cron environment")}`,
            timestamp: clock,
          },
        ],
      };
      for (let step = 0; step < expected.modelCalls; step++) {
        const answer = await stream(model, context, { apiKey: token, maxTokens: 4096 }).result();
        assert.notEqual(answer.stopReason, "error", answer.errorMessage);
        assert.ok(answer.responseId);
        responseIds.push(answer.responseId);
        context.messages.push(answer);
        const calls = answer.content.filter((block) => block.type === "toolCall");
        assert.equal(calls.length, expected.batches[step] ?? 0);
        for (const call of calls) {
          assert.equal(call.name, "files");
          assert.deepEqual(call.arguments, { action: "read", path: read.path });
          context.messages.push({
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text }],
            isError: false,
            timestamp: clock,
          });
        }
      }
      return { status: "silent", sessionId: `native-cron-${requests.length}` };
    },
  });
  try {
    await scheduler.tick(clock);
    assert.equal(requests.length, 1);
    await scheduler.tick(clock);
    assert.equal(requests.length, 1);
    clock += 60_000;
    await scheduler.tick(clock);
    assert.equal(requests.length, 2);
    assert.equal(requests[0]!.text, requests[1]!.text);
    assert.equal(requests[0]!.text, await renderCronPlanTask(plan));
    assert.match(requests[0]!.text!, /People here: @Fixture Actor \(<@UFIXTURE>\)/);
    assert.match(requests[0]!.text!, /Bound earlier fixture note/);
    const fireRows = await crons.listFires(plan.definition.id);
    assert.equal(fireRows.total, 2);
    for (const [index, request] of requests.entries()) {
      const key = `cron:${plan.definition.id}:${firstFireAt + index * 60_000}`;
      assert.equal(request.idempotencyKey, key);
      assert.equal(request.conversation.threadRef, `cron:${plan.definition.id}:fire:${hashId([key], 12)}`);
      assert.equal(request.surface, "cron");
      assert.equal(request.surfaceTools, undefined);
      assert.equal(fireRows.runs.find((fire) => fire.fireKey === key)!.status, "silent");
    }
    assert.deepEqual((await crons.get(plan.definition.id))!.lastFireNote, plan.definition.lastFireNote);
    assert.equal((await crons.get(plan.definition.id))!.nextFireAt, firstFireAt + 120_000);
    assert.equal(companion.crons!.snapshot().states[0]!.occurrence, 2);
    assert.equal(companion.crons!.snapshot().complete, false);
    await companion.close();
    assert.equal(receipts.length, 5);
    assert.deepEqual(
      receipts.map((record) => record.native.shape),
      ["first", "first", "second", "second", "second"],
    );
    assert.equal(
      receipts.reduce((n, record) => n + record.native.toolCalls, 0),
      4,
    );
    assert.ok(
      receipts.every(
        (record) =>
          record.cron.responseComplete && record.cron.provisional && !record.qualified && record.error === null,
      ),
    );
    assert.equal(new Set(responseIds).size, 5);
    assert.deepEqual(new Set(responseIds), new Set(receipts.map((record) => record.responseId)));
    assert.equal(companion.provider.totals.calls, 0);
  } finally {
    await scheduler.stop();
    await companion.close();
  }
});

test("cron admission fails closed on task changes, duplicate continuations, concurrent requests and exhaustion", async () => {
  const { plan } = await setup();
  const task = await renderCronPlanTask(plan);
  for (const transform of [
    (value: string) => value.replace("Bound earlier fixture note", "Changed note"),
    (value: string) => value.replace("Fixture Actor", "Someone else"),
    (value: string) => value + "\nchanged",
    (value: string) => value + "\n\n<environment>\nvalid\n</environment>\nextra",
    () => plan.definition.action!,
  ]) {
    const responder = await createCronResponder([plan], [shape, second], fixture.fixtureId);
    assert.throws(() => responder.begin(body(transform(task))), /changed|environment/);
    assert.equal(responder.snapshot().failed, true);
  }
  const request = body(task);
  const duplicate = await createCronResponder([plan], [shape, second], fixture.fixtureId);
  duplicate.begin(request)!.finish(true);
  assert.throws(() => duplicate.begin(request), /Duplicate or skipped/);
  const concurrent = await createCronResponder([plan], [shape, second], fixture.fixtureId);
  const active = concurrent.begin(request)!;
  assert.throws(() => concurrent.begin(request), /concurrent/);
  active.finish(true);
  assert.equal(concurrent.snapshot().failed, true);
  const finite = await createCronResponder(
    [{ ...plan, occurrences: [plan.occurrences[0]!] }],
    [shape],
    fixture.fixtureId,
  );
  const first = finite.begin(request)!;
  first.finish(true);
  const last = finite.begin(continuation(request, first.reply))!;
  last.finish(true);
  assert.equal(finite.snapshot().complete, true);
  assert.throws(() => finite.begin(request), /Exhausted/);
  assert.equal(finite.snapshot().complete, false);
  const failed = await createCronResponder([plan], [shape, second], fixture.fixtureId);
  failed.begin(request)!.finish(false);
  assert.throws(() => failed.begin(request), /poisoned/);
  await assert.rejects(
    createCronResponder(
      [{ ...plan, definition: { ...plan.definition, loopId: "linked" } }],
      [shape, second],
      fixture.fixtureId,
    ),
    /Ordinary recurring/,
  );
});

test("cron IDs accept native and bounded retained fixture forms without prefix or integer ambiguity", async () => {
  const { plan } = await setup();
  const withId = (id: string): CronPlan => ({
    ...plan,
    definition: {
      ...plan.definition,
      id,
      action: `[qm-perf-cron:${fixture.fixtureId}:${id}]\nSynthetic retained task`,
    },
  });
  for (const id of [
    "perf-cron-0",
    "perf-cron-962",
    "perf-cron-1000000",
    "0123456789abcdef",
    "01234567-89ab-cdef-0123-456789abcdef",
  ]) {
    const responder = await createCronResponder([withId(id)], [shape, second], fixture.fixtureId);
    assert.equal(responder.snapshot().states[0]!.cronId, id);
  }
  for (const id of [
    "perf-cron-01",
    "perf-cron-00",
    "perf-cron--1",
    "perf-cron-1000001",
    "perf-cron-1x",
    "perf-cron-1\n",
    "perf-cron-1]\n[other",
    "prefix-perf-cron-1",
  ]) {
    await assert.rejects(createCronResponder([withId(id)], [shape, second], fixture.fixtureId), /native cron ID/);
  }
});

test("aborted accepted cron HTTP response retains failed receipt without advancing occurrence", async () => {
  const { plan } = await setup();
  const records: Record<string, any>[] = [];
  const companion = await createWorkloadCompanion(
    { ...provider, utilities: [], nativeShapes: [{ ...shape, delayMs: 1000 }, second], cronPlans: [plan] },
    provider,
    fixture,
    (record) => records.push(record),
    { QM_PERF_TEST_TOKEN: token },
  );
  companion.server.listen(0, "127.0.0.1");
  await once(companion.server, "listening");
  const address = companion.server.address();
  assert.ok(address && typeof address !== "string");
  const abort = new AbortController();
  const request = fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": token, "content-type": "application/json" },
    body: JSON.stringify(body(await renderCronPlanTask(plan))),
    signal: abort.signal,
  });
  try {
    const until = Date.now() + 2000;
    while (!companion.crons!.snapshot().states[0]!.active && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(companion.crons!.snapshot().states[0]!.active, true);
    abort.abort();
    await assert.rejects(request);
    await companion.close();
    assert.equal(companion.crons!.snapshot().failed, true);
    assert.equal(companion.crons!.snapshot().states[0]!.occurrence, 0);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.cron.responseComplete, false);
    assert.ok(records[0]!.error);
  } finally {
    abort.abort();
    await request.catch(() => {});
    await companion.close();
  }
});
