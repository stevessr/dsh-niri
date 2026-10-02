/** Niri-specific local computer use, mounted only through a Harness composition. */
import { isAbsolute } from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import type {} from '@deepseek-ai/dsh-computer-use'
import type {} from '@deepseek-ai/dsh-attachment'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-ptc-runtime'
import { Config } from './config.ts'
import { LocalCommands } from './commands.ts'
import { NiriBackend } from './backend.ts'
import { createTools } from './tools.ts'

export { Config } from './config.ts'
/** Cordis plugin identity. */
export const name = 'niri'
/** Screenshots are durable from the first activation, not optional base64 fallbacks. */
export const inject = ['computerUse', 'tools', 'attachments']

function programmatic(ctx: Context, config: Config, checkRuntime = true): boolean {
  if (config.mode.get() !== 'typescript') return false
  if (Reflect.get(ctx.tools, 'supportsProgrammaticOnly') !== true) throw new Error('TypeScript-only mode requires the supplied Harness integration patch')
  if (checkRuntime && ctx.get('ptcRuntime')?.language !== 'typescript') throw new Error('TypeScript-only mode requires @deepseek-ai/dsh-ptc-runtime-node')
  return true
}

/** Resolve explicit deployment settings before running any command.
 * @param config - validated plugin settings.
 * @param env - launch environment, supplied explicitly by tests.
 * @returns local session environment passed through the subprocess scrubber.
 */
export function sessionEnvironment(config: Config, env: NodeJS.ProcessEnv): Record<string, string> {
  const socket = config.socketPath ?? env.NIRI_SOCKET
  const display = config.waylandDisplay ?? env.WAYLAND_DISPLAY
  const runtime = config.runtimeDir ?? env.XDG_RUNTIME_DIR
  const bus = config.dbusAddress ?? env.DBUS_SESSION_BUS_ADDRESS
  if (!socket || !isAbsolute(socket)) throw new Error('Set an absolute socketPath or NIRI_SOCKET for the target niri session')
  if (!display || !runtime || !isAbsolute(runtime)) throw new Error('Set waylandDisplay/WAYLAND_DISPLAY and absolute runtimeDir/XDG_RUNTIME_DIR')
  return { NIRI_SOCKET: socket, WAYLAND_DISPLAY: display, XDG_RUNTIME_DIR: runtime, ...(bus ? { DBUS_SESSION_BUS_ADDRESS: bus } : {}) }
}

/** Activate a local provider; unloading cancels and joins queued and active work before releasing ownership.
 * @param ctx - Harness composition context.
 * @param config - paths, budgets and live input/exposure settings.
 * @returns after protocol discovery and all tool registrations succeed.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (process.platform !== 'linux') throw new Error('dsh-niri supports Linux niri sessions only')
  const env = sessionEnvironment(config, process.env)
  programmatic(ctx, config, false)
  const lifetime = new AbortController()
  let child: Fiber | undefined
  // Startup may still be awaiting a child when Cordis begins parent disposal.
  // oxlint-disable-next-line typescript/no-misused-promises -- Cordis contains observer errors; the ordered effect joins disposal.
  ctx.on('internal/plugin', fiber => {
    if (fiber !== ctx.fiber || fiber.uid !== null) return
    lifetime.abort(new Error('Niri provider unloaded'))
    return child?.dispose()
  }, { global: true })
  ctx.on('system-prompt/assemble', (_assembly, _request, next) => { programmatic(ctx, config); return next() })
  ctx.effect(function* () {
    yield ctx.computerUse.register(ComputerUseProviderName('niri'))
    child = ctx.plugin({ name: 'niri-session', inject, async apply(inner: Context) {
      inner.on('internal/plugin', fiber => {
        if (fiber === inner.fiber && fiber.uid === null) lifetime.abort(new Error('Niri provider unloaded'))
      }, { global: true })
      const local = inner.isolate('subprocess')
      const subprocess = local.plugin(LocalSubprocess)
      let backend: NiriBackend | undefined
      inner.effect(function* () {
        yield subprocess.dispose
        yield async () => { await backend?.dispose() }
      }, 'niri.local-runtime')
      try {
        await subprocess.await()
        const runtime = local.get('subprocess')
        if (runtime === undefined) throw new Error('Niri local subprocess provider did not activate')
        backend = new NiriBackend(new LocalCommands(runtime, config, env), config, inner.attachments)
        const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(config.commandTimeoutMs)])
        await backend.initialize(signal)
        signal.throwIfAborted()
        for (const definition of createTools(backend)) {
          const execute: ToolDefinition['execute'] = (args, exec) => { programmatic(inner, config); return definition.execute(args, exec) }
          const exposed = { ...definition, execute, get programmaticOnly() { return programmatic(inner, config) } }
          inner.effect(() => inner.tools.register(exposed))
        }
      } catch (error) {
        if (!lifetime.signal.aborted) throw error
      }
    } })
    yield child.dispose
  }, 'niri.session')
  await child?.await()
}
