import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { parsePageId, readSecret, type Config, type Paths } from "../shared/config.ts"

/**
 * Artifacts are files published to a public bucket, each at a link that never expires. A file is stored as it is; a
 * folder is a page, and its link opens its index.html. Everything one publish stores sits under its own folder,
 * `<project or shared>/<YYYY-MM>/<16 random hex>/`, with a `.artifact.json` that says what it is and who made it.
 */

/** The few bucket calls publishing needs. The CLI uses Bun's S3 client; tests pass their own. */
export interface Bucket {
  write(key: string, body: Blob, type: string): Promise<void>
  list(prefix: string): Promise<string[]>
  delete(key: string): Promise<void>
}

/** Where a published file's metadata lives, beside its files. Dot-files are never published, so it can't collide. */
export const MANIFEST = ".artifact.json"

/** The access key every bucket call is signed with, read like the Notion token. */
export const KEY_NAMES = ["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const

const MAX_BYTES = 100 * 1024 * 1024
const MAX_FILES = 1_000
const SCOPE = /^[\w][\w.-]*$/u
const FOLDER = /^([\w][\w.-]*)\/(\d{4}-\d{2})\/([0-9a-f]{16})\//u

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
  title?: string
  /** A folder directly under the projects folder. */
  project?: string
  /** The owning Notion task, as an ID or link. */
  task?: string
}

/** What `.artifact.json` holds, and what publishing returns with the link. */
export interface Manifest {
  title: string
  project: string | null
  task: string | null
  automation: string | null
  run: string | null
  created: string
  /** The file the link opens. */
  entry: string
  type: string
  bytes: number
  files: string[]
}

export interface Published extends Manifest {
  url: string
}

export interface PublishContext {
  paths: Paths
  config: Config
  bucket: Bucket
  now: Date
  env?: Record<string, string | undefined>
}

/** The configured bucket, or an error saying what to set. */
export function settings(config: Config) {
  if (config.artifacts) return config.artifacts
  throw new ArtifactError("no bucket configured for artifacts", 'set "artifacts": { "bucketUrl": "<S3 endpoint>/<bucket>", "publicUrl": "<public address>" } in the config')
}

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
      const keys: string[] = []
      let continuationToken: string | undefined
      do {
        const page = await client.list({ prefix, ...(continuationToken ? { continuationToken } : {}) })
        keys.push(...(page.contents ?? []).map((entry) => entry.key))
        continuationToken = page.isTruncated ? page.nextContinuationToken : undefined
      } while (continuationToken)
      return keys
    },
    delete: (key) => client.delete(key),
  }
}

/** The files to publish, as paths relative to the source, refusing what must never go public by accident. */
function collect(source: string): { root: string; files: string[]; entry: string } {
  const stats = fs.lstatSync(source, { throwIfNoEntry: false })
  if (!stats) throw new ArtifactError(`${source} does not exist`, "give the path of a file, or of a folder with an index.html")
  if (stats.isSymbolicLink()) throw new ArtifactError(`${source} is a link`, "give the file or folder it points to")
  const name = path.basename(source)
  if (name.startsWith(".")) throw new ArtifactError(`${name} is a dot-file, and dot-files are never published`, "rename it, or publish the files it holds")
  if (stats.isFile()) return { root: path.dirname(source), files: [name], entry: name }
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
  return { root: source, files: files.sort(), entry: "index.html" }
}

/** A project folder's name, checked against the projects folder; null for none. */
function project(paths: Paths, value: string | undefined): string | null {
  if (value === undefined) return null
  const known = fs.existsSync(paths.projects) ? fs.readdirSync(paths.projects, { withFileTypes: true }).filter((entry) => entry.isDirectory() && SCOPE.test(entry.name)).map((entry) => entry.name) : []
  if (!known.includes(value)) throw new ArtifactError(`no project "${value}"`, `give a folder name under the projects folder: ${known.sort().join(", ") || "(none)"}`)
  return value
}

/** The public link to a key, each part encoded. */
function link(publicUrl: string, key: string): string {
  return `${publicUrl}/${key.split("/").map(encodeURIComponent).join("/")}`
}

export async function publish(input: PublishInput, context: PublishContext): Promise<Published> {
  const { publicUrl } = settings(context.config)
  const env = context.env ?? process.env
  const source = path.resolve(input.source)
  const scope = project(context.paths, input.project)
  const task = input.task === undefined ? null : parsePageId(input.task)
  if (input.task !== undefined && !task) throw new ArtifactError(`"${input.task}" is not a Notion task`, "give the task's Notion link or page ID")
  const title = (input.title ?? path.basename(source)).trim()
  if (!title || title.length > 200) throw new ArtifactError("the title must be 1 to 200 characters", "give a shorter --title")
  const { root, files, entry } = collect(source)
  const blobs = files.map((file) => Bun.file(path.join(root, file)))
  const bytes = blobs.reduce((sum, blob) => sum + blob.size, 0)
  if (bytes > MAX_BYTES) throw new ArtifactError(`${Math.round(bytes / 1024 / 1024)} MiB is over the ${MAX_BYTES / 1024 / 1024} MiB limit`, "publish a smaller file, such as a compressed video")
  const typeOf = (blob: Blob) => blob.type || "application/octet-stream"
  const folder = `${scope ?? "shared"}/${context.now.toISOString().slice(0, 7)}/${crypto.randomBytes(8).toString("hex")}/`
  const manifest: Manifest = {
    title,
    project: scope,
    task,
    automation: env.NTNCODE_AUTOMATION || null,
    run: env.NTNCODE_RUN || null,
    created: context.now.toISOString(),
    entry,
    type: typeOf(blobs[files.indexOf(entry)]!),
    bytes,
    files,
  }
  // The files first and the manifest last, so a folder with a manifest is always complete.
  const written: string[] = []
  try {
    for (const [index, file] of files.entries()) {
      await context.bucket.write(folder + file, blobs[index]!, typeOf(blobs[index]!))
      written.push(folder + file)
    }
    await context.bucket.write(folder + MANIFEST, new Blob([`${JSON.stringify(manifest, null, 2)}\n`]), "application/json")
  } catch (error) {
    // Take back what went up, so a failed publish leaves nothing public that delete would refuse.
    const left: string[] = []
    for (const key of [...written, folder + MANIFEST]) await context.bucket.delete(key).catch(() => left.push(key))
    const stranded = left.filter((key) => written.includes(key))
    const detail = stranded.length ? `; these files are still public: ${stranded.map((key) => link(publicUrl, key)).join(", ")}` : "; nothing was left public"
    throw new ArtifactError(`the bucket refused the upload: ${(error as Error).message}${detail}`, "check the access key and the bucketUrl in the config, then publish again", false)
  }
  return { url: link(publicUrl, folder + entry), ...manifest }
}

/** Deletes everything one publish stored, by any of its links. Refuses anything else in the bucket. */
export async function remove(url: string, context: Omit<PublishContext, "now" | "paths" | "env">): Promise<{ url: string; deleted: number }> {
  const { publicUrl } = settings(context.config)
  const fix = "give a link that ntncode artifact publish returned"
  if (!url.startsWith(`${publicUrl}/`)) throw new ArtifactError(`${url} is not in the artifacts bucket`, fix)
  let key: string
  try {
    key = decodeURIComponent(new URL(url).pathname.slice(new URL(`${publicUrl}/`).pathname.length))
  } catch {
    throw new ArtifactError(`${url} is not a valid link`, fix)
  }
  const folder = key.match(FOLDER)?.[0]
  if (!folder) throw new ArtifactError(`${url} is not an artifact's link`, fix)
  const bucketError = (error: unknown) => new ArtifactError(`the bucket refused the delete: ${(error as Error).message}`, "check the access key and the bucketUrl in the config, then delete again", false)
  const keys = await context.bucket.list(folder).catch((error) => Promise.reject(bucketError(error)))
  if (!keys.includes(folder + MANIFEST)) throw new ArtifactError(`${url} was not published by ntncode artifact, or is already deleted`, fix)
  // The manifest last, so a delete that stops halfway can be run again.
  try {
    for (const entry of [...keys.filter((entry) => entry !== folder + MANIFEST), folder + MANIFEST]) await context.bucket.delete(entry)
  } catch (error) {
    throw bucketError(error)
  }
  return { url, deleted: keys.length - 1 }
}
