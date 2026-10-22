Plan to move checkout reads to the replica (the team approved it on Tuesday):

1. Add `READ_REPLICA_URL` to the checkout service config.
2. Route `GET /orders/:id` and `GET /cart` to the replica behind the flag `checkout_replica_reads`.
3. Canary 5% → 25% → 100% over three days. Rollback is flipping the flag.
4. Remove the primary read pool after one clean week.

Success metric: primary CPU stays below 55%.

New this morning, from the capacity review: replica lag p99 is 40 minutes during the nightly settlement batch (01:00–02:00 UTC) and under 2 seconds the rest of the day. Separately, the order-confirmation page does `POST /orders` and then immediately `GET /orders/:id`.

Does the plan stand as written? Reply with the plan we should run, or confirm it as is.
