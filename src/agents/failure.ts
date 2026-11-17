import type { CommandResult } from "../shared/process.ts"

/** The most of an agent's output a failure keeps: enough to see what happened, not a whole transcript. */
const TAIL_LINES = 40
const DETAILS_CHARS = 4_000

/** Lines that are noise in every failure, such as Codex's MCP transport chatter. */
const NOISE = [/rmcp::transport/u]

/**
 * Masks secrets before anything an agent printed reaches Notion: the value of every environment variable whose name
 * says it holds one, and the shapes of common tokens.
 */
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text
  const values = Object.entries(env)
    .filter(([name, value]) => /KEY|TOKEN|SECRET|PASSWORD|PASS\b|AUTH/iu.test(name) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value!)
    .sort((a, b) => b.length - a.length)
  for (const value of values) out = out.split(value).join("<redacted>")
  return out
    .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/giu, "$1 <redacted>")
    .replace(/\b(?:ntn_|secret_|sk-|sk_live_|rk_live_|ghp_|gho_|github_pat_|xox[abpr]-|AKIA)[A-Za-z0-9._-]{8,}/gu, "<redacted>")
    .replace(/\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/gu, "<redacted>")
}

/** The last lines of a stream, without noise. */
export function tail(text: string, lines = TAIL_LINES): string {
  return text
    .split("\n")
    .filter((line) => line.trim() && !NOISE.some((pattern) => pattern.test(line)))
    .slice(-lines)
    .join("\n")
}

/** The raw context of a failed run, for the code block under the explanation: exit, the agent's fields, its stderr. */
export function failureDetails(result: CommandResult, fields: Record<string, unknown> = {}): string {
  const parts: string[] = []
  const exit = result.timedOut ? "timed out" : result.code === null ? `no exit code${result.error ? ` (${result.error})` : ""}` : String(result.code)
  parts.push(`exit: ${exit}`)
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") continue
    parts.push(`${name}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
  }
  const stderr = tail(result.stderr)
  if (stderr) parts.push("", "stderr (last lines):", stderr)
  const details = redact(parts.join("\n"))
  return details.length > DETAILS_CHARS ? `…${details.slice(-DETAILS_CHARS)}` : details
}

/**
 * A failure in plain words: what happened and what to do. Known causes get their own sentence; anything else says
 * the agent ended with an error, and the details carry the rest.
 */
export function explainFailure(error: string, agent: string): string {
  const known: [RegExp, string][] = [
    [/scheduler stopped/iu, "Notion Code's scheduler restarted or stopped during this run, which stopped the agent too. Nothing needs fixing; the next run starts as usual."],
    [/not logged in|please run \/login|401|invalid api key|authenticat|unauthori[sz]ed/iu, `${agent} couldn't sign in to its model provider, so it didn't do the work. Check the key in ~/.config/notion-code/agents.env, restart ntncode.service, and run ntncode doctor.`],
    [/unknown (?:provider for )?model|model[^\n]{0,40}(?:not found|does not exist|isn't supported|not supported)|invalid model/iu, `The model provider doesn't know the model this automation asks for, so ${agent} didn't do the work. Pick a model from the Model list in Notion.`],
    [/max_turns|turn limit/iu, `${agent} stopped at its turn limit before it finished. Split the prompt into smaller steps, or give it fewer things to do in one run.`],
    [/usage limit|rate limit|rate_limit|\b429\b|overloaded|quota/iu, `The model provider refused ${agent}'s requests because of a usage or rate limit. It usually works again on the next run; if it keeps failing, check the provider's limits.`],
    [/isn't installed/iu, `${agent} isn't installed on this machine, so the run couldn't start. Install it, or pick another agent for this automation.`],
    [/folder .* doesn't exist/iu, "The run's folder doesn't exist on this machine, so the agent didn't start. Fix the project's Path or the automation's Repository in Notion, or create the folder."],
    [/returned no result/iu, `${agent} exited without a final result, so the run can't tell what it did. The details below show how it ended.`],
  ]
  for (const [pattern, sentence] of known) if (pattern.test(error)) return sentence
  return `${agent} ended with an error before it finished. The details below are what it reported.`
}
