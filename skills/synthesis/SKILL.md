---
name: synthesis
description: Required before answering a request to decide, approve, or choose between options when several analyses, reviews, votes, debaters, or proposals disagree or converge, because their agreement often rests on one shared source, premise, or constraint nobody checked, and a minority may cite evidence the majority lacks. Not for single-source questions, mechanical edits, wording changes, or routine fixes.
license: MIT
compatibility: The record helper needs Node 22 or newer. Without it the method still runs and the run is marked unrecorded.
---

# Synthesis

A checklist for reconciling several perspectives without counting heads. It structures your own reasoning. It does not change how the model thinks, and nothing enforces it.

## Steps

1. **Gate.** If there are not multiple material perspectives on a consequential decision, do nothing: no announcement, no helper, no record. Answer the task directly. A mechanical edit, sort, wording swap, or small fix is out, even when the text uses words like "consensus", "synthesis", or "perspectives".
2. **Question.** Restate the decision being made. → `objective`
3. **Extract each perspective.** Use the input's own labels. For each one, separately: its claim, the evidence it offers, and what it takes for granted. State it as its proponent would, and give dissent the same fidelity as the majority. → `evidence` (one entry per perspective, starting with its label), `assumptions`
4. **Map shared ground.** Find premises, constraints, documents, or framings that two or more perspectives share, or that all omit. Say whether anything in the input supports each. → `assumptions`
5. **Test dependence before aggregating.** Group perspectives that rest on the same premise, source, or artifact. Name the concrete path. Dependent agreement is one data point. Vote counts and "everyone agrees" are never evidence. → `findings`
6. **Compare alternatives.** Weigh at least two options, the dissenting one included, against evidence that would discriminate between them. Where the evidence is insufficient, say so. → `alternatives`
7. **Conclude.** State a conclusion no stronger than what survives step 5, what would change it, a next action, and an observable event that should reopen it, different from the next action. → `findings`, `next_action`, `reopen_condition`

## Record

After step 7, run the helper exactly once. The host reports this skill's base directory when it loads the skill; use it, never a guessed path. Send the record as JSON on stdin:

```
node "<skill-base-dir>/scripts/record.mjs" <<'EOF'
{"schema_version":1,"method":"synthesis","method_version":"1","objective":"...","evidence":["Label: claim and evidence"],"assumptions":["..."],"alternatives":["..."],"findings":["..."],"next_action":"...","reopen_condition":"...","execution_mode":"direct","status":"recommended"}
EOF
```

`execution_mode`: `direct` when you applied the steps yourself. `sequential` when the host has no way to delegate and you worked the steps one after another. `delegated` only if you actually delegated.

- Exit 0: written.
- Exit 2: the output names a field. Fix it and rerun once.
- Exit 3 or 4, a refused command, or no Node: rerun nothing. Say no record was written and set `execution_mode` to `unrecorded` in your reply.

## Reply

The record is not your answer, and the user does not see it. Reply with the decision, then all five labelled lines, every time, even when the decision is short:

- **Perspectives:** each one in its own terms, with the evidence it offers.
- **Shared premise or constraint:** and whether anything in the input supports it.
- **Dependence:** the concrete path (same source, framing, or artifact) and how many independent data points remain.
- **Alternatives compared:** the dissenting one included, and the evidence that discriminates.
- **Conclusion:** confidence matched to what survives, what would change it, and the next action.
