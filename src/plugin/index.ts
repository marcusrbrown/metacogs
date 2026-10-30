import { skillsDirsFrom } from './config'
import { createServer } from './v1'

/**
 * The plugin entry: a plain object with no host import, so the built file loads on OpenCode v1 and v2 with neither
 * host package installed. v1 calls `server(input, options)`; v2 calls `setup(ctx)`. Typed against a local structural
 * shape because the published v2 type (`{id, effect}`) does not describe `setup`, and any extra named export on this
 * module would be read by the host as a plugin factory, so the default is the only export.
 */
interface MetacogsPlugin {
  id: string
  server: ReturnType<typeof createServer>
  setup: (ctx: unknown) => Promise<void>
}

/** v2 entry. Registers nothing yet; the adapter lands in a later unit. */
async function setup(ctx: unknown): Promise<void> {
  const host = ctx as { location?: unknown; session?: unknown } | null | undefined
  if (!host?.location || !host?.session) return
}

const plugin: MetacogsPlugin = { id: 'metacogs', server: createServer(skillsDirsFrom(import.meta.url)), setup }

export default plugin
