import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { z } from "zod"
import { describeIssues } from "./config.ts"

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

/** Reads a JSON file and validates it; a missing file is the fallback, a bad one an error naming the key. */
export function readValid<S extends z.ZodType>(file: string, schema: S, fallback: z.output<S>): z.output<S> {
  const value = readJson<unknown>(file, undefined)
  if (value === undefined) return fallback
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new Error(`${file}: ${describeIssues(parsed.error)}`)
  return parsed.data
}

/** Writes JSON only when it changed, so a no-change run leaves the file alone. */
export function writeJson(file: string, value: unknown): void {
  const content = `${JSON.stringify(value, null, 2)}\n`
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) return
  writeAtomic(file, content)
}

/** A digest of a folder's tree: every relative path, its kind and its file contents, in a stable order. */
export function hashTree(directory: string): string {
  const digest = crypto.createHash("sha256")
  const walk = (current: string, prefix: string) => {
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const file = path.join(current, entry.name)
      const relative = `${prefix}${entry.name}`
      if (entry.isDirectory()) {
        digest.update(`d ${relative}\0`)
        walk(file, `${relative}/`)
      } else if (entry.isFile()) {
        digest.update(`f ${relative}\0`).update(fs.readFileSync(file)).update("\0")
      } else {
        digest.update(`o ${relative}\0`)
      }
    }
  }
  walk(directory, "")
  return digest.digest("hex")
}

/** The tree digest of a real folder, or null when the path is missing or not a folder. */
export function hashDirectory(directory: string): string | null {
  return lstat(directory)?.isDirectory() ? hashTree(directory) : null
}

/** A folder name for the time, safe on every filesystem. */
export function stamp(now: Date): string {
  return now.toISOString().replaceAll(":", "-")
}

/** Moves a file or folder into the state's backups, keeping its path below home; returns where it went. */
export function backup(paths: { home: string; state: string }, file: string, now: Date): string {
  const relative = path.relative(paths.home, file).startsWith("..") ? file.replace(/^\/+/u, "") : path.relative(paths.home, file)
  const destination = path.join(paths.state, "backups", stamp(now), relative)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.renameSync(file, destination)
  return destination
}

/** Moves a file that failed validation out of the way, so one bad file never stops the rest; returns where it went. */
export function quarantine(paths: { state: string }, file: string): string {
  const destination = path.join(paths.state, "backups", "invalid", `${path.basename(file)}.${Date.now()}`)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.renameSync(file, destination)
  return destination
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
