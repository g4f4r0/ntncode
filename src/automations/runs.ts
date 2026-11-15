import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import { AgentName } from "../agents/index.ts"
import type { Paths } from "../shared/config.ts"
import { quarantine, readValid, writeJson } from "../shared/files.ts"
import type { Notion, NotionPage } from "../shared/notion.ts"
import type { NotionWriter } from "../shared/notion-writer.ts"
import { Reader } from "./row.ts"

/** A model ID as the Notion option names it: claude-opus-5-5 is Opus 5.5, gpt-6.1-sol is GPT-6.1 Sol. */
export function modelLabel(id: string): string {
  const claude = id.match(/^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)$/u)
  if (claude) return `${claude[1]![0]!.toUpperCase()}${claude[1]!.slice(1)} ${claude[2]}.${claude[3]}`
  const gpt = id.match(/^gpt-([\d.]+)((?:-[a-z]+)*)$/u)
  if (gpt) return `GPT-${gpt[1]}${gpt[2]!.split("-").filter(Boolean).map((word) => ` ${word[0]!.toUpperCase()}${word.slice(1)}`).join("")}`
  return id
}

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

  /** The row, with what runs it and where, so a run in progress already shows them. */
  async start(input: { key: string; automation: string; trigger: "Scheduled" | "Manual"; startedAt: string; agent: AgentName; model: string | null; effort: string | null; folder: string }): Promise<RunRow> {
    const page = await this.writer.createPage({
      parent: { data_source_id: this.dataSource },
      properties: {
        Title: { title: [{ text: { content: input.key } }] },
        Automation: { relation: [{ id: input.automation }] },
        Trigger: { select: { name: input.trigger } },
        Status: { status: { name: "In progress" } },
        Date: { date: { start: input.startedAt } },
        Agent: { select: { name: input.agent } },
        Model: { select: input.model ? { name: modelLabel(input.model) } : null },
        Effort: { select: input.effort ? { name: `${input.effort[0]!.toUpperCase()}${input.effort.slice(1)}` } : null },
        Folder: { rich_text: [{ text: { content: input.folder } }] },
      },
    })
    return this.toRow(page)
  }

  /** The reply as the page body; the status, the times, the session, and the numbers views can sum and chart. */
  async finish(run: string, input: Finish): Promise<void> {
    await this.writer.replaceMarkdown(run, input.markdown)
    const usage = input.usage ?? null
    await this.writer.updatePage(run, {
      properties: {
        Status: { status: { name: input.status } },
        Session: { rich_text: input.session ? [{ text: { content: input.session } }] : [] },
        Date: { date: { start: input.startedAt, end: input.finishedAt } },
        Duration: { number: Math.max(0, Math.round((Date.parse(input.finishedAt) - Date.parse(input.startedAt)) / 1000)) },
        Cost: { number: usage?.costUsd != null ? Math.round(usage.costUsd * 10_000) / 10_000 : null },
        "Input tokens": { number: usage ? usage.input : null },
        "Cached tokens": { number: usage ? usage.cached : null },
        "Output tokens": { number: usage ? usage.output : null },
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
  /** The agent's session ID; null or missing when there was none. */
  session?: string | null
  /** What the agent reported using; null or missing when it reported nothing. */
  usage?: { input: number; cached: number; output: number; costUsd: number | null } | null
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
  /** What ran, so a run cut off by a stopped scheduler explains its failure like any other. */
  agent: AgentName,
  model: z.string().nullable(),
  effort: z.string().nullable(),
  trigger: z.enum(["Scheduled", "Manual"]),
  at: z.string(),
  directory: z.string(),
  startedAt: z.string(),
  /** The scheduler process that started it. */
  pid: z.number().int(),
  request: z.string().nullable(),
})
export type Inflight = z.infer<typeof Inflight>

/** A Runs update that couldn't reach Notion, retried on every tick until it does. */
export const Outbox = z.strictObject({
  run: z.string(),
  id: z.string(),
  finish: z.strictObject({
    status: z.enum(["Completed", "Failed"]),
    startedAt: z.string(),
    finishedAt: z.string(),
    markdown: z.string(),
    session: z.string().nullable().optional(),
    usage: z.strictObject({ input: z.number(), cached: z.number(), output: z.number(), costUsd: z.number().nullable() }).nullable().optional(),
  }),
})

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
