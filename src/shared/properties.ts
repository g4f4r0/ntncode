import { z } from "zod"
import { plainText, type NotionProperty } from "./notion.ts"

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
