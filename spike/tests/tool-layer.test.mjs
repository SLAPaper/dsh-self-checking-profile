// Native tool-layer integration (Windows only, opt-in):
//   node tests/tool-layer.test.mjs
// Loads the REAL dsh-tool-pwsh plugin over the spike's replacement ctx.shell
// and exercises `pwsh` through the actual tool definition: execute -> canonical
// value -> output.render -> model-facing text. This proves the spike result
// shape survives the untouched native tool renderer.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import * as toolPwsh from '@deepseek-ai/dsh-tool-pwsh'
import * as selfCheckingPlugin from '../lib/index.js'
import { selfCheckNoticeMarker } from '../lib/state.js'

if (process.platform !== 'win32') {
  console.log('tool-layer spike test is Windows-only; skipping')
  process.exit(0)
}

let failures = 0
function check(cond, label) {
  if (cond) console.log(`  ok: ${label}`)
  else { failures += 1; console.error(`  FAIL: ${label}`) }
}

const base = mkdtempSync(join(homedir(), 'dsh-sc-spike-tool-'))
const workspace = join(base, 'workspace')
const outside = join(base, 'outside')
mkdirSync(workspace)
mkdirSync(outside)

const SESSION = 'tool-s1'
const session = {
  id: SESSION,
  events: [{ type: 'permission/preset', data: { preset: 'self-checking' } }],
  header: { cwd: workspace }
}
let registeredTool
let approvalRequests = []
const root = new Context()
const stub = (name, value) => ({ name, apply(ctx) { ctx.provide(name, value) } })

await root.plugin(LocalSubprocessRuntime)
await root.plugin(LocalSandboxProvider)
await root.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
await root.plugin(stub('sessions', { get: (id) => id === SESSION ? session : undefined, list: () => [] }))
await root.plugin(stub('systemPrompt', { section: () => {}, context: () => {} }))
await root.plugin(stub('shellEnv', { collect: () => ({}) }))
await root.plugin(stub('approval', { request: async (request) => { approvalRequests.push(request); return 'allowed-once' } }))
await root.plugin(stub('tools', { register: (definition) => { registeredTool = definition } }))
await root.plugin(selfCheckingPlugin)
await root.plugin(toolPwsh)

check(registeredTool?.name === 'pwsh', 'native pwsh tool registered over the spike shell')

const exec = {
  callId: 'tool-call-1',
  agent: { session },
  signal: new AbortController().signal
}

try {
  const outsideFile = join(outside, 'tool-probe.txt')
  const args = {
    command: `Set-Content -LiteralPath '${outsideFile}' -Value tool-ok`,
    description: 'Write outside workspace probe file'
  }

  // First tool call: the native tool body executes through the spike shell,
  // which probes workspace-write and intercepts. canonicalBashResult drops the
  // extra sandbox flags, but the notice survives in stdout.
  const firstValue = await registeredTool.execute(args, exec)
  const firstText = registeredTool.output.render(args, firstValue)[0].text
  console.log('  first tool text:\n' + firstText)
  check(firstText.includes(selfCheckNoticeMarker('command')), 'native tool renderer passes the notice through')
  check(!firstText.includes('file access denied under self-checking mode'), 'no generic denial marker emitted')
  check(!existsSync(outsideFile), 'first tool call did not write outside')

  // Exact re-run through the same tool: spike shell sees the recorded key and
  // executes unconfined; the untouched native tool returns a normal success.
  const secondValue = await registeredTool.execute(args, exec)
  check(secondValue.exitCode === 0, 'exact re-run succeeds through the native tool')
  check(existsSync(outsideFile) && readFileSync(outsideFile, 'utf8').trim() === 'tool-ok', 're-run wrote outside through the native tool')
  const secondText = registeredTool.output.render(args, secondValue)[0].text
  check(!secondText.includes(selfCheckNoticeMarker('command')), 'successful re-run has no notice')

  // Explicit escalation still works: standing mode is workspace-write, so
  // sandbox_permissions=danger-full-access routes through ctx.approval and
  // executes full access (the same channel as the fork version).
  const approvedFile = join(outside, 'tool-approved.txt')
  const approvedArgs = {
    command: `Set-Content -LiteralPath '${approvedFile}' -Value approved`,
    description: 'Write outside workspace with explicit escalation',
    sandbox_permissions: 'danger-full-access',
    justification: 'the user asked for this outside-workspace file'
  }
  const approvedValue = await registeredTool.execute(approvedArgs, exec)
  check(approvedValue.exitCode === 0, 'explicit escalation executes with full access')
  check(existsSync(approvedFile) && readFileSync(approvedFile, 'utf8').trim() === 'approved', 'explicit escalation wrote outside')
  check(approvalRequests.length === 1 && approvalRequests[0].toolName === 'pwsh', 'escalation used the approval channel once')
} finally {
  rmSync(base, { recursive: true, force: true })
  try { await root.dispose() } catch { }
}

if (failures > 0) {
  console.error(`\n${failures} TOOL-LAYER CHECK(S) FAILED`)
  process.exitCode = 1
} else {
  console.log('\nTOOL-LAYER CHECKS PASSED')
}
