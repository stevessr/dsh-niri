/** Pure geometry, environment parsing, schema validation and deterministic queue lifetime tests. */
import { expect, it } from 'vitest'
import { frameFor, mapPoint, Window, type DesktopState } from '../src/state.ts'
import { DesktopQueue } from '../src/commands.ts'
import { Input } from '../src/backend.ts'
import { sessionEnvironment, Config } from '../src/index.ts'

function desktop(): DesktopState {
  return {
    windows: [{ id: 7, title: 'Fixture', app_id: 'fixture', pid: 42, workspace_id: 8, is_focused: true,
      layout: { tile_pos_in_workspace_view: [10, 20], window_offset_in_tile: [2, 3], window_size: [800, 600] } }],
    workspaces: [{ id: 8, idx: 1, name: null, output: 'portrait', is_active: true }],
    outputs: { portrait: { logical: { x: -1000, y: 200, width: 1000, height: 1600, scale: 1.5, transform: '90' } } },
  }
}

it('maps normalized image pixels once into rotated/scaled output-local logical coordinates', () => {
  const frame = frameFor(desktop(), 7)
  expect(mapPoint(frame, { width: 400, height: 300 }, 200, 150)).toEqual({ x: 412, y: 323 })
  expect(frame.outputX).toBe(-1000)
  expect(() => mapPoint(frame, { width: 400, height: 300 }, 400, 1)).toThrow('outside')
  expect(() => mapPoint(frame, { width: 400, height: 300 }, NaN, 1)).toThrow('outside')
})

it('refuses absent, offscreen, partially visible and malformed windows', () => {
  const state = desktop()
  expect(() => frameFor(state, 99)).toThrow('no longer exists')
  state.windows[0]!.layout.tile_pos_in_workspace_view = null
  expect(() => frameFor(state, 7)).toThrow('position is not available')
  expect(frameFor(state, 7, 'output')).toMatchObject({ x: 0, y: 0, width: 1000, height: 1600 })
  state.windows[0]!.layout.tile_pos_in_workspace_view = [-30, 0]
  expect(() => frameFor(state, 7)).toThrow('partly off-screen')
  expect(Window.safeParse({ id: 1 }).success).toBe(false)
})

it('invalidates metadata fingerprints when focus, PID, app identity or output geometry changes', () => {
  const state = desktop()
  const original = frameFor(state, 7).fingerprint
  for (const patch of [{ is_focused: false }, { pid: 43 }, { app_id: 'another' }]) {
    const next = desktop(); Object.assign(next.windows[0]!, patch)
    expect(frameFor(next, 7).fingerprint).not.toBe(original)
  }
  state.outputs.portrait!.logical!.scale = 2
  expect(frameFor(state, 7).fingerprint).not.toBe(original)
})

it('keeps session selection explicit and accepts literal non-shell input', () => {
  expect(() => Config({ niriCommand: ' ' })).toThrow()
  expect(() => Config({ maxOutputBytes: Infinity })).toThrow()
  expect(() => sessionEnvironment(Config({}), {})).toThrow('NIRI_SOCKET')
  const env = sessionEnvironment(Config({ socketPath: '/run/niri.sock', runtimeDir: '/run/test', waylandDisplay: 'wayland-test' }), {})
  expect(env.NIRI_SOCKET).toBe('/run/niri.sock')
  expect(Input.parse({ kind: 'text', text: '$(touch /tmp/not-run)' }).kind).toBe('text')
  expect(Input.safeParse({ kind: 'key', key: '-k Return' }).success).toBe(false)
  expect(Input.safeParse({ kind: 'quit' }).success).toBe(false)
})

it('serializes calls, rejects overflow, cancels queued work and joins active teardown', async () => {
  const queue = new DesktopQueue(2, 10_000)
  const entered = Promise.withResolvers<void>()
  const exited = Promise.withResolvers<void>()
  const first = queue.run(new AbortController().signal, async signal => {
    entered.resolve()
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    exited.resolve()
    signal.throwIfAborted()
  })
  await entered.promise
  let secondStarted = false
  const second = queue.run(new AbortController().signal, async () => { secondStarted = true })
  await expect(queue.run(new AbortController().signal, async () => {})).rejects.toThrow('full')
  const settled = Promise.allSettled([first, second])
  await queue.dispose()
  await exited.promise
  expect((await settled).map(result => result.status)).toEqual(['rejected', 'rejected'])
  expect(secondStarted).toBe(false)
  await expect(queue.run(new AbortController().signal, async () => {})).rejects.toThrow('unloaded')
})
