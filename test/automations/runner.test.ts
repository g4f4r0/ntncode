import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import type { Agent, AgentName, AgentRunInput } from "../../src/agents/index.ts"
import { definitionsFolder, type Definition } from "../../src/automations/definitions.ts"
import { automations } from "../../src/automations/index.ts"
import { alert, count, duration, modelLabel, renderPrompt, renderReport, resultPath, runAutomation } from "../../src/automations/runner.ts"
import { outboxFolder, readInflight, runKey, writeInflight } from "../../src/automations/runs.ts"
import type { NotionPage } from "../../src/shared/notion.ts"
import type { NotionWriter } from "../../src/shared/notion-writer.ts"
import { fakeNotion, tempHome, testContext } from "../helpers.ts"
import { OWNER } from "./fixtures.ts"

const RUNS = "2f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c"

function definition(paths: { projects: string }, extra: Partial<Definition> = {}): Definition {
  const directory = path.join(paths.projects, "acme")
  fs.mkdirSync(directory, { recursive: true })
  return {
    format: 1,
    id: "AUT-12",
    page: "aut-page",
    url: "https://app.notion.com/p/aut12",
    title: "Acme daily audit",
    assignee: OWNER,
    agent: "Claude Code",
    model: "claude-opus-5-5",
    effort: "high",
    project: { page: "project", name: "Acme", folder: "acme" },
    directory,
    schedule: "DTSTART;TZID=Europe/Madrid:20261115T080000\nRRULE:FREQ=DAILY",
    timeZone: "Europe/Madrid",
    prompt: "Audit the store.",
    edited: "2026-11-14T08:00:00.000Z",
    synced: "2026-11-14T09:00:00.000Z",
    since: "2026-11-14T09:00:00.000Z",
    ...extra,
  }
}

/** A Notion with Runs rows, and a writer that records every write; `failFinish` makes the last write fail. */
function runsNotion({ existing = [] as NotionPage[], previous = [] as { id: number; report: string }[], failFinish = false } = {}) {
  const writes: { kind: string; page?: string; body: unknown }[] = []
  const notion = fakeNotion({
    async queryDataSource(source, body) {
      assert.equal(source, RUNS)
      const filter = JSON.stringify(body?.filter ?? {})
      if (filter.includes('"Title"')) {
        assert.ok(filter.includes('"Trigger"') && filter.includes('"Scheduled"'), "only a scheduled run blocks a scheduled minute")
        return existing
      }
      return previous.map((run) => ({
        id: `prev-${run.id}`,
        properties: {
          ID: { type: "unique_id", unique_id: { prefix: "RUN", number: run.id } },
          Status: { type: "status", status: { name: "Completed" } },
          Date: { type: "date", date: { start: "2026-11-13T07:00:00Z", end: "2026-11-13T07:10:00Z" } },
        },
      }))
    },
    getPageMarkdown: async (page) => previous.find((run) => `prev-${run.id}` === page)!.report,
  })
  const writer: NotionWriter = {
    async createPage(body) {
      writes.push({ kind: "create", body })
      return { id: "run-page", url: "https://app.notion.com/p/run5", properties: { ID: { type: "unique_id", unique_id: { prefix: "RUN", number: 5 } } } }
    },
    async replaceMarkdown(page, markdown) {
      if (failFinish) throw new Error("Notion unreachable (ETIMEDOUT)")
      writes.push({ kind: "markdown", page, body: markdown })
    },
    async updatePage(page, body) {
      writes.push({ kind: "update", page, body })
      return { id: page }
    },
  }
  return { notion, writer, writes }
}

/** An agent that records what it was given and answers as told. */
function stubAgent(answer: { ok: boolean; reply?: string; error?: string }) {
  const calls: AgentRunInput[] = []
  const agent: Agent = {
    name: "Claude Code",
    binary: () => "/bin/true",
    modelError: () => null,
    async run(_paths, input) {
      calls.push(input)
      return { ok: answer.ok, reply: answer.reply ?? "", session: "sess-1", resume: "claude --resume sess-1", error: answer.error ?? null, usage: answer.ok ? { input: 22_519, cached: 18_200, output: 412, costUsd: 0.0901 } : null }
    },
    checks: async () => [],
    envNeeds: () => [],
  }
  return { agents: { "Claude Code": agent, Codex: agent, OpenCode: agent } as Record<AgentName, Agent>, calls }
}

const config = (extra = {}) => ({ assignee: OWNER, automations: { automations: "a", runs: RUNS, instructions: null }, ...extra })

test("a scheduled run records In progress, runs the agent with the wrapped prompt, then records the report as Completed", async () => {
  const paths = tempHome()
  const { notion, writer, writes } = runsNotion({ previous: [{ id: 4, report: "Yesterday: 2 issues." }] })
  fs.mkdirSync(definitionsFolder(paths), { recursive: true })
  fs.writeFileSync(path.join(definitionsFolder(paths), "instructions.md"), "Every run reports in plain words.\n")
  const { agents, calls } = stubAgent({ ok: true, reply: "All good: 0 issues." })
  const results = await runAutomation({ context: testContext(paths, notion, config()), definition: definition(paths), trigger: "Scheduled", at: "2026-11-15T07:00:00.000Z", request: null, writer, agents })

  assert.deepEqual(results.map((result) => result.status), ["completed"])
  const created = writes[0]!.body as { properties: Record<string, unknown> }
  assert.deepEqual(created.properties.Title, { title: [{ text: { content: "AUT-12@2026-11-15T07:00Z" } }] })
  assert.deepEqual(created.properties.Trigger, { select: { name: "Scheduled" } })
  assert.deepEqual(created.properties.Status, { status: { name: "In progress" } })
  assert.deepEqual(created.properties.Automation, { relation: [{ id: "aut-page" }] })

  const prompt = calls[0]!.prompt
  assert.match(prompt, /<automation id="AUT-12" title="Acme daily audit"[^>]* run="RUN-5"/u)
  assert.match(prompt, /<trigger type="scheduled" scheduled_for="2026-11-15T07:00:00.000Z" started_at="[^"]+" time_zone="Europe\/Madrid"\/>/u)
  assert.match(prompt, /<run-instructions>\nEvery run reports in plain words.\n<\/run-instructions>/u)
  assert.match(prompt, /<run id="RUN-4" status="Completed"[^>]*>\nYesterday: 2 issues.\n<\/run>/u)
  assert.match(prompt, /<instructions>\nAudit the store.\n<\/instructions>\n<\/automation>$/u)
  assert.deepEqual([calls[0]!.directory, calls[0]!.model, calls[0]!.effort], [path.join(paths.projects, "acme"), "claude-opus-5-5", "high"])

  const markdown = writes.find((write) => write.kind === "markdown")!.body as string
  assert.equal(markdown.replace(/<td>\d+ s<\/td>/u, "<td>N s</td>"), "## Details\n\n<table header-row=\"false\">\n<tr>\n<td>Agent</td>\n<td>Claude Code</td>\n</tr>\n<tr>\n<td>Model</td>\n<td>Opus 5.5</td>\n</tr>\n<tr>\n<td>Effort</td>\n<td>High</td>\n</tr>\n<tr>\n<td>Trigger</td>\n<td>Scheduled</td>\n</tr>\n<tr>\n<td>Duration</td>\n<td>N s</td>\n</tr>\n<tr>\n<td>Cost</td>\n<td>$0.09 (agent's estimate)</td>\n</tr>\n<tr>\n<td>Tokens</td>\n<td>22.5k in (18.2k cached) · 412 out</td>\n</tr>\n<tr>\n<td>Session</td>\n<td>`sess-1`</td>\n</tr>\n<tr>\n<td>Folder</td>\n<td>`~/projects/acme`</td>\n</tr>\n</table>\n\n## Result\n\nAll good: 0 issues.\n")
  assert.match(markdown, /All good: 0 issues./u)
  const update = writes.find((write) => write.kind === "update")!.body as { properties: { Status: unknown; Date: { date: { end: string } } } }
  assert.deepEqual(update.properties.Status, { status: { name: "Completed" } })
  assert.ok(update.properties.Date.date.end)
  assert.equal(readInflight(paths).length, 0)
})

test("a scheduled time that already has a run in Runs never runs again", async () => {
  const paths = tempHome()
  const existing = [{ id: "old", properties: { ID: { type: "unique_id", unique_id: { prefix: "RUN", number: 3 } } } }]
  const { notion, writer, writes } = runsNotion({ existing })
  const { agents, calls } = stubAgent({ ok: true })
  const results = await runAutomation({ context: testContext(paths, notion, config()), definition: definition(paths), trigger: "Scheduled", at: "2026-11-15T07:00:00.000Z", request: null, writer, agents })
  assert.equal(results[0]!.status, "skipped")
  assert.match(results[0]!.detail, /already ran as RUN-3/u)
  assert.equal(calls.length + writes.length, 0)
})

test("a failed run is recorded Failed, and the onFailure command gets the details", async () => {
  const paths = tempHome()
  const { notion, writer, writes } = runsNotion()
  const { agents } = stubAgent({ ok: false, error: "Claude Code ended with error_max_turns" })
  const out = path.join(paths.home, "alert.txt")
  const onFailure = `cat > ${out}; echo "$AUTOMATION_ID $AUTOMATION_RUN_ID $AUTOMATION_RUN_STATUS" >> ${out}`
  const results = await runAutomation({ context: testContext(paths, notion, config({ onFailure })), definition: definition(paths), trigger: "Manual", at: "2026-11-14T10:00:00.000Z", request: "req-1", writer, agents })
  assert.equal(results[0]!.status, "failed")
  assert.match(results[0]!.detail, /onFailure command sent the alert/u)
  assert.match(fs.readFileSync(out, "utf8"), /automation "Acme daily audit" \(AUT-12\) failed: Claude Code ended with error_max_turns Run RUN-5: https:\/\/app.notion.com\/p\/run5\nAUT-12 RUN-5 failed\n/u)
  const update = writes.find((write) => write.kind === "update")!.body as { properties: { Status: unknown } }
  assert.deepEqual(update.properties.Status, { status: { name: "Failed" } })
  assert.match(String(writes.find((write) => write.kind === "markdown")!.body), /<td>Trigger<\/td>\n<td>Manual<\/td>[\s\S]*<td>Cost<\/td>\n<td>–<\/td>[\s\S]*<\/table>\n\n## Result\n\n\*\*Failed:\*\* Claude Code ended with error_max_turns\n$/u)
  const result = JSON.parse(fs.readFileSync(resultPath(paths, "req-1"), "utf8"))
  assert.deepEqual([result.status, result.run, result.error], ["Failed", "RUN-5", "Claude Code ended with error_max_turns"])
})

test("a missing run folder fails the run before the agent starts", async () => {
  const paths = tempHome()
  const { notion, writer } = runsNotion()
  const { agents, calls } = stubAgent({ ok: true })
  const results = await runAutomation({ context: testContext(paths, notion, config()), definition: { ...definition(paths), directory: "/nowhere" }, trigger: "Manual", at: "2026-11-14T10:00:00.000Z", request: null, writer, agents })
  assert.match(results[0]!.detail, /doesn't exist/u)
  assert.equal(calls.length, 0)
})

test("when Notion can't take the result, it waits in the outbox", async () => {
  const paths = tempHome()
  const { notion, writer } = runsNotion({ failFinish: true })
  const { agents } = stubAgent({ ok: true, reply: "done" })
  const results = await runAutomation({ context: testContext(paths, notion, config()), definition: definition(paths), trigger: "Manual", at: "2026-11-14T10:00:00.000Z", request: null, writer, agents })
  assert.match(results[0]!.detail, /queued for Notion/u)
  assert.equal(fs.readdirSync(outboxFolder(paths)).length, 1)
})

test("a manual run's title uses its start time; prompt text can't open or close the wrapper's tags", () => {
  assert.equal(runKey("AUT-7", "2026-11-14T10:03:59.900Z"), "AUT-7@2026-11-14T10:03Z")
  const prompt = renderPrompt({
    definition: { ...definition(tempHome()), title: 'Say "hi" <now>' },
    run: { id: "RUN-1", url: "u" },
    trigger: "Manual",
    at: "x",
    startedAt: "2026-11-14T10:00:00.000Z",
    instructions: null,
    previous: [],
  })
  assert.match(prompt, /title="Say &quot;hi&quot; &lt;now&gt;"/u)
  assert.match(prompt, /<trigger type="manual" started_at="2026-11-14T10:00:00.000Z"\/>/u)
  assert.doesNotMatch(prompt, /previous-runs|run-instructions/u)
})

test("a run left in progress by a stopped scheduler is marked Failed when the scheduler starts", async () => {
  const paths = tempHome()
  const { notion, writer, writes } = runsNotion()
  writeInflight(paths, { run: "run-page", id: "RUN-9", url: "u", key: "AUT-12@x", automation: "AUT-12", automationUrl: "a", title: "Acme", agent: "Claude Code", model: "claude-opus-5-5", effort: "high", trigger: "Scheduled", at: "2026-11-14T07:00:00.000Z", directory: "/tmp", startedAt: "2026-11-14T07:00:00.000Z", pid: 999_999_999, request: null })
  // The module's own writer goes to the real API; give it the fake through a stubbed fetch instead.
  const original = globalThis.fetch
  const sent: { url: string; body: string }[] = []
  globalThis.fetch = (async (url: string, init: { body?: string }) => {
    sent.push({ url, body: init.body ?? "" })
    return new Response(JSON.stringify({ id: "run-page" }), { status: 200 })
  }) as typeof fetch
  try {
    const out = path.join(paths.home, "alert.txt")
    const results = await automations.serve!.start!(testContext(paths, notion, config({ onFailure: `cat > ${out}` })))
    assert.equal(results[0]!.status, "failed")
    assert.match(results[0]!.detail, /RUN-9 marked Failed.*sent the alert/u)
    assert.match(fs.readFileSync(out, "utf8"), /"Acme" \(AUT-12\) failed: Notion Code's scheduler stopped/u)
  } finally {
    globalThis.fetch = original
  }
  assert.ok(sent.some((request) => request.url.endsWith("/pages/run-page") && request.body.includes('"Failed"')))
  assert.ok(sent.some((request) => request.url.endsWith("/pages/run-page/markdown") && request.body.includes("## Details") && request.body.includes("<td>Model</td>\\n<td>Opus 5.5</td>") && request.body.includes("## Result") && request.body.includes("scheduler stopped")), "a cut-off run gets the same page")
  assert.equal(readInflight(paths).length, 0)
  assert.equal(writes.length, 0)
  void writer
})

test("an agent's alert goes through the same command, marked as needing attention, with the whole message", async () => {
  const paths = tempHome()
  const out = path.join(paths.home, "alert.txt")
  const result = await alert(paths, `cat > ${out}; echo "$AUTOMATION_RUN_STATUS" >> ${out}`, {
    definition: { id: "AUT-18", title: "Acme publish holiday theme", url: "u", directory: "/tmp" },
    run: { id: "RUN-40", url: "r" },
    error: "The publish failed: someone must publish theme 123456789012 by hand.",
    session: null,
    status: "alert",
  })
  assert.equal(result, "onFailure command sent the alert")
  assert.equal(fs.readFileSync(out, "utf8"), 'Notion Code automation "Acme publish holiday theme" (AUT-18) needs attention: The publish failed: someone must publish theme 123456789012 by hand. Run RUN-40: r\nalert\n')
  assert.equal(await alert(paths, null, { definition: { id: "a", title: "t", url: "", directory: "/" }, run: null, error: "x", session: null }), "no onFailure command configured")
})

test("a broken manual request is set aside and never stops the scheduled automations", () => {
  const paths = tempHome()
  const folder = path.join(definitionsFolder(paths), "manual")
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, "bad.json"), '{"request":"x"}')
  fs.writeFileSync(path.join(definitionsFolder(paths), "AUT-12.json"), JSON.stringify(definition(paths)))
  const tasks = automations.tasks(testContext(paths, fakeNotion({}), config()))
  assert.deepEqual(tasks.map((task) => task.id), ["automations.sync", "AUT-12"])
  assert.equal(fs.existsSync(path.join(folder, "bad.json")), false)
  assert.equal(fs.readdirSync(path.join(paths.state, "backups/invalid")).length, 1)
})

test("a run's length reads naturally, and a late start says how late", () => {
  assert.deepEqual([duration(27_000), duration(240_000), duration(3_900_000)], ["27 s", "4 min", "1 h 5 min"])
  assert.deepEqual([count(412), count(1_234), count(22_519), count(1_250_000)], ["412", "1.2k", "22.5k", "1.3M"])
  const late = renderReport({ agent: "Codex", model: null, effort: null, session: null, folder: "~/x", usage: null, trigger: "Scheduled", at: "2026-11-15T07:00:00.000Z", startedAt: "2026-11-15T07:12:00.000Z", finishedAt: "2026-11-15T07:13:00.000Z", ok: false, reply: "", error: "boom" })
  assert.equal(late, "## Details\n\n<table header-row=\"false\">\n<tr>\n<td>Agent</td>\n<td>Codex</td>\n</tr>\n<tr>\n<td>Model</td>\n<td>–</td>\n</tr>\n<tr>\n<td>Effort</td>\n<td>–</td>\n</tr>\n<tr>\n<td>Trigger</td>\n<td>Scheduled, started 12 min late</td>\n</tr>\n<tr>\n<td>Duration</td>\n<td>1 min</td>\n</tr>\n<tr>\n<td>Cost</td>\n<td>–</td>\n</tr>\n<tr>\n<td>Tokens</td>\n<td>–</td>\n</tr>\n<tr>\n<td>Session</td>\n<td>–</td>\n</tr>\n<tr>\n<td>Folder</td>\n<td>`~/x`</td>\n</tr>\n</table>\n\n## Result\n\n**Failed:** boom\n", "a failed run has the same two sections and the same rows")
  assert.deepEqual(["claude-opus-5-5", "claude-fable-5-2", "gpt-6.1-sol", "gpt-6.1-terra-fast", "x/custom"].map(modelLabel), ["Opus 5.5", "Fable 5.2", "GPT-6.1 Sol", "GPT-6.1 Terra Fast", "x/custom"])
  const nested = renderReport({ agent: "Codex", model: null, effort: null, session: null, folder: "~/x", usage: null, trigger: "Manual", at: "", startedAt: "2026-11-15T07:00:00.000Z", finishedAt: "2026-11-15T07:00:05.000Z", ok: true, reply: "## Summary\nOK\n### Detail\nx", error: null })
  assert.match(nested, /## Result\n\n### Summary\nOK\n#### Detail\nx\n$/u, "the agent's headings sit under Result")
})
