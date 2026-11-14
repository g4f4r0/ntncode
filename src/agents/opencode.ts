import { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import type { Paths } from "../shared/config.ts"
import type { Check } from "../shared/module.ts"
import { runCommand } from "../shared/process.ts"
import { findBinary, mcpChecks, oneLine, type Agent, type McpServer } from "./agent.ts"
import { failureDetails } from "./failure.ts"
import type { Link } from "./links.ts"

/**
 * OpenCode reads ~/.agents/skills and project AGENTS.md files itself; its global instructions file is in its config
 * folder. While its Notion plugin (opencode-notion) is configured, that plugin adds the same instructions to every
 * session, so the link waits until the plugin is removed.
 */
export function openCodeLinks(paths: Paths): Link[] {
  const folder = path.join(paths.home, ".config/opencode")
  if (!fs.existsSync(folder) || retiredPlugins(paths).includes("opencode-notion")) return []
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

/** OpenCode's plugins that Notion Code replaces, still in its config. */
function retiredPlugins(paths: Paths): string[] {
  const file = path.join(paths.home, ".config/opencode/opencode.jsonc")
  if (!fs.existsSync(file)) return []
  // Comments may mention a plugin; only quoted strings outside comments count.
  const text = fs.readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gmu, "")
  return ["opencode-notion", "opencode-automations"].filter((name) => new RegExp(`"[^"]*${name}"`, "u").test(text))
}

/** OpenCode automations that are still enabled: none may also be enabled in Notion. */
function enabledOpenCodeAutomations(paths: Paths): string[] | null {
  const file = path.join(paths.home, ".local/share/opencode-automations/automations.db")
  if (!fs.existsSync(file)) return null
  const db = new Database(file, { readonly: true })
  try {
    return (db.query("select name from automations where enabled = 1 order by name").all() as { name: string }[]).map((row) => row.name)
  } finally {
    db.close()
  }
}

export const openCode: Agent = {
  name: "OpenCode",
  binary,
  modelError: (model) => (model && !openCodeModel(model) ? "OpenCode needs provider/model, such as anthropic/claude-opus-5-5, for a model that isn't claude-* or gpt-*" : null),

  async run(paths, input) {
    const bin = binary(paths)
    if (!bin) return { ok: false, reply: "", session: null, resume: null, usage: null, error: "OpenCode (opencode) isn't installed" }
    // A run gets a private OpenCode (--standalone), because the background service ignores the caller's folder. A
    // private OpenCode loads every plugin, and opencode-automations has no lock, so it could fire its own automations
    // a second time: refuse until it's removed.
    if (retiredPlugins(paths).includes("opencode-automations")) {
      return { ok: false, reply: "", session: null, resume: null, usage: null, error: "OpenCode runs need opencode-automations removed from ~/.config/opencode/opencode.jsonc first; a private OpenCode would also start its scheduler" }
    }
    const args = ["run", "--standalone", "--format", "json", "--auto", "--title", input.title]
    // OpenCode sets effort as the model's variant, so it needs a model.
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
        failure = oneLine(JSON.stringify(event.error ?? event))
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
    for (const plugin of retiredPlugins(paths)) {
      checks.push({
        ok: false,
        level: "warning",
        name: `OpenCode plugin ${plugin}`,
        detail: plugin === "opencode-notion" ? "still configured: it also syncs ~/.agents/skills and OpenCode's instructions, which Notion Code now does" : "still configured: it runs automations, which Notion Code now does",
        fix: `remove it from "plugins" in ~/.config/opencode/opencode.jsonc, then restart OpenCode${plugin === "opencode-notion" ? ". Never turn off its skills toggle instead: that deletes ~/.agents/skills" : ""}`,
      })
    }
    const enabled = enabledOpenCodeAutomations(paths)
    if (enabled?.length) {
      checks.push({
        ok: false,
        level: "warning",
        name: "OpenCode automations",
        detail: `${enabled.length} still enabled: ${enabled.join("; ")}`,
        fix: "move each to Notion and pause it in OpenCode in the same minute; an automation must never be enabled in both",
      })
    }
    return checks
  },
}
