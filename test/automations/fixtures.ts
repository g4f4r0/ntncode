import type { NotionPage } from "../../src/shared/notion.ts"

export const OWNER = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
export const BOT = "8b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e"
export const PROJECT = "9c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f"

export interface RowInput {
  n?: number
  page?: string
  title?: string
  status?: "Enabled" | "Disabled" | null
  owners?: string[]
  project?: string | null
  agent?: string | null
  model?: string
  effort?: string | null
  start?: string | null
  zone?: string | null
  repeat?: string | null
  every?: number | null
  days?: string[]
  monthDays?: string[]
  months?: string[]
  hours?: string[]
  minutes?: string[]
  occurrence?: string[]
  limit?: number | null
  until?: string | null
  editedBy?: string
  edited?: string
  trash?: boolean
}

const select = (name: string | null | undefined) => ({ type: "select", select: name ? { name } : null })
const multi = (names: string[] = []) => ({ type: "multi_select", multi_select: names.map((name) => ({ name })) })
const number = (value: number | null | undefined) => ({ type: "number", number: value ?? null })
const date = (start: string | null | undefined) => ({ type: "date", date: start ? { start, end: null, time_zone: null } : null })

/** An Automations row as Notion's API returns it. */
export function automationPage(input: RowInput = {}): NotionPage {
  const n = input.n ?? 12
  return {
    id: input.page ?? `3a7b8c9d-0e1f-4a2b-8c3d-${String(n).padStart(12, "0")}`,
    url: `https://app.notion.com/p/aut${n}`,
    in_trash: input.trash ?? false,
    last_edited_time: input.edited ?? "2026-11-14T08:00:00.000Z",
    last_edited_by: { id: input.editedBy ?? OWNER },
    properties: {
      ID: { type: "unique_id", unique_id: { prefix: "AUT", number: n } },
      Title: { type: "title", title: [{ plain_text: input.title ?? "Acme daily audit" }] },
      Owner: { type: "people", people: (input.owners ?? [OWNER]).map((id) => ({ object: "user", id })) },
      Project: { type: "relation", relation: input.project === null ? [] : [{ id: input.project ?? PROJECT }], has_more: false },
      Status: { type: "status", status: input.status === null ? null : { name: input.status ?? "Enabled" } },
      Agent: select(input.agent === undefined ? "Claude Code" : input.agent),
      Model: { type: "rich_text", rich_text: input.model ? [{ plain_text: input.model }] : [] },
      Effort: select(input.effort === undefined ? "High" : input.effort),
      Start: date(input.start === undefined ? "2026-11-15T08:00:00.000+01:00" : input.start),
      "Time zone": select(input.zone === undefined ? "Europe/Madrid" : input.zone),
      Repeat: select(input.repeat === undefined ? "Daily" : input.repeat),
      Every: number(input.every),
      Days: multi(input.days),
      "Days of month": multi(input.monthDays),
      Months: multi(input.months),
      Hours: multi(input.hours),
      Minutes: multi(input.minutes),
      Occurrence: multi(input.occurrence),
      Limit: number(input.limit),
      Until: date(input.until),
      Runs: { type: "relation", relation: [], has_more: false },
    },
  }
}

/** A Projects row with its Folder. */
export function projectPage(folder: string, name = "Acme"): NotionPage {
  return {
    id: PROJECT,
    url: "https://app.notion.com/p/acme",
    properties: { Name: { type: "title", title: [{ plain_text: name }] }, Folder: { type: "rich_text", rich_text: folder ? [{ plain_text: folder }] : [] } },
  }
}
