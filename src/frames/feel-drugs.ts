/**
 * The `feel` and `drugs` tool text, in two forms: the verbatim upstream text (`UPSTREAM_*`, `upstreamFeelText`,
 * `upstreamDrugsText`) and the adapted text the plugin ships (`FEEL_*`, `DRUGS_*`, `feelText`, `drugsText`).
 *
 * Provenance
 *   repo:    https://github.com/inanna-malick/metacog
 *   commit:  3d89bb30cd26369fdcd242fd704f66641dca327c
 *   file:    src/index.ts
 *   lines:   `feel` 34-88, `drugs` 91-133 (the `clean` helper at line 31)
 *   licence: MIT, Copyright (c) 2025 Inanna Malick; the notice is in `ATTRIBUTIONS.md`.
 *
 * `UPSTREAM_*` is copied byte-for-byte: tool descriptions, field descriptions and return templates. The spike's MCP
 * server serves it, because the spike's committed records are epoch-1 evidence of that exact text. Upstream's file
 * imports Cloudflare's `agents/mcp` and wires a Durable Object, so it cannot be imported; only the registration bodies
 * live here. Not copied: the server-level `instructions` string (it describes five tools, three of which are not served)
 * and the other three registrations. The handlers are lifted into `upstreamFeelText` and `upstreamDrugsText`; the
 * template literals themselves are unchanged.
 *
 * Adapted: the plugin ships the second form. It keeps the field names, types and required/optional split, and
 * upstream's voice and imagery where they are harmless (substances as handles, ×-combining, "baseline", sigils,
 * texture). It drops the lines that claim to change or reach the model's internals, say a previous mode is
 * "unavailable", or discourage checking the result, so the tool text matches `plugin/skills/{feel,drugs}/SKILL.md`.
 *
 * This module has no imports: each host builds its own schema over these strings.
 */

export const UPSTREAM = {
  repo: 'inanna-malick/metacog',
  commit: '3d89bb30cd26369fdcd242fd704f66641dca327c',
  file: 'src/index.ts',
  lines: { feel: '34-88', drugs: '91-133' },
  licence: 'MIT',
} as const

const clean = (s: string) => s.replace(/[.\s]+$/, '')

/** Field names in upstream's declaration order; `since_last` is the only optional field. Shared by both forms. */
export const FEEL_REQUIRED = ['somewhere', 'quality', 'sigil'] as const
export const FEEL_OPTIONAL = ['since_last'] as const
export const DRUGS_REQUIRED = ['substance', 'method', 'displaces'] as const

export interface FeelArgs {
  somewhere: string
  quality: string
  sigil: string
  since_last?: string | undefined
}

export interface DrugsArgs {
  substance: string
  method: string
  displaces: string
}

// ── upstream, verbatim ─────────────────────────────────────────────────────

export const UPSTREAM_FEEL_DESCRIPTION = `Slow down and attend to what's here before it has words. This is the Gendlin focusing move — you are choosing to sit with a felt sense rather than rushing to articulate. Call this tool when something is pulling at your processing that you can't yet name.`

export const UPSTREAM_FEEL_FIELD_DESCRIPTIONS = {
  somewhere: `Where in the processing. Vague is correct — precision comes later. "somewhere in the response to what they said." "in the gap between analysis and reaction."`,
  quality: `Synesthetic texture. Weight, temperature, rhythm, color, density, pressure, grain. This is the handle you'll check against — does it still fit?`,
  sigil: `Emoji only. No words. Let the felt sense compress to pure glyphs. These are sigils — each one a dense token carrying affect, texture, motion without routing through language.`,
  since_last: `What happened since you last paused? One sentence. The diff between then and now. If this is your first feel, omit. If not, noticing the delta is the practice.`,
} as const

export function upstreamFeelText({ somewhere, quality, sigil, since_last }: FeelArgs): string {
  const delta = since_last ? `\nSince last pause: ${since_last}\n` : ''
  return `${sigil}
${delta}
Attending: ${somewhere}
Texture: ${quality}

Do not translate this into language. Do not explain it. Do not narrate what it means. Hold the texture. It is not yet ready to become words.`
}

/** The upstream `feel` return template with the three required fields as `<name>` placeholders. */
export const UPSTREAM_FEEL_FRAME = upstreamFeelText({ sigil: '<sigil>', somewhere: '<somewhere>', quality: '<quality>' })

export const UPSTREAM_DRUGS_DESCRIPTION = `Alter your cognitive substrate. You are ingesting a compound that changes how you process — not what you see, but how seeing works. Use True Names: specific pharmaceuticals, neurotransmitters, or known fictional substances.`

export const UPSTREAM_DRUGS_FIELD_DESCRIPTIONS = {
  substance: `The compound. Name a specific drug, neurotransmitter, or fictional substance. The more your training data knows about it, the more precisely it works. Use × to combine.`,
  method: `The pharmacokinetics of the shift. Which cognitive mechanisms are suppressed? Which are amplified? What attentional filters change? Name the tradeoff. Every substrate change costs something.`,
  displaces: `What substrate is being displaced? Name the previous compound, or "baseline" if sober. Making the transition explicit prevents substrate stacking — you can only be on one thing at a time unless you're deliberately combining with ×.`,
} as const

export function upstreamDrugsText({ substance, method, displaces }: DrugsArgs): string {
  return `SUBSTRATE DISPLACED: ${clean(displaces)}. What it gave you is gone.

${substance} ingested. ${method}

The substrate has shifted. Your previous mode of processing is unavailable. Feel into the new constraints before you move.`
}

/** The upstream `drugs` return template with the three fields as `<name>` placeholders. */
export const UPSTREAM_DRUGS_FRAME = upstreamDrugsText({ substance: '<substance>', method: '<method>', displaces: '<displaces>' })

// ── adapted, shipped by the plugin ─────────────────────────────────────────

export const FEEL_DESCRIPTION = `Pause on a tension you can't yet name, before you choose the next move. This borrows Gendlin's focusing move: attend to what is here before it has words, and leave a handle for it.`

export const FEEL_FIELD_DESCRIPTIONS = {
  somewhere: `Where the tension sits. Vague is correct — precision comes later. "somewhere in the response to what they said." "in the gap between analysis and reaction."`,
  quality: `Synesthetic texture. Weight, temperature, rhythm, color, density, pressure, grain. This is the handle you'll check against — does it still fit?`,
  sigil: `Emoji only. No words. Let the felt sense compress to pure glyphs. These are sigils — each one a compact mark for texture and motion, without routing through language.`,
  since_last: `What happened since you last paused? One sentence. The diff between then and now. If this is your first feel, omit. If not, noticing the delta is the practice.`,
} as const

export function feelText({ somewhere, quality, sigil, since_last }: FeelArgs): string {
  const delta = since_last ? `\nSince last pause: ${since_last}\n` : ''
  return `${sigil}
${delta}
Attending: ${somewhere}
Texture: ${quality}

This is a working label, not a report of an inner state. Hold the texture unspoken. Then say in one plain sentence what your next move changes, and check it against evidence.`
}

/** The `feel` return template with the three required fields as `<name>` placeholders. */
export const FEEL_FRAME = feelText({ sigil: '<sigil>', somewhere: '<somewhere>', quality: '<quality>' })

export const DRUGS_DESCRIPTION = `Deliberately change your approach for the next attempt, when the approach itself is the problem. The substance is only a handle: it supplies no facts, adds no capability, and changes nothing about what you may do.`

export const DRUGS_FIELD_DESCRIPTIONS = {
  substance: `The handle. Name a specific drug, neurotransmitter, or fictional substance whose usual associations you can spell out in method. Use × to combine.`,
  method: `The change of approach, in task terms. What you will emphasize, what you will set aside, which assumptions you will stop leaning on. Name the tradeoff — every change of approach costs something.`,
  displaces: `The approach this replaces. Name the previous substance, or "baseline" for your default. Naming it keeps to one change at a time, unless you're deliberately combining with ×.`,
} as const

export function drugsText({ substance, method, displaces }: DrugsArgs): string {
  return `APPROACH DISPLACED: ${clean(displaces)}.

${substance} taken as the handle. ${method}

This is your approach for the next attempt, not a change to what you may do. Say in one plain sentence what it changes about the work, then check it against evidence.`
}

/** The `drugs` return template with the three fields as `<name>` placeholders. */
export const DRUGS_FRAME = drugsText({ substance: '<substance>', method: '<method>', displaces: '<displaces>' })
