import { spawn } from "node:child_process"

export interface CommandResult {
  /** Null when the process was killed by a signal or never started. */
  code: number | null
  stdout: string
  stderr: string
  /** Set when it couldn't start, such as a missing binary. */
  error: string | null
  timedOut: boolean
  pid: number | null
}

export interface CommandOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  input?: string
  /** Kills the whole process group after this long. Omit for no limit. */
  timeoutMs?: number
  /** Called once the process has started. */
  onStart?: (pid: number) => void
  /** Keeps only the last this-many characters of stdout; agent transcripts can be large. */
  maxOutput?: number
}

/** Runs a program (no shell), feeds it stdin, and collects its output. Never throws. */
export function runCommand(command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  const max = options.maxOutput ?? 16 * 1024 * 1024
  return new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: Omit<CommandResult, "stdout" | "stderr">) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve({ ...result, stdout, stderr })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env } as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      })
    } catch (error) {
      finish({ code: null, error: (error as Error).message, timedOut: false, pid: null })
      return
    }
    if (child.pid) options.onStart?.(child.pid)
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL")
        } catch {
          child.kill("SIGKILL")
        }
        finish({ code: null, error: null, timedOut: true, pid: child.pid ?? null })
      }, options.timeoutMs)
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.length > max * 2) stdout = stdout.slice(-max)
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-64_000)
    })
    child.stdin?.on("error", () => {})
    child.stdin?.end(options.input ?? "")
    child.on("error", (error) => finish({ code: null, error: error.message, timedOut: false, pid: child.pid ?? null }))
    child.on("close", (code) => finish({ code, error: null, timedOut: false, pid: child.pid ?? null }))
  })
}

/** Runs a shell command line with `sh -c`, for user-configured commands such as `onFailure`. */
export function runShell(line: string, options: CommandOptions = {}): Promise<CommandResult> {
  return runCommand("sh", ["-c", line], options)
}

/** True when a process with this ID is alive. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}
