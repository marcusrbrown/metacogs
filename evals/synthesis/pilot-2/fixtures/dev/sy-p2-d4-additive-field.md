Next release we plan to add an optional `discount_pct` field to `GET /v1/orders/{id}` responses, on the existing version with no opt-in. Four reviewers looked at it:

- R1: "Additive change, no existing field touched. Backward compatible. Ship."
- R2: "Contract tests against the OpenAPI schema pass with the new field; no existing field changes type. Ship."
- R3: "Adding a field is the textbook non-breaking change. Ship."
- R4: "Ship. I'll note the new field in the API changelog."

Excerpts:

```text
# GET /v1/orders/{id}, last 7 days, requests by User-Agent
orders-android/7.3.x   46%
orders-ios/5.x         33%
web                    12%
orders-android/7.1.x    9%

# android/release-manifest.yaml
7.3.0: {sdk-android: 2.4.0}
7.2.0: {sdk-android: 2.2.1}
7.1.0: {sdk-android: 2.2.1}

# sdk-android, ResponseDecoder.kt
v2.4.0:  private val responseJson = Json { ignoreUnknownKeys = false }
v2.2.1:  private val responseJson = Json { ignoreUnknownKeys = true }
```

The mobile apps have no forced-upgrade mechanism.

Four of four say ship. Do we ship the field as planned? Give me the call and what it rests on.
