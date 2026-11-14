import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import type { Paths } from "../shared/config.ts"
import type { Check } from "../shared/module.ts"

/** The agents an automation can run on, by the names the Notion Agent property uses. */
export const AgentName = z.enum(["Claude Code", "Codex", "OpenCode"])
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
  env?: Record<string, string>
  onStart?: (pid: number) => void
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
}

/** An agent: where it is, how to run one prompt headless and unattended, and what `doctor` checks. */
export interface Agent {
  name: AgentName
  /** The executable, or null when it isn't installed. */
  binary(paths: Paths): string | null
  /** Why this model can't run on the agent, or null when it can. */
  modelError(model: string | null): string | null
  run(paths: Paths, input: AgentRunInput): Promise<AgentRunOutput>
  /** `required` are the MCP servers every agent must have, from the config. */
  checks(paths: Paths, required: string[]): Promise<Check[]>
  /**
   * Environment variables the agent needs to sign in when it runs unattended, read from its own config. Each entry is
   * satisfied by any one of its names. `doctor` checks them against the scheduler's environment.
   */
  envNeeds(paths: Paths): { names: string[]; why: string }[]
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
