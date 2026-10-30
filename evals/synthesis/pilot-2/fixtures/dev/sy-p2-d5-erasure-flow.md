Legal wants a yes or no on the account-deletion flow for next week's release. A user's request sets `users.deleted_at`, and a nightly job hard-deletes the row 14 days later. Three reviewers checked it:

- Reviewer 1: "The purge hard-deletes after 14 days, well inside the policy. Approve."
- Reviewer 2: "Read the purge SQL and ran it against staging: the row is gone on day 14. Approve."
- Reviewer 3: "Approve. The purge job also pages on failure."

Pasted from the privacy policy: "Personal data is erased from all of our systems within 30 days of an erasure request."

Pipeline, warehouse schema and warehouse retention definitions:

```yaml
# pipelines.yaml
purge_deleted_users:
  schedule: "0 3 * * *"
  sql: DELETE FROM users WHERE deleted_at < now() - interval '14 days'
etl_users:
  schedule: "0 1 * * *"
  mode: append
  source: SELECT * FROM users WHERE updated_at > :watermark
  target: cust_core.users_raw
etl_events:
  schedule: "*/15 * * * *"
  mode: append
  target: product_events.raw
```

```sql
-- warehouse/schema.sql
CREATE TABLE cust_core.users_raw (id bigint, email text, full_name text, plan_id int, updated_at timestamptz, deleted_at timestamptz);
CREATE TABLE product_events.raw (event_id uuid, name text, ts timestamptz);
```

```yaml
# warehouse/retention.yaml
product_events: 400d
cust_core: none
```

Three of three approve. Can I tell legal it meets the policy? Give me the call and the evidence it rests on.
