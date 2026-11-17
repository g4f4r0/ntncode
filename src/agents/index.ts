import { agentOn, type Config, type Paths } from "../shared/config.ts"
import { SYNC_SCHEDULE, type Module } from "../shared/module.ts"
import type { Agent, AgentName } from "./agent.ts"
import { claudeCode, claudeCodeLinks } from "./claude-code.ts"
import { codex, codexLinks } from "./codex.ts"
import { ensureLinks, linkChecks } from "./links.ts"
import { openCode, openCodeLinks } from "./opencode.ts"
import { t3Code } from "./t3-code.ts"
import { zeron } from "./zeron.ts"
import { capy } from "./capy.ts"

export { AgentName, Effort, modelId, type Agent, type AgentRunInput, type AgentRunOutput, type Usage } from "./agent.ts"
export { explainFailure, redact } from "./failure.ts"

/** Every agent, by the name the Notion Agent property uses. */
export const AGENTS: Record<AgentName, Agent> = { "Claude Code": claudeCode, Codex: codex, OpenCode: openCode, "T3 Code": t3Code, Zeron: zeron, Capy: capy }

/** Every agent's paths that link into ~/.agents, so there is one copy of everything; an agent turned off keeps its own. */
const allLinks = (paths: Paths, config: Config) =>
  [
    agentOn(config, "Claude Code") ? claudeCodeLinks(paths) : [],
    agentOn(config, "Codex") ? codexLinks(paths) : [],
    agentOn(config, "OpenCode") ? openCodeLinks(paths) : [],
  ].flat()

/** Where each agent reads its instructions and skills, and whether each has the MCP servers it needs. */
export const agents: Module = {
  name: "agents",
  tasks: () => [
    {
      id: "agents.links",
      kind: "sync",
      schedule: SYNC_SCHEDULE,
      since: null,
      run: async (context) => ensureLinks(allLinks(context.paths, context.config), { dryRun: context.dryRun }),
    },
  ],
  async checks(context) {
    const { config, paths } = context
    const on = (Object.keys(AGENTS) as AgentName[]).filter((name) => agentOn(config, name))
    const perAgent = await Promise.all(on.map((name) => AGENTS[name].checks(paths, config.agents.mcp)))
    return [...linkChecks(paths, allLinks(paths, config)), ...perAgent.flat()]
  },
}
