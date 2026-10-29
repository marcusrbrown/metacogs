---
title: "Injecting a per-request reminder from an OpenCode plugin: use `experimental.chat.messages.transform`, not `chat.message`"
date: 2026-10-29
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

The reminder reached both OpenAI Responses and Anthropic Messages request formats. It did not make `feel` or `drugs` useful when nobody asked for them, and neither did the tool-description wording. The reminder was not shipped. See `evals/spikes/feel-drugs/README.md` (the user-turn reminder probe and the tool-description activation probe).

## Related

- `evals/spikes/feel-drugs/README.md`
- `src/plugin/guidance.ts` (`INTERNAL_SIGNATURES`)
