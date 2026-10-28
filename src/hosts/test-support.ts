// Typed access to parsed JSON for the host tests. `JSON.parse` returns `any`; these narrow it from `unknown`, so a
// manifest that changes shape fails with a message naming the path instead of a property read on `undefined`.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type JsonValue = { [key: string]: JsonValue } | JsonValue[] | string | number | boolean | null
export type JsonObject = { [key: string]: JsonValue }

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseJson(text: string): JsonValue {
  return JSON.parse(text)
}

/** A JSON file under `root`, as a value of unknown shape. */
export function readJsonFile(root: string, path: string): JsonValue {
  return parseJson(readFileSync(join(root, path), 'utf8'))
}

export function obj(value: unknown, what = 'value'): JsonObject {
  if (!isObject(value)) throw new Error(`${what}: expected an object, got ${JSON.stringify(value)}`)
  return value
}

export function arr(value: unknown, what = 'value'): JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${what}: expected an array, got ${JSON.stringify(value)}`)
  return value
}

export function str(value: unknown, what = 'value'): string {
  if (typeof value !== 'string') throw new Error(`${what}: expected a string, got ${JSON.stringify(value)}`)
  return value
}

/** Follow `path` (object keys and array indexes) from `value`. Throws, naming the step, where the shape differs. */
export function at(value: unknown, ...path: (string | number)[]): JsonValue {
  let current: unknown = value
  const walked: string[] = []
  for (const step of path) {
    walked.push(String(step))
    if (typeof step === 'number') current = arr(current, walked.join('.'))[step]
    else current = obj(current, walked.slice(0, -1).join('.') || '(root)')[step]
    if (current === undefined) throw new Error(`${walked.join('.')}: missing`)
  }
  return current as JsonValue
}

/** A JSON-RPC message from an MCP server, as far as the relocation tests read it. */
export interface RpcMessage {
  id?: number
  result?: Record<string, unknown>
  error?: unknown
}
