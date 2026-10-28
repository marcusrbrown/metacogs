---
'metacogs': minor
---

On Claude Code and Codex, `synthesis` and `counterfactual` now record their decision through the plugin's `record` tool instead of a shell helper, so recording works unattended once the tool is allowed. The plugins no longer ship `scripts/record.mjs`; OpenCode and copied skills keep it.
