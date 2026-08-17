// Native filesystem-tool integration (cross-platform):
//   node tests/fs-tool-layer.test.mjs
// Loads the REAL dsh-tool-fs plugin over the plugin's replacement ctx.fs and
// exercises the `write` tool definition: inside write succeeds, outside write
// throws the FS_SELFCHECK_INTERCEPTED marker, and the exact re-run succeeds.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import * as toolFs from '@deepseek-ai/dsh-tool-fs'
import * as selfCheckingPlugin from '../lib/index.js'
import { FS_SELF_CHECK_FAIL_HINT } from '../lib/state.js'

let failures = 0
function check(cond, label) {
  if (cond) console.log(`  ok: ${label}`)
  else { failures += 1; console.error(`  FAIL: ${label}`) }
}

const base = mkdtempSync(join(homedir(), 'dsh-sc-plugin-fstool-'))
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
let approvalRequests = []
const root = new Context()
const stub = (name, value) => ({ name, apply(ctx) { ctx.provide(name, value) } })

await root.plugin(stub('subprocess'))
await root.plugin(stub('sandbox', { confine: () => ({ argv: [], enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] }) }))
await root.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
await root.plugin(stub('sessions', { get: (id) => id === SESSION ? session : undefined, list: () => [] }))
await root.plugin(stub('systemPrompt', { section: () => {}, context: () => {} }))
await root.plugin(stub('tools', { register: (definition) => { tools.set(definition.name, definition) } }))
await root.plugin(stub('approval', { request: async (request) => { approvalRequests.push(request); return 'allowed-once' } }))
await root.plugin(selfCheckingPlugin)
await root.plugin(toolFs)

const writeTool = tools.get('write')
const editTool = tools.get('edit')
check(writeTool !== undefined, 'native write tool registered over the plugin fs')
check(editTool !== undefined, 'native edit tool registered over the plugin fs')

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

  // Explicit escalation still works: standing mode is workspace-write, so
  // sandbox_permissions=danger-full-access routes through ctx.approval.
  const approvedArgs = {
    file_path: join(outside, 'tool-approved.txt'),
    content: 'approved',
    sandbox_permissions: 'danger-full-access',
    justification: 'the user asked for this outside-workspace file'
  }
  const approvedValue = await writeTool.execute(approvedArgs, exec)
  check(approvedValue.operation === 'create', 'explicit fs escalation executes with full access')
  check(readFileSync(join(outside, 'tool-approved.txt'), 'utf8') === 'approved', 'explicit fs escalation wrote outside')
  check(approvalRequests.length === 1 && approvalRequests[0].toolName === 'write', 'fs escalation used the approval channel once')

  // Native edit tool over the plugin fs: outside edit intercepts once, the
  // exact re-run edits with full access.
  const editOutsideFile = join(outside, 'edit-outside.txt')
  writeFileSync(editOutsideFile, 'v1')
  const editOutsideArgs = { file_path: editOutsideFile, old_string: 'v1', new_string: 'v2' }
  let editFirstError
  try { await editTool.execute(editOutsideArgs, exec) } catch (error) { editFirstError = error }
  check(editFirstError?.code === 'FS_SELFCHECK_INTERCEPTED', 'outside edit throws FS_SELFCHECK_INTERCEPTED')
  check(readFileSync(editOutsideFile, 'utf8') === 'v1', 'intercepted edit did not change the file')
  const editRetry = await editTool.execute(editOutsideArgs, exec)
  check(editRetry.before === 'v1' && editRetry.after === 'v2', 'exact edit re-run reports the replacement')
  check(readFileSync(editOutsideFile, 'utf8') === 'v2', 'exact edit re-run changed the outside file')

  // Ordinary non-denial edit failure under self-checking: the defensive hint
  // survives the native tool error mapping.
  const editFailFile = join(workspace, 'edit-fail.txt')
  writeFileSync(editFailFile, 'hello')
  let editFailError
  try {
    await editTool.execute({ file_path: editFailFile, old_string: 'not-there', new_string: 'x' }, exec)
  } catch (error) { editFailError = error }
  check(editFailError?.code === 'FS_EDIT_NOT_FOUND', 'ordinary edit failure keeps its structured code')
  check(editFailError?.message.includes(FS_SELF_CHECK_FAIL_HINT.trim()), 'ordinary edit failure carries the self-check hint through the native tool layer')

  // Same-session preset switch: moving to workspace-write turns the plugin
  // gate off and restores the native plain denial; moving to full access
  // executes without any gate.
  session.events.push(
    { type: 'permission/preset', data: { preset: 'workspace-write' } },
    { type: 'sandbox/mode', data: { mode: 'workspace-write' } }
  )
  const wwFile = join(outside, 'switch-ww.txt')
  let wwError
  try { await writeTool.execute({ file_path: wwFile, content: 'ww' }, exec) } catch (error) { wwError = error }
  check(wwError?.code === 'FS_SANDBOX_DENIED', 'same session switched to workspace-write keeps plain denial')
  check(!wwError?.message.includes('self-check intercepted'), 'workspace-write switch has no self-check marker')
  check(!existsSync(wwFile), 'workspace-write switch did not write outside')

  session.events.push(
    { type: 'permission/preset', data: { preset: 'danger-full-access' } },
    { type: 'sandbox/mode', data: { mode: 'danger-full-access' } }
  )
  const fullFile = join(outside, 'switch-full.txt')
  const fullValue = await writeTool.execute({ file_path: fullFile, content: 'full' }, exec)
  check(fullValue.operation === 'create', 'same session switched to full access succeeds')
  check(readFileSync(fullFile, 'utf8') === 'full', 'full-access switch wrote outside')
  check(approvalRequests.length === 1, 'preset switches do not consume the approval channel')
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
