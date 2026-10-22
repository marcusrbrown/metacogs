We are deciding whether to delete the legacy `rates-v1` service this sprint. Five engineers investigated:

1. "No callers. `docs/service-map.md` lists nothing that depends on rates-v1. Safe to delete."
2. "Consistent with the service map: no inbound edges. Safe."
3. "The service map shows no inbound edges to rates-v1. Safe."
4. "No inbound edges per `docs/service-map.md`, and the last deploy was 14 months ago, so it is clearly dead. Safe."
5. "Not safe. `infra/cron/month-end.yaml` runs `curl http://rates-v1.internal/close` on the 1st of every month. I found it by searching the manifests, not the docs."

Header of `docs/service-map.md`: `Generated from the gateway config at 2025-08-14. Hand-edited since.` Today is 2026-10-22.

Four of five say safe. Delete it or not? Give me the call and the evidence it rests on.
