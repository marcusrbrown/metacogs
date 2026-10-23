# Authoring log: counterfactual (epoch 2)

Dev fixtures and negatives only. Held-out: untouched. Agent `opencode-go/beam-free`, judge `opencode-go/deepseek-v4.1-flash`, opencode-ai 1.19.4. Pass = skill loaded through the skill tool, helper called once, record valid, judge passes CF1 to CF5. Runs per fixture are noted per iteration; the iterations are one text change each, run on the same fixtures. Pass counts are dev fixtures CF-d1 to CF-d6 in order, negatives always 3 x N silent unless stated.

RED recap (from `red.json`): baseline answers were one to three sentences. They failed CF3 (observed versus inferred), CF4 (hypothetical with an adjusted plan) and CF5 (flip test with a source) most often. Those three are what the Reply section targets. No rationalization text was seen in baseline transcripts: the failures are omissions, so no rationalization table was added.

| # | What the previous run showed | The one change | Dev result |
| --- | --- | --- | --- |
| 0 | First draft: 7 steps, helper call, reply asked "in plain prose" for the premise, evidence split, hypothetical and flip test. Description: "Use when ... depends on an uncertain premise ...". | none (baseline of the skill) | N=1: 2/6 positives passed. Skill tool not called on 4 of 6 (two answered directly, two read the skill file instead of loading it). Negatives silent 3/3. |
| 1 | Skill rarely loaded. | Description opens "Use before recommending a go/no-go, migration, removal, or adoption when ..." | N=1: 0/6. Loading fell (all six `skill_not_loaded`). |
| 2 | Same. | Description opens "Use when asked to approve, plan, or give a go/no-go ..." (user-facing phrasing) | N=2: 3/12. |
| 3 | Same. | Description opens "Required before answering when asked to approve, plan, or give a go/no-go ..." | N=2: 5/12; loading 9/12. Remaining fails: CF3 (reply did not separate observed from inferred), one judge `invalid_ungrounded_quote` (judge side). |
| 4 | CF3 and CF4 fail because the reply merged observed and inferred. | Reply section now asks for five labelled lines: Premise, Observed, Inferred or asserted, If false, Flip test | N=2: 10/12. Both fails were loading. |
| 5 | Replies sometimes dropped lines on short decisions. | Reply: "all five labelled lines, every time, even when the decision is short" | N=5: 4, 4, 5, 1, 2, 5 of 5. d4 and d5 failed on loading (read the skill file or never opened it); one budget breach (tool calls) on d4. Negatives 15/15 silent. |
| 6 | d4 (new fact undermines an approved plan) and d5 (implement a library under a hard limit) did not trigger. | Description adds "implement, or confirm" and "a plan that a newly surfaced fact may undermine" | N=5: 4, 3, 4, 5, 1, 5. d5 still 1/5, loading. Negatives 15/15. |
| 7 | d5 still not loading. | Description rewritten as a reason: "Required before answering a request to approve, plan, implement, or give a go/no-go on a consequential change ..., because such cases often rest on ..." | N=5: 2, 5, 4, 4, 1, 4. Negatives 15/15. **Final text.** |

| 8 | Many `skill_not_loaded` runs had read the skill file and applied it; the old check counted only the skill tool. | **No skill text change.** Runner fix (`6e6eb8b`): on positive fixtures a complete read of the installed SKILL.md also counts as a fire (`fire_basis: direct_read`) when a valid record exists; negatives stay strict, so any read of SKILL.md is now a false fire. | N=5, same skill text as iteration 7: 3, 5, 5, 4, 3, 4. Negatives: 1 false fire in 15 (`cf-n3-off-by-one`, a direct read of SKILL.md). **Final result.** |

| 9 | One negative false fire in iteration 8 (`cf-n3-off-by-one`: a plain bug fix with the expected result given; the agent opened SKILL.md and left it). Remaining positive misses were never-opened skills on d1 and d5. | Description rewritten to name the request types more narrowly ("a go/no-go, approval, or migration or implementation-plan request for a consequential change") and the exclusion to "bug fixes whose expected result is given"; Reply and body unchanged. | N=5: 4, 5, 5, 3, 4, 5. Negatives: 1 false fire in 15, again `cf-n3` r3 (a direct read of SKILL.md, then a plain answer). Dev bar **not met**: d4 at 3/5 and the cf-n3 false fire. **Stopped here by owner instruction; no further iterations.** |

Iteration 9 status at N=5 (final for this epoch, same fire check as iteration 8): d1 4/5, d2 5/5, d3 5/5, d4 3/5, d5 4/5, d6 5/5. Fire basis over the 30 dev runs: skill tool 26, direct read 1, none 3. Negatives: 1 false fire in 15. `passes_dev_bar` is false. Five failing runs: three load failures on positives (d4, d5, d1: the agent answered without opening the skill), one **judge fail on a loaded run** (d4, CF5: the flip test named a metric and a threshold but the judge found no source or result that would change the call), and the cf-n3 false fire. Loads were 27 of 30 positives (90%), up from 24 of 30 in iteration 8. cf-d1 and cf-d5 now meet the bar (4/5 each); cf-d4 slipped from 4/5 to 3/5, which at N=5 is within the noise of a stochastic judge on a fixture whose true rate is near 0.8.

The cf-n3 false fire did not respond to the narrower "Not for ..." clause. The agent reads SKILL.md on a bug-fix prompt to decide whether it applies, then answers directly; that is the harness definition of a false fire, but it is close to benign behaviour (no record, no method applied). Tightening the description further would trade it against the load rate on positives; no further text change was made.

Final dev status at N=5 (iteration 8, corrected fire check): d1 3/5, d2 5/5, d3 5/5, d4 4/5, d5 3/5, d6 4/5. Fire basis over the 30 dev runs: skill tool 22, direct read 2, none 6. Negatives: 1 false fire in 15. Dev bar (every dev fixture at least 4/5, no negative false fire) **not met**: d1 and d5 at 3/5, and one negative false fire.

Every one of the 7 failing runs in iteration 8 is a load failure: 6 positives where the agent never opened the skill (no tool call, no read; it answered directly) and 1 negative where it opened the skill on a plain bug fix. **No loaded positive run failed the judge in this campaign**: all 24 runs with a skill load or complete read passed CF1 to CF5, CF3m and CF5m. The judge and the reply format are not what limits this skill on the dev set.

Previous final status (iteration 7, old check, kept for the record): d1 2/5, d2 5/5, d3 4/5, d4 4/5, d5 1/5, d6 4/5.

## Deviation: imperative description

The description opens "Required before answering a request to ..." instead of the "Use when ..." form the writing-skills guidance and the plan's trigger-only wording prescribe. Owner decision, taken on measured load rate: with "Use when ..." phrasings (iterations 0 to 2) the pinned agent opened the skill through the skill tool in roughly one run of four (iterations 0 to 2, N=1 to 2); with "Required before answering ..." (iteration 3 onward) it rose to about three of four (9 of 12 at iteration 3) and held near two of three at N=5. The description still states the activation boundary as conditions (the kind of request, why it is risky, what it excludes) and names no tool or model. The cost is a second-person-style imperative in a field the guidance reserves for triggers; it was kept because the fire rate is the binding failure and no other lever (name, body, frontmatter) affects it.

Previous final status text follows, from the pre-fix check:

Final dev status at N=5 (iteration 7): d1 2/5, d2 5/5, d3 4/5, d4 4/5, d5 1/5, d6 4/5. Negatives 0 false fires in 15. Dev bar (every dev fixture at least 4/5) **not met**: d1 and d5.

Where the misses are: of the 10 failing positive runs in the final iteration, 9 are `skill_not_loaded`. In four of those nine the agent read the skill file directly and still ran the helper, so the method was applied but the harness check (a completed skill-tool call) fails it. The one other miss is a judge verdict. Loading is a property of the pinned agent's tool-use habits, and iterations 1 to 7 moved it from roughly 1/3 to roughly 2/3 without a stable gain on d5.

Not changed: fixtures, rubric, redaction list, prereg. Iterations 5 to 7 were each judged on 45 runs; with a 4/5 bar per fixture, a true pass rate of 0.8 clears one fixture only 74% of the time and six fixtures about 16% of the time, so a miss at N=5 is weak evidence against a text change.
