/**
 * The sandbox POLICY home (`ctx.sandboxPolicy`): the single owner of the
 * deployment's sandbox fallbacks plus per-session resolution: the file-effect
 * {@link SandboxMode}, the `workspace-write` root, and the override kit (the
 * `sandbox/mode` event, its fold, and its write path, from `./session-mode.ts`).
 * Before each agent request, the owner also contributes the resolved policy to
 * the cache-safe runtime-context snapshot. The agent loop logs that snapshot as
 * model history, so replay reconstructs the same mode and root the enforcing
 * consumers resolve without rewriting the stable system prompt.
 *
 * Enforcing filesystem, one-shot bash, and terminal backends read the SAME
 * resolved policy here. The context describes that policy without inventorying
 * capabilities, while each backend retains its own enforcement dialect and each
 * tool owns its operation-specific denial and escalation guidance. The service
 * reads session state once at each operation boundary; executors and providers
 * remain session-free.
 *
 * @module @deepseek-ai/dsh-sandbox-policy
 */
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type SandboxExecutionPolicy, type SandboxMode } from '@deepseek-ai/dsh-sandbox';
import type { Session } from '@deepseek-ai/dsh-session';
export { SANDBOX_MODES, effectiveSandboxMode, setSandboxMode } from './session-mode.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        sandboxPolicy: SandboxPolicyService;
    }
}
/**
 * Plugin config: the deployment's sandbox default. All optional — `Config`
 * supplies the defaults (`mode: 'read-only'` is the fail-safe default; a
 * deployment that wants a workspace-writable agent opts in explicitly). The
 * runner choice is NOT here (it is the `ctx.sandbox` provider's config), nor
 * is any per-family knob: this is the one shared policy home.
 */
export interface Config {
    /** File-sandbox mode a session starts from (default: `read-only`). */
    mode?: SandboxMode;
    /**
     * Fallback root for agentless calls and sessions without a cwd (default:
     * `process.cwd()`). Normal agent calls use their session cwd instead.
     */
    workspaceRoot?: string;
}
/** Inputs that select the sandbox policy for one capability call. */
export interface SandboxPolicyRequest {
    /** Calling session; its immutable cwd becomes the workspace boundary. */
    session?: Session;
    /** Explicit approved mode override, which outranks session policy. */
    mode?: SandboxMode;
}
/**
 * The sandbox-policy service (`ctx.sandboxPolicy`). Owns the deployment
 * default mode, fallback workspace root, and current request-time policy
 * section. Tool layers call {@link resolve} for each execution so a session's
 * mode log and immutable cwd travel together to every enforcing capability.
 */
export declare class SandboxPolicyService extends Service {
    static Config: z<Config>;
    /** The deployment default mode — the fallback beneath a session override. */
    readonly defaultMode: SandboxMode;
    /** The absolute `workspace-write` fallback root for calls without a session cwd. */
    readonly workspaceRoot: string;
    /**
     * Per-session self-checking intercept state: `sessionId` → the set of
     * command/operation keys already intercepted once under `self-checking`
     * mode. A recorded key means the next identical call is the sanctioned
     * re-run and executes with full access. In-memory only: a server restart
     * resets the gate, and entries are dropped when their session is disposed.
     */
    readonly selfCheckIntercepts: Map<string, Set<string>>;
    constructor(ctx: Context, config: Config);
    /**
     * Whether a self-checking key was intercepted earlier in its session — the
     * sanctioned re-run test the bash/pwsh executors and the filesystem fence
     * apply BEFORE their workspace-write probe: an allowed key skips the probe
     * and executes with full access.
     * @param sessionId - the calling session's identity (absent for agentless
     *   calls, which never intercept).
     * @param key - the intercepted command string or resolved target path.
     * @returns whether the identical call already passed the interception.
     */
    selfCheckAllowed(sessionId: unknown, key: string): boolean;
    /**
     * Record one self-checking interception so the identical next call is
     * allowed with full access. Idempotent.
     * @param sessionId - the calling session's identity.
     * @param key - the intercepted command string or resolved target path.
     */
    selfCheckRecord(sessionId: unknown, key: string): void;
    /**
     * Resolve the complete policy for one capability call. An approved explicit
     * mode outranks the session's last `sandbox/mode` event, which outranks the
     * deployment default. A session cwd is its workspace-write boundary; the
     * configured root is the fallback for agentless calls and sessions without a
     * cwd.
     * @param request - optional session and approved mode override.
     * @returns the fully resolved per-call mode and absolute workspace root.
     */
    resolve(request?: SandboxPolicyRequest): SandboxExecutionPolicy;
    /**
     * Read the session override without applying the deployment default.
     * @param session - session whose log supplies the override.
     * @returns the last logged mode, or `undefined` without one.
     */
    overrideOf(session: Session): SandboxMode | undefined;
}
export default SandboxPolicyService;
//# sourceMappingURL=index.d.ts.map