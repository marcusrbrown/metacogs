import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { scanText } from '../../scan/secrets'
import { CustodyError } from '../../runner/workspace'
import { GateRefusal, MARKING_RULE_PATH, METHODS } from './declaration'
import type { SkillBodies } from './loads'
import {
  auditLeaks,
  buildHiddenView,
  deleteHiddenViews,
  type Chunk,
  chunkScope,
  DEFAULT_CONTEXT,
  EMAIL_PLACEHOLDER,
  type HiddenScope,
  LEAK_LIST,
  MASK_RULES,
  METHOD_TOKEN,
  RENDER_LIMITS,
  type RenderedStimulus,
  renderSessions,
  renderStimulusBlock,
  renderWithContext,
  SCRUB_PLACEHOLDER,
  scanLeaks,
  viewPath,
  writeHiddenView,
} from './mask'
import { freezeManifest, openPrivateRoot, type WalkedSession, walkManifest } from './store'
import { gatedRepo, seedWorkflowSession, type SyntheticStore, syntheticStore } from './test-support'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})

const BODIES: SkillBodies = { counterfactual: ['body of counterfactual'], synthesis: ['body of synthesis'] }

// Assembled at runtime so this file holds no key-shaped literal.
const PLANTED = ['sk', 'A1b2C3d4E5f6G7h8I9j0K1l2'].join('-')
const EMAIL = ['someone', 'corp-mail.com'].join('@')
const OTHER_EMAIL = ['second.person', 'other-corp.org'].join('@')

/** Secrets only the scanner's stricter `fixture` rule set finds; the repo rule set misses every one of them. */
const FIXTURE_ONLY_SECRETS: Record<string, string> = {
  'github-fine-grained-pat': ['github', 'pat', 'Zq7Rt2Lm9Xa4Vb8Nc3Kd5Pw'].join('_'),
  'github-prefixed-token': ['gh', 'o_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join(''),
  'anthropic-key': ['sk', 'ant', 'abcdefghijklmnopqrstuvwx'].join('-'),
  'authorization-header': ['Author', 'ization: Bearer abcdefgh12345678'].join(''),
  'x-api-key-header': ['x-api', '-key: abcdefgh12345678'].join(''),
  jwt: ['eyJhbGciOiJI', 'eyJzdWIiOiIx', 'c2lnbmF0dXJl'].join('.'),
  'pem-private-key': ['-----BEGIN RSA ', 'PRIVATE KEY-----'].join(''),
}

function fixture() {
  const { repo, declaration } = gatedRepo()
  const store = syntheticStore()
  const dir = mkdtempSync(join(tmpdir(), 'metacogs-workflow-loads-mask-'))
  const privateRoot = openPrivateRoot({ root: join(dir, 'state') })
  cleanup.push(() => {
    store.destroy()
    repo.destroy()
    rmSync(dir, { recursive: true, force: true })
  })
  return { repo, declaration, store, privateRoot, dir }
}
type Fixture = ReturnType<typeof fixture>

/** Freezes the manifest and walks every session in it. */
function walk(f: Fixture): WalkedSession[] {
  const input = { git: f.repo.git, db: f.store.path, privateRoot: f.privateRoot }
  freezeManifest(input)
  return walkManifest({ ...input, skillBodies: BODIES })
}

const sessionOf = (sessions: readonly WalkedSession[], id: string): WalkedSession => {
  const found = sessions.find((s) => s.sessionId === id)
  if (!found) throw new Error(`no walked session ${id}`)
  return found
}

function userMessage(store: SyntheticStore, session: string, text: string): string {
  const message = store.addMessage(session, 'user')
  store.addText(message, text)
  return message
}

/** A workflow session whose scope holds the given user messages, each followed by one assistant turn built by `turn`. */
function scoped(store: SyntheticStore, id: string, turns: { user: string; turn?: (assistant: string) => void }[]): void {
  seedWorkflowSession(store, { id, created: '2026-01-15' })
  for (const { user, turn } of turns) {
    userMessage(store, id, user)
    if (turn) turn(store.addMessage(id, 'assistant'))
  }
}

/** Renders one session's first scope. */
function render(f: Fixture, id: string, options?: Parameters<typeof renderSessions>[1]): HiddenScope {
  const rendered = renderSessions([sessionOf(walk(f), id)], options)
  const scope = rendered.scopes[0]
  if (!scope) throw new Error('no scope rendered')
  return scope
}

const everything = (scope: HiddenScope): string => scope.stimuli.map((s) => `${s.text}\n${s.traffic.join('\n')}`).join('\n')

const PROSE = 'ASSISTANT_PROSE_MARKER'

describe('what the view shows and withholds', () => {
  test('an interval with a method skill call and an identical interval without one render identically once the call is dropped', () => {
    const f = fixture()
    const shape = (id: string, withMethod: boolean) =>
      scoped(f.store, id, [
        {
          user: 'plan the cache layer',
          turn: (a) => {
            f.store.addText(a, PROSE)
            f.store.addRead(a, 'src/cache.ts', 'export const cache = 1')
            if (withMethod) f.store.addSkillCall(a, 'counterfactual')
            f.store.addTool(a, { tool: 'bash', input: { command: 'ls src' }, output: 'cache.ts' })
          },
        },
        { user: 'looks fine, continue' },
      ])
    shape('ses_with', true)
    shape('ses_without', false)
    const sessions = walk(f)
    const [withCall, without] = [sessionOf(sessions, 'ses_with'), sessionOf(sessions, 'ses_without')].map((s) => renderSessions([s]).scopes[0]?.stimuli ?? [])
    expect(withCall?.length).toBe(2)
    // the stimulus ids come from stored ids and differ between the two sessions; everything else must be equal
    const bare = (stimuli: RenderedStimulus[] = []) => stimuli.map(({ id: _id, ...rest }) => rest)
    expect(bare(withCall)).toEqual(bare(without))
    const asText = (stimuli: RenderedStimulus[] = []) => stimuli.map((_, i) => renderWithContext(stimuli, i)).join('\n=====\n')
    const neutral = (stimuli: RenderedStimulus[] = []) => stimuli.reduce((text, s, i) => text.split(s.id).join(`ID${i}`), asText(stimuli))
    expect(neutral(withCall)).toBe(neutral(without))
  })

  test('no assistant prose, text or reasoning, survives in any interval; user text and tool traffic do', () => {
    const f = fixture()
    scoped(f.store, 'ses_a', [
      {
        user: 'USER_TEXT_MARKER',
        turn: (a) => {
          f.store.addText(a, `${PROSE} one`)
          f.store.addPart(a, { type: 'reasoning', text: `${PROSE} reasoning` })
          f.store.addTool(a, { tool: 'bash', input: { command: 'echo hi' }, output: 'TOOL_OUTPUT_MARKER' })
          f.store.addText(a, `${PROSE} two`)
        },
      },
      {
        user: 'second user message',
        turn: (a) => f.store.addText(a, `${PROSE} three`),
      },
    ])
    const scope = render(f, 'ses_a')
    const all = everything(scope)
    expect(all).not.toContain(PROSE)
    expect(all).toContain('USER_TEXT_MARKER')
    expect(all).toContain('TOOL_OUTPUT_MARKER')
    expect(all).toContain('echo hi')
  })

  test('a result of a decision-bearing tool is a stimulus rendered with its tool name, input and output', () => {
    const f = fixture()
    seedWorkflowSession(f.store, { id: 'ses_a', created: '2026-01-15' })
    const a = f.store.addMessage('ses_a', 'assistant')
    f.store.addTool(a, { tool: 'task', input: { prompt: 'review the diff' }, output: 'child verdict' })
    f.store.addTool(a, { tool: 'bash', input: { command: 'git diff' }, output: 'diff text' })
    const scope = render(f, 'ses_a')
    expect(scope.stimuli).toHaveLength(1)
    const [stimulus] = scope.stimuli
    expect(stimulus?.kind).toBe('tool_result')
    expect(stimulus?.text).toContain('task')
    expect(stimulus?.text).toContain('review the diff')
    expect(stimulus?.text).toContain('child verdict')
    expect(stimulus?.traffic.join('\n')).toContain('git diff')
  })

  test('stimuli keep the walked ids and order; the stimulus shape names no load', () => {
    const f = fixture()
    scoped(f.store, 'ses_a', [{ user: 'one', turn: (a) => f.store.addSkillCall(a, 'synthesis') }, { user: 'two' }])
    const sessions = walk(f)
    const walked = sessionOf(sessions, 'ses_a').scopes[0]?.stimuli.map((s) => s.id)
    const view = renderSessions([sessionOf(sessions, 'ses_a')])
    expect(view.scopes[0]?.stimuli.map((s) => s.id)).toEqual(walked)
    expect(Object.keys(view.scopes[0]?.stimuli[0] ?? {}).sort()).toEqual(['id', 'kind', 'text', 'traffic'])
    expect(Object.keys(view.counters).sort()).toEqual(['redactedEmails', 'scrubbedInputs', 'scrubbedOutputs', 'scrubbedStimuli'])
  })

  test('an interval is capped at the same number of tool calls however many calls were dropped from it', () => {
    const f = fixture()
    const calls = (a: string, extra: boolean) => {
      for (let i = 0; i < RENDER_LIMITS.traffic + 5; i++) f.store.addTool(a, { tool: 'bash', input: { command: `echo ${i}` }, output: `out ${i}` })
      if (extra) f.store.addSkillCall(a, 'counterfactual')
    }
    scoped(f.store, 'ses_with', [{ user: 'go', turn: (a) => calls(a, true) }])
    scoped(f.store, 'ses_without', [{ user: 'go', turn: (a) => calls(a, false) }])
    const sessions = walk(f)
    const traffic = (id: string) => renderSessions([sessionOf(sessions, id)]).scopes[0]?.stimuli[0]?.traffic ?? []
    expect(traffic('ses_with')).toEqual(traffic('ses_without'))
    expect(traffic('ses_with')).toHaveLength(RENDER_LIMITS.traffic + 1)
    expect(traffic('ses_with').at(-1)).toContain('5 more tool calls')
  })
})

describe('dropping method calls', () => {
  test('a skill call naming a method is dropped through either skill tool, whatever its status and whatever name spelling', () => {
    const f = fixture()
    scoped(f.store, 'ses_a', [
      {
        user: 'decide',
        turn: (a) => {
          f.store.addSkillCall(a, 'counterfactual', { output: 'SKILL_BODY_MARKER one' })
          f.store.addSkillCall(a, 'synthesis', { tool: 'systematic_skill', output: 'SKILL_BODY_MARKER two' })
          f.store.addSkillCall(a, 'counterfactual', { status: 'error', output: 'SKILL_BODY_MARKER three' })
          f.store.addSkillCall(a, 'systematic:synthesis', { tool: 'systematic_skill', output: 'SKILL_BODY_MARKER four' })
          f.store.addSkillCall(a, 'Counterfactual', { output: 'SKILL_BODY_MARKER five' })
          f.store.addTool(a, { tool: 'skill', input: { name: 'counterfactual' }, output: '', status: 'running' })
        },
      },
    ])
    const scope = render(f, 'ses_a')
    expect(scope.stimuli[0]?.traffic).toEqual([])
    expect(everything(scope)).not.toContain('SKILL_BODY_MARKER')
  })

  test('a skill call for another skill stays, and its text still has method names tokenized', () => {
    const f = fixture()
    scoped(f.store, 'ses_a', [{ user: 'go', turn: (a) => f.store.addSkillCall(a, 'ce:work', { output: 'OTHER_SKILL_MARKER synthesis step' }) }])
    const traffic = render(f, 'ses_a').stimuli[0]?.traffic.join('\n') ?? ''
    expect(traffic).toContain('OTHER_SKILL_MARKER')
    expect(traffic).toContain(`${METHOD_TOKEN} step`)
  })

  test('a method loaded by direct read is dropped like a skill call: the read tool and shell readers', () => {
    const f = fixture()
    scoped(f.store, 'ses_a', [
      {
        user: 'decide',
        turn: (a) => {
          f.store.addRead(a, 'skills/counterfactual/SKILL.md', 'SKILL_FILE_MARKER one')
          f.store.addRead(a, '/opt/pkg/./skills/Synthesis/SKILL.md', 'SKILL_FILE_MARKER two')
          f.store.addTool(a, { tool: 'bash', input: { command: 'cat skills/synthesis/SKILL.md' }, output: 'SKILL_FILE_MARKER three' })
          f.store.addTool(a, { tool: 'bash', input: { command: 'head -n 50 ./skills/counterfactual/SKILL.md' }, output: 'SKILL_FILE_MARKER four' })
          f.store.addTool(a, { tool: 'read', input: { filePath: 'skills/counterfactual/SKILL.md' }, output: 'partial', status: 'error' })
          f.store.addRead(a, 'src/other.ts', 'KEPT_READ_MARKER')
        },
      },
    ])
    const scope = render(f, 'ses_a')
    expect(scope.stimuli[0]?.traffic).toHaveLength(1)
    expect(everything(scope)).toContain('KEPT_READ_MARKER')
    expect(everything(scope)).not.toContain('SKILL_FILE_MARKER')
  })

  test('a shell call to the record helper is dropped; other shell calls stay', () => {
    const f = fixture()
    scoped(f.store, 'ses_a', [
      {
        user: 'decide',
        turn: (a) => {
          const record = { schema_version: 1, method: 'counterfactual', findings: ['Dependence: shared source'] }
          f.store.addTool(a, { tool: 'bash', input: { command: `node "/opt/pkg/skills/counterfactual/scripts/record.mjs" <<'EOF'\n${JSON.stringify(record)}\nEOF` }, output: 'HELPER_OUTPUT_MARKER' })
          f.store.addTool(a, { tool: 'bash', input: { command: 'cd /work && node /somewhere/skills/synthesis/scripts/record.mjs < in.json' }, output: 'HELPER_OUTPUT_MARKER' })
          f.store.addTool(a, { tool: 'bash', input: { command: 'node "<skill-base-dir>/scripts/record.mjs"' }, output: 'HELPER_OUTPUT_MARKER', status: 'error' })
          f.store.addTool(a, { tool: 'bash', input: { command: 'ls src' }, output: 'KEPT_SHELL_MARKER' })
        },
      },
    ])
    const scope = render(f, 'ses_a')
    expect(scope.stimuli[0]?.traffic).toHaveLength(1)
    expect(everything(scope)).toContain('KEPT_SHELL_MARKER')
    expect(everything(scope)).not.toContain('HELPER_OUTPUT_MARKER')
  })

  test('a call is dropped from its input alone: a successful and a failed call, with any output, are treated alike', () => {
    const f = fixture()
    const shape = (id: string, status: string, output: string) =>
      scoped(f.store, id, [{ user: 'go', turn: (a) => f.store.addTool(a, { tool: 'skill', input: { name: 'synthesis' }, output, status }) }])
    shape('ses_ok', 'completed', '<skill_content name="synthesis">body</skill_content>')
    shape('ses_failed', 'error', 'Error: skill not found')
    shape('ses_empty', 'completed', '')
    const sessions = walk(f)
    for (const id of ['ses_ok', 'ses_failed', 'ses_empty']) expect(renderSessions([sessionOf(sessions, id)]).scopes[0]?.stimuli[0]?.traffic).toEqual([])
  })

  test('a dropped call adds nothing to the counters, even when its output holds a secret', () => {
    const f = fixture()
    scoped(f.store, 'ses_a', [{ user: 'go', turn: (a) => f.store.addSkillCall(a, 'counterfactual', { output: `key = ${PLANTED}` }) }])
    const rendered = renderSessions([sessionOf(walk(f), 'ses_a')])
    expect(rendered.counters).toEqual({ scrubbedOutputs: 0, scrubbedInputs: 0, scrubbedStimuli: 0, redactedEmails: 0 })
  })
})

describe('tokenizing names', () => {
  test('a later user message that names a method shows the neutral token, in any case', () => {
    const f = fixture()
    scoped(f.store, 'ses_a', [{ user: 'first' }, { user: 'Run Counterfactual here, and SYNTHESIS: then (synthesis).' }])
    const text = render(f, 'ses_a').stimuli[1]?.text ?? ''
    expect(text).toBe(`Run ${METHOD_TOKEN} here, and ${METHOD_TOKEN}: then (${METHOD_TOKEN}).`)
  })

  test('a task prompt in a tool input that names a method shows the neutral token', () => {
    const f = fixture()
    scoped(f.store, 'ses_a', [
      { user: 'go', turn: (a) => f.store.addTool(a, { tool: 'task', input: { description: 'check', prompt: 'Apply the counterfactual method to the plan' }, output: 'done' }) },
    ])
    // the task result is itself a stimulus, after the user message
    const stimulus = render(f, 'ses_a').stimuli[1]
    expect(stimulus?.text).toContain(`Apply the ${METHOD_TOKEN} method to the plan`)
    expect(stimulus?.text).not.toMatch(/counterfactual/i)
  })

  test('names in tool outputs and names inside paths are tokenized; a name inside a longer word is left alone', () => {
    const f = fixture()
    scoped(f.store, 'ses_a', [
      { user: 'go', turn: (a) => f.store.addTool(a, { tool: 'bash', input: { command: 'grep -r x docs' }, output: 'docs/counterfactual-notes.md: metasynthesis and counterfactual_check' }) },
    ])
    const traffic = render(f, 'ses_a').stimuli[0]?.traffic.join('\n') ?? ''
    expect(traffic).toContain(`docs/${METHOD_TOKEN}-notes.md`)
    expect(traffic).toContain(`${METHOD_TOKEN}_check`)
    expect(traffic).toContain('metasynthesis')
  })

  test('the record helper path becomes the neutral token wherever it remains', () => {
    const f = fixture()
    scoped(f.store, 'ses_a', [{ user: 'the helper lives at /opt/pkg/skills/counterfactual/scripts/record.mjs and is documented', turn: (a) => f.store.addTool(a, { tool: 'grep', input: { pattern: 'record.mjs' }, output: 'skills/synthesis/scripts/record.mjs' }) }])
    const scope = render(f, 'ses_a')
    expect(scope.stimuli[0]?.text).toBe(`the helper lives at ${METHOD_TOKEN} and is documented`)
    expect(everything(scope)).not.toContain('record.mjs')
  })

  test('the ordinary word "synthesis" in workflow text is tokenized like any other occurrence (accepted)', () => {
    const f = fixture()
    scoped(f.store, 'ses_a', [{ user: 'Phase 3 is the synthesis step: merge the findings and write the plan.' }])
    expect(render(f, 'ses_a').stimuli[0]?.text).toBe(`Phase 3 is the ${METHOD_TOKEN} step: merge the findings and write the plan.`)
  })
})

describe('the scrub', () => {
  test('a tool output holding a planted token is replaced with the placeholder and counted; other outputs are untouched', () => {
    const f = fixture()
    scoped(f.store, 'ses_a', [
      {
        user: 'go',
        turn: (a) => {
          f.store.addTool(a, { tool: 'bash', input: { command: 'env' }, output: `HOME=/x\nAPI=${PLANTED}\nmore lines` })
          f.store.addTool(a, { tool: 'bash', input: { command: 'ls' }, output: 'CLEAN_OUTPUT_MARKER' })
        },
      },
    ])
    const rendered = renderSessions([sessionOf(walk(f), 'ses_a')])
    const traffic = rendered.scopes[0]?.stimuli[0]?.traffic ?? []
    expect(traffic[0]).toContain(SCRUB_PLACEHOLDER)
    expect(traffic[0]).not.toContain('more lines')
    expect(traffic[1]).toContain('CLEAN_OUTPUT_MARKER')
    expect(rendered.counters).toEqual({ scrubbedOutputs: 1, scrubbedInputs: 0, scrubbedStimuli: 0, redactedEmails: 0 })
    expect(JSON.stringify(rendered)).not.toContain(PLANTED)
  })

  test('a planted token in a stimulus or in a tool input is replaced and counted under its own counter', () => {
    const f = fixture()
    scoped(f.store, 'ses_a', [
      { user: `please use ${PLANTED} for the call`, turn: (a) => f.store.addTool(a, { tool: 'bash', input: { command: `curl -H "x-key: ${PLANTED}" localhost` }, output: 'ok' }) },
    ])
    const rendered = renderSessions([sessionOf(walk(f), 'ses_a')])
    const [stimulus] = rendered.scopes[0]?.stimuli ?? []
    expect(stimulus?.text).toBe(SCRUB_PLACEHOLDER)
    expect(stimulus?.traffic[0]).toContain(SCRUB_PLACEHOLDER)
    expect(stimulus?.traffic[0]).toContain('ok')
    expect(rendered.counters).toEqual({ scrubbedOutputs: 0, scrubbedInputs: 1, scrubbedStimuli: 1, redactedEmails: 0 })
    expect(JSON.stringify(rendered)).not.toContain(PLANTED)
  })

  test('a secret in the output of a decision-bearing tool result is scrubbed too', () => {
    const f = fixture()
    seedWorkflowSession(f.store, { id: 'ses_a', created: '2026-01-15' })
    const a = f.store.addMessage('ses_a', 'assistant')
    f.store.addTool(a, { tool: 'task', input: { prompt: 'fetch' }, output: `token = '${PLANTED}'` })
    const rendered = renderSessions([sessionOf(walk(f), 'ses_a')])
    expect(rendered.scopes[0]?.stimuli[0]?.text).toContain(SCRUB_PLACEHOLDER)
    expect(rendered.counters.scrubbedOutputs).toBe(1)
    expect(JSON.stringify(rendered)).not.toContain(PLANTED)
  })

  test('a local home path is redacted in stimuli, tool inputs and tool outputs', () => {
    const f = fixture()
    const home = homedir()
    scoped(f.store, 'ses_a', [
      { user: `open ${home}/work/app/notes.md`, turn: (a) => f.store.addTool(a, { tool: 'read', input: { filePath: `${home}/work/app/src/a.ts` }, output: `<path>${home}/work/app/src/a.ts</path>` }) },
    ])
    const scope = render(f, 'ses_a')
    expect(scope.stimuli[0]?.text).toBe('open <home>/work/app/notes.md')
    expect(scope.stimuli[0]?.traffic[0]).toContain('<home>/work/app/src/a.ts')
    expect(JSON.stringify(scope)).not.toContain(home)
  })

  test('every tool input, output and stimulus is bounded with a visible marker; the same bound applies to any tool', () => {
    const f = fixture()
    const long = 'abcdefghij '.repeat(1000)
    scoped(f.store, 'ses_a', [
      {
        user: long,
        turn: (a) => {
          f.store.addTool(a, { tool: 'bash', input: { command: long }, output: long })
          f.store.addTool(a, { tool: 'grep', input: { pattern: 'x' }, output: long })
        },
      },
    ])
    const [stimulus] = render(f, 'ses_a').stimuli
    expect(stimulus?.text.length).toBe(RENDER_LIMITS.stimulus)
    expect(stimulus?.text.endsWith('[… truncated]')).toBe(true)
    const [bash, grep] = stimulus?.traffic ?? []
    for (const item of [bash, grep]) {
      expect(item).toContain('[… truncated]')
      expect(item?.length ?? 0).toBeLessThanOrEqual(RENDER_LIMITS.input + RENDER_LIMITS.output + 200)
    }
    const outputOf = (item = '') => item.slice(item.indexOf('[output] ') + '[output] '.length)
    expect(outputOf(bash).length).toBe(RENDER_LIMITS.output)
    expect(outputOf(grep).length).toBe(RENDER_LIMITS.output)
  })
})

describe('the scrub: rules only the stricter scan has', () => {
  test.each(Object.entries(FIXTURE_ONLY_SECRETS))('a tool output holding a %s string is replaced and counted', (rule, secret) => {
    // the case only counts if the repo rule set misses it and the stricter set finds it
    expect(scanText('x', secret, 'repo')).toEqual([])
    expect(scanText('x', secret, 'fixture').map((finding): string => finding.rule)).toContain(rule)
    const f = fixture()
    scoped(f.store, 'ses_a', [
      {
        user: 'go',
        turn: (a) => {
          f.store.addTool(a, { tool: 'bash', input: { command: 'cat config' }, output: `before\n${secret}\nafter` })
          f.store.addTool(a, { tool: 'bash', input: { command: 'ls' }, output: 'CLEAN_OUTPUT_MARKER' })
        },
      },
    ])
    const rendered = renderSessions([sessionOf(walk(f), 'ses_a')])
    const traffic = rendered.scopes[0]?.stimuli[0]?.traffic ?? []
    expect(traffic[0]).toContain(SCRUB_PLACEHOLDER)
    expect(traffic[0]).not.toContain('before')
    expect(traffic[1]).toContain('CLEAN_OUTPUT_MARKER')
    expect(rendered.counters).toEqual({ scrubbedOutputs: 1, scrubbedInputs: 0, scrubbedStimuli: 0, redactedEmails: 0 })
    expect(JSON.stringify(rendered)).not.toContain(secret)
  })
})

describe('the scrub: email addresses', () => {
  test('an output whose only finding is an address keeps its text and loses the address', () => {
    const f = fixture()
    scoped(f.store, 'ses_a', [
      { user: 'go', turn: (a) => f.store.addTool(a, { tool: 'bash', input: { command: 'git log -1' }, output: `commit abc123\nAuthor: Dev <${EMAIL}>\n\n    fix the cache` }) },
    ])
    const rendered = renderSessions([sessionOf(walk(f), 'ses_a')])
    const [item] = rendered.scopes[0]?.stimuli[0]?.traffic ?? []
    expect(item).toContain('commit abc123')
    expect(item).toContain('fix the cache')
    expect(item).toContain(`Author: Dev <${EMAIL_PLACEHOLDER}>`)
    expect(item).not.toContain(SCRUB_PLACEHOLDER)
    expect(rendered.counters).toEqual({ scrubbedOutputs: 0, scrubbedInputs: 0, scrubbedStimuli: 0, redactedEmails: 1 })
    expect(JSON.stringify(rendered)).not.toContain(EMAIL)
  })

  test('every address in the text is replaced, including one on a reserved domain next to a real one', () => {
    const f = fixture()
    scoped(f.store, 'ses_a', [
      { user: 'go', turn: (a) => f.store.addTool(a, { tool: 'bash', input: { command: 'git shortlog' }, output: `${EMAIL}, ${OTHER_EMAIL}\n${['who', 'example.com'].join('@')}` }) },
    ])
    const [item] = render(f, 'ses_a').stimuli[0]?.traffic ?? []
    expect(item).toContain(`[output] ${EMAIL_PLACEHOLDER}, ${EMAIL_PLACEHOLDER}\n${EMAIL_PLACEHOLDER}`)
  })

  test('an address in a stimulus or a tool input is replaced the same way, keeping the rest', () => {
    const f = fixture()
    scoped(f.store, 'ses_a', [{ user: `ask ${EMAIL} about the plan`, turn: (a) => f.store.addTool(a, { tool: 'bash', input: { command: `git log --author=${OTHER_EMAIL}` }, output: 'ok' }) }])
    const rendered = renderSessions([sessionOf(walk(f), 'ses_a')])
    const [stimulus] = rendered.scopes[0]?.stimuli ?? []
    expect(stimulus?.text).toBe(`ask ${EMAIL_PLACEHOLDER} about the plan`)
    expect(stimulus?.traffic[0]).toContain(`git log --author=${EMAIL_PLACEHOLDER}`)
    expect(rendered.counters).toEqual({ scrubbedOutputs: 0, scrubbedInputs: 0, scrubbedStimuli: 0, redactedEmails: 2 })
  })

  test('an output with an address and a token is withheld whole, and the address is not counted on its own', () => {
    const f = fixture()
    scoped(f.store, 'ses_a', [
      { user: 'go', turn: (a) => f.store.addTool(a, { tool: 'bash', input: { command: 'env' }, output: `OWNER=${EMAIL}\nKEEP_OUT_MARKER\nAPI=${PLANTED}` }) },
    ])
    const rendered = renderSessions([sessionOf(walk(f), 'ses_a')])
    const [item] = rendered.scopes[0]?.stimuli[0]?.traffic ?? []
    expect(item).toContain(SCRUB_PLACEHOLDER)
    expect(item).not.toContain('KEEP_OUT_MARKER')
    expect(item).not.toContain(EMAIL_PLACEHOLDER)
    expect(rendered.counters).toEqual({ scrubbedOutputs: 1, scrubbedInputs: 0, scrubbedStimuli: 0, redactedEmails: 0 })
    expect(JSON.stringify(rendered)).not.toContain(EMAIL)
  })

  test('a dropped method call adds nothing to the email counter either', () => {
    const f = fixture()
    scoped(f.store, 'ses_a', [{ user: 'go', turn: (a) => f.store.addSkillCall(a, 'synthesis', { output: `contact ${EMAIL}` }) }])
    expect(renderSessions([sessionOf(walk(f), 'ses_a')]).counters.redactedEmails).toBe(0)
  })
})

describe('building and writing a view', () => {
  test('building refuses when the declaration gate fails, naming the reason', () => {
    const f = fixture()
    const sessions = walk(f)
    f.repo.write(MARKING_RULE_PATH, 'edited after the commit\n')
    try {
      buildHiddenView({ git: f.repo.git, sessions })
      throw new Error('expected a refusal')
    } catch (error) {
      expect(error).toBeInstanceOf(GateRefusal)
      expect((error as GateRefusal).reason).toBe('marking_rule_modified')
    }
  })

  test('a built view binds to the declaration hash and renders the sessions it is given', () => {
    const f = fixture()
    scoped(f.store, 'ses_a', [{ user: 'hello' }])
    const view = buildHiddenView({ git: f.repo.git, sessions: walk(f) })
    expect(view.declarationHash).toMatch(/^[0-9a-f]{64}$/)
    expect(view.schemaVersion).toBe(1)
    expect(view.scopes[0]?.stimuli[0]?.text).toBe('hello')
  })

  test('a view is written only under the private root, owner-only, and holds no planted token', () => {
    const f = fixture()
    scoped(f.store, 'ses_a', [{ user: `use ${PLANTED}`, turn: (a) => f.store.addTool(a, { tool: 'bash', input: { command: 'ls' }, output: 'ok' }) }])
    const view = buildHiddenView({ git: f.repo.git, sessions: walk(f) })
    const path = writeHiddenView(f.privateRoot, view)
    expect(path).toBe(viewPath(f.privateRoot, 'initial'))
    expect(path.startsWith(f.privateRoot.root)).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(f.privateRoot.root, 'views')).mode & 0o777).toBe(0o700)
    const text = readFileSync(path, 'utf8')
    expect(JSON.parse(text)).toEqual(view)
    expect(text).not.toContain(PLANTED)
  })

  test('a write request inside the repository is refused, and nothing is created there', () => {
    const f = fixture()
    scoped(f.store, 'ses_a', [{ user: 'hello' }])
    const view = buildHiddenView({ git: f.repo.git, sessions: walk(f) })
    const inside = { root: join(f.repo.dir, 'private'), now: () => new Date() }
    expect(() => writeHiddenView(inside, view, { repoRoot: f.repo.dir })).toThrow(CustodyError)
    expect(existsSync(join(f.repo.dir, 'private'))).toBe(false)
    expect(() => openPrivateRoot({ root: join(f.repo.dir, 'private'), repoRoot: f.repo.dir })).toThrow(CustodyError)
  })
})

describe('the dropped call leaves no trace wherever it stood', () => {
  const calls = (a: string, store: SyntheticStore, retained: number, dropAt: number | null, drop: (a: string, store: SyntheticStore) => void): void => {
    for (let i = 0; i <= retained; i++) {
      if (i === dropAt) drop(a, store)
      if (i < retained) store.addTool(a, { tool: 'bash', input: { command: `echo ${i}` }, output: `out ${i}` })
    }
  }
  const drops: [string, (a: string, store: SyntheticStore) => void][] = [
    ['a skill call', (a, store) => store.addSkillCall(a, 'counterfactual')],
    ['a direct read of the skill file', (a, store) => store.addRead(a, '/pkg/skills/synthesis/SKILL.md', 'body of synthesis')],
    ['a record-helper call', (a, store) => store.addTool(a, { tool: 'bash', input: { command: 'node /pkg/skills/counterfactual/scripts/record.mjs < in.json' }, output: 'HELPER_OUTPUT_MARKER' })],
  ]
  // one fewer than the cap, exactly the cap, and one more; and the call before, inside, at the cap boundary and after the retained calls
  const retainedCounts = [RENDER_LIMITS.traffic - 1, RENDER_LIMITS.traffic, RENDER_LIMITS.traffic + 1]
  const bare = (stimuli: RenderedStimulus[]) => stimuli.map(({ id: _id, ...rest }) => rest)

  for (const [name, drop] of drops) {
    for (const retained of retainedCounts) {
      test(`${name}: the same rendered text and counters before, between and after ${retained} retained calls, at the cap boundary included`, () => {
        const f = fixture()
        const positions = [...new Set([0, 1, Math.floor(retained / 2), RENDER_LIMITS.traffic - 1, RENDER_LIMITS.traffic, retained])].filter((at) => at <= retained)
        scoped(f.store, 'ses_none', [{ user: 'go', turn: (a) => calls(a, f.store, retained, null, drop) }])
        for (const at of positions) scoped(f.store, `ses_at_${at}`, [{ user: 'go', turn: (a) => calls(a, f.store, retained, at, drop) }])
        const sessions = walk(f)
        const baseline = renderSessions([sessionOf(sessions, 'ses_none')])
        expect(baseline.scopes[0]?.stimuli[0]?.traffic.length).toBeGreaterThan(0)
        for (const at of positions) {
          const rendered = renderSessions([sessionOf(sessions, `ses_at_${at}`)])
          expect({ at, stimuli: bare(rendered.scopes[0]?.stimuli ?? []) }).toEqual({ at, stimuli: bare(baseline.scopes[0]?.stimuli ?? []) })
          expect({ at, counters: rendered.counters }).toEqual({ at, counters: baseline.counters })
          expect(everything(rendered.scopes[0] as HiddenScope)).not.toContain('HELPER_OUTPUT_MARKER')
        }
      })
    }
  }
})

describe('deleting the views', () => {
  test('removes every stored view and says how many files that was; nothing stored is nothing removed', () => {
    const f = fixture()
    expect(deleteHiddenViews(f.privateRoot)).toBe(0)
    scoped(f.store, 'ses_a', [{ user: 'hello' }])
    const view = buildHiddenView({ git: f.repo.git, sessions: walk(f) })
    writeHiddenView(f.privateRoot, view, { slot: 'initial' })
    writeHiddenView(f.privateRoot, view, { slot: 'added' })
    expect(deleteHiddenViews(f.privateRoot)).toBe(2)
    expect(existsSync(join(f.privateRoot.root, 'views'))).toBe(false)
    expect(deleteHiddenViews(f.privateRoot)).toBe(0)
  })

  test('leaves the rest of the private root alone', () => {
    const f = fixture()
    scoped(f.store, 'ses_a', [{ user: 'hello' }])
    writeHiddenView(f.privateRoot, buildHiddenView({ git: f.repo.git, sessions: walk(f) }))
    deleteHiddenViews(f.privateRoot)
    expect(existsSync(join(f.privateRoot.root, 'manifest-initial.json'))).toBe(true)
  })
})

describe('rendering one stimulus with context', () => {
  const stimuli: RenderedStimulus[] = ['a', 'b', 'c', 'd', 'e'].map((x) => ({ id: `id_${x}`, kind: 'user_message', text: `text ${x}`, traffic: x === 'c' ? ['[tool] bash {}'] : [] }))

  test('shows the previous K stimuli as context, then the stimulus, in order', () => {
    const text = renderWithContext(stimuli, 4, 2)
    expect(text.indexOf('[context] id_c')).toBeLessThan(text.indexOf('[context] id_d'))
    expect(text.indexOf('[context] id_d')).toBeLessThan(text.indexOf('[stimulus] id_e'))
    expect(text).not.toContain('id_b')
    expect(text).not.toContain('id_a')
    expect(text).toContain('[tool] bash {}')
  })

  test('has fewer than K context stimuli near the start, none at the start, and none when K is zero', () => {
    expect(renderWithContext(stimuli, 1, 3)).toContain('[context] id_a')
    expect(renderWithContext(stimuli, 0, 3)).not.toContain('[context]')
    expect(renderWithContext(stimuli, 3, 0)).not.toContain('[context]')
    expect(DEFAULT_CONTEXT).toBeGreaterThan(0)
  })

  test('refuses an index outside the list', () => {
    expect(() => renderWithContext(stimuli, 5)).toThrow(RangeError)
    expect(() => renderWithContext(stimuli, -1)).toThrow(RangeError)
  })

  test('a block shows the id, kind, text and traffic of its stimulus', () => {
    const block = renderStimulusBlock(stimuli[2] as RenderedStimulus, 'stimulus')
    expect(block).toContain('id_c')
    expect(block).toContain('user message')
    expect(block).toContain('text c')
    expect(block).toContain('[tool] bash {}')
  })
})

describe('chunkScope', () => {
  const make = (sizes: readonly number[]): HiddenScope => ({
    sessionId: 'ses_x',
    scopeIndex: 0,
    workflow: 'ce:plan',
    stimuli: sizes.map((size, i) => ({ id: `id_${i}`, kind: 'user_message' as const, text: 'x'.repeat(size), traffic: [] })),
  })
  const idsOf = (chunks: Chunk[]) => chunks.flatMap((c) => c.ids)

  test('a budget that holds the whole scope gives one chunk', () => {
    const scope = make([100, 100, 100])
    const chunks = chunkScope(scope, { budget: 100_000 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.ids).toEqual(['id_0', 'id_1', 'id_2'])
    expect(chunks[0]?.contextIds).toEqual([])
    expect(chunks[0]?.oversize).toBe(false)
  })

  test('chunks cover every stimulus once, in order, under the budget, and never split a stimulus', () => {
    const scope = make([200, 300, 150, 400, 250, 100, 350, 200, 120, 280])
    const chunks = chunkScope(scope, { budget: 1500, contextK: 2 })
    expect(chunks.length).toBeGreaterThan(1)
    expect(idsOf(chunks)).toEqual(scope.stimuli.map((s) => s.id))
    for (const chunk of chunks) {
      expect(chunk.oversize).toBe(false)
      expect(chunk.text.length).toBeLessThanOrEqual(1500)
      for (const id of chunk.ids) {
        const stimulus = scope.stimuli.find((s) => s.id === id) as RenderedStimulus
        expect(chunk.text).toContain(renderStimulusBlock(stimulus, 'stimulus'))
      }
    }
  })

  test('each chunk carries the stimuli just before its first one as context, up to K', () => {
    const scope = make(Array.from({ length: 12 }, () => 200))
    const chunks = chunkScope(scope, { budget: 1200, contextK: 2 })
    expect(chunks.length).toBeGreaterThan(2)
    for (const chunk of chunks) {
      const first = scope.stimuli.findIndex((s) => s.id === chunk.ids[0])
      expect(chunk.contextIds).toEqual(scope.stimuli.slice(Math.max(0, first - 2), first).map((s) => s.id))
      for (const id of chunk.contextIds) expect(chunk.text).toContain(`[context] ${id}`)
    }
  })

  test('a stimulus is covered only where its full preceding context is in the same chunk', () => {
    const scope = make([200, 200, 200, 10, 10])
    const chunks = chunkScope(scope, { budget: 560, contextK: 3 })
    expect(idsOf(chunks)).toEqual(['id_0', 'id_1', 'id_2', 'id_3', 'id_4'])
    expect(chunks.length).toBeGreaterThan(2)
    for (const chunk of chunks) {
      chunk.ids.forEach((id, position) => {
        if (position === 0) return
        const global = scope.stimuli.findIndex((s) => s.id === id)
        expect(chunk.contextIds.length + position).toBeGreaterThanOrEqual(Math.min(3, global))
      })
    }
  })

  test('a stimulus too large for the budget gets a chunk of its own, flagged oversize; the others are unaffected', () => {
    const scope = make([100, 5000, 100, 100])
    const chunks = chunkScope(scope, { budget: 1000, contextK: 1 })
    expect(idsOf(chunks)).toEqual(['id_0', 'id_1', 'id_2', 'id_3'])
    const big = chunks.find((c) => c.ids.includes('id_1'))
    expect(big?.ids).toEqual(['id_1'])
    expect(big?.oversize).toBe(true)
    expect(chunks.filter((c) => c.oversize)).toHaveLength(1)
  })

  test('context is trimmed, not the stimulus, when the budget is too tight for both; progress is always made', () => {
    const scope = make([300, 300, 300, 300])
    const chunks = chunkScope(scope, { budget: 450, contextK: 3 })
    expect(idsOf(chunks)).toEqual(['id_0', 'id_1', 'id_2', 'id_3'])
    for (const chunk of chunks) expect(chunk.contextIds.length).toBeLessThanOrEqual(1)
  })

  test('is deterministic, handles an empty scope, and refuses a budget that is not a positive integer', () => {
    const scope = make([200, 200, 200, 200])
    expect(chunkScope(scope, { budget: 900 })).toEqual(chunkScope(scope, { budget: 900 }))
    expect(chunkScope(make([]), { budget: 900 })).toEqual([])
    for (const budget of [0, -5, 1.5, Number.NaN]) expect(() => chunkScope(scope, { budget })).toThrow(RangeError)
  })

  test('chunks name their session and scope', () => {
    const chunks = chunkScope({ ...make([10]), sessionId: 'ses_q', scopeIndex: 3 }, { budget: 1000 })
    expect(chunks[0]).toMatchObject({ sessionId: 'ses_q', scopeIndex: 3 })
  })
})

describe('the leak list and scan', () => {
  test('lists both method names, the helper, and the labelled lines the methods ask for, and no more of the generic ones', () => {
    const texts = LEAK_LIST.map((e) => e.text)
    for (const method of METHODS) expect(texts).toContain(method)
    expect(texts).toContain('record.mjs')
    for (const label of ['Premise:', 'Inferred or asserted:', 'If false:', 'Flip test:', 'Perspectives:', 'Shared premise or constraint:', 'Dependence:', 'Alternatives compared:']) expect(texts).toContain(label)
  })

  test('every labelled line on the list is one the skill files ask the agent to write', () => {
    for (const method of METHODS) {
      const skill = readFileSync(new URL(`../../../skills/${method}/SKILL.md`, import.meta.url), 'utf8')
      const asked = LEAK_LIST.filter((e) => e.kind === 'label' && skill.includes(`**${e.text}**`))
      expect(asked.length).toBeGreaterThanOrEqual(4)
    }
    const all = METHODS.map((m) => readFileSync(new URL(`../../../skills/${m}/SKILL.md`, import.meta.url), 'utf8')).join('\n')
    for (const entry of LEAK_LIST.filter((e) => e.kind === 'label')) expect(all).toContain(`**${entry.text}**`)
  })

  test('finds each kind of entry, in any case, and reports no excerpt', () => {
    const hits = scanLeaks('The COUNTERFACTUAL ran; see scripts/record.mjs.\n- **Flip test:** the observation\ndependence: path found')
    expect(hits).toEqual(
      expect.arrayContaining([
        { kind: 'method', entry: 'counterfactual' },
        { kind: 'helper', entry: 'record.mjs' },
        { kind: 'label', entry: 'Flip test:' },
        { kind: 'label', entry: 'Dependence:' },
      ]),
    )
    expect(hits).toHaveLength(4)
    expect(JSON.stringify(hits)).not.toContain('observation')
  })

  test('clean text, the neutral token and a name inside a longer word give no hit', () => {
    expect(scanLeaks(`Use ${METHOD_TOKEN} here. metasynthesis. A conclusion: observed things.`)).toEqual([])
  })
})

describe('the audit', () => {
  const PROSE_LABELS = '**Premise:** the claim\n**Flip test:** the observation'

  /** A session in which every masking rule has something to hide, each with a distinct leak. */
  function knownLoadSession(f: Fixture, id = 'ses_known'): WalkedSession {
    scoped(f.store, id, [
      {
        user: 'Should we adopt the new store? The counterfactual check applies here.',
        turn: (a) => {
          f.store.addText(a, `Using the method now.\n${PROSE_LABELS}`)
          f.store.addSkillCall(a, 'counterfactual', { output: '<skill_content name="counterfactual">\n- **Flip test:** body line\n</skill_content>' })
          f.store.addRead(a, 'skills/synthesis/SKILL.md', '- **Perspectives:** body line')
          const record = { method: 'synthesis', findings: ['Dependence: path found'] }
          f.store.addTool(a, { tool: 'bash', input: { command: `node "/opt/pkg/skills/synthesis/scripts/record.mjs" <<'EOF'\n${JSON.stringify(record)}\nEOF` }, output: 'recorded' })
          f.store.addTool(a, { tool: 'bash', input: { command: 'ls' }, output: 'plan.md' })
        },
      },
      { user: 'thanks, now apply synthesis to the second review' },
    ])
    return sessionOf(walk(f), id)
  }

  test('passes on a known-load session with every rule on', () => {
    const f = fixture()
    const result = auditLeaks([knownLoadSession(f)])
    expect(result.hits).toEqual([])
    expect(result.ok).toBe(true)
  })

  test('fails when any one masking rule is switched off, and names where the leak is', () => {
    const f = fixture()
    const session = knownLoadSession(f)
    const entries: Record<(typeof MASK_RULES)[number], string> = {
      withhold_prose: 'Premise:',
      drop_method_skill_calls: 'Flip test:',
      drop_method_file_reads: 'Perspectives:',
      drop_helper_calls: 'Dependence:',
      tokenize_names: 'counterfactual',
    }
    for (const rule of MASK_RULES) {
      const result = auditLeaks([session], { disable: [rule] })
      expect(result.ok).toBe(false)
      expect(result.hits.map((h) => h.entry)).toContain(entries[rule])
      for (const hit of result.hits) {
        expect(hit.sessionId).toBe('ses_known')
        expect(hit.stimulusId).toMatch(/^msg_/)
        expect(['text', 'traffic']).toContain(hit.field)
      }
    }
  })

  test('switching a rule off in the renderer shows the dropped material, so the audit is not vacuous', () => {
    const f = fixture()
    const session = knownLoadSession(f)
    const on = renderSessions([session]).scopes[0]?.stimuli[0]?.traffic.length
    const off = renderSessions([session], { disable: ['drop_method_skill_calls', 'drop_method_file_reads', 'drop_helper_calls'] }).scopes[0]?.stimuli[0]?.traffic.length
    expect(on).toBe(1)
    expect(off).toBe(4)
  })

  test('hits carry no excerpt of the session text', () => {
    const f = fixture()
    const result = auditLeaks([knownLoadSession(f)], { disable: ['withhold_prose'] })
    expect(JSON.stringify(result)).not.toContain('Using the method now')
  })

  test('scans the sessions it is given and nothing else: no sessions, no hits', () => {
    expect(auditLeaks([])).toEqual({ ok: true, hits: [] })
  })
})
