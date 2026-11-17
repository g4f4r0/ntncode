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

const HttpUrl = z.url({ protocol: /^https?$/u, error: "must be an http(s) URL" }).transform((value) => value.replace(/\/+$/u, ""))

const HomePath = z.string().refine((value) => value.startsWith("/") || value.startsWith("~/"), "must be an absolute path or start with ~/")

const Enabled = z.boolean().optional()

/** Each part of Notion Code; `"enabled": false` in its section turns it off and keeps its other settings. */
export const SECTIONS = ["instructions", "skills", "agents", "automations", "artifacts"] as const
export type Section = (typeof SECTIONS)[number]

/** Each agent's key under `agents`, and the name the Notion Agent property uses for it. */
export const AGENT_KEYS = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode", "t3-code": "T3 Code", zeron: "Zeron", capy: "Capy" } as const
export type AgentKey = keyof typeof AGENT_KEYS

const AgentSettings = z.strictObject({ enabled: Enabled })

/** The config file. Every key is optional; an unknown key or a bad value is an error, never ignored. */
export const ConfigFile = z.strictObject({
  /** The Notion user this installation runs automations for: rows whose Assignee is this person. */
  assignee: NotionId.optional(),
  /** The projects folder, if not ~/projects. */
  projects: HomePath.optional(),
  /** The Notion Instructions data source: its Global row, each Project row and its Automations row. */
  instructions: z.strictObject({ enabled: Enabled, source: NotionId.optional() }).optional(),
  /** The Notion Skills data source, synced to ~/.agents/skills. */
  skills: z.strictObject({ enabled: Enabled, source: NotionId }).optional(),
  /** The Notion Automations database's two data sources: the automations and their runs. */
  automations: z.strictObject({ enabled: Enabled, source: NotionId, runs: NotionId }).optional(),
  /** The MCP servers every agent must have, signed in, and each agent's own switch. */
  agents: z
    .strictObject({
      enabled: Enabled,
      /** Default: notion. */
      mcp: z.array(z.string().regex(/^[\w.-]+$/u, "must be an MCP server name")).optional(),
      ...(Object.fromEntries(Object.keys(AGENT_KEYS).map((key) => [key, AgentSettings.optional()])) as Record<AgentKey, z.ZodOptional<typeof AgentSettings>>),
    })
    .optional(),
  /** The public bucket `ntncode artifact` publishes to: its S3 URL (endpoint and bucket) and where it is served. */
  artifacts: z
    .strictObject({
      enabled: Enabled,
      bucketUrl: HttpUrl.refine((value) => new URL(value).pathname.split("/").filter(Boolean).length === 1, "must be the S3 endpoint followed by the bucket name, such as https://<account>.r2.cloudflarestorage.com/<bucket>"),
      publicUrl: HttpUrl,
    })
    .optional(),
  /** A shell command run after a run fails, with the details on stdin and in AUTOMATION_* variables. */
  onFailure: z.string().min(1).optional(),
})

export interface Config {
  assignee: string | null
  projects: string | null
  /** The sections the config turns off. Their settings stay, so the rest still reads them: runs still get the Automations row. */
  off: Section[]
  /** The Instructions data source; null reads each folder's notion.json instead. */
  instructions: string | null
  skills: string | null
  automations: { source: string; runs: string } | null
  agents: { mcp: string[]; off: AgentKey[] }
  artifacts: { bucketUrl: string; publicUrl: string } | null
  onFailure: string | null
}

export const EMPTY_CONFIG: Config = { assignee: null, projects: null, off: [], instructions: null, skills: null, automations: null, agents: { mcp: ["notion"], off: [] }, artifacts: null, onFailure: null }

/** Whether a section runs: on unless the config sets its "enabled" to false. */
export const isOn = (config: Config, section: Section) => !config.off.includes(section)

/** An agent's key under `agents`, from its Notion name: "Claude Code" is claude-code. */
export const agentKey = (name: string) => name.toLowerCase().replaceAll(" ", "-") as AgentKey

/** Whether the config lets this agent run; doctor checks only the agents that are on. */
export const agentOn = (config: Config, name: string) => !config.agents.off.includes(agentKey(name))

/** Zod's issues as one line, each with the key that failed. */
export function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`).join("; ")
}

/** Keys from before 0.4, each with what replaced it, so an old file says exactly what to change. */
function oldKeys(value: unknown): string[] {
  if (!value || typeof value !== "object") return []
  const config = value as Record<string, unknown>
  const automations = config.automations && typeof config.automations === "object" ? (config.automations as Record<string, unknown>) : {}
  return [
    typeof config.skills === "string" && 'skills: now { "source": "<Skills data source ID>" }',
    "automations" in automations && 'automations.automations: now automations.source',
    "instructions" in automations && 'automations.instructions: now the Automations row of instructions.source, { "instructions": { "source": "<Instructions data source ID>" } }',
    "mcp" in config && "mcp: now agents.mcp",
  ].filter((entry): entry is string => !!entry)
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
  const old = oldKeys(value)
  if (old.length) throw new Error(`${file} uses the old layout: ${old.join("; ")}`)
  const parsed = ConfigFile.safeParse(value)
  if (!parsed.success) throw new Error(`${file}: ${describeIssues(parsed.error)}`)
  const config = parsed.data
  const agents = config.agents ?? {}
  return {
    assignee: config.assignee ?? null,
    projects: config.projects ?? null,
    off: SECTIONS.filter((section) => config[section]?.enabled === false),
    instructions: config.instructions?.source ?? null,
    skills: config.skills?.source ?? null,
    automations: config.automations ? { source: config.automations.source, runs: config.automations.runs } : null,
    agents: { mcp: agents.mcp ?? EMPTY_CONFIG.agents.mcp, off: (Object.keys(AGENT_KEYS) as AgentKey[]).filter((key) => agents[key]?.enabled === false) },
    artifacts: config.artifacts ? { bucketUrl: config.artifacts.bucketUrl, publicUrl: config.artifacts.publicUrl } : null,
    onFailure: config.onFailure ?? null,
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
