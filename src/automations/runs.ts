import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import type { Paths } from "../shared/config.ts"
import { quarantine, readValid, writeJson } from "../shared/files.ts"
import type { Notion, NotionPage } from "../shared/notion.ts"
import type { NotionWriter } from "../shared/notion-writer.ts"
import { Reader } from "./row.ts"

/** A run's Title: the automation's ID and the minute it was scheduled for (or started, by hand), in UTC. */
export function runKey(id: string, at: string): string {
  return `${id}@${new Date(at).toISOString().slice(0, 16)}Z`
}

export interface RunRow {
  page: string
  id: string
  url: string
}

/** The Runs rows, written only here. */
export class Runs {
  private readonly notion: Notion
  private readonly writer: NotionWriter
  private readonly dataSource: string
  constructor(notion: Notion, writer: NotionWriter, dataSource: string) {
    this.notion = notion
    this.writer = writer
    this.dataSource = dataSource
  }

  /**
   * The scheduled run already recorded for this key, so a scheduled time never runs twice, whatever the state files
   * say. A manual run in the same minute doesn't count.
   */
  async find(key: string): Promise<RunRow | null> {
    const pages = await this.notion.queryDataSource(this.dataSource, {
      filter: { and: [{ property: "Title", title: { equals: key } }, { property: "Trigger", select: { equals: "Scheduled" } }] },
      page_size: 1,
    })
    const page = pages.find((entry) => !entry.in_trash)
    return page ? this.toRow(page) : null
  }

  async start(input: { key: string; automation: string; trigger: "Scheduled" | "Manual"; startedAt: string }): Promise<RunRow> {
    const page = await this.writer.createPage({
      parent: { data_source_id: this.dataSource },
      properties: {
        Title: { title: [{ text: { content: input.key } }] },
        Automation: { relation: [{ id: input.automation }] },
        Trigger: { select: { name: input.trigger } },
        Status: { status: { name: "In progress" } },
        Date: { date: { start: input.startedAt } },
      },
    })
    return this.toRow(page)
  }

  async finish(run: string, input: Finish): Promise<void> {
    await this.writer.replaceMarkdown(run, input.markdown)
    await this.writer.updatePage(run, {
      properties: {
        Status: { status: { name: input.status } },
        Date: { date: { start: input.startedAt, end: input.finishedAt } },
      },
    })
  }

  /** The latest finished runs of an automation, newest first, with their reports. */
  async previous(automation: string, except: string, limit: number): Promise<{ id: string; status: string; started: string | null; finished: string | null; report: string }[]> {
    const pages = await this.notion.queryDataSource(this.dataSource, {
      filter: { and: [{ property: "Automation", relation: { contains: automation } }, { property: "Status", status: { does_not_equal: "In progress" } }] },
      sorts: [{ property: "Date", direction: "descending" }],
      page_size: limit + 1,
    })
    const out = []
    for (const page of pages.filter((entry) => entry.id !== except && !entry.in_trash).slice(0, limit)) {
      const read = new Reader(page.properties ?? {})
      const date = page.properties?.Date as { date?: { start?: string; end?: string | null } | null } | undefined
      out.push({
        id: read.uniqueId("ID") ?? page.id,
        status: read.status("Status") ?? "",
        started: date?.date?.start ?? null,
        finished: date?.date?.end ?? null,
        report: await this.notion.getPageMarkdown(page.id),
      })
    }
    return out
  }

  private toRow(page: NotionPage): RunRow {
    return { page: page.id, id: new Reader(page.properties ?? {}).uniqueId("ID") ?? page.id, url: page.url ?? "" }
  }
}

export interface Finish {
  status: "Completed" | "Failed"
  startedAt: string
  finishedAt: string
  markdown: string
}

/** A run that has started and not finished: on the next start, one left by a stopped scheduler is marked Failed. */
export const Inflight = z.strictObject({
  run: z.string(),
  id: z.string(),
  url: z.string(),
  key: z.string(),
  automation: z.string(),
  automationUrl: z.string(),
  title: z.string(),
  directory: z.string(),
  startedAt: z.string(),
  /** The scheduler process that started it. */
  pid: z.number().int(),
  request: z.string().nullable(),
})
export type Inflight = z.infer<typeof Inflight>

/** A Runs update that couldn't reach Notion, retried on every tick until it does. */
export const Outbox = z.strictObject({ run: z.string(), id: z.string(), finish: z.strictObject({ status: z.enum(["Completed", "Failed"]), startedAt: z.string(), finishedAt: z.string(), markdown: z.string() }) })

export const runsFolder = (paths: Paths) => path.join(paths.state, "runs")
export const outboxFolder = (paths: Paths) => path.join(paths.state, "outbox")

export function writeInflight(paths: Paths, inflight: Inflight): void {
  writeJson(path.join(runsFolder(paths), `${inflight.run}.json`), inflight)
}

export function clearInflight(paths: Paths, run: string): void {
  fs.rmSync(path.join(runsFolder(paths), `${run}.json`), { force: true })
}

/**
 * Every run in progress. A file that doesn't validate is skipped; given `problems`, as the scheduler does, it is also
 * moved aside and named there.
 */
export function readInflight(paths: Paths, problems?: string[]): Inflight[] {
  const folder = runsFolder(paths)
  const out: Inflight[] = []
  for (const name of fs.existsSync(folder) ? fs.readdirSync(folder).filter((entry) => entry.endsWith(".json")) : []) {
    const file = path.join(folder, name)
    try {
      out.push(readValid(file, Inflight, null as never))
    } catch (error) {
      if (problems) problems.push(`${(error as Error).message}; moved to ${quarantine(paths, file)}`)
    }
  }
  return out
}

export function queueOutbox(paths: Paths, entry: z.infer<typeof Outbox>): void {
  writeJson(path.join(outboxFolder(paths), `${entry.run}.json`), entry)
}

/** Sends every queued Runs update; each that still fails stays queued. Returns what's left. */
export async function flushOutbox(paths: Paths, runs: Runs): Promise<number> {
  const folder = outboxFolder(paths)
  let left = 0
  for (const name of fs.existsSync(folder) ? fs.readdirSync(folder).filter((entry) => entry.endsWith(".json")) : []) {
    const file = path.join(folder, name)
    let entry: z.infer<typeof Outbox>
    try {
      entry = readValid(file, Outbox, null as never)
    } catch {
      quarantine(paths, file)
      continue
    }
    try {
      await runs.finish(entry.run, entry.finish)
      fs.rmSync(file, { force: true })
    } catch {
      left += 1
    }
  }
  return left
}
