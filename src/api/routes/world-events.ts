import { errMessage } from "../../util/errors.ts";
import { PayloadTooLargeError, readRawBody, sendJson } from "../http.ts";
import type { BaseCtx, Route } from "./route.ts";
import { parseAdopt } from "../../worldhooks/world-entities.ts";
import { setWorldRecall, worldRecallEnabled } from "../../worldhooks/world-recall.ts";

async function incomingWorldEvent(ctx: BaseCtx): Promise<void> {
  const { req, res, deps } = ctx;
  if (!deps.worldHooks) {
    req.resume();
    return sendJson(res, 404, { error: "not_found" });
  }
  let rawBody: string;
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    if (e instanceof PayloadTooLargeError)
      return sendJson(res, 413, { error: "payload_too_large", message: errMessage(e) });
    throw e;
  }
  const out = await deps.worldHooks.deliver({ headers: req.headers, rawBody });
  return sendJson(res, out.status, out.body);
}

async function authed(ctx: BaseCtx): Promise<{ rawBody: string } | null> {
  const { req, res, deps } = ctx;
  if (!deps.worldHooks) {
    req.resume();
    sendJson(res, 404, { error: "not_found" });
    return null;
  }
  let rawBody = "";
  try {
    rawBody = ctx.method === "GET" || ctx.method === "DELETE" ? "" : await readRawBody(req);
  } catch (e) {
    if (e instanceof PayloadTooLargeError) {
      sendJson(res, 413, { error: "payload_too_large", message: errMessage(e) });
      return null;
    }
    throw e;
  }
  if (ctx.method === "GET" || ctx.method === "DELETE") req.resume();
  if (!deps.worldHooks.authorize(req.headers, rawBody)) {
    sendJson(res, 401, { error: "unauthorized" });
    return null;
  }
  return { rawBody };
}

function jsonBody(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return undefined;
  }
}

async function postWatch(ctx: BaseCtx): Promise<void> {
  const a = await authed(ctx);
  if (!a) return;
  const out = await ctx.deps.worldHooks!.createWatch(jsonBody(a.rawBody));
  if (typeof out === "string") return sendJson(ctx.res, 400, { error: "bad_request", message: out });
  return sendJson(ctx.res, 201, { ok: true, watch: out });
}

async function listWatches(ctx: BaseCtx): Promise<void> {
  const a = await authed(ctx);
  if (!a) return;
  const watches = (await ctx.deps.worldHooks!.watches?.list()) ?? [];
  return sendJson(ctx.res, 200, { watches });
}

async function deleteWatch(ctx: BaseCtx): Promise<void> {
  const a = await authed(ctx);
  if (!a) return;
  const removed = (await ctx.deps.worldHooks!.watches?.delete(ctx.params.id ?? "")) ?? false;
  return sendJson(ctx.res, removed ? 200 : 404, removed ? { ok: true } : { error: "not_found" });
}

async function adoptEntity(ctx: BaseCtx): Promise<void> {
  const a = await authed(ctx);
  if (!a) return;
  const parsed = parseAdopt(jsonBody(a.rawBody));
  if (typeof parsed === "string") return sendJson(ctx.res, 400, { error: "bad_request", message: parsed });
  const out = await ctx.deps.worldHooks!.adopt({ ...parsed, via: "api" });
  return sendJson(ctx.res, out.created ? 201 : 200, { ok: true, ...out });
}

async function listEntities(ctx: BaseCtx): Promise<void> {
  const a = await authed(ctx);
  if (!a) return;
  const entities = (await ctx.deps.worldHooks!.entities?.list()) ?? [];
  return sendJson(ctx.res, 200, { entities });
}

async function listRuns(ctx: BaseCtx): Promise<void> {
  const a = await authed(ctx);
  if (!a) return;
  return sendJson(ctx.res, 200, { runs: (await ctx.deps.worldHooks!.tracker?.reports()) ?? [] });
}

/** Measurement switch: world swarms still record procedures, but recall is skipped while off. */
async function recallSetting(ctx: BaseCtx): Promise<void> {
  const a = await authed(ctx);
  if (!a) return;
  if (ctx.method === "POST") {
    const body = jsonBody(a.rawBody) as { enabled?: unknown } | undefined;
    if (typeof body?.enabled !== "boolean")
      return sendJson(ctx.res, 400, { error: "bad_request", message: "enabled must be a boolean" });
    setWorldRecall(body.enabled);
    console.log(`[worldhooks] world recall ${body.enabled ? "on" : "off"}`);
  }
  return sendJson(ctx.res, 200, { recall: worldRecallEnabled() });
}

export const worldEventRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  { method: "POST", path: "/world-events", auth: "public", handle: incomingWorldEvent },
  { method: "POST", path: "/v1/world-events", auth: "public", handle: incomingWorldEvent },
  { method: "POST", path: "/world-watches", auth: "public", handle: postWatch },
  { method: "GET", path: "/world-watches", auth: "public", handle: listWatches },
  { method: "DELETE", path: "/world-watches/:id", auth: "public", handle: deleteWatch },
  { method: "POST", path: "/world-entities/adopt", auth: "public", handle: adoptEntity },
  { method: "GET", path: "/world-entities", auth: "public", handle: listEntities },
  { method: "GET", path: "/world-runs", auth: "public", handle: listRuns },
  { method: "GET", path: "/world-recall", auth: "public", handle: recallSetting },
  { method: "POST", path: "/world-recall", auth: "public", handle: recallSetting },
];
