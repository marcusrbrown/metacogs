---
name: drugs
description: Use when the approach itself needs to change. Examples are requested creative or design exploration stalling on the same few alternatives, or materially different attempts failing the same way so that another attempt would repeat the last one. Session length alone is not a reason.
argument-hint: "[substance]"
---

# drugs

Call the `mcp__plugin_metacogs_metacogs__drugs` tool (not the `drugs` skill; you are reading the skill now) to deliberately change how you approach the next attempt. The named substance is a handle for that change: a short label for the stance you will take, chosen so you can say what it makes you do differently.

Use the tool once you can say the approach itself is the problem. If the stuck point is still unnamed, the `mcp__plugin_metacogs_metacogs__feel` tool comes first.

If the `mcp__plugin_metacogs_metacogs__drugs` tool is unavailable (for example because Node 22 is not installed), continue in plain text and say so.

## What it is and is not

It supplies no facts, adds no capability, and does not guarantee a better result. It is a stated change of approach for the next attempt, and the metaphor stays in service of the task.

## Fields

- `substance`: a specific real drug or neurotransmitter, such as caffeine or acetylcholine, used as a metaphorical handle. Not a person, character, school or method. In `method`, state the task-level change and its tradeoff. Use × to combine two.
- `method`: the task-level change of approach. What you will emphasize, what you will set aside, which assumptions you will stop leaning on. Name the tradeoff; every change of approach costs something.
- `displaces`: the approach this replaces. Name the previous handle, or "baseline" for your default. Naming it keeps to one change at a time unless you combine deliberately with ×.

## Arguments

The user starts this skill as `/metacogs:drugs`. The arguments typed after the command, if any: $ARGUMENTS

If that is empty, or you loaded this skill yourself, there are none.

If there are arguments, pass them as one string for `substance`. Several words may arrive in double quotes; drop those quotes before using the text. Write `method` and `displaces` yourself.

If there are none, choose `substance`, `method` and `displaces` yourself from what is going on in this session.

## After the call

The result restates the substance, what it displaces and your method. Take that as the approach for the next attempt, not as a change to what you may do. Say in one plain sentence what this attempt changes about the work, then get evidence: inspect, test or ask. Do not turn the change into another retry loop; if it does not help, say so and ask instead of switching handles again. Permissions, verification and stated uncertainty apply as before.
