import fs from "node:fs"
import path from "node:path"
import { modules } from "./modules.ts"
import { defaultPaths, readConfig, readToken, withConfig, type Paths } from "./shared/config.ts"
import { acquireLock, writeAtomic } from "./shared/files.ts"
import { needsAttention, type Check, type Context, type Result } from "./shared/module.ts"
import { createNotion } from "./shared/notion.ts"

const USAGE = `ntncode: Notion Code, Notion as the source of truth for every coding agent.

  ntncode sync [--dry-run]   run every sync now: Notion instructions to AGENTS.md files, and the agents' links
  ntncode doctor             check that every agent reads the same files
  ntncode help

notion.json, in ~/.agents or a folder directly under the projects folder (~/projects unless the config says otherwise):
  { "instructions": "<Notion page ID or link>" }
Token: NOTION_ACCESS_TOKEN, from the environment or ~/.config/secrets.env.
Config: ~/.config/notion-code/config.json.
`

const show = (paths: Paths, file: string) => (file.startsWith(`${paths.home}/`) ? `~/${path.relative(paths.home, file)}` : file)

function context(paths: Paths, dryRun: boolean): Context | string {
  const token = readToken(paths.secrets)
  if (!token) return `No Notion token: set NOTION_ACCESS_TOKEN in the environment or in ${show(paths, paths.secrets)}.`
  const config = readConfig(paths.config)
  return { paths: withConfig(paths, config), config, notion: createNotion(token), dryRun, now: new Date() }
}

function printResults(paths: Paths, results: Result[]): void {
  const width = Math.max(0, ...results.map((result) => result.status.length))
  for (const result of results) console.log(`${result.status.padEnd(width)}  ${show(paths, result.path)}  ${result.detail}`)
}

async function sync(dryRun: boolean): Promise<number> {
  const paths = defaultPaths()
  const ready = context(paths, dryRun)
  if (typeof ready === "string") {
    console.error(ready)
    return 2
  }
  const lock = acquireLock(path.join(paths.state, "lock"))
  if (!lock) {
    console.log("Another sync is running; nothing done.")
    return 0
  }
  try {
    const results: Result[] = []
    for (const module of modules) for (const task of module.tasks()) results.push(...(await task.run(ready)))
    printResults(paths, results)
    const attention = results.filter(needsAttention).length
    const summary = `${ready.now.toISOString()} ${dryRun ? "dry run" : "sync"}: ${results.length} checked, ${attention} need attention`
    console.log(summary)
    if (!dryRun) {
      writeAtomic(path.join(paths.state, "last-run.json"), `${JSON.stringify({ at: ready.now.toISOString(), results }, null, 2)}\n`)
      const log = path.join(paths.state, "sync.log")
      if ((fs.statSync(log, { throwIfNoEntry: false })?.size ?? 0) > 1_000_000) fs.renameSync(log, `${log}.1`)
      const changes = results.filter((result) => result.status !== "unchanged").map((result) => `  ${result.status} ${result.path}: ${result.detail}`)
      fs.appendFileSync(log, `${[summary, ...changes].join("\n")}\n`)
    }
    return attention ? 1 : 0
  } finally {
    lock.release()
  }
}

async function doctor(): Promise<number> {
  const paths = defaultPaths()
  const checks: Check[] = []
  const token = readToken(paths.secrets)
  checks.push({ ok: !!token, name: "Notion token", detail: token ? "found" : `set NOTION_ACCESS_TOKEN in the environment or in ${show(paths, paths.secrets)}` })
  let config
  try {
    config = readConfig(paths.config)
    checks.push({ ok: true, name: show(paths, paths.config), detail: fs.existsSync(paths.config) ? "valid" : "absent; defaults apply" })
  } catch (error) {
    checks.push({ ok: false, name: show(paths, paths.config), detail: (error as Error).message })
  }
  if (token && config) {
    const ready: Context = { paths: withConfig(paths, config), config, notion: createNotion(token), dryRun: true, now: new Date() }
    for (const module of modules) checks.push(...((await module.checks?.(ready)) ?? []))
  }
  const width = Math.max(...checks.map((check) => check.name.length))
  for (const check of checks) console.log(`${check.ok ? "ok  " : "fail"}  ${check.name.padEnd(width)}  ${check.detail}`)
  return checks.every((check) => check.ok) ? 0 : 1
}

const [command, ...args] = process.argv.slice(2)
const fail = (error: Error) => {
  console.error(`ntncode: ${error.message}`)
  return 1
}
if (command === "sync") {
  const unknown = args.filter((arg) => arg !== "--dry-run")
  if (unknown.length) {
    console.error(`Unknown option ${unknown.join(" ")}\n\n${USAGE}`)
    process.exitCode = 2
  } else process.exitCode = await sync(args.includes("--dry-run")).catch(fail)
} else if (command === "doctor") {
  process.exitCode = await doctor().catch(fail)
} else {
  console[command === "help" || command === undefined ? "log" : "error"](USAGE)
  if (command !== "help" && command !== undefined) process.exitCode = 2
}
