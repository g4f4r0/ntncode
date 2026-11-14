import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import type { NotionPage } from "../../src/shared/notion.ts"
import { syncSkills } from "../../src/skills/sync.ts"
import { fakeNotion, tempHome } from "../helpers.ts"

const SOURCE = "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a"
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const skillFile = (name: string, page: string, body = "Do the thing.") => `---\nname: ${name}\ndescription: ${name} things\nnotion_page_id: ${page}\n---\n\n${body}\n`

/** Skills as Notion exports them: markdown only, with a version per skill. */
function library(skills: { name: string; n: number; body?: string; version?: string; auto?: boolean }[]) {
  const pages: NotionPage[] = skills.map((skill) => ({
    id: id(skill.n),
    last_edited_time: "2026-11-14T08:00:00.000Z",
    properties: { "Auto-invoke": { type: "checkbox", checkbox: skill.auto ?? true } },
  }))
  const calls = { skill: 0 }
  const notion = fakeNotion({
    queryDataSource: async () => pages,
    getSkill: async (page) => {
      calls.skill += 1
      const skill = skills.find((entry) => id(entry.n) === page)!
      return { id: page, version_id: skill.version ?? "v1", markdown: skillFile(skill.name, page, skill.body) }
    },
  })
  return { notion, calls }
}

const read = (file: string) => fs.readFileSync(file, "utf8")

test("writes new skills, adopts a folder that already matches Notion, and leaves a foreign different one alone", async () => {
  const paths = tempHome()
  const skills = path.join(paths.agents, "skills")
  fs.mkdirSync(path.join(skills, "same"), { recursive: true })
  fs.writeFileSync(path.join(skills, "same/SKILL.md"), skillFile("same", id(2)))
  fs.mkdirSync(path.join(skills, "foreign"), { recursive: true })
  fs.writeFileSync(path.join(skills, "foreign/SKILL.md"), "mine")
  fs.mkdirSync(path.join(skills, "unrelated"), { recursive: true })
  const { notion } = library([{ name: "fresh", n: 1 }, { name: "same", n: 2 }, { name: "foreign", n: 3 }])

  const results = await syncSkills(notion, paths, SOURCE)
  const byName = Object.fromEntries(results.map((result) => [path.basename(result.path), result]))
  assert.equal(byName.fresh!.status, "written")
  assert.equal(byName.same!.status, "unchanged")
  assert.match(byName.same!.detail, /adopted/u)
  assert.equal(byName.foreign!.status, "skipped")
  assert.equal(read(path.join(skills, "foreign/SKILL.md")), "mine")
  assert.equal(read(path.join(skills, "fresh/SKILL.md")), skillFile("fresh", id(1)))
  assert.ok(fs.existsSync(path.join(skills, "unrelated")), "a folder Notion doesn't know is never touched")
})

test("an unchanged library costs one export call per skill and no rewrite; Auto-invoke off disables model invocation", async () => {
  const paths = tempHome()
  const { notion } = library([{ name: "manual", n: 1, auto: false }])
  await syncSkills(notion, paths, SOURCE)
  const file = path.join(paths.agents, "skills/manual/SKILL.md")
  assert.match(read(file), /disable-model-invocation: true/u)
  const before = fs.statSync(file).mtimeMs
  const second = await syncSkills(notion, paths, SOURCE)
  assert.deepEqual(second.map((result) => result.status), ["unchanged"])
  assert.equal(fs.statSync(file).mtimeMs, before)
})

test("a hand edit is backed up before Notion's version replaces it", async () => {
  const paths = tempHome()
  await syncSkills(library([{ name: "a", n: 1 }]).notion, paths, SOURCE)
  const file = path.join(paths.agents, "skills/a/SKILL.md")
  fs.writeFileSync(file, "edited by hand")
  const results = await syncSkills(library([{ name: "a", n: 1, version: "v2", body: "New." }]).notion, paths, SOURCE)
  assert.equal(results[0]!.status, "written")
  assert.match(results[0]!.detail, /hand edit/u)
  assert.equal(read(file), skillFile("a", id(1), "New."))
  const backups = fs.readdirSync(path.join(paths.state, "backups"))
  assert.equal(read(path.join(paths.state, "backups", backups[0]!, ".agents/skills/a/SKILL.md")), "edited by hand")
})

test("a skill removed from Notion moves to the backups, unless it was edited by hand", async () => {
  const paths = tempHome()
  await syncSkills(library([{ name: "keep", n: 1 }, { name: "gone", n: 2 }, { name: "edited", n: 3 }]).notion, paths, SOURCE)
  fs.writeFileSync(path.join(paths.agents, "skills/edited/SKILL.md"), "hand")
  const results = await syncSkills(library([{ name: "keep", n: 1 }]).notion, paths, SOURCE)
  const byName = Object.fromEntries(results.map((result) => [path.basename(result.path), result.status]))
  assert.deepEqual(byName, { keep: "unchanged", gone: "removed", edited: "skipped" })
  assert.equal(fs.existsSync(path.join(paths.agents, "skills/gone")), false)
  assert.equal(read(path.join(paths.agents, "skills/edited/SKILL.md")), "hand")
})

test("any failed read, an empty library or a duplicate name changes nothing", async () => {
  const paths = tempHome()
  await syncSkills(library([{ name: "a", n: 1 }]).notion, paths, SOURCE)
  const failing = fakeNotion({ queryDataSource: async () => [{ id: id(1) }], getSkill: async () => Promise.reject(new Error("Notion failed (502)")) })
  for (const notion of [failing, library([]).notion, library([{ name: "b", n: 2 }, { name: "b", n: 3 }]).notion]) {
    const results = await syncSkills(notion, paths, SOURCE)
    assert.equal(results.length, 1)
    assert.equal(results[0]!.status, "failed")
    assert.match(results[0]!.detail, /kept as it is/u)
    assert.ok(fs.existsSync(path.join(paths.agents, "skills/a/SKILL.md")))
  }
})

test("a skill with a bad name or the wrong page ID is refused", async () => {
  const paths = tempHome()
  const notion = fakeNotion({
    queryDataSource: async () => [{ id: id(1) }],
    getSkill: async (page) => ({ id: page, version_id: "v1", markdown: skillFile("Bad Name", page) }),
  })
  assert.match((await syncSkills(notion, paths, SOURCE))[0]!.detail, /skill name/u)
  const wrong = fakeNotion({ queryDataSource: async () => [{ id: id(1) }], getSkill: async (page) => ({ id: page, version_id: "v1", markdown: skillFile("ok", id(9)) }) })
  assert.match((await syncSkills(wrong, paths, SOURCE))[0]!.detail, /notion_page_id/u)
})

test("a dry run writes nothing, not even its state", async () => {
  const paths = tempHome()
  const results = await syncSkills(library([{ name: "a", n: 1 }]).notion, paths, SOURCE, { dryRun: true })
  assert.equal(results[0]!.status, "would write")
  assert.equal(fs.existsSync(path.join(paths.agents, "skills/a")), false)
  assert.equal(fs.existsSync(path.join(paths.state, "skills.json")), false)
})
