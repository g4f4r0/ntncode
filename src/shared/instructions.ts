import { getTitle, type Notion } from "./notion.ts"
import { Reader } from "./properties.ts"

/** The Instructions data source's row types: one Global, one per project, and one for automation runs. */
export const INSTRUCTION_TYPES = ["Global", "Project", "Automations"] as const
export type InstructionType = (typeof INSTRUCTION_TYPES)[number]

export interface InstructionRow {
  page: string
  title: string
  url: string | undefined
  edited: string
  type: InstructionType | null
  projects: string[]
  /** What is wrong with the row's properties, if anything. */
  issues: string[]
}

/** Every Instructions row not in Notion's trash. */
export async function readInstructionRows(notion: Notion, source: string): Promise<InstructionRow[]> {
  const pages = (await notion.queryDataSource(source)).filter((page) => !page.in_trash && !page.archived)
  return pages.map((page) => {
    const read = new Reader(page.properties ?? {})
    const type = read.select("Type")
    const projects = read.relation("Project")
    if (type && !(INSTRUCTION_TYPES as readonly string[]).includes(type)) read.fail("Type", `"${type}" is not one of ${INSTRUCTION_TYPES.join(", ")}`)
    else if (!type && !read.issues.length) read.fail("Type", `is empty; set it to one of ${INSTRUCTION_TYPES.join(", ")}`)
    return {
      page: page.id,
      title: getTitle(page),
      url: page.url,
      edited: page.last_edited_time ?? "",
      type: (INSTRUCTION_TYPES as readonly string[]).includes(type ?? "") ? (type as InstructionType) : null,
      projects,
      issues: read.issues,
    }
  })
}

/** The one Automations row: the instructions every automation run gets. Throws when there is more than one. */
export async function automationsRow(notion: Notion, source: string): Promise<InstructionRow | null> {
  const rows = (await readInstructionRows(notion, source)).filter((row) => row.type === "Automations")
  if (rows.length > 1) throw new Error(`the Instructions data source has ${rows.length} Automations rows (${rows.map((row) => `"${row.title}"`).join(", ")}); keep one`)
  return rows[0] ?? null
}
