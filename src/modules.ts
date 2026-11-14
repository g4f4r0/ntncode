import { agents } from "./agents/index.ts"
import { instructions } from "./instructions/index.ts"
import type { Module } from "./shared/module.ts"

/** Every module, in the order their tasks run: links point at files the earlier tasks write. */
export const modules: Module[] = [instructions, agents]
