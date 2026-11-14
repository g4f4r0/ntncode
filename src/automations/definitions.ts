import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import { AgentName, AGENTS, Effort } from "../agents/index.ts"
import type { Config, Paths } from "../shared/config.ts"
import { readValid, writeAtomic, writeJson } from "../shared/files.ts"
import { normalizeNotionMarkdown } from "../shared/markdown.ts"
import { show, type Result } from "../shared/module.ts"
import type { Notion, NotionPage } from "../shared/notion.ts"
import { getTitle } from "../shared/notion.ts"
import { Reader, readRow, type Row } from "./row.ts"

/**
 * An automation file: everything a run needs, so the scheduler reads files, not Notion. The sync writes one per
 * enabled row it accepts, in `<state>/automations/<ID>.json`, and removes it when the row stops being runnable.
 */
export const Definition = z.strictObject({
  format: z.literal(1),
  id: z.string().regex(/^[A-Z]+-\d+$/u),
  page: z.string(),
  url: z.string(),
  title: z.string().min(1),
  assignee: z.string(),
  agent: AgentName,
  model: z.string().nullable(),
  effort: Effort.nullable(),
  project: z.strictObject({ page: z.string(), name: z.string(), folder: z.string() }).nullable(),
  /** The folder the agent runs in: the project's, or the state's workspace for no project. */
  directory: z.string(),
  /** iCalendar text; null for a manual run of a row with no valid schedule. */
  schedule: z.string().nullable(),
  timeZone: z.string().nullable(),
  prompt: z.string().min(1),
  /** The row's last_edited_time when it was read. */
  edited: z.string(),
  /** When the sync last read the row; with `edited`, tells whether a same-minute edit could have been missed. */
  synced: z.string(),
  /**
   * No occurrence at or before this ever fires: the minute before the assignee's edit that made the row runnable, or that
   * last changed its schedule. A run due between that edit and the sync that reads it still fires.
   */
  since: z.iso.datetime(),
})
export type Definition = z.infer<typeof Definition>

/** Notion rounds last_edited_time down to the minute; trust it only when the last read ran well after that minute. */
const SETTLED_MS = 120_000

export const definitionsFolder = (paths: Paths) => path.join(paths.state, "automations")
const definitionPath = (paths: Paths, id: string) => path.join(definitionsFolder(paths), `${id}.json`)
export const instructionsPath = (paths: Paths) => path.join(definitionsFolder(paths), "instructions.md")
export const workspacePath = (paths: Paths) => path.join(paths.state, "workspace")

/** Every automation file, valid or not; a broken file is reported, never run. */
export function readDefinitions(paths: Paths): { definitions: Definition[]; problems: Result[] } {
  const folder = definitionsFolder(paths)
  const definitions: Definition[] = []
  const problems: Result[] = []
  for (const name of fs.existsSync(folder) ? fs.readdirSync(folder).sort() : []) {
    if (!/^[A-Z]+-\d+\.json$/u.test(name)) continue
    const file = path.join(folder, name)
    try {
      definitions.push(readValid(file, Definition, null as never))
    } catch (error) {
      problems.push({ status: "failed", path: file, detail: `${(error as Error).message}; not scheduled` })
    }
  }
  return { definitions, problems }
}

/** The page's Time zone, for showing run times. */
const zoneOf = (page: NotionPage) => new Reader(page.properties ?? {}).select("Time zone")

/**
 * A row's project folder: the Projects row's Folder, under the projects folder. It must exist, so a run never starts
 * somewhere unexpected.
 */
async function resolveProject(notion: Notion, paths: Paths, row: Row): Promise<{ project: Definition["project"]; directory: string }> {
  if (!row.projects.length) return { project: null, directory: workspacePath(paths) }
  const page = await notion.getPage(row.projects[0]!)
  const folder = new Reader(page.properties ?? {}).text("Folder")
  if (!folder) throw new Error(`Project: the project "${getTitle(page)}" has no Folder in Notion`)
  if (folder.includes("/") || folder.startsWith(".")) throw new Error(`Project: the project's Folder "${folder}" must be one folder name under ${show(paths, paths.projects)}`)
  const directory = path.join(paths.projects, folder)
  if (!fs.existsSync(directory)) throw new Error(`Project: ${show(paths, directory)} doesn't exist on this machine`)
  return { project: { page: page.id, name: getTitle(page), folder }, directory }
}

/** A row → its automation file's content, reading the project and the prompt. Throws with every problem at once. */
export async function buildDefinition(notion: Notion, paths: Paths, page: NotionPage, row: Row, { now, since }: { now: Date; since: string }): Promise<Definition> {
  const settings = AGENTS[row.agent].modelError(row.model)
  if (settings) throw new Error(`Model: ${settings}`)
  if (row.agent === "OpenCode" && row.effort && !row.model) throw new Error("Effort: OpenCode sets effort through the model, so set Model too")
  const { project, directory } = await resolveProject(notion, paths, row)
  const prompt = normalizeNotionMarkdown(await notion.getPageMarkdown(page.id)).trim()
  if (!prompt) throw new Error("the page body, the prompt, is empty")
  return {
    format: 1,
    id: row.id,
    page: row.page,
    url: row.url,
    title: row.title,
    assignee: row.assignees[0] ?? "",
    agent: row.agent,
    model: row.model,
    effort: row.effort,
    project,
    directory,
    schedule: row.schedule,
    timeZone: zoneOf(page),
    prompt,
    edited: row.edited,
    synced: now.toISOString(),
    since,
  }
}

/**
 * Enabled Notion rows → automation files. A row becomes runnable, or changes what it runs, only when its Assignee is
 * this installation's assignee and the assignee made its last edit; otherwise the previous file stays. Disabling always
 * takes effect, whoever made it. Every Notion read finishes before anything is written.
 */
export async function syncAutomations(notion: Notion, paths: Paths, config: Config, { dryRun = false, now = new Date() } = {}): Promise<Result[]> {
  const folder = definitionsFolder(paths)
  if (!config.automations) return []
  if (!config.assignee) return [{ status: "failed", path: folder, detail: 'the config has no "assignee": no automation runs without one' }]
  const assignee = config.assignee
  const results: Result[] = []
  const { definitions, problems } = readDefinitions(paths)
  results.push(...problems)
  const existing = new Map(definitions.map((definition) => [definition.page, definition]))

  let pages: NotionPage[]
  let instructions: string | null = null
  try {
    pages = await notion.queryDataSource(config.automations.automations, { filter: { property: "Assignee", people: { contains: assignee } } })
    if (config.automations.instructions) instructions = normalizeNotionMarkdown(await notion.getPageMarkdown(config.automations.instructions)).trim()
  } catch (error) {
    return [...results, { status: "failed", path: folder, detail: `${(error as Error).message}; every automation kept as it is` }]
  }

  const writes = new Map<string, Definition>()
  const removals = new Map<string, string>()
  const seen = new Set<string>()
  for (const page of pages) {
    seen.add(page.id)
    const known = existing.get(page.id)
    const { row, issues, id, title } = readRow(page)
    const label = `${id ?? page.id} ${title}`.trim()
    const where = known ? definitionPath(paths, known.id) : definitionPath(paths, id ?? page.id)
    const status = row?.status ?? new Reader(page.properties ?? {}).status("Status")
    if (page.in_trash || status !== "Enabled") {
      if (known) removals.set(known.id, `${label}: ${page.in_trash ? "in Notion's trash" : `Status is ${status ?? "empty"}`}; no longer scheduled`)
      continue
    }
    if (!row) {
      results.push({ status: "failed", path: where, detail: `${label}: ${issues.join("; ")}${known ? "; the previous version stays scheduled" : "; not scheduled"}` })
      continue
    }
    if (row.assignees.length !== 1) {
      results.push({ status: "failed", path: where, detail: `${label}: Assignee must be exactly one person: two installations would race to run it${known ? "; the previous version stays scheduled" : "; not scheduled"}` })
      continue
    }
    if (known && known.id !== row.id) removals.set(known.id, `${label}: its ID changed to ${row.id}`)
    const settled = !!known && Date.parse(known.synced) - Date.parse(row.edited) > SETTLED_MS
    if (known && known.id === row.id && known.edited === row.edited && settled) {
      results.push({ status: "unchanged", path: where, detail: `${label}: not edited since the last sync` })
      continue
    }
    if (row.editedBy !== assignee) {
      const who = row.editedBy ? `user ${row.editedBy}` : "an unknown user"
      results.push({
        status: "skipped",
        path: where,
        detail: `${label}: last edited by ${who}, not the assignee; ${known ? "the previous version stays scheduled" : "not scheduled"} until the assignee edits it (setting Status counts)`,
      })
      continue
    }
    // An edit that makes a row runnable, or changes when it runs, counts from the assignee's edit, not from this sync, and
    // never fires a time before it.
    const editMinute = new Date(Math.min(now.getTime(), Date.parse(row.edited) || now.getTime()) - 1).toISOString()
    const since = known && known.schedule === row.schedule ? known.since : editMinute
    try {
      writes.set(row.id, await buildDefinition(notion, paths, page, row, { now, since }))
    } catch (error) {
      results.push({ status: "failed", path: where, detail: `${label}: ${(error as Error).message}${known ? "; the previous version stays scheduled" : "; not scheduled"}` })
    }
  }
  for (const definition of definitions) {
    if (!seen.has(definition.page)) removals.set(definition.id, `${definition.id} ${definition.title}: no longer assigned to this installation's assignee in Notion; no longer scheduled`)
  }

  for (const [id, detail] of removals) {
    if (writes.has(id)) continue
    const file = definitionPath(paths, id)
    if (dryRun) results.push({ status: "would remove", path: file, detail })
    else {
      fs.rmSync(file, { force: true })
      results.push({ status: "removed", path: file, detail })
    }
  }
  for (const [id, definition] of writes) {
    const file = definitionPath(paths, id)
    const before = existing.get(definition.page)
    const changed = !before || JSON.stringify({ ...before, synced: "", edited: "" }) !== JSON.stringify({ ...definition, synced: "", edited: "" })
    if (dryRun) {
      results.push({ status: changed ? "would write" : "unchanged", path: file, detail: `${id} ${definition.title}: ${before ? "updated in Notion" : "newly enabled"}` })
      continue
    }
    fs.mkdirSync(folder, { recursive: true })
    writeJson(file, definition)
    results.push({ status: changed ? "written" : "unchanged", path: file, detail: `${id} ${definition.title}: ${!before ? "newly scheduled" : changed ? "updated from Notion" : "read again; no change"}` })
  }
  if (!dryRun && instructions !== null) {
    const file = instructionsPath(paths)
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== `${instructions}\n`) {
      writeAtomic(file, `${instructions}\n`)
      results.push({ status: "written", path: file, detail: "the instructions every run gets, updated from Notion" })
    }
  }
  if (!dryRun) fs.mkdirSync(workspacePath(paths), { recursive: true })
  return results
}
