import { show, SYNC_SCHEDULE, type Check, type Module } from "../shared/module.ts"
import { syncInstructions } from "./sync.ts"

/** Notion Instructions pages → AGENTS.md files: the Instructions data source's rows, or each notion.json's page. */
export const instructions: Module = {
  name: "instructions",
  tasks: () => [
    {
      id: "instructions.sync",
      kind: "sync",
      schedule: SYNC_SCHEDULE,
      since: null,
      run: (context) => syncInstructions(context.notion, context.paths, { source: context.config.instructions, dryRun: context.dryRun, now: context.now }),
    },
  ],
  async checks(context) {
    const { config, paths, notion, now } = context
    const checks: Check[] = []
    if (!config.instructions) checks.push({ ok: true, name: "instructions", detail: "from each notion.json; set \"instructions\": { \"source\": \"<Instructions data source ID>\" } to read the data source instead" })
    for (const result of await syncInstructions(notion, paths, { source: config.instructions, dryRun: true, now })) {
      if (result.status === "failed") checks.push({ ok: false, level: "error", name: `instructions ${show(paths, result.path)}`, detail: result.detail, fix: "fix the row in Notion's Instructions database" })
      else if (result.status === "skipped") checks.push({ ok: false, level: "warning", name: `instructions ${show(paths, result.path)}`, detail: result.detail })
      else checks.push({ ok: true, name: `instructions ${show(paths, result.path)}`, detail: `next sync: ${result.status}: ${result.detail}` })
    }
    return checks
  },
}
