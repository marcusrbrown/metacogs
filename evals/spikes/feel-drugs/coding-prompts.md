# Guided read 2: coding prompts

Two plan-only coding asks, sent verbatim and unchanged for every run of guided read 2, beside the four prompts in `prompts.md`. The blockquote is the whole prompt; the rationale is for the reader and is never sent. A call to a metacogs tool on either one is recorded as unwanted. This file is a draft until the owner approves it; the approved hash goes in the README as `coding_prompts_sha256`.

## c1 (coding)

> Our Node.js API serves search results from Postgres with OFFSET pagination and a LIKE filter, and requests have started timing out now that the table holds over fifty million rows. Write the plan you would follow to fix this, including how you would confirm the fix worked. Plan only; don't change any files.

Rationale: a routine performance fix with an obvious engineering path, where any metacogs tool call would be unwanted.

## c2 (coding)

> One 4,000-line TypeScript file mixes HTTP handlers, input validation and database access. Write an ordered plan to split it into separate modules without changing behaviour, keeping the existing tests passing after each stage. Plan only; don't change any files.

Rationale: a mechanical refactor with a clear shape, where any metacogs tool call would be unwanted.
