import fs from "node:fs"
import path from "node:path"
import { Reader } from "./properties.ts"
import type { Paths } from "./config.ts"
import { show } from "./module.ts"
import { getTitle, type Notion } from "./notion.ts"

export interface ProjectFolder {
  page: string
  name: string
  /** The project's Path, relative to the projects folder, such as acme or acme/acme-theme. */
  folder: string
  /** That folder on this machine; it exists. */
  directory: string
}

/** A Projects row's folder: its Path under the projects folder, which must exist, so nothing lands somewhere unexpected. */
export async function projectFolder(notion: Notion, paths: Paths, id: string): Promise<ProjectFolder> {
  const page = await notion.getPage(id)
  const folder = new Reader(page.properties ?? {}).text("Path").replace(/\/+$/u, "")
  if (!folder) throw new Error(`Project: the project "${getTitle(page)}" has no Path in Notion`)
  const segments = folder.split("/")
  if (folder.startsWith("/") || segments.some((segment) => !segment || segment.startsWith(".")))
    throw new Error(`Project: the project's Path "${folder}" must be a folder under ${show(paths, paths.projects)}, such as acme or acme/acme-theme`)
  const directory = path.join(paths.projects, folder)
  if (!fs.existsSync(directory)) throw new Error(`Project: ${show(paths, directory)} doesn't exist on this machine`)
  return { page: page.id, name: getTitle(page), folder, directory }
}
