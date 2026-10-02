/** Local, cancellable command execution without shell interpolation. */
import { homedir } from 'node:os'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Config } from './config.ts'

/** The backend's sole child-process interface; fixtures can replace it without replacing Cordis. */
export interface Commands {
  run(argv: string[], signal: AbortSignal, input?: string): Promise<string>
}
/** Delegate environment scrubbing, deadlines and process-tree termination to Harness. */
export class LocalCommands implements Commands {
  constructor(private readonly runtime: SubprocessRuntime, private readonly config: Config, private readonly env: Record<string, string>) {}
  /** Run one argv vector and await its complete managed range.
   * @param argv - executable and literal arguments.
   * @param signal - caller and plugin lifetime cancellation.
   * @param input - optional complete stdin payload.
   * @returns bounded, lossless stdout; command failures reject.
   */
  async run(argv: string[], signal: AbortSignal, input?: string): Promise<string> {
    signal.throwIfAborted()
    const child = this.runtime.spawn({ argv, cwd: homedir(), env: this.env, signal, graceMs: this.config.terminationGraceMs,
      stdio: { stdin: input === undefined ? 'ignore' : { data: input }, stdout: { maxBytes: this.config.maxOutputBytes }, stderr: { maxBytes: this.config.maxOutputBytes } } })
    try {
      const result = await child.done
      signal.throwIfAborted()
      const output = child.collected.stdout?.readFrom(0)
      if (result.exitCode !== 0) throw new Error(`${argv[0]} failed (${result.exitCode}): ${child.collected.stderr?.readFrom(0).text ?? ''}`)
      if (output?.lossy) throw new Error('Command output exceeded maxOutputBytes')
      return output?.text ?? ''
    } finally {
      child.terminate()
      await child.waitForExit()
    }
  }
}

/** Serialize one desktop provider across Agents, including shutdown and queued cancellation. */
export class DesktopQueue {
  private tail: Promise<void> = Promise.resolve()
  private pending = 0
  private readonly lifetime = new AbortController()
  constructor(private readonly limit: number, private readonly timeoutMs: number) {}
  /** Queue one action; cancelled queued work never starts.
   * @param signal - owning tool invocation's signal.
   * @param body - one complete observation or action.
   * @returns the body's result without suppressing failure.
   */
  run<T>(signal: AbortSignal, body: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.pending >= this.limit) return Promise.reject(new Error('Niri action queue is full'))
    const combined = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(this.timeoutMs)])
    this.pending++
    const task = this.tail.then(() => { combined.throwIfAborted(); return body(combined) }).finally(() => { this.pending-- })
    // Only the drain chain contains failures; the caller receives the rejecting task.
    this.tail = task.then(() => {}, () => {})
    return task
  }
  /** Abort queued/active work and wait for every owned command and callback. */
  async dispose(): Promise<void> {
    this.lifetime.abort(new Error('Niri provider unloaded'))
    await this.tail
  }
}
