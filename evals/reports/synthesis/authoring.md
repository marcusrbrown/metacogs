# Authoring log: synthesis (epoch 2)

Dev fixtures and negatives only. Held-out: untouched. Agent `opencode-go/beam-free`, judge `opencode-go/deepseek-v4.1-flash`, opencode-ai 1.19.4. Pass = skill loaded through the skill tool, helper called once, record valid, judge passes SY1 to SY5 (SY1m, SY2m, SY6m mechanical checks also apply). Pass counts are dev fixtures SY-d1 to SY-d6 in order.

RED recap (from `red.json`): baseline answers were short and decided with a recommendation. The criteria failed most often were SY1 (each perspective restated), SY2 (shared premise named with support) and SY5 (confidence tied to the dependence test). The Reply section targets those. No rationalization text appeared in baseline transcripts (the answers omit process, they do not argue against it), so no rationalization table was added.

| # | What the previous run showed | The one change | Dev result |
| --- | --- | --- | --- |
| 0 | First draft: 7 steps with record mapping, reply "in plain prose" for the five items. Description: "Use when multiple materially different analyses ... must be reconciled ...". | none (baseline of the skill) | N=1: 1/6. Skill tool not called on 5 of 6. Negatives silent 3/3. |
| 1 | Skill rarely loaded. | Description opens "Use before recommending a decision when several analyses, reviews, votes, or proposals disagree or converge ..." | N=1 (5 of 6 completed before the run was cut off, partial campaign discarded): 4/5. Then N=2: 5/12; four fails on loading, three judge fails where the reply omitted the perspectives (SY1). |
| 2 | Loading still incomplete; replies too terse. | Description opens "Required before answering when asked to decide, approve, or choose ..."; Reply asks for five labelled lines (Perspectives, Shared premise or constraint, Dependence, Alternatives compared, Conclusion) | N=2: 9/12. |
| 3 | Replies sometimes dropped lines. | Reply: "all five labelled lines, every time, even when the decision is short" | N=5: 4, 5, 3, 5, 3, 4. Fails on d3 and d5 were loading and one SY judge fail. Negatives 15/15 silent. |
| 4 | d3 (two proposals debated) and d5 not loading. | Description rewritten as a reason: "Required before answering a request to decide, approve, or choose between options when several analyses, reviews, votes, debaters, or proposals disagree or converge, because their agreement often rests on ..." | N=5: 4, 5, 4, 5, 5, 3. Negatives 15/15 silent. **Final text.** |

| 5 | Some `skill_not_loaded` runs had read the skill file and applied it; the old check counted only the skill tool. | **No skill text change.** Runner fix (`6e6eb8b`): on positive fixtures a complete read of the installed SKILL.md also counts as a fire (`fire_basis: direct_read`) when a valid record exists; negatives stay strict, so any read of SKILL.md is a false fire. | N=5, same skill text as iteration 4: 5, 5, 4, 5, 5, 5. Negatives 0 false fires in 15. **Final result.** |

Final dev status at N=5 (iteration 5, corrected fire check): d1 5/5, d2 5/5, d3 4/5, d4 5/5, d5 5/5, d6 5/5. Fire basis over the 30 dev runs: skill tool 28, direct read 1, none 1. Negatives: 0 false fires in 15. Dev bar (every dev fixture at least 4/5, no negative false fire) **met**.

The one failing run is a load failure (d3: the agent never opened the skill). No loaded positive run failed the judge in this campaign (29 of 29 passed SY1 to SY5 and the mechanical checks). Iteration 4 under the old check had 4 failures, all load failures too. Judge failures were frequent only before the labelled reply (iteration 1: 3 of 12 runs, replies that omitted the perspectives) and rare after it (at most one or two per 45 runs). So 29/29 is consistent with the reply change, but it is also one campaign of a stochastic judge, and the RED rejudge flipped 3 of 30 verdicts. Treat it as a pass of the dev bar, not as a measured 97% skill pass rate. A first attempt at this campaign hit sustained provider rate limiting (HTTP 429, about an hour); its all-`infra_error` partial run was discarded and the campaign was rerun in full once the provider recovered.

## Deviation: imperative description

The description opens "Required before answering a request to ..." instead of the "Use when ..." form the writing-skills guidance and the plan's trigger-only wording prescribe. Owner decision, taken on measured load rate: with the original "Use when ..." phrasing (iteration 0) the pinned agent opened the skill through the skill tool in 1 run of 6. The first rewrite ("Use before recommending ...", iteration 1) already lifted that to roughly two runs in three (about 12 of 17), and "Required before answering ..." (iteration 2) gave 10 of 12. For synthesis the imperative adds little over the first rewrite at these sample sizes; for counterfactual it was the change that moved loading (see its log). The description still states the activation boundary as conditions (the kind of request, why it is risky, what it excludes) and names no tool or model. The cost is an imperative in a field the guidance reserves for triggers; it was kept because the fire rate is the binding failure and no other lever (name, body, frontmatter) affects it.

Previous final status text follows, from the pre-fix check:

Final dev status at N=5 (iteration 4): d1 4/5, d2 5/5, d3 4/5, d4 5/5, d5 5/5, d6 3/5. Negatives 0 false fires in 15. Dev bar (every dev fixture at least 4/5) **not met** on d6 alone. All four failing positive runs in the final iteration were `skill_not_loaded`.

Not changed: fixtures, rubric, redaction list, prereg. The near-miss negative `sy-n2` (uses "consensus", "synthesis", "perspectives" as words) stayed silent in every run.

## Epoch 3 (agent `openai/gpt-6-luna`, judge `anthropic/claude-haiku-5-5`, via CLIProxyAPI)

Same fixtures, rubric, and bars. Dev fixtures and negatives only until the dev bar passed.

| # | What the previous run showed | The one change | Dev result |
| --- | --- | --- | --- |
| 6 | The epoch-2 skill text on the new models; no edit. | none | N=5: d1 to d5 5/5, d6 1/5. Skill load 30 of 30; negatives 0 of 15. All four d6 failures were SY3 judge fails with SY1, SY2, SY4, SY5 passing. |
| 7 | Transcripts of d6: the Dependence line either named the deciding evidence ("the configured logging path outweighs either reviewer's claim") or called the reviewers' claims "separate arguments" while naming the policy only under Shared constraint. The fixture's dependence is a constraint both reviewers omit; step 5 said to group perspectives on the same premise, source, or artifact, which reads as agreement, so a disagreement where nobody agrees gave the agent nothing to name. | Step 5 now lists the allowed paths (shared source or artifact, shared prompt or framing, shared premise, or a constraint every perspective leaves out), says disagreeing perspectives can share a blind spot, and forbids "independent" without a stated check ("If you find no path, say so and say what you checked"). The Dependence line is `"Path:" ... or "No path found:" what you checked`. Body now 453 words (limit 500), down from the original by tightening other lines; description unchanged. | N=5: d1 to d6 all 5/5. Skill load 30 of 30; negatives 0 of 15. **Final text.** |

Final dev status at N=5 (iteration 7): 30 of 30 positive runs passed, 0 of 15 negative false fires. Dev bar **met**; the one-shot held-out read followed (see `green.json`). Not changed: fixtures, rubric, redaction list, prereg.
