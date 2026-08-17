import { Context } from '@deepseek-ai/cordis'
import * as main from '../lib/index.js'

const stub = (name, value = {}) => ({
  name,
  apply(ctx) { ctx.provide(name, value) }
})

const root = new Context()
const fibers = [
  root.plugin(stub('subprocess')),
  root.plugin(stub('sandbox', { confine: () => ({ argv: [], enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] }) })),
  root.plugin(stub('sandboxPolicy', { defaultMode: 'workspace-write' })),
  root.plugin(stub('sessions', { get: () => undefined, list: () => [] })),
  root.plugin(stub('permissionPresets', { current: () => 'workspace-write' })),
  root.plugin(stub('systemPrompt', { context: () => {} }))
]
const mainFiber = root.plugin(main)
fibers.push(mainFiber)
for (const fiber of fibers) await fiber
await new Promise((resolve) => setTimeout(resolve, 20))
const shell = root.get('shell')
const fs = root.get('fs')
if (!shell || !fs) {
  console.error('registration failed', { shell: shell?.constructor?.name, fs: fs?.constructor?.name })
  process.exit(1)
}
console.log('registered shell:', shell.constructor.name)
console.log('registered fs:', fs.constructor.name)
console.log('shell sandboxMode:', shell.sandboxMode)
console.log('fs sandboxMode:', fs.sandboxMode)
