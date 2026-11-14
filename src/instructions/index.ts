import { SYNC_SCHEDULE, type Module } from "../shared/module.ts"
import { syncInstructions } from "./sync.ts"

/** Notion Instructions pages → the AGENTS.md beside each notion.json. */
export const instructions: Module = {
  name: "instructions",
  tasks: () => [
    {
      id: "instructions.sync",
      schedule: SYNC_SCHEDULE,
      run: (context) => syncInstructions(context.notion, context.paths, { dryRun: context.dryRun, now: context.now }),
    },
  ],
}
