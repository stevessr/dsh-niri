/** Real Loader, Agent session logging and Node PTC on the pinned, patched Host. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import ComputerUse from '@deepseek-ai/dsh-computer-use'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import NodeRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import * as Provider from '../src/index.ts'
import { fakeDesktop } from './fake-desktop.ts'

const resources: { ctx: Context; root: string }[] = []
afterEach(async () => {
  for (const { ctx, root } of resources.splice(0)) {
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  }
})

class CaptureModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly mode: 'tools' | 'typescript') { super() }
  override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] as ('text' | 'image')[] }) }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      const name = this.mode === 'tools' ? 'niri_capture' : 'run_code'
      const args = this.mode === 'tools' ? { windowId: 7 } : { code: 'return (await tools.niri_capture({windowId: 7})).data', description: 'Inspect the selected niri window' }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('capture-call'), name, arguments: JSON.stringify(args) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Window inspected.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

async function load(mode: 'tools' | 'typescript') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-niri-ptc-'))
  const ctx = new Context(); resources.push({ ctx, root })
  const model = new CaptureModel(mode)
  const errors: unknown[] = []
  ctx.logger.exporter({ export(message) { if (message.type === 'error') message.args.forEach((error: unknown) => errors.push(error)) } })
  const fixture = await fakeDesktop(root)
  const config = { ...fixture.config, mode }
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader).await()
  Object.assign(ctx.loader.builtins, {
    include: Include, computer: ComputerUse, prompt: SystemPrompt, tools: ToolRuntime,
    llm: LlmRuntime, sessions: SessionStore, agents: AgentRegistry, loop: AgentLoop,
    projections: SessionProjectionRegistry, attachments: LocalAttachmentStore,
    fs: FileSystem, subprocess: Subprocess, sandbox: Sandbox, policy: SandboxPolicy, runtime: NodeRuntime,
    model: { inject: ['llm'], apply(inner: Context) { inner.effect(() => inner.llm.registerAdapter(['fixture'], model)) } },
    niri: Provider,
  })
  const rows = [
    ...['computer', 'prompt', 'tools', 'llm', 'sessions', 'agents', 'projections', 'fs', 'subprocess', 'sandbox', 'model'].map(name => ({ name: `cordis:${name}` })),
    { name: 'cordis:loop', config: { agents: [] } },
    { name: 'cordis:attachments', config: { dshHome: root } },
    { name: 'cordis:policy', config: { mode: 'danger-full-access', workspaceRoot: root } },
    { name: 'cordis:runtime' }, { id: 'niri', name: 'cordis:niri', config },
  ]
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify(rows))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const entry = [...ctx.loader.entries()].find(item => item.options.id === 'niri')
  if (!entry || entry.fiber?.state !== FiberState.ACTIVE) throw new AggregateError(errors, 'Niri failed to activate')
  return { ctx, root, entry, model, config }
}

it.each(['tools', 'typescript'] as const)('records and reconstructs durable screenshots through a real Agent in %s mode', async mode => {
  const { ctx, entry, model } = await load(mode)
  const schemas = (await ctx.systemPrompt.assemble()).tools.map(tool => tool.name)
  expect(schemas).toEqual(mode === 'tools'
    ? ['niri_accessibility', 'niri_activate', 'niri_capture', 'niri_input', 'niri_observe', 'niri_window'] : ['run_code'])
  if (mode === 'typescript') {
    const direct = await ctx.tools.execute({ name: 'niri_capture', arguments: { windowId: 7 }, callId: ToolCallId('denied'), signal: new AbortController().signal })
    expect(direct.isError).toBe(true)
  }
  const agent = await ctx.agentLoop.create(SessionId('niri-fixture'), { provider: 'fixture', model: 'vision' })
  const idle = new Promise<void>(resolve => {
    const off = ctx.on('agent/status', ({ agent: subject, status }) => { if (subject === agent && status === 'idle') { off(); resolve() } })
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect the selected window.' }], source: { kind: 'user' } }))
  await idle
  expect(model.requests).toHaveLength(2)
  expect(JSON.stringify(agent.session.snapshotEvents())).not.toContain('iVBOR')
  const images = agent.session.deriveMessages().flatMap(message => message.content.filter(block => block.type === 'image'))
  expect(images.length).toBeGreaterThan(0)
  expect(await ctx.attachments.readImage(images[0]!.attachment)).toMatchObject({ ref: { width: 1, height: 1 } })
  await entry.fiber?.dispose()
  expect(ctx.tools.schemas()).toEqual([])
  expect(ctx.computerUse.providerName).toBeUndefined()
})

it('changes live input and exposure settings without restarting the provider', async () => {
  const { ctx, entry, config } = await load('tools')
  const fiber = entry.fiber
  const call = () => ctx.tools.execute({ name: 'niri_window', arguments: { windowId: 7, expectedAppId: 'fixture', action: 'focus' }, callId: ToolCallId('focus'), signal: new AbortController().signal })
  expect((await call()).isError).toBe(true)
  await entry.update({ config: { ...config, readOnly: false } })
  expect(entry.fiber).toBe(fiber)
  expect((await call()).isError).toBe(false)
  for (const mode of ['typescript', 'tools'] as const) {
    await entry.update({ config: { ...config, mode, readOnly: true } })
    expect(entry.fiber).toBe(fiber)
    const schemas = (await ctx.systemPrompt.assemble()).tools.map(tool => tool.name)
    expect(schemas.includes('niri_observe')).toBe(mode === 'tools')
    expect(schemas.includes('run_code')).toBe(mode === 'typescript')
  }
  expect((await call()).isError).toBe(true)
})
