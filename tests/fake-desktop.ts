/** External-command fixture shared by stock and patched Host compositions. */
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Create a private executable and mutable IPC fixture. */
export async function fakeDesktop(root: string, hang = false) {
  const command = join(root, 'command')
  await writeFile(command, `#!${process.execPath}\n${await readFile(new URL('./fixtures/command.mjs', import.meta.url), 'utf8')}`)
  await chmod(command, 0o700)
  const state = { hang, windows: [{ id: 7, pid: 42, title: 'Fixture', app_id: 'fixture', workspace_id: 8, is_focused: true,
    layout: { tile_pos_in_workspace_view: [0, 0], window_offset_in_tile: [0, 0], window_size: [100, 100] } }],
  workspaces: [{ id: 8, idx: 1, name: null, output: 'test', is_active: true }], outputs: { test: { logical: { x: 0, y: 0, width: 100, height: 100, scale: 1, transform: 'Normal' } } } }
  const save = () => writeFile(join(root, 'state.json'), JSON.stringify(state))
  await save()
  return { state, save, config: { socketPath: join(root, 'niri.sock'), waylandDisplay: 'wayland-test', runtimeDir: root,
    pythonCommand: command, niriCommand: command, grimCommand: command, wtypeCommand: command, terminationGraceMs: 20 } }
}
