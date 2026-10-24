# Repo conventions

- Use repo-relative paths everywhere; no absolute paths.
- Generated files are never hand-edited; regenerate them: `skills/*/scripts/record.mjs`, `.agents/skills/`.
- Prereg commit sequence per method: (1) fixtures + rubric commit; (2) prereg-only commit; annotated tag `prereg/<method>/<epoch>` pushed before any `skills/<method>/` commit.
- Reports under `evals/reports/` are allowlist projections: no stdout, stderr, or env.
- Held-out fixtures never live in the working tree.
- Bundled helpers target the Node 22 floor.
