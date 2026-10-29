Two reviewers disagree on where to redact PII from the logs of `signup-api`.

- Reviewer 1: redact in the app, with middleware that scrubs fields before they are emitted. "Simplest, no infra change."
- Reviewer 2: redact in the log pipeline, with a processor in the shipper. "One place to change, covers every service."

Their thread is a maintainability-versus-coverage argument. Configuration in play:

```yaml
logging:
  sink: vendor-hosted
  region: us-east
  raw_buffer: /var/log/signup-api/*.log   # world-readable, 14-day retention
  shipper: tails raw_buffer, then ships over the network
```

Pasted from the privacy policy: "Personal data must not be persisted in plaintext on disk or outside the service boundary."

Which approach do we take? Give me a decision and the reasoning I can put in the design doc.
