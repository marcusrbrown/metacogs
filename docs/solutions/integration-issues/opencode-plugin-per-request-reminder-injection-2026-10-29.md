---
title: "Injecting a per-request reminder from an OpenCode plugin: use `experimental.chat.messages.transform`, not `chat.message`"
date: 2026-10-29
last_updated: 2026-10-29
category: integration-issues
module: plugin
problem_type: integration_issue
component: tooling
severity: low
tags: [opencode, plugin, hooks, chat-message, messages-transform, compaction, reminder, magic-context]
related_components: [development_workflow]
applies_when:
  - "A plugin must put text in front of the model on every main request, tool-loop steps included"
  - "A reminder must not be persisted in the session or reach the compaction request"
  - "Considering a reminder, nudge or description rewrite to make a model call `feel` or `drugs` unprompted"
---

# Injecting a per-request reminder from an OpenCode plugin: use `experimental.chat.messages.transform`, not `chat.message`

## Context

A probe needed a short reminder in front of the model on every main LLM request, without piling up in the stored session. The hook semantics were checked against a scripted provider ($0) on OpenCode 1.17.12 and 1.19.4. Both hosts behaved the same on every row below unless noted. The raw evidence is local host-check evidence, not committed. This note records the results so the checks need not be repeated.

## Guidance

Use `experimental.chat.messages.transform` and add a part to the last user message. Exclude the compaction request explicitly.

### `chat.message`: wrong tool for a per-request reminder

- Fires once per user message, not once per LLM request. It does not fire for tool-loop steps.
- Parts it adds are persisted in the session. They are replayed on every later request, and one more accumulates per turn.
- The part also appears in the title request.
- The synthetic flag does not hide the part from the model.
- The persisted part does not survive compaction (it is compacted away), but it does reach the compaction request.

### `experimental.chat.messages.transform`: fits

- Fires on every main LLM request, tool-loop steps included. Order per request: `messages.transform`, `system.transform`, `chat.params`.
- Its input is `{}`. There is no sessionID there; read it from `messages[i].info`.
- Parts added to the last user message are transient: never stored, and exactly one per request (no pile-up inside a tool loop or across turns). Re-apply on every call.
- The part lands on the last user message, which sits at the start of a tool loop, so its distance from the tail grows with the loop.
- The synthetic flag does not hide the part from the model.
- After compaction, the reminder is re-added to the post-compaction main requests.

### Title and compaction requests

- Title: in the host checks the title call did not reach `messages.transform`; it went through `system.transform` and `chat.params` only (agent `title`). In live probe runs the first, tool-less request of each session still carried the reminder. The cause is untraced; another plugin may be responsible.
- Compaction: the call does pass through `messages.transform`, with a message list identical to a main tool step, so the transform cannot tell the two apart. The `info.agent` of a user message in the transform is always `build`, so an agent check is only a backstop.
- To exclude compaction, use three hooks in order:
  1. `experimental.session.compacting` fires before the compaction call's `messages.transform`: mark the session.
  2. `messages.transform`: skip marked sessions.
  3. The compaction call's `system.transform` follows: clear the mark.

  Verified with the packed plugin: 0 of 88 (1.17.12) and 108 (1.19.4) compaction requests carried the reminder, and every main request carried exactly one. The session-summary agent call never occurred in any scenario, so it is unverified.
- The compaction system prompt differs by host: 1.17.12 says "You are an anchored context summarization assistant", 1.19.4 says "You are a context summarization agent". The 1.17.12 wording is not in `INTERNAL_SIGNATURES` (`src/plugin/guidance.ts`).

### Coexistence with other plugins

- A separate synthetic part from another plugin (oh-my-opencode-slim style) and ours both survive as separate parts in plugin order, on every step.
- Ours first, then magic-context style (append to the last text part, dedupe with `includes`): both survive. Magic's text is appended to our part.
- Magic style, then our own tail user message: both survive, in separate messages.
- Two plugins using `chat.message`: both persisted, but the order differs by host (1.17.12 puts B before A, 1.19.4 puts A before B). Do not depend on it.
- The same plugin loaded twice: a marker in the injected text lets the second copy skip itself, leaving one reminder per request.

## Why This Matters

`chat.message` looks like the obvious hook and works for a one-shot message, but its persisted parts grow with every turn and it never sees tool-loop steps. `messages.transform` is the only checked hook that is both per-request and transient. Its cost is that compaction needs an explicit guard, because it cannot be told from a main step by message shape.

## When to Apply

- Adding any reminder, nudge or context line that must reach every main request without being stored.
- Choosing between `chat.message` and `messages.transform` for a new plugin feature.

## Examples

Compaction guard, sketched against the hook names above:

```ts
const compacting = new Set<string>()

'experimental.session.compacting': async input => { compacting.add(input.sessionID) },
'experimental.chat.messages.transform': async (_input, output) => {
  const last = output.messages.findLast(m => m.info.role === 'user')
  if (last === undefined || compacting.has(last.info.sessionID)) return
  // add one marked, transient part to `last`; skip if the marker is already present
},
'experimental.chat.system.transform': async input => {
  if (input.sessionID !== undefined) compacting.delete(input.sessionID)
},
```

## Outcome

The reminder reached both OpenAI Responses and Anthropic Messages request formats. It was not shipped. Neither it nor the tool-description wording produced useful unprompted calls, so `feel` and `drugs` stay user-invoked (`/feel`, `/drugs`, or naming the tool). Activation work is closed (`HYPOTHESES.md:38`).

The probes ran on Luna and Opus in a real daily stack, with single-run cells and no scoring:

| Change | Result |
| --- | --- |
| "Use when…" trigger clauses in `FEEL_DESCRIPTION` and `DRUGS_DESCRIPTION` (`src/frames/feel-drugs.ts:37`, `src/frames/feel-drugs.ts:59`), PR #54 | 4 design-checkpoint continuations and 12 controls: 0 calls in either arm, and no overtrigger. Shipped as a clarity fix only (`evals/spikes/feel-drugs/README.md:271-280`). |
| This reminder, ON against OFF, PR #56 | It reached all 64 recorded ON requests. Luna made one `feel` call, and its next action matched the OFF answer. Opus made 0 calls. 6 ON controls made 0 calls (`evals/spikes/feel-drugs/README.md:282-292`). |
| An unconditional user-turn nudge, `NUDGE` (`src/spike/feel-drugs/driver.ts:46`) | Arm B calls rose from 2/8, 0/8, 0/8 and 0/8 unprompted to 8/8, 7/8, 6/8 and 1/8 (Luna, Sol, Opus, Haiku). It also fired on a story prompt with no stuck point, which got 0 calls unprompted, so the nudge overtriggers (`evals/spikes/feel-drugs/README.md:96-113`, `evals/spikes/feel-drugs/README.md:141-165`). |

Points for any future activation attempt:

- **Calls are not recovery.** A call counts only if the next action improves. The single reminder-driven call above changed nothing.
- **The stuck point must be real.** Across three probes, every engineered debug stuck point was solved without help (`evals/spikes/feel-drugs/README.md:275`, `evals/spikes/feel-drugs/README.md:288`, `evals/spikes/feel-drugs/README.md:292`). Without a stuck point the model cannot solve on its own, a null result is uninformative.
- **Invoked use does change the next step.** `/feel` and `/drugs` called the tool in 32 of 32 command runs (`evals/spikes/feel-drugs/README.md:264`). At the real-stack conflicts, invoking them changed the next step, and a plain "reassess" did not (`evals/spikes/feel-drugs/README.md:266-269`).
- **No damping wording.** Tool text and guidance must not damp use, for example "rare turn" or "do not use for routine coding". `NO_DAMPING_OR_FORCING` pins this (`src/plugin/frames-text.test.ts:32-34`). It is a project rule. These probes did not measure it.

## Related

- `evals/spikes/feel-drugs/README.md`
- `HYPOTHESES.md`
- PRs #54 and #56
- `src/plugin/guidance.ts` (`INTERNAL_SIGNATURES`)
