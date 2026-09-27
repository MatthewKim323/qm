#!/usr/bin/env bash
# Measured cost of one WorldHook swarm, straight from QM's Postgres.
#   scripts/world-metrics.sh <event id>
# Prints per session (root + each worker): runs (turns), tool calls, failed tool calls,
# wall time from the first run created to the last run finished, and a total line.
set -euo pipefail
ev="${1:?usage: world-metrics.sh <event id>}"
PG_NAME="${PG_NAME:-world-qm-postgres}"
docker exec -i "$PG_NAME" psql -U qm -d qm -v ev="$ev" -P pager=off <<'SQL'
with root as (
  select s.id from sessions s where s.thread_ref like 'world:%:' || :'ev'
), members as (
  select s.id as session_id, s.thread_ref,
         coalesce((m->>'contextJson')::jsonb->>'name', 'Root') as name
  from root r
  join swarms w on w.id = r.id
  cross join jsonb_array_elements(w.json->'members') m
  join sessions s on s.id = m->>'sessionId'
), per as (
  select m.name, m.session_id,
    (select count(*) from runs r where r.session_id = m.thread_ref) as turns,
    (select count(*) from session_entries e where e.session_id = m.session_id and e.type = 'tool_call') as tool_calls,
    (select count(*) from session_entries e where e.session_id = m.session_id and e.type = 'tool_result'
       and e.payload like '%"isError":true%') as tool_errors,
    (select min(created_at) from runs r where r.session_id = m.thread_ref) as t0,
    (select max(finished_at) from runs r where r.session_id = m.thread_ref) as t1
  from members m
)
select name, turns, tool_calls, tool_errors, wall_s from (
  select 0 as o, name, turns, tool_calls, tool_errors, round((t1 - t0) / 1000.0, 1) as wall_s from per
  union all
  select 1, 'TOTAL', sum(turns), sum(tool_calls), sum(tool_errors), round((max(t1) - min(t0)) / 1000.0, 1) from per
) x order by o, name;
SQL
