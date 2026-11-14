import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { acquireLock, writeAtomic } from "./files.ts"
import { createNotion } from "./notion.ts"
import { defaultPaths, ensureLinks, syncInstructions, type Result } from "./sync.ts"

const USAGE = `notion-agents: Notion → files every agent harness reads.

  notion-agents sync [--dry-run]   write each notion.json's page to the AGENTS.md beside it, and make the links
  notion-agents help

notion.json, in ~/.agents or a folder directly under ~/projects: { "instructions": "<Notion page ID or link>" }
Token: NOTION_ACCESS_TOKEN, from the environment or ~/.config/secrets.env.
`

/** NOTION_ACCESS_TOKEN from the environment, else from ~/.config/secrets.env. */
function readToken(home: string): string | null {
  if (process.env.NOTION_ACCESS_TOKEN) return process.env.NOTION_ACCESS_TOKEN.trim()
  const file = path.join(home, ".config/secrets.env")
  if (!fs.existsSync(file)) return null
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?NOTION_ACCESS_TOKEN\s*=\s*(.*?)\s*$/u)
    if (match) return match[1]!.replace(/^(["'])(.*)\1$/u, "$2") || null
  }
  return null
}

function print(results: Result[], home: string): void {
  const width = Math.max(...results.map((result) => result.status.length))
  for (const result of results) {
    const shown = result.path.startsWith(`${home}/`) ? `~/${path.relative(home, result.path)}` : result.path
    console.log(`${result.status.padEnd(width)}  ${shown}  ${result.detail}`)
  }
}

async function sync(dryRun: boolean): Promise<number> {
  const home = os.homedir()
  const paths = defaultPaths(home)
  const token = readToken(home)
  if (!token) {
    console.error("No Notion token: set NOTION_ACCESS_TOKEN in the environment or in ~/.config/secrets.env.")
    return 2
  }
  const lock = acquireLock(path.join(paths.state, "lock"))
  if (!lock) {
    console.log("Another sync is running; nothing done.")
    return 0
  }
  try {
    const started = new Date()
    const results = [...(await syncInstructions(createNotion(token), paths, { dryRun, now: started })), ...ensureLinks(paths, { dryRun })]
    print(results, home)
    const failed = results.filter((result) => result.status === "failed" || result.status === "skipped").length
    const summary = `${started.toISOString()} ${dryRun ? "dry run" : "sync"}: ${results.length} checked, ${failed} need attention`
    console.log(summary)
    if (!dryRun) {
      writeAtomic(path.join(paths.state, "last-run.json"), `${JSON.stringify({ at: started.toISOString(), results }, null, 2)}\n`)
      const log = path.join(paths.state, "sync.log")
      if ((fs.statSync(log, { throwIfNoEntry: false })?.size ?? 0) > 1_000_000) fs.renameSync(log, `${log}.1`)
      const changes = results.filter((result) => result.status !== "unchanged").map((result) => `  ${result.status} ${result.path}: ${result.detail}`)
      fs.appendFileSync(log, `${[summary, ...changes].join("\n")}\n`)
    }
    return failed ? 1 : 0
  } finally {
    lock.release()
  }
}

const [command, ...args] = process.argv.slice(2)
if (command === "sync") {
  const unknown = args.filter((arg) => arg !== "--dry-run")
  if (unknown.length) {
    console.error(`Unknown option ${unknown.join(" ")}\n\n${USAGE}`)
    process.exit(2)
  }
  process.exitCode = await sync(args.includes("--dry-run")).catch((error: Error) => {
    console.error(`notion-agents: ${error.message}`)
    return 1
  })
} else {
  console[command === "help" || command === undefined ? "log" : "error"](USAGE)
  if (command !== "help" && command !== undefined) process.exitCode = 2
}
