// A skill's download and checks, from opencode-notion's src/export.ts.
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import { disableModelInvocation } from "../shared/markdown.ts"
import type { Notion, NotionPage, NotionSkill } from "../shared/notion.ts"

const run = promisify(execFile)

/** A skill's name, which is its folder name. */
export const SkillName = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "must be lowercase words joined by hyphens")

/** Reads the simple YAML frontmatter Notion writes into SKILL.md, block scalars included. */
export function parseFrontmatter(markdown: string): Record<string, string> {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/u)
  if (!match) throw new Error("SKILL.md must start with YAML frontmatter")
  const data: Record<string, string> = {}
  const lines = match[1]!.split("\n")
  for (let index = 0; index < lines.length; index += 1) {
    const pair = lines[index]!.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/u)
    if (!pair) continue
    const key = pair[1]!
    const value = pair[2]!
    if (/^[|>][-+]?$/u.test(value)) {
      const parts: string[] = []
      while (lines[index + 1]?.startsWith("  ")) {
        parts.push(lines[index + 1]!.slice(2))
        index += 1
      }
      data[key] = parts.join("\n")
      continue
    }
    data[key] = value.replace(/^["']|["']$/gu, "")
  }
  return data
}

/** Rejects an empty archive, or one with absolute or parent-relative paths. */
export function assertArchivePaths(entries: string[]): void {
  if (entries.length === 0) throw new Error("Notion returned an empty skill archive")
  for (const entry of entries) {
    const normalized = entry.replaceAll("\\", "/")
    const segments = normalized.split("/").filter(Boolean)
    if (normalized.startsWith("/") || segments.includes("..") || normalized.includes("\0")) throw new Error(`unsafe archive path: ${entry}`)
  }
}

/** False only when the Skills page has its Auto-invoke checkbox unticked. */
export function isAutoInvoked(page: NotionPage): boolean {
  return (page.properties?.["Auto-invoke"] as { checkbox?: boolean } | undefined)?.checkbox !== false
}

const normalizeId = (value: string) => value.replaceAll("-", "").toLowerCase()

/** Checks an exported SKILL.md and returns the skill's name. */
export function validateSkill(markdown: string, pageId: string): string {
  const metadata = parseFrontmatter(markdown)
  const name = SkillName.safeParse(metadata.name?.trim())
  if (!name.success) throw new Error(`page ${pageId}: the skill name ${JSON.stringify(metadata.name ?? null)} ${name.error.issues[0]!.message}`)
  if (!metadata.description?.trim()) throw new Error(`skill ${name.data} has no description`)
  if (normalizeId(metadata.notion_page_id ?? "") !== normalizeId(pageId)) throw new Error(`skill ${name.data}: its notion_page_id doesn't match ${pageId}`)
  return name.data
}

async function findSkillFiles(directory: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) found.push(...(await findSkillFiles(file)))
    else if (entry.isFile() && entry.name === "SKILL.md") found.push(file)
  }
  return found
}

/**
 * Downloads one skill into `staging/<page id>` and returns its name and the folder holding its SKILL.md: a safe
 * archive with exactly one SKILL.md, a valid name, description and page ID, and `disable-model-invocation: true` when
 * Auto-invoke is unticked.
 */
export async function downloadSkill(notion: Notion, page: NotionPage, ref: NotionSkill, staging: string): Promise<{ name: string; directory: string }> {
  const extracted = path.join(staging, page.id)
  await fs.mkdir(extracted, { recursive: true })
  if (ref.url) {
    const archive = path.join(staging, `${page.id}.tar.gz`)
    await fs.writeFile(archive, await notion.download(ref.url))
    const list = async (flags: string) => (await run("tar", [flags, archive], { maxBuffer: 64 * 1024 * 1024 })).stdout.trim().split("\n").filter(Boolean)
    assertArchivePaths(await list("-tzf"))
    if ((await list("-tvzf")).some((entry) => entry[0] !== "-" && entry[0] !== "d")) throw new Error(`skill archive ${page.id} contains links or special files`)
    await run("tar", ["-xzf", archive, "-C", extracted, "--no-same-owner", "--no-same-permissions"])
  } else if (typeof ref.markdown === "string") {
    await fs.writeFile(path.join(extracted, "SKILL.md"), ref.markdown)
  } else {
    throw new Error(`Notion returned neither an archive nor markdown for skill ${page.id}`)
  }
  const files = await findSkillFiles(extracted)
  if (files.length !== 1) throw new Error(`page ${page.id}: expected one SKILL.md in the skill, found ${files.length}`)
  const skillFile = files[0]!
  const markdown = await fs.readFile(skillFile, "utf8")
  const name = validateSkill(markdown, page.id)
  if (!isAutoInvoked(page)) await fs.writeFile(skillFile, disableModelInvocation(markdown))
  return { name, directory: path.dirname(skillFile) }
}
