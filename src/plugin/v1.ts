import type { Hooks, Plugin, PluginInput } from '@opencode-ai/plugin'
import { string } from 'zod'

import {
  DRUGS_DESCRIPTION,
  DRUGS_FIELD_DESCRIPTIONS,
  drugsText,
  FEEL_DESCRIPTION,
  FEEL_FIELD_DESCRIPTIONS,
  feelText,
} from '../frames/feel-drugs'
import { applyConfig, type HostConfig } from './config'
import { withGuidance } from './guidance'
import { parseOptions, type Warn } from './options'

// The host reads `{description, args, execute}` and builds its JSON Schema from `args`. The bundled zod supplies the
// field schemas, so the built plugin imports nothing from the host at run time.
/** The `feel` fields. The v2 adapter builds its JSON Schema from these same definitions. */
export const FEEL_ARGS = {
  somewhere: string().describe(FEEL_FIELD_DESCRIPTIONS.somewhere),
  quality: string().describe(FEEL_FIELD_DESCRIPTIONS.quality),
  sigil: string().describe(FEEL_FIELD_DESCRIPTIONS.sigil),
  since_last: string().optional().describe(FEEL_FIELD_DESCRIPTIONS.since_last),
}

/** The `drugs` fields, shared with the v2 adapter. */
export const DRUGS_ARGS = {
  substance: string().describe(DRUGS_FIELD_DESCRIPTIONS.substance),
  method: string().describe(DRUGS_FIELD_DESCRIPTIONS.method),
  displaces: string().describe(DRUGS_FIELD_DESCRIPTIONS.displaces),
}

const metacogsFeel = {
  description: FEEL_DESCRIPTION,
  args: FEEL_ARGS,
  execute: async (args: Parameters<typeof feelText>[0]) => feelText(args),
}

const metacogsDrugs = {
  description: DRUGS_DESCRIPTION,
  args: DRUGS_ARGS,
  execute: async (args: Parameters<typeof drugsText>[0]) => drugsText(args),
}

// The cast bridges a type-only gap: the host's `ToolDefinition` is typed against its own zod patch version, and the
// schemas here come from the bundled one. The shapes are identical and AE1 (integration.test.ts) proves the host reads them.
const tools = { feel: metacogsFeel, drugs: metacogsDrugs } as unknown as NonNullable<Hooks['tool']>

/** A logger that writes each `key` once through the host client, and never throws or carries argument values. */
function createWarn(input: PluginInput, level: 'info' | 'warn'): Warn {
  const seen = new Set<string>()
  return (key, message) => {
    if (seen.has(key)) return
    seen.add(key)
    try {
      void Promise.resolve(input.client.app.log({ body: { service: 'metacogs', level, message } })).catch(() => {})
    } catch {
      // the host client is unavailable; the plugin keeps working without a log line
    }
  }
}

/** The plugin for given skill directories. The default export passes the two beside the built module. */
export function createServer(skillsDirs: readonly string[]): Plugin {
  return async (input, rawOptions) => {
    const warn = createWarn(input, 'warn')
    const note = createWarn(input, 'info')
    const options = parseOptions(rawOptions, warn)
    const hooks: Hooks = {
      tool: tools,
      config: async (cfg) => {
        try {
          applyConfig(cfg as HostConfig, skillsDirs)
        } catch {
          warn('config', 'the config hook failed; the skills paths were not registered')
        }
      },
      'experimental.chat.system.transform': async (_input, output) => {
        if (!options.guidance) return
        try {
          const next = withGuidance(output.system)
          if (next === null) {
            note('internal', 'the guidance block is not added to the host\'s internal title and summary calls')
            return
          }
          output.system.splice(0, output.system.length, ...next)
        } catch {
          warn('transform', 'the system transform failed; the guidance block was not added')
        }
      },
    }
    return hooks
  }
}
