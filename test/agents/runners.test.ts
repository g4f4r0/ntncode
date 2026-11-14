import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { mcpChecks } from "../../src/agents/agent.ts"
import { claudeCode, parseClaudeMcp } from "../../src/agents/claude-code.ts"
import { codex, parseCodexMcp } from "../../src/agents/codex.ts"
import { openCode, parseOpenCodeMcp } from "../../src/agents/opencode.ts"
import { tempHome } from "../helpers.ts"

/** Puts a fake agent CLI first on PATH: it records its argv, cwd and stdin, and prints `output`. */
function stub(name: string, output: string, exit = 0) {
  const paths = tempHome()
  const bin = path.join(paths.home, "bin")
  fs.mkdirSync(bin)
  const record = path.join(paths.home, "record")
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$@" > ${record}.argv\npwd > ${record}.cwd\ncat > ${record}.stdin\ncat <<'OUT'\n${output}\nOUT\nexit ${exit}\n`, { mode: 0o755 })
  const saved = process.env.PATH
  process.env.PATH = `${bin}:${saved}`
  const directory = path.join(paths.projects, "acme")
  fs.mkdirSync(directory)
  return {
    paths,
    directory,
    argv: () => fs.readFileSync(`${record}.argv`, "utf8").trim().split("\n"),
    stdin: () => fs.readFileSync(`${record}.stdin`, "utf8"),
    cwd: () => fs.realpathSync(fs.readFileSync(`${record}.cwd`, "utf8").trim()),
    restore: () => (process.env.PATH = saved),
  }
}

const input = (directory: string) => ({ prompt: "<automation>do it</automation>", directory, model: "claude-opus-5-5", effort: "high" as const, title: "AUT-1 Acme" })

test("Claude Code runs headless and unattended, with the model, effort and a session ID of its own", async () => {
  const fake = stub("claude", '{"type":"result","subtype":"success","is_error":false,"result":"Done: 3 fixed.","session_id":"s-1"}')
  try {
    const output = await claudeCode.run(fake.paths, input(fake.directory))
    assert.deepEqual([output.ok, output.reply, output.session, output.error], [true, "Done: 3 fixed.", "s-1", null])
    const argv = fake.argv()
    for (const flag of ["-p", "--output-format", "json", "--permission-mode", "bypassPermissions", "--model", "claude-opus-5-5", "--effort", "high", "--name", "AUT-1 Acme"]) assert.ok(argv.includes(flag), flag)
    assert.match(argv[argv.indexOf("--session-id") + 1]!, /^[0-9a-f-]{36}$/u)
    assert.equal(fake.stdin(), "<automation>do it</automation>")
    assert.equal(fake.cwd(), fs.realpathSync(fake.directory))
    assert.match(output.resume!, /claude --resume /u)
  } finally {
    fake.restore()
  }
})

test("Claude Code's error result, or no result at all, is a failure with the reason", async () => {
  for (const [out, exit, pattern] of [
    ['{"type":"result","subtype":"error_max_turns","is_error":true,"result":"","session_id":"s"}', 1, /error_max_turns/u],
    ["not json", 1, /returned no result/u],
  ] as const) {
    const fake = stub("claude", out, exit)
    try {
      const output = await claudeCode.run(fake.paths, input(fake.directory))
      assert.equal(output.ok, false)
      assert.match(output.error!, pattern)
    } finally {
      fake.restore()
    }
  }
})

test("Codex runs exec --json, bypassing approvals, with effort as model_reasoning_effort (max → xhigh)", async () => {
  const events = ['{"type":"thread.started","thread_id":"t-1"}', '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}', '{"type":"item.completed","item":{"type":"agent_message","text":"final"}}', '{"type":"turn.completed"}'].join("\n")
  const fake = stub("codex", events)
  try {
    const output = await codex.run(fake.paths, { ...input(fake.directory), model: "gpt-6.1-sol", effort: "max" })
    assert.deepEqual([output.ok, output.reply, output.session], [true, "final", "t-1"])
    const argv = fake.argv()
    assert.deepEqual(argv.slice(0, 2), ["exec", "--json"])
    for (const flag of ["--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "gpt-6.1-sol", 'model_reasoning_effort="xhigh"', "-"]) assert.ok(argv.includes(flag), flag)
    assert.equal(argv[argv.indexOf("-C") + 1], fake.directory)
  } finally {
    fake.restore()
  }
  const failed = stub("codex", ['{"type":"thread.started","thread_id":"t"}', '{"type":"turn.failed","message":"usage limit"}'].join("\n"))
  try {
    const output = await codex.run(failed.paths, input(failed.directory))
    assert.equal(output.ok, false)
    assert.match(output.error!, /usage limit/u)
  } finally {
    failed.restore()
  }
})

test("OpenCode runs with --auto and the model's variant as effort; the reply is the last message's text", async () => {
  const events = [
    '{"type":"text","sessionID":"ses_1","part":{"type":"text","messageID":"m1","text":"thinking out loud"}}',
    '{"type":"text","sessionID":"ses_1","part":{"type":"text","messageID":"m2","text":"Final report."}}',
  ].join("\n")
  const fake = stub("opencode", events)
  try {
    const output = await openCode.run(fake.paths, { ...input(fake.directory), model: "anthropic/claude-opus-5-5" })
    assert.deepEqual([output.ok, output.reply, output.session], [true, "Final report.", "ses_1"])
    const argv = fake.argv()
    for (const flag of ["run", "--format", "json", "--auto", "anthropic/claude-opus-5-5#high"]) assert.ok(argv.includes(flag), flag)
  } finally {
    fake.restore()
  }
  assert.ok(fake.argv().includes("--standalone"), "a private OpenCode, so the run is in its own folder")
  assert.match(openCode.modelError("claude-opus-5-5")!, /provider\/model/u)
  assert.equal(openCode.modelError("anthropic/claude-opus-5-5"), null)
})

test("each agent's MCP list is read, and a missing or signed-out server is an error with its fix", () => {
  const claude = parseClaudeMcp("Checking MCP server health…\n\nnotion: https://mcp.notion.com/mcp (HTTP) - ! Needs authentication\nexecutor: executor mcp - ✓ Connected\nbroken: x - ✗ Failed to connect\n")
  assert.deepEqual(claude, [
    { name: "notion", state: "login" },
    { name: "executor", state: "connected" },
    { name: "broken", state: "failed" },
  ])
  const codexServers = parseCodexMcp(JSON.stringify([{ name: "notion", enabled: true, auth_status: "not_logged_in" }, { name: "executor", enabled: true, auth_status: "unsupported" }, { name: "off", enabled: false, auth_status: null }]))
  assert.deepEqual(codexServers.map((server) => server.state), ["login", "configured", "disabled"])
  assert.deepEqual(parseOpenCodeMcp("✓ executor  connected\n✗ notion    needs authentication\n"), [
    { name: "executor", state: "connected" },
    { name: "notion", state: "login" },
  ])
  const checks = mcpChecks("Codex", codexServers, ["notion", "executor", "github"], { add: (name) => `add ${name}`, login: (name) => `login ${name}` })
  assert.deepEqual(
    checks.map((check) => [check.name, check.ok, check.fix ?? null]),
    [
      ["Codex MCP notion", false, "login notion"],
      ["Codex MCP executor", true, null],
      ["Codex MCP github", false, "add github"],
    ],
  )
})

test("OpenCode refuses to run while opencode-automations is configured, so nothing fires twice", async () => {
  const fake = stub("opencode", "")
  try {
    fs.mkdirSync(path.join(fake.paths.home, ".config/opencode"), { recursive: true })
    fs.writeFileSync(path.join(fake.paths.home, ".config/opencode/opencode.jsonc"), '{\n  // opencode-automations was here\n  "plugins": [{ "package": "/x/opencode-automations" }]\n}\n')
    const output = await openCode.run(fake.paths, input(fake.directory))
    assert.equal(output.ok, false)
    assert.match(output.error!, /opencode-automations removed/u)
    assert.equal(fs.existsSync(path.join(fake.paths.home, "record.argv")), false, "never started")
  } finally {
    fake.restore()
  }
})

test("each agent names the variables it needs to sign in unattended, from its own config", () => {
  const paths = tempHome()
  fs.mkdirSync(path.join(paths.home, ".claude"))
  fs.writeFileSync(path.join(paths.home, ".claude/settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://proxy" } }))
  assert.deepEqual(claudeCode.envNeeds(paths)[0]!.names, ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"])
  fs.mkdirSync(path.join(paths.home, ".codex"))
  fs.writeFileSync(path.join(paths.home, ".codex/config.toml"), 'model_provider = "proxy"\n\n[model_providers.proxy]\nenv_key = "PROXY_KEY"\n\n[mcp_servers.x]\nenv_key = "NOT_THIS"\n')
  assert.deepEqual(codex.envNeeds(paths).map((need) => need.names), [["PROXY_KEY"]])
  fs.mkdirSync(path.join(paths.home, ".config/opencode"), { recursive: true })
  fs.writeFileSync(path.join(paths.home, ".config/opencode/opencode.jsonc"), '{\n  // {env:IN_A_COMMENT}\n  "headers": { "Authorization": "Bearer {env:EXECUTOR_TOKEN}" }\n}\n')
  assert.deepEqual(openCode.envNeeds(paths).map((need) => need.names), [["EXECUTOR_TOKEN"]])
})
