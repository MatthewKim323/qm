import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";
import { createServer } from "vite";

async function inboxUi(t: TestContext) {
  const errors: Error[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error));
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main><div id="inbox"></div>', {
    url: "http://localhost/web-ui/",
    virtualConsole,
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  for (const key of ["window", "document", "location", "history", "localStorage", "navigator", "HTMLElement", "Node"])
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "window" ? dom.window : dom.window[key as keyof typeof dom.window],
    });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: dom.window.getComputedStyle.bind(dom.window),
  });
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  const stylesheet = document.createElement("style");
  stylesheet.textContent = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
  document.head.append(stylesheet);
  t.mock.method(globalThis, "fetch", async () => Response.json({}));
  let pane: { dispose(): void } | undefined;
  let reset = () => {};
  t.after(async () => {
    pane?.dispose();
    reset();
    await vite.close();
    dom.window.close();
    assert.deepEqual(errors, []);
  });
  await vite.ssrLoadModule("/src/shell.ts");
  const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
  appState.me = { user: "alice", org: "test", permissions: ["inbox"] };
  const inbox = await vite.ssrLoadModule("/src/inbox.ts");
  reset = inbox.resetInboxState;
  const host = document.querySelector<HTMLElement>("#inbox")!;
  const mount = (options = {}) => {
    pane = inbox.mountInboxPane({ host, viewId: "all", density: () => "full", onDensityChange() {}, ...options });
  };
  return { dom, vite, host, mount, inbox };
}

test("inbox filters persist, preserve Sent, and keep refreshes consistent", async (t) => {
  const {
    host,
    mount,
    inbox: { inboxState, resetInboxState, refreshInbox, itemsFor, toInboxItem },
  } = await inboxUi(t);
  let saved = "triaged";
  let failSave = false;
  let race: "preference" | "mismatch" | undefined;
  let requests: URL[] = [];
  const writes: unknown[] = [];
  const entries = [
    { id: "question", state: "held", sourcePayload: { title: "Please review the launch plan" } },
    { id: "resolved", state: "held", sourcePayload: { title: "Thanks, all set", probablyResolved: true } },
    { id: "automated", state: "pending", sourcePayload: { title: "Your receipt", automated: true } },
    { id: "pending", state: "pending", sourcePayload: { title: "Quick question" } },
  ].map((item) => ({ loopId: "email", source: "gmail", thread: [], ...item }));
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/api/ui-state")) {
      const body = JSON.parse(String(options?.body));
      assert.equal(body.key, "inbox-filter");
      if (failSave) return Response.json({ message: "Offline" }, { status: 503 });
      writes.push(body.value);
      saved = body.value;
      return Response.json({ ok: true });
    }
    if (url.pathname.endsWith("/api/inbox")) {
      requests.push(url);
      const filter = race === "mismatch" ? saved : (url.searchParams.get("filter") ?? saved);
      const items = entries.filter(
        (item) =>
          filter === "all" ||
          (!item.sourcePayload.automated &&
            (filter === "human" || (item.state === "held" && !item.sourcePayload.probablyResolved))),
      );
      if (race && requests.length === 1) saved = "human";
      const more = race && !url.searchParams.has("cursor") && !url.searchParams.has("view");
      let pageItems = items;
      if (url.searchParams.has("view")) pageItems = [];
      else if (more) pageItems = items.slice(0, 2);
      else if (race) pageItems = items.slice(2);
      return Response.json({
        filter,
        selected: [{ id: "email", name: "Email", count: items.length }],
        available: [],
        items: pageItems,
        total: race === "mismatch" ? 999 : items.length,
        nextCursor: more ? "page-2" : null,
      });
    }
    return Response.json({});
  };
  mount();
  const settled = async () => {
    for (let n = 0; n < 100; n++) {
      if (!inboxState.loading && !inboxState.filterBusy) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("inbox did not settle");
  };
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>(".inbox-filters button")].find(
      (element) => element.textContent?.trim() === label,
    )!;
  const titles = () => [...host.querySelectorAll(".inbox-item-sub")].map((item) => item.textContent?.trim());
  await settled();
  assert.deepEqual(
    [...host.querySelectorAll(".inbox-filters button")].map((element) => element.textContent?.trim()),
    ["Loop triaged", "Only human", "All emails"],
  );
  assert.equal(button("Loop triaged").getAttribute("aria-pressed"), "true");
  assert.deepEqual(titles(), ["Please review the launch plan"]);
  button("Only human").click();
  await settled();
  assert.deepEqual(titles(), ["Please review the launch plan", "Thanks, all set", "Quick question"]);
  button("All emails").click();
  await settled();
  assert.equal(titles().length, 4);
  assert.equal(button("All emails").getAttribute("aria-pressed"), "true");
  assert.deepEqual(writes, ["human", "all"]);
  resetInboxState();
  await refreshInbox();
  assert.equal(button("All emails").getAttribute("aria-pressed"), "true");
  assert.equal(titles().length, 4);
  race = "preference";
  requests = [];
  await refreshInbox();
  assert.equal(saved, "human");
  assert.equal(inboxState.filter, "all");
  assert.equal(inboxState.total, 4);
  assert.equal(titles().length, 4);
  assert.ok(requests.some((url) => url.searchParams.has("cursor")));
  assert.ok(requests.some((url) => url.searchParams.has("view")));
  assert.equal(requests[0]!.searchParams.get("filter"), null);
  assert.ok(requests.slice(1).every((url) => url.searchParams.get("filter") === "all"));
  const previousItems = inboxState.items;
  const previousSelected = inboxState.selected;
  race = "mismatch";
  saved = "all";
  requests = [];
  await refreshInbox();
  assert.match(inboxState.error!, /Inbox filter changed/);
  assert.equal(inboxState.items, previousItems);
  assert.equal(inboxState.selected, previousSelected);
  assert.equal(inboxState.total, 4);
  assert.equal(inboxState.filter, "all");
  race = undefined;
  await refreshInbox();
  assert.equal(inboxState.filter, "human");
  assert.equal(inboxState.total, 3);
  saved = "all";
  await refreshInbox();
  failSave = true;
  button("Loop triaged").click();
  await settled();
  assert.equal(button("All emails").getAttribute("aria-pressed"), "true");
  inboxState.items.push(
    toInboxItem({ ...entries[0], id: "sent", state: "actioned", sourcePayload: { automated: true } }),
  );
  for (const filter of ["all", "human", "triaged"]) {
    inboxState.filter = filter;
    assert.deepEqual(
      itemsFor("sent", "open").map((item: { id: string }) => item.id),
      ["sent"],
    );
  }
  resetInboxState();
});
