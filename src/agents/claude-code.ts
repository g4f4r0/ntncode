import path from "node:path"
import type { Paths } from "../shared/config.ts"
import type { Link } from "./links.ts"

/**
 * Claude Code reads AGENTS.md in a session's folder and its parents, but its global file is ~/.claude/CLAUDE.md and
 * it doesn't read ~/.agents/skills, so both are linked.
 */
export function claudeCodeLinks(paths: Paths): Link[] {
  return [
    { link: path.join(paths.home, ".claude/CLAUDE.md"), target: path.join(paths.agents, "AGENTS.md") },
    { link: path.join(paths.home, ".claude/skills"), target: path.join(paths.agents, "skills") },
  ]
}
