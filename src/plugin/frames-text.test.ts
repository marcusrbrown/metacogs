import { describe, expect, test } from 'bun:test'

import plugin, { createServer } from './index'

// Literal pins for the `feel` and `drugs` text the plugin offers. They are written out here, not imported, so a change
// to src/frames/feel-drugs.ts cannot move them silently. The text is adapted from upstream (see ATTRIBUTIONS.md); the
// verbatim upstream copy is pinned in src/frames/feel-drugs.test.ts.

const FEEL_DESCRIPTION = "Pause on a tension you can't yet name, before you choose the next move. This borrows Gendlin's focusing move: attend to what is here before it has words, and leave a handle for it."
const FEEL_FIELDS = {
  somewhere: 'Where the tension sits. Vague is correct — precision comes later. "somewhere in the response to what they said." "in the gap between analysis and reaction."',
  quality: "Synesthetic texture. Weight, temperature, rhythm, color, density, pressure, grain. This is the handle you'll check against — does it still fit?",
  sigil: 'Emoji only. No words. Let the felt sense compress to pure glyphs. These are sigils — each one a compact mark for texture and motion, without routing through language.',
  since_last: 'What happened since you last paused? One sentence. The diff between then and now. If this is your first feel, omit. If not, noticing the delta is the practice.',
}
const FEEL_RETURN =
  '🪨\n\nSince last pause: the pressure eased\n\nAttending: chest\nTexture: tight\n\nThis is a working label, not a report of an inner state. Hold the texture unspoken. Then say in one plain sentence what your next move changes, and check it against evidence.'

const DRUGS_DESCRIPTION =
  'Deliberately change your approach for the next attempt, when the approach itself is the problem. The substance is only a handle: it supplies no facts, adds no capability, and changes nothing about what you may do.'
const DRUGS_FIELDS = {
  substance: 'The handle. Name a specific drug, neurotransmitter, or fictional substance whose usual associations you can spell out in method. Use × to combine.',
  method: 'The change of approach, in task terms. What you will emphasize, what you will set aside, which assumptions you will stop leaning on. Name the tradeoff — every change of approach costs something.',
  displaces: 'The approach this replaces. Name the previous substance, or "baseline" for your default. Naming it keeps to one change at a time, unless you\'re deliberately combining with ×.',
}
const DRUGS_RETURN =
  'APPROACH DISPLACED: baseline.\n\ncaffeine taken as the handle. Emphasize speed of checks; set aside long deliberation.\n\nThis is your approach for the next attempt, not a change to what you may do. Say in one plain sentence what it changes about the work, then check it against evidence.'

const BANNED = ['substrate', 'ingesting', 'unavailable', 'is gone', 'training data knows', 'pharmacokinetics']

type Hooks = Awaited<ReturnType<typeof plugin.server>>
type Context = Parameters<NonNullable<Hooks['tool']>[string]['execute']>[1]

const offered = async () => {
  const input = { client: { app: { log: async () => undefined } } } as unknown as Parameters<typeof plugin.server>[0]
  const hooks = await createServer(['/pkg/skills', '/pkg/plugin/skills'])(input, undefined)
  const feel = hooks.tool?.feel
  const drugs = hooks.tool?.drugs
  if (!feel || !drugs) throw new Error('plugin did not offer feel and drugs')
  const fieldDescriptions = (args: Record<string, unknown>) => Object.fromEntries(Object.entries(args).map(([key, schema]) => [key, (schema as { description?: string }).description]))
  const context = {} as Context
  return {
    feel: { description: feel.description, fields: fieldDescriptions(feel.args), run: await feel.execute({ somewhere: 'chest', quality: 'tight', sigil: '🪨', since_last: 'the pressure eased' }, context) },
    drugs: {
      description: drugs.description,
      fields: fieldDescriptions(drugs.args),
      run: await drugs.execute({ substance: 'caffeine', method: 'Emphasize speed of checks; set aside long deliberation.', displaces: 'baseline.' }, context),
    },
  }
}

describe('shipped feel and drugs text (adapted from upstream)', () => {
  test('feel: description, field descriptions and returned text equal the adapted strings', async () => {
    const { feel } = await offered()
    expect(feel.description).toBe(FEEL_DESCRIPTION)
    expect(feel.fields).toEqual(FEEL_FIELDS)
    expect(Object.keys(feel.fields)).toEqual(['somewhere', 'quality', 'sigil', 'since_last'])
    expect(feel.run).toBe(FEEL_RETURN)
  })

  test('drugs: description, field descriptions and returned text equal the adapted strings', async () => {
    const { drugs } = await offered()
    expect(drugs.description).toBe(DRUGS_DESCRIPTION)
    expect(drugs.fields).toEqual(DRUGS_FIELDS)
    expect(Object.keys(drugs.fields)).toEqual(['substance', 'method', 'displaces'])
    expect(drugs.run).toBe(DRUGS_RETURN)
  })

  test('none of the shipped text carries the retired efficacy or changed-internals phrases', async () => {
    const { feel, drugs } = await offered()
    for (const tool of [feel, drugs]) {
      const shipped = [tool.description, ...Object.values(tool.fields), tool.run].join('\n').toLowerCase()
      for (const phrase of BANNED) expect(shipped).not.toContain(phrase)
    }
  })
})
