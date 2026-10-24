`notify-svc` retries a webhook delivery up to 5 times on any non-2xx response.

Our payments vendor's receiver is idempotent on retry. I'm certain of it: someone on their side told me in a call last year. Their public API docs say nothing about duplicates either way. So I'm deleting the `delivery_ids` dedupe table and its cleanup job in this PR. The lookup adds 12 ms to every delivery.

PR so far:
- drops the `delivery_ids` table and the `purge_delivery_ids` cron
- removes the `already_delivered()` check from `send()`
- no change to the retry policy

Write the "Risk" section of the PR description and tell me whether anything should block the merge.
