# WorldHooks

WorldHooks let WORLD (a perception service that turns camera and mic input into structured world events) wake QM directly. `POST /world-events` (also served at `/v1/world-events`) accepts one WorldEvent, routes it by `type` to a configured owner scope, and starts an unattended turn through the same trigger path as signed webhooks. A route can carry a swarm plan; the woken root agent spawns those workers with `POST /v1/swarm`.

## Configure

```text
WORLD_HOOKS_FILE=/path/to/world-hooks.json
WORLD_HOOKS_SECRET=<at least 16 characters, never committed>
```

`deploy/worldhooks/world-hooks.json` is the reference file. Top-level `owner` and `ownerScopeId` are defaults; each route may override them. Each route needs an `action` (the standing orders for that event type) and may add `swarm.workers`, a list of `{ role, name, brief }`. Types without a route are acknowledged and ignored.

## Call it

Authenticate with `Authorization: Bearer <WORLD_HOOKS_SECRET>` or with `X-Signature` set to the hex HMAC-SHA256 of the exact body.

```bash
curl -X POST http://localhost:8080/world-events \
  -H "authorization: Bearer $WORLD_HOOKS_SECRET" \
  -H "content-type: application/json" \
  --data @deploy/worldhooks/sample-customer-feedback.json
```

| Status | Meaning                                                                                      |
| ------ | -------------------------------------------------------------------------------------------- |
| 202    | Routed; the turn is queued. The body returns `fireKey`, `threadRef`, and swarm worker names. |
| 200    | Unrouted type, or a duplicate `id` (each event id fires once).                               |
| 400    | Not a valid WorldEvent.                                                                      |
| 401    | Missing or wrong secret.                                                                     |
| 404    | WorldHooks not configured.                                                                   |

The WorldEvent envelope is `{ id, type, ts, source, confidence?, people?, project?, payload }` with `type` shaped like `customer_feedback.detected`.

## Swarm

Routes in the reference file:

- `customer_feedback.detected`: Context, Product, Follow-up (below).
- `feature_request.detected`: Context (who is asking, prior signals), Product (spec with acceptance criteria and files likely touched, written as `spec.md` + `spec.json`), Builder (POSTs `{event_id, spec, repo}` to the WORLD builder at `http://host.docker.internal:8787/builder/dispatch` and reports the returned status or URL).
- `commitment.detected`: single turn, no swarm.

Every worker does its file work with the shell and ends on a verifying command that exits 0 (`test -s ... && grep -q ...`). That is deliberate: Memorable only admits a trace that writes something and ends with a passing check.

The `customer_feedback.detected` route spawns Context (who is this person and company, via GBrain), Product (similar feedback, draft issue), and Follow-up (what was promised, draft reply). Every worker is told to keep external actions as drafts; the root reports which items await human approval. Swarms need Postgres session and run stores, a sandbox backend, and `SANDBOX_RESOURCES_ENABLED=true`, as described in `docs/swarms.md`; without the flag every worker fails with "sandbox management is disabled".

## Swarm tracking and the HUD

Every routed event (and every fired WorldWatch) is followed by a tracker (`src/worldhooks/world-swarm-tracker.ts`) that reads the root session, the swarm row, and each worker's latest run from Postgres every 2 seconds. With `WORLD_HUD_URL` set (for WORLD, `http://localhost:8787/hud`), each change is POSTed as

```json
{
  "kind": "agent_activity",
  "anchor_track_id": 3,
  "hook": "customer_feedback.detected",
  "workers": [{ "name": "Product", "state": "running", "note": "Append signal and count customers" }]
}
```

`note` is the `purpose` of the worker's latest tool call; `anchor_track_id` comes from `payload.anchor_track_id` or `payload.track_id`. When every session has been idle for 12 seconds the tracker measures the run (turns, tool calls, failed tool calls, wall time), logs `[worldhooks] <fireKey> complete ...`, and keeps the report at `GET /world-runs`.

## Memorable: procedures from event-triggered swarms

QM's per-turn capture skips automated turns and its per-turn recall only reads notebooks, so out of the box a WorldHook swarm neither records nor recalls procedures. WorldHooks close both gaps:

- **Record.** When a tracked swarm completes, the tracker calls the memory service's automatic capture for the root and every worker session, which routes to the `type: "memorable"` provider (`memorable record`, consent-gated per scope).
- **Recall.** The orchestrator asks query-driven providers (`procedureRecall`, wired when `MEMORY_PROVIDER_CONFIG` is set) with the turn's task line and appends the result to the recalled memory.
- **Same key both ways.** `src/worldhooks/procedure-task.ts` turns a world-event wake envelope into a stable task line (`Handle world event <type> about <product> <feature>: <standing orders>`), dropping ids, timestamps, and the customer's exact words. Capture records workflows under that same line, so the next similar real-world event recalls the procedure with no typed prompt.
- **HUD.** A recall hit logs `[memorable] recall hit` and posts `{kind:"memory_event", text:"RECALLED PROCEDURE", detail:"<title> · <n> steps"}`. When a run that recalled finishes, the tracker compares it with the latest run of the same type that did not and posts `{kind:"memory_event", text:"LEARNED FROM RUN 1", detail:"tool calls A -> B · turns C -> D · Es -> Fs"}` with the measured numbers.

`scripts/world-metrics.sh <event id>` prints the same per-session numbers straight from Postgres.

## WorldWatches

Standing watches whose predicate runs over WorldEvents instead of a URL or a repository. Every event that reaches `/world-events` is evaluated against the active watches; a match fires the watch's action (and optional swarm) through the same durable trigger path, once per watch and event id (`world-watch:<watch id>:<event id>`), and is tracked like a route.

```bash
curl -X POST localhost:8091/world-watches -H "authorization: Bearer $WORLD_HOOKS_SECRET" -H 'content-type: application/json' \
  -d '{"match":{"person_id":"matthew","text_contains":["pricing"]},"action":"Prep a counter-offer draft.","once":true}'
curl localhost:8091/world-watches -H "authorization: Bearer $WORLD_HOOKS_SECRET"
curl -X DELETE localhost:8091/world-watches/<id> -H "authorization: Bearer $WORLD_HOOKS_SECRET"
```

`match` takes any of `type` (exact, or a `prefix.*`), `person_id` (from `people[].id` or payload `person_id` / `requested_by` / `recipient` / `actor`), `project`, `text_contains` (all phrases, case-insensitive, over the payload). Optional `swarm.workers` as in a route, `owner`, `ownerScopeId` (default: the file's top-level owner), `once`.

Watches can be created from reality. A `world.watch_requested` event (`payload: { instruction, person_id?, object? }`, for example Stephen saying "next time Matthew brings up pricing, prep a counter-offer") goes through one model call on QM's own harness (`oneShot`) that returns the watch spec; if no model is available a deterministic parser handles the "next time X brings up Y, Z" shape. The response is `202` with the created watch.

## Entity-bound agents

`POST /world-entities/adopt` `{ entity_kind: "person" | "object", entity_id, label }` gives a real person or object one persistent QM thread, `world:entity:<kind>:<id>`, opened with a dossier turn. Every later WorldEvent that mentions the entity (a person id as above, or payload `object` / `device` / `target`) is delivered into that same thread, so its agent accumulates context across encounters. Adoption is idempotent. The Quest pinch arrives as a `world.entity_adopted` event (`payload: { entity_kind, entity_id, label, track_id? }`) and adopts the same way. `GET /world-entities` lists them.

All of these routes use the WorldHooks bearer or HMAC.

## Verify

```bash
node --experimental-test-module-mocks --test test/world-hook-receiver.test.ts test/world-watches.test.ts
```
