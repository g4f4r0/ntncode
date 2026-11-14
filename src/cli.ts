// The ntncode command. It is written for agents first: every command prints exactly one JSON document on stdout
// (`serve` prints one JSON line per event), arguments are validated strictly, and every error says how to fix it.
import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"
import { ArtifactError, list, openBucket, publish, remove } from "./artifacts/publish.ts"
import { readDefinitions } from "./automations/definitions.ts"
import { requestRun, resultPath, RunResult } from "./automations/index.ts"
import { alert as sendAlert } from "./automations/runner.ts"
import { readInflight } from "./automations/runs.ts"
import { modules } from "./modules.ts"
import { appendLog, readSchedulerState, serve, serveStatus, upcoming } from "./scheduler/serve.ts"
import { defaultPaths, readConfig, readToken, withConfig, type Paths } from "./shared/config.ts"
import { acquireLock, readJson, writeAtomic } from "./shared/files.ts"
import { needsAttention, show, type Check, type Context, type Result } from "./shared/module.ts"
import { createNotion } from "./shared/notion.ts"

const VERSION = "0.3.0"

/** The commands, their options and what they print: `ntncode help` returns this, so an agent can learn the CLI. */
const COMMANDS = {
  sync: {
    usage: "ntncode sync [--dry-run] [--only instructions|skills|agents|automations]",
    does: "Runs every sync once now, under the sync lock: Notion instructions → AGENTS.md, Notion skills → ~/.agents/skills, the agents' links, and Notion automations → automation files.",
    prints: "{ ok, command, dryRun, results: [{ module, task, status, path, detail }], summary: { at, checked, attention } }",
  },
  doctor: {
    usage: "ntncode doctor",
    does: "Checks everything Notion Code depends on: the token and config, the Notion databases' properties, every agent's links and MCP servers (configured and signed in), the scheduler, and every automation with its next three runs.",
    prints: "{ ok, command, checks: [{ ok, level, name, detail, fix }], summary: { checks, errors, warnings } }",
  },
  serve: {
    usage: "ntncode serve",
    does: "Runs the scheduler until stopped: every sync every 10 minutes, and every automation on its schedule. Run it as the ntncode.service systemd unit.",
    prints: "one JSON line per event on stdout, also appended to <state>/serve.log",
  },
  run: {
    usage: "ntncode run <AUT-n> [--wait] [--timeout <seconds>]",
    does: "Starts one run of an automation now, read fresh from Notion, even while it's Disabled (for a rehearsal). The scheduler starts it; the command returns once the run is recorded in Runs, or, with --wait, once it ends.",
    prints: "{ ok, command, automation, title, request, run, url, status, error, report, session, resume }",
  },
  alert: {
    usage: 'ntncode alert "<message>"',
    does: "For an automation run: asks a person for attention now, through the config's onFailure command (an email, a push), with the run's details. Use it where a prompt says to report loudly; the run goes on.",
    prints: "{ ok, command, automation, run, result }",
  },
  "artifact publish": {
    usage: "ntncode artifact publish <file|folder> [--title <text>] [--project <folder> [--task <TSK-n>]]",
    does: "Publishes a file, or a folder with an index.html as a page, to the public artifacts bucket, at a link that never expires. A task's files go under <project>/<task>/, a project's other files under <project>/<YYYY-MM>/, everything else under <YYYY-MM>/. --title names it, in kebab case; anyone with the link can open it, so never publish secrets or private data.",
    prints: "{ ok, command, url, project, task, name, type, bytes, files, created }",
  },
  "artifact list": {
    usage: "ntncode artifact list [--project <folder> [--task <TSK-n>]] [--search <words>] [--limit <n>]",
    does: "Finds published artifacts, newest first: a project's or a task's, and those whose name, project or task has every word of --search. 50 by default.",
    prints: "{ ok, command, total, artifacts: [{ url, project, task, name, type, bytes, files, created }] }",
  },
  "artifact delete": {
    usage: "ntncode artifact delete <url>",
    does: "Deletes one artifact by its link: a file, or every file of a page. Refuses anything else in the bucket.",
    prints: "{ ok, command, url, deleted }",
  },
  status: {
    usage: "ntncode status",
    does: "Shows the scheduler, the runs in progress, and every scheduled automation with its last fire and next three runs. Reads only local files.",
    prints: "{ ok, command, serve, running, tasks: [{ id, title, agent, timeZone, last, next }] }",
  },
  help: { usage: "ntncode help", does: "Prints this.", prints: "{ ok, command, version, commands, exitCodes, files }" },
} as const

const EXIT = { ok: 0, attention: 1, usage: 2 } as const

class UsageError extends Error {}

function print(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function fail(command: string, error: unknown, fix?: string): number {
  const usage = error instanceof UsageError || error instanceof z.ZodError
  const message = error instanceof z.ZodError ? error.issues.map((issue) => `${issue.path.join(".") || "argument"}: ${issue.message}`).join("; ") : (error as Error).message
  print({ ok: false, command, error: { code: usage ? "usage" : "failed", message, ...(fix ? { fix } : {}) } })
  return usage ? EXIT.usage : EXIT.attention
}

/** The config, or a usage error naming the bad key. */
function config(paths: Paths) {
  try {
    return readConfig(paths.config)
  } catch (error) {
    throw new UsageError((error as Error).message)
  }
}

/** The paths, config and Notion client for a command; a usage error when the token or config is missing or bad. */
function context(paths: Paths, dryRun: boolean): Context {
  const token = readToken(paths.secrets)
  if (!token) throw new UsageError(`no Notion token: set NOTION_ACCESS_TOKEN in the environment or in ${show(paths, paths.secrets)}`)
  const settings = config(paths)
  return { paths: withConfig(paths, settings), config: settings, notion: createNotion(token), token, dryRun, now: new Date() }
}

async function sync(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { "dry-run": { type: "boolean" }, only: { type: "string" } }, strict: true, allowPositionals: false })
  const only = z.enum(["instructions", "skills", "agents", "automations"]).optional().parse(values.only)
  const paths = defaultPaths()
  const ready = context(paths, !!values["dry-run"])
  const lock = acquireLock(path.join(paths.state, "lock"))
  if (!lock) {
    print({ ok: true, command: "sync", dryRun: ready.dryRun, skipped: "another sync holds the lock; nothing done", results: [] })
    return EXIT.ok
  }
  try {
    const results: (Result & { module: string; task: string })[] = []
    for (const module of modules) {
      if (only && module.name !== only) continue
      for (const task of module.tasks(ready).filter((entry) => entry.kind === "sync")) {
        try {
          for (const result of await task.run(ready, { trigger: "Manual", at: ready.now.toISOString() })) results.push({ module: module.name, task: task.id, ...result, path: show(paths, result.path) })
        } catch (error) {
          results.push({ module: module.name, task: task.id, status: "failed", path: task.id, detail: (error as Error).message })
        }
      }
    }
    const attention = results.filter(needsAttention).length
    const summary = { at: ready.now.toISOString(), checked: results.length, attention }
    if (!ready.dryRun) {
      writeAtomic(path.join(paths.state, "last-run.json"), `${JSON.stringify({ ...summary, results }, null, 2)}\n`)
      const log = path.join(paths.state, "sync.log")
      if ((fs.statSync(log, { throwIfNoEntry: false })?.size ?? 0) > 1_000_000) fs.renameSync(log, `${log}.1`)
      fs.appendFileSync(log, `${JSON.stringify({ ...summary, changes: results.filter((result) => result.status !== "unchanged") })}\n`)
    }
    print({ ok: attention === 0, command: "sync", dryRun: ready.dryRun, results, summary })
    return attention ? EXIT.attention : EXIT.ok
  } finally {
    lock.release()
  }
}

async function doctor(args: string[]): Promise<number> {
  parseArgs({ args, options: {}, strict: true, allowPositionals: false })
  const paths = defaultPaths()
  const checks: Check[] = []
  const token = readToken(paths.secrets)
  checks.push(token ? { ok: true, name: "Notion token", detail: "found" } : { ok: false, level: "error", name: "Notion token", detail: "missing", fix: `set NOTION_ACCESS_TOKEN in the environment or in ${show(paths, paths.secrets)}` })
  let config
  try {
    config = readConfig(paths.config)
    checks.push({ ok: true, name: show(paths, paths.config), detail: fs.existsSync(paths.config) ? "valid" : "absent; defaults apply" })
  } catch (error) {
    checks.push({ ok: false, level: "error", name: show(paths, paths.config), detail: (error as Error).message, fix: "fix the key named in the message; `ntncode help` lists the config keys" })
  }
  if (token && config) {
    const ready: Context = { paths: withConfig(paths, config), config, notion: createNotion(token), token, dryRun: true, now: new Date() }
    const perModule = await Promise.all(
      modules.map(async (module): Promise<Check[]> => {
        try {
          return (await module.checks?.(ready)) ?? []
        } catch (error) {
          return [{ ok: false, level: "error", name: module.name, detail: `the check itself failed: ${(error as Error).message}` }]
        }
      }),
    )
    checks.push(...perModule.flat())
  }
  const normalized = checks.map((check) => ({ ok: check.ok, level: check.ok ? "ok" : (check.level ?? "error"), name: check.name, detail: check.detail, ...(check.fix && !check.ok ? { fix: check.fix } : {}) }))
  const errors = normalized.filter((check) => check.level === "error").length
  const warnings = normalized.filter((check) => check.level === "warning").length
  print({ ok: errors === 0, command: "doctor", checks: normalized, summary: { checks: normalized.length, errors, warnings } })
  return errors ? EXIT.attention : EXIT.ok
}

async function runServe(args: string[]): Promise<number> {
  parseArgs({ args, options: {}, strict: true, allowPositionals: false })
  const paths = defaultPaths()
  context(paths, false)
  const controller = new AbortController()
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => controller.abort())
  const log = (event: Record<string, unknown>) => {
    process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`)
    appendLog(paths, event)
  }
  log({ event: "serve", version: VERSION, pid: process.pid })
  await serve({ paths, modules, log, signal: controller.signal, load: (now) => ({ ...context(paths, false), now }) })
  log({ event: "stopped" })
  return EXIT.ok
}

async function run(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, options: { wait: { type: "boolean" }, timeout: { type: "string" } }, strict: true, allowPositionals: true })
  if (positionals.length !== 1) throw new UsageError("give exactly one automation ID, such as ntncode run AUT-12")
  const timeout = z.coerce.number().int().positive().default(values.wait ? 7_200 : 120).parse(values.timeout)
  const ready = context(defaultPaths(), false)
  const { request, definition } = await requestRun(ready, positionals[0]!)
  const file = resultPath(ready.paths, request)
  const deadline = Date.now() + timeout * 1_000
  let last: RunResult | null = null
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      // The scheduler may be mid-write; a result that doesn't read yet is read again on the next poll.
      const parsed = RunResult.safeParse((() => { try { return readJson(file, null) } catch { return null } })())
      if (parsed.success) {
        last = parsed.data
        if (last.status !== "In progress" || !values.wait) break
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  if (!last) return fail("run", new Error(`the scheduler didn't start ${definition.id} within ${timeout} s`), "check `ntncode status` and `journalctl --user -u ntncode`")
  const ended = last.status !== "In progress"
  const note = ended ? {} : { note: values.wait ? `still running after ${timeout} s; read the run in Notion` : "started; read the run in Notion, or run again with --wait" }
  print({ ok: last.status === "Completed" || (!ended && !values.wait), command: "run", title: definition.title, ...last, ...note })
  return last.status === "Completed" || (!ended && !values.wait) ? EXIT.ok : EXIT.attention
}

async function alertCommand(args: string[]): Promise<number> {
  const { positionals } = parseArgs({ args, options: {}, strict: true, allowPositionals: true })
  const message = z.string().trim().min(1, "give the message, such as ntncode alert \"The publish failed: …\"").parse(positionals.join(" "))
  const paths = defaultPaths()
  const settings = config(paths)
  const env = process.env
  const definition = { id: env.NTNCODE_AUTOMATION ?? "manual", title: env.NTNCODE_AUTOMATION_TITLE ?? "(not in an automation run)", url: env.NTNCODE_AUTOMATION_URL ?? "", directory: env.NTNCODE_DIRECTORY ?? process.cwd() }
  const run = env.NTNCODE_RUN ? { id: env.NTNCODE_RUN, url: env.NTNCODE_RUN_URL ?? "" } : null
  const result = await sendAlert(withConfig(paths, settings), settings.onFailure, { definition, run, error: message, session: null, status: "alert" })
  const ok = result.startsWith("onFailure command sent")
  print({ ok, command: "alert", automation: definition.id, run: run?.id ?? null, result })
  return ok ? EXIT.ok : EXIT.attention
}

async function artifact(args: string[]): Promise<number> {
  const [action, ...rest] = args
  const command = `artifact ${action ?? ""}`.trim()
  const paths = defaultPaths()
  const settings = config(paths)
  try {
    if (action === "publish") {
      const { values, positionals } = parseArgs({ args: rest, options: { title: { type: "string" }, project: { type: "string" }, task: { type: "string" } }, strict: true, allowPositionals: true })
      if (positionals.length !== 1) throw new UsageError("give exactly one file or folder, such as ntncode artifact publish ./report.png")
      const published = await publish({ source: positionals[0]!, ...values }, { paths: withConfig(paths, settings), config: settings, bucket: openBucket(paths, settings), now: new Date() })
      print({ ok: true, command, ...published })
      return EXIT.ok
    }
    if (action === "list") {
      const { values } = parseArgs({ args: rest, options: { project: { type: "string" }, task: { type: "string" }, search: { type: "string" }, limit: { type: "string" } }, strict: true, allowPositionals: false })
      const limit = z.coerce.number().int().positive().max(1_000).optional().parse(values.limit)
      const found = await list({ project: values.project, task: values.task, search: values.search, limit }, { config: settings, bucket: openBucket(paths, settings) })
      print({ ok: true, command, ...found })
      return EXIT.ok
    }
    if (action === "delete") {
      const { positionals } = parseArgs({ args: rest, options: {}, strict: true, allowPositionals: true })
      if (positionals.length !== 1) throw new UsageError("give exactly one link, such as ntncode artifact delete https://…/index.html")
      print({ ok: true, command, ...(await remove(positionals[0]!, { config: settings, bucket: openBucket(paths, settings) })) })
      return EXIT.ok
    }
    throw new UsageError("give publish, list or delete, such as ntncode artifact publish ./report.png")
  } catch (error) {
    if (!(error instanceof ArtifactError)) throw error
    return fail(command, error.usage ? new UsageError(error.message) : error, error.fix)
  }
}

async function status(args: string[]): Promise<number> {
  parseArgs({ args, options: {}, strict: true, allowPositionals: false })
  const paths = withConfig(defaultPaths(), config(defaultPaths()))
  const now = new Date()
  const scheduler = readSchedulerState(paths)
  const tasks = readDefinitions(paths).definitions.map((definition) => ({
    id: definition.id,
    title: definition.title,
    agent: definition.agent,
    timeZone: definition.timeZone,
    last: scheduler.tasks[definition.id]?.last ?? null,
    next: definition.schedule ? upcoming({ schedule: definition.schedule }, now, 3) : [],
  }))
  print({ ok: true, command: "status", serve: serveStatus(paths, now), running: readInflight(paths), tasks })
  return EXIT.ok
}

function help(): number {
  print({
    ok: true,
    command: "help",
    version: VERSION,
    about: "Notion Code (ntncode): Notion as the source of truth for every coding agent. Output is JSON, for agents.",
    commands: COMMANDS,
    exitCodes: { 0: "ok", 1: "needs attention: a failed or skipped result, a doctor error, or a failed run", 2: "usage: bad arguments, no token, or an invalid config" },
    files: {
      config: "~/.config/notion-code/config.json: { assignee, projects, skills, automations: { automations, runs, instructions }, onFailure, mcp, artifacts: { bucketUrl, publicUrl } }",
      notionJson: '~/.agents/notion.json and ~/projects/<folder>/notion.json: { "instructions": "<page ID or link>" }',
      token: "NOTION_ACCESS_TOKEN, and S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY for artifacts, from the environment or ~/.config/secrets.env",
      state: "~/.local/state/notion-code: state.json, skills.json, scheduler.json, automations/, runs/, outbox/, serve.log, sync.log, backups/",
    },
  })
  return EXIT.ok
}

const [command = "help", ...rest] = process.argv.slice(2)
const handlers: Record<string, (args: string[]) => Promise<number> | number> = { sync, doctor, serve: runServe, run, alert: alertCommand, artifact, status, help, "--help": help, "-h": help }
const handler = handlers[command]
if (!handler) process.exitCode = fail(command, new UsageError(`unknown command "${command}"; run ntncode help`))
else {
  try {
    process.exitCode = await handler(rest)
  } catch (error) {
    const code = (error as { code?: string }).code
    process.exitCode = fail(command, typeof code === "string" && code.startsWith("ERR_PARSE_ARGS") ? new UsageError((error as Error).message) : error)
  }
}
