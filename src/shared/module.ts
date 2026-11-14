import type { Config, Paths } from "./config.ts"
import type { Notion } from "./notion.ts"

/**
 * A domain plugs into Notion Code as a module: the tasks it runs and the checks `doctor` makes. Adding a domain means
 * a folder that exports one Module, and one line in src/modules.ts.
 */
export interface Module {
  name: string
  tasks(): Task[]
  checks?(context: Context): Check[] | Promise<Check[]>
}

/** Something the scheduler runs, on an RFC 5545 recurrence rule. */
export interface Task {
  /** `<module>.<name>`, such as `instructions.sync`. */
  id: string
  /** An RRULE, such as `FREQ=MINUTELY;INTERVAL=10`. */
  schedule: string
  run(context: Context): Promise<Result[]>
}

/** How often each sync runs. */
export const SYNC_SCHEDULE = "FREQ=MINUTELY;INTERVAL=10"

export interface Context {
  paths: Paths
  config: Config
  /** Read-only: the sync never writes to Notion. */
  notion: Notion
  dryRun: boolean
  now: Date
}

export type Status = "written" | "unchanged" | "skipped" | "failed" | "linked" | "would write" | "would link"

/** One line of a run's report: a file or link, what happened to it, and why. */
export interface Result {
  status: Status
  path: string
  detail: string
}

/** One line of `doctor`: something that should be true, and whether it is. */
export interface Check {
  ok: boolean
  name: string
  detail: string
}

/** A result that needs a person to look at it. */
export const needsAttention = (result: Result) => result.status === "failed" || result.status === "skipped"
