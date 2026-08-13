// Isolated verification of the self-checking sandbox mode changes.
// Imports the EDITED modules fresh (a separate process, so it exercises the
// new code without touching the running harness), then exercises:
//  1. the mode vocabulary (WIDER_MODES / ESCALATION_TARGETS / SANDBOX_MODES)
//  2. the per-session intercept gate on SandboxPolicyService
//  3. the rendered policy-context text
//  4. the REAL filesystem fence (SandboxedFileSystem): inside-workspace write
//     passes, outside-workspace write is intercepted once (FS_SELFCHECK_INTERCEPTED),
//     the identical re-run is allowed with full access, agentless stays denied.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Resolution bases, overridable:
//   DSH_SC_FORKS    - the fork layer to test (default: the installed
//                     "self-checking" profile). The repo's own profile/forks
//                     cannot be imported directly from this workspace — the
//                     forks' undeclared dependencies (cordis etc.) resolve via
//                     the node_modules parent walk, which must reach the dsh
//                     shared fallback (~/.dsh/profiles/node_modules).
//   DSH_SC_UPSTREAM - the pristine @deepseek-ai install for non-forked imports
//                     (default: the DSH_HOME shared fallback)
const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const FORK_ROOT = process.env.DSH_SC_FORKS ?? join(dshHome, "profiles", "self-checking", "node_modules", "@deepseek-ai");
const CACHE_ROOT = process.env.DSH_SC_UPSTREAM ?? join(dshHome, "profiles", "node_modules", "@deepseek-ai");
const load = (pkg, root = FORK_ROOT) => import(pathToFileURL(join(root, pkg, "lib/index.js")).href);

let failures = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ok: ${label}`); }
  else { failures += 1; console.error(`  FAIL: ${label}`); }
}

// The 8 forked packages come from the profile's fork layer; dsh-pwsh-local is
// NOT forked and comes from the pristine install (the same instance the fork
// resolves through the node_modules parent-walk).
const sandbox = await load("dsh-sandbox");
const policyMod = await load("dsh-sandbox-policy");
const fsSandbox = await load("dsh-fs-sandbox");
const pwshSandbox = await load("dsh-pwsh-sandbox");
const bashSandbox = await load("dsh-bash-sandbox");
const pwshLocal = await load("dsh-pwsh-local", CACHE_ROOT);

console.log("== 1. vocabulary ==");
assert(sandbox.WIDER_MODES["read-only"].includes("self-checking"), "read-only may escalate to self-checking");
assert(sandbox.WIDER_MODES["workspace-write"].includes("self-checking"), "workspace-write may escalate to self-checking");
assert(JSON.stringify(sandbox.WIDER_MODES["self-checking"]) === JSON.stringify(["danger-full-access"]), "self-checking escalates only to danger-full-access");
assert(sandbox.ESCALATION_TARGETS.includes("self-checking"), "ESCALATION_TARGETS includes self-checking");
assert(policyMod.SANDBOX_MODES.includes("self-checking"), "SANDBOX_MODES includes self-checking");
console.log("  targets:", sandbox.ESCALATION_TARGETS.join(", "));
console.log("  notice:", sandbox.selfCheckNoticeMarker("command"));

console.log("== 2. per-session gate ==");
let capturedContext;
const stubCtx = {
  reflect: { provide: () => {} },
  on: () => {},
  inject: (fields, cb) => {
    if (fields.includes("systemPrompt")) cb({ systemPrompt: { context: (def) => { capturedContext = def; } } });
  },
  logger: console
};
const service = new policyMod.SandboxPolicyService(stubCtx, { mode: "self-checking", workspaceRoot: process.cwd() });
assert(service.defaultMode === "self-checking", "service default mode is self-checking");
assert(service.selfCheckAllowed("s1", "cmd A") === false, "fresh key not allowed");
service.selfCheckRecord("s1", "cmd A");
assert(service.selfCheckAllowed("s1", "cmd A") === true, "recorded key allowed (the sanctioned re-run)");
assert(service.selfCheckAllowed("s2", "cmd A") === false, "other session unaffected");
service.selfCheckRecord("s1", "cmd A");
assert(service.selfCheckAllowed("s1", "cmd A") === true, "record is idempotent");

console.log("== 3. policy context text ==");
const fakeSession = {
  events: [{ type: "sandbox/mode", data: { mode: "self-checking" } }],
  header: { cwd: process.cwd() }
};
const text = capturedContext.text({ agent: { session: fakeSession } });
console.log("  ", text);
assert(text.includes("Current DSH file policy: self-checking"), "context announces self-checking");
assert(text.includes("re-running the exact same command or operation executes it with full access"), "context teaches the re-run continuation");

console.log("== 4. real fs fence ==");
const base = mkdtempSync(join(process.env.DSH_SC_FENCE_DIR ?? homedir(), "dsh-sc-verify-"));
const workspace = join(base, "workspace");
const outside = join(base, "outside");
mkdirSync(workspace);
mkdirSync(outside);
try {
  const gate = {
    selfCheckAllowed: (id, key) => service.selfCheckAllowed(id, key),
    selfCheckRecord: (id, key) => service.selfCheckRecord(id, key)
  };
  const fs = new fsSandbox.SandboxedFileSystem(
    { sandboxPolicy: { defaultMode: "self-checking", ...gate }, get: () => undefined, logger: console, reflect: { provide: () => {} } },
    { cwd: workspace, diffBasisMaxBytes: 1024 * 1024 }
  );
  const policy = { mode: "self-checking", workspaceRoot: workspace, sessionId: "s1" };

  const inside = await fs.resolve("inside.txt", { cwd: workspace });
  await fs.writeText(inside, "hello", undefined, undefined, policy);
  assert(readFileSync(join(workspace, "inside.txt"), "utf8") === "hello", "inside-workspace write passes on first attempt");

  const outTarget = await fs.resolve(join(outside, "out.txt"), { cwd: workspace });
  let firstError;
  try {
    await fs.writeText(outTarget, "x", undefined, undefined, policy);
  } catch (e) { firstError = e; }
  assert(firstError?.code === "FS_SELFCHECK_INTERCEPTED", "outside write intercepted with FS_SELFCHECK_INTERCEPTED");
  console.log("  first outside write:", firstError.message);
  assert(!existsSync(join(outside, "out.txt")), "intercepted write did not happen");
  assert(service.selfCheckAllowed("s1", outTarget.displayPath) === true, "interception recorded on session");

  await fs.writeText(outTarget, "y", undefined, undefined, policy);
  assert(readFileSync(join(outside, "out.txt"), "utf8") === "y", "identical re-run allowed with full access");

  let agentlessError;
  const out2 = await fs.resolve(join(outside, "out2.txt"), { cwd: workspace });
  try {
    await fs.writeText(out2, "x", undefined, undefined, { mode: "self-checking", workspaceRoot: workspace });
  } catch (e) { agentlessError = e; }
  assert(agentlessError?.code === "FS_SANDBOX_DENIED", "agentless outside write stays a plain denial");

  let wwError;
  const out3 = await fs.resolve(join(outside, "out3.txt"), { cwd: workspace });
  try {
    await fs.writeText(out3, "x", undefined, undefined, { mode: "workspace-write", workspaceRoot: workspace });
  } catch (e) { wwError = e; }
  assert(wwError?.code === "FS_SANDBOX_DENIED", "workspace-write mode unchanged (plain denial)");
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log("== 5. executor surface ==");
assert(typeof pwshSandbox.SandboxPwshExecutor.prototype.runSelfChecking === "function", "pwsh executor has runSelfChecking");
assert(typeof pwshSandbox.SandboxPwshExecutor.prototype.startSelfChecking === "function", "pwsh executor has startSelfChecking");
assert(typeof bashSandbox.SandboxBashExecutor.prototype.runSelfChecking === "function", "bash executor has runSelfChecking");
assert(typeof bashSandbox.SandboxBashExecutor.prototype.startSelfChecking === "function", "bash executor has startSelfChecking");

console.log("== 6. pwsh executor wiring (stubbed object) ==");
{
  const proto = pwshSandbox.SandboxPwshExecutor.prototype;
  const recorded = [];
  const gate = {
    selfCheckAllowed: (id, key) => recorded.includes(`${id}|${key}`),
    selfCheckRecord: (id, key) => { recorded.push(`${id}|${key}`); }
  };
  const exec = Object.create(proto);
  exec.ctx = { sandboxPolicy: gate };
  exec.processFacts = new Map();
  let unconfinedRuns = 0;
  pwshLocal.PwshLocalExecutor.prototype.run = async function () {
    unconfinedRuns += 1;
    return { exitCode: 0, stdout: { text: "", truncated: false }, stderr: { text: "", truncated: false }, timedOut: false, signal: null, timeoutMs: 0 };
  };
  exec.runArgv = async (_spec, argv) => ({
    exitCode: 1,
    stdout: { text: "", truncated: false },
    stderr: { text: "Access is denied", truncated: false },
    timedOut: false,
    signal: null,
    timeoutMs: 0,
    argv
  });
  exec.confine = (_spec, policy) => ({
    argv: ["node", "runner", "--mode", policy.mode, "--", _spec.command],
    enforcement: "partial",
    denialSignatures: ["access is denied", "access to the path", "permission denied"],
    runnerFailureRules: []
  });
  exec.startArgv = (_spec, argv) => ({ argv, exitCode: 1 });
  // NOTE: runProbe is the REAL method — the stub only replaces runArgv and
  // confine, so the probe result reconstruction (incl. the sandbox stamp that
  // runSelfChecking reads back) is exercised for real.
  const spec = { command: "Copy-Item C:\\outside C:\\work" };
  const policy = { mode: "self-checking", workspaceRoot: "C:\\work", sessionId: "s1" };

  // first run: probe under workspace-write, denied -> interception
  const first = await exec.runSelfChecking(spec, policy);
  assert(first.sandbox.mode === "self-checking", "probe result reports self-checking mode");
  assert(first.sandbox.intercepted === true, "first run stamped intercepted");
  assert(first.sandbox.denied === true, "first run kept denied");
  assert(recorded.length === 1 && recorded[0] === "s1|Copy-Item C:\\outside C:\\work", "interception recorded with session+command key");
  assert(unconfinedRuns === 0, "first run never ran unconfined");

  // identical re-run: allowed -> unconfined full access
  const second = await exec.runSelfChecking(spec, policy);
  assert(second.sandbox.intercepted === void 0, "re-run not marked intercepted");
  assert(second.sandbox.denied === false, "re-run not denied");
  assert(unconfinedRuns === 1, "re-run executed unconfined");

  // a different command still probes
  const other = await exec.runSelfChecking({ command: "Remove-Item C:\\other" }, policy);
  assert(other.sandbox.intercepted === true, "different command intercepted separately");
  assert(recorded.length === 2, "second interception recorded");

  // agentless: probes, denied, no record, no interception escape
  const agentless = await exec.runSelfChecking(spec, { mode: "self-checking", workspaceRoot: "C:\\work" });
  assert(agentless.sandbox.denied === true && agentless.sandbox.intercepted === void 0, "agentless probe stays a plain denial");
  assert(recorded.length === 2, "agentless recorded nothing");

  // pwsh exit-0 denial: probe verdict is stderr-based, so a zero exit with a
  // denial on stderr still intercepts (verified live against the real runner)
  const zeroExit = await exec.runSelfChecking(
    { command: "Set-Content -LiteralPath C:\\outside\\f.txt -Value hi" },
    { mode: "self-checking", workspaceRoot: "C:\\work", sessionId: "s3" }
  );
  assert(zeroExit.sandbox.intercepted === true, "exit-0 denial still intercepted (probe verdict is stderr-based)");

  // background path: startSelfChecking probes; onProcessDone records on denial
  let superStartCalls = 0;
  pwshLocal.PwshLocalExecutor.prototype.start = function () { superStartCalls += 1; return "proc"; };
  const probeProc = exec.startSelfChecking({ command: "bg-cmd" }, policy);
  assert(probeProc !== "proc", "probe start returns a confined process handle");
  assert(exec.processFacts.get(probeProc).selfCheckKey === "bg-cmd", "facts carry the command key");
  exec.onProcessDone(probeProc, "New-Item : Access to the path 'C:\\outside' is denied.", false, void 0);
  assert(probeProc.sandbox.intercepted === true, "background denial stamped intercepted");
  assert(recorded.includes("s1|bg-cmd"), "background interception recorded");
  // allowed background command starts unconfined
  const allowedProc = exec.startSelfChecking({ command: "bg-cmd" }, policy);
  assert(allowedProc === "proc", "allowed background command starts unconfined");
  assert(superStartCalls === 1, "unconfined start used the local executor");
}

if (failures > 0) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exitCode = 1;
} else {
  console.log("\nALL CHECKS PASSED");
}
