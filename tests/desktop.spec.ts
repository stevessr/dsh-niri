/** Real isolated compositor, GTK state, virtual input, AT-SPI and built-plugin image delivery. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ComputerUse from '@deepseek-ai/dsh-computer-use'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalAttachments from '@deepseek-ai/dsh-attachment-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import type * as Provider from '../src/index.ts'

const State = z.object({ text: z.string(), count: z.number(), button: z.tuple([z.number(), z.number()]), pid: z.number(), env: z.object({ NIRI_SOCKET: z.string(), WAYLAND_DISPLAY: z.string(), XDG_RUNTIME_DIR: z.string(), DBUS_SESSION_BUS_ADDRESS: z.string() }) })

it.skipIf(!process.env.DSH_NIRI_DESKTOP_TEST)('operates only its disposable GTK application through niri, Wayland and AT-SPI', async () => {
  const plugin: typeof Provider = await import(new URL('../dist/index.js', import.meta.url).href)
  const root = await mkdtemp(join(tmpdir(), 'dsh-niri-test-'))
  const child = spawn('dbus-run-session', ['--', '/usr/bin/python3', fileURLToPath(new URL('./fixtures/session.py', import.meta.url)), root], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ATSPI_DBUS_IMPLEMENTATION: 'dbus-daemon', GIO_USE_VFS: 'local', GSETTINGS_BACKEND: 'memory', XDG_RUNTIME_DIR: root },
  })
  const closed = once(child, 'close')
  let log = ''
  child.stdout.on('data', chunk => { log = (log + String(chunk)).slice(-65_536) })
  child.stderr.on('data', chunk => { log = (log + String(chunk)).slice(-65_536) })
  const ctx = new Context()
  const state = async () => State.parse(JSON.parse(await readFile(join(root, 'state.json'), 'utf8')))
  try {
    await vi.waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`Isolated desktop exited: ${log}`)
      expect((await state()).pid).toBeGreaterThan(0)
    }, { timeout: 20_000, interval: 50 })
    const app = await state()
    await ctx.plugin(ComputerUse)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalAttachments, { dshHome: join(root, 'store') })
    const provider = await ctx.plugin(plugin, { readOnly: false, pythonCommand: resolve('.venv/bin/python'),
      socketPath: app.env.NIRI_SOCKET, waylandDisplay: app.env.WAYLAND_DISPLAY, runtimeDir: app.env.XDG_RUNTIME_DIR, dbusAddress: app.env.DBUS_SESSION_BUS_ADDRESS })
    await provider.await()
    let sequence = 0
    const execute = async (name: string, args: object) => {
      const result = await ctx.tools.execute({ name, arguments: args, callId: ToolCallId(String(++sequence)), signal: new AbortController().signal })
      if (result.isError) throw new Error(JSON.stringify(result.content))
      return result
    }
    const observed = await execute('niri_observe', {})
    log += `\nObservation: ${JSON.stringify(observed.value)}`
    const { data } = z.object({ data: z.object({ windows: z.array(z.object({ id: z.number(), pid: z.number().nullable(), app_id: z.string().nullable() })) }) }).parse(observed.value)
    const window = data.windows.find(item => item.pid === app.pid)
    expect(window).toBeDefined()
    await execute('niri_window', { windowId: window!.id, expectedAppId: window!.app_id, action: 'focus' })
    const capture = async (area: 'window' | 'output') => {
      const result = await execute('niri_capture', { windowId: window!.id, area })
      const image = result.content.find(block => block.type === 'image')
      expect(image?.type).toBe('image')
      if (image?.type === 'image') expect((await ctx.attachments.readImage(image.attachment)).data.byteLength).toBeGreaterThan(100)
      expect(JSON.stringify(result.value)).not.toContain('iVBOR')
      return z.object({ data: z.object({ snapshotId: z.string() }) }).parse(result.value).data.snapshotId
    }
    const first = await capture('output')
    await execute('niri_input', { snapshotId: first, action: { kind: 'text', text: '你好 niri' } })
    await vi.waitFor(async () => expect((await state()).text).toBe('你好 niri'))
    const reused = await ctx.tools.execute({ name: 'niri_input', arguments: { snapshotId: first, action: { kind: 'text', text: 'must not type' } }, callId: ToolCallId('reused'), signal: new AbortController().signal })
    expect(reused.isError).toBe(true)
    log += `\nFloating: ${JSON.stringify((await execute('niri_window', { windowId: window!.id, expectedAppId: window!.app_id, action: 'float' })).value)}`
    const second = await capture('window')
    const [x, y] = (await state()).button
    await execute('niri_input', { snapshotId: second, action: { kind: 'click', x, y } })
    log += `\nGTK: ${await readFile(join(root, 'state.json'), 'utf8')}`
    await vi.waitFor(async () => expect((await state()).count).toBe(1))
    const tree = await execute('niri_accessibility', { windowId: window!.id })
    const semantic = z.object({ data: z.object({ snapshotId: z.string(), nodes: z.array(z.object({ name: z.string(), path: z.array(z.number()), actions: z.array(z.string()) })) }) }).parse(tree.value).data
    const button = semantic.nodes.find(node => node.name === 'Increment counter' && node.actions.length > 0)
    expect(button).toBeDefined()
    await execute('niri_activate', { snapshotId: semantic.snapshotId, path: button!.path, action: button!.actions[0] })
    await vi.waitFor(async () => expect((await state()).count).toBe(2))
    expect((await state()).text).toBe('你好 niri')
    await execute('niri_window', { windowId: window!.id, expectedAppId: window!.app_id, action: 'tile' })
    const desktop = z.object({ data: z.object({
      windows: z.array(z.object({ id: z.number(), workspace_id: z.number() })),
      workspaces: z.array(z.object({ id: z.number() })),
    }) }).parse((await execute('niri_observe', {})).value).data
    const current = desktop.windows.find(item => item.id === window!.id)!.workspace_id
    const target = desktop.workspaces.find(item => item.id !== current)!.id
    const moved = await execute('niri_window', { windowId: window!.id, expectedAppId: window!.app_id, action: 'move', workspaceId: target })
    expect(z.object({ data: z.object({ windows: z.array(z.object({ id: z.number(), workspace_id: z.number() })) }) }).parse(moved.value)
      .data.windows.find(item => item.id === window!.id)?.workspace_id).toBe(target)
    await provider.dispose()
    expect(ctx.tools.schemas()).toEqual([])
    expect(ctx.computerUse.providerName).toBeUndefined()
  } catch (error) {
    throw new Error(`${String(error)}\nIsolated compositor log:\n${log}`, { cause: error })
  } finally {
    try { await ctx.fiber.dispose() } finally {
      if (child.pid && child.exitCode === null) process.kill(-child.pid, 'SIGTERM')
      await closed
      try {
        const pids = z.array(z.number()).parse(JSON.parse(await readFile(join(root, 'pids.json'), 'utf8').catch(() => '[]')))
        for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow()
      } finally { await rm(root, { recursive: true, force: true }) }
    }
  }
}, 60_000)
