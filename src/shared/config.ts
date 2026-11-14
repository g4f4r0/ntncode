import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { z } from "zod"

/** Where everything lives. Tests pass their own. */
export interface Paths {
  home: string
  /** ~/.agents: the global notion.json, AGENTS.md and skills. */
  agents: string
  /** The projects folder, ~/projects unless the config says otherwise: each direct child may hold a notion.json. */
  projects: string
  /** State, logs and backups. */
  state: string
  /** The installation's config file. */
  config: string
  /** Where NOTION_ACCESS_TOKEN is read from when the environment lacks it. */
  secrets: string
}

export function defaultPaths(home = os.homedir()): Paths {
  return {
    home,
    agents: path.join(home, ".agents"),
    projects: path.join(home, "projects"),
    state: path.join(process.env.XDG_STATE_HOME || path.join(home, ".local/state"), "notion-code"),
    config: path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "notion-code", "config.json"),
    secrets: path.join(home, ".config/secrets.env"),
  }
}

/** A Notion ID, with or without dashes, returned in its dashed lowercase form. */
export const NotionId = z
  .string()
  .regex(/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/iu, "must be a Notion ID (32 hex digits, dashes optional)")
  .transform(dashed)

/** A Notion ID in its dashed lowercase form. */
export function dashed(value: string): string {
  const id = value.replaceAll("-", "").toLowerCase()
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`
}

/** A Notion page ID from an ID or a link, in its dashed form; null when there is none. */
export function parsePageId(value: unknown): string | null {
  if (typeof value !== "string") return null
  // A link's ?v= is a view and #… a block: only the path names the page. An ID must stand alone, so a title slug
  // ending in a hex letter ("Acme-<id>") does not run into it.
  const text = value.trim().toLowerCase().split(/[?#]/u)[0]!
  const matches = text.match(/(?<![0-9a-f])(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-f])/gu)
  const id = matches?.at(-1)?.replaceAll("-", "")
  return id ? `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}` : null
}

const HttpUrl = z.url({ protocol: /^https?$/u, error: "must be an http(s) URL" }).transform((value) => value.replace(/\/+$/u, ""))

const HomePath = z.string().refine((value) => value.startsWith("/") || value.startsWith("~/"), "must be an absolute path or start with ~/")

/** The config file. Every key is optional; an unknown key or a bad value is an error, never ignored. */
export const ConfigFile = z.strictObject({
  /** The Notion user this installation runs automations for: rows whose Assignee is this person. */
  assignee: NotionId.optional(),
  /** The projects folder, if not ~/projects. */
  projects: HomePath.optional(),
  /** The Notion Skills data source; set it to sync skills to ~/.agents/skills. */
  skills: NotionId.optional(),
  /** The Notion Automations database's two data sources, and the instructions page every run gets. */
  automations: z
    .strictObject({
      automations: NotionId,
      runs: NotionId,
      instructions: NotionId.optional(),
    })
    .optional(),
  /** A shell command run after a run fails, with the details on stdin and in AUTOMATION_* variables. */
  onFailure: z.string().min(1).optional(),
  /** The MCP servers every installed agent must have, signed in; `doctor` checks each. Default: notion. */
  mcp: z.array(z.string().regex(/^[\w.-]+$/u, "must be an MCP server name")).optional(),
  /** The public bucket `ntncode artifact` publishes to: its S3 URL (endpoint and bucket) and where it is served. */
  artifacts: z
    .strictObject({
      bucketUrl: HttpUrl.refine((value) => new URL(value).pathname.split("/").filter(Boolean).length === 1, "must be the S3 endpoint followed by the bucket name, such as https://<account>.r2.cloudflarestorage.com/<bucket>"),
      publicUrl: HttpUrl,
    })
    .optional(),
})

export interface Config {
  assignee: string | null
  projects: string | null
  skills: string | null
  automations: { automations: string; runs: string; instructions: string | null } | null
  onFailure: string | null
  mcp: string[]
  artifacts: { bucketUrl: string; publicUrl: string } | null
}

export const EMPTY_CONFIG: Config = { assignee: null, projects: null, skills: null, automations: null, onFailure: null, mcp: ["notion"], artifacts: null }

/** Zod's issues as one line, each with the key that failed. */
export function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`).join("; ")
}

/** Reads and validates the config file. A missing file is the default. */
export function readConfig(file: string): Config {
  if (!fs.existsSync(file)) return EMPTY_CONFIG
  let value: unknown
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`)
  }
  const parsed = ConfigFile.safeParse(value)
  if (!parsed.success) throw new Error(`${file}: ${describeIssues(parsed.error)}`)
  const config = parsed.data
  return {
    assignee: config.assignee ?? null,
    projects: config.projects ?? null,
    skills: config.skills ?? null,
    automations: config.automations ? { ...config.automations, instructions: config.automations.instructions ?? null } : null,
    onFailure: config.onFailure ?? null,
    mcp: config.mcp ?? EMPTY_CONFIG.mcp,
    artifacts: config.artifacts ?? null,
  }
}

/** `~/x` as an absolute path in this home. */
export function expandHome(home: string, value: string): string {
  return value.startsWith("~/") ? path.join(home, value.slice(2)) : value
}

/** The paths with the config applied: a projects folder it names replaces ~/projects. */
export function withConfig(paths: Paths, config: Config): Paths {
  if (!config.projects) return paths
  return { ...paths, projects: path.resolve(expandHome(paths.home, config.projects)) }
}

/** NOTION_ACCESS_TOKEN from the environment, else from the secrets file. */
export function readToken(secrets: string): string | null {
  return readSecret(secrets, "NOTION_ACCESS_TOKEN")
}

/** A secret from the environment, else from the secrets file; null when neither has it. */
export function readSecret(secrets: string, name: string): string | null {
  if (process.env[name]) return process.env[name].trim()
  if (!fs.existsSync(secrets)) return null
  for (const line of fs.readFileSync(secrets, "utf8").split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u)
    if (match?.[1] === name) return match[2]!.replace(/^(["'])(.*)\1$/u, "$2") || null
  }
  return null
}
