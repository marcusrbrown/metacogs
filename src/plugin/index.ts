import { skillsDirsFrom } from './config'
import { createServer } from './v1'
import { createSetup } from './v2'

/** Plain object with no host import; the default export is the only export. */
interface MetacogsPlugin {
  id: string
  server: ReturnType<typeof createServer>
  setup: (ctx: unknown) => Promise<void>
}

const skillsDirs = skillsDirsFrom(import.meta.url)

const plugin: MetacogsPlugin = { id: 'metacogs', server: createServer(skillsDirs), setup: createSetup(skillsDirs) }

export default plugin
