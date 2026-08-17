import {
  SELF_CHECK_DENIAL_SIGNATURES,
  matchesDenialStderr,
  selfCheckFailMarker,
  selfCheckNoticeMarker
} from './state.js'

/** The tool layer appends truncation notices at render time; reproduce that here. */
function streamText(output) {
  if (!output?.truncated) return output?.text ?? ''
  return `${output.text ?? ''}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`
}

/** Rebuild the exact model-facing body the native bash/pwsh renderer would show. */
function renderFullBody(result) {
  const out = streamText(result.stdout)
  const err = streamText(result.stderr)
  let body = out
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  return body
}

function appendNotice(body, notice) {
  if (body.length > 0 && !body.endsWith('\n')) body += '\n'
  return body + notice
}

/**
 * The native tool renderer does not know the spike's `intercepted`/`failed`
 * facts (we intentionally did not fork dsh-tool-bash/pwsh). Bake the notice
 * into stdout text instead and clear stderr so the native renderer does not
 * emit a generic denial marker.
 */
function resultWithNotice(result, notice, flags) {
  return {
    ...result,
    stdout: {
      text: appendNotice(renderFullBody(result), notice),
      truncated: false
    },
    stderr: {
      text: '',
      truncated: false
    },
    sandbox: selfCheckSandbox(result.sandbox, flags)
  }
}

function selfCheckSandbox(previous = {}, flags = {}) {
  return {
    mode: 'self-checking',
    denied: false,
    ...previous?.enforcement !== undefined ? { enforcement: previous.enforcement } : {},
    ...flags
  }
}

/**
 * Subclass the UPSTREAM sandbox executor instead of shadowing its package.
 *
 * The preset's standing sandbox mode is `workspace-write`; when the runtime
 * says the session is in the `self-checking` preset, this subclass adds the
 * intercept-once / exact-retry-full-access choreography around the inherited
 * implementation. The subclass itself has no service dependency on
 * `permissionPresets` or `sessions` (avoiding a service cycle); it reads the
 * preset through the shared runtime object.
 */
export function makeSelfCheckingShell(BaseExecutor, runtime, subject = 'command') {
  return class SelfCheckingShellExecutor extends BaseExecutor {
    static inject = BaseExecutor.inject

    /** proc -> { sessionId, key }, live only until settlement. */
    selfCheckProcs = new Map()

    constructor(ctx, config) {
      super(ctx, config)
      this.runtime = runtime
    }

    async run(spec) {
      const policy = spec.sandboxPolicy
      if (!this.runtime.isSelfChecking(policy)) return super.run(spec)
      return this.runSelfChecking(spec, policy)
    }

    async runSelfChecking(spec, policy) {
      const sessionId = policy.sessionId
      const key = spec.command
      if (sessionId !== undefined && this.runtime.allowed(sessionId, key)) {
        const full = await super.run({
          ...spec,
          sandboxPolicy: { ...policy, mode: 'danger-full-access' }
        })
        return {
          ...full,
          sandbox: selfCheckSandbox(full.sandbox)
        }
      }

      const probe = await super.run({
        ...spec,
        sandboxPolicy: { ...policy, mode: 'workspace-write' }
      })
      const denied = matchesDenialStderr(probe.stderr?.text ?? '', SELF_CHECK_DENIAL_SIGNATURES)
      if (denied) {
        if (sessionId === undefined) {
          // Agentless self-checking calls keep a plain denial (no escape hatch).
          return {
            ...probe,
            sandbox: { ...probe.sandbox, mode: 'self-checking', denied: true }
          }
        }
        this.runtime.record(sessionId, key)
        return resultWithNotice(probe, selfCheckNoticeMarker(subject), { intercepted: true })
      }

      const failed = probe.exitCode !== 0
      if (failed && sessionId !== undefined) this.runtime.record(sessionId, key)
      if (failed) {
        return resultWithNotice(probe, selfCheckFailMarker(subject), { failed: true })
      }
      return {
        ...probe,
        sandbox: selfCheckSandbox(probe.sandbox)
      }
    }

    start(spec) {
      const policy = spec.sandboxPolicy
      if (!this.runtime.isSelfChecking(policy)) return super.start(spec)
      return this.startSelfChecking(spec, policy)
    }

    startSelfChecking(spec, policy) {
      const sessionId = policy.sessionId
      const key = spec.command
      if (sessionId !== undefined && this.runtime.allowed(sessionId, key)) {
        return super.start({
          ...spec,
          sandboxPolicy: { ...policy, mode: 'danger-full-access' }
        })
      }

      const proc = super.start({
        ...spec,
        sandboxPolicy: { ...policy, mode: 'workspace-write' }
      })
      this.selfCheckProcs.set(proc, { sessionId, key })

      let noticeEmitted = false
      const originalReadOutput = proc.readOutput.bind(proc)
      proc.readOutput = () => {
        const read = originalReadOutput()
        const notice = proc.sandbox?.intercepted === true
          ? selfCheckNoticeMarker(subject)
          : proc.sandbox?.failed === true
            ? selfCheckFailMarker(subject)
            : ''
        if (notice === '' || noticeEmitted) return read
        noticeEmitted = true
        return {
          ...read,
          delta: appendNotice(read.delta, notice)
        }
      }
      return proc
    }

    /**
     * Relaxed settlement for self-checking probes. The upstream
     * implementation's strict exit-code gate is deliberately bypassed here,
     * exactly like the fork layer's `runProbe`: a pwsh non-terminating file
     * error exits 0 with the denial on stderr and must still intercept.
     */
    onProcessDone(proc, stderr, spawnFailed, spawnError) {
      const facts = this.selfCheckProcs.get(proc)
      if (facts === undefined) return super.onProcessDone(proc, stderr, spawnFailed, spawnError)
      this.selfCheckProcs.delete(proc)

      super.onProcessDone(proc, stderr, spawnFailed, spawnError)
      const settled = proc.sandbox ?? {}
      const runnerFailed = settled.runnerFailed === true
      const denied = !runnerFailed && matchesDenialStderr(stderr, SELF_CHECK_DENIAL_SIGNATURES)

      let intercepted = false
      let failed = false
      if (facts.sessionId !== undefined) {
        if (denied) {
          this.runtime.record(facts.sessionId, facts.key)
          intercepted = true
        } else if (!runnerFailed && proc.exitCode !== 0) {
          this.runtime.record(facts.sessionId, facts.key)
          failed = true
        }
      }
      proc.sandbox = selfCheckSandbox(settled, {
        ...denied && facts.sessionId === undefined ? { denied: true } : {},
        ...runnerFailed ? { runnerFailed } : {},
        ...intercepted ? { intercepted: true } : {},
        ...failed ? { failed: true } : {}
      })
    }
  }
}
