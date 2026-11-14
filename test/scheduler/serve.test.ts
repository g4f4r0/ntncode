import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { dueOccurrence, serve, upcoming } from "../../src/scheduler/serve.ts"
import type { Context, Module, Task } from "../../src/shared/module.ts"
import { fakeNotion, tempHome, testContext } from "../helpers.ts"

const DAILY_8 = "DTSTART;TZID=Europe/Madrid:20261115T080000\nRRULE:FREQ=DAILY"
const at = (iso: string) => new Date(iso)

test("missed occurrences collapse into the latest one, and nothing fires twice", () => {
  const task = { schedule: DAILY_8, since: "2026-11-14T00:00:00.000Z" }
  assert.equal(dueOccurrence(task, null, at("2026-11-15T06:59:00Z")), null, "not yet 08:00 Madrid")
  assert.equal(dueOccurrence(task, null, at("2026-11-15T07:00:00Z")), "2026-11-15T07:00:00.000Z")
  assert.equal(dueOccurrence(task, "2026-11-15T07:00:00.000Z", at("2026-11-15T12:00:00Z")), null, "already fired")
  assert.equal(dueOccurrence(task, "2026-11-15T07:00:00.000Z", at("2026-11-18T12:00:00Z")), "2026-11-18T07:00:00.000Z", "three days down: one run, the latest")
})

test("an automation never fires for times before it was first accepted", () => {
  const task = { schedule: DAILY_8, since: "2026-11-16T09:00:00.000Z" }
  assert.equal(dueOccurrence(task, null, at("2026-11-16T09:30:00Z")), null, "today's 08:00 passed before it was enabled")
  assert.equal(dueOccurrence(task, null, at("2026-11-17T07:00:30Z")), "2026-11-17T07:00:00.000Z")
})

test("a sync with no record fires at once, then every 10 minutes", () => {
  const task = { schedule: "DTSTART:20260101T000000Z\nRRULE:FREQ=MINUTELY;INTERVAL=10", since: null }
  assert.equal(dueOccurrence(task, null, at("2026-11-14T10:07:00Z")), "2026-11-14T10:00:00.000Z")
  assert.equal(dueOccurrence(task, "2026-11-14T10:00:00.000Z", at("2026-11-14T10:09:59Z")), null)
  assert.equal(dueOccurrence(task, "2026-11-14T10:00:00.000Z", at("2026-11-14T10:10:00Z")), "2026-11-14T10:10:00.000Z")
})

test("a once-only task fires once; a schedule that ended has no next run", () => {
  const once = { schedule: "DTSTART;TZID=Europe/Madrid:20261116T060000", since: "2026-11-14T00:00:00.000Z" }
  assert.equal(dueOccurrence(once, null, at("2026-11-16T05:00:30Z")), "2026-11-16T05:00:00.000Z")
  assert.equal(dueOccurrence(once, "2026-11-16T05:00:00.000Z", at("2026-11-20T00:00:00Z")), null)
  assert.deepEqual(upcoming(once, at("2026-11-17T00:00:00Z"), 3), [])
  const limited = { schedule: "DTSTART;TZID=Europe/Madrid:20261115T080000\nRRULE:FREQ=DAILY;COUNT=2" }
  assert.deepEqual(upcoming(limited, at("2026-11-14T00:00:00Z"), 3), ["2026-11-15T07:00:00.000Z", "2026-11-16T07:00:00.000Z"])
})

test("daily 08:00 Madrid stays 08:00 local across the daylight-saving changes", () => {
  const next = upcoming({ schedule: DAILY_8 }, at("2027-03-27T12:00:00Z"), 2)
  assert.deepEqual(next, ["2027-03-28T06:00:00.000Z", "2027-03-29T06:00:00.000Z"], "after 28 March 2027, 08:00 CEST is 06:00Z")
  const autumn = "DTSTART;TZID=Europe/Madrid:20261001T080000\nRRULE:FREQ=DAILY"
  assert.deepEqual(upcoming({ schedule: autumn }, at("2026-10-24T12:00:00Z"), 2), ["2026-10-25T07:00:00.000Z", "2026-10-26T07:00:00.000Z"], "after 25 October, 08:00 CET is 07:00Z")
})

/** Runs the scheduler on a fake clock, `ticks` times, with these tasks. */
async function drive(tasks: Task[], clock: string[]) {
  const paths = tempHome()
  const controller = new AbortController()
  const events: Record<string, unknown>[] = []
  let index = 0
  const now = () => at(clock[Math.min(index, clock.length - 1)]!)
  const module: Module = { name: "test", tasks: () => tasks }
  const ticking: Module = {
    name: "ticker",
    tasks: () => [],
    serve: {
      tick: async () => {
        index += 1
        if (index >= clock.length) controller.abort()
        return []
      },
    },
  }
  await serve({ paths, modules: [module, ticking], log: (event) => events.push(event), load: (time) => testContext(paths, fakeNotion({}), {}, time) as Context, tickMs: 1, signal: controller.signal, now })
  return events
}

test("the scheduler runs a due task once, and never starts a second run of the same group while one is running", async () => {
  let release!: () => void
  const blocker = new Promise<void>((resolve) => (release = resolve))
  const starts: string[] = []
  const slow: Task = {
    id: "AUT-1",
    kind: "run",
    schedule: "DTSTART:20261114T100000Z\nRRULE:FREQ=MINUTELY",
    since: "2026-11-14T09:00:00.000Z",
    run: async (_context, fire) => {
      starts.push(fire.at)
      await blocker
      return []
    },
  }
  const manual: Task = { id: "AUT-1#req", group: "AUT-1", kind: "run", schedule: "DTSTART:20261114T100000Z", since: null, run: async () => (starts.push("manual"), []) }
  setTimeout(() => release(), 50)
  const events = await drive([slow, manual], ["2026-11-14T10:00:10Z", "2026-11-14T10:00:40Z", "2026-11-14T10:01:05Z", "2026-11-14T10:01:10Z"])
  assert.deepEqual(starts, ["2026-11-14T10:00:00.000Z"], "the manual run and the next minute wait while the first run goes on")
  assert.ok(events.some((event) => event.event === "deferred" && event.task === "AUT-1#req"))
  assert.equal(events.filter((event) => event.event === "deferred" && event.task === "AUT-1#req").length, 1, "logged once, not every tick")
})

test("sync tasks run one after another and a failing task doesn't stop the others", async () => {
  const order: string[] = []
  const sync = (id: string, fail = false): Task => ({
    id,
    kind: "sync",
    schedule: "DTSTART:20260101T000000Z\nRRULE:FREQ=MINUTELY;INTERVAL=10",
    since: null,
    run: async () => {
      order.push(id)
      if (fail) throw new Error("boom")
      return [{ status: "written", path: id, detail: "ok" }]
    },
  })
  const events = await drive([sync("a", true), sync("b")], ["2026-11-14T10:01:00Z", "2026-11-14T10:02:00Z", "2026-11-14T10:03:00Z"])
  assert.deepEqual(order, ["a", "b"])
  assert.ok(events.some((event) => event.event === "error" && event.task === "a"))
  assert.ok(events.some((event) => event.event === "result" && event.task === "b"))
})

test("a deferred run starts once the run before it ends", async () => {
  let release!: () => void
  const blocker = new Promise<void>((resolve) => (release = resolve))
  const starts: string[] = []
  const first: Task = { id: "AUT-2#rehearsal", group: "AUT-2", kind: "run", schedule: "DTSTART:20261114T100000Z", since: null, run: async () => (starts.push("rehearsal"), await blocker, []) }
  const publish: Task = { id: "AUT-2", kind: "run", schedule: "DTSTART:20261114T100100Z", since: "2026-11-14T09:00:00.000Z", run: async (_c, fire) => (starts.push(`publish ${fire.at}`), []) }
  const clock = ["2026-11-14T10:00:30Z", "2026-11-14T10:01:10Z", "2026-11-14T10:01:20Z"]
  const paths = tempHome()
  const controller = new AbortController()
  let index = 0
  const ticker: Module = {
    name: "ticker",
    tasks: () => [],
    serve: {
      tick: async () => {
        index += 1
        if (index === 2) release()
        if (index >= 6) controller.abort()
        await new Promise((resolve) => setTimeout(resolve, 5))
        return []
      },
    },
  }
  await serve({ paths, modules: [{ name: "t", tasks: () => [first, publish] }, ticker], log: () => {}, load: (time) => testContext(paths, fakeNotion({}), {}, time) as Context, tickMs: 1, signal: controller.signal, now: () => at(clock[Math.min(index, clock.length - 1)]!) })
  assert.deepEqual(starts, ["rehearsal", "publish 2026-11-14T10:01:00.000Z"], "the publish waited for the rehearsal, then ran for its own time")
})

test("a broken scheduler state file is set aside, never a crash loop", async () => {
  const paths = tempHome()
  fs.mkdirSync(paths.state, { recursive: true })
  fs.writeFileSync(path.join(paths.state, "scheduler.json"), '{"version":1,"unknown":true}')
  const events: Record<string, unknown>[] = []
  const controller = new AbortController()
  const ticker: Module = { name: "ticker", tasks: () => [], serve: { tick: async () => (controller.abort(), []) } }
  await serve({ paths, modules: [ticker], log: (event) => events.push(event), load: (time) => testContext(paths, fakeNotion({}), {}, time) as Context, tickMs: 1, signal: controller.signal })
  assert.ok(events.some((event) => event.task === "scheduler.state"))
  assert.ok(fs.readdirSync(paths.state).some((name) => name.startsWith("scheduler.json.bad-")))
  assert.equal(JSON.parse(fs.readFileSync(path.join(paths.state, "scheduler.json"), "utf8")).version, 1)
  assert.equal(dueOccurrence({ schedule: DAILY_8, since: "not a date" }, "nope", at("2026-11-15T07:00:30Z")), "2026-11-15T07:00:00.000Z", "a bad time is ignored, not NaN")
})
