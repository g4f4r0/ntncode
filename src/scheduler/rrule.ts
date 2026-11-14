// A small, exact iCalendar recurrence engine (RFC 5545 subset).
//
// Semantics follow python-dateutil's rrule, evaluated in the wall-clock time of
// the start's time zone: occurrences are expanded as local wall times, then each
// wall time becomes an instant with disambiguation "compatible" (a time in a
// spring-forward gap moves forward by the gap; an ambiguous fall-back time takes
// the earlier offset). test/scheduler/fixtures.json cross-checks against dateutil.

export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU"
export type Frequency = "YEARLY" | "MONTHLY" | "WEEKLY" | "DAILY" | "HOURLY" | "MINUTELY"
export interface Rule {
  freq: Frequency
  interval: number
  byDay: Weekday[]
  byMonthDay: number[]
  byMonth: number[]
  byHour: number[]
  byMinute: number[]
  bySetPos: number[]
  count: number | null
  until: Temporal.Instant | null
}
export interface Schedule {
  start: Temporal.ZonedDateTime
  rule: Rule | null
}

const WEEKDAYS: readonly Weekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]
const FREQUENCIES: readonly Frequency[] = ["YEARLY", "MONTHLY", "WEEKLY", "DAILY", "HOURLY", "MINUTELY"]

// ---------------------------------------------------------------------------
// Parsing and formatting

const DTSTART = /^DTSTART(?:;TZID=([^:;]*))?:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/
const UNTIL = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/
const PART_ORDER = ["FREQ", "INTERVAL", "BYMONTH", "BYMONTHDAY", "BYDAY", "BYHOUR", "BYMINUTE", "BYSETPOS", "COUNT", "UNTIL"] as const
type PartName = (typeof PART_ORDER)[number]

export function parseSchedule(text: string): Schedule {
  if (typeof text !== "string") throw new Error("schedule must be a string")
  const lines = text.split("\n")
  if (lines.length > 2) throw new Error(`schedule has ${lines.length} lines; expected DTSTART and an optional RRULE line`)
  const first = lines[0] ?? ""
  if (first === "") throw new Error("schedule is missing the DTSTART line")
  const start = parseStart(first)
  if (lines.length === 1) return { start, rule: null }
  const second = lines[1] ?? ""
  if (second === "") throw new Error("schedule has an empty second line; expected RRULE:...")
  return { start, rule: parseRule(second) }
}

function parseStart(line: string): Temporal.ZonedDateTime {
  const m = DTSTART.exec(line)
  if (!m) throw new Error(`DTSTART line must look like DTSTART;TZID=Europe/Madrid:20261120T090000 or DTSTART:20260101T000000Z, got "${line}"`)
  const [, tzid, year, month, day, hour, minute, second, z] = m
  if (tzid !== undefined && z === "Z") throw new Error("DTSTART cannot have both TZID and a trailing Z")
  if (tzid === undefined && z !== "Z") throw new Error("DTSTART needs a TZID or a trailing Z (floating times are not supported)")
  if (second !== "00") throw new Error(`DTSTART seconds must be 00, got ${second}`)
  if (tzid === "") throw new Error("DTSTART has an empty TZID")
  if (tzid !== undefined && /^[+-]/.test(tzid)) throw new Error(`DTSTART TZID must be an IANA time zone name, got "${tzid}"`)
  const wall = plainFrom("DTSTART", Number(year), Number(month), Number(day), Number(hour), Number(minute), 0)
  const zone = tzid ?? "UTC"
  let start: Temporal.ZonedDateTime
  try {
    start = wall.toZonedDateTime(zone, { disambiguation: "compatible" })
  } catch {
    throw new Error(`DTSTART has an unknown time zone "${zone}"`)
  }
  if (!start.toPlainDateTime().equals(wall)) throw new Error(`DTSTART ${wall.toString()} does not exist in ${start.timeZoneId} (daylight saving gap)`)
  return start
}

function plainFrom(what: string, year: number, month: number, day: number, hour: number, minute: number, second: number): Temporal.PlainDateTime {
  try {
    return Temporal.PlainDateTime.from({ year, month, day, hour, minute, second }, { overflow: "reject" })
  } catch {
    throw new Error(`${what} is not a valid date-time: ${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)} ${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}`)
  }
}

function parseRule(line: string): Rule {
  if (!line.startsWith("RRULE:")) throw new Error(`second line must start with RRULE:, got "${line}"`)
  const body = line.slice("RRULE:".length)
  if (body === "") throw new Error("RRULE is empty")
  const seen = new Map<PartName, string>()
  for (const part of body.split(";")) {
    const eq = part.indexOf("=")
    if (eq < 0) throw new Error(`RRULE part "${part}" is not NAME=VALUE`)
    const name = part.slice(0, eq)
    const value = part.slice(eq + 1)
    if (!(PART_ORDER as readonly string[]).includes(name)) throw new Error(`RRULE has an unknown or unsupported part "${name}"`)
    if (seen.has(name as PartName)) throw new Error(`RRULE has a duplicate part ${name}`)
    if (value === "") throw new Error(`RRULE part ${name} has an empty value`)
    seen.set(name as PartName, value)
  }
  const freq = seen.get("FREQ")
  if (freq === undefined) throw new Error("RRULE is missing FREQ")
  if (!(FREQUENCIES as readonly string[]).includes(freq)) throw new Error(`RRULE FREQ must be one of ${FREQUENCIES.join(", ")}, got "${freq}"`)
  const get = (name: PartName) => seen.get(name)
  const rule: Rule = {
    freq: freq as Frequency,
    interval: positive("INTERVAL", get("INTERVAL")) ?? 1,
    byMonth: intList("BYMONTH", get("BYMONTH"), 1, 12, false),
    byMonthDay: intList("BYMONTHDAY", get("BYMONTHDAY"), 1, 31, true),
    byDay: dayList(get("BYDAY")),
    byHour: intList("BYHOUR", get("BYHOUR"), 0, 23, false),
    byMinute: intList("BYMINUTE", get("BYMINUTE"), 0, 59, false),
    bySetPos: intList("BYSETPOS", get("BYSETPOS"), 1, 366, true),
    count: positive("COUNT", get("COUNT")),
    until: until(get("UNTIL")),
  }
  if (rule.count !== null && rule.until !== null) throw new Error("RRULE cannot have both COUNT and UNTIL")
  if (rule.bySetPos.length > 0 && rule.byMonth.length + rule.byMonthDay.length + rule.byDay.length + rule.byHour.length + rule.byMinute.length === 0) {
    throw new Error("RRULE BYSETPOS needs at least one other BYxxx part")
  }
  return rule
}

function positive(name: string, value: string | undefined): number | null {
  if (value === undefined) return null
  if (!/^\d+$/.test(value)) throw new Error(`RRULE ${name} must be a positive integer, got "${value}"`)
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`RRULE ${name} must be a positive integer, got "${value}"`)
  return n
}

function intList(name: string, value: string | undefined, min: number, max: number, signed: boolean): number[] {
  if (value === undefined) return []
  const out: number[] = []
  for (const item of value.split(",")) {
    if (item === "") throw new Error(`RRULE ${name} has an empty value in "${value}"`)
    if (!(signed ? /^[+-]?\d{1,4}$/ : /^\d{1,4}$/).test(item)) throw new Error(`RRULE ${name} value "${item}" is not ${signed ? "an integer" : "a non-negative integer"}`)
    const n = Number(item)
    const ok = signed ? n !== 0 && Math.abs(n) >= min && Math.abs(n) <= max : n >= min && n <= max
    if (!ok) throw new Error(`RRULE ${name} value ${item} is out of range ${signed ? `-${max}..-${min} or ${min}..${max}` : `${min}..${max}`}`)
    if (out.includes(n)) throw new Error(`RRULE ${name} repeats the value ${item}`)
    out.push(n)
  }
  return out.sort((a, b) => a - b)
}

function dayList(value: string | undefined): Weekday[] {
  if (value === undefined) return []
  const out: Weekday[] = []
  for (const item of value.split(",")) {
    if (item === "") throw new Error(`RRULE BYDAY has an empty value in "${value}"`)
    if (/^[+-]?\d+[A-Z]{2}$/.test(item)) throw new Error(`RRULE BYDAY ordinals like "${item}" are not supported; use BYSETPOS`)
    if (!(WEEKDAYS as readonly string[]).includes(item)) throw new Error(`RRULE BYDAY value "${item}" is not one of ${WEEKDAYS.join(",")}`)
    if (out.includes(item as Weekday)) throw new Error(`RRULE BYDAY repeats the value ${item}`)
    out.push(item as Weekday)
  }
  return out.sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b))
}

function until(value: string | undefined): Temporal.Instant | null {
  if (value === undefined) return null
  const m = UNTIL.exec(value)
  if (!m) throw new Error(`RRULE UNTIL must be a UTC date-time like 20261231T225959Z, got "${value}"`)
  const [, y, mo, d, h, mi, s] = m
  return plainFrom("RRULE UNTIL", Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s)).toZonedDateTime("UTC").toInstant()
}

export function formatSchedule(schedule: Schedule): string {
  const s = schedule.start
  const stamp = `${pad(s.year, 4)}${pad(s.month, 2)}${pad(s.day, 2)}T${pad(s.hour, 2)}${pad(s.minute, 2)}${pad(s.second, 2)}`
  const first = s.timeZoneId === "UTC" ? `DTSTART:${stamp}Z` : `DTSTART;TZID=${s.timeZoneId}:${stamp}`
  const r = schedule.rule
  if (r === null) return first
  const nums = (xs: number[]) => sortedUnique(xs).join(",")
  const parts: string[] = [`FREQ=${r.freq}`]
  if (r.interval !== 1) parts.push(`INTERVAL=${r.interval}`)
  if (r.byMonth.length) parts.push(`BYMONTH=${nums(r.byMonth)}`)
  if (r.byMonthDay.length) parts.push(`BYMONTHDAY=${nums(r.byMonthDay)}`)
  if (r.byDay.length) parts.push(`BYDAY=${WEEKDAYS.filter((d) => r.byDay.includes(d)).join(",")}`)
  if (r.byHour.length) parts.push(`BYHOUR=${nums(r.byHour)}`)
  if (r.byMinute.length) parts.push(`BYMINUTE=${nums(r.byMinute)}`)
  if (r.bySetPos.length) parts.push(`BYSETPOS=${nums(r.bySetPos)}`)
  if (r.count !== null) parts.push(`COUNT=${r.count}`)
  if (r.until !== null) {
    const u = r.until.toZonedDateTimeISO("UTC")
    parts.push(`UNTIL=${pad(u.year, 4)}${pad(u.month, 2)}${pad(u.day, 2)}T${pad(u.hour, 2)}${pad(u.minute, 2)}${pad(u.second, 2)}Z`)
  }
  return `${first}\nRRULE:${parts.join(";")}`
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0")
}

function sortedUnique(xs: readonly number[]): number[] {
  return [...new Set(xs)].sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// Calendar math. Days are counted from 1970-01-01 (day 0, a Thursday); a "wall"
// is a local wall-clock time in whole minutes since 1970-01-01T00:00 (naive).

function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y
  const era = Math.floor(yy / 400)
  const yoe = yy - era * 400
  const doy = Math.floor((153 * ((m + 9) % 12) + 2) / 5) + d - 1
  return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468
}

function civilFromDays(days: number): [number, number, number] {
  const z = days + 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1
  const m = mp < 10 ? mp + 3 : mp - 9
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d]
}

const weekdayOf = (day: number): number => (((day + 3) % 7) + 7) % 7 // 0 = Monday
const MONTH_DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
const daysInMonth = (y: number, m: number): number => (m === 2 && isLeap(y) ? 29 : MONTH_DAYS[m]!)
const MAX_YEAR = 9999 // dateutil stops at datetime.MAXYEAR

// ---------------------------------------------------------------------------
// Expansion plan: the rule with dateutil's defaults applied.

interface Plan {
  freq: Frequency
  interval: number
  zone: string
  startWall: number
  startDay: number
  startHour: number
  months: boolean[] | null // index 1..12
  weekdays: boolean[] | null // index 0..6, Monday first
  posMonthDays: boolean[] | null // index 1..31
  negMonthDays: boolean[] | null // index 1..31 for -1..-31
  hours: boolean[] | null // HOURLY/MINUTELY filter
  minutes: boolean[] | null // MINUTELY filter
  times: number[] // minute-of-day (YEARLY..DAILY) or minute-of-hour (HOURLY)
  setPos: number[]
  count: number | null
  untilMs: number | null
  never: boolean
}

function mask(values: readonly number[], size: number, map: (v: number) => number = (v) => v): boolean[] {
  const out = new Array<boolean>(size).fill(false)
  for (const v of values) out[map(v)] = true
  return out
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b]
  return a
}

function plan(start: Temporal.ZonedDateTime, rule: Rule): Plan {
  if (!Number.isSafeInteger(rule.interval) || rule.interval < 1) throw new Error(`rule interval must be a positive integer, got ${rule.interval}`)
  const freq = rule.freq
  const fi = FREQUENCIES.indexOf(freq)
  const startDay = daysFromCivil(start.year, start.month, start.day)
  let byMonth = sortedUnique(rule.byMonth)
  let byMonthDay = sortedUnique(rule.byMonthDay)
  let byDay = WEEKDAYS.filter((d) => rule.byDay.includes(d)).map((d) => WEEKDAYS.indexOf(d))
  if (byDay.length === 0 && byMonthDay.length === 0) {
    if (freq === "YEARLY") {
      if (byMonth.length === 0) byMonth = [start.month]
      byMonthDay = [start.day]
    } else if (freq === "MONTHLY") byMonthDay = [start.day]
    else if (freq === "WEEKLY") byDay = [weekdayOf(startDay)]
  }
  const hours = rule.byHour.length ? sortedUnique(rule.byHour) : fi <= 3 ? [start.hour] : null
  const minutes = rule.byMinute.length ? sortedUnique(rule.byMinute) : fi <= 4 ? [start.minute] : null
  let times: number[] = []
  if (fi <= 3) for (const h of hours!) for (const m of minutes!) times.push(h * 60 + m)
  if (freq === "HOURLY") times = minutes!
  const setPos = sortedUnique(rule.bySetPos)
  const startMinute = start.hour * 60 + start.minute
  let never = false
  // Hours/minutes a fixed wall-clock step can never reach (dateutil raises here).
  if (freq === "HOURLY" && hours) {
    const g = gcd(rule.interval, 24)
    never = !hours.some((h) => (((h - start.hour) % g) + g) % g === 0)
  }
  if (freq === "MINUTELY" && (hours || minutes)) {
    const g = gcd(rule.interval, 1440)
    const hs = hours ?? Array.from({ length: 24 }, (_, i) => i)
    const ms = minutes ?? Array.from({ length: 60 }, (_, i) => i)
    never = !hs.some((h) => ms.some((m) => (((h * 60 + m - startMinute) % g) + g) % g === 0))
  }
  // BYMONTHDAY values no month in BYMONTH has (e.g. 31 in February).
  const monthsOk = byMonth.length ? byMonth : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
  if (byMonthDay.length && !monthsOk.some((m) => byMonthDay.some((d) => Math.abs(d) <= (m === 2 ? 29 : MONTH_DAYS[m]!)))) never = true
  // BYSETPOS positions larger than any period can hold.
  if (setPos.length) {
    const T = times.length
    const largest = [366 * T, 31 * T, 7 * T, T, T, 1][fi]!
    if (setPos.every((p) => Math.abs(p) > largest)) never = true
  }
  return {
    freq,
    interval: rule.interval,
    zone: start.timeZoneId,
    startWall: startDay * 1440 + startMinute,
    startDay,
    startHour: start.hour,
    months: byMonth.length ? mask(byMonth, 13) : null,
    weekdays: byDay.length ? mask(byDay, 7) : null,
    posMonthDays: byMonthDay.length ? mask(byMonthDay.filter((d) => d > 0), 32) : null,
    negMonthDays: byMonthDay.length ? mask(byMonthDay.filter((d) => d < 0), 32, (d) => -d) : null,
    hours: fi >= 4 && hours ? mask(hours, 24) : null,
    minutes: fi === 5 && minutes ? mask(minutes, 60) : null,
    times,
    setPos,
    count: rule.count,
    untilMs: rule.until === null ? null : floorMs(rule.until),
    never,
  }
}

function dayMatches(p: Plan, y: number, m: number, d: number, weekday: number): boolean {
  if (p.months && !p.months[m]) return false
  if (p.weekdays && !p.weekdays[weekday]) return false
  if (p.posMonthDays && !p.posMonthDays[d] && !p.negMonthDays![daysInMonth(y, m) - d + 1]) return false
  return true
}

// ---------------------------------------------------------------------------
// Periods. Each chunk holds the periods of one YEARLY/MONTHLY/WEEKLY/DAILY step,
// or one day of HOURLY/MINUTELY steps; `weight` feeds the never-match guard
// (periods for YEARLY..DAILY, days for HOURLY/MINUTELY).

interface Period {
  days: number[]
  times: number[]
}
interface Chunk {
  periods: Period[]
  weight: number
}

const EMPTY_LIMIT: Record<Frequency, number> = {
  // About 400 years (one Gregorian cycle) without an occurrence.
  YEARLY: 400,
  MONTHLY: 4800,
  WEEKLY: 20871,
  DAILY: 146097,
  HOURLY: 146097,
  MINUTELY: 146097,
}

// `from` (a wall) lets the scan jump straight to the period that contains it;
// null scans from the start (needed when COUNT is set).
function* chunks(p: Plan, from: number | null): Generator<Chunk> {
  const { interval, startDay } = p
  const fromDay = from === null ? startDay : Math.floor(from / 1440)
  const index = (base: number): number => Math.max(0, Math.floor(base / interval))
  const [y0, m0] = civilFromDays(startDay)
  // Periods (days for HOURLY/MINUTELY) without a matching day are skipped here
  // and carried into the next chunk's weight; too many in a row end the scan.
  const limit = EMPTY_LIMIT[p.freq]
  let skipped = 0
  function* emit(days: number[]): Generator<Chunk> {
    yield { periods: [{ days, times: p.times }], weight: skipped + 1 }
    skipped = 0
  }
  switch (p.freq) {
    case "YEARLY": {
      for (let k = index(civilFromDays(fromDay)[0] - y0); ; k++) {
        const y = y0 + k * interval
        if (y > MAX_YEAR) return
        const days: number[] = []
        for (let m = 1; m <= 12; m++) {
          if (p.months && !p.months[m]) continue
          const first = daysFromCivil(y, m, 1)
          for (let d = 1, n = daysInMonth(y, m); d <= n; d++) if (dayMatches(p, y, m, d, weekdayOf(first + d - 1))) days.push(first + d - 1)
        }
        if (days.length) yield* emit(days)
        else if (++skipped > limit) return
      }
    }
    case "MONTHLY": {
      const [fy, fm] = civilFromDays(fromDay)
      const base0 = y0 * 12 + m0 - 1
      for (let k = index(fy * 12 + fm - 1 - base0); ; k++) {
        const at = base0 + k * interval
        const y = Math.floor(at / 12)
        const m = at - y * 12 + 1
        if (y > MAX_YEAR) return
        const days: number[] = []
        const first = daysFromCivil(y, m, 1)
        for (let d = 1, n = daysInMonth(y, m); d <= n; d++) if (dayMatches(p, y, m, d, weekdayOf(first + d - 1))) days.push(first + d - 1)
        if (days.length) yield* emit(days)
        else if (++skipped > limit) return
      }
    }
    case "WEEKLY": {
      const monday0 = startDay - weekdayOf(startDay)
      for (let k = index(Math.floor((fromDay - monday0) / 7)); ; k++) {
        const monday = monday0 + 7 * k * interval
        // dateutil's first week runs from the start day to the end of that week.
        const days: number[] = []
        for (let day = k === 0 ? startDay : monday; day < monday + 7; day++) {
          const [y, m, d] = civilFromDays(day)
          if (y > MAX_YEAR) return
          if (dayMatches(p, y, m, d, weekdayOf(day))) days.push(day)
        }
        if (days.length) yield* emit(days)
        else if (++skipped > limit) return
      }
    }
    case "DAILY": {
      for (let k = index(fromDay - startDay); ; k++) {
        const day = startDay + k * interval
        const [y, m, d] = civilFromDays(day)
        if (y > MAX_YEAR) return
        if (dayMatches(p, y, m, d, weekdayOf(day))) yield* emit([day])
        else if (++skipped > limit) return
      }
    }
    case "HOURLY":
    case "MINUTELY": {
      // Steps count wall-clock hours or minutes from the start.
      const hourly = p.freq === "HOURLY"
      const perDay = hourly ? 24 : 1440
      const s0 = hourly ? startDay * 24 + p.startHour : p.startWall
      const next = (lo: number) => (lo <= s0 ? s0 : s0 + Math.ceil((lo - s0) / interval) * interval)
      let a = from === null ? s0 : next(hourly ? Math.floor(from / 60) : from)
      for (;;) {
        const day = Math.floor(a / perDay)
        const [y, m, d] = civilFromDays(day)
        if (y > MAX_YEAR) return
        const dayEnd = (day + 1) * perDay
        if (!dayMatches(p, y, m, d, weekdayOf(day))) {
          a = next(dayEnd)
          if ((skipped += Math.floor(a / perDay) - day) > limit) return
          continue
        }
        const periods: Period[] = []
        for (; a < dayEnd; a += interval) {
          const unit = a - day * perDay
          if (hourly) {
            if (p.hours && !p.hours[unit]) continue
            periods.push({ days: [day], times: p.times.map((minute) => unit * 60 + minute) })
          } else {
            if (p.hours && !p.hours[Math.floor(unit / 60)]) continue
            if (p.minutes && !p.minutes[unit % 60]) continue
            periods.push({ days: [day], times: [unit] })
          }
        }
        yield { periods, weight: skipped + Math.floor(a / perDay) - day }
        skipped = 0
      }
    }
  }
}

// The period's walls in ascending order, after BYSETPOS (dateutil indexes the
// flattened, sorted day x time list).
function periodWalls(period: Period, setPos: readonly number[]): number[] {
  const { days, times } = period
  const T = times.length
  const wall = (i: number) => days[Math.floor(i / T)]! * 1440 + times[i % T]!
  const n = days.length * T
  const out: number[] = []
  if (setPos.length === 0) {
    for (let i = 0; i < n; i++) out.push(wall(i))
    return out
  }
  const picked = new Set<number>()
  for (const pos of setPos) {
    const i = pos > 0 ? pos - 1 : n + pos
    if (i >= 0 && i < n) picked.add(i)
  }
  return [...picked].sort((a, b) => a - b).map(wall)
}

interface Occurrence {
  wall: number
  ms: number
}

// Occurrences in wall-clock order, as dateutil emits them. Walls before `from`
// are not converted to instants (they all fall at or before the query instant)
// but still count toward COUNT.
function* occurrences(p: Plan, from: number): Generator<Occurrence> {
  if (p.never) return
  let remaining = p.count
  let empty = 0
  for (const chunk of chunks(p, p.count === null ? from : null)) {
    let emitted = false
    for (const period of chunk.periods) {
      for (const wall of periodWalls(period, p.setPos)) {
        if (wall < p.startWall) continue
        emitted = true
        if (wall < from) {
          if (remaining !== null && --remaining < 0) return
          continue
        }
        const ms = wallToMs(p.zone, wall)
        if (p.untilMs !== null && ms > p.untilMs) return
        if (remaining !== null && --remaining < 0) return
        yield { wall, ms }
      }
    }
    if (emitted) empty = 0
    else if ((empty += chunk.weight) > EMPTY_LIMIT[p.freq]) return
  }
}

function wallToMs(zone: string, wall: number): number {
  if (zone === "UTC") return wall * 60000
  const day = Math.floor(wall / 1440)
  const minute = wall - day * 1440
  const [y, m, d] = civilFromDays(day)
  return new Temporal.PlainDateTime(y, m, d, Math.floor(minute / 60), minute % 60).toZonedDateTime(zone, { disambiguation: "compatible" }).epochMilliseconds
}

// The real local wall time (in minutes) of an instant.
function msToWall(zone: string, ms: number): number {
  if (zone === "UTC") return Math.floor(ms / 60000)
  const offset = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone).offsetNanoseconds / 1e6
  return Math.floor((ms + offset) / 60000)
}

function floorMs(instant: Temporal.Instant): number {
  const ns = instant.epochNanoseconds
  let q = ns / 1000000n
  if (ns % 1000000n < 0n) q -= 1n
  return Number(q)
}

// The earliest wall that can map to an instant after `after`. Normally the wall
// time of `after` itself; right after a spring-forward transition, walls inside
// the gap (which map past the transition) are earlier, so back up by the gap.
function scanStart(zone: string, after: Temporal.Instant, afterMs: number): number {
  const z = after.toZonedDateTimeISO(zone)
  const wall = Math.floor((afterMs + z.offsetNanoseconds / 1e6) / 60000)
  const t = z.add({ nanoseconds: 1 }).getTimeZoneTransition("previous")
  if (t === null) return wall
  const gapMs = (t.offsetNanoseconds - t.subtract({ nanoseconds: 1 }).offsetNanoseconds) / 1e6
  return gapMs > 0 && afterMs < t.epochMilliseconds + gapMs ? wall - Math.ceil(gapMs / 60000) : wall
}

// ---------------------------------------------------------------------------
// Queries

export function nextAfter(schedule: Schedule, after: Temporal.Instant): Temporal.Instant | null {
  return nextOccurrences(schedule, after, 1)[0] ?? null
}

// The first `n` distinct occurrence instants strictly after `after`, ascending.
export function nextOccurrences(schedule: Schedule, after: Temporal.Instant, n: number): Temporal.Instant[] {
  if (!Number.isInteger(n) || n < 0) throw new Error(`n must be a non-negative integer, got ${n}`)
  if (n === 0) return []
  if (schedule.rule === null) {
    const start = schedule.start.toInstant()
    return Temporal.Instant.compare(start, after) > 0 ? [start] : []
  }
  const p = plan(schedule.start, schedule.rule)
  const afterMs = floorMs(after)
  const out: number[] = []
  // Wall order equals instant order except around a spring-forward gap, where a
  // gap wall maps past later walls. Hold each candidate until the scan reaches
  // its real wall time; no later wall can map to an earlier instant after that.
  const pending: { ms: number; realWall: number }[] = []
  let last = afterMs
  const flush = (upTo: number): boolean => {
    while (pending.length && pending[0]!.realWall <= upTo) {
      const ms = pending.shift()!.ms
      if (ms > last) {
        out.push(ms)
        last = ms
        if (out.length === n) return true
      }
    }
    return false
  }
  for (const occ of occurrences(p, scanStart(p.zone, after, afterMs))) {
    if (occ.ms > last && !pending.some((x) => x.ms === occ.ms)) {
      const at = pending.findIndex((x) => x.ms > occ.ms)
      pending.splice(at < 0 ? pending.length : at, 0, { ms: occ.ms, realWall: msToWall(p.zone, occ.ms) })
    }
    if (flush(occ.wall)) break
  }
  if (out.length < n) flush(Infinity)
  return out.map((ms) => Temporal.Instant.fromEpochMilliseconds(ms))
}
