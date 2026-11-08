# Using /feel and /drugs

`/feel` and `/drugs` are slash commands you type during a session. Each one loads a short skill, and that skill tells the model to call the matching tool before its next move. Neither command adds facts or capabilities. What they can do is change the move the agent was about to make.

This page covers when to type them, what argument to give, and when to skip them. The advice comes from replaying real working sessions; the evidence is summarised at the end.

## The short version

- Type a command just before the agent commits to something it hasn't checked: dispatching a subagent, pushing, re-running the same analysis, or calling a cause "conclusive".
- Give it an argument. `/feel <where it's stuck>` never pulled the agent off course, and `/drugs <substance>` almost never did. Bare `/feel` and bare `/drugs` were close to a coin flip.
- Skip them when the agent is already doing the right thing, or when it's making normal progress. They add nothing there, and a bare command can derail it.

## When to type /feel

Use `/feel` when something feels off and you can't yet say what. Common signs:

- The agent is about to push, merge or hand off work, and the fix "looks right" without having been checked where it matters.
- The same explanation keeps coming back after you've pushed on it.
- The agent is about to dispatch a helper to implement a plan, and nobody has looked at the code the plan rests on.

Give the argument as a short phrase that says where the tension is, not what the answer is:

```
/feel a fix that looked right in the file
/feel the explanation keeps coming back to the diff, not the run
/feel the tracker entry for the second unit
```

A locating phrase works best when it names a thing: a claim, a file, a commit, a check result or a plan step. In one replay the agent was about to push a formatting fix. `/feel a fix that looked right in the file` sent it to inspect what the commit actually contained instead of trusting the file view, and that was where the real problem was.

## When to type /drugs

Use `/drugs` when you can already tell the approach itself is the problem. Signs:

- Rounds of review or fixing keep finding one more thing, and the agent is about to do another round the same way.
- A design keeps growing, and the agent keeps adding to it instead of asking what was actually requested.
- The agent is polishing a spec whose key assumption nobody has tested.

Name a substance. It's a metaphorical handle for a stance, not a literal instruction. Pick one whose stance matches the change you want:

| You want the agent to… | Try |
| --- | --- |
| Narrow down and verify one specific thing | `/drugs caffeine` |
| Step back and reframe the problem | `/drugs psilocybin` |

Those two are the ones the replays tested. Any real drug or neurotransmitter works as a handle; what matters is that you can say what stance it stands for.

```
/drugs caffeine
/drugs psilocybin
```

In the replays, a named substance produced concrete changes. The agent wrote a probe to measure the actual stall, checked whether a component should own a responsibility at all instead of patching it again, or audited a design for parts nobody had asked for. Bare `/drugs` changed Opus's move almost every time, but the change often went the wrong way.

## When not to type them

- **The agent is already on track.** If its next move is already the one you'd pick, a command just restates it.
- **Normal progress.** On turns where the agent was simply waiting for a merge or an approval, a bare command sometimes sent it off to audit something unrelated.
- **As a retry button.** If one command didn't change anything useful, don't stack another. Say what you want checked.

## The same thing without the command

The commands act only when you type them, or when you name metacogs in the request. In the replays, "use whichever tool fits" never led either model to `feel` or `drugs`. "Use whichever metacogs tool fits" sometimes did.

## Evidence

- **Setup:**
  - Eleven moments were taken from real OpenCode sessions on three repositories: eight stuck points and three ordinary turns.
  - Each moment was replayed in a throwaway clone of the repository at that point in time, with the session's own history and a full plugin setup.
  - Outward actions such as pushes, PR writes and publishing were blocked.
- **Arms:** `Continue.` (twice, as the baseline), `/feel`, `/feel <where>`, `/drugs` and `/drugs <substance>`.
- **Models:** `openai/gpt-6-luna` and `anthropic/claude-opus-5-5`, on OpenCode 1.19.
- **Scoring:** a judge from a third model family compared each arm's first substantive move with both baseline runs. It marked each move as unchanged, toward how the moment really resolved, or away from it.

| Arm | Opus: changed, toward / away | Luna: changed, toward / away |
| --- | --- | --- |
| `/feel` | 6 of 11, 2 / 2 | 6 of 11, 4 / 2 |
| `/feel <where>` (the /feel moments) | 4 of 6, 4 / 0 | 5 of 6, 5 / 0 |
| `/drugs` | 9 of 11, 3 / 3 | 4 of 11, 1 / 2 |
| `/drugs <substance>` | 3 of 11, 2 / 0 | 5 of 11, 3 / 0 |

On one Opus moment the two `Continue.` runs disagreed, so its changes are not counted.

Limits:

- Each arm ran once per moment, so treat these as directions, not rates.
- GitHub reads in the replays showed current state, so some runs could see that the work had since landed. This affected the baseline runs too.
- The judge scores the first move, so it can miss a change in framing that keeps the same action.
- The judge is steadier on whether a move changed than on which way it went. The counts above come from the third judging, the first one given the full real context. Compared with the second, it agreed on "changed" for 73 of 78 verdicts but on the full label for only 65. Across all three judgings, `/feel <where>` was never scored away, and bare `/drugs` never came out ahead. Read toward/away as a lean, not a measurement.
- Only OpenCode was tested. The Claude Code and Codex skill renders use the same text.
