---
title: "Scrub session text by failing closed: pattern scanner plus a key-next-to-assignment rule, never parse the value"
date: 2026-11-16
category: best-practices
module: src/spike/workflow-loads
problem_type: best_practice
component: tooling
severity: high
tags: [scrubbing, credentials, fail-closed, secrets, session-text, redaction, bounded-decoding]
related_components: [testing_framework]
applies_when:
  - "Text that came from a recorded agent session will leave the machine, or reach a model, a log or a committed file"
  - "A scrubber has to catch credentials in tool inputs and outputs whose shape you do not control"
  - "A review round found one more way a credential value slipped past a value-parsing rule"
---

# Scrub session text by failing closed: pattern scanner plus a key-next-to-assignment rule, never parse the value

## Context

metacogs#100 added a spike that read recorded `ce:plan` and `ce:review` sessions and sent scrubbed chunks to a labeling model. Session text holds tool inputs and outputs: config files, shell commands, JSON inside JSON strings. The scrubber had to keep credentials out of every request.

The first design recognized credential values: find a credential key, read what follows, withhold only if the value looks real. Fro Bot reviewed the PR in five rounds, and each of the first four reproduced a credential that survived. The bypasses fell into four classes:

- **Serialization and escaping.** A structured tool input serialized before the scan escaped the quotes the key rule needed. An escaped form feed between key and `:` was not on the separator list.
- **Value exemptions.** A placeholder prefix (`$`, `<`, `[`, `{`) exempted a real value, and a real value after a placeholder.
- **Structure.** A list or object value lost its key context at the leaves. A duplicate JSON property hid the earlier key from a parse. JSON inside a Markdown fence or behind a label was never decoded.
- **Unsafe limits and truncation.** Traversal past a fixed depth returned "no secret". metacogs#103's first round found that scanning only the first 8,192 characters let a long quoted value or token prefix through, because the closing context the rule needed fell outside the window.

The code the rounds converged on is recorded at commit `861f09d` in [`src/spike/workflow-loads/scrub.ts`](https://github.com/marcusrbrown/metacogs/blob/861f09d/src/spike/workflow-loads/scrub.ts). metacogs#106 removed the spike (13,568 lines) before it ran on a real session store. The rules below apply to any scrubber between session text and an external reader. They reduce what slips through; they are not a proof that every credential encoding is caught.

## Guidance

1. **Run a secret-pattern scanner, and add a fail-closed key rule on top of it.** The scrubber ran the repo's pattern scanner (`scanText` in `src/scan/secrets.ts`, called in `fixture` mode at `scrub.ts:115`) on every form of the text, for credentials with no key next to them: provider keys, tokens, JWTs, private-key blocks, bearer headers. The key rule below adds coverage for values the patterns don't recognize. Neither rule alone is enough: a bare credential with no assignment passes the key rule and is caught only if a pattern fires.
2. **Withhold on a credential key name next to an assignment, and never read the value.** Withhold the whole text when a credential key name (the password family, `secret`, `token`, API, access and private key, `credential`, `auth`, `authorization`, `cookie`, also as the end of a longer name such as `db_password`) is followed by `:` or `=` after a short run of separators (`CREDENTIAL_ASSIGNMENT`, `scrub.ts:46`). No placeholder exemption, no value shape, no quote check. A key name with no assignment next to it stays. The accepted cost is false positives: `token: ${VAR}` is withheld too.
3. **Name separators by shape, and fail closed past the bound.** The separator class covered quotes, brackets, backslashes, whitespace, control characters, and backslashes followed by a letter (`SEPARATOR`, `:44`), so an escape form counts without being listed. At `861f09d` it allowed at most 16 separators (`MAX_SEPARATORS`, `:39`), and a longer run was not a finding: a credential key followed by 17 spaces and `=` did not match the rule and passed unless a pattern fired. That was a coverage gap in the deleted code. Close it by treating an overlong separator run after a credential key as uninspectable and withholding the text.
4. **Decode in bounded layers, as an extra view, not the gate.** Run the rules on the text as written. Then replace every escape with its character until the text stops changing (`unescapeText`, `:104`; loop in `inspectText`, `:120`), and run the rules on each form. Also decode JSON the text holds, whole or after a label, and check each string inside again (`decodeInto`, `:158`; `inspectValue`, `:167`). Treat any object key that names a credential as a finding whatever its value. Check a structured tool input before it is serialized (`inputHoldsSecret`, `:205`).
5. **Make every limit's over-limit outcome "withhold".** The bounds were 8 decoded JSON layers, 64 nested containers, 25,000 values visited and 100,000 characters (`SCRUB_LIMITS`, `:60`). The line scanner's cost grew with the square of line length (about 1.7 s at 80,000 characters), so a line over 20,000 characters was withheld without a scan (`hasLongLine`, `:88`). A reached limit reports as `scrub-limit`, so counts show how much was withheld as uninspectable. Rule 3's separator bound is the exception the deleted code missed.
6. **Scan the whole text before cutting it, and never window the scan.** A pattern that needs closing context is recognized only in full. Scan and transform the whole text, then cut (`finish`, `src/spike/workflow-loads/mask.ts:142` at `861f09d`). A cut that would land inside an escape sequence withholds the text instead. Bound the cost with rule 5's limits, not a shorter scan.
7. **Run the pre-send guard on exactly what is sent,** with the same rules as the scrub, and again on the cut text.

When a scrubber's review keeps finding "one more shape" of value, stop adding shapes: move the decision to the key name, keep the pattern scanner, and make every bound fail closed. A withheld chunk costs a measurement point; a leaked credential cannot be recalled.

## Related

- metacogs#100 (the spike; four Fro Bot rounds with requested changes, then approval), metacogs#103 (whole-text scan, `861f09d`), metacogs#106 (spike removed before a real run).
- [Eval fixtures need headroom: screen the baseline before spending a skill arm](eval-fixture-headroom-baseline-screen-before-skill-arm-2026-10-29.md)
