/**
 * The `feel` and `drugs` tool text the plugin ships (`FEEL_*`, `DRUGS_*`, `feelText`, `drugsText`), adapted from
 * upstream (https://github.com/inanna-malick/metacog, MIT; the notice and pinned commit are in `ATTRIBUTIONS.md`).
 * The verbatim upstream copy is spike-only and lives in `src/spike/feel-drugs/upstream-frames.ts`, so it stays out of
 * the plugin bundle.
 *
 * Adapted: it keeps the field names, types and required/optional split, and upstream's voice and imagery where they
 * are harmless (substances as handles, ×-combining, "baseline", sigils, texture). It drops the lines that claim to
 * change or reach the model's internals, say a previous mode is "unavailable", or discourage checking the result, so
 * the tool text matches `plugin/skills/{feel,drugs}/SKILL.md`.
 *
 * This module has no imports: each host builds its own schema over these strings. The field names, their order and
 * the argument types are shared with the spike's upstream copy.
 */

/** Trims trailing dots and whitespace from the `displaces` field. Shared with the spike's upstream copy. */
export const clean = (s: string) => s.replace(/[.\s]+$/, '')

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

export const FEEL_DESCRIPTION = `Pause on a stuck point you can't yet name, to work out what your next move should change. Use when the same failure persists after materially different attempts, conflicting constraints block a commitment, or your next step would repeat a hypothesis you already exhausted. It is a working metaphor; evidence still decides.`

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

export const DRUGS_DESCRIPTION = `Deliberately replace an exhausted approach with a different one for the next attempt. Use when requested creative or design exploration has stalled on the same few alternatives, or another attempt would repeat the last one. It is a working metaphor; evidence still decides.`

export const DRUGS_FIELD_DESCRIPTIONS = {
  substance: `Name a specific real drug or neurotransmitter, such as caffeine or acetylcholine, as a metaphorical handle — not a person, character, school, or method. In method, state the task-level change and its tradeoff. Use × to combine two.`,
  method: `The task-level change of approach: what you will emphasize, what you will set aside, which assumptions you will stop leaning on. Name its tradeoff — every change of approach costs something.`,
  displaces: `The approach this replaces. Name the previous substance, or "baseline" for your default. Naming it keeps to one change at a time, unless you're deliberately combining with ×.`,
} as const

export function drugsText({ substance, method, displaces }: DrugsArgs): string {
  return `APPROACH DISPLACED: ${clean(displaces)}.

${substance} taken as the handle. ${method}

This is your approach for the next attempt, not a change to what you may do. Say in one plain sentence what it changes about the work, then check it against evidence.`
}

/** The `drugs` return template with the three fields as `<name>` placeholders. */
export const DRUGS_FRAME = drugsText({ substance: '<substance>', method: '<method>', displaces: '<displaces>' })
