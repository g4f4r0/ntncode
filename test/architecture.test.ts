import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"

const SRC = path.join(import.meta.dirname, "../src")

/** Which domains each domain may import. Every domain may import shared; shared imports no domain. */
const ALLOWED: Record<string, string[]> = {
  shared: [],
  instructions: ["shared"],
  agents: ["shared"],
}

function imports(file: string): string[] {
  const source = fs.readFileSync(file, "utf8")
  return [...source.matchAll(/^\s*import\s[^"']*["']([^"']+)["']/gmu)].map((match) => match[1]!).filter((spec) => spec.startsWith("."))
}

test("each domain imports only shared and the domains it is allowed", () => {
  const domains = fs.readdirSync(SRC, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  assert.deepEqual(domains.sort(), Object.keys(ALLOWED).sort(), "every domain folder is listed in ALLOWED")
  for (const domain of domains) {
    for (const file of fs.readdirSync(path.join(SRC, domain)).filter((name) => name.endsWith(".ts"))) {
      for (const spec of imports(path.join(SRC, domain, file))) {
        const target = path.relative(SRC, path.resolve(SRC, domain, spec)).split(path.sep)[0]!
        if (target === domain) continue
        assert.ok(ALLOWED[domain]!.includes(target), `${domain}/${file} imports ${spec}, but ${domain} may import only ${ALLOWED[domain]!.join(", ") || "nothing"}`)
      }
    }
  }
})
