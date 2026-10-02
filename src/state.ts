/** Parse niri IPC data and map normalized screenshot pixels to output-local coordinates. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const id = z.number().int().nonnegative().safe()
const pair = z.tuple([z.number().finite(), z.number().finite()])
/** Window fields required for identity, focus and geometry checks. */
export const Window = z.object({
  id, title: z.string().nullable(), app_id: z.string().nullable(), pid: id.nullable(),
  workspace_id: id.nullable(), is_focused: z.boolean(),
  layout: z.object({ tile_pos_in_workspace_view: pair.nullable(), window_offset_in_tile: pair, window_size: pair }),
})
/** Workspace ids remain stable across index changes. */
export const Workspace = z.object({ id, idx: id, name: z.string().nullable(), output: z.string().nullable(), is_active: z.boolean() })
/** Output logical dimensions already account for rotation and scale. */
export const Output = z.object({ logical: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive(), scale: z.number().positive(), transform: z.enum(['Normal', '90', '180', '270', 'Flipped', 'Flipped90', 'Flipped180', 'Flipped270']) }).nullable() })
/** One bounded, non-atomic IPC observation. */
export interface DesktopState {
  windows: z.infer<typeof Window>[]
  workspaces: z.infer<typeof Workspace>[]
  outputs: Record<string, z.infer<typeof Output>>
}
/** A visible client rectangle, in output-local logical pixels. */
export interface Frame {
  area: 'window' | 'output'
  window: z.infer<typeof Window>
  output: string
  outputX: number
  outputY: number
  outputWidth: number
  outputHeight: number
  transform: NonNullable<z.infer<typeof Output>['logical']>['transform']
  x: number
  y: number
  width: number
  height: number
  fingerprint: string
}

/** Resolve a visible window without focusing or scrolling the user's desktop.
 * @param state - parsed compositor state.
 * @param windowId - stable niri window id.
 * @param area - exact client rectangle when available, or the containing output.
 * @returns visible rectangle and a metadata fingerprint.
 */
export function frameFor(state: DesktopState, windowId: number, area: 'window' | 'output' = 'window'): Frame {
  const window = state.windows.find(item => item.id === windowId)
  if (!window) throw new Error('Window no longer exists; observe again')
  const workspace = state.workspaces.find(item => item.id === window.workspace_id)
  const name = workspace?.output
  const output = name ? state.outputs[name]?.logical : undefined
  const position = window.layout.tile_pos_in_workspace_view
  if (!name || !output || !workspace?.is_active) throw new Error('Window is not visible; focus it with niri_window, then capture again')
  if (area === 'window' && !position) throw new Error('Window position is not available; explicitly request area: output, or use AT-SPI')
  const x = area === 'output' ? 0 : Math.ceil(position![0] + window.layout.window_offset_in_tile[0])
  const y = area === 'output' ? 0 : Math.ceil(position![1] + window.layout.window_offset_in_tile[1])
  const width = area === 'output' ? output.width : Math.floor(window.layout.window_size[0])
  const height = area === 'output' ? output.height : Math.floor(window.layout.window_size[1])
  if (width <= 0 || height <= 0 || x < 0 || y < 0 || x + width > output.width || y + height > output.height) {
    throw new Error('Window is partly off-screen; focus or resize it before capture')
  }
  return { area, window, output: name, outputX: output.x, outputY: output.y, outputWidth: output.width, outputHeight: output.height,
    transform: output.transform, x, y, width, height, fingerprint: createHash('sha256').update(JSON.stringify({ window, output, name })).digest('hex') }
}

/** Convert pixels in the stored (possibly normalized) image, not physical monitor pixels.
 * @param frame - output-local captured rectangle.
 * @param image - dimensions returned by the attachment store.
 * @param x - image-local horizontal pixel.
 * @param y - image-local vertical pixel.
 * @returns output-local logical coordinates.
 */
export function mapPoint(frame: Frame, image: { width: number; height: number }, x: number, y: number): { x: number; y: number } {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= image.width || y >= image.height) throw new Error('Coordinates are outside the captured image')
  return { x: frame.x + x * frame.width / image.width, y: frame.y + y * frame.height / image.height }
}
