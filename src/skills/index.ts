import path from "node:path"
import { SYNC_SCHEDULE, type Module } from "../shared/module.ts"
import { syncSkills } from "./sync.ts"

/** Notion's Skills library → ~/.agents/skills, when the config names the Skills data source. */
export const skills: Module = {
  name: "skills",
  tasks: (context) =>
    context.config.skills
      ? [
          {
            id: "skills.sync",
            kind: "sync",
            schedule: SYNC_SCHEDULE,
            since: null,
            run: (ready) => syncSkills(ready.notion, ready.paths, ready.config.skills!, { dryRun: ready.dryRun, now: ready.now }),
          },
        ]
      : [],
  checks: (context) =>
    context.config.skills
      ? []
      : [{ ok: false, level: "warning", name: "skills", detail: "not synced: the config has no skills data source", fix: `set "skills" in ${path.basename(context.paths.config)} to the Notion Skills data source ID` }],
}
