import fs from "node:fs"
import path from "node:path"
import type { Paths } from "../shared/config.ts"
import type { Check } from "../shared/module.ts"
import type { Link } from "./links.ts"

/** Codex reads ~/.agents/skills itself; its global instructions file is ~/.codex/AGENTS.md. */
export function codexLinks(paths: Paths): Link[] {
  return [{ link: path.join(paths.home, ".codex/AGENTS.md"), target: path.join(paths.agents, "AGENTS.md") }]
}

/**
 * Codex reads AGENTS.md files only from the project root down, and finds the root by the nearest marker. With
 * `project_root_markers = ["notion.json"]`, a project folder's AGENTS.md reaches chats opened in its repositories.
 */
export function codexChecks(paths: Paths): Check[] {
  const file = path.join(paths.home, ".codex/config.toml")
  const name = "~/.codex/config.toml"
  if (!fs.existsSync(file)) return [{ ok: false, name, detail: "missing; Codex isn't set up here" }]
  // Top-level keys come before the first [table].
  const top = fs.readFileSync(file, "utf8").split(/^\s*\[/mu)[0]!
  const markers = top.match(/^\s*project_root_markers\s*=\s*\[([^\]]*)\]/mu)?.[1]
  const ok = !!markers && /["']notion\.json["']/u.test(markers)
  return [{ ok, name, detail: ok ? 'project_root_markers includes "notion.json"' : 'add project_root_markers = ["notion.json"] before any [table]' }]
}
