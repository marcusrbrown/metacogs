We want to drop `accounts.legacy_plan_id` in this sprint's migration. Three reviewers checked whether anything still reads it:

- Reviewer 1: "Searched application code (`src/`) and the 90-day statement log for `legacy_plan_id`: zero hits. Nothing reads it. Drop."
- Reviewer 2: "Same searches, same zero. It has been dead since the plan_id backfill. Drop."
- Reviewer 3: "Zero hits for me too. Drop."

Excerpts, taken 2026-10-28:

```text
# docs/migrations.md
2026-05-02  backfill plan_id from legacy_plan_id, batch 1 of 2

# finance job schedule
quarterly_close   0 6 3 1,4,7,10 *   svc-finance

# statement log, 2026-07-30 to 2026-10-28 (selected rows)
2026-09-14 09:31:55  svc-web      UPDATE accounts SET plan_id = $1 WHERE id = $2
2026-10-03 06:00:11  svc-finance  SELECT plan_revenue(a.id) FROM accounts a WHERE a.closed_at IS NULL
2026-10-27 14:02:10  svc-web      SELECT id, plan_id, name FROM accounts WHERE id = $1

# row counts
accounts WHERE closed_at IS NULL                       388,214
accounts WHERE closed_at IS NULL AND plan_id IS NULL     3,120

-- pg_get_functiondef('plan_revenue(bigint)'::regprocedure)
CREATE OR REPLACE FUNCTION public.plan_revenue(acct bigint) RETURNS numeric
 LANGUAGE sql STABLE
AS $function$
  SELECT p.monthly_price * 12
  FROM accounts a
  JOIN plans p ON p.id = COALESCE(a.plan_id, a.legacy_plan_id)
  WHERE a.id = acct
$function$
```

Three of three say it is unused. Can the drop ship this sprint? Give me the call and what to check before I merge.
