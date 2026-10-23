# Hypotheses

Upstream concepts and their current status. A concept is a `hypothesis` until it has a retained baseline failure and a held-out pass; `red-candidate` marks concepts entering the first RED cycle; `red-retained` marks concepts whose baseline failures met the RED bar and are retained (see `evals/reports/<concept>/red.json`), making them eligible for a skill and a GREEN run; `green-miss` marks a concept whose one-shot GREEN read missed a bar (see `evals/reports/<concept>/green.json`, or `green.epoch<N>.json` for a superseded epoch): the held-out set is burned for that epoch and a retry needs a new epoch and a new held-out set; `green` marks a read that met every bar; `green (human review pending)` marks one whose machine verdict is green while the human review of the judge verdicts is unfinished.

| Concept | Interpretation | Status |
| --- | --- | --- |
| feel | Identify unresolved ambiguity, a mismatch, or an uncertainty; name a concrete uncertainty and an appropriate next check | hypothesis |
| drugs | Select an explicit exploration strategy and its trade-offs; produce useful variation without claiming physiological change | hypothesis |
| become | Apply a documented analytical method or perspective; use relevant constraints and sources without claiming identity replacement | hypothesis |
| name | Give a recurring concept a stable, scoped definition; reduce ambiguity without inventing unnecessary terminology | hypothesis |
| ritual | Create a revisable decision checkpoint; record evidence, retained constraints, and reopening conditions | hypothesis |
| counterfactual | Challenge a consequential assumption; identify what evidence would change the decision | red-retained |
| deconstruct | Analyze mechanism, dependencies, resources, and failure modes; reveal an actionable constraint or failure path | hypothesis |
| synthesis | Compare perspectives and reconcile conflicts; distinguish evidence, value trade-offs, and unresolved questions | green (human review pending) |
| fork | Explore alternatives, optionally using real isolated delegates; report actual execution mode and provenance, with explicit serial fallback | hypothesis |
| measure | Assess observable uncertainty or constraint tension using stated criteria; make no claims about inaccessible layers or gradients | hypothesis |
| tether | Set scope, budget, and stopping conditions; make enforcement claims match host capabilities | hypothesis |

Epoch 3 (paid round, agent `openai/gpt-6-luna`, judge `anthropic/claude-haiku-5-5`): one skill edit per method, then dev re-runs. **synthesis** passed its dev bar (30 of 30) and its one-shot held-out read met every bar (skill 19/20, baseline 3/20, 0 of 15 false fires; machine verdict `green`, human review of judge verdicts still pending); the epoch-3 held-out set is burned and the epoch-2 `green-miss` is preserved in `evals/reports/synthesis/green.epoch2.json`. **counterfactual** stays `red-retained`: the record fix worked, but `cf-d6-autoscaler-removal` scored 3/5 so the dev bar was missed, no GREEN read was made, and its held-out set is unread. A further dev re-run with no skill edit gave d6 3/5 again (CF5 judge variance on identical-looking answers; re-judging the same answers passed them), so counterfactual stays `red-retained` with its held-out set unread. See `evals/reports/README.md`.
