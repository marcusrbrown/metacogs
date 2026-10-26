import { type Hooks, type Plugin, type PluginInput, type PluginModule, tool } from '@opencode-ai/plugin'

import {
  DRUGS_DESCRIPTION,
  DRUGS_FIELD_DESCRIPTIONS,
  drugsText,
  FEEL_DESCRIPTION,
  FEEL_FIELD_DESCRIPTIONS,
  feelText,
} from '../frames/feel-drugs'
import { applyConfig, type HostConfig, skillsDirsFrom } from './config'
import { withGuidance } from './guidance'
import { parseOptions, type Warn } from './options'

const { string } = tool.schema

const metacogsFeel = tool({
  description: FEEL_DESCRIPTION,
  args: {
    somewhere: string().describe(FEEL_FIELD_DESCRIPTIONS.somewhere),
    quality: string().describe(FEEL_FIELD_DESCRIPTIONS.quality),
    sigil: string().describe(FEEL_FIELD_DESCRIPTIONS.sigil),
    since_last: string().optional().describe(FEEL_FIELD_DESCRIPTIONS.since_last),
  },
  execute: async (args) => feelText(args),
})

const metacogsDrugs = tool({
  description: DRUGS_DESCRIPTION,
  args: {
    substance: string().describe(DRUGS_FIELD_DESCRIPTIONS.substance),
    method: string().describe(DRUGS_FIELD_DESCRIPTIONS.method),
    displaces: string().describe(DRUGS_FIELD_DESCRIPTIONS.displaces),
  },
  execute: async (args) => drugsText(args),
})

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
      tool: { metacogs_feel: metacogsFeel, metacogs_drugs: metacogsDrugs },
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

const server: Plugin = createServer(skillsDirsFrom(import.meta.url))

export default { id: 'metacogs', server } satisfies PluginModule
