import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { definitionsFolder, readDefinitions, syncAutomations } from "../../src/automations/definitions.ts"
import { requestRun } from "../../src/automations/index.ts"
import { statePath } from "../../src/scheduler/serve.ts"
import { EMPTY_CONFIG, type Config } from "../../src/shared/config.ts"
import type { NotionPage } from "../../src/shared/notion.ts"
import { dueOccurrence } from "../../src/scheduler/serve.ts"
import { fakeNotion, tempHome, testContext } from "../helpers.ts"
import { automationPage, BOT, OWNER, PROJECT, projectPage, type RowInput } from "./fixtures.ts"

const SOURCE = "1e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b"
const config: Config = { ...EMPTY_CONFIG, assignee: OWNER, automations: { automations: SOURCE, runs: SOURCE, instructions: null } }

function setup() {
  const paths = tempHome()
  fs.mkdirSync(path.join(paths.projects, "acme"))
  return paths
}

/** A Notion with these rows; records the query filter and markdown reads. */
function notionWith(rows: RowInput[], prompt = "Audit the store.", projectPath = "acme") {
  const calls = { filters: [] as unknown[], markdown: 0 }
  const pages: NotionPage[] = rows.map((row) => automationPage(row))
  const notion = fakeNotion({
    queryDataSource: async (_source, body) => {
      calls.filters.push(body?.filter)
      return pages
    },
    getPage: async (id) => {
      assert.equal(id, PROJECT)
      return projectPage(projectPath)
    },
    getPageMarkdown: async () => {
      calls.markdown += 1
      return prompt
    },
  })
  return { notion, calls }
}

const at = (iso: string) => new Date(iso)

test("an enabled row the assignee last edited becomes an automation file with everything a run needs", async () => {
  const paths = setup()
  const { notion, calls } = notionWith([{ model: "claude-opus-5-5" }])
  const results = await syncAutomations(notion, paths, config, { now: at("2026-11-14T09:00:00Z") })
  assert.deepEqual(results.map((result) => result.status), ["written"])
  assert.deepEqual(calls.filters[0], { property: "Assignee", people: { contains: OWNER } }, "only the assignee's rows are read")
  const [definition] = readDefinitions(paths).definitions
  assert.equal(definition!.id, "AUT-12")
  assert.equal(definition!.directory, path.join(paths.projects, "acme"))
  assert.equal(definition!.schedule, "DTSTART;TZID=Europe/Madrid:20261115T080000\nRRULE:FREQ=DAILY")
  assert.deepEqual([definition!.agent, definition!.model, definition!.effort, definition!.timeZone, definition!.prompt], ["Claude Code", "claude-opus-5-5", "high", "Europe/Madrid", "Audit the store."])
  assert.equal(definition!.since, "2026-11-14T07:59:59.999Z", "runs count from the assignee's edit at 08:00, not from the sync")
})

test("a run due between the assignee's enable and the sync that reads it still fires; a schedule change never fires an old time", async () => {
  const paths = setup()
  // Enabled at 08:59 for a one-off at 09:00; the sync only reads it at 09:00:05.
  await syncAutomations(notionWith([{ repeat: "Once", start: "2026-11-15T09:00:00.000Z", zone: "UTC", edited: "2026-11-15T08:59:00.000Z" }]).notion, paths, config, { now: at("2026-11-15T09:00:05Z") })
  const once = readDefinitions(paths).definitions[0]!
  assert.equal(dueOccurrence(once as never, null, at("2026-11-15T09:00:20Z")), "2026-11-15T09:00:00.000Z")

  // A daily 15:00 changed at 14:00 to 13:00 doesn't fire 13:00 today, late.
  const daily = setup()
  await syncAutomations(notionWith([{ start: "2026-11-15T15:00:00.000Z", zone: "UTC", edited: "2026-11-15T10:00:00.000Z" }]).notion, daily, config, { now: at("2026-11-15T10:05:00Z") })
  await syncAutomations(notionWith([{ start: "2026-11-15T13:00:00.000Z", zone: "UTC", edited: "2026-11-16T14:00:00.000Z" }]).notion, daily, config, { now: at("2026-11-16T14:05:00Z") })
  const changed = readDefinitions(daily).definitions[0]!
  assert.equal(changed.since, "2026-11-16T13:59:59.999Z")
  assert.equal(dueOccurrence(changed as never, "2026-11-15T15:00:00.000Z", at("2026-11-16T14:06:00Z")), null)
})

test("a row last edited by anyone but the assignee never becomes runnable, and an existing file keeps its old version", async () => {
  const paths = setup()
  const first = await syncAutomations(notionWith([{ editedBy: BOT }]).notion, paths, config, { now: at("2026-11-14T09:00:00Z") })
  assert.equal(first[0]!.status, "skipped")
  assert.match(first[0]!.detail, /not the assignee; not scheduled/u)
  assert.equal(readDefinitions(paths).definitions.length, 0)

  await syncAutomations(notionWith([{}], "Old prompt.").notion, paths, config, { now: at("2026-11-14T09:00:00Z") })
  const edited = await syncAutomations(notionWith([{ editedBy: BOT, edited: "2026-11-14T10:00:00.000Z" }], "Agent's new prompt.").notion, paths, config, { now: at("2026-11-14T10:05:00Z") })
  assert.equal(edited[0]!.status, "skipped")
  assert.match(edited[0]!.detail, /previous version stays scheduled/u)
  assert.equal(readDefinitions(paths).definitions[0]!.prompt, "Old prompt.")
})

test("disabling or archiving always takes effect, whoever did it; so does trashing or giving it another assignee", async () => {
  for (const change of [{ status: "Disabled" as const, editedBy: BOT }, { status: "Archived" as const, editedBy: BOT }, { trash: true }, { owners: [BOT] }]) {
    const paths = setup()
    await syncAutomations(notionWith([{}]).notion, paths, config, { now: at("2026-11-14T09:00:00Z") })
    const rows = "owners" in change ? [] : [change]
    const results = await syncAutomations(notionWith(rows).notion, paths, config, { now: at("2026-11-14T10:00:00Z") })
    assert.deepEqual(results.map((result) => result.status), ["removed"], JSON.stringify(change))
    assert.equal(readDefinitions(paths).definitions.length, 0)
  }
})

test("an unchanged, settled row isn't read again; one edited in the same minute as the last sync is", async () => {
  const paths = setup()
  const { notion, calls } = notionWith([{ edited: "2026-11-14T09:00:00.000Z" }])
  await syncAutomations(notion, paths, config, { now: at("2026-11-14T09:00:30Z") })
  assert.equal(calls.markdown, 1)
  await syncAutomations(notion, paths, config, { now: at("2026-11-14T09:10:00Z") })
  assert.equal(calls.markdown, 2, "the first sync ran within two minutes of the edit, so it reads again")
  const results = await syncAutomations(notion, paths, config, { now: at("2026-11-14T09:20:00Z") })
  assert.equal(calls.markdown, 2)
  assert.equal(results[0]!.status, "unchanged")
})

test("an invalid row is reported with every problem and doesn't run; a valid earlier version stays", async () => {
  const paths = setup()
  const bad = await syncAutomations(notionWith([{ agent: null, start: null }]).notion, paths, config, { now: at("2026-11-14T09:00:00Z") })
  assert.equal(bad[0]!.status, "failed")
  assert.match(bad[0]!.detail, /Agent: is required.*Start: is required|Start: is required.*Agent: is required/u)
  await syncAutomations(notionWith([{}]).notion, paths, config, { now: at("2026-11-14T09:00:00Z") })
  const broken = await syncAutomations(notionWith([{ repeat: "Once", days: ["Mon"], edited: "2026-11-14T11:00:00.000Z" }]).notion, paths, config, { now: at("2026-11-14T11:10:00Z") })
  assert.equal(broken[0]!.status, "failed")
  assert.match(broken[0]!.detail, /previous version stays scheduled/u)
  assert.equal(readDefinitions(paths).definitions.length, 1)
})

test("each agent refuses the model and effort it can't run, under the property to fix", async () => {
  const sync = async (row: RowInput) => (await syncAutomations(notionWith([row]).notion, setup(), config, { now: at("2026-11-14T09:00:00Z") }))[0]!
  assert.match((await sync({ agent: "OpenCode", effort: "High" })).detail, /Effort: OpenCode sets effort through the model, so set Model too/u)
  assert.match((await sync({ agent: "OpenCode", model: "grok-5" })).detail, /Model: OpenCode needs provider\/model/u)
  assert.match((await sync({ agent: "Codex", model: "gpt 6" })).detail, /Model: a Codex model is one word/u)
  for (const row of [{ agent: "OpenCode", model: "claude-opus-5-5" }, { agent: "Codex", effort: "High" }] as RowInput[]) assert.equal((await sync(row)).status, "written", JSON.stringify(row))
})

test("a project without a Path, or one missing on disk, an empty prompt and two owners are refused", async () => {
  const paths = tempHome()
  const missing = await syncAutomations(notionWith([{}]).notion, paths, config, { now: at("2026-11-14T09:00:00Z") })
  assert.match(missing[0]!.detail, /doesn't exist on this machine/u)
  fs.mkdirSync(path.join(paths.projects, "acme"))
  assert.match((await syncAutomations(notionWith([{}], "  ").notion, paths, config))[0]!.detail, /prompt, is empty/u)
  assert.match((await syncAutomations(notionWith([{ owners: [OWNER, BOT] }]).notion, paths, config))[0]!.detail, /exactly one person/u)
  const noProject = await syncAutomations(notionWith([{ project: null }]).notion, paths, config)
  assert.equal(noProject[0]!.status, "written")
  assert.equal(readDefinitions(paths).definitions[0]!.directory, path.join(paths.state, "workspace"))
})

test("a failed query changes nothing; no assignee runs nothing; a dry run writes nothing", async () => {
  const paths = setup()
  await syncAutomations(notionWith([{}]).notion, paths, config)
  const down = fakeNotion({ queryDataSource: async () => Promise.reject(new Error("Notion unreachable (ECONNRESET)")) })
  const results = await syncAutomations(down, paths, config)
  assert.equal(results.at(-1)!.status, "failed")
  assert.equal(readDefinitions(paths).definitions.length, 1)
  assert.match((await syncAutomations(down, paths, { ...config, assignee: null }))[0]!.detail, /no "assignee"/u)

  const fresh = setup()
  const dry = await syncAutomations(notionWith([{}]).notion, fresh, config, { dryRun: true })
  assert.equal(dry[0]!.status, "would write")
  assert.equal(fs.existsSync(definitionsFolder(fresh)), false)
})

/** A folder that's a clone of `repository`, as far as git can tell. */
function clone(directory: string, repository: string) {
  fs.mkdirSync(directory, { recursive: true })
  execFileSync("git", ["init", "-q", directory])
  execFileSync("git", ["-C", directory, "remote", "add", "origin", `git@github.com:${repository}.git`])
}

test("a project's Path can hold subfolders, and a Repository runs in its clone inside the Path", async () => {
  const paths = tempHome()
  fs.mkdirSync(path.join(paths.projects, "acme/web"), { recursive: true })
  await syncAutomations(notionWith([{}], undefined, "acme/web").notion, paths, config)
  assert.equal(readDefinitions(paths).definitions[0]!.directory, path.join(paths.projects, "acme/web"))

  clone(path.join(paths.projects, "acme/acme-theme"), "Acme-Co/acme-theme")
  const results = await syncAutomations(notionWith([{ repository: "acme-co/acme-theme", edited: "2026-11-14T09:00:00.000Z" }]).notion, paths, config)
  assert.equal(results[0]!.status, "written", results[0]!.detail)
  assert.equal(readDefinitions(paths).definitions[0]!.directory, path.join(paths.projects, "acme/acme-theme"))
})

test("a bad Path or Repository is refused under the property to fix, and nothing runs somewhere unexpected", async () => {
  const paths = setup()
  const sync = async (row: RowInput, projectPath = "acme") => (await syncAutomations(notionWith([row], undefined, projectPath).notion, paths, config))[0]!.detail
  for (const bad of ["/etc", "../elsewhere", "acme/../..", "acme/.git"]) assert.match(await sync({}, bad), /Path ".*" must be a folder under/u, bad)
  assert.match(await sync({}, "acme/missing"), /acme\/missing doesn't exist on this machine/u)
  assert.match(await sync({ repository: "acme-theme" }), /Repository: "acme-theme" must be owner\/repo/u)
  assert.match(await sync({ repository: "acme-co/.." }), /Repository: "acme-co\/\.\." must be owner\/repo/u)
  assert.match(await sync({ repository: "acme-co/acme-theme", project: null }), /Repository: needs a Project/u)
  assert.match(await sync({ repository: "acme-co/acme-theme" }), /acme-theme doesn't exist on this machine; clone acme-co\/acme-theme there/u)
  fs.mkdirSync(path.join(paths.projects, "acme/plain"))
  assert.match(await sync({ repository: "acme-co/plain" }), /plain isn't a clone, not of acme-co\/plain/u)
  clone(path.join(paths.projects, "acme/fork"), "someone/fork")
  assert.match(await sync({ repository: "acme-co/fork" }), /fork is a clone of someone\/fork, not of acme-co\/fork/u)
  assert.equal(readDefinitions(paths).definitions.length, 0)
})

test("ntncode run starts a Disabled row for a rehearsal but never an Archived one", async () => {
  const paths = setup()
  fs.mkdirSync(paths.state, { recursive: true })
  fs.writeFileSync(statePath(paths), JSON.stringify({ version: 1, pid: process.pid, startedAt: new Date().toISOString(), heartbeat: new Date().toISOString(), tasks: {} }))
  const context = (status: "Disabled" | "Archived") => testContext(paths, notionWith([{ status }]).notion, config)
  assert.equal((await requestRun(context("Disabled"), "AUT-12")).definition.id, "AUT-12")
  await assert.rejects(requestRun(context("Archived"), "AUT-12"), /AUT-12 is Archived, so it never runs/u)
})
