import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'
import { createRuntime, SELF_CHECK_PRESET } from './state.js'
import { makeSelfCheckingShell } from './shell.js'
import { makeSelfCheckingFs } from './fs.js'

export const name = 'dsh-self-checking-spike'

/**
 * The main plugin only owns runtime state. It then mounts replacement
 * SERVICE PROVIDERS as child plugins:
 *   - one `ctx.shell` subclass (pwsh on Windows, bash elsewhere);
 *   - one `ctx.fs` subclass.
 * The bundle patch disables the native `bash-sandbox`, `pwsh-sandbox` and
 * `fs-sandbox` rows, so these subclasses are the only providers.
 */
export const inject = ['sessions']

const SELF_CHECK_CONTEXT = `Self Checking mode is active. Commands and file operations run under workspace-write confinement by default. An operation denied for accessing a path outside the workspace is intercepted with a notice, and a command that runs confined but fails (non-zero exit) may be failing on a sandbox permission issue — in both cases the notice demands a deliberate self-check: re-running the exact same command or operation with full access is sanctioned ONLY when that access is intentional — otherwise do not re-run.`

export function apply(ctx) {
  const runtime = createRuntime()
  runtime.sessions = ctx.sessions

  ctx.on('session/disposed', (session) => runtime.disposeSession(session.id))

  const ShellBase = process.platform === 'win32' ? SandboxPwshExecutor : SandboxBashExecutor
  const ShellPlugin = makeSelfCheckingShell(ShellBase, runtime)
  const FsPlugin = makeSelfCheckingFs(runtime)
  ctx.plugin(ShellPlugin)
  ctx.plugin(FsPlugin)

  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.context({
      name: 'sandbox:self-checking-spike',
      order: 111,
      text: (context) => {
        const session = context.agent?.session
        if (session === undefined) return ''
        try {
          return runtime.currentPreset(session.id) === SELF_CHECK_PRESET
            ? SELF_CHECK_CONTEXT
            : ''
        } catch {
          return ''
        }
      }
    })
  })

  ctx.logger.info('dsh-self-checking-spike: active (subclass service replacement)')
}
