import { Context } from '@deepseek-ai/cordis'
import * as main from '../lib/index.js'

const stub = (name, value = {}) => ({
  name,
  apply(ctx) { ctx.provide(name, value) }
})

let failures = 0
function check(cond, label) {
  if (cond) console.log(`  ok: ${label}`)
  else { failures += 1; console.error(`  FAIL: ${label}`) }
}

const sessions = new Map([
  ['sc-s1', { id: 'sc-s1', events: [{ type: 'permission/preset', data: { preset: 'self-checking' } }] }],
  ['ww-s1', { id: 'ww-s1', events: [{ type: 'permission/preset', data: { preset: 'workspace-write' } }] }]
])
let promptDefinition

const root = new Context()
const fibers = [
  root.plugin(stub('subprocess')),
  root.plugin(stub('sandbox', { confine: () => ({ argv: [], enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] }) })),
  root.plugin(stub('sandboxPolicy', { defaultMode: 'workspace-write' })),
  root.plugin(stub('sessions', { get: (id) => sessions.get(id), list: () => [...sessions.values()] })),
  root.plugin(stub('systemPrompt', { context: (definition) => { promptDefinition = definition } }))
]
const mainFiber = root.plugin(main)
fibers.push(mainFiber)
for (const fiber of fibers) await fiber
await new Promise((resolve) => setTimeout(resolve, 20))

const shell = root.get('shell')
const fs = root.get('fs')
check(shell !== undefined && shell.constructor.name === 'SelfCheckingShellExecutor', 'replacement ctx.shell registered')
check(fs !== undefined && fs.constructor.name === 'SelfCheckingSandboxedFileSystem', 'replacement ctx.fs registered')
check(shell?.sandboxMode === 'workspace-write', 'shell advertises the standing workspace-write mode')
check(fs?.sandboxMode === 'workspace-write', 'fs advertises the standing workspace-write mode')

check(promptDefinition !== undefined, 'systemPrompt context registered')
const selfCheckingText = promptDefinition?.text({ agent: { session: sessions.get('sc-s1') } }) ?? ''
const workspaceText = promptDefinition?.text({ agent: { session: sessions.get('ww-s1') } }) ?? ''
check(selfCheckingText.includes('Self Checking mode is active'), 'self-checking session gets the plugin context')
check(workspaceText === '', 'ordinary workspace-write session gets no extra context')

if (failures > 0) process.exitCode = 1
else console.log('\nCORDIS REGISTRATION CHECKS PASSED')
