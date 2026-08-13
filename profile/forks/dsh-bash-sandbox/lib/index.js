import { SandboxUnavailableError } from "@deepseek-ai/dsh-sandbox";
import { LocalBashExecutor } from "@deepseek-ai/dsh-bash-local";
import { accessSync, constants, statSync } from "node:fs";
//#region lib/types/helpers.js
/**
* Internal sandbox-result classification helpers.
*
* @module @deepseek-ai/dsh-bash-sandbox/helpers
*/
/** Node-local spawn codes proven to identify executable resolution or permission failure. */
const EXECUTABLE_SPAWN_CODES = new Set(["EACCES", "ENOENT"]);
/** Whether the caller-owned spawn cwd can be entered. */
function isUsableWorkdir(path) {
	try {
		if (!statSync(path).isDirectory()) return false;
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
/**
* Attribute only Node ENOENT/EACCES failures whose error path equals argv[0]
* after independently ruling out the caller-owned cwd. A supplied error path
* must exactly identify the runner; without one, the syscall must. With a
* usable cwd, these codes describe resolution or execute permission for that
* argv[0] or its shebang interpreter.
* The workdir is checked at classification time, not atomically with spawn;
* concurrent path replacement may change attribution but cannot permit an
* unconfined execution.
* @param error - the original spawn rejection.
* @param runnerProgram - provider argv[0], the executable that establishes confinement.
* @param workdir - the caller-owned spawn cwd, checked independently for usability.
* @returns whether the rejection has executable-specific runner evidence.
*/
function isRunnerSpawnFailure(error, runnerProgram, workdir) {
	if (runnerProgram === void 0 || !isUsableWorkdir(workdir)) return false;
	if (typeof error !== "object" || error === null) return false;
	const { code, path, syscall } = error;
	if (typeof code !== "string" || !EXECUTABLE_SPAWN_CODES.has(code)) return false;
	if (typeof syscall !== "string") return false;
	const exactSyscall = `spawn ${runnerProgram}`;
	if (path === void 0) return syscall === exactSyscall;
	if (typeof path !== "string" || path.length === 0 || path !== runnerProgram) return false;
	return syscall === "spawn" || syscall === exactSyscall;
}
/**
* Classify a failed run against the selected backend's denial dialect.
* @param result - settled foreground run.
* @param signatures - case-insensitive denial substrings from the active wrap.
* @returns whether the failed run matches that denial dialect.
*/
function classifyDenial(result, signatures) {
	return matchesSignature(result.exitCode, result.stderr.text, signatures);
}
/**
* Classify one settled process against the selected backend's structured
* runner-failure rules. Each rule requires a nonzero exit, its optional
* exit-code gate, and a fatal signature on one stderr line after exact
* informational lines are excluded.
* @param exitCode - process exit code; null means signal termination.
* @param stderr - collected stderr text, left unchanged.
* @param rules - structured runner-failure rules from the active wrap.
* @returns the first matching fatal line, or undefined when evidence is insufficient.
*/
function classifyRunnerFailure(exitCode, stderr, rules) {
	if (exitCode === null || exitCode === 0) return void 0;
	const lines = stderr.split(/\r?\n/);
	for (const rule of rules) {
		if (rule.allowedExitCodes !== void 0 && !rule.allowedExitCodes.includes(exitCode)) continue;
		const informationalLines = new Set((rule.informationalLines ?? []).map((line) => line.toLowerCase()));
		const fatalSignatures = rule.fatalSignatures.filter((signature) => signature.trim().length > 0).map((signature) => signature.toLowerCase());
		for (const line of lines) {
			const lowered = line.toLowerCase();
			if (informationalLines.has(lowered)) continue;
			if (fatalSignatures.some((signature) => lowered.includes(signature))) return { detail: line };
		}
	}
}
/**
* Match a non-zero exit against case-insensitive stderr signatures.
* @param exitCode - process exit code; null means signal termination.
* @param stderr - collected stderr text.
* @param signatures - substrings identifying the selected backend's dialect.
* @returns whether this is a non-zero exit whose stderr matches a signature.
*/
function matchesSignature(exitCode, stderr, signatures) {
	if (exitCode === null || exitCode === 0) return false;
	const lowered = stderr.toLowerCase();
	return signatures.some((signature) => lowered.includes(signature.toLowerCase()));
}
/**
* Match stderr against the backend's denial signatures WITHOUT the exit-code
* gate — the self-checking probe rule (the pwsh twin of this executor may
* surface a denied file effect as a non-terminating error with a ZERO exit,
* so the probe that must catch exactly those denials cannot require a nonzero
* status; the standing modes keep the strict gate).
* @param stderr - collected stderr text.
* @param signatures - substrings identifying the selected backend's dialect.
* @returns whether the stderr matches a denial signature.
*/
function matchesDenialStderr(stderr, signatures) {
	const lowered = stderr.toLowerCase();
	return signatures.some((signature) => lowered.includes(signature.toLowerCase()));
}
//#endregion
//#region lib/types/index.js
/**
* Sandbox-consuming bash executor. It wraps the exact local bash argv through
* `ctx.sandbox`, inherits local process mechanics, and reports the selected
* mode, enforcement, and denial facts. Positive runner-launch evidence means
* the command never ran: foreground calls throw `SANDBOX_UNAVAILABLE`, while
* background processes carry `runnerFailed`; other spawn rejections retain
* local-executor semantics. The tool owns approval and passes a complete per-call policy.
* @module @deepseek-ai/dsh-bash-sandbox
*/
/**
* Registers as `ctx.shell` in place of the local executor and requires a
* `ctx.sandbox` provider plus `ctx.sandboxPolicy`; the tool layer is
* unchanged. Tool calls pass the calling session's resolved policy; direct
* calls fall back to deployment policy. `result.sandbox` reports the mode and
* enforcement actually used.
*/
var SandboxBashExecutor = class extends LocalBashExecutor {
	static inject = [
		"subprocess",
		"sandbox",
		"sandboxPolicy"
	];
	mode;
	/**
	* Per-process confinement facts retained until settlement. Providers may
	* vary enforcement and diagnostic dialect between overlapping calls, so a
	* shared latest-wrap value would classify a process against the wrong facts.
	* Unconfined processes have no entry.
	*/
	processFacts = /* @__PURE__ */ new Map();
	constructor(ctx, config) {
		super(ctx, config);
		this.mode = ctx.sandboxPolicy.defaultMode;
	}
	/** The configured default mode — the capability fact the tool layer reads. */
	get sandboxMode() {
		return this.mode;
	}
	/**
	* Stamp a complete per-call policy onto the spec. Tool calls supply the
	* calling session's resolved mode and root; lower-level callers fall back to
	* the deployment policy.
	*/
	resolve(request) {
		return {
			...super.resolve(request),
			sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
		};
	}
	async run(spec) {
		const policy = spec.sandboxPolicy;
		const { mode } = policy;
		if (mode === "danger-full-access") return {
			...await super.run(spec),
			sandbox: {
				mode,
				denied: false
			}
		};
		if (mode === "self-checking") return this.runSelfChecking(spec, policy);
		return this.runConfined(spec, {
			...policy,
			mode
		});
	}
	/**
	* The `self-checking` execution path: an already-intercepted command (the
	* sanctioned re-run) executes unconfined with full access; any other
	* command first probes under `workspace-write`. A probe denied for touching
	* paths outside the workspace is the one-time INTERCEPTION: the key is
	* recorded on the calling session and the result carries `intercepted` so
	* the tool layer renders the re-run notice instead of a plain denial. An
	* agentless call has no session to record on: its probe stays a plain
	* denial with no escape hatch.
	* @param spec - the resolved execution spec.
	* @param policy - the self-checking policy stamped onto the call.
	* @returns the settled result with `sandbox.mode: "self-checking"`.
	*/
	async runSelfChecking(spec, policy) {
		const sessionId = policy.sessionId;
		const key = spec.command;
		if (sessionId === void 0 || !this.ctx.sandboxPolicy.selfCheckAllowed(sessionId, key)) {
			const probe = await this.runProbe(spec, {
				...policy,
				mode: "workspace-write"
			});
			const intercepted = probe.denied && sessionId !== void 0;
			if (intercepted) this.ctx.sandboxPolicy.selfCheckRecord(sessionId, key);
			return {
				...probe.result,
				sandbox: {
					mode: "self-checking",
					denied: probe.denied,
					...probe.result.sandbox.enforcement !== void 0 ? { enforcement: probe.result.sandbox.enforcement } : {},
					...intercepted ? { intercepted: true } : {}
				}
			};
		}
		return {
			...await super.run(spec),
			sandbox: {
				mode: "self-checking",
				denied: false
			}
		};
	}
	/**
	* Run one workspace-write probe and settle it with the probe's relaxed
	* denial rule ({@link matchesDenialStderr}): a file effect a shell reports
	* as a non-terminating error (a denied write with a zero exit, e.g. a pwsh
	* twin's `Set-Content`) would slip past the exit gate the standing modes
	* apply — the probe must catch exactly those denials. Runner failures keep
	* their fail-closed throw.
	* @param spec - the resolved execution spec.
	* @param policy - the confined probe policy (mode `workspace-write`).
	* @returns the settled result plus the probe's denial verdict.
	*/
	async runProbe(spec, policy) {
		const { mode } = policy;
		const confined = this.confine(spec.command, {
			...policy,
			mode
		});
		let result;
		try {
			result = await this.runArgv(spec, confined.argv);
		} catch (error) {
			if (spec.signal?.aborted === true) spec.signal.throwIfAborted();
			if (isRunnerSpawnFailure(error, confined.argv[0], spec.workdir)) throw new SandboxUnavailableError(mode, String(error));
			throw error;
		}
		const runnerFailure = classifyRunnerFailure(result.exitCode, result.stderr.text, confined.runnerFailureRules);
		if (runnerFailure !== void 0) throw new SandboxUnavailableError(mode, runnerFailure.detail);
		const denied = matchesDenialStderr(result.stderr.text, confined.denialSignatures);
		return {
			result: {
				...result,
				sandbox: {
					mode,
					denied,
					enforcement: confined.enforcement
				}
			},
			denied
		};
	}
	/** The shared confined-run machinery (the standing confined modes and the self-checking probe). */
	async runConfined(spec, policy) {
		const { mode } = policy;
		const confined = this.confine(spec.command, {
			...policy,
			mode
		});
		let result;
		try {
			result = await this.runArgv(spec, confined.argv);
		} catch (error) {
			if (spec.signal?.aborted === true) spec.signal.throwIfAborted();
			if (isRunnerSpawnFailure(error, confined.argv[0], spec.workdir)) throw new SandboxUnavailableError(mode, String(error));
			throw error;
		}
		const runnerFailure = classifyRunnerFailure(result.exitCode, result.stderr.text, confined.runnerFailureRules);
		if (runnerFailure !== void 0) throw new SandboxUnavailableError(mode, runnerFailure.detail);
		return {
			...result,
			sandbox: {
				mode,
				denied: classifyDenial(result, confined.denialSignatures),
				enforcement: confined.enforcement
			}
		};
	}
	start(spec) {
		const policy = spec.sandboxPolicy;
		const { mode } = policy;
		if (mode === "danger-full-access") return super.start(spec);
		if (mode === "self-checking") return this.startSelfChecking(spec, policy);
		const confined = this.confine(spec.command, {
			...policy,
			mode
		});
		let proc;
		try {
			proc = this.startArgv(spec, confined.argv);
		} catch (error) {
			if (isRunnerSpawnFailure(error, confined.argv[0], spec.workdir)) throw new SandboxUnavailableError(mode, String(error));
			throw error;
		}
		const { enforcement, denialSignatures, runnerFailureRules } = confined;
		this.processFacts.set(proc, {
			mode,
			enforcement,
			denialSignatures,
			runnerFailureRules,
			runnerProgram: confined.argv[0],
			workdir: spec.workdir
		});
		return proc;
	}
	/**
	* The `self-checking` background path: an already-intercepted command
	* starts unconfined; any other command probes under `workspace-write`, with
	* the calling session and command key carried on its process facts so a
	* denied settlement records the interception and stamps `intercepted` for
	* the job-output renderer (see {@link onProcessDone}).
	*/
	startSelfChecking(spec, policy) {
		const sessionId = policy.sessionId;
		const key = spec.command;
		if (sessionId === void 0 || this.ctx.sandboxPolicy.selfCheckAllowed(sessionId, key)) return super.start(spec);
		const confined = this.confine(spec.command, {
			...policy,
			mode: "workspace-write"
		});
		let proc;
		try {
			proc = this.startArgv(spec, confined.argv);
		} catch (error) {
			if (isRunnerSpawnFailure(error, confined.argv[0], spec.workdir)) throw new SandboxUnavailableError("workspace-write", String(error));
			throw error;
		}
		const { enforcement, denialSignatures, runnerFailureRules } = confined;
		this.processFacts.set(proc, {
			mode: "self-checking",
			sessionId,
			selfCheckKey: key,
			enforcement,
			denialSignatures,
			runnerFailureRules,
			runnerProgram: confined.argv[0],
			workdir: spec.workdir
		});
		return proc;
	}
	/**
	* Stamp per-process sandbox facts before `done` settles. Full-access
	* processes have no facts; signal deaths are not denials. A denied
	* self-checking probe records the interception on its session (idempotent)
	* and stamps `intercepted` so the tool renders the re-run notice.
	*/
	onProcessDone(proc, stderr, spawnFailed, spawnError) {
		const facts = this.processFacts.get(proc);
		if (facts !== void 0) {
			this.processFacts.delete(proc);
			const runnerFailed = spawnFailed ? isRunnerSpawnFailure(spawnError, facts.runnerProgram, facts.workdir) : classifyRunnerFailure(proc.exitCode, stderr, facts.runnerFailureRules) !== void 0;
			const denied = !runnerFailed && (facts.selfCheckKey !== void 0 ? matchesDenialStderr(stderr, facts.denialSignatures) : matchesSignature(proc.exitCode, stderr, facts.denialSignatures));
			let intercepted = false;
			if (denied && facts.selfCheckKey !== void 0 && facts.sessionId !== void 0) {
				this.ctx.sandboxPolicy.selfCheckRecord(facts.sessionId, facts.selfCheckKey);
				intercepted = true;
			}
			proc.sandbox = {
				mode: facts.mode,
				denied,
				enforcement: facts.enforcement,
				...runnerFailed ? { runnerFailed } : {},
				...intercepted ? { intercepted: true } : {}
			};
		}
		super.onProcessDone(proc, stderr, spawnFailed, spawnError);
	}
	/**
	* Wrap one shell command via the `ctx.sandbox` provider. Provider errors
	* propagate unchanged; the returned argv is handed directly to the local
	* executor's subprocess path.
	* @param command - shell source for the confined inner `bash -c`.
	* @param policy - resolved confined execution policy.
	* @returns the provider's exact argv and settlement-classification facts.
	*/
	confine(command, policy) {
		return this.ctx.sandbox.confine([
			"bash",
			"-c",
			command
		], policy);
	}
};
//#endregion
export { SandboxBashExecutor, SandboxBashExecutor as default };
