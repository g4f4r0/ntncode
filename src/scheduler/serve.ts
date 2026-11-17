import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import type { Paths } from "../shared/config.ts"
import { acquireLock, readValid, writeJson } from "../shared/files.ts"
import { activeModules, type Context, type Module, type Result, type Task } from "../shared/module.ts"
import { isAlive } from "../shared/process.ts"
import { nextAfter, parseSchedule } from "./rrule.ts"

/** The scheduler's own state: each task's last fired occurrence, and a heartbeat other commands read. */
export const SchedulerState = z.strictObject({
  version: z.literal(1),
  pid: z.number().int().nullable(),
  startedAt: z.string().nullable(),
  heartbeat: z.string().nullable(),
  tasks: z.record(z.string(), z.strictObject({ last: z.iso.datetime() })),
})
export type SchedulerState = z.infer<typeof SchedulerState>

const EMPTY: SchedulerState = { version: 1, pid: null, startedAt: null, heartbeat: null, tasks: {} }
export const statePath = (paths: Paths) => path.join(paths.state, "scheduler.json")
export const readSchedulerState = (paths: Paths) => readValid(statePath(paths), SchedulerState, EMPTY)

/** A scheduler counts as running when its process is alive and it ticked within this long. */
const STALE_MS = 90_000
/** Missed occurrences further back than this are forgotten; the latest missed one still fires. */
const CATCH_UP_MS = 7 * 24 * 3_600_000
const DAY_MS = 24 * 3_600_000

/** Whether `ntncode serve` is running, from its heartbeat. */
export function serveStatus(paths: Paths, now = new Date()): { running: boolean; pid: number | null; heartbeat: string | null; startedAt: string | null } {
  let state: SchedulerState
  try {
    state = readSchedulerState(paths)
  } catch {
    state = EMPTY
  }
  const fresh = !!state.heartbeat && now.getTime() - Date.parse(state.heartbeat) < STALE_MS
  return { running: fresh && state.pid !== null && isAlive(state.pid), pid: state.pid, heartbeat: state.heartbeat, startedAt: state.startedAt }
}

/** The names of the variables in the running scheduler's environment, or null when it isn't running or can't be read. */
export function serveEnvNames(paths: Paths): Set<string> | null {
  const status = serveStatus(paths)
  if (!status.running || status.pid === null) return null
  try {
    return new Set(fs.readFileSync(`/proc/${status.pid}/environ`, "utf8").split("\0").map((entry) => entry.split("=")[0]!).filter(Boolean))
  } catch {
    return null
  }
}

/**
 * The occurrence a task should fire for now: the latest one after both its last fire and its `since`, at or before
 * now. Missed occurrences collapse into one, so a scheduler that was down runs each task once, not once per miss.
 */
export function dueOccurrence(task: Pick<Task, "schedule" | "since">, last: string | null, now: Date): string | null {
  const schedule = parseSchedule(task.schedule)
  const time = (value: string | null) => (value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null)
  const floors = [now.getTime() - CATCH_UP_MS, time(last) ?? now.getTime() - DAY_MS, time(task.since) ?? -Infinity]
  let cursor = Temporal.Instant.fromEpochMilliseconds(Math.max(...floors))
  const limit = Temporal.Instant.fromEpochMilliseconds(now.getTime())
  let due: Temporal.Instant | null = null
  for (let step = 0; step < 20_000; step += 1) {
    const next = nextAfter(schedule, cursor)
    if (!next || Temporal.Instant.compare(next, limit) > 0) break
    due = next
    cursor = next
  }
  return due ? new Date(due.epochMilliseconds).toISOString() : null
}

/** The next occurrences after now, for `doctor` and `status`. */
export function upcoming(task: Pick<Task, "schedule">, now: Date, count: number): string[] {
  const schedule = parseSchedule(task.schedule)
  const out: string[] = []
  let cursor = Temporal.Instant.fromEpochMilliseconds(now.getTime())
  while (out.length < count) {
    const next = nextAfter(schedule, cursor)
    if (!next) break
    out.push(new Date(next.epochMilliseconds).toISOString())
    cursor = next
  }
  return out
}

export interface ServeOptions {
  paths: Paths
  /** A fresh context and the modules, read again on every tick so config and token changes apply. */
  load(now: Date): Context
  modules: Module[]
  tickMs?: number
  signal?: AbortSignal
  /** One JSON object per event, for the journal. */
  log(event: Record<string, unknown>): void
  now?: () => Date
}

/** Runs until the signal aborts: fires every task on its schedule, syncs in turn under the sync lock, runs side by side. */
export async function serve(options: ServeOptions): Promise<void> {
  const { paths, modules, log } = options
  const clock = options.now ?? (() => new Date())
  const lock = acquireLock(path.join(paths.state, "serve.lock"))
  if (!lock) throw new Error("another ntncode serve is already running")
  const running = new Map<string, Promise<void>>()
  /** Occurrences waiting for an earlier run of their group to end; each is logged once. */
  const deferred = new Set<string>()
  let syncing: Promise<void> | null = null
  let state: SchedulerState
  try {
    state = readSchedulerState(paths)
  } catch (error) {
    // A broken state file must not stop every automation: set it aside and start fresh. Runs' Title check still stops
    // a scheduled minute from running twice.
    const aside = `${statePath(paths)}.bad-${Date.now()}`
    fs.renameSync(statePath(paths), aside)
    log({ event: "error", task: "scheduler.state", error: `${(error as Error).message}; moved it to ${aside} and started fresh` })
    state = { ...EMPTY, tasks: {} }
  }
  state.pid = process.pid
  state.startedAt = clock().toISOString()
  const save = () => {
    state.heartbeat = clock().toISOString()
    writeJson(statePath(paths), state)
  }
  save()
  const report = (task: string, results: Result[]) => {
    for (const result of results) if (result.status !== "unchanged") log({ event: "result", task, ...result })
  }

  try {
    {
      const context = options.load(clock())
      for (const module of activeModules(context.config, modules)) {
        try {
          report(`${module.name}.start`, (await module.serve?.start?.(context)) ?? [])
        } catch (error) {
          log({ event: "error", task: `${module.name}.start`, error: (error as Error).message })
        }
      }
    }
    while (!options.signal?.aborted) {
      const now = clock()
      let context: Context | null = null
      try {
        context = options.load(now)
      } catch (error) {
        log({ event: "error", task: "load", error: (error as Error).message })
      }
      if (context) {
        const tasks: Task[] = []
        let complete = true
        const active = new Set(activeModules(context.config, modules))
        for (const module of modules) {
          try {
            const listed = module.tasks(context)
            tasks.push(...(active.has(module) ? listed : listed.map((task) => ({ ...task, off: `${module.name} is turned off in the config` }))))
          } catch (error) {
            complete = false
            if (active.has(module)) log({ event: "error", task: `${module.name}.tasks`, error: (error as Error).message })
          }
        }
        const due: { task: Task; at: string }[] = []
        for (const task of tasks) {
          try {
            const at = dueOccurrence(task, state.tasks[task.id]?.last ?? null, now)
            // A task that's off lets the occurrence pass, so it doesn't fire late when it's turned back on.
            if (at && task.off) state.tasks[task.id] = { last: at }
            else if (at) due.push({ task, at })
          } catch (error) {
            log({ event: "error", task: task.id, error: `bad schedule: ${(error as Error).message}` })
          }
        }

        const syncs = due.filter((entry) => entry.task.kind === "sync")
        if (syncs.length && !syncing) {
          const ready = context
          syncing = (async () => {
            const held = acquireLock(path.join(paths.state, "lock"))
            if (!held) return log({ event: "skipped", task: "sync", detail: "another sync holds the lock; trying again next tick" })
            try {
              for (const { task, at } of syncs) {
                try {
                  report(task.id, await task.run(ready, { trigger: "Scheduled", at }))
                } catch (error) {
                  log({ event: "error", task: task.id, error: (error as Error).message })
                }
                state.tasks[task.id] = { last: at }
                save()
              }
            } finally {
              held.release()
            }
          })().finally(() => {
            syncing = null
          })
        }

        for (const { task, at } of due.filter((entry) => entry.task.kind === "run")) {
          const group = task.group ?? task.id
          if (running.has(group)) {
            // Never drop an occurrence because another run of the same automation, such as a rehearsal, is still
            // going: it starts as soon as that run ends, and its prompt says when it was scheduled.
            const key = `${task.id}@${at}`
            if (!deferred.has(key)) log({ event: "deferred", task: task.id, at, detail: `${group} is still running; this run starts when it ends` })
            deferred.add(key)
            continue
          }
          deferred.delete(`${task.id}@${at}`)
          state.tasks[task.id] = { last: at }
          save()
          log({ event: "start", task: task.id, at })
          const ready = context
          running.set(
            group,
            task
              .run(ready, { trigger: "Scheduled", at })
              .then((results) => report(task.id, results))
              .catch((error: Error) => log({ event: "error", task: task.id, error: error.message }))
              .finally(() => running.delete(group)),
          )
        }

        for (const module of activeModules(context.config, modules)) {
          try {
            report(`${module.name}.tick`, (await module.serve?.tick?.(context)) ?? [])
          } catch (error) {
            log({ event: "error", task: `${module.name}.tick`, error: (error as Error).message })
          }
        }
        // Forget tasks that are gone, such as a disabled automation, so the state doesn't grow. One that comes back
        // fires only after its `since`, and Runs' Title check stops a scheduled time from running twice.
        // Only when every module listed its tasks: a module that failed this tick hasn't lost its tasks.
        const ids = new Set(tasks.map((task) => task.id))
        if (complete) for (const id of Object.keys(state.tasks)) if (!ids.has(id)) delete state.tasks[id]
      }
      save()
      await sleep(options.tickMs ?? 15_000, options.signal)
    }
    await Promise.allSettled([...running.values(), ...(syncing ? [syncing] : [])])
  } finally {
    state.pid = null
    writeJson(statePath(paths), state)
    lock.release()
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

export const serveLog = (paths: Paths) => path.join(paths.state, "serve.log")

/** Appends a JSON line to the serve log, rotating it past 5 MB. */
export function appendLog(paths: Paths, event: Record<string, unknown>): void {
  const file = serveLog(paths)
  fs.mkdirSync(paths.state, { recursive: true })
  if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 5_000_000) fs.renameSync(file, `${file}.1`)
  fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`)
}
