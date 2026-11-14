import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { claudeCodeLinks } from "../../src/agents/claude-code.ts"
import { codexChecks, codexLinks } from "../../src/agents/codex.ts"
import { ensureLinks, linkChecks } from "../../src/agents/links.ts"
import { tempHome } from "../helpers.ts"

test("makes missing links, keeps its own, and leaves anything else alone", () => {
  const paths = tempHome()
  const { home } = paths
  fs.writeFileSync(path.join(paths.agents, "AGENTS.md"), "x")
  fs.mkdirSync(path.join(paths.agents, "skills"))
  fs.mkdirSync(path.join(home, ".codex"))
  fs.writeFileSync(path.join(home, ".codex/AGENTS.md"), "mine")
  const links = [...claudeCodeLinks(paths), ...codexLinks(paths)]

  const first = ensureLinks(links)
  assert.deepEqual(first.map((result) => [result.status, path.relative(home, result.path)]), [
    ["linked", ".claude/CLAUDE.md"],
    ["linked", ".claude/skills"],
    ["skipped", ".codex/AGENTS.md"],
  ])
  assert.equal(fs.readlinkSync(path.join(home, ".claude/CLAUDE.md")), "../.agents/AGENTS.md")
  assert.equal(fs.readFileSync(path.join(home, ".codex/AGENTS.md"), "utf8"), "mine")
  assert.deepEqual(ensureLinks(links).map((result) => result.status), ["skipped"])
  assert.deepEqual(linkChecks(paths, links).map((check) => check.ok), [true, true, false])
})

test("a dry run makes no links", () => {
  const paths = tempHome()
  fs.writeFileSync(path.join(paths.agents, "AGENTS.md"), "x")
  const results = ensureLinks(codexLinks(paths), { dryRun: true })
  assert.equal(results[0]!.status, "would link")
  assert.equal(fs.existsSync(path.join(paths.home, ".codex/AGENTS.md")), false)
})

test("the Codex check wants notion.json as a project root marker, before any table", () => {
  const paths = tempHome()
  const file = path.join(paths.home, ".codex/config.toml")
  assert.equal(codexChecks(paths)[0]!.ok, false, "no config")
  fs.mkdirSync(path.dirname(file))
  fs.writeFileSync(file, 'model = "x"\n[tools]\nproject_root_markers = ["notion.json"]\n')
  assert.equal(codexChecks(paths)[0]!.ok, false, "inside a table it isn't top-level")
  fs.writeFileSync(file, 'model = "x"\nproject_root_markers = ["notion.json"]\n[tools]\n')
  assert.equal(codexChecks(paths)[0]!.ok, true)
})
