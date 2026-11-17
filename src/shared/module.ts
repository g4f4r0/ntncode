import { isOn, type Config, type Paths, type Section } from "./config.ts"
import type { Notion } from "./notion.ts"

/**
 * A domain plugs into Notion Code as a module: the tasks it runs and the checks `doctor` makes. Adding a domain means
 * a folder that exports one Module, and one line in src/modules.ts.
 */
export interface Module {
  name: string
  /** Read on every scheduler tick, so a module can return tasks from its own files, such as one per automation. */
  tasks(context: Context): Task[]
  checks?(context: Context): Check[] | Promise<Check[]>
  /** Called once when `ntncode serve` starts, and on every tick after the tasks, for upkeep such as retries. */
  serve?: { start?(context: Context): Promise<Result[]>; tick?(context: Context): Promise<Result[]> }
}

/**
 * Something the scheduler runs. A `sync` task runs in turn with the other syncs, under the sync lock, and `ntncode
 * sync` runs them all at once. A `run` task runs on its own, alongside others, never twice at the same time.
 */
export interface Task {
  /** `<module>.<name>`, such as `instructions.sync`, or an automation's ID, such as `AUT-12`. */
  id: string
  kind: "sync" | "run"
  /** iCalendar text: a DTSTART line and, unless it runs once, an RRULE line. */
  schedule: string
  /** Occurrences at or before this time never fire: when the task first appeared. Null fires the latest missed one. */
  since: string | null
  /** Run tasks with the same group never run at the same time; by default the group is the ID. */
  group?: string
  /**
   * Why the config turns the task off. The scheduler lets its occurrences pass without running them, so turning it back
   * on never fires one it missed while it was off.
   */
  off?: string
  run(context: Context, fire: Fire): Promise<Result[]>
}

/** Why a task runs now: the occurrence it fires for, or a manual start. */
export interface Fire {
  trigger: "Scheduled" | "Manual"
  /** The scheduled occurrence, as an ISO instant; for a manual start, the time it was asked for. */
  at: string
}

/** Every sync starts on the hour and repeats every 10 minutes, in UTC. */
export const SYNC_SCHEDULE = "DTSTART:20260101T000000Z\nRRULE:FREQ=MINUTELY;INTERVAL=10"

export interface Context {
  paths: Paths
  config: Config
  /** Read-only. Only the automations runner writes to Notion, through its own writer. */
  notion: Notion
  /** The Notion token, for the runner's writer; never logged. */
  token: string
  dryRun: boolean
  now: Date
  /** Scheduler shutdown; hosted agents interrupt the session their app owns. */
  signal?: AbortSignal
}

export type Status =
  | "written"
  | "unchanged"
  | "removed"
  | "skipped"
  | "failed"
  | "linked"
  | "started"
  | "completed"
  | "would write"
  | "would remove"
  | "would link"

/** One line of a report: a file, link or run, what happened to it, and why. */
export interface Result {
  status: Status
  path: string
  detail: string
}

/**
 * One line of `doctor`. `error` means something is broken or will break; `warning` means it works but needs a look.
 * `fix` says exactly what to do, for whoever reads it next.
 */
export interface Check {
  ok: boolean
  name: string
  detail: string
  level?: "error" | "warning"
  fix?: string
}

/** A result that needs someone to look at it. */
export const needsAttention = (result: Result) => result.status === "failed" || result.status === "skipped"

/** `~/…` for a path inside home, so reports don't leak the user name and stay short. */
export function show(paths: Pick<Paths, "home">, file: string): string {
  return file === paths.home ? "~" : file.startsWith(`${paths.home}/`) ? `~/${file.slice(paths.home.length + 1)}` : file
}

/** The modules the config leaves on: one turned off runs no task, no upkeep and no check. */
export const activeModules = (config: Config, modules: Module[]) => modules.filter((module) => isOn(config, module.name as Section))
