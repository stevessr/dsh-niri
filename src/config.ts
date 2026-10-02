/** Deployment settings and live operator controls. */
import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/** Paths select one local compositor; input is opt-in. */
export interface Config {
  readOnly: Volatile<boolean>
  mode: Volatile<'tools' | 'typescript'>
  niriCommand: string
  grimCommand: string
  wtypeCommand: string
  pythonCommand: string
  socketPath?: string
  waylandDisplay?: string
  runtimeDir?: string
  dbusAddress?: string
  accessibility: boolean
  allowedAppIds: string[]
  commandTimeoutMs: number
  terminationGraceMs: number
  maxOutputBytes: number
  maxImageBytes: number
  maxSnapshots: number
  snapshotTtlMs: number
  maxPendingCalls: number
  maxTreeNodes: number
  maxTreeDepth: number
  maxTextLength: number
}

const duration = (value: number) => s.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(value)
const command = (value: string) => s.string().pattern(/\S/u).default(value)
/** Validate paths, resource budgets and Settings UI controls. */
export const Config = s.object({
  readOnly: s.boolean().default(true).volatile(),
  mode: s.union(['tools', 'typescript'] as const).default('tools').volatile(),
  niriCommand: command('niri'),
  grimCommand: command('grim'),
  wtypeCommand: command('wtype'),
  pythonCommand: command('python3'),
  socketPath: s.string(), waylandDisplay: s.string(), runtimeDir: s.string(), dbusAddress: s.string(),
  accessibility: s.boolean().default(true),
  allowedAppIds: s.array(String).default([]),
  commandTimeoutMs: duration(15_000), terminationGraceMs: duration(1_000),
  maxOutputBytes: s.number().step(1).min(1024).max(Number.MAX_SAFE_INTEGER).default(1_048_576),
  maxImageBytes: s.number().step(1).min(1024).max(Number.MAX_SAFE_INTEGER).default(16_777_216),
  maxSnapshots: s.number().step(1).min(1).max(256).default(16),
  snapshotTtlMs: duration(30_000),
  maxPendingCalls: s.number().step(1).min(1).max(1024).default(32),
  maxTreeNodes: s.number().step(1).min(1).max(4096).default(256),
  maxTreeDepth: s.number().step(1).min(1).max(32).default(12),
  maxTextLength: s.number().step(1).min(1).max(1_048_576).default(16_384),
})
