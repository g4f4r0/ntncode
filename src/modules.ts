import { agents } from "./agents/index.ts"
import { automations } from "./automations/index.ts"
import { instructions } from "./instructions/index.ts"
import type { Module } from "./shared/module.ts"
import { skills } from "./skills/index.ts"

/** Every module, in the order their syncs run: instructions and skills first, so the links point at real files. */
export const modules: Module[] = [instructions, skills, agents, automations]
