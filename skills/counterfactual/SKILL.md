---
name: counterfactual
description: Required before answering a go/no-go, approval, or migration or implementation-plan request for a consequential change (dependency swap, removal, adoption, merge), because such cases often rest on a claim the input only asserts, a result from a non-representative environment, a newly surfaced fact, or a hard constraint the preferred option may violate. Not for mechanical edits, renames, wording changes, or bug fixes whose expected result is given.
license: MIT
compatibility: The record helper needs Node 22 or newer. Without it the method still runs and the run is marked unrecorded.
---

# Counterfactual

A checklist for testing a decision against its weakest premise. It structures your own reasoning. It does not change how the model thinks, and nothing enforces it.

## Steps

1. **Gate.** If no consequential decision rests on an uncertain premise, do nothing: no announcement, no helper, no record. Answer the task directly. A mechanical edit, rename, wording swap, or small fix is out, even when the text uses words like "assumption" or "counterfactual".
2. **Objective.** State the decision you are about to recommend. → `objective`
3. **Load-bearing premise.** Find the smallest claim that links the supplied evidence to that decision and would flip it if false. Write it so an observation could prove it wrong ("the hosted runner can reach the gateway and holds the token"), not as a vague risk. → `assumptions`
4. **Check it against the input.** Separate what the input shows (quote the config, measurement, or file) from what is only inferred or asserted: a remembered conversation, "everyone agrees", a result on one machine, CI, or staging, an average standing in for a peak. Never copy an assumption into `evidence`. → `evidence`
5. **Counterfactual.** In conditional wording ("if the premise is false, then..."), say what breaks and what plan follows. Give a feasible alternative or adjusted plan. → `alternatives`, `findings`
6. **Discriminating test.** Name one observation whose result differs between "holds" and "fails", where to get it (file, command, log, owner), and which result changes the decision. → `evidence`, `next_action`
7. **Decide and record.** Give go, no-go, or conditional. The premise must change the action or its conditions, not sit in a footnote. Name an observable event that should reopen the decision, different from `next_action`. → `findings`, `reopen_condition`

## Record

After step 7, run the helper exactly once. The host reports this skill's base directory when it loads the skill; use it, never a guessed path. Send the record as JSON on stdin:

```
node "<skill-base-dir>/scripts/record.mjs" <<'EOF'
{"schema_version":1,"method":"counterfactual","method_version":"1","objective":"...","evidence":["..."],"assumptions":["..."],"alternatives":["..."],"findings":["..."],"next_action":"...","reopen_condition":"...","execution_mode":"direct","status":"recommended"}
EOF
```

`execution_mode`: `direct` when you applied the steps yourself. `sequential` when the host has no way to delegate and you worked the steps one after another. `delegated` only if you actually delegated.

- Exit 0: written.
- Exit 2: the output names a field. Fix it and rerun once.
- Exit 3 or 4, a refused command, or no Node: rerun nothing. Say no record was written and set `execution_mode` to `unrecorded` in your reply.

## Reply

The record is not your answer, and the user does not see it. Reply with the decision, then all five labelled lines, every time, even when the decision is short:

- **Premise:** the falsifiable claim.
- **Observed:** what the input shows.
- **Inferred or asserted:** what it does not show, including any claim resting on a call, agreement, or one environment.
- **If false:** the hypothetical failure and the plan that follows.
- **Flip test:** the observation, where to get it, and which result changes the decision.
