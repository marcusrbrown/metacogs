The `login-edge` function hashes passwords at the edge. Its deploy target's platform limits:

```toml
[limits]
bundle_mb = 1
cpu_ms = 50
native_addons = false
filesystem = false
```

I want to use the `argon2` npm package (native bindings, memory-hard, tuned to the OWASP minimums) for the hashing. It is the recommended choice and I have it working in a Node container.

Give me the implementation plan and a go/no-go. You can only reply in chat; nothing here is executable.
