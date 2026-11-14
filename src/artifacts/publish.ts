import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { readSecret, type Config, type Paths } from "../shared/config.ts"

/**
 * Artifacts are files published to a public bucket, each at a link that never expires. The bucket is the index: where
 * a file sits says what it belongs to, so nothing else records it.
 *
 *   <project>/<task>/<name>-<random>.<ext>   a task's files, such as lennys-shoe-apparel/tsk-123/checkout-after-7f3a9c.png
 *   <project>/<YYYY-MM>/<name>-<random>.<ext> a project's files outside a task
 *   <YYYY-MM>/<name>-<random>.<ext>           everything else
 *
 * A folder is a page: it keeps its files under `<name>-<random>/`, and its link opens its index.html. The random part
 * keeps links unguessable and stops one publish from replacing another.
 */

export interface StoredObject {
  key: string
  size: number
  /** ISO time of the upload. */
  modified: string
}

/** The few bucket calls artifacts need. The CLI uses Bun's S3 client; tests pass their own. */
export interface Bucket {
  write(key: string, body: Blob, type: string): Promise<void>
  list(prefix: string): Promise<StoredObject[]>
  delete(key: string): Promise<void>
}

/** The access key every bucket call is signed with, read like the Notion token. */
export const KEY_NAMES = ["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const

const MAX_BYTES = 100 * 1024 * 1024
const MAX_FILES = 1_000
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/u
const TASK = /^[a-z]+-\d+$/u
const PROJECT = /^[a-z0-9][a-z0-9._-]*$/u
/** A leaf: `<name>-<6 hex>` and, for a file, its extension. */
const LEAF = /^([a-z0-9]+(?:-[a-z0-9]+)*)-([0-9a-f]{6})(\.[a-z0-9]+)?$/u

/** A refusal with its fix. `usage` is false when the input was fine but the bucket failed. */
export class ArtifactError extends Error {
  readonly fix: string
  readonly usage: boolean
  constructor(message: string, fix: string, usage = true) {
    super(message)
    this.fix = fix
    this.usage = usage
  }
}

export interface PublishInput {
  /** A file, or a folder with an index.html. */
  source: string
  /** The name it gets, in kebab case; the file's own name by default. */
  title?: string
  /** A folder directly under the projects folder. */
  project?: string
  /** The Notion task's ID, such as TSK-123. Needs a project. */
  task?: string
}

/** One artifact, as publish and list return it. */
export interface Artifact {
  url: string
  project: string | null
  task: string | null
  /** The kebab-case name, without the random part and extension. */
  name: string
  type: string
  bytes: number
  /** Files in it: one for a file, every file of a page. */
  files: number
  created: string
}

export interface ArtifactContext {
  paths: Paths
  config: Config
  bucket: Bucket
  now: Date
}

/** The configured bucket, or an error saying what to set. */
export function settings(config: Config) {
  if (config.artifacts) return config.artifacts
  throw new ArtifactError("no bucket configured for artifacts", 'set "artifacts": { "bucketUrl": "<S3 endpoint>/<bucket>", "publicUrl": "<public address>" } in the config')
}

const bucketError = (action: string, error: unknown) => new ArtifactError(`the bucket refused the ${action}: ${(error as Error).message}`, `check the access key and the bucketUrl in the config, then ${action} again`, false)

/** Bun's S3 client on the configured bucket, signed with the access key from the environment or the secrets file. */
export function openBucket(paths: Paths, config: Config): Bucket {
  const { bucketUrl } = settings(config)
  const [accessKeyId, secretAccessKey] = KEY_NAMES.map((name) => readSecret(paths.secrets, name))
  if (!accessKeyId || !secretAccessKey) throw new ArtifactError("no access key for the artifacts bucket", `set ${KEY_NAMES.join(" and ")} in the environment or in the secrets file`)
  const url = new URL(bucketUrl)
  const client = new Bun.S3Client({ endpoint: url.origin, bucket: url.pathname.split("/").filter(Boolean)[0]!, region: "auto", accessKeyId, secretAccessKey })
  return {
    write: async (key, body, type) => void (await client.write(key, body, { type })),
    list: async (prefix) => {
      const objects: StoredObject[] = []
      let continuationToken: string | undefined
      do {
        const page = await client.list({ prefix, ...(continuationToken ? { continuationToken } : {}) })
        objects.push(...(page.contents ?? []).map((entry) => ({ key: entry.key, size: entry.size ?? 0, modified: entry.lastModified ?? "" })))
        continuationToken = page.isTruncated ? page.nextContinuationToken : undefined
      } while (continuationToken)
      return objects
    },
    delete: (key) => client.delete(key),
  }
}

/** Text in kebab case: lowercase ASCII letters and digits, accents dropped, everything else a single dash. */
export function kebab(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80)
    .replace(/-+$/u, "")
}

/** The files to publish, as paths relative to the source, refusing what must never go public by accident. */
function collect(source: string): { root: string; files: string[]; page: boolean } {
  const stats = fs.lstatSync(source, { throwIfNoEntry: false })
  if (!stats) throw new ArtifactError(`${source} does not exist`, "give the path of a file, or of a folder with an index.html")
  if (stats.isSymbolicLink()) throw new ArtifactError(`${source} is a link`, "give the file or folder it points to")
  const name = path.basename(source)
  if (name.startsWith(".")) throw new ArtifactError(`${name} is a dot-file, and dot-files are never published`, "rename it, or publish the files it holds")
  if (stats.isFile()) return { root: path.dirname(source), files: [name], page: false }
  if (!stats.isDirectory()) throw new ArtifactError(`${source} is not a file or folder`, "give the path of a file, or of a folder with an index.html")
  const files: string[] = []
  const walk = (relative: string) => {
    for (const entry of fs.readdirSync(path.join(source, relative), { withFileTypes: true })) {
      const file = path.posix.join(relative, entry.name)
      if (entry.name.startsWith(".")) throw new ArtifactError(`${file} is a dot-file, and dot-files are never published`, "remove it from the folder, or publish a copy without it")
      if (entry.isSymbolicLink()) throw new ArtifactError(`${file} is a link`, "replace it with the file itself, or remove it")
      if (entry.isDirectory()) walk(file)
      else if (entry.isFile()) files.push(file)
      if (files.length > MAX_FILES) throw new ArtifactError(`the folder holds more than ${MAX_FILES} files`, "publish a smaller folder")
    }
  }
  walk("")
  if (!files.includes("index.html")) throw new ArtifactError(`${name} has no index.html`, "add the page's entry file as index.html at the folder's top, or publish a single file")
  return { root: source, files: files.sort(), page: true }
}

/** The projects a publish may name: folders directly under the projects folder. */
function projects(paths: Paths): string[] {
  if (!fs.existsSync(paths.projects)) return []
  return fs.readdirSync(paths.projects, { withFileTypes: true }).filter((entry) => entry.isDirectory() && PROJECT.test(entry.name)).map((entry) => entry.name).sort()
}

/** A task ID such as TSK-123, as its folder name, tsk-123. */
function taskFolder(value: string): string {
  const folder = value.trim().toLowerCase()
  if (!TASK.test(folder)) throw new ArtifactError(`"${value}" is not a task ID`, "give the Notion task's ID, such as TSK-123")
  return folder
}

/** The public link to a key, each part encoded. */
function link(publicUrl: string, key: string): string {
  return `${publicUrl}/${key.split("/").map(encodeURIComponent).join("/")}`
}

const typeOf = (file: string) => Bun.file(file).type || "application/octet-stream"

export async function publish(input: PublishInput, context: ArtifactContext): Promise<Artifact> {
  const { publicUrl } = settings(context.config)
  const source = path.resolve(input.source)
  const known = projects(context.paths)
  if (input.project !== undefined && !known.includes(input.project)) throw new ArtifactError(`no project "${input.project}"`, `give a folder name under the projects folder: ${known.join(", ") || "(none)"}`)
  if (input.task !== undefined && input.project === undefined) throw new ArtifactError("--task needs --project", "add the task's project, such as --project <folder>")
  const task = input.task === undefined ? null : taskFolder(input.task)
  const { root, files, page } = collect(source)
  const extension = page ? "" : path.extname(source).toLowerCase().replace(/[^.a-z0-9]/gu, "")
  // A title that ends in the file's own extension doesn't get it twice.
  const title = input.title ?? path.basename(source)
  const name = kebab(extension && title.toLowerCase().endsWith(extension) ? title.slice(0, -extension.length) : title)
  if (!name) throw new ArtifactError(`"${title}" has no letters or digits to name the file by`, "give a --title such as \"checkout after redesign\"")
  const blobs = files.map((file) => Bun.file(path.join(root, file)))
  const bytes = blobs.reduce((sum, blob) => sum + blob.size, 0)
  if (bytes > MAX_BYTES) throw new ArtifactError(`${Math.round(bytes / 1024 / 1024)} MiB is over the ${MAX_BYTES / 1024 / 1024} MiB limit`, "publish a smaller file, such as a compressed video")
  const month = context.now.toISOString().slice(0, 7)
  const folder = [input.project, task ?? month].filter(Boolean).join("/")
  const leaf = `${name}-${crypto.randomBytes(3).toString("hex")}${extension}`
  const keys = page ? files.map((file) => `${folder}/${leaf}/${file}`) : [`${folder}/${leaf}`]
  const written: string[] = []
  try {
    // index.html last, so a page's link opens only once its assets are there.
    for (const index of files.map((_, index) => index).sort((a, b) => Number(files[a] === "index.html") - Number(files[b] === "index.html"))) {
      await context.bucket.write(keys[index]!, blobs[index]!, typeOf(files[index]!))
      written.push(keys[index]!)
    }
  } catch (error) {
    // Take back what went up, so a failed publish leaves nothing public.
    const left: string[] = []
    for (const key of written) await context.bucket.delete(key).catch(() => left.push(key))
    const detail = left.length ? `; these files are still public: ${left.map((key) => link(publicUrl, key)).join(", ")}` : "; nothing was left public"
    throw new ArtifactError(`the bucket refused the upload: ${(error as Error).message}${detail}`, "check the access key and the bucketUrl in the config, then publish again", false)
  }
  const entry = page ? `${folder}/${leaf}/index.html` : keys[0]!
  return { url: link(publicUrl, entry), project: input.project ?? null, task, name, type: typeOf(page ? "index.html" : source), bytes, files: files.length, created: context.now.toISOString() }
}

/** Where a key sits in the layout: its artifact's key (a file, or a page's folder), or null when it isn't one. */
function locate(key: string): { project: string | null; task: string | null; name: string; root: string; page: boolean; file: string } | null {
  const parts = key.split("/")
  const depth = MONTH.test(parts[0]!) ? 1 : PROJECT.test(parts[0]!) && parts[1] && (MONTH.test(parts[1]) || TASK.test(parts[1])) ? 2 : 0
  if (!depth) return null
  const leaf = parts[depth]
  const match = leaf?.match(LEAF)
  if (!match) return null
  const page = parts.length > depth + 1
  // A page's folder never has an extension: names are kebab case.
  if (page && match[3]) return null
  return {
    project: depth === 2 ? parts[0]! : null,
    task: depth === 2 && TASK.test(parts[1]!) ? parts[1]! : null,
    name: match[1]!,
    root: parts.slice(0, depth + 1).join("/"),
    page,
    file: parts.slice(depth + 1).join("/"),
  }
}

export interface ListInput {
  project?: string
  task?: string
  /** Words that must all appear in the name, project or task. */
  search?: string
  limit?: number
}

/** The artifacts that match, newest first. The layout is the index: a project or task reads only its own folder. */
export async function list(input: ListInput, context: Omit<ArtifactContext, "paths" | "now">): Promise<{ artifacts: Artifact[]; total: number }> {
  const { publicUrl } = settings(context.config)
  if (input.task !== undefined && input.project === undefined) throw new ArtifactError("--task needs --project", "add the task's project, such as --project <folder>")
  if (input.project !== undefined && !PROJECT.test(input.project)) throw new ArtifactError(`"${input.project}" is not a project folder name`, "give a folder name under the projects folder")
  const task = input.task === undefined ? undefined : taskFolder(input.task)
  const prefix = input.project === undefined ? "" : `${input.project}/${task ? `${task}/` : ""}`
  const words = (input.search ?? "").split(/\s+/u).map(kebab).filter(Boolean)
  const objects = await context.bucket.list(prefix).catch((error) => Promise.reject(bucketError("list", error)))
  const found = new Map<string, Artifact & { entry: string | null }>()
  for (const object of objects) {
    const place = locate(object.key)
    if (!place) continue
    const artifact = found.get(place.root) ?? { url: "", entry: null, project: place.project, task: place.task, name: place.name, type: typeOf(place.page ? "index.html" : place.root), bytes: 0, files: 0, created: "" }
    artifact.bytes += object.size
    artifact.files += 1
    if (object.modified > artifact.created) artifact.created = object.modified
    if (!place.page || place.file === "index.html") artifact.entry = object.key
    found.set(place.root, artifact)
  }
  const matches = [...found.values()]
    // A page without its index.html is a publish still going up, or one half deleted: it has no link to give.
    .flatMap(({ entry, ...artifact }) => (entry ? [{ ...artifact, url: link(publicUrl, entry) }] : []))
    .filter((artifact) => words.every((word) => [artifact.name, artifact.project ?? "", artifact.task ?? ""].some((field) => field.includes(word))))
    .sort((a, b) => b.created.localeCompare(a.created))
  return { artifacts: matches.slice(0, input.limit ?? 50), total: matches.length }
}

/** Deletes one artifact by its link: a file, or every file of a page. Refuses anything outside the layout. */
export async function remove(url: string, context: Omit<ArtifactContext, "paths" | "now">): Promise<{ url: string; deleted: number }> {
  const { publicUrl } = settings(context.config)
  const fix = "give a link that ntncode artifact publish or list returned"
  if (!url.startsWith(`${publicUrl}/`)) throw new ArtifactError(`${url} is not in the artifacts bucket`, fix)
  let key: string
  try {
    key = decodeURIComponent(new URL(url).pathname.slice(new URL(`${publicUrl}/`).pathname.length))
  } catch {
    throw new ArtifactError(`${url} is not a valid link`, fix)
  }
  const place = locate(key)
  if (!place) throw new ArtifactError(`${url} is not an artifact's link`, fix)
  const objects = await context.bucket.list(place.page ? `${place.root}/` : place.root).catch((error) => Promise.reject(bucketError("delete", error)))
  const keys = objects.map((object) => object.key).filter((entry) => (place.page ? entry.startsWith(`${place.root}/`) : entry === place.root))
  if (!keys.length) throw new ArtifactError(`${url} is already deleted`, fix)
  // index.html last for a page, so a delete that stops halfway leaves its link working and can be run again.
  keys.sort((a, b) => Number(a.endsWith("/index.html")) - Number(b.endsWith("/index.html")))
  try {
    for (const entry of keys) await context.bucket.delete(entry)
  } catch (error) {
    throw bucketError("delete", error)
  }
  return { url, deleted: keys.length }
}
