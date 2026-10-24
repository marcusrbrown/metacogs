// generated — do not edit; run `bun run generate`

// src/record/cli.ts
import { realpathSync } from "node:fs";
import { readFile as readFile2 } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// src/record/contract.ts
var SCHEMA_VERSION = 1;
var SHIPPED_METHODS = ["counterfactual", "synthesis"];
var METHOD_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
var EXECUTION_MODES = [
  "direct",
  "sequential",
  "delegated",
  "unrecorded",
  "counterfactual",
  "synthesis"
];
var REQUIRED_STRING_FIELDS = ["method_version", "objective", "next_action", "reopen_condition", "status"];
var STRING_ARRAY_FIELDS = ["evidence", "assumptions", "alternatives", "findings"];
var STAMPED_FIELD = "helper_version";
var RECORD_FIELDS = [
  "schema_version",
  "helper_version",
  "method",
  "method_version",
  "objective",
  "evidence",
  "assumptions",
  "alternatives",
  "findings",
  "next_action",
  "reopen_condition",
  "execution_mode",
  "status"
];
var EXIT = {
  OK: 0,
  VALIDATION: 2,
  IO: 3,
  COLLISION: 4,
  USAGE: 64
};

// src/record/validate.ts
var isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;
function validateRecord(input, options = {}) {
  if (!isPlainObject(input))
    return fail([{ field: "$", message: "record must be a JSON object" }]);
  if (input.schema_version !== SCHEMA_VERSION) {
    const got = input.schema_version === undefined ? "missing" : JSON.stringify(input.schema_version);
    return fail([{ field: "schema_version", message: `unsupported value ${got}; this helper only accepts ${SCHEMA_VERSION}` }]);
  }
  const errors = [];
  const methods = options.methods ?? SHIPPED_METHODS;
  for (const key of Object.keys(input)) {
    if (!RECORD_FIELDS.includes(key))
      errors.push({ field: key, message: "unknown field" });
  }
  if (input[STAMPED_FIELD] !== undefined && typeof input[STAMPED_FIELD] !== "string") {
    errors.push({ field: STAMPED_FIELD, message: "must be a string when present" });
  }
  const method = input.method;
  if (typeof method !== "string") {
    errors.push({ field: "method", message: "is required and must be a string" });
  } else if (!METHOD_PATTERN.test(method)) {
    errors.push({ field: "method", message: `must match ${METHOD_PATTERN.source}` });
  } else if (!methods.includes(method)) {
    errors.push({ field: "method", message: `must be one of: ${methods.join(", ")}` });
  }
  for (const field of REQUIRED_STRING_FIELDS) {
    if (!isNonEmptyString(input[field]))
      errors.push({ field, message: "is required and must be a non-empty string" });
  }
  for (const field of STRING_ARRAY_FIELDS) {
    const value = input[field];
    if (!Array.isArray(value)) {
      errors.push({ field, message: "is required and must be an array of strings" });
      continue;
    }
    value.forEach((entry, index) => {
      if (!isNonEmptyString(entry))
        errors.push({ field: `${field}[${index}]`, message: "must be a non-empty string" });
    });
  }
  const mode = input.execution_mode;
  if (typeof mode !== "string" || !EXECUTION_MODES.includes(mode)) {
    errors.push({ field: "execution_mode", message: `must be one of: ${EXECUTION_MODES.join(", ")}` });
  }
  if (errors.length > 0)
    return fail(errors);
  return { ok: true, record: input };
}
function fail(errors) {
  return { ok: false, errors };
}

// src/record/write.ts
import { randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

// src/record/canonical.ts
import { createHash } from "node:crypto";
function canonicalize(value) {
  if (value === null)
    return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value))
        throw new TypeError("canonicalize: non-finite number");
      return JSON.stringify(value);
    case "string":
      if (!value.isWellFormed())
        throw new TypeError("canonicalize: string contains a lone surrogate");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value))
        return `[${value.map(canonicalize).join(",")}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null)
        throw new TypeError("canonicalize: only plain objects are supported");
      const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      return `{${entries.map(([key, val]) => `${canonicalize(key)}:${canonicalize(val)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalize: unsupported value of type ${typeof value}`);
  }
}
function canonicalPayload(record) {
  const { [STAMPED_FIELD]: _stamped, ...payload } = record;
  return canonicalize(payload);
}
function recordHash(record) {
  return createHash("sha256").update(canonicalPayload(record), "utf8").digest("hex");
}
function recordFilename(record) {
  return `${record.method}-${recordHash(record).slice(0, 16)}.json`;
}

// src/record/write.ts
class RecordIoError extends Error {
  name = "RecordIoError";
}

class RecordCollisionError extends Error {
  path;
  name = "RecordCollisionError";
  constructor(path) {
    super(`${path} already exists with different content; refusing to overwrite`);
    this.path = path;
  }
}
var set = (value) => value !== undefined && value !== "";
function resolveRoot({ outDir, env, cwd, home }) {
  if (set(outDir))
    return resolve(cwd, outDir);
  const fromEnv = env.METACOGS_RECORDS_DIR;
  if (set(fromEnv))
    return resolve(cwd, fromEnv);
  const xdg = env.XDG_STATE_HOME;
  if (set(xdg) && isAbsolute(xdg))
    return join(xdg, "metacogs", "records");
  return join(home, ".local", "state", "metacogs", "records");
}
function assertDirectChild(root, path) {
  const rel = relative(root, path);
  if (rel === "" || isAbsolute(rel) || rel.startsWith("..") || rel.includes(sep)) {
    throw new RecordIoError(`resolved path ${path} is not a direct child of the output root ${root}`);
  }
}
var code = (error) => error?.code;
async function isEquivalent(path, expectedBytes, record) {
  const existing = await readFile(path, "utf8");
  if (existing === expectedBytes)
    return true;
  try {
    return canonicalPayload(JSON.parse(existing)) === canonicalPayload(record);
  } catch {
    return false;
  }
}
async function writeRecord({ root, record }) {
  let name;
  let bytes;
  try {
    name = recordFilename(record);
    bytes = `${canonicalize(record)}
`;
  } catch (error) {
    throw new RecordIoError(`cannot serialize record: ${error.message}`);
  }
  const resolvedRoot = resolve(root);
  const final = resolve(resolvedRoot, name);
  assertDirectChild(resolvedRoot, final);
  try {
    await mkdir(resolvedRoot, { recursive: true, mode: 448 });
  } catch (error) {
    throw new RecordIoError(`cannot create ${resolvedRoot}: ${error.message}`);
  }
  const tmp = join(resolvedRoot, `.${name}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let tmpCreated = false;
  try {
    const handle = await open(tmp, "wx", 384);
    tmpCreated = true;
    try {
      await handle.writeFile(bytes, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(tmp, final);
      return { path: final, status: "written" };
    } catch (error) {
      if (code(error) !== "EEXIST")
        throw error;
    }
    if (await isEquivalent(final, bytes, record))
      return { path: final, status: "exists" };
    throw new RecordCollisionError(final);
  } catch (error) {
    if (error instanceof RecordCollisionError || error instanceof RecordIoError)
      throw error;
    throw new RecordIoError(`cannot write ${final}: ${error.message}`);
  } finally {
    if (tmpCreated)
      await unlink(tmp).catch(() => {
        return;
      });
  }
}

// src/record/cli.ts
var PROGRAM = "metacogs-record";
var USAGE = `usage: ${PROGRAM} [--out-dir <dir>] [--file <path>]
  Reads one JSON record from stdin (or --file), validates it, and writes <method>-<hash>.json.
  Output root: --out-dir, else $METACOGS_RECORDS_DIR, else $XDG_STATE_HOME/metacogs/records,
               else ~/.local/state/metacogs/records.
  Prints {"path": ..., "next_action": ...} on success.
  Exit codes: 0 written, 2 validation, 3 I/O, 4 collision, 64 usage.
`;

class UsageError extends Error {
  name = "UsageError";
}
function parseArgs(argv) {
  let outDir;
  let file;
  for (let i = 0;i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h")
      return { kind: "help" };
    const eq = arg.indexOf("=");
    const flag = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
    if (flag !== "--out-dir" && flag !== "--file")
      return { kind: "usage", message: `unexpected argument: ${arg}` };
    let value;
    if (flag === arg) {
      value = argv[++i];
    } else {
      value = arg.slice(eq + 1);
    }
    if (value === undefined || value === "")
      return { kind: "usage", message: `${flag} requires a value` };
    if (flag === "--out-dir") {
      if (outDir !== undefined)
        return { kind: "usage", message: "--out-dir given more than once" };
      outDir = value;
    } else {
      if (file !== undefined)
        return { kind: "usage", message: "--file given more than once" };
      file = value;
    }
  }
  return { kind: "run", ...outDir !== undefined ? { outDir } : {}, ...file !== undefined ? { file } : {} };
}
function buildMethods() {
  return "counterfactual,synthesis".split(",");
}
function buildHelperVersion() {
  return "0.1.0";
}
async function run(argv, ctx) {
  const err = (text) => ctx.stderr(`${PROGRAM}: ${text}
`);
  const args = parseArgs(argv);
  if (args.kind === "help") {
    ctx.stdout(USAGE);
    return EXIT.OK;
  }
  if (args.kind === "usage") {
    ctx.stderr(`${PROGRAM}: ${args.message}
${USAGE}`);
    return EXIT.USAGE;
  }
  let raw;
  try {
    raw = args.file !== undefined ? await readFile2(args.file, "utf8") : await ctx.readStdin();
  } catch (error) {
    if (error instanceof UsageError) {
      ctx.stderr(`${PROGRAM}: ${error.message}
${USAGE}`);
      return EXIT.USAGE;
    }
    err(`cannot read input: ${error.message}`);
    return EXIT.IO;
  }
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    err(`validation failed
  $: input is not valid JSON`);
    return EXIT.VALIDATION;
  }
  const checked = validateRecord(input, { methods: ctx.methods ?? buildMethods() });
  if (!checked.ok) {
    err(`validation failed
${checked.errors.map((e) => `  ${e.field}: ${e.message}`).join(`
`)}`);
    return EXIT.VALIDATION;
  }
  const record = { ...checked.record, helper_version: ctx.helperVersion ?? buildHelperVersion() };
  try {
    const root = resolveRoot({
      outDir: args.outDir,
      env: ctx.env,
      cwd: ctx.cwd,
      home: ctx.env.HOME || homedir()
    });
    const { path } = await writeRecord({ root, record });
    ctx.stdout(`${JSON.stringify({ path, next_action: record.next_action })}
`);
    return EXIT.OK;
  } catch (error) {
    if (error instanceof RecordCollisionError) {
      err(`collision: ${error.message}`);
      return EXIT.COLLISION;
    }
    err(`I/O failure: ${error instanceof RecordIoError ? error.message : error.message}`);
    return EXIT.IO;
  }
}
async function readProcessStdin() {
  if (process.stdin.isTTY)
    throw new UsageError("no input: pipe a JSON record on stdin or pass --file");
  const chunks = [];
  for await (const chunk of process.stdin)
    chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
function isEntrypoint() {
  const entry = process.argv[1];
  if (entry === undefined)
    return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isEntrypoint()) {
  process.exitCode = await run(process.argv.slice(2), {
    env: process.env,
    cwd: process.cwd(),
    readStdin: readProcessStdin,
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text)
  });
}
export {
  UsageError,
  run
};
