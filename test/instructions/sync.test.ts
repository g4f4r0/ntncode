import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import type { Paths } from "../../src/shared/config.ts"
import type { Notion, NotionPage } from "../../src/shared/notion.ts"
import { HEADER_PREFIX, parsePageId, syncInstructions } from "../../src/instructions/sync.ts"
import { fakeNotion as baseNotion } from "../helpers.ts"

const PAGE = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
const GLOBAL = "5f6e7d8c-9b0a-4f1e-8d2c-3b4a5f6e7d8c"

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "notion-agents-"))
  const paths: Paths = { home, agents: path.join(home, ".agents"), projects: path.join(home, "projects"), state: path.join(home, "state"), config: path.join(home, "config.json"), secrets: path.join(home, "secrets.env") }
  fs.mkdirSync(paths.agents, { recursive: true })
  fs.mkdirSync(path.join(paths.projects, "acme"), { recursive: true })
  return { home, paths }
}

function fakeNotion(pages: Record<string, { title: string; markdown: string; edited?: string; trash?: boolean }>) {
  const calls = { page: 0, markdown: 0 }
  const notion: Notion = baseNotion({
    async getPage(id) {
      calls.page += 1
      const page = pages[id]
      if (!page) throw new Error("Notion page not found, or not shared with the token's owner")
      return {
        id,
        url: `https://app.notion.com/p/${id.replaceAll("-", "")}`,
        in_trash: page.trash,
        last_edited_time: page.edited ?? "2026-11-14T08:00:00.000Z",
        properties: { Name: { type: "title", title: [{ plain_text: page.title }] } },
      } satisfies NotionPage
    },
    async getPageMarkdown(id) {
      calls.markdown += 1
      return pages[id]!.markdown
    },
  })

  return { notion, calls }
}

const later = new Date("2026-11-14T09:00:00.000Z")
const json = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value))

test("parsePageId takes an ID or a link", () => {
  assert.equal(parsePageId(PAGE), PAGE)
  assert.equal(parsePageId("0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d"), PAGE)
  assert.equal(parsePageId("https://app.notion.com/p/Acme-0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d"), PAGE)
  assert.equal(parsePageId("https://www.notion.so/Face-0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d?v=99998888777766665555444433332222"), PAGE)
  assert.equal(parsePageId("https://app.notion.com/p/0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d#ffffeeeeddddccccbbbbaaaa99998888"), PAGE)
  assert.equal(parsePageId("0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D"), PAGE)
  assert.equal(parsePageId("nope"), null)
  assert.equal(parsePageId(42), null)
})

test("writes each notion.json's page beside it, then skips unedited pages without reading their markdown", async () => {
  const { paths } = setup()
  json(path.join(paths.agents, "notion.json"), { instructions: GLOBAL })
  json(path.join(paths.projects, "acme/notion.json"), { instructions: PAGE })
  const { notion, calls } = fakeNotion({ [GLOBAL]: { title: "Organization", markdown: "# Org\n\nBe kind." }, [PAGE]: { title: "Acme", markdown: "Acme rules." } })

  const first = await syncInstructions(notion, paths, { now: later })
  assert.deepEqual(first.map((result) => result.status), ["written", "written"])
  const written = fs.readFileSync(path.join(paths.projects, "acme/AGENTS.md"), "utf8")
  assert.ok(written.startsWith(`${HEADER_PREFIX}: "Acme"`))
  assert.ok(written.endsWith("\n\nAcme rules.\n"))

  const second = await syncInstructions(notion, paths, { now: later })
  assert.deepEqual(second.map((result) => result.status), ["unchanged", "unchanged"])
  assert.equal(calls.markdown, 2, "the second run reads no markdown")
})

test("re-reads a page edited within the minute of the last sync", async () => {
  const { paths } = setup()
  json(path.join(paths.projects, "acme/notion.json"), { instructions: PAGE })
  const pages = { [PAGE]: { title: "Acme", markdown: "v1", edited: "2026-11-14T09:00:00.000Z" } }
  const { notion } = fakeNotion(pages)
  await syncInstructions(notion, paths, { now: new Date("2026-11-14T09:00:30.000Z") })
  pages[PAGE].markdown = "v2" // edited again in the same minute: last_edited_time does not move
  const results = await syncInstructions(notion, paths, { now: new Date("2026-11-14T09:05:00.000Z") })
  assert.equal(results[0]!.status, "written")
  assert.ok(fs.readFileSync(path.join(paths.projects, "acme/AGENTS.md"), "utf8").endsWith("v2\n"))
})

test("never overwrites a hand-written file or writes through a link", async () => {
  const { paths } = setup()
  json(path.join(paths.agents, "notion.json"), { instructions: GLOBAL })
  json(path.join(paths.projects, "acme/notion.json"), { instructions: PAGE })
  fs.writeFileSync(path.join(paths.agents, "AGENTS.md"), "My own notes.\n")
  fs.writeFileSync(path.join(paths.home, "elsewhere.md"), "outside\n")
  fs.symlinkSync(path.join(paths.home, "elsewhere.md"), path.join(paths.projects, "acme/AGENTS.md"))
  const { notion } = fakeNotion({ [GLOBAL]: { title: "Organization", markdown: "Org" }, [PAGE]: { title: "Acme", markdown: "J" } })

  const results = await syncInstructions(notion, paths, { now: later })
  assert.deepEqual(results.map((result) => result.status), ["skipped", "skipped"])
  assert.equal(fs.readFileSync(path.join(paths.agents, "AGENTS.md"), "utf8"), "My own notes.\n")
  assert.equal(fs.readFileSync(path.join(paths.home, "elsewhere.md"), "utf8"), "outside\n")
})

test("keeps the last good copy when Notion fails, the page is trashed or empty", async () => {
  const { paths } = setup()
  json(path.join(paths.projects, "acme/notion.json"), { instructions: PAGE })
  const pages: Parameters<typeof fakeNotion>[0] = { [PAGE]: { title: "Acme", markdown: "good" } }
  await syncInstructions(fakeNotion(pages).notion, paths, { now: later })
  const file = path.join(paths.projects, "acme/AGENTS.md")
  const good = fs.readFileSync(file, "utf8")

  const brokens: Parameters<typeof fakeNotion>[0][] = [{}, { [PAGE]: { title: "Acme", markdown: "x", trash: true, edited: "2026-11-14T10:00:00.000Z" } }, { [PAGE]: { title: "Acme", markdown: "  ", edited: "2026-11-14T10:00:00.000Z" } }]
  for (const broken of brokens) {
    const results = await syncInstructions(fakeNotion(broken).notion, paths, { now: later })
    assert.equal(results[0]!.status, "failed")
    assert.equal(fs.readFileSync(file, "utf8"), good)
  }
})

test("backs up a hand edit to a synced file before replacing it", async () => {
  const { paths } = setup()
  json(path.join(paths.projects, "acme/notion.json"), { instructions: PAGE })
  const { notion } = fakeNotion({ [PAGE]: { title: "Acme", markdown: "from Notion" } })
  await syncInstructions(notion, paths, { now: later })
  const file = path.join(paths.projects, "acme/AGENTS.md")
  const edited = `${fs.readFileSync(file, "utf8")}a local edit\n`
  fs.writeFileSync(file, edited)

  const results = await syncInstructions(notion, paths, { now: later })
  assert.equal(results[0]!.status, "written")
  assert.match(results[0]!.detail, /hand edit/)
  const backup = path.join(paths.state, "backups", later.toISOString().replaceAll(":", "-"), "projects/acme/AGENTS.md")
  assert.equal(fs.readFileSync(backup, "utf8"), edited)
})

test("reports a bad notion.json and writes nothing for it", async () => {
  const { paths } = setup()
  json(path.join(paths.projects, "acme/notion.json"), { instructions: PAGE, project: "x" })
  fs.mkdirSync(path.join(paths.projects, "other"))
  fs.writeFileSync(path.join(paths.projects, "other/notion.json"), "{ not json")
  const results = await syncInstructions(fakeNotion({}).notion, paths, { now: later })
  assert.deepEqual(results.map((result) => result.status), ["failed", "failed"])
  assert.equal(fs.existsSync(path.join(paths.projects, "acme/AGENTS.md")), false)
})

test("a dry run writes nothing", async () => {
  const { paths } = setup()
  json(path.join(paths.projects, "acme/notion.json"), { instructions: PAGE })
  const results = await syncInstructions(fakeNotion({ [PAGE]: { title: "Acme", markdown: "J" } }).notion, paths, { dryRun: true, now: later })
  assert.equal(results[0]!.status, "would write")
  assert.equal(fs.existsSync(path.join(paths.projects, "acme/AGENTS.md")), false)
  assert.equal(fs.existsSync(path.join(paths.state, "state.json")), false)
})

test("a file written in an older format is written again, though its page wasn't edited", async () => {
  const { paths } = setup()
  json(path.join(paths.projects, "acme/notion.json"), { instructions: PAGE })
  const { notion, calls } = fakeNotion({ [PAGE]: { title: "Acme", markdown: "rules" } })
  await syncInstructions(notion, paths, { now: later })
  const statePath = path.join(paths.state, "state.json")
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"))
  const file = path.join(paths.projects, "acme/AGENTS.md")
  // As an older version would have left it: no format, and an older header.
  for (const entry of Object.values(state.files) as { format?: number; hash: string }[]) delete entry.format
  fs.writeFileSync(statePath, JSON.stringify(state))

  const results = await syncInstructions(notion, paths, { now: later })
  assert.equal(results[0]!.status, "unchanged", "same content, so nothing to write")
  assert.equal(calls.markdown, 2, "but the page was read again rather than trusted")
  const again = await syncInstructions(notion, paths, { now: later })
  assert.equal(again[0]!.status, "unchanged")
  assert.equal(calls.markdown, 2, "and once recorded in the current format, it is trusted again")
  assert.ok(fs.readFileSync(file, "utf8").includes("Notion Code replaces this file"))
})
