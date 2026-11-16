import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import type { Paths } from "../shared/config.ts"
import type { Check } from "../shared/module.ts"

/** The agents an automation can run on, by the names the Notion Agent property uses. */
export const AgentName = z.enum(["Claude Code", "Codex", "OpenCode", "T3 Code", "Zeron"])
export type AgentName = z.infer<typeof AgentName>

/** Reasoning effort, by the names the Notion Effort property uses, lowercased. Each agent maps it to its own levels. */
export const Effort = z.enum(["low", "medium", "high", "xhigh", "max"])
export type Effort = z.infer<typeof Effort>

export interface AgentRunInput {
  prompt: string
  /** The folder the agent works in. */
  directory: string
  model: string | null
  effort: Effort | null
  /** The session's display name, where the agent has one. */
  title: string
  /** Added to, or with undefined removed from, the scheduler's environment. */
  env?: Record<string, string | undefined>
  onStart?: (pid: number) => void
  /** A daemon-owned session is recorded before work starts, so a scheduler restart can stop it. */
  onSession?: (session: string) => void
  signal?: AbortSignal
}

export interface AgentRunOutput {
  ok: boolean
  /** The agent's final reply: the run's report. */
  reply: string
  /** The agent's own session ID. */
  session: string | null
  /** A command that opens the session again. */
  resume: string | null
  /** Why it failed, in one line. */
  error: string | null
  /** What the run used, as the agent reports it; null when it reported nothing. */
  usage: Usage | null
  /** For a failure, the raw context: exit code, the agent's own error fields, the end of its stderr; secrets masked. */
  details?: string | null
}

/** Hosted apps keep their own environment. Give alerts their run identity without copying scheduler credentials. */
export function hostedPrompt(input: AgentRunInput): string {
  const names = ["NTNCODE_AUTOMATION", "NTNCODE_AUTOMATION_TITLE", "NTNCODE_AUTOMATION_URL", "NTNCODE_DIRECTORY", "NTNCODE_RUN", "NTNCODE_RUN_URL"]
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
  const values = names.flatMap((name) => input.env?.[name] === undefined ? [] : [quote(`${name}=${input.env[name]}`)])
  if (!values.length) return input.prompt
  return `${input.prompt}\n\n<hosted-run-context>\nThis app runs the agent in its daemon's environment. When calling ntncode alert, prefix the command with the following exact environment assignments so the alert belongs to this automation run:\n\nenv ${values.join(" ")} ntncode alert "<message>"\n</hosted-run-context>`
}

/** A hosted agent inherits its daemon's environment, rather than the sanitized bridge environment. */
export function assertHostedEnvironment(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Couldn't identify the local app's engine process")
  if (process.platform !== "linux") throw new Error("Hosted daemon environment verification currently requires Linux")
  let names: string[]
  try {
    names = fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").map((entry) => entry.split("=", 1)[0]!)
  } catch {
    throw new Error("Couldn't verify the local app engine's environment")
  }
  if (names.includes("NOTION_ACCESS_TOKEN")) throw new Error("The local app engine has NOTION_ACCESS_TOKEN in its environment; remove it from that service before running automations")
}

/**
 * Tokens and cost of a run. `input` counts every prompt token, cached or not; `cached` is the part read from the
 * prompt cache. `costUsd` is the agent's own estimate at list prices, null when it gives none.
 */
export interface Usage {
  input: number
  cached: number
  output: number
  costUsd: number | null
}

/** An agent: where it is, how to run one prompt headless and unattended, and what `doctor` checks. */
export interface Agent {
  name: AgentName
  /** The executable, or null when it isn't installed. */
  binary(paths: Paths): string | null
  /** Why the agent can't run this model and effort, led by the property to fix (`Model: …`), or null when it can. */
  settingsError(model: string | null, effort: Effort | null): string | null
  run(paths: Paths, input: AgentRunInput): Promise<AgentRunOutput>
  /** Stops an existing daemon-owned session. Must be safe to repeat after a restart. */
  cancel?(paths: Paths, session: string): Promise<void>
  /** `required` are the MCP servers every agent must have, from the config. */
  checks(paths: Paths, required: string[]): Promise<Check[]>
  /**
   * Environment variables the agent needs to sign in when it runs unattended, read from its own config. Each entry is
   * satisfied by any one of its names. `doctor` checks them against the scheduler's environment.
   */
  envNeeds(paths: Paths): { names: string[]; why: string }[]
}

/**
 * A Model property option as the agents name it: "Opus 5.5" is claude-opus-5-5, "GPT-6.1 Sol" is gpt-6.1-sol.
 * Anything else, such as an ID written out, passes through as it is.
 */
export function modelId(name: string): string {
  const claude = name.match(/^(Opus|Sonnet|Haiku|Fable) (\d+)\.(\d+)$/u)
  if (claude) return `claude-${claude[1]!.toLowerCase()}-${claude[2]}-${claude[3]}`
  if (/^GPT-\S+( \S+)*$/u.test(name)) return name.toLowerCase().replace(/\s+/gu, "-")
  return name
}

/** The first executable of this name on PATH or in the extra folders. */
export function findBinary(name: string, extra: string[]): string | null {
  for (const folder of [...(process.env.PATH ?? "").split(":"), ...extra]) {
    if (!folder) continue
    const file = path.join(folder, name)
    try {
      fs.accessSync(file, fs.constants.X_OK)
      return file
    } catch {}
  }
  return null
}

/** The last line of an error, cut to a readable length. */
export function oneLine(text: string, max = 400): string {
  const flat = text.replace(/\s+/gu, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** One MCP server's state, as each agent reports it. */
export interface McpServer {
  name: string
  /** `connected` works; `login` needs a sign-in; `failed` can't connect; `configured` is set up but wasn't probed. */
  state: "connected" | "login" | "failed" | "configured" | "disabled"
}

/** The doctor lines for an agent's MCP servers: each required one must be there and signed in. */
export function mcpChecks(agent: AgentName, servers: McpServer[] | string, required: string[], fixes: { add: (name: string) => string; login: (name: string) => string }): Check[] {
  if (typeof servers === "string") return [{ ok: false, level: "error", name: `${agent} MCP`, detail: `couldn't list its MCP servers: ${servers}` }]
  return required.map((name): Check => {
    const server = servers.find((entry) => entry.name === name)
    const label = `${agent} MCP ${name}`
    if (!server) return { ok: false, level: "error", name: label, detail: "not configured", fix: fixes.add(name) }
    if (server.state === "login") return { ok: false, level: "error", name: label, detail: "configured, not signed in", fix: fixes.login(name) }
    if (server.state === "failed") return { ok: false, level: "error", name: label, detail: "configured, but it can't connect", fix: fixes.login(name) }
    if (server.state === "disabled") return { ok: false, level: "error", name: label, detail: "configured but disabled", fix: fixes.add(name) }
    return { ok: true, name: label, detail: server.state === "connected" ? "connected" : "configured" }
  })
}
