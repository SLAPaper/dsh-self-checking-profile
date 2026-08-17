import { FsError } from '@deepseek-ai/dsh-fs'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { FS_SELF_CHECK_FAIL_HINT } from './state.js'

/**
 * Subclass the UPSTREAM filesystem fence instead of shadowing its package.
 * Mutations under the `self-checking` preset probe with the inherited
 * `workspace-write` fence; an outside-workspace denial is recorded once and
 * rethrown as `FS_SELFCHECK_INTERCEPTED` so the native dsh-tool-fs
 * error-mapping passes the marker text through untouched (its `mapError`
 * only rewrites `FS_SANDBOX_DENIED`).
 */
export function makeSelfCheckingFs(runtime) {
  return class SelfCheckingSandboxedFileSystem extends SandboxedFileSystem {
    static inject = SandboxedFileSystem.inject

    constructor(ctx, config) {
      super(ctx, config)
      this.runtime = runtime
    }

    async writeText(target, content, expected, signal, sandboxPolicy) {
      return this.selfCheckMutation('writeText', target, content, expected, signal, sandboxPolicy)
    }

    async editText(target, edit, expected, signal, sandboxPolicy) {
      return this.selfCheckMutation('editText', target, edit, expected, signal, sandboxPolicy)
    }

    async selfCheckMutation(method, target, ...rest) {
      const policy = rest[rest.length - 1]
      const actualPolicy = policy === undefined ? this.ctx.sandboxPolicy.resolve() : policy
      if (!this.runtime.isSelfChecking(actualPolicy)) return super[method](target, ...rest)

      const sessionId = actualPolicy.sessionId
      const key = target.displayPath
      if (sessionId !== undefined && this.runtime.allowed(sessionId, key)) {
        return super[method](target, ...rest.slice(0, -1), { ...actualPolicy, mode: 'danger-full-access' })
      }

      try {
        return await super[method](target, ...rest)
      } catch (error) {
        if (error instanceof FsError && error.code === 'FS_SANDBOX_DENIED') {
          if (sessionId !== undefined) {
            this.runtime.record(sessionId, key)
            throw new FsError(
              `[sandbox: self-check intercepted — this operation accesses a path outside the workspace ("${target.displayPath}"); unless this access is intentional, do not re-run this operation — if it IS intentional, re-run the exact same operation and it will be allowed with full access]`,
              'FS_SELFCHECK_INTERCEPTED',
              { cause: error }
            )
          }
          throw error
        }
        if (error instanceof FsError) {
          throw new FsError(`${error.message}${FS_SELF_CHECK_FAIL_HINT}`, error.code, { cause: error })
        }
        throw error
      }
    }
  }
}
