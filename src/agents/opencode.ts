import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import type { Paths } from "../shared/config.ts"
import type { Check } from "../shared/module.ts"
import { runCommand } from "../shared/process.ts"
import { findBinary, mcpChecks, oneLine, type Agent, type McpServer } from "./agent.ts"
import { failureDetails } from "./failure.ts"
import type { Link } from "./links.ts"

/** OpenCode reads ~/.agents/skills and project AGENTS.md files itself; its global instructions file is in its config folder. */
export function openCodeLinks(paths: Paths): Link[] {
  const folder = path.join(paths.home, ".config/opencode")
  if (!fs.existsSync(folder)) return []
  return [{ link: path.join(folder, "AGENTS.md"), target: path.join(paths.agents, "AGENTS.md") }]
}

/** `opencode mcp list` lines: `✓ name  connected`. */
export function parseOpenCodeMcp(output: string): McpServer[] {
  const servers: McpServer[] = []
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*\S+\s+(\S+)\s+(.+?)\s*$/u)
    if (!match || /^No MCP/u.test(line.trim())) continue
    const status = match[2]!
    servers.push({ name: match[1]!, state: /connected/iu.test(status) ? "connected" : /auth/iu.test(status) ? "login" : /disabled/iu.test(status) ? "disabled" : "failed" })
  }
  return servers
}

const OpenCodeEvent = z.looseObject({
  type: z.string(),
  sessionID: z.string().optional(),
  part: z
    .looseObject({
      type: z.string(),
      messageID: z.string().optional(),
      text: z.string().optional(),
      cost: z.number().optional(),
      tokens: z.looseObject({ input: z.number().optional(), output: z.number().optional(), cache: z.looseObject({ read: z.number().optional(), write: z.number().optional() }).optional() }).optional(),
    })
    .optional(),
  error: z.unknown().optional(),
})

/**
 * OpenCode names a model provider/model. The Model property holds one list of names for every agent, so the provider
 * is added for the families whose provider is clear: claude-* is Anthropic's, gpt-* is OpenAI's. Null when unclear.
 */
export function openCodeModel(model: string): string | null {
  if (/^[\w.-]+\/[\w.:-]+$/u.test(model)) return model
  if (/^claude-[\w.-]+$/u.test(model)) return `anthropic/${model}`
  if (/^gpt-[\w.-]+$/u.test(model)) return `openai/${model}`
  return null
}

const binary = (paths: Paths) => findBinary("opencode", [path.join(paths.home, ".opencode/bin"), path.join(paths.home, ".local/bin")])

export const openCode: Agent = {
  name: "OpenCode",
  binary,
  settingsError(model, effort) {
    if (model && !openCodeModel(model)) return "Model: OpenCode needs provider/model, such as anthropic/claude-opus-5-5, for a model that isn't claude-* or gpt-*"
    // OpenCode sets effort as the model's variant, so it needs a model.
    if (effort && !model) return "Effort: OpenCode sets effort through the model, so set Model too"
    return null
  },

  async run(paths, input) {
    const bin = binary(paths)
    if (!bin) return { ok: false, reply: "", session: null, resume: null, usage: null, error: "OpenCode (opencode) isn't installed" }
    // A private OpenCode (--standalone), because the background service ignores the caller's folder.
    const args = ["run", "--standalone", "--format", "json", "--auto", "--title", input.title]
    const model = input.model ? openCodeModel(input.model) : null
    if (model) args.push("-m", input.effort ? `${model}#${input.effort}` : model)
    const result = await runCommand(bin, args, { cwd: input.directory, input: input.prompt, env: input.env, onStart: input.onStart })
    let session: string | null = null
    const texts = new Map<string, string[]>()
    let lastMessage: string | null = null
    let failure: string | null = null
    let usage: { input: number; cached: number; output: number; costUsd: number | null } | null = null
    let failedEvent: string | null = null
    for (const line of result.stdout.split("\n")) {
      if (!line.trim()) continue
      let event: z.infer<typeof OpenCodeEvent>
      try {
        const parsed = OpenCodeEvent.safeParse(JSON.parse(line))
        if (!parsed.success) continue
        event = parsed.data
      } catch {
        continue
      }
      session ??= event.sessionID ?? null
      if (event.type === "text" && event.part?.text && event.part.messageID) {
        texts.set(event.part.messageID, [...(texts.get(event.part.messageID) ?? []), event.part.text])
        lastMessage = event.part.messageID
      }
      if (event.type === "error") {
        const error = event.error as { message?: unknown; data?: { message?: unknown } } | undefined
        const message = error?.data?.message ?? error?.message
        failure = oneLine(typeof message === "string" ? message : JSON.stringify(event.error ?? event))
        failedEvent = line
      }
      // Each step reports its own tokens and cost; OpenCode counts cache reads and writes apart from input.
      if (event.type === "step_finish" && event.part?.tokens) {
        const tokens = event.part.tokens
        usage ??= { input: 0, cached: 0, output: 0, costUsd: null }
        usage.input += (tokens.input ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0)
        usage.cached += tokens.cache?.read ?? 0
        usage.output += tokens.output ?? 0
        if (event.part.cost !== undefined) usage.costUsd = (usage.costUsd ?? 0) + event.part.cost
      }
    }
    const reply = lastMessage ? texts.get(lastMessage)!.join("\n") : ""
    const resume = session ? `cd ${input.directory} && opencode --session ${session}` : null
    const ok = result.code === 0 && !failure && !!session
    const details = ok ? null : failureDetails(result, { event: failedEvent })
    return { ok, reply, session, resume, usage, details, error: ok ? null : `OpenCode failed: ${failure ?? result.error ?? (oneLine(result.stderr) || `exit code ${result.code}`)}` }
  },

  envNeeds(paths) {
    const file = path.join(paths.home, ".config/opencode/opencode.jsonc")
    if (!fs.existsSync(file)) return []
    const text = fs.readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gmu, "")
    return [...new Set([...text.matchAll(/\{env:([A-Z0-9_]+)\}/gu)].map((match) => match[1]!))].map((name) => ({ names: [name], why: `~/.config/opencode/opencode.jsonc reads {env:${name}}` }))
  },

  async checks(paths, required) {
    const bin = binary(paths)
    if (!bin) return []
    const checks: Check[] = []
    const version = await runCommand(bin, ["--version"], { timeoutMs: 30_000 })
    checks.push({ ok: version.code === 0, name: "OpenCode", detail: version.code === 0 ? version.stdout.trim() : "installed, but --version failed" })
    const list = await runCommand(bin, ["mcp", "list"], { timeoutMs: 60_000, cwd: paths.home })
    checks.push(
      ...mcpChecks("OpenCode", list.code === 0 ? parseOpenCodeMcp(list.stdout) : oneLine(list.error ?? list.stderr), required, {
        add: (name) => `add "${name}" under "mcp" in ~/.config/opencode/opencode.jsonc`,
        login: (name) => `opencode mcp auth ${name}`,
      }),
    )
    return checks
  },
}
