import { randomUUID } from "node:crypto";
import { createCronStore } from "../../src/cron/cron-store.ts";
import { createIdempotencyStore } from "../../src/idempotency/idempotency-store.ts";
import { createLoopFireService } from "../../src/loops/loop-fire.ts";
import { createLoopItemLedger, loopItemId } from "../../src/loops/item-ledger.ts";
import { renderInboxSyncTask, renderSourceInboxTask } from "../../src/loops/inbox-loop.ts";
import { createLoopStore } from "../../src/loops/loop-store.ts";
import { createLoopOutputStore } from "../../src/loops/output-store.ts";
import { createShipGrantStore } from "../../src/loops/ship-grant-store.ts";
import { createMemoryMap } from "../../src/persistence/durable-map.ts";
import type { Loop } from "../../src/types.ts";
import { nativeShapeReply, nativeTurn, validateNativeShapes, type NativeShape } from "./workload-native.ts";
import { workloadCheck } from "./workload-provider.ts";

export type LoopStage = "sync" | "intake" | "work" | "judge";
export interface LoopPlan {
  definition: Loop;
  sourceKey: string;
  occurrences: Array<{
    id: string;
    item: boolean;
    sourceKey?: string;
    stages: Array<{ stage: LoopStage; shape: string }>;
  }>;
}

const summary = "Synthetic performance fixture item";

function terminal(plan: LoopPlan, stage: LoopStage, item: boolean, sourceKey = plan.sourceKey): string {
  if (stage === "sync") return "";
  if (stage === "intake") return JSON.stringify({ items: item ? [{ sourceKey, sourceSummary: summary }] : [] });
  if (stage === "work")
    return JSON.stringify({
      outputs: [
        { shipAction: plan.definition.shipActions[0]!.action, title: summary, summary: "Prepared for fixture review" },
      ],
    });
  return JSON.stringify({ outcome: "met", reason: "Synthetic fixture output prepared for review", checks: [] });
}

export async function renderLoopPlanTasks(
  plan: LoopPlan,
  sourceKey = plan.sourceKey,
): Promise<Partial<Record<LoopStage, string>>> {
  const loop = plan.definition;
  if (loop.surface === "inbox") return { sync: renderInboxSyncTask(loop.id) };
  if (loop.surface?.startsWith("inbox:")) return { sync: renderSourceInboxTask(loop.id, loop.sources![0]!) };
  const backing = createMemoryMap<Loop>();
  await backing.put(loop.id, { ...structuredClone(loop), cronId: undefined, state: "enabled", enabled: true });
  const tasks: Partial<Record<LoopStage, string>> = {};
  const fire = createLoopFireService({
    loops: createLoopStore(backing),
    crons: createCronStore(),
    items: createLoopItemLedger(),
    outputs: createLoopOutputStore(),
    grants: createShipGrantStore(),
    trigger: {
      deliveries: {
        enqueue: async () => {
          throw new Error("Loop template cannot deliver");
        },
      } as never,
      idempotency: createIdempotencyStore(),
      identity: { refresh: async () => {}, classify: () => ({ type: "internal" }) } as never,
      run: async (request) => {
        const stage = /^\[Loop (intake|work|judge)\]\n/.exec(request.text ?? "")?.[1] as LoopStage | undefined;
        workloadCheck(stage && !tasks[stage], "One native template per stage required");
        tasks[stage] = request.text!;
        return { status: "ok", reply: terminal(plan, stage, true, sourceKey), sessionId: "template-only" };
      },
    },
  });
  const result = await fire.fire(loop.id, "template-only");
  workloadCheck(
    result.status === "ok" && Object.keys(tasks).length === 3,
    `Native held task rendering failed: ${result.note}`,
  );
  workloadCheck(
    tasks.work!.includes(JSON.stringify(loopItemId(loop.id, sourceKey))),
    "Native deterministic item identity required",
  );
  return tasks;
}

function taskText(origin: string): string {
  const offset = origin.indexOf("\n\n<environment>\n");
  if (offset < 0) {
    workloadCheck(!/<\/?environment>/.test(origin), "Malformed native environment suffix");
    return origin;
  }
  const suffix = origin.slice(offset + "\n\n<environment>\n".length);
  workloadCheck(
    suffix.endsWith("\n</environment>") &&
      suffix.slice(0, -"\n</environment>".length).trim().length > 0 &&
      !/<\/?environment>/.test(suffix.slice(0, -"\n</environment>".length)),
    "One complete native environment suffix required",
  );
  return origin.slice(0, offset);
}

export async function createLoopResponder(plans: LoopPlan[], shapes: NativeShape[], fixtureId: string) {
  workloadCheck(Array.isArray(plans) && plans.length > 0 && plans.length <= 32, "Bounded loop plans required");
  validateNativeShapes(shapes);
  const instanceId = randomUUID();
  const ids = new Set<string>();
  const tasks = new Map<string, { index: number; stage: LoopStage; sourceKey?: string }>();
  const states = [] as Array<{ occurrence: number; stage: number; step: number; active: boolean; origin?: string }>;
  let failed = false;
  for (const [index, plan] of plans.entries()) {
    const loop = plan.definition;
    workloadCheck(
      /^(?:[a-f0-9]{16}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(loop.id) && !ids.has(loop.id),
      "Unique native loop ID required",
    );
    ids.add(loop.id);
    const sourceKeys = new Set([plan.sourceKey, ...plan.occurrences.map((entry) => entry.sourceKey ?? plan.sourceKey)]);
    for (const sourceKey of sourceKeys)
      workloadCheck(
        sourceKey.startsWith(`[qm-perf-loop:${fixtureId}:`) &&
          /^\[qm-perf-loop:[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+\]$/.test(sourceKey),
        "Stable fixture source key required",
      );
    const sync = loop.surface === "inbox" || loop.surface?.startsWith("inbox:");
    if (sync)
      workloadCheck(
        loop.surface === "inbox" ||
          (loop.sources?.length === 1 &&
            ["gmail", "slack"].includes(loop.sources[0]!) &&
            loop.surface === `inbox:${loop.sources[0]}`),
        "Exact native inbox source required",
      );
    else
      workloadCheck(
        loop.shipActions.length === 1 &&
          loop.shipActions[0]!.gate === "hold" &&
          !loop.successChecks?.length &&
          (loop.caps?.maxOpenOutputs ?? 2) >= 2,
        "One held action, no checks and output headroom required",
      );
    workloadCheck(plan.occurrences.length > 0 && plan.occurrences.length <= 1000, "Finite loop occurrences required");
    const held = new Set<string>();
    const occurrences = new Set<string>();
    for (const occurrence of plan.occurrences) {
      workloadCheck(
        /^[A-Za-z0-9_.-]+$/.test(occurrence.id) && !occurrences.has(occurrence.id),
        "Unique occurrence ID required",
      );
      occurrences.add(occurrence.id);
      workloadCheck(typeof occurrence.item === "boolean", "Explicit intake outcome required");
      const sourceKey = occurrence.sourceKey ?? plan.sourceKey;
      let expected: LoopStage[] = ["intake"];
      if (sync) expected = ["sync"];
      else if (occurrence.item && !held.has(sourceKey)) expected = ["intake", "work", "judge"];
      workloadCheck(
        JSON.stringify(occurrence.stages.map((stage) => stage.stage)) === JSON.stringify(expected),
        "Exact native stage progression required",
      );
      workloadCheck(!sync || !occurrence.item, "Inbox sync cannot manufacture intake items");
      for (const stage of occurrence.stages)
        workloadCheck(
          shapes.some((shape) => shape.name === stage.shape && shape.terminal === "reply"),
          "Declared native stage shape required",
        );
      if (occurrence.item) held.add(sourceKey);
    }
    workloadCheck(
      sync || loop.caps?.maxOpenOutputs === undefined || loop.caps.maxOpenOutputs > held.size,
      "Output headroom required for every distinct held source key",
    );
    for (const sourceKey of sourceKeys) {
      for (const [stage, task] of Object.entries(await renderLoopPlanTasks(plan, sourceKey))) {
        const prior = tasks.get(task);
        workloadCheck(
          Buffer.byteLength(task) <= 1_000_000 &&
            (!prior || (prior.index === index && prior.stage === stage && ["intake", "sync"].includes(stage))),
          "Unambiguous bounded native tasks required",
        );
        tasks.set(task, {
          index,
          stage: stage as LoopStage,
          ...(["work", "judge"].includes(stage) ? { sourceKey } : {}),
        });
      }
    }
    states.push({ occurrence: 0, stage: 0, step: 0, active: false });
  }
  return {
    begin(body: Record<string, unknown>) {
      try {
        const turn = nativeTurn(body);
        if (!turn) return null;
        const looksLikeLoop = /^(?:\[Loop |Inbox sync v|Source restriction:)/.test(turn.origin);
        if (!looksLikeLoop) return null;
        workloadCheck(!failed, "Loop plan poisoned by an unsuccessful request");
        const selected = tasks.get(taskText(turn.origin));
        workloadCheck(selected, "Unknown or changed native loop task");
        const { index, stage } = selected;
        const plan = plans[index]!,
          state = states[index]!;
        const occurrence = plan.occurrences[state.occurrence];
        const expected = occurrence?.stages[state.stage];
        const sourceKey = occurrence?.sourceKey ?? plan.sourceKey;
        workloadCheck(
          occurrence && expected?.stage === stage && !state.active,
          "Unexpected, exhausted or concurrent loop stage",
        );
        workloadCheck(
          selected.sourceKey === undefined || selected.sourceKey === sourceKey,
          "Unexpected native item key",
        );
        workloadCheck(turn.pairs.length === state.step, "Duplicate or skipped native continuation");
        workloadCheck(
          state.origin === undefined || state.origin === turn.origin,
          "Native originating task changed within stage",
        );
        const shape = shapes.find((candidate) => candidate.name === expected.shape)!;
        const nonce = `${instanceId}.${index}.${state.occurrence}.${state.stage}`;
        const reply = nativeShapeReply(body, turn, shape, nonce, terminal(plan, stage, occurrence.item, sourceKey));
        state.active = true;
        state.origin = turn.origin;
        const loop = {
          loopId: plan.definition.id,
          sourceKey,
          occurrenceId: occurrence.id,
          occurrenceIndex: state.occurrence,
          stage,
          stageIndex: state.stage,
          provisional: true,
        };
        let finished = false;
        return {
          reply: { ...reply, loop },
          finish(success: boolean) {
            if (finished) return;
            finished = true;
            state.active = false;
            if (!success) {
              failed = true;
              return;
            }
            state.step++;
            if (reply.native.terminal) {
              state.step = 0;
              state.origin = undefined;
              state.stage++;
              if (state.stage === occurrence.stages.length) {
                state.stage = 0;
                state.occurrence++;
              }
            }
          },
        };
      } catch (error) {
        failed = true;
        throw error;
      }
    },
    snapshot: () => ({
      instanceId,
      failed,
      provisional: true,
      complete: !failed && states.every((state, index) => state.occurrence === plans[index]!.occurrences.length),
      states: states.map((state, index) => ({ ...state, origin: undefined, loopId: plans[index]!.definition.id })),
    }),
  };
}
