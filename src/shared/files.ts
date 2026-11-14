import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export function hash(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex")
}

export function lstat(file: string): fs.Stats | undefined {
  return fs.lstatSync(file, { throwIfNoEntry: false })
}

/** Writes to a temporary sibling, then renames it over the file, so a reader never sees half a file. */
export function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}`
  const descriptor = fs.openSync(temporary, "w", 0o644)
  try {
    fs.writeSync(descriptor, content)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  fs.renameSync(temporary, file)
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`)
  }
}

/** Writes JSON only when it changed, so a no-change run leaves the file alone. */
export function writeJson(file: string, value: unknown): void {
  const content = `${JSON.stringify(value, null, 2)}\n`
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) return
  writeAtomic(file, content)
}

/** Holds an exclusive `flock` on a file until released; null when another process holds it. */
export function acquireLock(file: string): { release(): void } | null {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const descriptor = fs.openSync(file, "a")
  // flock locks the open file description, which this process keeps open after the helper exits.
  const result = spawnSync("flock", ["--nonblock", "3"], { stdio: ["ignore", "ignore", "ignore", descriptor] })
  if (result.status === 0) return { release: () => fs.closeSync(descriptor) }
  fs.closeSync(descriptor)
  if (result.error) throw new Error(`Could not run flock: ${result.error.message}`)
  return null
}
