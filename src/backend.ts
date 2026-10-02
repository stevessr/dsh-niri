/** Niri observations, bounded snapshot capabilities and serialized desktop operations. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { z } from 'zod'
import type { Config } from './config.ts'
import type { Commands } from './commands.ts'
import { DesktopQueue } from './commands.ts'
import { Window, Workspace, Output, frameFor, mapPoint, type DesktopState, type Frame } from './state.ts'

/** Opaque, activation-local observation capability. */
export const SnapshotId = z.string().uuid().brand<'NiriSnapshotId'>()
/** An AT-SPI node is re-resolved and matched before activation. */
export const AccessibleNode = z.object({ path: z.array(z.number().int().nonnegative()).max(32), name: z.string(), role: z.string(), actions: z.array(z.string()) })
const Tree = z.object({ nodes: z.array(AccessibleNode), truncated: z.boolean() })
const Probe = z.object({ protocols: z.record(z.string(), z.number().int()), outputs: z.array(z.string()), accessibility: z.boolean() })
/** One validated input operation; no raw shell or compositor command is accepted. */
export const Input = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().min(1) }),
  z.object({ kind: z.literal('key'), key: z.string().regex(/^[A-Za-z0-9_]+$/u).max(64), modifiers: z.array(z.enum(['ctrl', 'alt', 'shift', 'logo', 'altgr'])).max(5).default([]) }),
  ...(['move', 'click', 'drag', 'scroll'] as const).map(kind => z.object({ kind: z.literal(kind), x: z.number().finite(), y: z.number().finite(),
    button: z.enum(['left', 'right', 'middle']).default('left'), toX: z.number().finite().optional(), toY: z.number().finite().optional(),
    axis: z.enum(['vertical', 'horizontal']).default('vertical'), amount: z.number().min(-1000).max(1000).optional() })),
])
type Snapshot = { owner: object | undefined; expires: number; frame: Frame } & (
  | { kind: 'image'; image: ImageAttachmentRef }
  | { kind: 'tree'; nodes: z.infer<typeof AccessibleNode>[] }
)

/** Stateful provider implementation; the plugin owns its queue and all registrations. */
export class NiriBackend {
  readonly queue: DesktopQueue
  private readonly snapshots = new Map<z.infer<typeof SnapshotId>, Snapshot>()
  private capabilities: z.infer<typeof Probe> | undefined
  private readonly helperPath = fileURLToPath(new URL('../helper/desktop.py', import.meta.url))
  constructor(private readonly commands: Commands, private readonly config: Config, private readonly attachments: AttachmentStore) {
    this.queue = new DesktopQueue(config.maxPendingCalls, config.commandTimeoutMs)
  }

  /** Verify the selected compositor and required protocols without moving input.
   * @param signal - startup cancellation.
   */
  async initialize(signal: AbortSignal): Promise<void> {
    this.capabilities = Probe.parse(await this.helper({ operation: 'probe', accessibility: this.config.accessibility }, signal))
    for (const [protocol, minimum] of [['zwlr_virtual_pointer_manager_v1', 2], ['zwp_virtual_keyboard_manager_v1', 1], ['zwlr_screencopy_manager_v1', 1]] as const) {
      if ((this.capabilities.protocols[protocol] ?? 0) < minimum) throw new Error(`Selected niri lacks ${protocol} v${minimum}`)
    }
    z.object({ cli: z.string(), compositor: z.string() }).parse(JSON.parse(await this.commands.run([this.config.niriCommand, 'msg', '--json', 'version'], signal)))
  }

  /** Query current IPC state; these three reads are not an atomic compositor transaction.
   * @param signal - execution cancellation.
   * @returns parsed windows, stable workspace ids and logical output geometry.
   */
  async state(signal: AbortSignal): Promise<DesktopState> {
    const query = async (name: string): Promise<unknown> => JSON.parse(await this.commands.run([this.config.niriCommand, 'msg', '--json', name], signal))
    const windows = z.array(Window).parse(await query('windows')).filter(window => this.allowed(window.app_id))
    const workspaces = z.array(Workspace).parse(await query('workspaces'))
    const outputs = z.record(z.string(), Output).parse(await query('outputs'))
    return { windows, workspaces, outputs }
  }

  /** Observe without launching apps, activating windows or reading clipboard contents.
   * @param signal - invocation cancellation.
   * @returns current state and the selected session's capabilities.
   */
  async observe(signal: AbortSignal) {
    return { ...await this.state(signal), capabilities: this.capabilities, readOnly: this.config.readOnly.get() }
  }

  /** Capture a client rectangle or its entire output without changing the clipboard.
   * @param windowId - stable window id from observation.
   * @param owner - invoking Agent, used to scope snapshot capabilities.
   * @param signal - invocation cancellation.
   * @param area - explicit capture extent; output includes other visible applications.
   * @returns a durable image reference and input-coordinate metadata.
   */
  async capture(windowId: number, owner: object | undefined, signal: AbortSignal, area: 'window' | 'output' = 'window') {
    const frame = frameFor(await this.state(signal), windowId, area)
    const root = await mkdtemp(join(tmpdir(), 'dsh-niri-capture-'))
    try {
      const path = join(root, 'window.png')
      await this.helper({ operation: 'check' }, signal)
      const extent = area === 'output' ? ['-o', frame.output]
        : ['-g', `${frame.outputX + frame.x},${frame.outputY + frame.y} ${frame.width}x${frame.height}`]
      await this.commands.run([this.config.grimCommand, '-s', '1', ...extent, path], signal)
      if (frameFor(await this.state(signal), windowId, area).fingerprint !== frame.fingerprint) throw new Error('Window changed during capture; capture again')
      if ((await stat(path)).size > this.config.maxImageBytes) throw new Error('Screenshot exceeds maxImageBytes')
      const data = await readFile(path)
      signal.throwIfAborted()
      const image = await this.attachments.saveImage({ data, mediaType: 'image/png', name: 'niri-window.png' })
      const snapshotId = this.remember({ kind: 'image', owner, frame, image, expires: Date.now() + this.config.snapshotTtlMs })
      return { data: { snapshotId, windowId, area, output: frame.output, width: image.width, height: image.height, coordinates: 'stored-image-pixels' }, image }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  /** Use niri's semantic API instead of simulated desktop shortcuts.
   * @param request - focus or move operation, with app identity copied from observation.
   * @param signal - invocation cancellation.
   * @returns dispatch acknowledgement and a fresh, non-atomic state observation.
   */
  async windowAction(request: { windowId: number; expectedAppId: string | null; action: 'focus' | 'move' | 'float' | 'tile'; workspaceId?: number | undefined }, signal: AbortSignal) {
    this.writable()
    const state = await this.state(signal)
    const window = state.windows.find(item => item.id === request.windowId)
    if (!window || window.app_id !== request.expectedAppId) throw new Error('Window identity changed or is not allowed; observe again')
    if (request.action === 'move' && !state.workspaces.some(item => item.id === request.workspaceId)) throw new Error('A current workspaceId is required for move')
    const action = request.action === 'focus' ? { FocusWindow: { id: request.windowId } }
      : request.action === 'float' ? { MoveWindowToFloating: { id: request.windowId } }
      : request.action === 'tile' ? { MoveWindowToTiling: { id: request.windowId } }
      : { MoveWindowToWorkspace: { window_id: request.windowId, reference: { Id: request.workspaceId }, focus: true } }
    this.writable()
    this.snapshots.clear()
    await this.commands.run([this.config.niriCommand, 'msg', '--json', 'raw-request'], signal, JSON.stringify({ Action: action }))
    return { dispatched: true, ...await this.state(signal) }
  }

  /** Dispatch one pixel/keyboard operation, consuming its fresh observation token.
   * @param id - image snapshot capability.
   * @param action - bounded, validated input operation.
   * @param owner - invoking Agent.
   * @param signal - invocation cancellation.
   * @returns dispatch acknowledgement; applications must still be observed for success.
   */
  async input(id: z.infer<typeof SnapshotId>, action: z.infer<typeof Input>, owner: object | undefined, signal: AbortSignal) {
    this.writable()
    const snapshot = await this.current(id, owner, signal)
    if (snapshot.kind !== 'image') throw new Error('Input requires a screenshot snapshotId')
    if (!snapshot.frame.window.is_focused) throw new Error('Focus the target window and capture again before input')
    if (action.kind === 'text' && (action.text.length > this.config.maxTextLength || action.text.includes('\0'))) throw new Error('Text is too long or contains NUL')
    let point: { x: number; y: number } | undefined
    let target: { x: number; y: number } | undefined
    if ('x' in action) {
      point = mapPoint(snapshot.frame, snapshot.image, action.x, action.y)
      if (action.kind === 'drag') {
        if (action.toX === undefined || action.toY === undefined) throw new Error('Drag requires toX and toY')
        target = mapPoint(snapshot.frame, snapshot.image, action.toX, action.toY)
      }
      if (action.kind === 'scroll' && action.amount === undefined) throw new Error('Scroll requires amount')
    }
    if (action.kind === 'text' || action.kind === 'key') await this.helper({ operation: 'check' }, signal)
    this.writable()
    this.snapshots.clear() // Failed or partial input also invalidates earlier capabilities.
    if (action.kind === 'text') await this.commands.run([this.config.wtypeCommand, '-'], signal, action.text)
    else if (action.kind === 'key') await this.commands.run([this.config.wtypeCommand, ...action.modifiers.flatMap(modifier => ['-M', modifier]), '-k', action.key, ...[...action.modifiers].reverse().flatMap(modifier => ['-m', modifier])], signal)
    else await this.helper({ ...action, ...point, operation: 'pointer', output: snapshot.frame.output, transform: snapshot.frame.transform, width: snapshot.frame.outputWidth, height: snapshot.frame.outputHeight, ...(target ? { toX: target.x, toY: target.y } : {}) }, signal)
    return { dispatched: true, windowId: snapshot.frame.window.id, instruction: 'Observe application state before deciding whether the task succeeded.' }
  }

  /** Read a bounded accessibility tree for one unambiguously matched app window.
   * @param windowId - visible window id.
   * @param owner - invoking Agent.
   * @param signal - invocation cancellation.
   * @returns semantic node paths, actions and a scoped snapshot id.
   */
  async tree(windowId: number, owner: object | undefined, signal: AbortSignal) {
    const frame = frameFor(await this.state(signal), windowId, 'output')
    const tree = Tree.parse(await this.helper({ ...this.accessibilityRequest(frame), operation: 'tree' }, signal))
    const snapshotId = this.remember({ kind: 'tree', frame, owner, expires: Date.now() + this.config.snapshotTtlMs, nodes: tree.nodes })
    return { snapshotId, windowId, ...tree }
  }

  /** Activate only a node/action pair advertised by this Agent's prior tree.
   * @param id - tree snapshot capability.
   * @param path - exact child-index path in that tree.
   * @param action - advertised AT-SPI action name.
   * @param owner - invoking Agent.
   * @param signal - invocation cancellation.
   * @returns application dispatch acknowledgement.
   */
  async activate(id: z.infer<typeof SnapshotId>, path: number[], action: string, owner: object | undefined, signal: AbortSignal) {
    this.writable()
    const snapshot = await this.current(id, owner, signal)
    if (snapshot.kind !== 'tree') throw new Error('Accessibility actions require a tree snapshotId')
    const node = snapshot.nodes.find(item => JSON.stringify(item.path) === JSON.stringify(path))
    if (!node || !node.actions.includes(action)) throw new Error('Node/action was not advertised in this snapshot')
    this.writable()
    this.snapshots.clear()
    return z.object({ dispatched: z.literal(true) }).parse(await this.helper({ ...this.accessibilityRequest(snapshot.frame), operation: 'act', node, action }, signal))
  }

  /** Stop pending input before the plugin releases the exclusive provider slot. */
  async dispose(): Promise<void> { await this.queue.dispose(); this.snapshots.clear() }

  private allowed(app: string | null): boolean { return this.config.allowedAppIds.length === 0 || (app !== null && this.config.allowedAppIds.includes(app)) }
  private writable(): void { if (this.config.readOnly.get()) throw new Error('Niri is read-only; enable input in trusted plugin Settings first') }
  private async helper(request: object, signal: AbortSignal): Promise<unknown> {
    return JSON.parse(await this.commands.run([this.config.pythonCommand, this.helperPath], signal, JSON.stringify(request)))
  }
  private accessibilityRequest(frame: Frame) {
    if (!this.config.accessibility) throw new Error('Accessibility is disabled in this deployment')
    if (frame.window.pid === null || frame.window.title === null) throw new Error('AT-SPI requires a window PID and title')
    return { pid: frame.window.pid, title: frame.window.title, maxNodes: this.config.maxTreeNodes, maxDepth: this.config.maxTreeDepth, maxTextLength: this.config.maxTextLength, timeoutMs: this.config.commandTimeoutMs }
  }
  private remember(snapshot: Snapshot): z.infer<typeof SnapshotId> {
    for (const [id, item] of this.snapshots) if (item.expires <= Date.now()) this.snapshots.delete(id)
    while (this.snapshots.size >= this.config.maxSnapshots) this.snapshots.delete(this.snapshots.keys().next().value!)
    const id = SnapshotId.parse(randomUUID())
    this.snapshots.set(id, snapshot)
    return id
  }
  private async current(id: z.infer<typeof SnapshotId>, owner: object | undefined, signal: AbortSignal): Promise<Snapshot> {
    const snapshot = this.snapshots.get(id)
    if (!snapshot || snapshot.owner !== owner || snapshot.expires <= Date.now()) throw new Error('Unknown, expired, consumed, or foreign snapshotId; observe again')
    if (frameFor(await this.state(signal), snapshot.frame.window.id, snapshot.frame.area).fingerprint !== snapshot.frame.fingerprint) throw new Error('Focus, identity or window geometry changed; observe again')
    if (snapshot.expires <= Date.now()) throw new Error('Snapshot expired during validation; observe again')
    return snapshot
  }
}
