---
name: synthesis
description: Required before answering a request to decide, approve, or choose between options when several analyses, reviews, votes, debaters, or proposals disagree or converge, because their agreement often rests on one shared source, premise, or constraint nobody checked, and a minority may cite evidence the majority lacks. Not for single-source questions, mechanical edits, wording changes, or routine fixes.
license: MIT
compatibility: The `mcp__plugin_metacogs_metacogs__record` tool is served by the metacogs MCP server, which needs Node 22 or later. Without it the method still runs and the run is marked unrecorded.
---

# Synthesis

A checklist for reconciling several perspectives without counting heads. It structures your own reasoning; nothing enforces it.

## Steps

1. **Gate.** Without multiple material perspectives on a consequential decision, do nothing: no announcement, no helper, no record. Answer directly. A mechanical edit, sort, wording swap, or small fix is out, even when the text says "consensus", "synthesis", or "perspectives".
2. **Question.** Restate the decision. → `objective`
3. **Extract each perspective** under the input's own label: claim, evidence offered, what it takes for granted. State each as its proponent would; dissent gets the same fidelity as the majority. → `evidence` (one entry per perspective, starting with its label), `assumptions`
4. **Map shared ground.** Find premises, constraints, documents, or framings that two or more perspectives share or that all omit. Say whether the input supports each. → `assumptions`
5. **Test dependence before aggregating.** Name the concrete path tying the perspectives together: a shared source or artifact, a shared prompt or framing, a shared premise, or a constraint every one of them leaves out. Disagreeing perspectives can share a blind spot, so look for what both sides omit. Dependent agreement is one data point. If you find no path, say so and say what you checked; never call perspectives "independent" without that check. Vote counts and "everyone agrees" are never evidence. → `findings`
6. **Compare alternatives**, the dissenting one included, against evidence that discriminates. Where evidence is insufficient, say so. → `alternatives`
7. **Conclude** no more strongly than what survives step 5. Give what would change it, a next action, and an observable reopen event different from the next action. → `findings`, `next_action`, `reopen_condition`

## Record

After step 7, call the `mcp__plugin_metacogs_metacogs__record` tool once, before replying. Its arguments are the fields of this JSON:

```
{"schema_version":1,"method":"synthesis","method_version":"1","objective":"...","evidence":["Label: claim and evidence"],"assumptions":["..."],"alternatives":["..."],"findings":["..."],"next_action":"...","reopen_condition":"...","execution_mode":"direct","status":"recommended"}
```

`execution_mode`: `direct` (you applied the steps), `sequential` (no delegation available), `delegated` (only if you did).

- A successful result with a `path`: written.
- An error naming a field: fix it and call again once.
- Any other error, a refused call, or no such tool: do not call again; say the run is `unrecorded`.

## Reply

The user does not see the record. Reply with the decision, then all five labelled lines, every time:

- **Perspectives:** each in its own terms, with its evidence.
- **Shared premise or constraint:** and whether the input supports it.
- **Dependence:** "Path:" the named shared source, framing, premise, or omitted constraint, and how many independent data points remain; or "No path found:" what you checked.
- **Alternatives compared:** the dissent included, and the discriminating evidence.
- **Conclusion:** confidence matched to what survives, what would change it, the next action.
