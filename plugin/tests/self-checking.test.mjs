import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'
import { PwshLocalExecutor } from '@deepseek-ai/dsh-pwsh-local'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import {
  FS_SELF_CHECK_FAIL_HINT,
  createRuntime,
  selfCheckFailMarker,
  selfCheckNoticeMarker
} from '../lib/state.js'
import { makeSelfCheckingShell } from '../lib/shell.js'
import { makeSelfCheckingFs } from '../lib/fs.js'

let failures = 0
function check(cond, label) {
  if (cond) console.log(`  ok: ${label}`)
  else { failures += 1; console.error(`  FAIL: ${label}`) }
}

const S1 = 's1'
const selfCheckingEvents = [{ type: 'permission/preset', data: { preset: 'self-checking' } }]
const stubPresetServices = () => ({
  sessions: { get: (id) => id === S1 ? { events: selfCheckingEvents } : undefined }
})

console.log('== 1. runtime gate ==')
{
  const runtime = createRuntime()
  runtime.sessions = stubPresetServices().sessions
  check(runtime.isSelfChecking({ mode: 'workspace-write', sessionId: S1 }) === true, 'workspace-write policy + self-checking preset detected')
  check(runtime.isSelfChecking({ mode: 'workspace-write', sessionId: 'other' }) === false, 'unknown session is not self-checking')
  check(runtime.isSelfChecking({ mode: 'workspace-write' }) === false, 'agentless workspace-write is not self-checking')
  check(runtime.isSelfChecking({ mode: 'danger-full-access', sessionId: S1 }) === false, 'full access bypasses the plugin gate')
  check(runtime.allowed(S1, 'cmd A') === false, 'fresh key not allowed')
  runtime.record(S1, 'cmd A')
  check(runtime.allowed(S1, 'cmd A') === true, 'recorded key allowed')
  runtime.disposeSession(S1)
  check(runtime.allowed(S1, 'cmd A') === false, 'session disposal clears the gate')
}

console.log('== 2. real fs fence via subclass ==')
{
  const runtime = createRuntime()
  runtime.sessions = stubPresetServices().sessions
  const SelfCheckingFs = makeSelfCheckingFs(runtime)
  const base = mkdtempSync(join(homedir(), 'dsh-sc-plugin-'))
  const workspace = join(base, 'workspace')
  const outside = join(base, 'outside')
  mkdirSync(workspace)
  mkdirSync(outside)
  try {
    const ctx = {
      reflect: { provide: () => {} },
      on: () => {},
      inject: () => {},
      get: () => undefined,
      logger: console,
      sandboxPolicy: { defaultMode: 'workspace-write' }
    }
    const fs = new SelfCheckingFs(ctx, { cwd: workspace, diffBasisMaxBytes: 1024 * 1024 })
    const policy = { mode: 'workspace-write', workspaceRoot: workspace, sessionId: S1 }

    const inside = await fs.resolve('inside.txt', { cwd: workspace })
    await fs.writeText(inside, 'hello', undefined, undefined, policy)
    check(readFileSync(join(workspace, 'inside.txt'), 'utf8') === 'hello', 'inside-workspace write passes on first attempt')

    const outTarget = await fs.resolve(join(outside, 'out.txt'), { cwd: workspace })
    let firstError
    try { await fs.writeText(outTarget, 'x', undefined, undefined, policy) } catch (e) { firstError = e }
    check(firstError?.code === 'FS_SELFCHECK_INTERCEPTED', 'outside write intercepted with FS_SELFCHECK_INTERCEPTED')
    console.log('  first outside write:', firstError?.message)
    check(!existsSync(join(outside, 'out.txt')), 'intercepted write did not happen')
    check(runtime.allowed(S1, outTarget.displayPath) === true, 'interception recorded on session')

    await fs.writeText(outTarget, 'y', undefined, undefined, policy)
    check(readFileSync(join(outside, 'out.txt'), 'utf8') === 'y', 'identical re-run allowed with full access')

    const out2 = await fs.resolve(join(outside, 'out2.txt'), { cwd: workspace })
    let agentlessError
    try { await fs.writeText(out2, 'x', undefined, undefined, { mode: 'self-checking', workspaceRoot: workspace }) } catch (e) { agentlessError = e }
    check(agentlessError?.code === 'FS_SANDBOX_DENIED', 'agentless outside write stays a plain denial')

    // Ordinary FsError under the preset gets the defensive hint appended.
    const versioned = await fs.resolve('versioned.txt', { cwd: workspace })
    await fs.writeText(versioned, 'v1', undefined, undefined, policy)
    let ordinaryError
    try { await fs.writeText(versioned, 'v2', { kind: 'createIfAbsent' }, undefined, policy) } catch (e) { ordinaryError = e }
    check(ordinaryError !== undefined && ordinaryError.message.includes(FS_SELF_CHECK_FAIL_HINT.trim()), 'ordinary fs failure carries the self-check hint')
    console.log('  ordinary failure:', ordinaryError?.message?.slice(0, 160))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

console.log('== 3. pwsh executor surface (stubbed object) ==')
{
  const runtime = createRuntime()
  runtime.sessions = stubPresetServices().sessions
  const SelfCheckingPwsh = makeSelfCheckingShell(SandboxPwshExecutor, runtime)
  const exec = Object.create(SelfCheckingPwsh.prototype)
  exec.ctx = {}
  exec.runtime = runtime
  exec.selfCheckProcs = new Map()
  exec.processFacts = new Map()

  let unconfinedRuns = 0
  let unconfinedStarts = 0
  const originalRun = PwshLocalExecutor.prototype.run
  const originalStart = PwshLocalExecutor.prototype.start
  PwshLocalExecutor.prototype.run = async function () {
    unconfinedRuns += 1
    return { exitCode: 0, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false }, timedOut: false, signal: null, timeoutMs: 0 }
  }
  PwshLocalExecutor.prototype.start = function () {
    unconfinedStarts += 1
    return 'full-proc'
  }

  exec.confine = (_spec, policy) => ({
    argv: ['node', 'runner', '--mode', policy.mode, '--', _spec.command],
    enforcement: 'partial',
    denialSignatures: ['access is denied', 'access to the path', 'permission denied'],
    runnerFailureRules: []
  })
  exec.runArgv = async (_spec, argv) => ({
    exitCode: 1,
    stdout: { text: '', truncated: false },
    stderr: { text: 'Access is denied', truncated: false },
    timedOut: false,
    signal: null,
    timeoutMs: 0,
    argv
  })
  exec.startArgv = (_spec, argv) => ({
    status: 'running',
    exitCode: 1,
    signal: null,
    done: Promise.resolve(),
    readOutput: () => ({ delta: '', lossy: false }),
    argv
  })

  const spec = { command: 'Copy-Item C:\outside C:\work' }
  const policy = { mode: 'workspace-write', workspaceRoot: 'C:\work', sessionId: S1 }

  try {
    // First run: probe under workspace-write, denied -> notice baked into stdout.
    const first = await exec.run({ ...spec, sandboxPolicy: policy })
    check(first.sandbox.mode === 'self-checking', 'probe result reports self-checking mode')
    check(first.sandbox.intercepted === true, 'first run stamped intercepted')
    check(first.sandbox.denied === false, 'native renderer must not emit a generic denial marker')
    check(first.stdout.text.includes(selfCheckNoticeMarker('command')), 'notice marker baked into model-facing stdout')
    check(first.stderr.text === '', 'stderr cleared so the native renderer cannot duplicate it')
    check(runtime.allowed(S1, spec.command) === true, 'interception recorded with session+command key')
    check(unconfinedRuns === 0, 'first run never ran unconfined')

    // Identical re-run: full access.
    const second = await exec.run({ ...spec, sandboxPolicy: policy })
    check(second.sandbox.intercepted === undefined, 're-run not marked intercepted')
    check(second.sandbox.denied === false, 're-run not denied')
    check(unconfinedRuns === 1, 're-run executed unconfined')

    // A different command still probes.
    const other = await exec.run({ command: 'Remove-Item C:\other', sandboxPolicy: policy })
    check(other.sandbox.intercepted === true, 'different command intercepted separately')

    // Agentless direct self-checking policy: plain denial, no escape hatch.
    const agentless = await exec.run({ command: spec.command, sandboxPolicy: { mode: 'self-checking', workspaceRoot: 'C:\work' } })
    check(agentless.sandbox.denied === true && agentless.sandbox.intercepted === undefined, 'agentless probe stays a plain denial')
    // pwsh exit-0 denial: relaxed stderr matching still intercepts.
    exec.runArgv = async (_spec, argv) => ({
      exitCode: 0,
      stdout: { text: '', truncated: false },
      stderr: { text: "Set-Content : Access to the path 'C:\outside\f.txt' is denied.", truncated: false },
      timedOut: false, signal: null, timeoutMs: 0, argv
    })
    const zeroExit = await exec.run({ command: 'Set-Content -LiteralPath C:\outside\f.txt -Value hi', sandboxPolicy: policy })
    check(zeroExit.sandbox.intercepted === true, 'exit-0 denial still intercepted')

    // Confined failure path: probe passes, exits non-zero -> fail notice + record.
    exec.runArgv = async (_spec, argv) => ({
      exitCode: 2,
      stdout: { text: '', truncated: false },
      stderr: { text: 'schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS', truncated: false },
      timedOut: false, signal: null, timeoutMs: 0, argv
    })
    const failRun = await exec.run({ command: 'git push origin main', sandboxPolicy: policy })
    check(failRun.sandbox.failed === true, 'confined failure stamped failed')
    check(failRun.stdout.text.includes(selfCheckFailMarker('command')), 'fail marker baked into stdout')
    check(runtime.allowed(S1, 'git push origin main') === true, 'failure recorded on session')

    // Background path: probe start carries facts; settlement records and stamps.
    exec.runArgv = async (_spec, argv) => ({
      exitCode: 1,
      stdout: { text: '', truncated: false },
      stderr: { text: 'Access is denied', truncated: false },
      timedOut: false, signal: null, timeoutMs: 0, argv
    })
    const bgPolicy = { mode: 'workspace-write', workspaceRoot: 'C:\work', sessionId: S1 }
    const probeProc = exec.start({ command: 'bg-cmd', sandboxPolicy: bgPolicy })
    check(probeProc !== 'full-proc', 'probe start returns a confined process handle')
    check(exec.selfCheckProcs.get(probeProc)?.key === 'bg-cmd', 'facts carry the command key')
    exec.onProcessDone(probeProc, "New-Item : Access to the path 'C:\outside' is denied.", false, undefined)
    check(probeProc.sandbox.intercepted === true, 'background denial stamped intercepted')
    check(probeProc.readOutput().delta.includes(selfCheckNoticeMarker('command')), 'background notice emitted once')
    check(probeProc.readOutput().delta === '', 'background notice is not duplicated')
    check(runtime.allowed(S1, 'bg-cmd') === true, 'background interception recorded')

    // Allowed background command starts unconfined.
    const allowedProc = exec.start({ command: 'bg-cmd', sandboxPolicy: bgPolicy })
    check(allowedProc === 'full-proc', 'allowed background command starts unconfined')
    check(unconfinedStarts === 1, 'unconfined start used the local executor')

    // Background fail path.
    const failProc = exec.start({ command: 'bg-fail', sandboxPolicy: bgPolicy })
    exec.onProcessDone(failProc, 'SEC_E_NO_CREDENTIALS (0x8009030e)', false, undefined)
    check(failProc.sandbox.failed === true, 'background failure stamped failed')
    check(failProc.readOutput().delta.includes(selfCheckFailMarker('command')), 'background fail notice emitted')
    check(runtime.allowed(S1, 'bg-fail') === true, 'background failure recorded')
  } finally {
    PwshLocalExecutor.prototype.run = originalRun
    PwshLocalExecutor.prototype.start = originalStart
  }
}

console.log('== 4. both platform executors subclass cleanly ==')
{
  const runtime = createRuntime()
  check(typeof makeSelfCheckingShell(SandboxBashExecutor, runtime).prototype.run === 'function', 'bash subclass has run')
  check(typeof makeSelfCheckingShell(SandboxPwshExecutor, runtime).prototype.start === 'function', 'pwsh subclass has start')
  check(typeof makeSelfCheckingFs(runtime).prototype.writeText === 'function', 'fs subclass has writeText')
}

if (failures > 0) {
  console.error(`\n${failures} CHECK(S) FAILED`)
  process.exitCode = 1
} else {
  console.log('\nALL PLUGIN-ROUTE CHECKS PASSED')
}
