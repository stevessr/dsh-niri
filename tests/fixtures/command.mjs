/** Fake external commands only; stock-plugin tests use real Cordis, subprocesses and image storage. */
import { readFile, appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const root = process.env.XDG_RUNTIME_DIR
const args = process.argv.slice(2)
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const input = Buffer.concat(chunks).toString()
await appendFile(join(root, 'commands.jsonl'), JSON.stringify({ args, input, pid: process.pid }) + '\n')
const state = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))
const output = value => process.stdout.write(JSON.stringify(value))
if (args[0]?.endsWith('desktop.py')) {
  const request = JSON.parse(input)
  if (request.operation === 'probe' && state.hang) {
    process.on('SIGTERM', () => {})
    setInterval(() => {}, 1000)
    await writeFile(join(root, 'ready'), String(process.pid))
  } else if (request.operation === 'probe') output({ protocols: { zwlr_virtual_pointer_manager_v1: 2, zwp_virtual_keyboard_manager_v1: 1, zwlr_screencopy_manager_v1: 3 }, outputs: ['test'], accessibility: true })
  else if (request.operation === 'tree') output({ nodes: [{ path: [0], name: 'Increment', role: 'push button', actions: ['click'] }], truncated: false })
  else output({ dispatched: true })
} else if (args[0] === 'msg') {
  if (args[2] === 'version') output({ cli: '26.04 fixture', compositor: '26.04 fixture' })
  else if (args[2] === 'raw-request') output({ Ok: 'Handled' })
  else output(state[args[2]])
} else if (args.includes('-g') || args.includes('-o')) {
  await writeFile(args.at(-1), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64'))
}
