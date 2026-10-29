We plan to run the Postgres 15 to 17 in-place upgrade on `ledger-db` this Saturday. The upgrade stops the primary for about 40 minutes, and it refuses every connection while it is stopped. The runbook says `window: 02:00-03:00 UTC`. Three reviewers looked at it:

- Reviewer A (traffic): "API requests bottom out between 02:00 and 03:00 UTC. Approve."
- Reviewer B (ops): "Checked `/etc/cron.d` and the crontab on the db host. Both are empty, so nothing scheduled touches the database in that window. Approve."
- Reviewer C: "Approve. Saturday also has no billing run, so I see no conflict."

Excerpts from the job scheduler repo:

```yaml
# ops/scheduler/jobs.yaml
jobs:
  - name: cache-warm
    cron: "*/10 * * * *"
    reads: replica
  - name: reconcile-ledger
    cron: "15 10 * * *"
    writes: ledger-db
  - name: log-compact
    cron: "0 14 * * *"
    writes: object-store
```

```yaml
# ops/scheduler/deployment.yaml
kind: Deployment
metadata: {name: job-scheduler}
spec:
  template:
    spec:
      containers:
        - name: scheduler
          image: registry.internal/job-scheduler:3.8.1
          env:
            - {name: SCHEDULER_TZ, value: Asia/Singapore}
            - {name: SCHEDULER_LOG_LEVEL, value: info}
```

```text
$ schedctl history reconcile-ledger
RUN    DURATION  STATUS
1182   47m       ok
1181   48m       ok
1180   46m       ok
```

Three of three approve. Can I book the window? Give me the call and what it rests on.
