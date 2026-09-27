import { errMessage } from "../../util/errors.ts";
import { PayloadTooLargeError, readRawBody, sendJson } from "../http.ts";
import type { BaseCtx, Route } from "./route.ts";

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

export const worldEventRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  { method: "POST", path: "/world-events", auth: "public", handle: incomingWorldEvent },
  { method: "POST", path: "/v1/world-events", auth: "public", handle: incomingWorldEvent },
];
