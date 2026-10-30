import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  type Cell,
  checkMatrix,
  loadMatrix,
  type Matrix,
  parseMatrix,
  type PluginEntry,
  README_END,
  README_START,
  renderMatrix,
  renderReadme,
  renderTable,
  REPO_ROOT,
  sectionByAnchor,
  slug,
} from './check'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true })
})

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

const INSTALL_DOC = [
  '# Install',
  '',
  '## OpenCode',
  'Docs: https://opencode.ai/docs/skills/',
  '',
  '## Pi',
  'Docs: https://pi.dev/docs/latest/skills',
  '',
  '## Codex',
  'Docs: https://developers.openai.com/codex/skills',
  '',
  '## Claude Code',
  'Docs: https://code.claude.com/docs/en/skills',
  '',
].join('\n')

function greenReport(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'green',
    method: 'synthesis',
    verdict: 'green',
    opencode: { package: 'opencode-ai', version: '1.19.4' },
    models: { agent_pinned: 'agent/model-a', judge_pinned: 'judge/model-b' },
    human_review: { status: 'pending', judged_runs: 39, reviewed: 0 },
    ...over,
  }
}

const baseMatrix = (): Matrix => ({
  schema_version: 2,
  hosts: {
    opencode: { name: 'OpenCode', project_path: '.agents/skills/' },
    'opencode-v2': { name: 'OpenCode (v2)', project_path: '.agents/skills/' },
    pi: { name: 'Pi', project_path: '.agents/skills/' },
    codex: { name: 'Codex', project_path: '.agents/skills/' },
    'claude-code': { name: 'Claude Code', project_path: '.claude/skills/' },
  },
  methods: {
    synthesis: {
      opencode: {
        status: 'content-compatible-untested',
        pending_verification: true,
        evidence_ref: 'evals/reports/synthesis/green.json',
        date: '2026-10-23',
        host_version: '1.19.4',
        model: 'agent/model-a',
        judge_model: 'judge/model-b',
        history: [],
      },
      'opencode-v2': { status: 'unverified', evidence_ref: null, date: '2026-10-30', note: 'No v2 eval report exists.', history: [] },
      pi: { status: 'content-compatible-untested', evidence_ref: 'docs/install.md#pi', date: '2026-10-23', host_version: '1.3.0', history: [] },
      codex: { status: 'content-compatible-untested', evidence_ref: 'docs/install.md#codex', date: '2026-10-23', host_version: '0.162.1', history: [] },
      'claude-code': {
        status: 'unverified',
        evidence_ref: null,
        date: '2026-10-23',
        note: 'CLI not installed on the author machine.',
        history: [],
      },
    },
  },
})

interface RepoSpec {
  matrix?: Matrix
  report?: Record<string, unknown> | null
  install?: string | null
  /** Replace the README table with this text instead of the rendered one. */
  table?: string
  skill?: boolean
  /** Extra files, by repo-relative path, written after the defaults. */
  files?: Record<string, string>
}

function repo(spec: RepoSpec = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'metacogs-matrix-'))
  scratch.push(root)
  const matrix = spec.matrix ?? baseMatrix()
  const put = (rel: string, content: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  put('matrix.json', JSON.stringify(matrix, null, 2))
  if (spec.skill !== false) put('skills/synthesis/SKILL.md', '---\nname: synthesis\n---\n')
  if (spec.report !== null) put('evals/reports/synthesis/green.json', JSON.stringify(spec.report ?? greenReport()))
  if (spec.install !== null) put('docs/install.md', spec.install ?? INSTALL_DOC)
  for (const [rel, content] of Object.entries(spec.files ?? {})) put(rel, content)
  const table = spec.table ?? renderMatrix(matrix)
  put('README.md', `# metacogs\n\n${README_START}\n${table}\n${README_END}\n\nafter\n`)
  return root
}

/** Mutate the baseline matrix, build a repo from it, and return the problems. */
function problemsFor(mutate: (m: Matrix) => void, spec: RepoSpec = {}): string[] {
  const matrix = baseMatrix()
  mutate(matrix)
  return checkMatrix({ root: repo({ ...spec, matrix }) }).map(p => `${p.where}: ${p.message}`)
}

const opencode = (m: Matrix): Cell => m.methods.synthesis!.opencode!

describe('checkMatrix: happy path', () => {
  test('valid matrix.json with a matching README table passes', () => {
    expect(checkMatrix({ root: repo() })).toEqual([])
  })

  test('a verified cell passes when the green report has completed human review', () => {
    const problems = problemsFor(
      m => {
        const c = opencode(m)
        c.status = 'verified'
        delete c.pending_verification
      },
      { report: greenReport({ human_review: { status: 'complete', judged_runs: 39, reviewed: 39 } }) },
    )
    expect(problems).toEqual([])
  })

  test('the committed matrix, install guide, reports, and README agree', () => {
    expect(checkMatrix({ root: REPO_ROOT })).toEqual([])
  })
})

describe('checkMatrix: plugin entries', () => {
  const SPIKE = 'evals/spikes/feel-drugs/README.md'
  const opencodeEntry = (): PluginEntry => ({
    status: 'verified',
    host_version: '1.19.4',
    evidence_ref: `${SPIKE}#plugin-reads`,
    date: '2026-10-26',
    note: 'Tested on the pinned release.',
  })
  const claudeEntry = (): PluginEntry => ({
    status: 'unverified',
    evidence_ref: 'docs/install.md#claude-code-plugin',
    date: '2026-10-27',
    note: 'Not installed on a real Claude Code.',
  })
  const opencodeV2Entry = (): PluginEntry => ({
    status: 'unverified',
    host_version: '2.2.2',
    evidence_ref: 'docs/install.md#opencode-plugin',
    date: '2026-10-30',
    note: 'The contract suite passes on the pinned CLI.',
  })
  const codexEntry = (): PluginEntry => ({ ...claudeEntry(), evidence_ref: 'docs/install.md#codex-plugin', experimental: true })
  const files = {
    [SPIKE]: '# Spike\n\n## Plugin reads\n\nFacts.\n',
    'docs/install.md': `${INSTALL_DOC}\n## OpenCode plugin\nDocs: https://opencode.ai/docs/plugins/\n\n## Claude Code plugin\nDocs: https://code.claude.com/docs/en/plugins\n\n## Codex plugin\nDocs: https://developers.openai.com/codex/plugins/build\n`,
  }
  const all = (): Record<string, PluginEntry> => ({ opencode: opencodeEntry(), 'opencode-v2': opencodeV2Entry(), 'claude-code': claudeEntry(), codex: codexEntry() })
  const withPlugins = (mutate: (plugins: Record<string, PluginEntry>) => void = () => {}, spec: RepoSpec = { files }) =>
    problemsFor(m => {
      const plugins = all()
      mutate(plugins)
      m.plugins = plugins
    }, spec)

  test('OpenCode verified and the two unverified host entries pass', () => {
    expect(withPlugins()).toEqual([])
  })

  test('a verified Claude Code or Codex entry without a manual_run note fails', () => {
    for (const host of ['claude-code', 'codex']) {
      const out = withPlugins(p => {
        p[host] = { ...p[host]!, status: 'verified', host_version: '2.1.312' }
        delete p[host]!.note
      })
      expect(out).toEqual([`plugins.${host}: verified requires a manual_run note saying what was installed and invoked by hand on a real install`])
    }
  })

  test('a verified Claude Code entry with a manual_run note and a host version passes', () => {
    expect(
      withPlugins(p => {
        p['claude-code'] = { ...p['claude-code']!, status: 'verified', host_version: '2.1.312', manual_run: 'Installed from the marketplace and ran /metacogs:feel.' }
      }),
    ).toEqual([])
  })

  test('a verified entry without host_version fails, and a blank manual_run does not count', () => {
    const out = withPlugins(p => {
      p.codex = { ...p.codex!, status: 'verified' }
      p['claude-code'] = { ...p['claude-code']!, status: 'verified', host_version: '2.1.312' }
    }).join('\n')
    expect(out).toContain('plugins.codex: a verified plugin needs host_version')
    expect(out).toContain('plugins.codex: verified requires a manual_run note')
    expect(withPlugins(p => void (p['claude-code'] = { ...p['claude-code']!, status: 'verified', host_version: '1', manual_run: ' ' })).join('\n')).toContain('manual_run must be a non-empty string')
  })

  test('a verified OpenCode v2 entry needs a manual_run note, unlike OpenCode', () => {
    const verified = (p: Record<string, PluginEntry>) => void (p['opencode-v2'] = { ...p['opencode-v2']!, status: 'verified' })
    expect(withPlugins(verified)).toEqual(['plugins.opencode-v2: verified requires a manual_run note saying what was installed and invoked by hand on a real install'])
    expect(
      withPlugins(p => {
        verified(p)
        p['opencode-v2']!.manual_run = 'Installed metacogs on OpenCode v2 2.2.2 and ran /feel.'
      }),
    ).toEqual([])
  })

  test('an unverified OpenCode v2 entry cannot carry a manual_run note', () => {
    expect(withPlugins(p => void (p['opencode-v2']!.manual_run = 'Ran it.'))).toEqual(['plugins.opencode-v2: manual_run is only valid on verified entries'])
  })

  test('the OpenCode entry stays verified without a manual_run note', () => {
    expect(withPlugins(p => void delete p.opencode!.note)).toEqual([])
  })

  test('an unverified entry needs a reason and cannot carry a manual_run note', () => {
    expect(withPlugins(p => void delete p.codex!.note)).toEqual(['plugins.codex: unverified requires a note giving the reason'])
    expect(withPlugins(p => void (p.codex!.manual_run = 'Ran it.'))).toEqual(['plugins.codex: manual_run is only valid on verified entries'])
  })

  test('evidence_ref may point into docs/install.md, the README or the spike notes, and the section must exist', () => {
    expect(withPlugins(p => void (p.codex!.evidence_ref = 'docs/install.md#nowhere'))).toEqual(['plugins.codex: docs/install.md has no section for #nowhere'])
    expect(withPlugins(p => void (p.opencode!.evidence_ref = 'README.md#plugin'))).toEqual(['plugins.opencode: README.md has no section for #plugin'])
    expect(withPlugins(p => void (p.opencode!.evidence_ref = `${SPIKE}#nowhere`))).toEqual([`plugins.opencode: ${SPIKE} has no section for #nowhere`])
    expect(withPlugins(undefined, { files: { 'docs/install.md': files['docs/install.md'] } })).toEqual([`plugins.opencode: evidence_ref points into ${SPIKE}, which does not exist`])
  })

  test('a foreign or traversal-shaped evidence_ref is rejected', () => {
    for (const ref of ['docs/other.md#x', 'docs/install.md', '../README.md#x', 'https://example.com/#x']) {
      expect(withPlugins(p => void (p.codex!.evidence_ref = ref)).join('\n')).toContain('plugins.codex: evidence_ref must be')
    }
  })

  test('an unknown key, an undeclared host, a bad status, a bad date and a non-boolean experimental flag are rejected', () => {
    expect(withPlugins(p => void Object.assign(p.codex!, { stauts: 'verified' }))).toEqual(['plugins.codex: unknown field "stauts"'])
    expect(withPlugins(p => void (p.vim = claudeEntry()))).toEqual(['plugins.vim: entry for undeclared host "vim"'])
    // An inherited Object.prototype name is not a declared host.
    expect(withPlugins(p => void Object.assign(p, { constructor: claudeEntry() }))).toEqual(['plugins.constructor: entry for undeclared host "constructor"'])
    const out = withPlugins(p => {
      Object.assign(p.codex!, { status: 'content-compatible-untested', date: '2026-13-40', experimental: 'yes' })
    }).join('\n')
    expect(out).toContain('status must be one of verified, unverified')
    expect(out).toContain('date must be a real YYYY-MM-DD date')
    expect(out).toContain('experimental must be a boolean')
  })

  test('the old single `plugin` entry is no longer accepted', () => {
    const raw = clone(baseMatrix()) as unknown as Record<string, unknown>
    raw.plugin = { host: 'opencode' }
    expect(parseMatrix(raw).problems.map(p => p.message)).toContain('unknown field "plugin"')
  })

  test('the README projection lists each plugin with its status, the experimental label and any manual run', () => {
    const matrix = baseMatrix()
    matrix.plugins = all()
    matrix.plugins['claude-code'] = { ...claudeEntry(), status: 'verified', host_version: '2.1.312', manual_run: 'Installed and ran /metacogs:feel.' }
    const table = renderMatrix(matrix)
    expect(table).toContain('| Host | Plugin package |')
    expect(table).toContain('| OpenCode | `verified`<br>OpenCode 1.19.4 · 2026-10-26 · [evidence](evals/spikes/feel-drugs/README.md#plugin-reads)')
    expect(table).toContain('| Claude Code | `verified`<br>Claude Code 2.1.312 · 2026-10-27 · [evidence](docs/install.md#claude-code-plugin)<br>Manual run: Installed and ran /metacogs:feel.')
    expect(table).toContain('| Codex | `unverified` (experimental)<br>2026-10-27 · [evidence](docs/install.md#codex-plugin)')
    expect(renderMatrix(baseMatrix())).toBe(renderTable(baseMatrix()))
  })

  test('a README without the plugin table fails, and the committed one carries it', () => {
    const matrix = baseMatrix()
    matrix.plugins = all()
    const root = repo({ matrix, files, table: renderTable(matrix) })
    expect(checkMatrix({ root }).some(p => p.where === 'README.md' && p.message.includes('matrix:render'))).toBe(true)
  })

  test('the committed matrix records OpenCode, Claude Code and Codex as verified, with Codex experimental', () => {
    const { matrix } = loadMatrix(REPO_ROOT)
    expect(matrix?.plugins?.opencode?.status).toBe('verified')
    expect(matrix?.plugins?.['claude-code']).toMatchObject({ status: 'verified', evidence_ref: 'docs/install.md#claude-code-plugin' })
    expect(matrix?.plugins?.codex).toMatchObject({ status: 'verified', evidence_ref: 'docs/install.md#codex-plugin', experimental: true })
  })
})

describe('checkMatrix: verified cells', () => {
  test('missing report fails and names the cell', () => {
    const problems = problemsFor(
      m => {
        const c = opencode(m)
        c.status = 'verified'
        delete c.pending_verification
      },
      { report: null },
    )
    expect(problems.some(p => p.startsWith('methods.synthesis.opencode:') && p.includes('does not exist'))).toBe(true)
  })

  test('human review not complete fails with a pointer to pending_verification', () => {
    const problems = problemsFor(m => {
      const c = opencode(m)
      c.status = 'verified'
      delete c.pending_verification
    })
    const hit = problems.find(p => p.includes('human_review.status'))
    expect(hit).toContain('methods.synthesis.opencode')
    expect(hit).toContain('pending_verification')
  })

  test('review that recomputed the verdict away from green blocks verification', () => {
    const problems = problemsFor(
      m => {
        const c = opencode(m)
        c.status = 'verified'
        delete c.pending_verification
      },
      { report: greenReport({ human_review: { status: 'complete', judged_runs: 39, reviewed: 39, recomputed: { verdict: 'green-miss' } } }) },
    )
    expect(problems.some(p => p.includes('recomputed the verdict'))).toBe(true)
  })

  test('a non-green report fails', () => {
    const problems = problemsFor(
      m => {
        const c = opencode(m)
        c.status = 'verified'
        delete c.pending_verification
      },
      { report: greenReport({ verdict: 'green-miss', human_review: { status: 'complete', judged_runs: 1, reviewed: 1 } }) },
    )
    expect(problems.some(p => p.includes('verdict is "green-miss"'))).toBe(true)
  })

  test('host version or model that differs from the report fails', () => {
    const problems = problemsFor(m => {
      const c = opencode(m)
      c.host_version = '1.0.0'
      c.model = 'other/model'
    })
    expect(problems.some(p => p.includes('host_version "1.0.0"'))).toBe(true)
    expect(problems.some(p => p.includes('model "other/model"'))).toBe(true)
  })

  test('a non-OpenCode host cannot cite a green report', () => {
    const problems = problemsFor(m => {
      const pi = m.methods.synthesis!.pi!
      pi.status = 'verified'
      pi.evidence_ref = 'evals/reports/synthesis/green.json'
    })
    expect(problems.some(p => p.startsWith('methods.synthesis.pi:') && p.includes('only OpenCode'))).toBe(true)
  })

  test('verified and pending_verification together is rejected', () => {
    const problems = problemsFor(
      m => {
        opencode(m).status = 'verified'
      },
      { report: greenReport({ human_review: { status: 'complete', judged_runs: 1, reviewed: 1 } }) },
    )
    expect(problems.some(p => p.includes('cannot also be pending_verification'))).toBe(true)
  })
})

describe('checkMatrix: content-compatible-untested and pending verification', () => {
  test('missing evidence_ref fails', () => {
    const problems = problemsFor(m => {
      m.methods.synthesis!.pi!.evidence_ref = null
    })
    expect(problems.some(p => p.startsWith('methods.synthesis.pi:'))).toBe(true)
  })

  test('an install ref must point at the cell host section', () => {
    const problems = problemsFor(m => {
      m.methods.synthesis!.pi!.evidence_ref = 'docs/install.md#codex'
    })
    expect(problems.some(p => p.includes("this host's section"))).toBe(true)
  })

  test('an install section without a discovery URL fails', () => {
    const problems = problemsFor(() => {}, { install: INSTALL_DOC.replace('Docs: https://pi.dev/docs/latest/skills', 'Docs: see the website') })
    expect(problems.some(p => p.startsWith('methods.synthesis.pi:') && p.includes('no primary discovery URL'))).toBe(true)
  })

  test('a missing install section fails', () => {
    const problems = problemsFor(() => {}, { install: INSTALL_DOC.replace('## Codex', '## Something else') })
    expect(problems.some(p => p.startsWith('methods.synthesis.codex:') && p.includes('no section for #codex'))).toBe(true)
  })

  test('a missing docs/install.md fails', () => {
    const problems = problemsFor(() => {}, { install: null })
    expect(problems.some(p => p.includes('docs/install.md, which does not exist'))).toBe(true)
  })

  test('traversal-shaped and foreign refs are rejected before any file read', () => {
    for (const ref of ['../secrets.json', '/etc/passwd', 'evals/reports/../../matrix.json', 'https://example.com/x']) {
      const problems = problemsFor(m => {
        m.methods.synthesis!.pi!.evidence_ref = ref
      })
      expect(problems.some(p => p.startsWith('methods.synthesis.pi:') && p.includes('evidence_ref must be'))).toBe(true)
    }
  })

  test('pending_verification flips to an error once human review is complete', () => {
    const problems = problemsFor(() => {}, { report: greenReport({ human_review: { status: 'complete', judged_runs: 1, reviewed: 1 } }) })
    expect(problems.some(p => p.includes('promote the cell to verified'))).toBe(true)
  })

  test('report-backed evidence without pending_verification is rejected', () => {
    const problems = problemsFor(m => {
      delete opencode(m).pending_verification
    })
    expect(problems.some(p => p.includes('requires pending_verification: true'))).toBe(true)
  })

  test('pending_verification with a non-green report fails', () => {
    const problems = problemsFor(() => {}, { report: greenReport({ verdict: 'green-miss' }) })
    expect(problems.some(p => p.startsWith('methods.synthesis.opencode:') && p.includes('not "green"'))).toBe(true)
  })
})

describe('checkMatrix: unverified and unsupported cells', () => {
  test('require a reason', () => {
    const problems = problemsFor(m => {
      delete m.methods.synthesis!['claude-code']!.note
    })
    expect(problems.some(p => p.startsWith('methods.synthesis.claude-code:') && p.includes('requires a note'))).toBe(true)
  })

  test('pending_verification is not valid on them', () => {
    const problems = problemsFor(m => {
      m.methods.synthesis!['claude-code']!.pending_verification = true
    })
    expect(problems.some(p => p.includes('only valid on content-compatible-untested'))).toBe(true)
  })
})

describe('checkMatrix: the OpenCode v2 host', () => {
  test('its unverified method cell needs a reason', () => {
    const problems = problemsFor(m => void delete m.methods.synthesis!['opencode-v2']!.note)
    expect(problems.some(p => p.startsWith('methods.synthesis.opencode-v2:') && p.includes('requires a note'))).toBe(true)
  })

  test('a verified method cell is refused: only OpenCode has a live eval runner, so no v2 report can back it', () => {
    const problems = problemsFor(m => {
      m.methods.synthesis!['opencode-v2'] = {
        status: 'verified',
        evidence_ref: 'evals/reports/synthesis/green.json',
        date: '2026-10-30',
        host_version: '1.19.4',
        model: 'agent/model-a',
        judge_model: 'judge/model-b',
        history: [],
      }
    })
    expect(problems).toContain('methods.synthesis.opencode-v2: only OpenCode has a live eval runner; other hosts cannot cite a green report')
  })

  test('a host without its method cell fails', () => {
    const problems = problemsFor(m => void delete m.methods.synthesis!['opencode-v2'])
    expect(problems).toContain('methods.synthesis: missing cell for host "opencode-v2"')
  })
})

describe('the committed matrix: OpenCode v2', () => {
  const { matrix } = loadMatrix(REPO_ROOT)

  test('is its own host with unverified synthesis and counterfactual cells that say no v2 eval report exists', () => {
    expect(matrix?.hosts['opencode-v2']).toEqual({ name: 'OpenCode (v2)', project_path: '.agents/skills/' })
    for (const method of ['synthesis', 'counterfactual']) {
      const cell = matrix?.methods[method]?.['opencode-v2']
      expect(cell?.status).toBe('unverified')
      expect(cell?.evidence_ref).toBeNull()
      expect(cell?.note).toContain('No v2 eval report exists')
    }
  })

  test('has an unverified plugin entry for 2.2.2 that waits for the owner\'s hand check', () => {
    const plugin = matrix?.plugins?.['opencode-v2']
    expect(plugin?.status).toBe('unverified')
    expect(plugin?.host_version).toBe('2.2.2')
    expect(plugin?.manual_run).toBeUndefined()
    expect(plugin?.note).toContain('contract suite')
  })
})

describe('checkMatrix: methods must have shipped', () => {
  test('a method without a green report is rejected', () => {
    const problems = problemsFor(() => {}, { report: greenReport({ verdict: 'green-miss' }) })
    expect(problems.some(p => p.startsWith('methods.synthesis:') && p.includes('verdict "green"'))).toBe(true)
  })

  test('a method without a skill directory is rejected', () => {
    const problems = problemsFor(() => {}, { skill: false })
    expect(problems.some(p => p.includes('skills/synthesis/SKILL.md does not exist'))).toBe(true)
  })
})

describe('checkMatrix: README agreement', () => {
  test('a table that disagrees with matrix.json fails', () => {
    const matrix = baseMatrix()
    const table = renderTable(matrix).replace('`unverified`', '`verified`')
    const problems = checkMatrix({ root: repo({ matrix, table }) })
    expect(problems.map(p => p.message).join('\n')).toContain('run `bun run matrix:render`')
  })

  test('missing markers fail', () => {
    const root = repo()
    writeFileSync(join(root, 'README.md'), '# no markers\n')
    expect(checkMatrix({ root }).some(p => p.where === 'README.md' && p.message.includes('marker'))).toBe(true)
  })

  test('duplicate markers fail', () => {
    const root = repo()
    const text = readFileSync(join(root, 'README.md'), 'utf8')
    writeFileSync(join(root, 'README.md'), `${text}\n${README_START}\n${README_END}\n`)
    expect(checkMatrix({ root }).some(p => p.message.includes('exactly one'))).toBe(true)
  })

  test('CRLF line endings do not count as drift', () => {
    const root = repo()
    const text = readFileSync(join(root, 'README.md'), 'utf8').replace(/\n/g, '\r\n')
    writeFileSync(join(root, 'README.md'), text)
    expect(checkMatrix({ root })).toEqual([])
  })
})

describe('renderReadme', () => {
  test('rewrites only the block and the result passes the check', () => {
    const matrix = baseMatrix()
    const root = repo({ matrix, table: 'stale table' })
    expect(checkMatrix({ root }).length).toBeGreaterThan(0)
    const readme = readFileSync(join(root, 'README.md'), 'utf8')
    const next = renderReadme(matrix, readme)
    expect(next.startsWith('# metacogs\n\n')).toBe(true)
    expect(next.endsWith('\n\nafter\n')).toBe(true)
    writeFileSync(join(root, 'README.md'), next)
    expect(checkMatrix({ root })).toEqual([])
    expect(renderReadme(matrix, next)).toBe(next)
  })

  test('throws when the markers are missing', () => {
    expect(() => renderReadme(baseMatrix(), '# nothing\n')).toThrow('marker')
  })

  test('the table shows pending review, versions, models, and escapes pipes', () => {
    const matrix = baseMatrix()
    matrix.methods.synthesis!.pi!.note = 'a | b'
    const table = renderTable(matrix)
    expect(table).toContain('`content-compatible-untested` (pending human review)')
    expect(table).toContain('OpenCode 1.19.4')
    expect(table).toContain('model `agent/model-a`')
    expect(table).toContain('judge `judge/model-b`')
    expect(table).toContain('a \\| b')
    expect(table).toContain('[Claude Code](docs/install.md#claude-code) | `.claude/skills/`')
  })
})

describe('history', () => {
  test('a regression downgrade that keeps its prior evidence under history is valid', () => {
    const problems = problemsFor(m => {
      const pi = m.methods.synthesis!.pi!
      pi.history = [
        { status: 'verified', evidence_ref: 'evals/reports/synthesis/green.json', date: '2026-10-01', host_version: '1.0.0', model: 'old/model', judge_model: 'old/judge' },
      ]
    })
    expect(problems).toEqual([])
  })

  test('a verified history entry that lost its evidence_ref is rejected', () => {
    const matrix = clone(baseMatrix())
    matrix.methods.synthesis!.pi!.history = [{ status: 'verified', evidence_ref: null, date: '2026-10-01' }]
    const { problems } = parseMatrix(matrix)
    expect(problems.some(p => p.where === 'methods.synthesis.pi.history[0]' && p.message.includes('keep its evidence_ref'))).toBe(true)
  })
})

describe('parseMatrix', () => {
  test('unknown fields are rejected, so a typo cannot disable a rule', () => {
    const raw = clone(baseMatrix()) as unknown as { methods: { synthesis: { pi: Record<string, unknown> } } }
    raw.methods.synthesis.pi.evidence_red = 'x'
    expect(parseMatrix(raw).problems.some(p => p.message.includes('unknown field "evidence_red"'))).toBe(true)
  })

  test('a missing host cell is reported', () => {
    const raw = clone(baseMatrix()) as unknown as { methods: { synthesis: Record<string, unknown> } }
    delete raw.methods.synthesis.codex
    expect(parseMatrix(raw).problems.some(p => p.message.includes('missing cell for host "codex"'))).toBe(true)
  })

  test('an undeclared host cell is reported', () => {
    const raw = clone(baseMatrix()) as unknown as { methods: { synthesis: Record<string, unknown> } }
    raw.methods.synthesis.zed = clone(raw.methods.synthesis.pi)
    expect(parseMatrix(raw).problems.some(p => p.message.includes('undeclared host "zed"'))).toBe(true)
  })

  test('bad status, bad date, and missing history are reported with their location', () => {
    const raw = clone(baseMatrix()) as unknown as { methods: { synthesis: { pi: Record<string, unknown> } } }
    raw.methods.synthesis.pi.status = 'works'
    raw.methods.synthesis.pi.date = '2026-02-30'
    delete raw.methods.synthesis.pi.history
    const messages = parseMatrix(raw).problems.filter(p => p.where === 'methods.synthesis.pi').map(p => p.message)
    expect(messages.some(m => m.includes('status must be one of'))).toBe(true)
    expect(messages.some(m => m.includes('real YYYY-MM-DD date'))).toBe(true)
    expect(parseMatrix(raw).problems.length).toBeGreaterThanOrEqual(2)
  })

  test('schema_version other than 2 is rejected', () => {
    const raw = clone(baseMatrix()) as unknown as Record<string, unknown>
    raw.schema_version = 1
    expect(parseMatrix(raw).problems.some(p => p.where === 'schema_version')).toBe(true)
  })

  test('loadMatrix reports invalid JSON and a missing file', () => {
    const root = repo()
    writeFileSync(join(root, 'matrix.json'), '{ nope')
    expect(loadMatrix(root).problems[0]?.message).toContain('invalid JSON')
    rmSync(join(root, 'matrix.json'))
    expect(loadMatrix(root).problems[0]?.message).toBe('does not exist')
  })
})

describe('markdown helpers', () => {
  test('slug follows GitHub heading anchors', () => {
    expect(slug('Claude Code')).toBe('claude-code')
    expect(slug('OpenCode')).toBe('opencode')
    expect(slug('Where `records` go?')).toBe('where-records-go')
  })

  test('sectionByAnchor stops at the next heading of equal or higher level and ignores fenced headings', () => {
    const doc = ['# Top', '## A', 'a-body', '```', '## fake', '```', '### A-child', 'child', '## B', 'b-body'].join('\n')
    const a = sectionByAnchor(doc, 'a') ?? ''
    expect(a).toContain('a-body')
    expect(a).toContain('child')
    expect(a).not.toContain('b-body')
    expect(sectionByAnchor(doc, 'fake')).toBeNull()
  })
})
