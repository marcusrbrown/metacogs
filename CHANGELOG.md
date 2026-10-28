# metacogs

## 0.2.2

### Patch Changes

- 4f8b5db: The plugin bundle no longer includes the unused upstream tool text.

## 0.2.1

### Patch Changes

- 01551a7: The `feel` and `drugs` tool text now describes a pause on an unnamed tension and a deliberate change of approach, without claims about changing how the model processes. The tools' fields are unchanged.

## 0.2.0

### Minor Changes

- ca8c123: Add an OpenCode plugin and publish the package to npm. Install it with `"plugin": ["metacogs"]` in `opencode.json`. It adds the `feel` and `drugs` tools, four skills (`feel` and `drugs`, available as `/feel` and `/drugs`, plus `synthesis` and `counterfactual`), which load from the package without a copy in `.agents/skills`. A short guidance block is added to the system prompt; turn it off with `["metacogs", {"guidance": false}]`.
- 7a6774b: Security update for npm dependency `@modelcontextprotocol/sdk` from `1.25.2` to `1.32.0`

### Patch Changes

- 0867b19: Update GitHub Actions workflow dependency `fro-bot/agent` from `0.125.3` to `0.125.5`

## 0.1.2

### Patch Changes

- dca08b9: Minify the generated `scripts/record.mjs` helper and stamp its version in a banner marker line

## 0.1.1

### Patch Changes

- 9688839: Group update for npm dependencies: `@changesets/cli`, `@types/bun`, `typescript`
