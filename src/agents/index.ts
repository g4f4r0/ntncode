import type { Paths } from "../shared/config.ts"
import { SYNC_SCHEDULE, type Module } from "../shared/module.ts"
import { claudeCodeLinks } from "./claude-code.ts"
import { codexChecks, codexLinks } from "./codex.ts"
import { ensureLinks, linkChecks } from "./links.ts"

/** Every agent's paths that link into ~/.agents, so there is one copy of everything. */
const allLinks = (paths: Paths) => [...claudeCodeLinks(paths), ...codexLinks(paths)]

/**
 * Where each agent reads its instructions and skills. OpenCode reads project AGENTS.md files and ~/.agents/skills
 * itself; it gets a file here once its global instructions come from Notion Code instead of its Notion plugin.
 */
export const agents: Module = {
  name: "agents",
  tasks: () => [
    {
      id: "agents.links",
      schedule: SYNC_SCHEDULE,
      run: async (context) => ensureLinks(allLinks(context.paths), { dryRun: context.dryRun }),
    },
  ],
  checks: (context) => [...linkChecks(context.paths, allLinks(context.paths)), ...codexChecks(context.paths)],
}
