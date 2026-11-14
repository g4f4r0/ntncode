// Minimal ambient types for the global Temporal API that Bun provides.
// Covers only what src/scheduler and its tests use.

declare namespace Temporal {
  type Disambiguation = "compatible" | "earlier" | "later" | "reject"
  type TransitionDirection = "next" | "previous"

  interface DurationLike {
    hours?: number
    minutes?: number
    seconds?: number
    milliseconds?: number
    nanoseconds?: number
  }

  class Instant {
    private constructor()
    static from(item: string | Instant): Instant
    static fromEpochMilliseconds(epochMilliseconds: number): Instant
    static compare(one: Instant, two: Instant): -1 | 0 | 1
    readonly epochMilliseconds: number
    readonly epochNanoseconds: bigint
    add(duration: DurationLike): Instant
    subtract(duration: DurationLike): Instant
    equals(other: Instant): boolean
    toZonedDateTimeISO(timeZone: string): ZonedDateTime
    toString(): string
  }

  class ZonedDateTime {
    private constructor()
    static from(item: string | ZonedDateTime, options?: { disambiguation?: Disambiguation }): ZonedDateTime
    readonly year: number
    readonly month: number
    readonly day: number
    readonly hour: number
    readonly minute: number
    readonly second: number
    readonly millisecond: number
    readonly microsecond: number
    readonly nanosecond: number
    readonly dayOfWeek: number
    readonly timeZoneId: string
    readonly offset: string
    readonly offsetNanoseconds: number
    readonly epochMilliseconds: number
    readonly epochNanoseconds: bigint
    add(duration: DurationLike): ZonedDateTime
    subtract(duration: DurationLike): ZonedDateTime
    getTimeZoneTransition(direction: TransitionDirection): ZonedDateTime | null
    equals(other: ZonedDateTime): boolean
    toInstant(): Instant
    toPlainDateTime(): PlainDateTime
    toString(): string
  }

  interface PlainDateTimeLike {
    year: number
    month: number
    day: number
    hour?: number
    minute?: number
    second?: number
  }

  class PlainDateTime {
    constructor(year: number, month: number, day: number, hour?: number, minute?: number, second?: number)
    static from(item: string | PlainDateTimeLike, options?: { overflow?: "constrain" | "reject" }): PlainDateTime
    readonly year: number
    readonly month: number
    readonly day: number
    readonly hour: number
    readonly minute: number
    readonly second: number
    equals(other: PlainDateTime): boolean
    toZonedDateTime(timeZone: string, options?: { disambiguation?: Disambiguation }): ZonedDateTime
    toString(): string
  }
}
