import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"

const SRC = path.join(import.meta.dirname, "../src")

/** Which domains each domain may import. Every domain may import shared; shared imports no domain. */
const ALLOWED: Record<string, string[]> = {
  shared: [],
  instructions: ["shared"],
  skills: ["shared"],
  agents: ["shared"],
  scheduler: ["shared"],
  automations: ["shared", "agents", "scheduler"],
  artifacts: ["shared"],
}

/** Only the automations runner writes to Notion: every sync stays read-only, and agents never write Runs. */
const WRITERS = ["automations/runner.ts", "automations/runs.ts", "automations/index.ts"]

function imports(file: string): string[] {
  const source = fs.readFileSync(file, "utf8")
  // `from "./x"` in import and export statements, and side-effect imports.
  return [...source.matchAll(/(?:\bfrom\s*|^\s*import\s*)["'](\.[^"']*)["']/gmu)].map((match) => match[1]!)
}

const domainFiles = () =>
  fs
    .readdirSync(SRC, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => fs.readdirSync(path.join(SRC, entry.name)).filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts")).map((name) => `${entry.name}/${name}`))

test("each domain imports only shared and the domains it is allowed", () => {
  const domains = fs.readdirSync(SRC, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  assert.deepEqual(domains.sort(), Object.keys(ALLOWED).sort(), "every domain folder is listed in ALLOWED")
  for (const file of domainFiles()) {
    const domain = file.split("/")[0]!
    for (const spec of imports(path.join(SRC, file))) {
      const target = path.relative(SRC, path.resolve(SRC, domain, spec)).split(path.sep)[0]!
      if (target === domain) continue
      assert.ok(ALLOWED[domain]!.includes(target), `${file} imports ${spec}, but ${domain} may import only ${ALLOWED[domain]!.join(", ") || "nothing"}`)
    }
  }
})

test("only the automations runner imports the Notion writer", () => {
  const top = fs.readdirSync(SRC).filter((name) => name.endsWith(".ts"))
  for (const file of [...domainFiles(), ...top]) {
    const writes = imports(path.join(SRC, file)).some((spec) => spec.endsWith("notion-writer.ts"))
    if (writes) assert.ok(WRITERS.includes(file), `${file} imports the Notion writer; only ${WRITERS.join(", ")} may`)
  }
})
