import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import type { Paths } from "../shared/config.ts"
import { runCommand } from "../shared/process.ts"
import { findBinary, mcpChecks, oneLine, type Agent, type McpServer } from "./agent.ts"
import type { Link } from "./links.ts"

/**
 * Claude Code reads AGENTS.md in a session's folder and its parents, but its global file is ~/.claude/CLAUDE.md and
 * it doesn't read ~/.agents/skills, so both are linked.
 */
export function claudeCodeLinks(paths: Paths): Link[] {
  return [
    { link: path.join(paths.home, ".claude/CLAUDE.md"), target: path.join(paths.agents, "AGENTS.md") },
    { link: path.join(paths.home, ".claude/skills"), target: path.join(paths.agents, "skills") },
  ]
}

/** `claude -p --output-format json`'s final object. */
const ClaudeResult = z.looseObject({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().optional(),
  session_id: z.string(),
})

/** `claude mcp list` lines: `name: url-or-command - ✓ Connected`. */
export function parseClaudeMcp(output: string): McpServer[] {
  const servers: McpServer[] = []
  for (const line of output.split("\n")) {
    const match = line.match(/^([^\s:][^:]*): .* - (.+)$/u)
    if (!match) continue
    const status = match[2]!
    servers.push({
      name: match[1]!.trim(),
      state: /Connected/iu.test(status) ? "connected" : /auth/iu.test(status) ? "login" : /disabled/iu.test(status) ? "disabled" : "failed",
    })
  }
  return servers
}

const binary = (paths: Paths) => findBinary("claude", [path.join(paths.home, ".local/bin"), path.join(paths.home, ".claude/local")])

export const claudeCode: Agent = {
  name: "Claude Code",
  binary,
  modelError: (model) => (model && /\s/u.test(model) ? "a Claude Code model is one word, such as claude-opus-5-5 or opus" : null),

  async run(paths, input) {
    const claude = binary(paths)
    if (!claude) return { ok: false, reply: "", session: null, resume: null, error: "Claude Code (claude) isn't installed" }
    const session = crypto.randomUUID()
    const args = ["-p", "--output-format", "json", "--permission-mode", "bypassPermissions", "--session-id", session, "--name", input.title]
    if (input.model) args.push("--model", input.model)
    if (input.effort) args.push("--effort", input.effort)
    const result = await runCommand(claude, args, { cwd: input.directory, input: input.prompt, env: input.env, onStart: input.onStart })
    const resume = `cd ${input.directory} && claude --resume ${session}`
    const last = result.stdout.trim().split("\n").at(-1) ?? ""
    let parsed: z.infer<typeof ClaudeResult> | null = null
    try {
      const value = ClaudeResult.safeParse(JSON.parse(last))
      if (value.success) parsed = value.data
    } catch {}
    if (!parsed) {
      const why = result.error ?? (oneLine(result.stderr || result.stdout) || `exit code ${result.code}`)
      return { ok: false, reply: "", session, resume, error: `Claude Code returned no result: ${why}` }
    }
    const reply = parsed.result ?? ""
    const ok = !parsed.is_error && parsed.subtype === "success" && result.code === 0
    return { ok, reply, session: parsed.session_id, resume, error: ok ? null : `Claude Code ended with ${parsed.subtype}${parsed.is_error ? " (error)" : ""}: ${oneLine(reply || result.stderr)}` }
  },

  envNeeds(paths) {
    let env: Record<string, unknown> = {}
    try {
      env = (JSON.parse(fs.readFileSync(path.join(paths.home, ".claude/settings.json"), "utf8")) as { env?: Record<string, unknown> }).env ?? {}
    } catch {}
    const keys = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]
    if (keys.some((key) => typeof env[key] === "string")) return []
    if (typeof env.ANTHROPIC_BASE_URL === "string") return [{ names: keys.slice(0, 2), why: "~/.claude/settings.json points Claude Code at ANTHROPIC_BASE_URL without a key" }]
    if (fs.existsSync(path.join(paths.home, ".claude/.credentials.json"))) return []
    return [{ names: keys, why: "Claude Code has no saved sign-in" }]
  },

  async checks(paths, required) {
    const claude = binary(paths)
    if (!claude) return [{ ok: false, level: "warning", name: "Claude Code", detail: "not installed", fix: "install Claude Code: https://claude.com/claude-code" }]
    const version = await runCommand(claude, ["--version"], { timeoutMs: 30_000 })
    const list = await runCommand(claude, ["mcp", "list"], { timeoutMs: 90_000, cwd: paths.home })
    const servers = list.code === 0 ? parseClaudeMcp(list.stdout) : oneLine(list.error ?? list.stderr ?? `exit code ${list.code}`)
    return [
      { ok: version.code === 0, name: "Claude Code", detail: version.code === 0 ? version.stdout.trim() : "installed, but --version failed" },
      ...mcpChecks("Claude Code", servers, required, {
        add: (name) =>
          name === "executor"
            ? "claude mcp add --scope user executor -- executor mcp"
            : name === "notion"
              ? "claude mcp add --scope user --transport http notion https://mcp.notion.com/mcp"
              : `claude mcp add --scope user ${name} …`,
        login: (name) => `in an interactive Claude Code session run /mcp, choose ${name}, then Authenticate`,
      }),
    ]
  },
}
