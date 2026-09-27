import { EventEmitter } from "node:events";
import type { MemoryService } from "../memory/memory-service.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { ScopeId } from "../types.ts";
import { errMessage } from "../util/errors.ts";

/**
 * Follows one WorldHook turn (root session plus any swarm workers) from the durable stores,
 * mirrors worker progress to the WORLD HUD as `agent_activity`, and when the whole swarm has
 * gone quiet: records each session's tool trace as a Memorable procedure (event-triggered
 * turns are autonomous, so QM's per-turn capture skips them) and measures the run.
 */

type Rows = Array<Record<string, unknown>>;
export type Query = (text: string, params?: unknown[]) => Promise<Rows>;

export interface WorldRunMetrics {
  turns: number;
  toolCalls: number;
  toolErrors: number;
  wallMs: number;
}

export interface WorldRunReport {
  eventId: string;
  type: string;
  fireKey: string;
  scopeId: string;
  startedAt: number;
  finishedAt: number;
  total: WorldRunMetrics;
  sessions: Array<{ name: string; sessionId: string } & WorldRunMetrics>;
  recalled: Array<{ title: string; steps: number }>;
  captured: number;
  captureError?: string;
}

export interface WorkerStatus {
  name: string;
  state: "running" | "done" | "failed";
  note?: string;
}

export interface RecallEvent {
  scopeId: string;
  task: string;
  block: string;
}

/** Memorable recall hits, emitted by the memorable memory provider. */
export const memorableEvents = new EventEmitter();
memorableEvents.setMaxListeners(100);

export function parseRecallBlock(block: string): { title: string; steps: number } {
  const title =
    /##\s+(?:A previous session solved a near-identical task|Recorded procedure from a past session):\s*(.+)/.exec(
      block,
    )?.[1] ??
    /near-identical task \("(.+?)"\)/.exec(block)?.[1] ??
    /##\s+(.+)/.exec(block)?.[1] ??
    "procedure";
  const steps = block.split("\n").filter((l) => /^\s+\d+\.\s+\[/.test(l)).length;
  return { title: title.trim().slice(0, 80), steps };
}

export interface WorldSwarmTrackerDeps {
  q: Query;
  hudUrl?: string;
  memory?: MemoryService;
  fetchImpl?: typeof fetch;
  pollMs?: number;
  quietMs?: number;
  maxMs?: number;
  log?: (line: string) => void;
  /** Durable run reports, so the run 1 vs run 2 comparison survives a restart. */
  store?: DurableMap<WorldRunReport>;
}

export interface TrackRequest {
  fireKey: string;
  eventId: string;
  type: string;
  scopeId: ScopeId;
  anchorTrackId?: number;
}

interface SessionRow {
  name: string;
  sessionId: string;
  threadRef: string;
}

const TERMINAL = new Set(["done", "failed", "cancelled", "canceled"]);

function toState(status: string | undefined): WorkerStatus["state"] {
  if (status === "failed") return "failed";
  if (status && TERMINAL.has(status)) return "done";
  return "running";
}

function nameOf(contextJson: unknown): string {
  try {
    const ctx = typeof contextJson === "string" ? (JSON.parse(contextJson) as unknown) : contextJson;
    if (ctx && typeof ctx === "object" && typeof (ctx as { name?: unknown }).name === "string")
      return (ctx as { name: string }).name;
  } catch {
    /* fall through */
  }
  return "Worker";
}

function fmtS(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

export function learnedLine(before: WorldRunReport, after: WorldRunReport): string {
  return `tool calls ${before.total.toolCalls} -> ${after.total.toolCalls} · turns ${before.total.turns} -> ${after.total.turns} · ${fmtS(before.total.wallMs)} -> ${fmtS(after.total.wallMs)}`;
}

export function createWorldSwarmTracker(deps: WorldSwarmTrackerDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const pollMs = deps.pollMs ?? 2_000;
  const quietMs = deps.quietMs ?? 12_000;
  const maxMs = deps.maxMs ?? 20 * 60_000;
  const log = deps.log ?? ((line: string) => console.log(line));
  const reports: WorldRunReport[] = [];

  async function hud(message: Record<string, unknown>): Promise<void> {
    if (!deps.hudUrl) return;
    try {
      await fetchImpl(deps.hudUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(3_000),
      });
    } catch (e) {
      log(`[worldhooks] hud post failed: ${errMessage(e)}`);
    }
  }

  async function sessions(fireKey: string): Promise<SessionRow[]> {
    const root = await deps.q("select id from sessions where thread_ref = $1 order by created_at limit 1", [fireKey]);
    const rootId = root[0]?.id as string | undefined;
    if (!rootId) return [];
    const out: SessionRow[] = [{ name: "Root", sessionId: rootId, threadRef: fireKey }];
    const swarm = await deps.q("select json from swarms where id = $1", [rootId]);
    const members = ((swarm[0]?.json as { members?: unknown[] } | undefined)?.members ?? []) as Array<{
      sessionId?: string;
      threadRef?: string;
      contextJson?: unknown;
      id?: string;
    }>;
    for (const m of members) {
      if (!m.sessionId || !m.threadRef || m.sessionId === rootId) continue;
      out.push({ name: nameOf(m.contextJson), sessionId: m.sessionId, threadRef: m.threadRef });
    }
    return out;
  }

  async function latestRun(threadRef: string): Promise<{ status?: string; finishedAt?: number }> {
    const rows = await deps.q(
      "select status, finished_at from runs where session_id = $1 order by created_at desc limit 1",
      [threadRef],
    );
    const r = rows[0];
    return r ? { status: r.status as string, finishedAt: Number(r.finished_at ?? 0) || undefined } : {};
  }

  async function lastPurpose(sessionId: string): Promise<string | undefined> {
    const rows = await deps.q(
      "select payload from session_entries where session_id = $1 and type = 'tool_call' order by seq desc limit 1",
      [sessionId],
    );
    try {
      const p = JSON.parse(String(rows[0]?.payload ?? "")) as { purpose?: unknown; tool?: unknown };
      if (typeof p.purpose === "string") return p.purpose.slice(0, 60);
      if (typeof p.tool === "string") return p.tool;
    } catch {
      /* no tool call yet */
    }
    return undefined;
  }

  async function metricsFor(s: SessionRow): Promise<WorldRunMetrics & { t0: number; t1: number }> {
    const [runs] = await deps.q(
      "select count(*)::int as n, min(created_at) as t0, max(finished_at) as t1 from runs where session_id = $1",
      [s.threadRef],
    );
    const [calls] = await deps.q(
      "select count(*) filter (where type = 'tool_call')::int as calls, count(*) filter (where type = 'tool_result' and payload like '%\"isError\":true%')::int as errs from session_entries where session_id = $1",
      [s.sessionId],
    );
    const t0 = Number(runs?.t0 ?? 0);
    const t1 = Number(runs?.t1 ?? 0);
    return {
      turns: Number(runs?.n ?? 0),
      toolCalls: Number(calls?.calls ?? 0),
      toolErrors: Number(calls?.errs ?? 0),
      wallMs: t1 && t0 ? t1 - t0 : 0,
      t0,
      t1,
    };
  }

  async function track(req: TrackRequest): Promise<WorldRunReport | undefined> {
    const startedAt = Date.now();
    const recalled: Array<{ title: string; steps: number }> = [];
    const onRecall = (e: RecallEvent) => {
      if (e.scopeId !== req.scopeId) return;
      const hit = parseRecallBlock(e.block);
      recalled.push(hit);
      if (recalled.length === 1)
        void hud({
          kind: "memory_event",
          text: "RECALLED PROCEDURE",
          detail: hit.steps ? `${hit.title} · ${hit.steps} steps` : hit.title,
        });
    };
    memorableEvents.on("recall", onRecall);
    try {
      let lastSent = "";
      let quietSince = 0;
      while (Date.now() - startedAt < maxMs) {
        await new Promise((r) => setTimeout(r, pollMs));
        const all = await sessions(req.fireKey);
        if (!all.length) continue;
        const statuses = await Promise.all(all.map(async (s) => ({ s, run: await latestRun(s.threadRef) })));
        const workers: WorkerStatus[] = await Promise.all(
          statuses
            .filter(({ s }) => s.name !== "Root" || all.length === 1)
            .map(async ({ s, run }) => {
              const state = toState(run.status);
              const note = state === "running" ? await lastPurpose(s.sessionId) : undefined;
              return { name: s.name, state, ...(note ? { note } : {}) };
            }),
        );
        const msg = {
          kind: "agent_activity",
          ...(req.anchorTrackId !== undefined ? { anchor_track_id: req.anchorTrackId } : {}),
          hook: req.type,
          workers,
        };
        const key = JSON.stringify(msg);
        if (key !== lastSent) {
          lastSent = key;
          await hud(msg);
        }
        const settled = statuses.every(({ run }) => run.status !== undefined && TERMINAL.has(run.status));
        if (!settled) {
          quietSince = 0;
          continue;
        }
        quietSince ||= Date.now();
        if (Date.now() - quietSince < quietMs) continue;
        return await finish(req, all, startedAt, recalled);
      }
      log(`[worldhooks] ${req.fireKey} tracker gave up after ${fmtS(maxMs)}`);
      return undefined;
    } finally {
      memorableEvents.off("recall", onRecall);
    }
  }

  async function finish(
    req: TrackRequest,
    all: SessionRow[],
    startedAt: number,
    recalled: Array<{ title: string; steps: number }>,
  ): Promise<WorldRunReport> {
    const per = await Promise.all(all.map(async (s) => ({ s, m: await metricsFor(s) })));
    const t0 = Math.min(...per.map(({ m }) => m.t0).filter(Boolean));
    const t1 = Math.max(...per.map(({ m }) => m.t1));
    const total: WorldRunMetrics = {
      turns: per.reduce((a, { m }) => a + m.turns, 0),
      toolCalls: per.reduce((a, { m }) => a + m.toolCalls, 0),
      toolErrors: per.reduce((a, { m }) => a + m.toolErrors, 0),
      wallMs: Number.isFinite(t0) && t1 ? t1 - t0 : 0,
    };
    let captured = 0;
    let captureError: string | undefined;
    if (deps.memory) {
      for (const { s } of per) {
        try {
          captured += await deps.memory.capture(req.scopeId, [], Date.now(), undefined, {
            mode: "automatic",
            sessionId: s.sessionId,
            idempotencyKey: `world-capture:${s.sessionId}`,
          });
        } catch (e) {
          captureError = errMessage(e);
          log(`[worldhooks] ${req.fireKey} capture ${s.name} failed: ${captureError}`);
        }
      }
    }
    const report: WorldRunReport = {
      eventId: req.eventId,
      type: req.type,
      fireKey: req.fireKey,
      scopeId: req.scopeId,
      startedAt,
      finishedAt: Date.now(),
      total,
      sessions: per.map(({ s, m }) => ({
        name: s.name,
        sessionId: s.sessionId,
        turns: m.turns,
        toolCalls: m.toolCalls,
        toolErrors: m.toolErrors,
        wallMs: m.wallMs,
      })),
      recalled,
      captured,
      ...(captureError ? { captureError } : {}),
    };
    const history = deps.store ? (await deps.store.all()).sort((a, b) => a.finishedAt - b.finishedAt) : reports;
    const baseline = [...history].reverse().find((r) => r.type === req.type && r.recalled.length === 0);
    reports.push(report);
    await deps.store
      ?.put(req.fireKey, report)
      .catch((e: unknown) => log(`[worldhooks] run report not saved: ${errMessage(e)}`));
    log(
      `[worldhooks] ${req.fireKey} complete turns=${total.turns} toolCalls=${total.toolCalls} toolErrors=${total.toolErrors} wall=${fmtS(total.wallMs)} recalled=${recalled.length} captured=${captured}`,
    );
    if (recalled.length && baseline) {
      await hud({ kind: "memory_event", text: "LEARNED FROM RUN 1", detail: learnedLine(baseline, report) });
    } else if (captured > 0) {
      await hud({ kind: "memory_event", text: "PROCEDURE LEARNED", detail: `${req.type} · ${captured} workflows` });
    }
    return report;
  }

  async function allReports(): Promise<WorldRunReport[]> {
    if (!deps.store) return [...reports];
    return (await deps.store.all()).sort((a, b) => a.finishedAt - b.finishedAt);
  }

  return { track, reports: allReports };
}

export type WorldSwarmTracker = ReturnType<typeof createWorldSwarmTracker>;
