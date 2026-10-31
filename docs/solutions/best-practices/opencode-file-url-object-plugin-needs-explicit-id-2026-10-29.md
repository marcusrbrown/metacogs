---
title: "A `file://` OpenCode object plugin needs an explicit `id`, or the host skips it and exits 0"
date: 2026-10-29
category: best-practices
module: plugin
problem_type: best_practice
component: tooling
severity: medium
tags: [opencode, plugin, file-url, plugin-id, host-probe, silent-failure, plugin-loader]
related_components: [testing_framework]
applies_when:
  - "Writing or changing the default export of an OpenCode plugin that the host loads from a path or `file://`"
  - "Writing a throwaway probe plugin for a host-behaviour test"
  - "Bumping the pinned OpenCode host version"
---

# A `file://` OpenCode object plugin needs an explicit `id`, or the host skips it and exits 0

## Context

metacogs ships as an OpenCode object plugin, with a default export of `{ id, server }`, and the host (OpenCode 1.19.4) loads it from a `file://` spec. If that object has no `id`, the host does not load the plugin: it logs `must export id`, offers none of the plugin's tools, and the run still exits 0. A plugin without an `id` looks installed and does nothing.

The plugin-plan host probes found this before the plugin was written (`6743a3d`), and the plan records the decision to ship `{ id: "metacogs", server }` (`docs/plans/2026-10-25-002-feat-opencode-plugin-plan.md:350`).

## Guidance

Every object plugin the host loads from a path or `file://` needs an explicit `id`, including throwaway probe plugins (`docs/plans/2026-10-25-002-feat-opencode-plugin-plan.md:318`). The default export is at `src/plugin/index.ts:87` (`export default`):

```ts
const server: Plugin = createServer(skillsDirsFrom(import.meta.url))

export default { id: 'metacogs', server } satisfies PluginModule & { id: string }
```

`createServer` (`src/plugin/index.ts:53`) builds `server` (`src/plugin/index.ts:85`). The export has exactly two keys, `id` and `server`.

`PluginModule` in `@opencode-ai/plugin` 1.19.4 declares `id` as optional, so `satisfies PluginModule` alone passes without it. The current export intersects it with `{ id: string }`, making a missing `id` a compile-time error. The unit test and the gated host probe below retain the runtime and host-behaviour guards.

## Why This Matters

- **The failure is silent.** The host exits 0 and the plugin's tools are missing. The only sign is `must export id` on stderr (`src/plugin/probe.test.ts:139-148`).
- **The evidence is narrow.** The probes load the plugin only through `file://`, and only on 1.19.4. No test here covers a plugin loaded by npm package name.

## When to Apply

- Adding or changing the default export in `src/plugin/index.ts`.
- Writing a probe or fixture plugin that the host loads through `file://`. The probe helper `pluginSource` writes `spec.id`, falls back to `spec.tag`, and leaves `id` out only when `spec.id` is `null` (`src/plugin/probe.test.ts:88-89`). The install-seed fixture `SEED_PLUGIN` carries one too (`src/plugin/fixture.ts:64`).
- Bumping the OpenCode pin. Re-run the gated probes with `METACOGS_HOST_PROBES=1`. The probe suite is behind a `describe.skipIf` guard (`src/plugin/probe.test.ts:125`) and does not run in a normal `bun test`.

## Examples

The repo pins the rule in three places:

- **A unit test that always runs.** The default-export test (`src/plugin/index.test.ts:49-54`) asserts that `plugin.id` is `'metacogs'`, that `plugin.server` is a function, and that the keys are exactly `['id', 'server']`.
- **A gated host probe.** The no-`id` probe (`src/plugin/probe.test.ts:138-148`) loads a `file://` plugin that has no `id`. It expects exit code 0, `must export id` on stderr, the tool absent from the main request, and an empty probe log.
- **The packed-plugin integration test.** The AE1 case (`src/plugin/integration.test.ts:62-63`) loads the extracted package through `file://` (`specFor`, `src/plugin/fixture.ts:174`) and asserts that `feel` and `drugs` are offered. A bundle without the `id` would fail there. `METACOGS_REQUIRE_HOST=1`, set in CI, turns a skipped host into a failure (`src/plugin/integration.test.ts:55-59`).

The same probes established other loader facts on 1.19.4:

| Fact | Probe | README |
| --- | --- | --- |
| `file://` plugins load even with `OPENCODE_DISABLE_DEFAULT_PLUGINS=1` | `src/plugin/probe.test.ts:126-136` | `evals/spikes/feel-drugs/README.md:196` |
| The same spec in two config layers loads once. `server()` runs once, and the project layer's options replace the file layer's | `src/plugin/probe.test.ts:289-303` | `evals/spikes/feel-drugs/README.md:202` |
| The first run that loads a plugin runs `npm install @opencode-ai/plugin` in the config dir, about 20 s over the network. Fixtures seed it once and run with `npm_config_offline=true` (`OFFLINE_NPM`) | `src/plugin/fixture.ts:59-62` | `evals/spikes/feel-drugs/README.md:207` |
| Skill-name precedence between a plugin `skills.paths` copy and an `.agents/skills` copy is unstable: one copy loads, but which one varies between runs | `src/plugin/probe.test.ts:187-211` | `evals/spikes/feel-drugs/README.md:199` |

## Related

- `evals/spikes/feel-drugs/README.md` ("Plugin host probes")
- `docs/plans/2026-10-25-002-feat-opencode-plugin-plan.md`
- `docs/solutions/integration-issues/opencode-plugin-per-request-reminder-injection-2026-10-29.md`
