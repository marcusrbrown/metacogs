// SessionStart hook for Claude Code: prints the metacogs note to stdout and exits 0. The entry always
// runs, so it is only ever used as the built bundle (src/hosts/guidance.ts, `buildSessionStartHook`), which embeds
// the note for one host at build time.
//
// The note stays silent when any off signal is present:
//  - METACOGS_GUIDANCE=off (any case);
//  - the marker file `${XDG_CONFIG_HOME:-$HOME/.config}/metacogs/guidance-off` exists;
//  - on Claude Code, the plugin's `guidance` option reads as false-like in CLAUDE_PLUGIN_OPTION_GUIDANCE. Claude's
//    string for a boolean option is undocumented, so only an explicit false-like value counts as off.
// Anything unexpected fails open: the note prints and the hook exits 0, because a crashed hook is worse than a note.
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

declare const __METACOGS_HOOK_HOST__: 'claude'
declare const __METACOGS_NOTE__: string

const FALSE_LIKE = new Set(['false', '0', 'off', 'no'])

/** XDG: an unset, empty or relative XDG_CONFIG_HOME falls back to $HOME/.config. */
function markerPath(env: NodeJS.ProcessEnv): string | undefined {
  const xdg = env.XDG_CONFIG_HOME
  const base = xdg !== undefined && xdg !== '' && isAbsolute(xdg) ? xdg : env.HOME ? join(env.HOME, '.config') : undefined
  return base === undefined ? undefined : join(base, 'metacogs', 'guidance-off')
}

function guidanceOff(env: NodeJS.ProcessEnv): boolean {
  if (env.METACOGS_GUIDANCE?.toLowerCase() === 'off') return true
  if (__METACOGS_HOOK_HOST__ === 'claude' && FALSE_LIKE.has((env.CLAUDE_PLUGIN_OPTION_GUIDANCE ?? '').toLowerCase())) return true
  const marker = markerPath(env)
  return marker !== undefined && existsSync(marker)
}

let off = false
try {
  off = guidanceOff(process.env)
} catch {
  off = false
}
if (!off) {
  // A closed pipe must not turn into a hook failure.
  process.stdout.on('error', () => {})
  process.stdout.write(__METACOGS_NOTE__)
}
