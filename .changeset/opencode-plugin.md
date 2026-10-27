---
'metacogs': minor
---

Add an OpenCode plugin and publish the package to npm. Install it with `"plugin": ["metacogs"]` in `opencode.json`. It adds the `feel` and `drugs` tools, four skills (`feel` and `drugs`, available as `/feel` and `/drugs`, plus `synthesis` and `counterfactual`), which load from the package without a copy in `.agents/skills`. A short guidance block is added to the system prompt; turn it off with `["metacogs", {"guidance": false}]`.
