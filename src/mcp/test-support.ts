// Shared by the MCP server tests. Not a test file itself (no `.test.` suffix).
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'

export interface Message {
  jsonrpc?: string
  id?: number | string
  method?: string
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

export interface ToolResult {
  isError?: boolean
  content: { type: string; text: string }[]
}

/** A running server: requests are matched to responses by `id`, since responses may arrive in any order. */
export class Session {
  readonly stdoutLines: string[] = []
  stderr = ''
  private readonly proc: ChildProcessWithoutNullStreams
  private buffer = ''
  private nextId = 1
  private readonly waiting = new Map<number | string, (message: Message) => void>()
  readonly exited: Promise<number | null>

  /** `env` replaces the server's environment when given; the default is this process's. */
  constructor(bundle: string, cwd: string, env?: Record<string, string | undefined>) {
    this.proc = spawn('node', [bundle], { cwd, stdio: ['pipe', 'pipe', 'pipe'], ...(env !== undefined ? { env: env as NodeJS.ProcessEnv } : {}) })
    this.proc.stdout.setEncoding('utf8')
    this.proc.stderr.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      for (let newline = this.buffer.indexOf('\n'); newline !== -1; newline = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        this.stdoutLines.push(line)
        const message = JSON.parse(line) as Message
        if (message.id !== undefined) this.waiting.get(message.id)?.(message)
      }
    })
    this.proc.stderr.on('data', (chunk: string) => {
      this.stderr += chunk
    })
    this.exited = new Promise((resolve, reject) => {
      this.proc.on('error', reject)
      this.proc.on('close', code => resolve(code))
    })
  }

  private write(message: object): void {
    this.proc.stdin.write(`${JSON.stringify(message)}\n`)
  }

  request(method: string, params?: object): Promise<Message> {
    const id = this.nextId++
    const response = new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no response to ${method} #${id}; stderr: ${this.stderr}`)), 10_000)
      this.waiting.set(id, message => {
        clearTimeout(timer)
        resolve(message)
      })
    })
    this.write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
    return response
  }

  /** Send a request whose JSON text the caller builds, for payloads `JSON.stringify` cannot produce or would not send. */
  requestRaw(build: (id: number) => string): Promise<Message> {
    const id = this.nextId++
    const response = new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no response to raw request #${id}; stderr: ${this.stderr}`)), 10_000)
      this.waiting.set(id, message => {
        clearTimeout(timer)
        resolve(message)
      })
    })
    this.proc.stdin.write(`${build(id)}\n`)
    return response
  }

  notify(method: string): void {
    this.write({ jsonrpc: '2.0', method })
  }

  async initialize(): Promise<Message> {
    const response = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'server-test', version: '0.0.0' } })
    this.notify('notifications/initialized')
    return response
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const response = await this.request('tools/call', { name, arguments: args })
    if (response.result === undefined) throw new Error(`tools/call ${name} returned a JSON-RPC error: ${JSON.stringify(response.error)}`)
    return response.result as unknown as ToolResult
  }

  /** Close stdin and wait for the server to exit. */
  async end(): Promise<number | null> {
    this.proc.stdin.end()
    return this.exited
  }

  kill(): void {
    this.proc.kill()
  }
}
