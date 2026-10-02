/** Stock released Harness composition, failed-start rollback, stale tokens and quiescent unload. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ComputerUse from '@deepseek-ai/dsh-computer-use'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import Attachments from '@deepseek-ai/dsh-attachment-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import * as Provider from '../src/index.ts'
import { fakeDesktop } from './fake-desktop.ts'

const resources: { ctx: Context; root: string }[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const { ctx, root } of resources.splice(0)) {
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  }
})
async function setup(options: object = {}, hang = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-niri-plugin-'))
  const ctx = new Context(); resources.push({ ctx, root })
  const { state, save, config } = await fakeDesktop(root, hang)
  await ctx.plugin(ComputerUse); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
  await ctx.plugin(Attachments, { dshHome: join(root, 'store') })
  const provider = ctx.plugin(Provider, { ...config, ...options })
  let sequence = 0
  const call = (name: string, args: object) => ctx.tools.execute({ name, arguments: args, callId: ToolCallId(String(++sequence)), signal: new AbortController().signal })
  const successful = async (name: string, args: object) => {
    const result = await call(name, args)
    if (result.isError) throw new Error(JSON.stringify(result.content))
    return result
  }
  const snapshot = async () => z.object({ data: z.object({ snapshotId: z.string() }) }).parse((await successful('niri_capture', { windowId: 7 })).value).data.snapshotId
  return { ctx, root, provider, state, save, call, successful, snapshot }
}

it('registers six ordinary tools on stock Harness, captures durable images and starts read-only', async () => {
  const fixture = await setup(); await fixture.provider.await()
  expect((await fixture.ctx.systemPrompt.assemble()).tools).toHaveLength(6)
  const capture = await fixture.successful('niri_capture', { windowId: 7 })
  expect(capture.content.some(block => block.type === 'image')).toBe(true)
  expect(JSON.stringify(capture.value)).not.toContain('iVBOR')
  expect((await fixture.call('niri_window', { windowId: 7, expectedAppId: 'fixture', action: 'focus' })).isError).toBe(true)
  await fixture.provider.dispose()
  expect(fixture.ctx.computerUse.providerName).toBeUndefined()
  expect(fixture.ctx.tools.schemas()).toEqual([])
})

it('rejects stale focus, coordinates, wrong token kinds and token reuse before input', async () => {
  const f = await setup({ readOnly: false }); await f.provider.await()
  const id = await f.snapshot()
  expect((await f.call('niri_input', { snapshotId: id, action: { kind: 'click', x: 1, y: 0 } })).isError).toBe(true)
  f.state.windows[0]!.is_focused = false; await f.save()
  expect((await f.call('niri_input', { snapshotId: id, action: { kind: 'text', text: 'wrong target' } })).isError).toBe(true)
  f.state.windows[0]!.is_focused = true; await f.save()
  await f.successful('niri_input', { snapshotId: id, action: { kind: 'text', text: '$(literal)\n你好' } })
  expect((await f.call('niri_input', { snapshotId: id, action: { kind: 'text', text: 'duplicate' } })).isError).toBe(true)
  const tree = await f.successful('niri_accessibility', { windowId: 7 })
  const semanticId = z.object({ data: z.object({ snapshotId: z.string() }) }).parse(tree.value).data.snapshotId
  expect((await f.call('niri_input', { snapshotId: semanticId, action: { kind: 'text', text: 'bad kind' } })).isError).toBe(true)
  expect((await f.call('niri_activate', { snapshotId: semanticId, path: [1], action: 'click' })).isError).toBe(true)
  await f.successful('niri_activate', { snapshotId: semanticId, path: [0], action: 'click' })
  const lines = (await readFile(join(f.root, 'commands.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { args: string[]; input: string })
  expect(lines.filter(line => line.args[0] === '-').map(line => line.input)).toEqual(['$(literal)\n你好'])
})

it('rejects unavailable TypeScript-only mode without exposing native tools', async () => {
  const f = await setup({ mode: 'typescript' })
  await expect(f.provider.await()).rejects.toThrow('integration patch')
  await f.provider.dispose()
  expect(f.ctx.tools.schemas()).toEqual([])
  expect(f.ctx.computerUse.providerName).toBeUndefined()
})

it('evicts old capabilities and rejects expired tokens without typing', async () => {
  const f = await setup({ readOnly: false, maxSnapshots: 1 }); await f.provider.await()
  const old = await f.snapshot()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
  const recent = await f.snapshot()
  expect((await f.call('niri_input', { snapshotId: old, action: { kind: 'text', text: 'evicted' } })).isError).toBe(true)
  clock.mockReturnValue(31_000)
  expect((await f.call('niri_input', { snapshotId: recent, action: { kind: 'text', text: 'expired' } })).isError).toBe(true)
  const log = await readFile(join(f.root, 'commands.jsonl'), 'utf8')
  expect(log).not.toContain('"args":["-"]')
})

it('filters app identities and fails capture rather than guessing tiled coordinates', async () => {
  const blocked = await setup({ allowedAppIds: ['another-app'] }); await blocked.provider.await()
  expect((await blocked.call('niri_capture', { windowId: 7 })).isError).toBe(true)
  const f = await setup(); await f.provider.await()
  const state = { ...f.state, windows: f.state.windows.map(window => ({ ...window, layout: { ...window.layout, tile_pos_in_workspace_view: null } })) }
  await writeFile(join(f.root, 'state.json'), JSON.stringify(state))
  expect((await f.call('niri_capture', { windowId: 7 })).isError).toBe(true)
  await f.successful('niri_capture', { windowId: 7, area: 'output' })
  await f.successful('niri_accessibility', { windowId: 7 })
})

it('cancels unfinished setup and retains computer-use ownership until the child exits', async () => {
  const f = await setup({}, true)
  let pid = 0
  await vi.waitFor(async () => { pid = Number(await readFile(join(f.root, 'ready'), 'utf8')); expect(pid).toBeGreaterThan(0) })
  const stopped = f.provider.dispose()
  expect(f.ctx.computerUse.providerName).toBe('niri')
  await stopped
  expect(() => process.kill(pid, 0)).toThrow()
  expect(f.ctx.computerUse.providerName).toBeUndefined()
})
