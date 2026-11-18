import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import { describeIssues, type Paths } from "../shared/config.ts"
import { hash, lstat, readJson, writeAtomic } from "../shared/files.ts"
import { normalizeNotionMarkdown } from "../shared/markdown.ts"
import type { Result } from "../shared/module.ts"
import { getTitle, type Notion } from "../shared/notion.ts"
import { projectFolder } from "../shared/projects.ts"
import { readInstructionRows } from "../shared/instructions.ts"

/** Every file this tool writes starts with this; a file without it is never overwritten. */
export const HEADER_PREFIX = "<!-- Synced from Notion"

interface FileState {
  page: string
  /** The page's last_edited_time at the sync. Notion rounds it to the minute. */
  edited: string
  /** When the file was last checked against Notion. */
  synced: string
  hash: string
  /** The FORMAT the file was written in. */
  format?: number
}

/**
 * How files are written: the header and the markdown conversion. Bump it whenever either changes, so every file is
 * written again on the next sync even though its page wasn't edited.
 */
export const FORMAT = 3

/** Notion rounds last_edited_time down to the minute; trust it only when the last sync ran well after that minute. */
const SETTLED_MS = 120_000

interface State {
  version: 1
  files: Record<string, FileState>
}

/** A Notion page ID from an ID or a link, in its dashed form; null when there is none. */
export function parsePageId(value: unknown): string | null {
  if (typeof value !== "string") return null
  // A link's ?v= is a view and #… a block: only the path names the page. An ID must stand alone, so a title slug
  // ending in a hex letter ("Acme-<id>") does not run into it.
  const text = value.trim().toLowerCase().split(/[?#]/u)[0]!
  const matches = text.match(/(?<![0-9a-f])(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-f])/gu)
  const id = matches?.at(-1)?.replaceAll("-", "")
  return id ? `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}` : null
}

/** A notion.json: the one page whose markdown becomes the AGENTS.md beside it. */
export const NotionJson = z.strictObject({
  instructions: z.string().transform((value, context) => {
    const page = parsePageId(value)
    if (!page) context.addIssue({ code: "custom", message: "must be a Notion page ID or link" })
    return page ?? ""
  }),
})

interface Mapping {
  /** The notion.json, or the Instructions row's link. */
  source: string
  /** The AGENTS.md beside it. */
  target: string
  page: string
}

/** The notion.json files: ~/.agents/notion.json and <projects folder>/<folder>/notion.json, nowhere else. */
export function findMappings(paths: Paths): { mappings: Mapping[]; problems: Result[] } {
  const sources = [path.join(paths.agents, "notion.json")]
  const entries = lstat(paths.projects)?.isDirectory() ? fs.readdirSync(paths.projects, { withFileTypes: true }) : []
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.isDirectory()) sources.push(path.join(paths.projects, entry.name, "notion.json"))
  }

  const mappings: Mapping[] = []
  const problems: Result[] = []
  for (const source of sources) {
    const stats = lstat(source)
    if (!stats) continue
    const target = path.join(path.dirname(source), "AGENTS.md")
    const fail = (detail: string) => problems.push({ status: "failed", path: target, detail: `${source}: ${detail}` })
    if (!stats.isFile()) {
      fail("not a regular file")
      continue
    }
    let value: unknown
    try {
      value = JSON.parse(fs.readFileSync(source, "utf8"))
    } catch (error) {
      fail(`not valid JSON (${(error as Error).message})`)
      continue
    }
    const parsed = NotionJson.safeParse(value)
    if (!parsed.success) {
      fail(`${describeIssues(parsed.error)}; expected { "instructions": "<Notion page ID or link>" }`)
      continue
    }
    const page = parsed.data.instructions
    mappings.push({ source, target, page })
  }
  return { mappings, problems }
}

/**
 * The Instructions data source's rows: its one Global row becomes ~/.agents/AGENTS.md and each Project row the AGENTS.md
 * in its project's Path. Automations rows are for runs, not files. A row that can't be placed is reported, never guessed.
 */
export async function sourceMappings(notion: Notion, paths: Paths, source: string): Promise<{ mappings: Mapping[]; problems: Result[] }> {
  const rows = await readInstructionRows(notion, source)
  const candidates: Mapping[] = []
  const problems: Result[] = []
  const fail = (where: string, label: string, detail: string) => problems.push({ status: "failed", path: where, detail: `${label}: ${detail}; not written` })
  const globals = rows.filter((row) => row.type === "Global")
  for (const row of rows) {
    const label = `Instructions "${row.title}"`
    const where = row.url ?? row.page
    if (row.issues.length) fail(where, label, row.issues.join("; "))
    else if (row.type === "Global") {
      if (globals.length > 1) fail(path.join(paths.agents, "AGENTS.md"), label, `one of ${globals.length} Global rows; keep one`)
      else if (row.projects.length) fail(where, label, "a Global row names no Project")
      else candidates.push({ source: where, target: path.join(paths.agents, "AGENTS.md"), page: row.page })
    } else if (row.type === "Project") {
      if (row.projects.length !== 1) {
        fail(where, label, `Project must name exactly one project, not ${row.projects.length}`)
        continue
      }
      try {
        const { directory } = await projectFolder(notion, paths, row.projects[0]!)
        candidates.push({ source: where, target: path.join(directory, "AGENTS.md"), page: row.page })
      } catch (error) {
        fail(where, label, (error as Error).message)
      }
    }
  }
  const counts = new Map<string, number>()
  for (const { target } of candidates) counts.set(target, (counts.get(target) ?? 0) + 1)
  const mappings = candidates.filter((mapping) => {
    if (counts.get(mapping.target) === 1) return true
    problems.push({ status: "failed", path: mapping.target, detail: `${mapping.source}: ${counts.get(mapping.target)} Instructions rows write this file; keep one; not written` })
    return false
  })
  return { mappings, problems }
}

function header(title: string, url: string | undefined): string {
  const name = title ? `"${title.replaceAll("--", "-")}"` : "a page"
  return `${HEADER_PREFIX}: ${name}${url ? ` (${url})` : ""}. Edit it in Notion; ntncode replaces this file on every sync. -->`
}

interface Planned {
  mapping: Mapping
  content: string
  edited: string
  /** The file is ours but was edited since it was written: back it up before replacing it. */
  editedByHand: boolean
}

/**
 * Writes each Instructions page to its AGENTS.md: from the Instructions data source when the config names one, else
 * each notion.json's page beside it. Every Notion read finishes before anything is written.
 * A file is never overwritten unless it starts with the header, never written through a link, and never deleted;
 * when Notion fails for a page, its file keeps its last good copy.
 */
export async function syncInstructions(notion: Notion, paths: Paths, { source = null as string | null, dryRun = false, now = new Date() } = {}): Promise<Result[]> {
  const statePath = path.join(paths.state, "state.json")
  const state = readJson<State>(statePath, { version: 1, files: {} })
  let found: { mappings: Mapping[]; problems: Result[] }
  try {
    found = source ? await sourceMappings(notion, paths, source) : findMappings(paths)
  } catch (error) {
    return [{ status: "failed", path: source!, detail: `couldn't read the Instructions data source: ${(error as Error).message}; every file kept as it is` }]
  }
  const { mappings, problems } = found
  const results: Result[] = [...problems]
  const planned: Planned[] = []

  for (const mapping of mappings) {
    const { target } = mapping
    const stats = lstat(target)
    if (stats && !stats.isFile()) {
      results.push({ status: "skipped", path: target, detail: `${stats.isSymbolicLink() ? "is a link" : "is not a regular file"}; left as it is` })
      continue
    }
    const current = stats ? fs.readFileSync(target, "utf8") : null
    if (current !== null && !current.startsWith(HEADER_PREFIX)) {
      results.push({ status: "skipped", path: target, detail: `written by hand (no "${HEADER_PREFIX}" first line); left as it is` })
      continue
    }

    try {
      const page = await notion.getPage(mapping.page)
      if (page.in_trash || page.archived) throw new Error("the page is in Notion's trash")
      const edited = page.last_edited_time ?? ""
      const known = state.files[target]
      const currentHash = current === null ? null : hash(current)
      const settled = !!known && Date.parse(known.synced) - Date.parse(edited) > SETTLED_MS
      if (known && known.page === mapping.page && known.format === FORMAT && edited && known.edited === edited && known.hash === currentHash && settled) {
        results.push({ status: "unchanged", path: target, detail: `Notion "${getTitle(page)}" not edited since the last sync` })
        continue
      }
      const text = normalizeNotionMarkdown(await notion.getPageMarkdown(mapping.page)).trim()
      if (!text) throw new Error("the page is empty")
      const content = `${header(getTitle(page), page.url)}\n\n${text}\n`
      // Ours by its header, but not what was last written (or no record of it): keep a copy before replacing it.
      const editedByHand = current !== null && current !== content && (!known || known.hash !== currentHash)
      planned.push({ mapping, content, edited, editedByHand })
    } catch (error) {
      results.push({ status: "failed", path: target, detail: `${(error as Error).message}; kept the file as it is` })
    }
  }

  const stamp = now.toISOString().replaceAll(":", "-")
  for (const { mapping, content, edited, editedByHand } of planned) {
    const { target } = mapping
    const current = lstat(target) ? fs.readFileSync(target, "utf8") : null
    if (current === content) {
      results.push({ status: "unchanged", path: target, detail: "content already matches Notion" })
    } else if (dryRun) {
      results.push({ status: "would write", path: target, detail: current === null ? "new file" : editedByHand ? "replaces a hand edit (would back it up)" : "updated in Notion" })
      continue
    } else {
      let detail = current === null ? "new file" : "updated from Notion"
      if (editedByHand) {
        const backup = path.join(paths.state, "backups", stamp, path.relative(paths.home, target))
        fs.mkdirSync(path.dirname(backup), { recursive: true })
        fs.copyFileSync(target, backup)
        detail = `replaced a hand edit; the edited copy is in ${backup}`
      }
      writeAtomic(target, content)
      results.push({ status: "written", path: target, detail })
    }
    state.files[target] = { page: mapping.page, edited, synced: now.toISOString(), hash: hash(content), format: FORMAT }
  }

  if (!dryRun) {
    fs.mkdirSync(paths.state, { recursive: true })
    writeAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`)
  }
  return results
}
