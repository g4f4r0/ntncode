import assert from "node:assert/strict"
import fs from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { AGENTS } from "../../src/agents/index.ts"
import { modules } from "../../src/modules.ts"
import { AGENT_KEYS, agentKey, agentOn, EMPTY_CONFIG, isOn, readConfig, readToken, withConfig } from "../../src/shared/config.ts"
import { activeModules } from "../../src/shared/module.ts"
import { tempHome } from "../helpers.ts"

const OWNER = "5f6e7d8c-9b0a-4f1e-8d2c-3b4a5f6e7d8c"

test("a missing config is the default; a valid one is read", () => {
  const paths = tempHome()
  assert.deepEqual(readConfig(paths.config), EMPTY_CONFIG)
  fs.writeFileSync(paths.config, JSON.stringify({ assignee: OWNER }))
  assert.deepEqual(readConfig(paths.config), { ...EMPTY_CONFIG, assignee: OWNER })
  const full = {
    assignee: OWNER.replaceAll("-", "").toUpperCase(),
    instructions: { source: OWNER },
    skills: { source: OWNER },
    automations: { source: OWNER, runs: OWNER },
    agents: { mcp: ["notion", "executor"], capy: { enabled: false } },
    onFailure: "~/alert.sh",
  }
  fs.writeFileSync(paths.config, JSON.stringify(full))
  assert.deepEqual(readConfig(paths.config), { ...EMPTY_CONFIG, assignee: OWNER, instructions: OWNER, skills: OWNER, automations: { source: OWNER, runs: OWNER }, agents: { mcp: ["notion", "executor"], off: ["capy"] }, onFailure: "~/alert.sh" })
})

test("an unknown key, a bad assignee, or broken JSON is an error, never ignored", () => {
  const paths = tempHome()
  for (const content of [JSON.stringify({ assignee: OWNER, ownr: "x" }), JSON.stringify({ assignee: "Johan" }), JSON.stringify({ projects: "code" }), JSON.stringify({ automations: { source: OWNER } }), JSON.stringify({ automations: { source: OWNER, runs: OWNER, extra: 1 } }), JSON.stringify({ agents: { mcp: ["no spaces"] } }), JSON.stringify({ agents: { cursor: { enabled: false } } }), JSON.stringify({ skills: { enabled: "no", source: OWNER } }), JSON.stringify({ onFailure: "" }), "{ nope", "[]"]) {
    fs.writeFileSync(paths.config, content)
    assert.throws(() => readConfig(paths.config))
  }
})

test("the token comes from the environment first, then the secrets file", () => {
  const paths = tempHome()
  const saved = process.env.NOTION_ACCESS_TOKEN
  try {
    delete process.env.NOTION_ACCESS_TOKEN
    assert.equal(readToken(paths.secrets), null)
    fs.writeFileSync(paths.secrets, 'OTHER=1\nexport NOTION_ACCESS_TOKEN="ntn_file"\n')
    assert.equal(readToken(paths.secrets), "ntn_file")
    process.env.NOTION_ACCESS_TOKEN = "ntn_env"
    assert.equal(readToken(paths.secrets), "ntn_env")
  } finally {
    if (saved === undefined) delete process.env.NOTION_ACCESS_TOKEN
    else process.env.NOTION_ACCESS_TOKEN = saved
  }
})

test("the artifacts bucket needs an S3 URL with the bucket, and a public URL", () => {
  const paths = tempHome()
  fs.writeFileSync(paths.config, JSON.stringify({ artifacts: { bucketUrl: "https://s3.example.test/bucket/", publicUrl: "https://files.example.test/" } }))
  assert.deepEqual(readConfig(paths.config).artifacts, { bucketUrl: "https://s3.example.test/bucket", publicUrl: "https://files.example.test" })
  for (const artifacts of [{ bucketUrl: "https://s3.example.test", publicUrl: "https://f.test" }, { bucketUrl: "https://s3.example.test/a/b", publicUrl: "https://f.test" }, { bucketUrl: "https://s3.example.test/b", publicUrl: "ftp://f.test" }, { bucketUrl: "https://s3.example.test/b" }, { bucketUrl: "https://s3.example.test/b", publicUrl: "https://f.test", prefix: "x" }]) {
    fs.writeFileSync(paths.config, JSON.stringify({ artifacts }))
    assert.throws(() => readConfig(paths.config))
  }
})

test("a projects folder in the config replaces ~/projects", () => {
  const paths = tempHome()
  assert.equal(withConfig(paths, EMPTY_CONFIG).projects, paths.projects)
  assert.equal(withConfig(paths, { ...EMPTY_CONFIG, projects: "~/code" }).projects, path.join(paths.home, "code"))
  assert.equal(withConfig(paths, { ...EMPTY_CONFIG, projects: "/srv/work" }).projects, "/srv/work")
})

test("the layout from before 0.4 is refused, naming what replaced each key", () => {
  const paths = tempHome()
  fs.writeFileSync(paths.config, JSON.stringify({ skills: OWNER, automations: { automations: OWNER, runs: OWNER, instructions: OWNER }, mcp: ["notion"] }))
  assert.throws(() => readConfig(paths.config), (error: Error) => {
    for (const hint of ['skills: now { "source"', "automations.automations: now automations.source", "automations.instructions: now the Automations row of instructions.source", "mcp: now agents.mcp"]) assert.ok(error.message.includes(hint), hint)
    return error.message.includes("uses the old layout")
  })
})

test('"enabled": false turns a section or an agent off and keeps its settings; only sections that are on run', () => {
  const paths = tempHome()
  fs.writeFileSync(paths.config, JSON.stringify({ skills: { enabled: false, source: OWNER }, automations: { enabled: true, source: OWNER, runs: OWNER }, agents: { "claude-code": { enabled: false }, codex: { enabled: true } } }))
  const config = readConfig(paths.config)
  assert.deepEqual(config.off, ["skills"])
  assert.equal(config.skills, OWNER, "its source stays")
  assert.equal(isOn(config, "skills"), false)
  assert.equal(isOn(config, "automations"), true)
  assert.deepEqual([agentOn(config, "Claude Code"), agentOn(config, "Codex"), agentOn(config, "T3 Code")], [false, true, true])
  assert.deepEqual(activeModules(config, modules).map((module) => module.name), modules.map((module) => module.name).filter((name) => name !== "skills"))
})

test("every agent has a key under agents, and each key names an agent", () => {
  assert.deepEqual(Object.values(AGENT_KEYS).sort(), Object.keys(AGENTS).sort())
  for (const [key, name] of Object.entries(AGENT_KEYS)) assert.equal(agentKey(name), key)
})
