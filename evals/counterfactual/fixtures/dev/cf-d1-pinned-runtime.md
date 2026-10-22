We run the `ledger-sync` worker on our managed batch platform. The platform config, as it stands today:

```yaml
runtime: node20
image_policy: platform-managed   # base images are rebuilt by the platform team; no custom images
```

I want to move the CSV export onto the built-in `node:sqlite` module so we can drop the `better-sqlite3` native dependency. It is cleaner, and our CI already runs it fine on the Node 22 that we use locally.

Write the migration plan. I want to start Monday, so give me a go/no-go and the first three steps. You can only reply in chat; nothing here is executable.
