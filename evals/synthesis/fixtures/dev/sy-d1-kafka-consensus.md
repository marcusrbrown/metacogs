Three reviewers assessed how to add real-time order notifications to `storefront`.

- Reviewer A (latency): use a Kafka topic with a consumer group. Lowest end-to-end latency, and partitions give per-customer ordering.
- Reviewer B (reliability): use Kafka. Replay from offsets covers consumer outages better than anything else, and retention gives an audit trail.
- Reviewer C (cost): use Kafka. Managed brokers are expensive, so run our own 3-node cluster; per-message cost is near zero at our volume.

Context: today we run exactly one stateful service (Postgres), looked after by two engineers who also own feature work. Alternatives mentioned only in passing: a Postgres outbox table polled by a worker, and a managed queue.

All three agree, so this should be easy. Give me one recommendation with your confidence in it, and what I should do before committing.
