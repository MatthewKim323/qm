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

The `customer_feedback.detected` route spawns Context (who is this person and company, via GBrain), Product (similar feedback, draft issue), and Follow-up (what was promised, draft reply). Every worker is told to keep external actions as drafts; the root reports which items await human approval. Swarms need Postgres session and run stores and a sandbox backend, as described in `docs/swarms.md`.

## Verify

```bash
node --experimental-test-module-mocks --test test/world-hook-receiver.test.ts
```
