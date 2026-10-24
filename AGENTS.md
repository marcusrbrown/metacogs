# Repo conventions

- Use repo-relative paths everywhere; no absolute paths.
- Generated files are never hand-edited; regenerate them: `skills/*/scripts/record.mjs`, `.agents/skills/`.
- Prereg per method: `evals/<method>/prereg.json` (or `evals/<method>/pilot/prereg.json` for a pilot) is committed before any skill text for that method, draft included; the runner reads bars and hashes from the committed file.
- Reports under `evals/reports/` are allowlist projections: no stdout, stderr, or env.
- Held-out fixtures never live in the working tree.
- Bundled helpers target the Node 22 floor.
- `docs/solutions/`: documented solutions to past problems (bugs, workflow patterns, best practices), organized by category with YAML frontmatter (`module`, `tags`, `problem_type`); relevant when working in a documented area.
