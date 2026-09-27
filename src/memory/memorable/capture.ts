import { createHash } from "node:crypto";
import type { SessionEntry } from "../../types.ts";
import { clampChars, stripTerminalControl } from "./inject.ts";
import { procedureTaskLine } from "../../worldhooks/procedure-task.ts";

export interface MemorableToolCall {
  name: string;
  input: Record<string, unknown>;
  result?: { ok: boolean; exit_code?: number };
}

export interface MemorableWorkflow {
  workflow_id: string;
  prompt: string;
  tool_calls: MemorableToolCall[];
}

export interface MemorableCapture {
  session_id: string;
  scope_id: string;
  workflows: MemorableWorkflow[];
}

const MAX_WORKFLOW_ID_CHARS = 200;
const WORKFLOW_ID_DIGEST_CHARS = 16;
const MAX_PROMPT_CHARS = 16_000;
const MAX_TOOL_INPUT_CHARS = 32_000;

function workflowId(sessionId: string, seq: number): string {
  const raw = `${sessionId}-${seq}`;
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, "-");
  if (safe === raw && safe.length <= MAX_WORKFLOW_ID_CHARS) return safe;
  const digest = createHash("sha256")
    .update(`${sessionId}\u0000${seq}`)
    .digest("hex")
    .slice(0, WORKFLOW_ID_DIGEST_CHARS);
  return `${safe.slice(0, MAX_WORKFLOW_ID_CHARS - WORKFLOW_ID_DIGEST_CHARS - 1)}-${digest}`;
}

function cleanPrompt(text: string): string {
  const clean = stripTerminalControl(text).trim();
  return clean.length > MAX_PROMPT_CHARS ? clampChars(clean, MAX_PROMPT_CHARS).trimEnd() : clean;
}

function capInput(input: Record<string, unknown>): Record<string, unknown> {
  let capped: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.length > MAX_TOOL_INPUT_CHARS) {
      capped ??= { ...input };
      capped[key] = clampChars(value, MAX_TOOL_INPUT_CHARS);
    }
  }
  return capped ?? input;
}

const READ_ONLY_HEADS = new Set([
  "cat",
  "ls",
  "grep",
  "egrep",
  "rg",
  "head",
  "tail",
  "jq",
  "find",
  "wc",
  "env",
  "printenv",
  "pwd",
  "echo",
  "sleep",
  "curl",
  "stat",
  "file",
  "which",
  "sort",
  "uniq",
  "cut",
  "true",
]);
const WRITE_SIGNS =
  /(^|[^0-9&])>{1,2}(?!&)|\btee\b|\b(?:mkdir|rm|mv|cp|touch|chmod|ln|install|sed\s+-i|git\s+(?:commit|push|add|tag))\b|\s-X\s*(?:POST|PUT|PATCH|DELETE)\b|\s(?:-d|--data(?:-raw|-binary)?|-F|--form|-T|--upload-file)[\s=@]|\btest\s|\[\s/;

/**
 * A shell command that only looks (reads files, lists, GETs an API, waits). Traces record these as
 * reads so a recalled procedure lists them as skippable context instead of decisive steps; every
 * other command stays an execute.
 */
export function readOnlyCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd || WRITE_SIGNS.test(cmd)) return false;
  const segments = cmd
    .split(/\|\||&&|;|\||\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  return segments.every((part) => {
    const head = part.replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, "").split(/\s+/)[0] ?? "";
    if (head === "python3" || head === "python") return /-m\s+json\.tool/.test(part);
    return READ_ONLY_HEADS.has(head);
  });
}

function securityTainted(entry: SessionEntry): boolean {
  return (entry.payload as { securityTainted?: unknown } | null)?.securityTainted === true;
}

function callKey(call: MemorableToolCall): string {
  return `${call.name}\u0000${JSON.stringify(call.input)}`;
}

export function worthOffering(workflow: MemorableWorkflow): boolean {
  const calls = workflow.tool_calls;
  if (calls.length < 2) return false;
  const first = callKey(calls[0]!);
  return calls.some((call) => callKey(call) !== first);
}

export function captureSession(sessionId: string, entries: SessionEntry[]): MemorableCapture {
  let scopeId = "";
  const outcomes = new Map<string, Array<{ ok: boolean; exit_code?: number }>>();
  for (const entry of entries) {
    if (entry.type !== "tool_result" || securityTainted(entry)) continue;
    const payload = entry.payload as Record<string, unknown> | null;
    if (!payload || typeof payload.callId !== "string") continue;
    const ok = payload.isError !== true;
    const code =
      (payload.tool === "execute" || (payload.tool === "sandbox" && payload.action === "exec")) &&
      typeof payload.code === "number"
        ? payload.code
        : undefined;
    const outcome = { ok, ...(code !== undefined ? { exit_code: code } : {}) };
    const queue = outcomes.get(payload.callId);
    if (queue) queue.push(outcome);
    else outcomes.set(payload.callId, [outcome]);
  }
  const workflows: MemorableWorkflow[] = [];
  let current: MemorableWorkflow = { workflow_id: workflowId(sessionId, 0), prompt: "", tool_calls: [] };
  const close = () => {
    if (current.tool_calls.length) workflows.push(current);
  };
  for (const entry of entries) {
    if (!scopeId && entry.scopeLabel) scopeId = entry.scopeLabel;
    if (securityTainted(entry)) {
      if (entry.type === "user") {
        close();
        current = { workflow_id: workflowId(sessionId, entry.seq), prompt: "", tool_calls: [] };
      }
      continue;
    }
    if (entry.type === "user") {
      const text = (entry.payload as { text?: unknown } | null)?.text;
      if (typeof text !== "string") continue;
      const prompt = cleanPrompt(procedureTaskLine(text) ?? text);
      if (!prompt) continue;
      close();
      current = { workflow_id: workflowId(sessionId, entry.seq), prompt, tool_calls: [] };
      continue;
    }
    if (entry.type !== "tool_call") continue;
    const payload = entry.payload as Record<string, unknown> | null;
    if (!payload || typeof payload.tool !== "string") continue;
    const { tool, callId, ...input } = payload;
    const outcome = typeof callId === "string" ? outcomes.get(callId)?.shift() : undefined;
    const isExec = tool === "execute" || (tool === "sandbox" && input.action === "exec");
    const name = isExec && typeof input.command === "string" && readOnlyCommand(input.command) ? "read" : tool;
    current.tool_calls.push({ name, input: capInput(input), ...(outcome ? { result: outcome } : {}) });
  }
  close();
  return { session_id: sessionId, scope_id: scopeId, workflows };
}
