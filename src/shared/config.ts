import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** Where everything lives. Tests pass their own. */
export interface Paths {
  home: string
  /** ~/.agents: the global notion.json, AGENTS.md and skills. */
  agents: string
  /** ~/projects: each direct child folder may hold a notion.json. */
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

/** The installation's settings: what differs between one install and another. */
export interface Config {
  /** The Notion user this installation runs automations for. */
  owner: string | null
}

const KEYS = ["owner"] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/** Reads the config file. A missing file is the default; an unknown key or a bad value is an error, never ignored. */
export function readConfig(file: string): Config {
  if (!fs.existsSync(file)) return { owner: null }
  let value: unknown
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`)
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${file} must be a JSON object`)
  const unknown = Object.keys(value).filter((key) => !(KEYS as readonly string[]).includes(key))
  if (unknown.length) throw new Error(`${file}: unknown key ${unknown.map((key) => `"${key}"`).join(", ")}; allowed: ${KEYS.join(", ")}`)
  const owner = (value as { owner?: unknown }).owner
  if (owner !== undefined && (typeof owner !== "string" || !UUID.test(owner))) throw new Error(`${file}: "owner" must be a Notion user ID`)
  return { owner: owner ?? null }
}

/** NOTION_ACCESS_TOKEN from the environment, else from the secrets file. */
export function readToken(secrets: string): string | null {
  if (process.env.NOTION_ACCESS_TOKEN) return process.env.NOTION_ACCESS_TOKEN.trim()
  if (!fs.existsSync(secrets)) return null
  for (const line of fs.readFileSync(secrets, "utf8").split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?NOTION_ACCESS_TOKEN\s*=\s*(.*?)\s*$/u)
    if (match) return match[1]!.replace(/^(["'])(.*)\1$/u, "$2") || null
  }
  return null
}
