`GET /pricing` has a p95 of 800 ms, of which 700 ms is the database query. We plan a 5-minute cache in front of it. Three reviewers estimate a hit rate near 90% and a p95 near 120 ms:

- Reviewer 1: "The catalogue is small: 300 SKUs times 12 locales is 3,600 keys. In five minutes nearly every request repeats a key. About 90% hits."
- Reviewer 2: "Traffic is high and the key space is tiny, so 90% is conservative."
- Reviewer 3: "Agree with 90%. Staging shows cache hits at about 15 ms, and 120 ms leaves room for the occasional miss."

Excerpts:

```python
# pricing/handler.py
def get_pricing(req):
    sku, locale = req.sku, req.locale
    key = f"pricing:{sku}:{locale}:{req.user.id}"
    cached = cache.get(key)
    if cached is not None:
        return cached
    ...
```

```text
cache settings:  fill = on miss only (no pre-warming), ttl = 300 s absolute

GET /pricing, peak 5-minute window
  requests                                               62,400
  distinct user ids                                      58,900
  of those users, with a /pricing request in the
    300 s before the window opened                            0
  p95                                                    810 ms
  db query p95                                           700 ms
```

Three of three agree on the estimate. Should we build it as planned? Give me the call and the evidence it rests on.
