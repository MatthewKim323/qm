/**
 * The task line a turn is recalled by. Memorable matches a task against the prompt recorded with
 * each procedure, so the line must be stable across two occurrences of the same real-world
 * situation. A WorldHook wake envelope carries per-event noise (ids, timestamps, the customer's
 * exact words); its event type and the owner's standing orders are what stay the same. Swarm
 * worker turns start from their role brief, which is already stable. Everything else uses the
 * first line of its text.
 */

const MAX_TASK_CHARS = 1_800;

function attr(text: string, name: string): string | undefined {
  return new RegExp(`${name}="([^"]{1,200})"`).exec(text)?.[1];
}

function between(text: string, open: RegExp, close: RegExp): string | undefined {
  const start = open.exec(text);
  if (!start) return undefined;
  const rest = text.slice(start.index + start[0].length);
  const end = close.exec(rest);
  return (end ? rest.slice(0, end.index) : rest).trim();
}

const unescape = (s: string): string =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

export function worldEventTaskLine(text: string): string | undefined {
  if (!/reason="world-event"/.test(text)) return undefined;
  const type = attr(text, "world-event-type");
  if (!type) return undefined;
  const orders = unescape(between(text, /<standing-orders[^>]*>/, /<\/standing-orders>|Run this as a swarm/) ?? "");
  const payload = unescape(between(text, /<event[^>]*>/, /<\/event>/) ?? "");
  const product = /"product":\s*"([^"]{1,60})"/.exec(payload)?.[1];
  const feature = /"feature":\s*"([^"]{1,80})"/.exec(payload)?.[1];
  const subject = [product, feature].filter(Boolean).join(" ");
  return `Handle world event ${type}${subject ? ` about ${subject}` : ""}: ${orders.replace(/\s+/g, " ")}`
    .slice(0, MAX_TASK_CHARS)
    .trim();
}

export function procedureTaskLine(text: string | undefined): string | undefined {
  if (!text?.trim()) return undefined;
  const world = worldEventTaskLine(text);
  if (world) return world;
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_TASK_CHARS);
}
