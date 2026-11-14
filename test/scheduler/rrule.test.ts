import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { formatSchedule, nextAfter, nextOccurrences, parseSchedule } from "../../src/scheduler/rrule.ts"

interface Fixture {
  name: string
  text: string
  after: string
  expected: string[]
}

const fixtures = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures.json"), "utf8")) as Fixture[]
const at = (iso: string) => Temporal.Instant.from(iso)
const isos = (xs: Temporal.Instant[]) => xs.map((x) => x.toString())
const next = (text: string, after: string, n: number) => isos(nextOccurrences(parseSchedule(text), at(after), n))
const local = (x: Temporal.Instant | null, zone: string) => x?.toZonedDateTimeISO(zone).toPlainDateTime().toString() ?? null

test("matches python-dateutil on every fixture", () => {
  assert.ok(fixtures.length >= 60, `only ${fixtures.length} fixtures`)
  for (const f of fixtures) {
    const schedule = parseSchedule(f.text)
    assert.deepEqual(isos(nextOccurrences(schedule, at(f.after), 12)), f.expected, f.name)
    assert.equal(nextAfter(schedule, at(f.after))?.toString() ?? null, f.expected[0] ?? null, f.name)
    assert.equal(formatSchedule(schedule), f.text, `${f.name}: fixture text is canonical`)
  }
})

test("chained nextAfter walks the same sequence as nextOccurrences", () => {
  for (const f of fixtures) {
    const schedule = parseSchedule(f.text)
    const walked: string[] = []
    let cursor: Temporal.Instant | null = at(f.after)
    while (walked.length < f.expected.length && cursor) {
      cursor = nextAfter(schedule, cursor)
      if (cursor) walked.push(cursor.toString())
    }
    assert.deepEqual(walked, f.expected, f.name)
  }
})

// Named examples from the product docs. DTSTART is chosen per example below.
const MADRID = "Europe/Madrid"
const WORKDAYS = "MO,TU,WE,TH,FR"

test("once: 20 Nov 2026 09:00 Europe/Berlin (no RRULE)", () => {
  const s = parseSchedule("DTSTART;TZID=Europe/Berlin:20261120T090000")
  assert.equal(s.rule, null)
  assert.equal(nextAfter(s, at("2026-11-14T00:00:00Z"))?.toString(), "2026-11-20T08:00:00Z")
  assert.deepEqual(isos(nextOccurrences(s, at("2026-11-14T00:00:00Z"), 5)), ["2026-11-20T08:00:00Z"])
  assert.equal(nextAfter(s, at("2026-11-20T08:00:00Z")), null)
})

test("weekdays 09:00 (start Mon 16 Nov 2026, Madrid)", () => {
  const text = `DTSTART;TZID=Europe/Madrid:20261116T090000\nRRULE:FREQ=WEEKLY;BYDAY=${WORKDAYS}`
  assert.deepEqual(next(text, "2026-11-20T09:00:00Z", 3), ["2026-11-23T08:00:00Z", "2026-11-24T08:00:00Z", "2026-11-25T08:00:00Z"])
})

test("weekdays 09:00 and 17:00 (start Mon 16 Nov 2026, Madrid)", () => {
  const text = `DTSTART;TZID=Europe/Madrid:20261116T090000\nRRULE:FREQ=WEEKLY;BYDAY=${WORKDAYS};BYHOUR=9,17`
  assert.deepEqual(next(text, "2026-11-20T12:00:00Z", 3), ["2026-11-20T16:00:00Z", "2026-11-23T08:00:00Z", "2026-11-23T16:00:00Z"])
})

test("every 15 minutes 09:00-17:45 on weekdays (start Mon 16 Nov 2026, Madrid)", () => {
  const text = `DTSTART;TZID=Europe/Madrid:20261116T090000\nRRULE:FREQ=WEEKLY;BYDAY=${WORKDAYS};BYHOUR=9,10,11,12,13,14,15,16,17;BYMINUTE=0,15,30,45`
  assert.deepEqual(next(text, "2026-11-20T16:40:00Z", 3), ["2026-11-20T16:45:00Z", "2026-11-23T08:00:00Z", "2026-11-23T08:15:00Z"])
  const monday = nextOccurrences(parseSchedule(text), at("2026-11-22T23:00:00Z"), 37).map((x) => local(x, MADRID))
  assert.equal(monday[0], "2026-11-23T09:00:00")
  assert.equal(monday[35], "2026-11-23T17:45:00")
  assert.equal(monday[36], "2026-11-24T09:00:00")
})

test("every other Monday 08:00 (start Mon 16 Nov 2026, Madrid)", () => {
  const text = "DTSTART;TZID=Europe/Madrid:20261116T080000\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO"
  assert.deepEqual(next(text, "2026-11-17T00:00:00Z", 3), ["2026-11-30T07:00:00Z", "2026-12-14T07:00:00Z", "2026-12-28T07:00:00Z"])
})

test("last working day of the month 17:00 (start 30 Nov 2026, Madrid)", () => {
  const text = `DTSTART;TZID=Europe/Madrid:20261130T170000\nRRULE:FREQ=MONTHLY;BYDAY=${WORKDAYS};BYSETPOS=-1`
  assert.deepEqual(next(text, "2026-11-01T00:00:00Z", 4), ["2026-11-30T16:00:00Z", "2026-12-31T16:00:00Z", "2027-01-29T16:00:00Z", "2027-02-26T16:00:00Z"])
})

test("first Monday of each quarter (start Mon 5 Jan 2026, Madrid)", () => {
  const text = "DTSTART;TZID=Europe/Madrid:20260105T090000\nRRULE:FREQ=MONTHLY;INTERVAL=3;BYDAY=MO;BYSETPOS=1"
  assert.deepEqual(next(text, "2026-01-01T00:00:00Z", 6), [
    "2026-01-05T08:00:00Z",
    "2026-04-06T07:00:00Z",
    "2026-07-06T07:00:00Z",
    "2026-10-05T07:00:00Z",
    "2027-01-04T08:00:00Z",
    "2027-04-05T07:00:00Z",
  ])
})

test("1st and 15th 09:00 (start 1 Dec 2026, Madrid)", () => {
  const text = "DTSTART;TZID=Europe/Madrid:20261201T090000\nRRULE:FREQ=MONTHLY;BYMONTHDAY=1,15"
  assert.deepEqual(next(text, "2026-11-14T00:00:00Z", 4), ["2026-12-01T08:00:00Z", "2026-12-15T08:00:00Z", "2027-01-01T08:00:00Z", "2027-01-15T08:00:00Z"])
})

test("every 31 March 09:00 (start 31 Mar 2027, Madrid)", () => {
  const text = "DTSTART;TZID=Europe/Madrid:20270331T090000\nRRULE:FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=31"
  assert.deepEqual(next(text, "2026-11-14T00:00:00Z", 2), ["2027-03-31T07:00:00Z", "2028-03-31T07:00:00Z"])
})

test("daily 07:00 ten times (start 1 Dec 2026, Madrid)", () => {
  const s = parseSchedule("DTSTART;TZID=Europe/Madrid:20261201T070000\nRRULE:FREQ=DAILY;COUNT=10")
  const all = nextOccurrences(s, at("2026-11-01T00:00:00Z"), 50)
  assert.equal(all.length, 10)
  assert.equal(local(all[0]!, MADRID), "2026-12-01T07:00:00")
  assert.equal(local(all[9]!, MADRID), "2026-12-10T07:00:00")
  assert.equal(nextAfter(s, all[9]!), null)
})

test("daily 07:00 until 2026-12-31 (start 1 Dec 2026, Madrid)", () => {
  const s = parseSchedule("DTSTART;TZID=Europe/Madrid:20261201T070000\nRRULE:FREQ=DAILY;UNTIL=20261231T225959Z")
  const all = nextOccurrences(s, at("2026-11-01T00:00:00Z"), 50)
  assert.equal(all.length, 31)
  const last = all[30]!
  assert.equal(last.toString(), "2026-12-31T06:00:00Z")
  assert.equal(local(last, MADRID), "2026-12-31T07:00:00")
  assert.equal(nextAfter(s, last), null)
})

test("DST: daily 02:30 Madrid runs at 03:30 on 29 March and once at the earlier 02:30 on 25 October", () => {
  const s = parseSchedule("DTSTART;TZID=Europe/Madrid:20260301T023000\nRRULE:FREQ=DAILY")
  const spring = nextAfter(s, at("2026-03-28T12:00:00Z"))
  assert.equal(spring?.toString(), "2026-03-29T01:30:00Z")
  assert.equal(local(spring, MADRID), "2026-03-29T03:30:00")
  assert.deepEqual(isos(nextOccurrences(s, at("2026-10-24T12:00:00Z"), 2)), ["2026-10-25T00:30:00Z", "2026-10-26T01:30:00Z"])
  assert.equal(at("2026-10-25T00:30:00Z").toZonedDateTimeISO(MADRID).offset, "+02:00")
  // Daily 08:00 stays 08:00 local across both changes.
  const eight = parseSchedule("DTSTART;TZID=Europe/Madrid:20260301T080000\nRRULE:FREQ=DAILY")
  for (const after of ["2026-03-28T12:00:00Z", "2026-10-24T12:00:00Z"]) {
    for (const x of nextOccurrences(eight, at(after), 3)) assert.equal(local(x, MADRID)?.slice(11), "08:00:00")
  }
})

test("strict parsing rejects bad input", () => {
  const D = "DTSTART;TZID=Europe/Madrid:20261120T090000"
  const bad: [string, RegExp][] = [
    ["", /missing the DTSTART/],
    [`${D}\n`, /empty second line/],
    [`${D}\nRRULE:FREQ=DAILY\n`, /3 lines/],
    [`${D}\nRRULE:FREQ=DAILY\nRRULE:FREQ=DAILY`, /3 lines/],
    ["DTSTART:20261120T090000", /TZID or a trailing Z/],
    ["DTSTART;TZID=Europe/Madrid:20261120T090000Z", /both TZID and a trailing Z/],
    ["DTSTART;TZID=Nope/Zone:20261120T090000", /unknown time zone "Nope\/Zone"/],
    ["DTSTART;TZID=:20261120T090000", /empty TZID/],
    ["DTSTART;TZID=+01:00:20261120T090000", /DTSTART line must look like/],
    ["DTSTART;TZID=Europe/Madrid:20261120T090030", /seconds must be 00/],
    ["DTSTART;TZID=Europe/Madrid:20260230T090000", /not a valid date-time/],
    ["DTSTART;TZID=Europe/Madrid:20261120T250000", /not a valid date-time/],
    ["DTSTART;TZID=Europe/Madrid:20260329T023000", /does not exist in Europe\/Madrid/],
    ["DTSTART;VALUE=DATE:20261120", /DTSTART line must look like/],
    [`${D} `, /DTSTART line must look like/],
    [`${D}\nEXDATE:20261121T090000`, /must start with RRULE:/],
    [`${D}\nRRULE:`, /RRULE is empty/],
    [`${D}\nRRULE:INTERVAL=2`, /missing FREQ/],
    [`${D}\nRRULE:FREQ=SECONDLY`, /FREQ must be one of/],
    [`${D}\nRRULE:FREQ=daily`, /FREQ must be one of/],
    [`${D}\nRRULE:FREQ=DAILY;WKST=MO`, /unknown or unsupported part "WKST"/],
    [`${D}\nRRULE:FREQ=DAILY;BYWEEKNO=1`, /unknown or unsupported part "BYWEEKNO"/],
    [`${D}\nRRULE:FREQ=DAILY;FREQ=WEEKLY`, /duplicate part FREQ/],
    [`${D}\nRRULE:FREQ=DAILY;BYHOUR=9;BYHOUR=10`, /duplicate part BYHOUR/],
    [`${D}\nRRULE:FREQ=DAILY;INTERVAL=`, /INTERVAL has an empty value/],
    [`${D}\nRRULE:FREQ=DAILY;INTERVAL=0`, /INTERVAL must be a positive integer/],
    [`${D}\nRRULE:FREQ=DAILY;INTERVAL=-1`, /INTERVAL must be a positive integer/],
    [`${D}\nRRULE:FREQ=DAILY;INTERVAL=1.5`, /INTERVAL must be a positive integer/],
    [`${D}\nRRULE:FREQ=DAILY;COUNT=0`, /COUNT must be a positive integer/],
    [`${D}\nRRULE:FREQ=DAILY;BYHOUR=24`, /BYHOUR value 24 is out of range 0..23/],
    [`${D}\nRRULE:FREQ=DAILY;BYMINUTE=60`, /BYMINUTE value 60 is out of range/],
    [`${D}\nRRULE:FREQ=DAILY;BYMINUTE=-5`, /BYMINUTE value "-5" is not a non-negative integer/],
    [`${D}\nRRULE:FREQ=YEARLY;BYMONTH=13`, /BYMONTH value 13 is out of range 1..12/],
    [`${D}\nRRULE:FREQ=YEARLY;BYMONTH=0`, /BYMONTH value 0 is out of range/],
    [`${D}\nRRULE:FREQ=MONTHLY;BYMONTHDAY=0`, /BYMONTHDAY value 0 is out of range/],
    [`${D}\nRRULE:FREQ=MONTHLY;BYMONTHDAY=32`, /BYMONTHDAY value 32 is out of range/],
    [`${D}\nRRULE:FREQ=MONTHLY;BYMONTHDAY=-32`, /BYMONTHDAY value -32 is out of range/],
    [`${D}\nRRULE:FREQ=MONTHLY;BYMONTHDAY=1,,15`, /BYMONTHDAY has an empty value/],
    [`${D}\nRRULE:FREQ=MONTHLY;BYMONTHDAY=1,1`, /BYMONTHDAY repeats the value 1/],
    [`${D}\nRRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=0`, /BYSETPOS value 0 is out of range/],
    [`${D}\nRRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=367`, /BYSETPOS value 367 is out of range/],
    [`${D}\nRRULE:FREQ=MONTHLY;BYSETPOS=1`, /BYSETPOS needs at least one other BYxxx part/],
    [`${D}\nRRULE:FREQ=MONTHLY;BYDAY=1MO`, /ordinals like "1MO" are not supported/],
    [`${D}\nRRULE:FREQ=MONTHLY;BYDAY=-1FR`, /ordinals like "-1FR" are not supported/],
    [`${D}\nRRULE:FREQ=WEEKLY;BYDAY=MON`, /BYDAY value "MON" is not one of/],
    [`${D}\nRRULE:FREQ=WEEKLY;BYDAY=mo`, /BYDAY value "mo" is not one of/],
    [`${D}\nRRULE:FREQ=WEEKLY;BYDAY=MO,MO`, /BYDAY repeats the value MO/],
    [`${D}\nRRULE:FREQ=DAILY;COUNT=3;UNTIL=20261231T225959Z`, /both COUNT and UNTIL/],
    [`${D}\nRRULE:FREQ=DAILY;UNTIL=20261231T225959`, /UNTIL must be a UTC date-time/],
    [`${D}\nRRULE:FREQ=DAILY;UNTIL=20261231`, /UNTIL must be a UTC date-time/],
    [`${D}\nRRULE:FREQ=DAILY;UNTIL=20261332T000000Z`, /UNTIL is not a valid date-time/],
    [`${D}\nRRULE:FREQ=DAILY;`, /part "" is not NAME=VALUE/],
    [`${D}\nRRULE:FREQ=DAILY;;INTERVAL=2`, /part "" is not NAME=VALUE/],
    [`${D}\nRRULE:FREQ=DAILY;INTERVAL`, /part "INTERVAL" is not NAME=VALUE/],
    [`${D}\nRRULE:FREQ=DAILY;INTERVAL=2x`, /INTERVAL must be a positive integer/],
    [`${D}\nRRULE:FREQ=DAILY junk`, /FREQ must be one of/],
    [`${D}\r\nRRULE:FREQ=DAILY`, /DTSTART line must look like/],
  ]
  for (const [text, message] of bad) assert.throws(() => parseSchedule(text), message, JSON.stringify(text))
})

test("formatting is canonical and round-trips", () => {
  const canonical = [
    "DTSTART;TZID=Europe/Madrid:20261120T090000",
    "DTSTART:20260101T000000Z",
    "DTSTART;TZID=Europe/Madrid:20261120T090000\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261231T225959Z",
    "DTSTART;TZID=America/New_York:20260105T090000\nRRULE:FREQ=MONTHLY;INTERVAL=3;BYMONTH=1,4,7,10;BYMONTHDAY=-1,1,15;BYDAY=MO,FR;BYHOUR=9,17;BYMINUTE=0,30;BYSETPOS=-1,1;COUNT=12",
  ]
  for (const text of canonical) {
    assert.equal(formatSchedule(parseSchedule(text)), text)
    assert.equal(formatSchedule(parseSchedule(formatSchedule(parseSchedule(text)))), text)
  }
  const messy = "DTSTART;TZID=UTC:20261120T090000\nRRULE:BYDAY=FR,MO;BYHOUR=17,9;INTERVAL=1;BYMONTHDAY=+15,-1,1;FREQ=MONTHLY;BYSETPOS=-1,2"
  assert.equal(formatSchedule(parseSchedule(messy)), "DTSTART:20261120T090000Z\nRRULE:FREQ=MONTHLY;BYMONTHDAY=-1,1,15;BYDAY=MO,FR;BYHOUR=9,17;BYSETPOS=-1,2")
  const rule = parseSchedule(messy).rule!
  assert.equal(rule.interval, 1)
  assert.deepEqual(rule.byDay, ["MO", "FR"])
  assert.deepEqual(rule.byMonthDay, [-1, 1, 15])
})

test("a never-matching rule returns null quickly", () => {
  for (const rrule of [
    "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=31",
    "FREQ=MONTHLY;BYMONTH=4,6,9,11;BYMONTHDAY=31",
    "FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30,31",
    "FREQ=MINUTELY;BYMONTH=2;BYMONTHDAY=-31",
    "FREQ=HOURLY;INTERVAL=2;BYHOUR=1",
    "FREQ=MINUTELY;BYMINUTE=0;BYSETPOS=2",
    "FREQ=DAILY;INTERVAL=7;BYDAY=TU",
    "FREQ=HOURLY;INTERVAL=168;BYDAY=TU",
  ]) {
    const s = parseSchedule(`DTSTART:20260105T000000Z\nRRULE:${rrule}`)
    const t = performance.now()
    assert.equal(nextAfter(s, at("2026-06-01T00:00:00Z")), null, rrule)
    assert.ok(performance.now() - t < 250, `${rrule} took ${performance.now() - t} ms`)
  }
})

test("the jump path is fast: MINUTELY every 10 minutes from 2020, queried in 2026", () => {
  const s = parseSchedule("DTSTART;TZID=Europe/Madrid:20200101T000000\nRRULE:FREQ=MINUTELY;INTERVAL=10")
  nextAfter(s, at("2026-01-01T00:00:00Z")) // warm up
  const t = performance.now()
  const x = nextAfter(s, at("2026-06-15T12:34:56Z"))
  const ms = performance.now() - t
  assert.equal(x?.toString(), "2026-06-15T12:40:00Z")
  assert.ok(ms < 50, `took ${ms} ms`)
  const t2 = performance.now()
  assert.equal(nextOccurrences(s, at("2026-06-15T12:34:56Z"), 100).length, 100)
  assert.ok(performance.now() - t2 < 50)
})

test("instants with sub-minute precision and queries at an occurrence", () => {
  const s = parseSchedule("DTSTART;TZID=Asia/Kolkata:20260101T093000\nRRULE:FREQ=DAILY")
  assert.equal(nextAfter(s, at("2026-02-01T03:59:59.999999999Z"))?.toString(), "2026-02-01T04:00:00Z")
  assert.equal(nextAfter(s, at("2026-02-01T04:00:00Z"))?.toString(), "2026-02-02T04:00:00Z")
  assert.equal(nextAfter(s, at("2026-02-01T04:00:00.000000001Z"))?.toString(), "2026-02-02T04:00:00Z")
  assert.deepEqual(nextOccurrences(s, at("2026-02-01T00:00:00Z"), 0), [])
})
