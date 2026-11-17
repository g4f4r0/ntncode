import fs from "node:fs"
import path from "node:path"
import { agentOn } from "../shared/config.ts"
import { show, SYNC_SCHEDULE, type Check, type Context, type Module } from "../shared/module.ts"
import { findMappings, sourceMappings, syncInstructions } from "./sync.ts"

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
    if (config.instructions) checks.push(...(await markerChecks(context, config.instructions)))
    return checks
  },
}

/**
 * With an Instructions source, each notion.json is only Codex's project-root marker: a project folder without one hides
 * its AGENTS.md from Codex, and one without a Project row is no longer synced.
 */
async function markerChecks({ notion, paths, config }: Context, source: string): Promise<Check[]> {
  let written: Awaited<ReturnType<typeof sourceMappings>>["mappings"]
  try {
    written = (await sourceMappings(notion, paths, source)).mappings
  } catch {
    return [] // the dry-run sync already reported it
  }
  const checks: Check[] = []
  const targets = new Set(written.map((mapping) => mapping.target))
  if (agentOn(config, "Codex")) {
    for (const mapping of written) {
      const folder = path.dirname(mapping.target)
      if (folder === paths.agents || fs.existsSync(path.join(folder, "notion.json"))) continue
      checks.push({
        ok: false,
        level: "warning",
        name: `Codex marker ${show(paths, folder)}`,
        detail: "no notion.json, and Codex finds a project's root by it, so Codex sessions here miss this AGENTS.md",
        fix: `echo '{ "instructions": "${mapping.page}" }' > ${show(paths, path.join(folder, "notion.json"))}`,
      })
    }
  }
  for (const mapping of findMappings(paths).mappings) {
    if (targets.has(mapping.target)) continue
    checks.push({ ok: false, level: "warning", name: `instructions ${show(paths, mapping.target)}`, detail: `${show(paths, mapping.source)} has no Instructions row, so this file is no longer synced`, fix: "add a Project row for it to the Instructions database, or delete the notion.json" })
  }
  return checks
}
