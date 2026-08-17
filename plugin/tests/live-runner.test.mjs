// Live runner plugin-route test (Windows only, opt-in):
//   node tests/live-runner.test.mjs
// Boots real LocalSubprocessRuntime + LocalSandboxProvider + SandboxPolicyService
// in a Cordis context and runs the plugin's SelfCheckingPwshExecutor against
// the real windows-acl runner: inside write passes, outside write is
// intercepted once, and the exact re-run executes with full access.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import * as selfCheckingPlugin from '../lib/index.js'
import { selfCheckNoticeMarker } from '../lib/state.js'

if (process.platform !== 'win32') {
  console.log('live-runner plugin-route test is Windows-only (pwsh + windows-acl); skipping')
  process.exit(0)
}

let failures = 0
function check(cond, label) {
  if (cond) console.log(`  ok: ${label}`)
  else { failures += 1; console.error(`  FAIL: ${label}`) }
}

const base = mkdtempSync(join(homedir(), 'dsh-sc-plugin-live-'))
const workspace = join(base, 'workspace')
const outside = join(base, 'outside')
mkdirSync(workspace)
mkdirSync(outside)

const root = new Context()
const stub = (name, value) => ({ name, apply(ctx) { ctx.provide(name, value) } })

const SESSION = 'live-s1'
const sessionMap = new Map([
  [SESSION, {
    id: SESSION,
    events: [{ type: 'permission/preset', data: { preset: 'self-checking' } }],
    header: { cwd: workspace }
  }],
  ['ww-s1', {
    id: 'ww-s1',
    events: [{ type: 'permission/preset', data: { preset: 'workspace-write' } }],
    header: { cwd: workspace }
  }],
  ['full-s1', {
    id: 'full-s1',
    events: [{ type: 'permission/preset', data: { preset: 'danger-full-access' } }],
    header: { cwd: workspace }
  }]
])

await root.plugin(LocalSubprocessRuntime)
await root.plugin(LocalSandboxProvider)
await root.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
await root.plugin(stub('sessions', { get: (id) => sessionMap.get(id), list: () => [] }))
await root.plugin(stub('systemPrompt', { context: () => {} }))
await root.plugin(selfCheckingPlugin)
const shell = root.get('shell')

// Actual plugin preset: standing sandbox mode is workspace-write; the session
// log's last permission/preset event is what switches on Self Checking.
const policy = { mode: 'workspace-write', workspaceRoot: workspace, sessionId: SESSION }

try {
  // Inside-workspace write: probe passes on the first attempt.
  const insideFile = join(workspace, 'inside.txt')
  const insideSpec = shell.resolve({
    command: `Set-Content -LiteralPath '${insideFile}' -Value inside-ok`,
    workdir: workspace,
    timeoutMs: 30000,
    sandboxPolicy: policy
  })
  const inside = await shell.run(insideSpec)
  check(inside.exitCode === 0, 'inside-workspace pwsh write succeeds on first attempt')
  check(existsSync(insideFile) && readFileSync(insideFile, 'utf8').trim() === 'inside-ok', 'inside file was actually written')

  // Outside-workspace write: intercepted once, nothing written.
  const outsideFile = join(outside, 'probe.txt')
  const outsideSpec = shell.resolve({
    command: `Set-Content -LiteralPath '${outsideFile}' -Value outside-ok`,
    workdir: workspace,
    timeoutMs: 30000,
    sandboxPolicy: policy
  })
  const first = await shell.run(outsideSpec)
  check(first.sandbox?.intercepted === true, 'outside pwsh write intercepted')
  check(first.sandbox?.denied === false, 'interception is presented as the self-check notice, not a generic denial')
  check(first.stdout.text.includes(selfCheckNoticeMarker('command')), 'live result carries the self-check notice')
  check(!existsSync(outsideFile), 'intercepted write did not happen')

  // Exact re-run: full access.
  const second = await shell.run(outsideSpec)
  check(second.exitCode === 0, 'exact re-run succeeds')
  check(existsSync(outsideFile) && readFileSync(outsideFile, 'utf8').trim() === 'outside-ok', 'outside file written on re-run')
  check(second.sandbox?.intercepted === undefined, 're-run is not marked intercepted')

  // Different outside command still probes.
  const otherFile = join(outside, 'probe2.txt')
  const otherSpec = shell.resolve({
    command: `Set-Content -LiteralPath '${otherFile}' -Value outside-ok`,
    workdir: workspace,
    timeoutMs: 30000,
    sandboxPolicy: policy
  })
  const other = await shell.run(otherSpec)
  check(other.sandbox?.intercepted === true, 'different outside command intercepted separately')
  check(!existsSync(otherFile), 'different outside write did not happen')

  // Background live path: start a confined probe, wait for settlement, then
  // read the one-shot notice from the wrapped process handle.
  const bgFile = join(outside, 'bg-probe.txt')
  const bgSpec = shell.resolve({
    command: `Set-Content -LiteralPath '${bgFile}' -Value outside-ok`,
    workdir: workspace,
    timeoutMs: 30000,
    sandboxPolicy: policy
  })
  const bgProc = shell.start(bgSpec)
  await bgProc.done
  check(bgProc.sandbox?.intercepted === true, 'background outside write intercepted on settlement')
  const bgRead = bgProc.readOutput()
  check(bgRead.delta.includes(selfCheckNoticeMarker('command')), 'background read emits the self-check notice')
  check(bgProc.readOutput().delta === '', 'background notice is one-shot')
  check(!existsSync(bgFile), 'background intercepted write did not happen')

  const bgRetry = shell.start(bgSpec)
  await bgRetry.done
  check(existsSync(bgFile) && readFileSync(bgFile, 'utf8').trim() === 'outside-ok', 'background exact re-run writes with full access')

  // Same-session preset switch: workspace-write turns the plugin gate off and
  // restores the native plain denial; danger-full-access runs untouched.
  const sameSession = sessionMap.get(SESSION)
  sameSession.events.push(
    { type: 'permission/preset', data: { preset: 'workspace-write' } },
    { type: 'sandbox/mode', data: { mode: 'workspace-write' } }
  )
  const sameWwFile = join(outside, 'same-ww.txt')
  const sameWwSpec = shell.resolve({
    command: `Set-Content -LiteralPath '${sameWwFile}' -Value ww`,
    workdir: workspace,
    timeoutMs: 30000,
    sandboxPolicy: { mode: 'workspace-write', workspaceRoot: workspace, sessionId: SESSION }
  })
  const sameWw = await shell.run(sameWwSpec)
  check(sameWw.sandbox?.denied === true && sameWw.sandbox?.intercepted === undefined, 'same session switched to workspace-write keeps plain denial')
  check(!existsSync(sameWwFile), 'same-session workspace-write switch did not write outside')

  sameSession.events.push(
    { type: 'permission/preset', data: { preset: 'danger-full-access' } },
    { type: 'sandbox/mode', data: { mode: 'danger-full-access' } }
  )
  const sameFullFile = join(outside, 'same-full.txt')
  const sameFullSpec = shell.resolve({
    command: `Set-Content -LiteralPath '${sameFullFile}' -Value full`,
    workdir: workspace,
    timeoutMs: 30000,
    sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: workspace, sessionId: SESSION }
  })
  const sameFull = await shell.run(sameFullSpec)
  check(sameFull.exitCode === 0, 'same session switched to full access succeeds')
  check(existsSync(sameFullFile) && readFileSync(sameFullFile, 'utf8').trim() === 'full', 'same-session full-access switch wrote outside')

  // Preset isolation: a normal workspace-write session keeps the native
  // plain-denial path; a danger-full-access session is untouched by the gate.
  const wwFile = join(outside, 'ww.txt')
  const wwSpec = shell.resolve({
    command: `Set-Content -LiteralPath '${wwFile}' -Value ww`,
    workdir: workspace,
    timeoutMs: 30000,
    sandboxPolicy: { mode: 'workspace-write', workspaceRoot: workspace, sessionId: 'ww-s1' }
  })
  const ww = await shell.run(wwSpec)
  check(ww.sandbox?.denied === true && ww.sandbox?.intercepted === undefined, 'workspace-write preset keeps the native plain denial')
  check(!existsSync(wwFile), 'workspace-write preset did not write outside')

  const fullFile = join(outside, 'full.txt')
  const fullSpec = shell.resolve({
    command: `Set-Content -LiteralPath '${fullFile}' -Value full`,
    workdir: workspace,
    timeoutMs: 30000,
    sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: workspace, sessionId: 'full-s1' }
  })
  const full = await shell.run(fullSpec)
  check(full.exitCode === 0, 'danger-full-access preset succeeds')
  check(existsSync(fullFile) && readFileSync(fullFile, 'utf8').trim() === 'full', 'danger-full-access preset wrote outside')
} finally {
  rmSync(base, { recursive: true, force: true })
  try { await root.dispose() } catch { }
}

if (failures > 0) {
  console.error(`\n${failures} LIVE CHECK(S) FAILED`)
  process.exitCode = 1
} else {
  console.log('\nALL LIVE PLUGIN-ROUTE CHECKS PASSED')
}
