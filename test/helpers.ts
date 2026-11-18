import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { EMPTY_CONFIG, type Config, type Paths } from "../src/shared/config.ts"
import type { Context } from "../src/shared/module.ts"
import type { Notion } from "../src/shared/notion.ts"

/** Every throwaway home lives in one folder per test run, removed when the run exits. */
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ntncode-test-"))
process.on("exit", () => fs.rmSync(ROOT, { recursive: true, force: true }))

/** An empty throwaway folder, removed with the rest when the test run exits. */
export function tempDir(): string {
  return fs.mkdtempSync(path.join(ROOT, "home-"))
}

/** A throwaway home with ~/.agents and ~/projects. */
export function tempHome(): Paths {
  const home = tempDir()
  const paths: Paths = {
    home,
    agents: path.join(home, ".agents"),
    projects: path.join(home, "projects"),
    state: path.join(home, "state"),
    config: path.join(home, "config.json"),
    secrets: path.join(home, "secrets.env"),
  }
  fs.mkdirSync(paths.agents, { recursive: true })
  fs.mkdirSync(paths.projects, { recursive: true })
  return paths
}

/** A Notion fake: every method fails unless the test provides it, so a test never reads more than it means to. */
export function fakeNotion(methods: Partial<Notion>): Notion {
  const missing = (name: string) => async () => {
    throw new Error(`fake Notion: ${name} not expected`)
  }
  return {
    getPage: missing("getPage"),
    getPageMarkdown: missing("getPageMarkdown"),
    queryDataSource: missing("queryDataSource"),
    getDataSource: missing("getDataSource"),
    getSkill: missing("getSkill"),
    download: missing("download"),
    me: missing("me"),
    ...methods,
  }
}

export function testContext(paths: Paths, notion: Notion, config: Partial<Config> = {}, now = new Date()): Context {
  return { paths, config: { ...EMPTY_CONFIG, ...config }, notion, token: "ntn_test", dryRun: false, now }
}
