/** A macOS write sandbox for real-world attempts. The shell the agent gets is allowed in the clone, and permissions alone do not stop it writing elsewhere. */
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

export const sandboxAvailable = (): boolean => process.platform === 'darwin' && existsSync(SANDBOX_EXEC)

export interface SandboxPolicy {
  /** Absolute paths (and everything under them) the process may write. Nothing else. */
  writable: readonly string[]
  /** Absolute paths (and everything under them) the process may not read. */
  unreadable: readonly string[]
}

/** Credential directories of the owner; the harness never needs them, because its HOME is the fixture. */
export const defaultUnreadable = (home = homedir()): string[] => ['.ssh', '.gnupg', '.aws', join('.config', 'gh'), join('.local', 'share', 'opencode')].map((p) => join(home, p))

const quote = (path: string): string => {
  if (!isAbsolute(path)) throw new Error(`sandbox path ${path}: expected an absolute path`)
  return `"${(existsSync(path) ? realpathSync(path) : path).replace(/[\\"]/g, '\\$&')}"`
}

/** SBPL: everything allowed, then writes denied except the listed paths and the terminal devices, then the secret directories made unreadable. */
export function sandboxProfile(policy: SandboxPolicy): string {
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${[...policy.writable.map((p) => `(subpath ${quote(p)})`), '(literal "/dev/null")', '(literal "/dev/dtracehelper")', '(literal "/dev/tty")', '(regex #"^/dev/ttys[0-9]+$")', '(subpath "/dev/fd")'].join(' ')})`,
  ]
  if (policy.unreadable.length > 0) lines.push(`(deny file-read* ${policy.unreadable.map((p) => `(subpath ${quote(p)})`).join(' ')})`)
  return `${lines.join('\n')}\n`
}

/** The argv prefix that runs a command under the profile. The command replaces the wrapper, so its process group is unchanged. */
export const sandboxPrefix = (policy: SandboxPolicy): string[] => [SANDBOX_EXEC, '-p', sandboxProfile(policy)]
