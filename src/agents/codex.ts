import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import type { Paths } from "../shared/config.ts"
import type { Check } from "../shared/module.ts"
import { runCommand } from "../shared/process.ts"
import { findBinary, mcpChecks, oneLine, type Agent, type McpServer } from "./agent.ts"
import { failureDetails } from "./failure.ts"
import type { Link } from "./links.ts"

/** Codex reads ~/.agents/skills itself; its global instructions file is ~/.codex/AGENTS.md. */
export function codexLinks(paths: Paths): Link[] {
  return [{ link: path.join(paths.home, ".codex/AGENTS.md"), target: path.join(paths.agents, "AGENTS.md") }]
}

/**
 * Codex reads AGENTS.md files only from the project root down, and finds the root by the nearest marker. With
 * `project_root_markers = ["notion.json"]`, a project folder's AGENTS.md reaches chats opened in its repositories.
 */
export function codexChecks(paths: Paths): Check[] {
  const file = path.join(paths.home, ".codex/config.toml")
  const name = "~/.codex/config.toml"
  if (!fs.existsSync(file)) return [{ ok: false, level: "warning", name, detail: "missing; Codex isn't set up here" }]
  // Top-level keys come before the first [table].
  const top = fs.readFileSync(file, "utf8").split(/^\s*\[/mu)[0]!
  const markers = top.match(/^\s*project_root_markers\s*=\s*\[([^\]]*)\]/mu)?.[1]
  const ok = !!markers && /["']notion\.json["']/u.test(markers)
  return ok
    ? [{ ok, name, detail: 'project_root_markers includes "notion.json"' }]
    : [{ ok, level: "error", name, detail: "project_root_markers lacks notion.json", fix: 'add project_root_markers = ["notion.json"] before any [table]' }]
}

const CodexServer = z.looseObject({ name: z.string(), enabled: z.boolean(), auth_status: z.string().nullable().optional() })

/** `codex mcp list --json`. */
export function parseCodexMcp(output: string): McpServer[] {
  return z
    .array(CodexServer)
    .parse(JSON.parse(output))
    .map((server): McpServer => ({
      name: server.name,
      state: !server.enabled ? "disabled" : server.auth_status === "not_logged_in" ? "login" : server.auth_status === "o_auth" || server.auth_status === "logged_in" ? "connected" : "configured",
    }))
}

const CodexEvent = z.looseObject({
  type: z.string(),
  thread_id: z.string().optional(),
  item: z.looseObject({ type: z.string(), text: z.string().optional() }).optional(),
  error: z.unknown().optional(),
  message: z.string().optional(),
  usage: z.looseObject({ input_tokens: z.number().optional(), cached_input_tokens: z.number().optional(), output_tokens: z.number().optional() }).optional(),
})

/** Codex's effort levels stop at xhigh. */
const codexEffort = (effort: string) => (effort === "max" ? "xhigh" : effort)

const binary = (paths: Paths) => findBinary("codex", [path.join(paths.home, ".local/bin"), path.join(paths.home, ".npm-global/bin")])

export const codex: Agent = {
  name: "Codex",
  binary,
  settingsError: (model) => (model && /\s/u.test(model) ? "Model: a Codex model is one word, such as gpt-6.1-sol" : null),

  async run(paths, input) {
    const bin = binary(paths)
    if (!bin) return { ok: false, reply: "", session: null, resume: null, usage: null, error: "Codex (codex) isn't installed" }
    const args = ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-C", input.directory]
    if (input.model) args.push("-m", input.model)
    if (input.effort) args.push("-c", `model_reasoning_effort="${codexEffort(input.effort)}"`)
    args.push("-")
    const result = await runCommand(bin, args, { cwd: input.directory, input: input.prompt, env: input.env, onStart: input.onStart })
    let session: string | null = null
    let reply = ""
    let failure: string | null = null
    let usage: { input: number; cached: number; output: number; costUsd: null } | null = null
    let failedEvent: string | null = null
    for (const line of result.stdout.split("\n")) {
      if (!line.trim()) continue
      let event: z.infer<typeof CodexEvent>
      try {
        const parsed = CodexEvent.safeParse(JSON.parse(line))
        if (!parsed.success) continue
        event = parsed.data
      } catch {
        continue
      }
      if (event.type === "thread.started" && event.thread_id) session = event.thread_id
      if (event.type === "item.completed" && event.item?.type === "agent_message") reply = event.item.text ?? ""
      // Codex counts cached tokens inside input_tokens, and gives no cost.
      if (event.type === "turn.completed" && event.usage) {
        usage ??= { input: 0, cached: 0, output: 0, costUsd: null }
        usage.input += event.usage.input_tokens ?? 0
        usage.cached += event.usage.cached_input_tokens ?? 0
        usage.output += event.usage.output_tokens ?? 0
      }
      if (event.type === "turn.failed" || event.type === "error") {
        const message = event.message ?? (event.error as { message?: unknown } | undefined)?.message
        failure = oneLine(typeof message === "string" ? message : JSON.stringify(event.error ?? event))
        failedEvent = line
      }
    }
    const resume = session ? `cd ${input.directory} && codex resume ${session}` : null
    const ok = result.code === 0 && !failure && !!session
    const stderr = oneLine(result.stderr.split("\n").filter((line) => !/rmcp::transport/u.test(line)).join(" "))
    const details = ok ? null : failureDetails(result, { event: failedEvent, "last reply": reply ? oneLine(reply, 1_000) : null })
    return { ok, reply, session, resume, usage, details, error: ok ? null : `Codex failed: ${failure ?? result.error ?? (stderr || `exit code ${result.code}`)}` }
  },

  envNeeds(paths) {
    const file = path.join(paths.home, ".codex/config.toml")
    if (!fs.existsSync(file)) return []
    const text = fs.readFileSync(file, "utf8")
    const provider = text.split(/^\s*\[/mu)[0]!.match(/^\s*model_provider\s*=\s*"([^"]+)"/mu)?.[1]
    if (!provider) return []
    const table = text.split(new RegExp(`^\\s*\\[model_providers\\.${provider.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\]\\s*$`, "mu"))[1]?.split(/^\s*\[/mu)[0] ?? ""
    const key = table.match(/^\s*env_key\s*=\s*"([^"]+)"/mu)?.[1]
    return key ? [{ names: [key], why: `~/.codex/config.toml's provider ${provider} reads its key from ${key}` }] : []
  },

  async checks(paths, required) {
    const bin = binary(paths)
    if (!bin) return [{ ok: false, level: "warning", name: "Codex", detail: "not installed", fix: "install Codex: https://developers.openai.com/codex" }]
    const version = await runCommand(bin, ["--version"], { timeoutMs: 30_000 })
    const list = await runCommand(bin, ["mcp", "list", "--json"], { timeoutMs: 60_000, cwd: paths.home })
    let servers: McpServer[] | string
    try {
      servers = list.code === 0 ? parseCodexMcp(list.stdout) : oneLine(list.error ?? list.stderr)
    } catch (error) {
      servers = `unexpected output (${(error as Error).message})`
    }
    return [
      { ok: version.code === 0, name: "Codex", detail: version.code === 0 ? version.stdout.trim() : "installed, but --version failed" },
      ...codexChecks(paths),
      ...mcpChecks("Codex", servers, required, {
        add: (name) => (name === "executor" ? "codex mcp add executor -- executor mcp" : name === "notion" ? "codex mcp add notion --url https://mcp.notion.com/mcp" : `codex mcp add ${name} …`),
        login: (name) => `codex mcp login ${name}`,
      }),
    ]
  },
}
