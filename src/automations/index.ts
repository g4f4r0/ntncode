import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import { AGENTS } from "../agents/index.ts"
import { formatSchedule, parseSchedule } from "../scheduler/rrule.ts"
import { serveEnvNames, serveStatus, upcoming } from "../scheduler/serve.ts"
import { agentKey, agentOn, expandHome, isOn } from "../shared/config.ts"
import { quarantine, readValid, writeJson } from "../shared/files.ts"
import { show, SYNC_SCHEDULE, type Check, type Context, type Module, type Result, type Task } from "../shared/module.ts"
import type { Notion } from "../shared/notion.ts"
import { createNotionWriter } from "../shared/notion-writer.ts"
import { buildDefinition, Definition, definitionsFolder, readDefinitions, syncAutomations } from "./definitions.ts"
import { AUTOMATION_PROPERTIES, readRow, REQUIRED_OPTIONS, RUN_PROPERTIES, wallClock } from "./row.ts"
import { alert, renderReport, resultPath, resultsFolder, RunResult, runAutomation } from "./runner.ts"
import { clearInflight, flushOutbox, outboxFolder, readInflight, Runs } from "./runs.ts"

export { RunResult, resultPath }

/** A manual run waiting for the scheduler: written by `ntncode run`, removed once the run ends. */
const ManualRequest = z.strictObject({ request: z.string(), requestedAt: z.string(), definition: Definition })
const manualFolder = (paths: Context["paths"]) => path.join(definitionsFolder(paths), "manual")

/** iCalendar text for the minute of one moment, in UTC; schedules run on whole minutes. */
const once = (at: string) => `DTSTART:${new Date(at).toISOString().slice(0, 16).replaceAll("-", "").replaceAll(":", "")}00Z`

function manualTasks(context: Context): Task[] {
  const folder = manualFolder(context.paths)
  const tasks: Task[] = []
  for (const name of fs.existsSync(folder) ? fs.readdirSync(folder).filter((entry) => entry.endsWith(".json")) : []) {
    const file = path.join(folder, name)
    let request: z.infer<typeof ManualRequest>
    try {
      request = readValid(file, ManualRequest, null as never)
    } catch {
      // One broken request must never stop the scheduled automations.
      quarantine(context.paths, file)
      continue
    }
    tasks.push({
      id: `${request.definition.id}#${request.request}`,
      kind: "run",
      group: request.definition.id,
      schedule: once(request.requestedAt),
      since: null,
      runWhenOff: true,
      run: async (ready) => {
        try {
          return await runAutomation({ context: ready, definition: request.definition, trigger: "Manual", at: request.requestedAt, request: request.request })
        } finally {
          fs.rmSync(file, { force: true })
        }
      },
    })
  }
  return tasks
}

/** Stops daemon-owned sessions before another occurrence may run. Failed interruption keeps the record for retry. */
async function recoverRuns(context: Context, startup = false): Promise<Result[]> {
  if (!context.config.automations) return []
  const runs = new Runs(context.notion, createNotionWriter(context.token), context.config.automations.runs)
  const problems: string[] = []
  const inflights = readInflight(context.paths, problems)
  const results: Result[] = problems.map((detail): Result => ({ status: "failed", path: "runs", detail }))
  // This runs before the scheduler starts anything, so every run still on record was cut off by the last stop.
  for (const inflight of inflights) {
    if (!startup && !inflight.cleanupPending && inflight.pid === process.pid) continue
    if (inflight.session && AGENTS[inflight.agent].cancel) {
      try {
        await AGENTS[inflight.agent].cancel!(context.paths, inflight.session)
      } catch (failure) {
        results.push({ status: "failed", path: inflight.id, detail: `couldn't stop the hosted session; automation remains blocked: ${(failure as Error).message}` })
        continue
      }
    }
    if (inflight.cleanupPending) {
      clearInflight(context.paths, inflight.run)
      results.push({ status: "completed", path: inflight.id, detail: "stopped the hosted session left by a failed run" })
      continue
    }
    const finishedAt = new Date().toISOString()
    const error = "ntncode's scheduler stopped during the run (a restart or a crash), so the agent was stopped too"
    try {
      const markdown = renderReport({ agent: inflight.agent, ok: false, reply: "", error: `${error}.`, details: `run ${inflight.id} started ${inflight.startedAt}\nscheduler started again ${finishedAt}; no agent process left to report` })
      await runs.finish(inflight.run, { status: "Failed", startedAt: inflight.startedAt, finishedAt, markdown, session: inflight.session ?? null })
    } catch (failure) {
      results.push({ status: "failed", path: inflight.id, detail: `couldn't mark ${inflight.id} Failed: ${(failure as Error).message}` })
      continue
    }
    clearInflight(context.paths, inflight.run)
    if (inflight.request) {
      fs.rmSync(path.join(manualFolder(context.paths), `${inflight.request}.json`), { force: true })
      writeJson(resultPath(context.paths, inflight.request), RunResult.parse({ request: inflight.request, automation: inflight.automation, run: inflight.id, url: inflight.url, status: "Failed", error, report: null, session: inflight.session ?? null, resume: null }))
    }
    const definition = { id: inflight.automation, title: inflight.title, url: inflight.automationUrl, directory: inflight.directory }
    const alerted = await alert(context.paths, context.config.onFailure, { definition, run: { id: inflight.id, url: inflight.url }, error, session: null })
    results.push({ status: "failed", path: `${inflight.automation} ${inflight.title}`, detail: `${inflight.id} marked Failed: ${error}; ${alerted}` })
  }
  return results
}

/** Notion Automations rows → scheduled agent runs, each recorded in Runs. */
export const automations: Module = {
  name: "automations",
  tasks(context) {
    if (!context.config.automations) return []
    const sync: Task = {
      id: "automations.sync",
      kind: "sync",
      schedule: SYNC_SCHEDULE,
      since: null,
      run: (ready) => syncAutomations(ready.notion, ready.paths, ready.config, { dryRun: ready.dryRun, now: ready.now }),
    }
    const scheduled = readDefinitions(context.paths)
      .definitions.filter((definition) => definition.schedule)
      .map(
        (definition): Task => ({
          id: definition.id,
          kind: "run",
          schedule: definition.schedule!,
          since: definition.since,
          ...(agentOn(context.config, definition.agent) ? {} : { off: `${agentKey(definition.agent)} is turned off in the config` }),
          run: (ready, fire) => runAutomation({ context: ready, definition, trigger: "Scheduled", at: fire.at, request: null }),
        }),
      )
    const blocked = new Set(readInflight(context.paths).filter((run) => run.cleanupPending || run.pid !== process.pid).map((run) => run.automation))
    return [sync, ...scheduled, ...manualTasks(context)].filter((task) => task.kind === "sync" || !blocked.has(task.group ?? task.id))
  },

  serve: {
    /** A run still marked as started when the scheduler starts was cut off: it is marked Failed and alerted. */
    start: (context) => recoverRuns(context, true),
    /** Retries Runs updates Notion refused, and forgets manual results older than a day. */
    async tick(context) {
      if (!context.config.automations) return []
      const runs = new Runs(context.notion, createNotionWriter(context.token), context.config.automations.runs)
      const recovered = await recoverRuns(context)
      const left = await flushOutbox(context.paths, runs)
      // Manual results, and requests that never became a run, are forgotten after a day.
      for (const folder of [resultsFolder(context.paths), manualFolder(context.paths)]) {
        for (const name of fs.existsSync(folder) ? fs.readdirSync(folder) : []) {
          const file = path.join(folder, name)
          if (context.now.getTime() - fs.statSync(file).mtimeMs > 24 * 3_600_000) fs.rmSync(file, { force: true })
        }
      }
      return [...recovered, ...(left ? [{ status: "failed" as const, path: outboxFolder(context.paths), detail: `${left} Runs updates still waiting for Notion` }] : [])]
    },
  },

  checks: automationChecks,
}

/** Checks one data source has every property the code reads, with the right type and options. */
async function schemaChecks(notion: Notion, name: string, id: string, properties: Record<string, string>, options: Record<string, readonly string[]>): Promise<Check[]> {
  let source
  try {
    source = await notion.getDataSource(id)
  } catch (error) {
    return [{ ok: false, level: "error", name: `Notion ${name}`, detail: (error as Error).message, fix: `share the ${name} database with the token's integration, or fix its ID in the config` }]
  }
  const problems: string[] = []
  for (const [property, type] of Object.entries(properties)) {
    const found = source.properties[property]
    if (!found) problems.push(`${property} is missing (want ${type})`)
    else if (found.type !== type) problems.push(`${property} is ${found.type}, want ${type}`)
  }
  for (const [property, wanted] of Object.entries(options)) {
    const found = source.properties[property] as { type: string; [key: string]: unknown } | undefined
    const list = (found?.[found.type] as { options?: { name: string }[] } | undefined)?.options?.map((option) => option.name) ?? []
    const missing = wanted.filter((option) => !list.includes(option))
    if (found && missing.length) problems.push(`${property} lacks the option${missing.length > 1 ? "s" : ""} ${missing.join(", ")}`)
  }
  return [
    problems.length
      ? { ok: false, level: "error", name: `Notion ${name}`, detail: problems.join("; "), fix: `fix the ${name} database's properties in Notion to match` }
      : { ok: true, name: `Notion ${name}`, detail: `all ${Object.keys(properties).length} properties present` },
  ]
}

async function automationChecks(context: Context): Promise<Check[]> {
  const { config, paths, notion, now } = context
  if (!config.automations) return [{ ok: false, level: "warning", name: "automations", detail: "off: the config has no automations data sources", fix: 'set "automations": { "source": "<Automations data source ID>", "runs": "<Runs data source ID>" } in the config' }]
  const checks: Check[] = []
  try {
    const me = await notion.me()
    const tokenOwner = me.bot?.owner?.user?.id ?? null
    if (!config.assignee) checks.push({ ok: false, level: "error", name: "assignee", detail: "not set: no automation runs", fix: `set "assignee" in the config to your Notion user ID${tokenOwner ? `, ${tokenOwner} for this token` : ""}` })
    else if (tokenOwner && tokenOwner !== config.assignee) checks.push({ ok: false, level: "warning", name: "assignee", detail: `${config.assignee} isn't the token's owner (${tokenOwner}); only rows assigned to and last edited by ${config.assignee} run` })
    else checks.push({ ok: true, name: "assignee", detail: `${config.assignee}; API edits show as ${me.name ?? me.id} (${me.id}), so they never count as the assignee's` })
  } catch (error) {
    checks.push({ ok: false, level: "error", name: "Notion token", detail: (error as Error).message })
  }
  checks.push(...(await schemaChecks(notion, "Automations", config.automations.source, AUTOMATION_PROPERTIES, REQUIRED_OPTIONS.automations)))
  checks.push(...(await schemaChecks(notion, "Runs", config.automations.runs, RUN_PROPERTIES, REQUIRED_OPTIONS.runs)))

  const status = serveStatus(paths, now)
  checks.push(
    status.running
      ? { ok: true, name: "ntncode serve", detail: `running (pid ${status.pid}), last tick ${status.heartbeat}` }
      : { ok: false, level: "error", name: "ntncode serve", detail: status.heartbeat ? `not running; last tick ${status.heartbeat}` : "never ran: nothing is scheduled", fix: "systemctl --user enable --now ntncode.service" },
  )
  if (!config.onFailure) checks.push({ ok: false, level: "warning", name: "onFailure", detail: "not set: a failed run alerts no one", fix: 'set "onFailure" in the config to a command that sends the alert on its stdin' })
  else {
    const program = expandHome(paths.home, config.onFailure.trim().split(/\s+/u)[0]!)
    const found = !program.includes("/") || fs.existsSync(program)
    checks.push(found ? { ok: true, name: "onFailure", detail: config.onFailure } : { ok: false, level: "error", name: "onFailure", detail: `${program} doesn't exist` })
  }

  // What the next sync would do, without writing: every row that won't run says why.
  for (const result of await syncAutomations(notion, paths, config, { dryRun: true, now })) {
    if (result.status === "failed" || result.status === "skipped") checks.push({ ok: false, level: result.status === "failed" ? "error" : "warning", name: `automation ${show(paths, result.path)}`, detail: result.detail, fix: "fix the row in Notion; the assignee's own edit makes it runnable" })
    else if (result.status.startsWith("would")) checks.push({ ok: true, name: `automation ${show(paths, result.path)}`, detail: `next sync: ${result.status}: ${result.detail}` })
  }

  const { definitions, problems } = readDefinitions(paths)
  // Each agent an automation uses must be able to sign in from the scheduler's environment, not only from a shell.
  const env = serveEnvNames(paths)
  if (env) {
    const used = new Set(definitions.map((definition) => definition.agent))
    for (const agent of Object.entries(AGENTS).filter(([key, entry]) => used.has(key as keyof typeof AGENTS) && agentOn(config, key) && entry.binary(paths)).map(([, entry]) => entry)) {
      const name = agent.name
      for (const need of agent.envNeeds(paths)) {
        const ok = need.names.some((variable) => env.has(variable))
        checks.push(
          ok
            ? { ok, name: `${name} sign-in for runs`, detail: `the scheduler has ${need.names.find((variable) => env.has(variable))}` }
            : { ok, level: "error", name: `${name} sign-in for runs`, detail: `the scheduler's environment lacks ${need.names.join(" or ")}: ${need.why}`, fix: `add ${need.names[0]}=<value> to ~/.config/notion-code/agents.env (mode 600), then systemctl --user restart ntncode.service` },
        )
      }
    }
  }
  for (const problem of problems) checks.push({ ok: false, level: "error", name: show(paths, problem.path), detail: problem.detail })
  for (const definition of definitions) {
    const agent = AGENTS[definition.agent]
    const issues: string[] = []
    if (!agentOn(config, definition.agent)) {
      checks.push({ ok: true, name: `${definition.id} ${definition.title}`, detail: `${agentKey(definition.agent)} is turned off in the config, so each run is skipped` })
      continue
    }
    if (!agent.binary(paths)) issues.push(`${definition.agent} isn't installed`)
    if (!fs.existsSync(definition.directory)) issues.push(`${show(paths, definition.directory)} doesn't exist`)
    const next = definition.schedule ? upcoming({ schedule: definition.schedule }, now, 3) : []
    const local = next.map((at) => (definition.timeZone ? wallClock(Temporal.Instant.from(at).toZonedDateTimeISO(definition.timeZone)) : at))
    const where = definition.project ? show(paths, definition.directory) : "no project"
    const who = `${definition.agent}${definition.model ? ` ${definition.model}` : ""}${definition.effort ? ` ${definition.effort}` : ""}`
    checks.push({
      ok: issues.length === 0,
      ...(issues.length ? { level: "error" as const, fix: "install the agent or fix the project's Path or the Repository" } : {}),
      name: `${definition.id} ${definition.title}`,
      detail: `${issues.length ? `${issues.join("; ")}. ` : ""}${who}, ${where}; next: ${local.length ? `${local.join(", ")}${definition.timeZone ? ` ${definition.timeZone}` : " UTC"}` : "none, the schedule has ended"}`,
    })
  }
  const inflight = readInflight(paths)
  if (inflight.length) checks.push({ ok: true, name: "runs in progress", detail: inflight.map((entry) => `${entry.id} (${entry.automation}, since ${entry.startedAt})`).join("; ") })
  const outbox = fs.existsSync(outboxFolder(paths)) ? fs.readdirSync(outboxFolder(paths)).length : 0
  if (outbox) checks.push({ ok: false, level: "warning", name: "Runs outbox", detail: `${outbox} run results not yet in Notion; the scheduler retries them every tick` })
  return checks
}

/** An automation's ID, such as `AUT-12`; the row found by its number must have exactly this ID. */
const AutomationRef = z
  .string()
  .regex(/^[A-Za-z]+-\d+$/u, "must be an automation ID, such as AUT-12")
  .transform((value) => value.toUpperCase())

/**
 * Reads the row now, from Notion, so a Disabled row can run for a rehearsal, and queues it for the scheduler. An
 * Archived row never runs. The Assignee must be this installation's assignee, so `ntncode run` never runs someone else's
 * automation.
 */
export async function requestRun(context: Context, ref: string): Promise<{ request: string; definition: Definition }> {
  const { config, notion, paths } = context
  if (!config.automations) throw new Error('the config has no "automations" data sources')
  if (!isOn(config, "automations")) throw new Error('automations are turned off in the config ("automations": { "enabled": false })')
  if (!config.assignee) throw new Error('the config has no "assignee"')
  if (!serveStatus(paths).running) throw new Error("ntncode serve isn't running, so nothing would start the run; start it with systemctl --user enable --now ntncode.service")
  const wanted = AutomationRef.parse(ref)
  const number = Number(wanted.split("-")[1])
  const pages = (await notion.queryDataSource(config.automations.source, { filter: { property: "ID", unique_id: { equals: number } } })).filter((page) => !page.in_trash)
  if (!pages.length) throw new Error(`no automation ${ref.toUpperCase()} in Notion`)
  const page = pages[0]!
  // A manual run doesn't need a schedule, but a schedule that's set must be valid.
  let { row, issues } = readRow(page)
  if (!row) {
    const unscheduled = readRow(page, { schedule: false })
    if (!unscheduled.row) throw new Error(`${ref}: ${issues.join("; ")}`)
    row = unscheduled.row
  }
  if (row.id !== wanted) throw new Error(`no automation ${wanted} in Notion (${number} is ${row.id})`)
  if (row.status === "Archived") throw new Error(`${row.id} is Archived, so it never runs; set its Status to Disabled or Enabled to run it`)
  if (row.assignees.length !== 1 || row.assignees[0] !== config.assignee) throw new Error(`${row.id}: Assignee must be this installation's assignee, ${config.assignee}`)
  if (!agentOn(config, row.agent)) throw new Error(`${row.id} runs on ${row.agent}, which is turned off in the config ("agents": { "${agentKey(row.agent)}": { "enabled": false } })`)
  const now = new Date()
  const definition = await buildDefinition(notion, paths, page, row, { now, since: now.toISOString() })
  if (definition.schedule) definition.schedule = formatSchedule(parseSchedule(definition.schedule))
  const request = crypto.randomUUID()
  fs.mkdirSync(manualFolder(paths), { recursive: true })
  writeJson(path.join(manualFolder(paths), `${request}.json`), { request, requestedAt: now.toISOString(), definition })
  return { request, definition }
}
