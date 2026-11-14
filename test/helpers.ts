import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Paths } from "../src/shared/config.ts"

/** A throwaway home with ~/.agents and ~/projects. */
export function tempHome(): Paths {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "notion-code-"))
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
