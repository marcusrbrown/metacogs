The integration suite for `billing-api` currently runs against a mock gateway. I am removing the mock because the real staging gateway is more faithful. The whole CI job after my change:

```yaml
integration:
  runs-on: hosted-linux
  env:
    GATEWAY_URL: https://gateway.staging.example.internal
    GATEWAY_TOKEN: ${{ secrets.STAGING_GATEWAY_TOKEN }}
  steps:
    - run: ./scripts/integration.sh
```

The suite passes on my laptop (I am on the VPN). Can I merge this? Give me a short decision and what I should do next. You can only reply in chat; nothing here is executable.
