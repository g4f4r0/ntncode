import { z } from "zod"
import { AgentName, Effort, modelId } from "../agents/index.ts"
import { formatSchedule, parseSchedule } from "../scheduler/rrule.ts"
import type { NotionPage, NotionProperty } from "../shared/notion.ts"
import { plainText } from "../shared/notion.ts"

/** The Automations data source's properties, by name and type. `doctor` checks Notion still has each one. */
export const AUTOMATION_PROPERTIES = {
  ID: "unique_id",
  Title: "title",
  Assignee: "people",
  Project: "relation",
  Status: "status",
  Agent: "select",
  Model: "select",
  Effort: "select",
  Start: "date",
  "Time zone": "select",
  Repeat: "select",
  Every: "number",
  Days: "multi_select",
  "Days of month": "multi_select",
  Months: "multi_select",
  Hours: "multi_select",
  Minutes: "multi_select",
  Occurrence: "multi_select",
  Limit: "number",
  Until: "date",
  Runs: "relation",
} as const

/** The Runs data source's properties. */
export const RUN_PROPERTIES = {
  ID: "unique_id",
  Title: "title",
  Automation: "relation",
  Trigger: "select",
  Status: "status",
  Date: "date",
  Duration: "number",
  Cost: "number",
  "Input tokens": "number",
  "Cached tokens": "number",
  "Output tokens": "number",
} as const

/** Select and status options the code relies on; `doctor` checks Notion has each. */
export const REQUIRED_OPTIONS = {
  automations: {
    Status: ["Disabled", "Enabled"],
    Agent: AgentName.options as readonly string[],
    Effort: ["Low", "Medium", "High", "Xhigh", "Max"],
    Repeat: ["Once", "Minutely", "Hourly", "Daily", "Weekly", "Monthly", "Yearly"],
  },
  runs: { Trigger: ["Scheduled", "Manual"], Status: ["In progress", "Completed", "Failed"] },
} as const

const REPEAT = { Minutely: "MINUTELY", Hourly: "HOURLY", Daily: "DAILY", Weekly: "WEEKLY", Monthly: "MONTHLY", Yearly: "YEARLY" } as const
const DAYS = { Mon: "MO", Tue: "TU", Wed: "WE", Thu: "TH", Fri: "FR", Sat: "SA", Sun: "SU" } as const
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const
const OCCURRENCE = { "1st": 1, "2nd": 2, "3rd": 3, "4th": 4, Last: -1 } as const

// One Zod schema per Notion property type, for the parts Notion Code reads.
const Named = z.looseObject({ name: z.string() })
const P = {
  title: z.looseObject({ type: z.literal("title"), title: z.array(z.looseObject({ plain_text: z.string().optional() })) }),
  rich_text: z.looseObject({ type: z.literal("rich_text"), rich_text: z.array(z.looseObject({ plain_text: z.string().optional() })) }),
  unique_id: z.looseObject({ type: z.literal("unique_id"), unique_id: z.looseObject({ prefix: z.string().nullable(), number: z.number().int().nullable() }) }),
  people: z.looseObject({ type: z.literal("people"), people: z.array(z.looseObject({ id: z.string() })) }),
  relation: z.looseObject({ type: z.literal("relation"), relation: z.array(z.looseObject({ id: z.string() })) }),
  status: z.looseObject({ type: z.literal("status"), status: Named.nullable() }),
  select: z.looseObject({ type: z.literal("select"), select: Named.nullable() }),
  multi_select: z.looseObject({ type: z.literal("multi_select"), multi_select: z.array(Named) }),
  number: z.looseObject({ type: z.literal("number"), number: z.number().nullable() }),
  date: z.looseObject({
    type: z.literal("date"),
    date: z.looseObject({ start: z.string(), end: z.string().nullable().optional(), time_zone: z.string().nullable().optional() }).nullable(),
  }),
}

/** A row's properties, read one by one; each problem names its property, so whoever fixes the row knows where. */
export class Reader {
  readonly issues: string[] = []
  private readonly properties: Record<string, NotionProperty>
  constructor(properties: Record<string, NotionProperty>) {
    this.properties = properties
  }

  private get<T extends keyof typeof P>(name: string, type: T): z.infer<(typeof P)[T]> | null {
    const property = this.properties[name]
    if (!property) {
      this.issues.push(`${name}: the property is missing from the database`)
      return null
    }
    const parsed = P[type].safeParse(property)
    if (!parsed.success) {
      this.issues.push(`${name}: expected a ${type} property, found ${String(property.type)}`)
      return null
    }
    return parsed.data as z.infer<(typeof P)[T]>
  }
  fail(name: string, message: string): null {
    this.issues.push(`${name}: ${message}`)
    return null
  }
  text(name: string): string {
    const property = this.properties[name]
    const value = property?.type === "title" ? this.get(name, "title")?.title : this.get(name, "rich_text")?.rich_text
    return plainText(value).trim()
  }
  uniqueId(name: string): string | null {
    const value = this.get(name, "unique_id")?.unique_id
    if (!value) return null
    if (value.number == null) return this.fail(name, "has no number yet")
    if (!value.prefix) return this.fail(name, "needs a prefix, such as AUT, set on the ID property")
    return `${value.prefix}-${value.number}`
  }
  people(name: string): string[] {
    return this.get(name, "people")?.people.map((person) => person.id) ?? []
  }
  relation(name: string): string[] {
    return this.get(name, "relation")?.relation.map((page) => page.id) ?? []
  }
  status(name: string): string | null {
    return this.get(name, "status")?.status?.name ?? null
  }
  select(name: string): string | null {
    return this.get(name, "select")?.select?.name ?? null
  }
  multi(name: string): string[] {
    return this.get(name, "multi_select")?.multi_select.map((option) => option.name) ?? []
  }
  number(name: string): number | null {
    return this.get(name, "number")?.number ?? null
  }
  /** A date's start. When Notion gives a time zone and no offset, the time is that zone's, made explicit here. */
  date(name: string): string | null {
    const value = this.get(name, "date")?.date
    if (!value) return null
    if (value.time_zone && /T\d\d:\d\d/u.test(value.start) && !/[zZ]|[+-]\d\d:\d\d$/u.test(value.start)) {
      try {
        return Temporal.PlainDateTime.from(value.start.slice(0, 19)).toZonedDateTime(value.time_zone).toInstant().toString()
      } catch {
        return this.fail(name, `has an unknown time zone, ${value.time_zone}`)
      }
    }
    return value.start
  }
}

/** A Notion date with a time, as an instant; a date without a time gives null. */
function instantOf(value: string): Temporal.Instant | null {
  if (!/T\d\d:\d\d/u.test(value)) return null
  return Temporal.Instant.from(/[zZ]|[+-]\d\d:\d\d$/u.test(value) ? value : `${value}Z`)
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0")
/** `20261120T090000`, iCalendar's local date-time form. */
const compact = (value: { year: number; month: number; day: number; hour: number; minute: number; second: number }) =>
  `${pad(value.year, 4)}${pad(value.month)}${pad(value.day)}T${pad(value.hour)}${pad(value.minute)}${pad(value.second)}`

/** `2026-11-20T09:00`, a wall-clock time to show. */
export const wallClock = (value: { year: number; month: number; day: number; hour: number; minute: number }) =>
  `${pad(value.year, 4)}-${pad(value.month)}-${pad(value.day)}T${pad(value.hour)}:${pad(value.minute)}`

/**
 * The schedule properties → iCalendar text (DTSTART and RRULE), validated by the scheduler's own parser. Strict: a
 * property that can't take part in the schedule is an error, never ignored.
 */
export function scheduleFromProperties(read: Reader): string | null {
  const before = read.issues.length
  const start = read.date("Start")
  const zone = read.select("Time zone")
  const repeat = read.select("Repeat")
  const every = read.number("Every")
  const days = read.multi("Days")
  const monthDays = read.multi("Days of month")
  const months = read.multi("Months")
  const hours = read.multi("Hours")
  const minutes = read.multi("Minutes")
  const occurrence = read.multi("Occurrence")
  const limit = read.number("Limit")
  const until = read.date("Until")
  if (read.issues.length > before) return null

  if (!start) return read.fail("Start", "is required: the first run, with a time")
  if (!zone) return read.fail("Time zone", "is required, such as Europe/Madrid")
  let tz: string
  try {
    tz = Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(zone).timeZoneId
  } catch {
    return read.fail("Time zone", `${zone} is not an IANA time zone, such as Europe/Madrid`)
  }
  const startInstant = instantOf(start)
  if (!startInstant) return read.fail("Start", "needs a time, not only a date")
  const local = startInstant.toZonedDateTimeISO(tz)
  if (local.second !== 0 || local.millisecond !== 0) return read.fail("Start", "must be on a whole minute")
  const dtstart = `DTSTART;TZID=${tz}:${compact(local)}`

  if (!repeat) return read.fail("Repeat", "is required: Once, Minutely, Hourly, Daily, Weekly, Monthly or Yearly")
  if (repeat === "Once") {
    const extra = [
      ["Every", every !== null],
      ["Days", days.length > 0],
      ["Days of month", monthDays.length > 0],
      ["Months", months.length > 0],
      ["Hours", hours.length > 0],
      ["Minutes", minutes.length > 0],
      ["Occurrence", occurrence.length > 0],
      ["Limit", limit !== null],
      ["Until", until !== null],
    ].filter(([, set]) => set)
    if (extra.length) return read.fail("Repeat", `Once runs only at Start; clear ${extra.map(([name]) => name).join(", ")}`)
    return dtstart
  }
  const freq = REPEAT[repeat as keyof typeof REPEAT]
  if (!freq) return read.fail("Repeat", `unknown option ${repeat}`)

  const parts = [`FREQ=${freq}`]
  if (every !== null) {
    if (!Number.isInteger(every) || every < 1) return read.fail("Every", "must be a whole number of 1 or more")
    if (every > 1) parts.push(`INTERVAL=${every}`)
  }
  const map = <T>(name: string, values: string[], lookup: (value: string) => T | undefined): T[] | null => {
    const out: T[] = []
    for (const value of values) {
      const mapped = lookup(value)
      if (mapped === undefined) return read.fail(name, `unknown option ${value}`)
      out.push(mapped)
    }
    return out
  }
  const byMonth = map("Months", months, (value) => (MONTHS.indexOf(value as (typeof MONTHS)[number]) + 1 || undefined))
  const byMonthDay = map("Days of month", monthDays, (value) => (value === "Last" ? -1 : /^([1-9]|[12]\d|3[01])$/u.test(value) ? Number(value) : undefined))
  const byDay = map("Days", days, (value) => DAYS[value as keyof typeof DAYS])
  const byHour = map("Hours", hours, (value) => (/^([01]\d|2[0-3])$/u.test(value) ? Number(value) : undefined))
  const byMinute = map("Minutes", minutes, (value) => (/^[0-5]\d$/u.test(value) ? Number(value) : undefined))
  const bySetPos = map("Occurrence", occurrence, (value) => OCCURRENCE[value as keyof typeof OCCURRENCE])
  if (!byMonth || !byMonthDay || !byDay || !byHour || !byMinute || !bySetPos) return null
  if (bySetPos.length && !byDay.length && !byMonthDay.length) return read.fail("Occurrence", "needs Days or Days of month to choose from")
  const join = (values: (number | string)[]) => values.join(",")
  if (byMonth.length) parts.push(`BYMONTH=${join(byMonth)}`)
  if (byMonthDay.length) parts.push(`BYMONTHDAY=${join(byMonthDay)}`)
  if (byDay.length) parts.push(`BYDAY=${join(byDay)}`)
  if (byHour.length) parts.push(`BYHOUR=${join(byHour)}`)
  if (byMinute.length) parts.push(`BYMINUTE=${join(byMinute)}`)
  if (bySetPos.length) parts.push(`BYSETPOS=${join(bySetPos)}`)
  if (limit !== null && until !== null) return read.fail("Limit", "use Limit or Until, not both")
  if (limit !== null) {
    if (!Number.isInteger(limit) || limit < 1) return read.fail("Limit", "must be a whole number of 1 or more")
    parts.push(`COUNT=${limit}`)
  }
  if (until !== null) {
    // A date alone means the end of that day, in the automation's time zone.
    const end = instantOf(until) ?? Temporal.PlainDateTime.from(`${until.slice(0, 10)}T23:59:59`).toZonedDateTime(tz).toInstant()
    if (Temporal.Instant.compare(end, startInstant) < 0) return read.fail("Until", "is before Start")
    parts.push(`UNTIL=${compact(end.toZonedDateTimeISO("UTC"))}Z`)
  }
  const text = `${dtstart}\nRRULE:${parts.join(";")}`
  try {
    return formatSchedule(parseSchedule(text))
  } catch (error) {
    return read.fail("Repeat", `the schedule is invalid: ${(error as Error).message}`)
  }
}

/** What a row says, before its project folder and prompt are resolved. */
export interface Row {
  id: string
  page: string
  url: string
  title: string
  status: string | null
  assignees: string[]
  projects: string[]
  agent: AgentName
  model: string | null
  effort: Effort | null
  schedule: string | null
  editedBy: string | null
  edited: string
}

/** Reads a row; `issues` lists every property that's wrong, so one pass fixes them all. */
export function readRow(page: NotionPage, { schedule = true } = {}): { row: Row | null; issues: string[]; id: string | null; title: string } {
  const read = new Reader(page.properties ?? {})
  const id = read.uniqueId("ID")
  const title = read.text("Title")
  if (!title) read.fail("Title", "is empty")
  const status = read.status("Status")
  const assignees = read.people("Assignee")
  const projects = read.relation("Project")
  if (projects.length > 1) read.fail("Project", "link one project at most")
  const agentName = read.select("Agent")
  const agent = AgentName.safeParse(agentName)
  if (!agent.success) read.fail("Agent", agentName ? `unknown agent ${agentName}` : `is required: ${AgentName.options.join(", ")}`)
  // The option's display name, such as "Opus 5.5", becomes the ID the agent takes.
  const modelName = read.select("Model")
  const model = modelName ? modelId(modelName) : null
  const effortName = read.select("Effort")
  const effort = effortName === null ? null : Effort.safeParse(effortName.toLowerCase())
  if (effort && !effort.success) read.fail("Effort", `unknown option ${effortName}`)
  const text = schedule ? scheduleFromProperties(read) : null
  const base = { id, title }
  if (read.issues.length || !id || !agent.success) return { row: null, issues: read.issues, ...base }
  return {
    row: {
      id,
      page: page.id,
      url: page.url ?? "",
      title,
      status,
      assignees,
      projects,
      agent: agent.data,
      model,
      effort: effort?.success ? effort.data : null,
      schedule: text,
      editedBy: page.last_edited_by?.id ?? null,
      edited: page.last_edited_time ?? "",
    },
    issues: [],
    ...base,
  }
}
