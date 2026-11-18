import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import type { Paths } from "../shared/config.ts"
import { backup, hashDirectory, hashTree, lstat, readValid, stamp, writeJson } from "../shared/files.ts"
import type { Result } from "../shared/module.ts"
import type { Notion, NotionPage } from "../shared/notion.ts"
import { downloadSkill, isAutoInvoked, SkillName } from "./export.ts"

const SkillRecord = z.strictObject({
  page: z.string(),
  version: z.string().nullable(),
  edited: z.string().nullable(),
  autoInvoke: z.boolean(),
  /** The tree digest of what was written, or of the folder adopted because it already matched Notion. */
  hash: z.string(),
})

const SkillsState = z.strictObject({ version: z.literal(1), skills: z.record(SkillName, SkillRecord) })
type SkillsState = z.infer<typeof SkillsState>

interface Plan {
  name: string
  page: NotionPage
  version: string | null
  /** The staged folder, or null when Notion and the installed folder are both unchanged since the last sync. */
  directory: string | null
}

const statePath = (paths: Paths) => path.join(paths.state, "skills.json")

/** Reads every skill, downloading only those whose version, edit time or Auto-invoke changed, or whose folder drifted. */
async function readSkills(notion: Notion, dataSource: string, skills: string, state: SkillsState, staging: string): Promise<Plan[]> {
  const pages = (await notion.queryDataSource(dataSource)).filter((page) => !page.in_trash && !page.archived)
  if (pages.length === 0) throw new Error("the Notion Skills data source returned no pages")
  const byPage = new Map(Object.entries(state.skills).map(([name, record]) => [record.page, { name, record }]))
  const plans: Plan[] = []
  const names = new Set<string>()
  for (const page of pages) {
    const ref = await notion.getSkill(page.id)
    if (!ref) continue
    const version = ref.version_id ?? null
    const known = byPage.get(page.id)
    const unchanged =
      known &&
      version !== null &&
      known.record.version === version &&
      known.record.edited === (page.last_edited_time ?? null) &&
      known.record.autoInvoke === isAutoInvoked(page) &&
      hashDirectory(path.join(skills, known.name)) === known.record.hash
    const plan: Plan = unchanged
      ? { name: known.name, page, version, directory: null }
      : { ...(await downloadSkill(notion, page, ref, staging)), page, version }
    if (names.has(plan.name)) throw new Error(`two Notion skills export the same name, ${plan.name}`)
    names.add(plan.name)
    plans.push(plan)
  }
  if (names.size === 0) throw new Error("Notion exported no skills")
  return plans
}

/** Copies the staged folder beside the target, then swaps it in, so an agent never sees half a skill. */
function install(target: string, source: string): void {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${process.pid}`)
  const old = path.join(path.dirname(target), `.${path.basename(target)}.old-${process.pid}`)
  fs.rmSync(temporary, { recursive: true, force: true })
  fs.cpSync(source, temporary, { recursive: true })
  if (lstat(target)) fs.renameSync(target, old)
  fs.renameSync(temporary, target)
  fs.rmSync(old, { recursive: true, force: true })
}

/**
 * Notion's Skills library → ~/.agents/skills, one folder per skill. Every Notion read finishes before anything is
 * written; when any read fails, every skill stays as it is. A folder is written only when ntncode wrote it before,
 * or it doesn't exist; a folder that already matches Notion exactly is adopted as it is. Anything else is left alone
 * and reported. A skill removed from Notion moves to the backups, unless it was edited by hand.
 */
export async function syncSkills(notion: Notion, paths: Paths, dataSource: string, { dryRun = false, now = new Date() } = {}): Promise<Result[]> {
  const skills = path.join(paths.agents, "skills")
  const state = readValid(statePath(paths), SkillsState, { version: 1, skills: {} })
  const staging = path.join(paths.state, `staging-${process.pid}`)
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  const results: Result[] = []
  try {
    let plans: Plan[]
    try {
      plans = await readSkills(notion, dataSource, skills, state, staging)
    } catch (error) {
      return [{ status: "failed", path: skills, detail: `${(error as Error).message}; every skill kept as it is` }]
    }

    const desired = new Set(plans.map((plan) => plan.name))
    const next: SkillsState = { version: 1, skills: {} }
    if (!dryRun) fs.mkdirSync(skills, { recursive: true })
    for (const plan of plans) {
      const target = path.join(skills, plan.name)
      const record = { page: plan.page.id, version: plan.version, edited: plan.page.last_edited_time ?? null, autoInvoke: isAutoInvoked(plan.page) }
      if (!plan.directory) {
        next.skills[plan.name] = { ...record, hash: state.skills[plan.name]!.hash }
        results.push({ status: "unchanged", path: target, detail: "Notion and the folder unchanged since the last sync" })
        continue
      }
      const staged = hashTree(plan.directory)
      const stats = lstat(target)
      const current = hashDirectory(target)
      const known = state.skills[plan.name]
      if (current === staged) {
        next.skills[plan.name] = { ...record, hash: staged }
        results.push({ status: "unchanged", path: target, detail: known ? "already matches Notion" : "already matches Notion; adopted" })
        continue
      }
      if (stats && !stats.isDirectory()) {
        if (known) next.skills[plan.name] = known
        results.push({ status: "skipped", path: target, detail: `${stats.isSymbolicLink() ? "is a link" : "is a file"}, not a folder; left as it is` })
        continue
      }
      if (stats && !known) {
        results.push({ status: "skipped", path: target, detail: "a folder ntncode didn't write, and it differs from Notion; left as it is. Move it away to let ntncode write the skill" })
        continue
      }
      const editedByHand = !!stats && current !== known!.hash
      if (dryRun) {
        if (known) next.skills[plan.name] = known
        results.push({ status: "would write", path: target, detail: !stats ? "new skill" : editedByHand ? "replaces a hand edit (would back it up)" : "updated in Notion" })
        continue
      }
      let detail = !stats ? "new skill" : "updated from Notion"
      if (editedByHand) {
        const saved = path.join(paths.state, "backups", stamp(now), path.relative(paths.home, target))
        fs.cpSync(target, saved, { recursive: true })
        detail = `replaced a hand edit; the edited copy is in ${saved}`
      }
      install(target, plan.directory)
      next.skills[plan.name] = { ...record, hash: staged }
      results.push({ status: "written", path: target, detail })
    }

    for (const [name, record] of Object.entries(state.skills)) {
      if (desired.has(name)) continue
      const target = path.join(skills, name)
      const current = hashDirectory(target)
      if (current === null) continue
      if (current !== record.hash) {
        results.push({ status: "skipped", path: target, detail: "no longer in Notion, but edited by hand; left as it is" })
        continue
      }
      if (dryRun) {
        next.skills[name] = record
        results.push({ status: "would remove", path: target, detail: "no longer in Notion (would move it to the backups)" })
        continue
      }
      results.push({ status: "removed", path: target, detail: `no longer in Notion; moved to ${backup(paths, target, now)}` })
    }

    if (!dryRun) writeJson(statePath(paths), next)
    return results
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}
