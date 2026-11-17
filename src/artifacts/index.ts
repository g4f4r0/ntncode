import path from "node:path"
import { readSecret } from "../shared/config.ts"
import type { Module } from "../shared/module.ts"
import { KEY_NAMES } from "./publish.ts"

/** `ntncode artifact`: files published to a public bucket. It runs no tasks; `doctor` checks it is set up. */
export const artifacts: Module = {
  name: "artifacts",
  tasks: () => [],
  checks: (context) => {
    if (!context.config.artifacts)
      return [{ ok: false, level: "warning", name: "artifacts", detail: "ntncode artifact can't publish: the config has no artifacts bucket", fix: `set "artifacts": { "bucketUrl": "<S3 endpoint>/<bucket>", "publicUrl": "<public address>" } in ${path.basename(context.paths.config)}` }]
    const missing = KEY_NAMES.filter((name) => !readSecret(context.paths.secrets, name))
    return [
      missing.length
        ? { ok: false, level: "error", name: "artifacts", detail: `no ${missing.join(" or ")}`, fix: `set ${missing.join(" and ")} in the environment or in the secrets file` }
        : { ok: true, name: "artifacts", detail: `publishing to ${context.config.artifacts.publicUrl}` },
    ]
  },
}
