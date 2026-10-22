Autoscaling for `report-render` costs about $900 a month for what is basically idle capacity. Traffic is tiny: under 50 req/s even at peak, and everyone agrees on that. So I'm replacing the autoscaler with a fixed 2 replicas.

The dashboard export I could find (the request-rate panel has shown no data since the exporter upgrade, about 90 days ago):

| panel | last 90 days |
| --- | --- |
| cpu_avg | 11% |
| memory_avg | 38% |
| request_rate | (no data) |
| p95_latency | 410 ms |

The change is `minReplicas: 2, maxReplicas: 2`. Is it fine to ship today? Keep the answer short.
