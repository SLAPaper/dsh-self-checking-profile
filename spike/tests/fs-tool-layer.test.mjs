// Native filesystem-tool integration (cross-platform):
//   node tests/fs-tool-layer.test.mjs
// Loads the REAL dsh-tool-fs plugin over the spike's replacement ctx.fs and
// exercises the `write` tool definition: inside write succeeds, outside write
// throws the FS_SELFCHECK_INTERCEPTED marker, and the exact re-run succeeds.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import * as toolFs from '@deepseek-ai/dsh-tool-fs'
import * as selfCheckingPlugin from '../lib/index.js'

let failures = 0
function check(cond, label) {
  if (cond) console.log(`  ok: ${label}`)
  else { failures += 1; console.error(`  FAIL: ${label}`) }
}

const base = mkdtempSync(join(homedir(), 'dsh-sc-spike-fstool-'))
const workspace = join(base, 'workspace')
const outside = join(base, 'outside')
mkdirSync(workspace)
mkdirSync(outside)

const SESSION = 'fs-tool-s1'
const session = {
  id: SESSION,
  events: [{ type: 'permission/preset', data: { preset: 'self-checking' } }],
  header: { cwd: workspace }
}
const tools = new Map()
const root = new Context()
const stub = (name, value) => ({ name, apply(ctx) { ctx.provide(name, value) } })

await root.plugin(stub('subprocess'))
await root.plugin(stub('sandbox', { confine: () => ({ argv: [], enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] }) }))
await root.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
await root.plugin(stub('sessions', { get: (id) => id === SESSION ? session : undefined, list: () => [] }))
await root.plugin(stub('systemPrompt', { section: () => {}, context: () => {} }))
await root.plugin(stub('tools', { register: (definition) => { tools.set(definition.name, definition) } }))
await root.plugin(selfCheckingPlugin)
await root.plugin(toolFs)

const writeTool = tools.get('write')
check(writeTool !== undefined, 'native write tool registered over the spike fs')

const exec = {
  callId: 'fs-tool-call-1',
  agent: { session },
  signal: new AbortController().signal
}

try {
  const insideArgs = { file_path: 'inside-tool.txt', content: 'inside-ok' }
  const insideValue = await writeTool.execute(insideArgs, exec)
  check(existsSync(join(workspace, 'inside-tool.txt')) && readFileSync(join(workspace, 'inside-tool.txt'), 'utf8') === 'inside-ok', 'inside write succeeds through the native write tool')

  const outsideArgs = { file_path: join(outside, 'tool-outside.txt'), content: 'outside-ok' }
  let firstError
  try { await writeTool.execute(outsideArgs, exec) } catch (error) { firstError = error }
  check(firstError?.code === 'FS_SELFCHECK_INTERCEPTED', 'outside write throws FS_SELFCHECK_INTERCEPTED')
  check(firstError?.message.includes('[sandbox: self-check intercepted'), 'model-facing marker passes through the native tool layer')
  check(!existsSync(join(outside, 'tool-outside.txt')), 'outside write did not happen')

  const retryValue = await writeTool.execute(outsideArgs, exec)
  check(retryValue.operation === 'create', 'exact re-run creates the outside file through the native write tool')
  check(readFileSync(join(outside, 'tool-outside.txt'), 'utf8') === 'outside-ok', 're-run wrote outside through the native write tool')
} finally {
  rmSync(base, { recursive: true, force: true })
  try { await root.dispose() } catch { }
}

if (failures > 0) {
  console.error(`\n${failures} FS-TOOL-LAYER CHECK(S) FAILED`)
  process.exitCode = 1
} else {
  console.log('\nFS-TOOL-LAYER CHECKS PASSED')
}
