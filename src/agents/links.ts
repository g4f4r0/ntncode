import fs from "node:fs"
import path from "node:path"
import type { Paths } from "../shared/config.ts"
import { lstat } from "../shared/files.ts"
import { show, type Check, type Result } from "../shared/module.ts"

/** A path an agent reads, linked to the one copy in ~/.agents. */
export interface Link {
  link: string
  target: string
}

function pointsAt(link: string, target: string): boolean {
  const stats = lstat(link)
  return !!stats?.isSymbolicLink() && path.resolve(path.dirname(link), fs.readlinkSync(link)) === target
}

/** Creates each missing link (relative, as `../.agents/...`). Anything else already at a link's path is left alone. */
export function ensureLinks(links: Link[], { dryRun = false } = {}): Result[] {
  return links.flatMap(({ link, target }): Result[] => {
    if (pointsAt(link, target)) return []
    if (lstat(link)) return [{ status: "skipped", path: link, detail: `something else is there; left it alone (expected a link to ${target})` }]
    if (!lstat(target)) return [{ status: "skipped", path: link, detail: `${target} does not exist yet; no link made` }]
    if (dryRun) return [{ status: "would link", path: link, detail: `→ ${target}` }]
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(path.relative(path.dirname(link), target), link)
    return [{ status: "linked", path: link, detail: `→ ${target}` }]
  })
}

export function linkChecks(paths: Paths, links: Link[]): Check[] {
  return links.map(({ link, target }): Check =>
    pointsAt(link, target)
      ? { ok: true, name: show(paths, link), detail: `links to ${show(paths, target)}` }
      : {
          ok: false,
          level: "error",
          name: show(paths, link),
          detail: lstat(link) ? `something else is there, not a link to ${show(paths, target)}` : `missing; should link to ${show(paths, target)}`,
          fix: lstat(link) ? `move ${show(paths, link)} away (keep what you need from it), then run ntncode sync` : "run ntncode sync",
        },
  )
}
