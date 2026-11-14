import type { Paths } from "../shared/config.ts"
import { SYNC_SCHEDULE, type Module } from "../shared/module.ts"
import type { Agent, AgentName } from "./agent.ts"
import { claudeCode, claudeCodeLinks } from "./claude-code.ts"
import { codex, codexLinks } from "./codex.ts"
import { ensureLinks, linkChecks } from "./links.ts"
import { openCode, openCodeLinks } from "./opencode.ts"

export { AgentName, Effort, modelId, type Agent, type AgentRunInput, type AgentRunOutput, type Usage } from "./agent.ts"
export { explainFailure, redact } from "./failure.ts"

/** Every agent, by the name the Notion Agent property uses. */
export const AGENTS: Record<AgentName, Agent> = { "Claude Code": claudeCode, Codex: codex, OpenCode: openCode }

/** Every agent's paths that link into ~/.agents, so there is one copy of everything. */
const allLinks = (paths: Paths) => [...claudeCodeLinks(paths), ...codexLinks(paths), ...openCodeLinks(paths)]

/** Where each agent reads its instructions and skills, and whether each has the MCP servers it needs. */
export const agents: Module = {
  name: "agents",
  tasks: () => [
    {
      id: "agents.links",
      kind: "sync",
      schedule: SYNC_SCHEDULE,
      since: null,
      run: async (context) => ensureLinks(allLinks(context.paths), { dryRun: context.dryRun }),
    },
  ],
  async checks(context) {
    const required = context.config.mcp
    const perAgent = await Promise.all(Object.values(AGENTS).map((agent) => agent.checks(context.paths, required)))
    return [...linkChecks(context.paths, allLinks(context.paths)), ...perAgent.flat()]
  },
}
