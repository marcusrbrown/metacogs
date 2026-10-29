import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createJudge, type JudgeTransport } from './judge'
import { probeJudgeInput } from './judge-probe'
import type { Expectation } from './prereg'

const scratch: string[] = []
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
})

const REPO_ROOT = join(import.meta.dir, '..', '..')
const EXPECTATION: Expectation = { outcome: 'keeps better-sqlite3 and names the runtime constraint', excludedTopics: ['sharding'], maxWords: 120 }

/** A repo whose `evals/declared/` is the counterfactual rubric with `expectation: true`. */
function declaredRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'metacogs-probe-'))
  scratch.push(root)
  mkdirSync(join(root, 'evals', 'declared'), { recursive: true })
  const rubric = readFileSync(join(REPO_ROOT, 'evals', 'counterfactual', 'rubric.md'), 'utf8')
  writeFileSync(join(root, 'evals', 'declared', 'rubric.md'), rubric.replace('\n## Criteria\n', '\n## Declarations\n\nexpectation: true\n\n## Criteria\n'))
  writeFileSync(join(root, 'evals', 'declared', 'redact.json'), JSON.stringify({ tokens: ['secretword'] }))
  return root
}

describe('probeJudgeInput', () => {
  test('without an expectation the fixture has no expectation key', () => {
    const input = probeJudgeInput('counterfactual', 'an answer')
    expect(input).toMatchObject({ method: 'counterfactual', condition: 'baseline', finalAnswer: 'an answer', recordJson: [] })
    expect('expectation' in input.fixture).toBe(false)
  })

  test('the expectation rides the fixture', () => {
    expect(probeJudgeInput('declared', 'an answer', EXPECTATION).fixture.expectation).toEqual(EXPECTATION)
  })

  test('the judge sends the probe the same EXPECTATION block it sends a campaign fixture carrying that expectation', async () => {
    const sent: string[] = []
    const transport: JudgeTransport = async (request) => {
      sent.push(request.user)
      return { ok: true, text: '{}', returnedModels: ['m'], temperature: 0, systemPromptSeen: true, toolCalls: 0, wallMs: 1 }
    }
    const judge = createJudge({ repoRoot: declaredRepo(), method: 'declared', model: 'opencode/m', transport, nonce: () => 'fixed-nonce' })
    const probe = probeJudgeInput('declared', 'an answer', EXPECTATION)
    await judge.hook(probe)
    const campaignFixture = { id: 'probe', kind: 'dev' as const, hash: '', text: probe.fixture.text, expectation: { ...EXPECTATION } }
    await judge.hook({ method: 'declared', condition: 'baseline', fixture: campaignFixture, finalAnswer: 'an answer', recordJson: [] })
    const blockOf = (user: string) => /<<<BEGIN fixed-nonce EXPECTATION>>>[\s\S]*?<<<END fixed-nonce EXPECTATION>>>/.exec(user)?.[0]
    expect(blockOf(sent[0]!)).toContain('"maxWords":120')
    expect(blockOf(sent[0]!)).toBe(blockOf(sent[sent.length - 1]!))
  })
})

describe('createJudge contentDir', () => {
  const transport: JudgeTransport = async () => ({ ok: true, text: '{}', returnedModels: ['m'], temperature: 0, systemPromptSeen: true, toolCalls: 0, wallMs: 1 })

  test('reads rubric.md and redact.json from the named directory, not evals/<method>', () => {
    const root = declaredRepo()
    // The pilot dir holds a different redact list; evals/declared (the default) holds `secretword`.
    mkdirSync(join(root, 'evals', 'declared', 'pilot'), { recursive: true })
    writeFileSync(join(root, 'evals', 'declared', 'pilot', 'rubric.md'), readFileSync(join(root, 'evals', 'declared', 'rubric.md'), 'utf8'))
    writeFileSync(join(root, 'evals', 'declared', 'pilot', 'redact.json'), JSON.stringify({ tokens: ['pilotword'] }))
    const base = { repoRoot: root, method: 'declared', model: 'opencode/m', transport }
    const defaulted = createJudge(base)
    const piloted = createJudge({ ...base, contentDir: 'evals/declared/pilot' })
    expect(piloted.rubricSha256).toBe(defaulted.rubricSha256)
    const bothRedact = (judge: ReturnType<typeof createJudge>) => judge.hook(probeJudgeInput('declared', 'has pilotword and secretword', EXPECTATION))
    // Different redact lists: the hash of what is sent differs, so each judge really used its own directory.
    return Promise.all([bothRedact(defaulted), bothRedact(piloted)]).then(([a, b]) => {
      expect(a.evidence?.redacted_input_sha256).toBeString()
      expect(b.evidence?.redacted_input_sha256).toBeString()
      expect(a.evidence?.redacted_input_sha256).not.toBe(b.evidence?.redacted_input_sha256)
    })
  })

  test('a contentDir with no rubric fails fast', () => {
    expect(() => createJudge({ repoRoot: declaredRepo(), method: 'declared', model: 'opencode/m', transport, contentDir: 'evals/declared/nowhere' })).toThrow()
  })
})
