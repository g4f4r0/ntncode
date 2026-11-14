import assert from "node:assert/strict"
import { test } from "node:test"
import { readRow, wallClock } from "../../src/automations/row.ts"
import { nextOccurrences, parseSchedule } from "../../src/scheduler/rrule.ts"
import { automationPage, type RowInput } from "./fixtures.ts"

const schedule = (input: RowInput) => {
  const { row, issues } = readRow(automationPage(input))
  assert.deepEqual(issues, [], `no issues for ${JSON.stringify(input)}`)
  return row!.schedule!
}
const issues = (input: RowInput) => readRow(automationPage(input)).issues.join("; ")

/** The next local times, as `YYYY-MM-DDTHH:MM`, in the zone. */
function next(text: string, after: string, count: number, zone = "Europe/Madrid"): string[] {
  return nextOccurrences(parseSchedule(text), Temporal.Instant.from(after), count).map((at) => wallClock(at.toZonedDateTimeISO(zone)))
}

// Every example in the automations skill's references/schedules.md, as properties → rule → runs.
test("the skill's schedule examples build the expected rules and run at the expected local times", () => {
  const berlin = "2026-11-20T09:00:00.000+01:00"
  assert.equal(schedule({ repeat: "Once", start: berlin, zone: "Europe/Berlin" }), "DTSTART;TZID=Europe/Berlin:20261120T090000")
  assert.deepEqual(next(schedule({ repeat: "Once", start: berlin, zone: "Europe/Berlin" }), "2026-11-01T00:00:00Z", 3, "Europe/Berlin"), ["2026-11-20T09:00"])

  const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri"]
  const monday9 = "2026-11-16T09:00:00.000+01:00"
  const t1 = schedule({ repeat: "Weekly", days: weekdays, start: monday9 })
  assert.equal(t1, "DTSTART;TZID=Europe/Madrid:20261116T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR")
  assert.deepEqual(next(t1, "2026-11-20T09:00:00Z", 2), ["2026-11-23T09:00", "2026-11-24T09:00"], "Friday 09:00 Madrid is 08:00Z, so the next is Monday")

  const t2 = schedule({ repeat: "Weekly", days: weekdays, hours: ["09", "17"], minutes: ["00"], start: monday9 })
  assert.deepEqual(next(t2, "2026-11-16T00:00:00Z", 3), ["2026-11-16T09:00", "2026-11-16T17:00", "2026-11-17T09:00"])

  const t3 = schedule({ repeat: "Weekly", days: weekdays, hours: ["09", "10", "11", "12", "13", "14", "15", "16", "17"], minutes: ["00", "15", "30", "45"], start: monday9 })
  assert.deepEqual(next(t3, "2026-11-16T16:40:00Z", 3), ["2026-11-16T17:45", "2026-11-17T09:00", "2026-11-17T09:15"])

  const t4 = schedule({ repeat: "Weekly", every: 2, days: ["Mon"], start: "2026-11-16T08:00:00.000+01:00" })
  assert.deepEqual(next(t4, "2026-11-16T00:00:00Z", 3), ["2026-11-16T08:00", "2026-11-30T08:00", "2026-12-14T08:00"])

  const t5 = schedule({ repeat: "Monthly", days: weekdays, occurrence: ["Last"], start: "2026-11-01T17:00:00.000+01:00" })
  assert.deepEqual(next(t5, "2026-11-01T00:00:00Z", 3), ["2026-11-30T17:00", "2026-12-31T17:00", "2027-01-29T17:00"])

  const t6 = schedule({ repeat: "Monthly", every: 3, days: ["Mon"], occurrence: ["1st"], start: "2027-01-01T09:00:00.000+01:00" })
  assert.deepEqual(next(t6, "2026-12-01T00:00:00Z", 3), ["2027-01-04T09:00", "2027-04-05T09:00", "2027-07-05T09:00"])

  const t7 = schedule({ repeat: "Monthly", monthDays: ["1", "15"], start: "2026-11-01T09:00:00.000+01:00" })
  assert.deepEqual(next(t7, "2026-11-02T00:00:00Z", 3), ["2026-11-15T09:00", "2026-12-01T09:00", "2026-12-15T09:00"])

  const t8 = schedule({ repeat: "Yearly", months: ["Mar"], monthDays: ["31"], start: "2026-11-01T09:00:00.000+01:00" })
  assert.deepEqual(next(t8, "2026-11-02T00:00:00Z", 2), ["2027-03-31T09:00", "2028-03-31T09:00"])

  const t9 = schedule({ repeat: "Daily", limit: 10, start: "2026-11-15T07:00:00.000+01:00" })
  assert.equal(next(t9, "2026-11-01T00:00:00Z", 20).length, 10)

  const t10 = schedule({ repeat: "Daily", until: "2026-12-31", start: "2026-12-29T07:00:00.000+01:00" })
  assert.deepEqual(next(t10, "2026-12-01T00:00:00Z", 10), ["2026-12-29T07:00", "2026-12-30T07:00", "2026-12-31T07:00"], "Until a date includes that whole day")
})

test("the migrated OpenCode schedules keep their cron times", () => {
  // 15 */2 * * * Europe/Madrid
  const watch = schedule({ repeat: "Daily", hours: ["00", "02", "04", "06", "08", "10", "12", "14", "16", "18", "20", "22"], minutes: ["15"], start: "2026-11-14T16:15:00.000+01:00" })
  assert.deepEqual(next(watch, "2026-11-14T15:20:00Z", 3), ["2026-11-14T18:15", "2026-11-14T20:15", "2026-11-14T22:15"])
  // 0 8 * * * Europe/Madrid, across the 29 March change: still 08:00 local
  const daily = schedule({ repeat: "Daily", start: "2026-11-15T08:00:00.000+01:00" })
  assert.deepEqual(next(daily, "2027-03-27T12:00:00Z", 3), ["2027-03-28T08:00", "2027-03-29T08:00", "2027-03-30T08:00"])
  // 0 9 11-24 11 * Europe/Madrid, this year only
  const gift = schedule({ repeat: "Daily", until: "2026-11-24", start: "2026-11-15T09:00:00.000+01:00" })
  assert.equal(next(gift, "2026-11-15T00:00:00Z", 20).length, 10)
})

test("a wrong or ambiguous schedule is an error naming the property, never a guess", () => {
  assert.match(issues({ start: null }), /Start: is required/u)
  assert.match(issues({ start: "2026-11-15" }), /Start: needs a time/u)
  assert.match(issues({ zone: null }), /Time zone: is required/u)
  assert.match(issues({ zone: "Mars/Olympus" }), /not an IANA time zone/u)
  assert.match(issues({ repeat: null }), /Repeat: is required/u)
  assert.match(issues({ repeat: "Once", days: ["Mon"] }), /Once runs only at Start; clear Days/u)
  assert.match(issues({ occurrence: ["1st"], repeat: "Monthly" }), /Occurrence: needs Days or Days of month/u)
  assert.match(issues({ limit: 3, until: "2026-12-01" }), /Limit: use Limit or Until, not both/u)
  assert.match(issues({ every: 0 }), /Every: must be a whole number/u)
  assert.match(issues({ until: "2026-11-01" }), /Until: is before Start/u)
  assert.match(issues({ agent: null }), /Agent: is required/u)
  assert.match(issues({ agent: "Cursor" }), /Agent: unknown agent Cursor/u)
  assert.match(issues({ effort: "Ultra" }), /Effort: unknown option Ultra/u)
  assert.match(issues({ title: "" }), /Title: is empty/u)
  const several = issues({ start: null, agent: null, title: "" })
  assert.ok(several.includes("Start") && several.includes("Agent") && several.includes("Title"), "every problem in one pass")
})

test("a row reads its agent, model and effort", () => {
  const { row } = readRow(automationPage({ model: "claude-opus-5-5", effort: "High" }))
  assert.deepEqual([row!.id, row!.agent, row!.model, row!.effort, row!.status], ["AUT-12", "Claude Code", "claude-opus-5-5", "high", "Enabled"])
})

test("a Model option's display name becomes the agent's model ID", () => {
  const model = (name: string) => readRow(automationPage({ model: name })).row!.model
  assert.equal(model("Opus 5.5"), "claude-opus-5-5")
  assert.equal(model("Sonnet 5.5"), "claude-sonnet-5-5")
  assert.equal(model("Fable 5.2"), "claude-fable-5-2")
  assert.equal(model("GPT-6.1 Sol"), "gpt-6.1-sol")
  assert.equal(model("GPT-6.1 Terra"), "gpt-6.1-terra")
  assert.equal(model("claude-opus-5-5"), "claude-opus-5-5", "an ID passes through")
})
