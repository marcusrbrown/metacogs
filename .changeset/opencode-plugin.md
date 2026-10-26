---
'metacogs': minor
---

Add an OpenCode plugin and publish the package to npm. Install it with `"plugin": ["metacogs"]` in `opencode.json`. It adds the `metacogs_feel` and `metacogs_drugs` tools, the `feel` and `drugs` skills (available as `/feel` and `/drugs`), and the `synthesis` and `counterfactual` skills, which load from the package without a copy in `.agents/skills`. A short guidance block is added to the system prompt; turn it off with `["metacogs", {"guidance": false}]`.
