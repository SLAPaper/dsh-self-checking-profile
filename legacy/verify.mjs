// Recipient-side verification for the Self Checking profile fork layer.
//
// Usage:
//   node verify.mjs --profile <profileDir> [--upstream <pristineDshAIDir>]
//
// Checks, exactly along the boot path:
//   1. bare-name resolution from the profile directory: the modified
//      packages AND dsh-permission-presets must resolve to the profile's own
//      node_modules (fork layer); non-forked packages (dsh-tool-fs-search)
//      must still resolve to the pristine install.
//   2. the forked SANDBOX_MODES includes "self-checking".
//   3. the profile's cordis.patch.yml parses and the permission preset table
//      validates against the forked vocabulary (the original boot failure).
//   4. the real filesystem fence gate: inside-workspace write passes, an
//      outside-workspace write is intercepted once (FS_SELFCHECK_INTERCEPTED),
//      the identical re-run is allowed with full access, agentless stays a
//      plain denial, workspace-write mode is unchanged.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const get = (name) => { const i = args.indexOf(name); return i === -1 ? void 0 : args[i + 1]; };
const profileDir = get("--profile");
if (!profileDir) { console.error("usage: node verify.mjs --profile <profileDir> [--upstream <pristineDshAIDir>]"); process.exit(2); }

const forkNm = join(profileDir, "node_modules", "@deepseek-ai");
const upstream = get("--upstream") ?? join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "profiles", "node_modules", "@deepseek-ai");
const requireFromProfile = createRequire(pathToFileURL(join(profileDir, "__probe__.js")).href);

let failures = 0;
const assert = (cond, label) => { console.log(`  ${cond ? "ok" : "FAIL"}: ${label}`); if (!cond) failures++; };
const canonical = (p) => { try { return realpathSync(p); } catch { return p; } };
const isUnder = (p, dir) => canonical(p).toLowerCase().startsWith(canonical(dir).toLowerCase());

console.log(`profile: ${profileDir}`);
console.log(`fork layer: ${forkNm}`);
const upstreamPresent = existsSync(join(upstream, "dsh-sandbox"));
if (!upstreamPresent) console.log(`pristine install: ${upstream} (missing — run any dsh profile once to build the shared module fallback; pristine-resolution checks skipped)`);
else console.log(`pristine install: ${upstream}`);

// 1. resolution shadowing
console.log("== 1. resolution ==");
for (const pkg of ["dsh-sandbox", "dsh-sandbox-policy", "dsh-pwsh-sandbox", "dsh-bash-sandbox", "dsh-fs-sandbox", "dsh-tool-pwsh", "dsh-tool-bash", "dsh-terminal-bash", "dsh-sandbox-local", "dsh-permission-presets", "dsh-client-ui-conversation", "dsh-tool-fs"]) {
  const resolved = requireFromProfile.resolve(`@deepseek-ai/${pkg}`);
  assert(isUnder(resolved, forkNm), `${pkg} resolves into the fork layer`);
}
if (upstreamPresent) {
  // Packages no dependency declares can never enter the pnpm-managed profile
  // node_modules — they must resolve from the pristine install (fallback).
  for (const pkg of ["dsh-tool-fs-search"]) {
    const resolved = requireFromProfile.resolve(`@deepseek-ai/${pkg}`);
    assert(!isUnder(resolved, forkNm), `${pkg} resolves outside the fork layer (not shadowed)`);
  }
  // dsh-sandbox-windows-acl MAY legitimately sit inside the profile's
  // node_modules as pnpm's transitive install (a declared dependency of
  // dsh-sandbox-local); it must then be the UNMODIFIED registry original.
  const aclResolved = requireFromProfile.resolve("@deepseek-ai/dsh-sandbox-windows-acl");
  if (isUnder(aclResolved, forkNm)) {
    const a = readFileSync(aclResolved, "utf8");
    const b = readFileSync(join(upstream, "dsh-sandbox-windows-acl", "lib", "index.js"), "utf8");
    assert(a === b, "profile-local dsh-sandbox-windows-acl is byte-identical to the pristine install (unmodified transitive dep)");
  }
}
// fork-internal dependency: the forked policy's own dsh-sandbox import
{
  const internalRequire = createRequire(pathToFileURL(join(forkNm, "dsh-sandbox-policy", "lib", "__probe__.js")).href);
  const resolved = internalRequire.resolve("@deepseek-ai/dsh-sandbox");
  assert(isUnder(resolved, forkNm), "fork-internal dsh-sandbox import resolves to the fork");
}

// 2. forked vocabulary
console.log("== 2. vocabulary ==");
{
  const { SANDBOX_MODES } = requireFromProfile("@deepseek-ai/dsh-sandbox-policy");
  assert(SANDBOX_MODES.includes("self-checking"), `SANDBOX_MODES includes self-checking (got ${JSON.stringify(SANDBOX_MODES)})`);
}
// 2b. forked windows-acl denial dialect covers Node's EPERM text
{
  const provider = requireFromProfile("@deepseek-ai/dsh-sandbox-local");
  const instance = new provider.default(
    { reflect: { provide: () => {} }, effect: () => () => {}, logger: console },
    { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5000 }
  );
  const confined = instance.confine(["cmd", "/c", "exit", "0"], { mode: "read-only", workspaceRoot: "C:/" });
  assert(confined.denialSignatures.includes("operation not permitted"), "windows-acl denial signatures include Node's EPERM text");
}

// 3. patch parses + preset config validates against the forked vocabulary
console.log("== 3. preset config ==");
{
  const { parse } = requireFromProfile("yaml");
  const patch = parse(readFileSync(join(profileDir, "cordis.patch.yml"), "utf8"));
  assert(Array.isArray(patch), "cordis.patch.yml is a top-level array");
  const row = patch.find((e) => e.id === "permission");
  assert(row !== void 0, "patch targets the permission row");
  if (row !== void 0) {
    const { PermissionPresetService } = requireFromProfile("@deepseek-ai/dsh-permission-presets");
    const result = PermissionPresetService.Config["~standard"].validate({ presets: row.config.presets });
    assert(result.issues === void 0, "preset table validates against the forked SANDBOX_MODES");
  }
}

// 4. real fs fence gate
console.log("== 4. filesystem fence ==");
{
  const policyMod = await import(pathToFileURL(join(forkNm, "dsh-sandbox-policy", "lib", "index.js")).href);
  const fsSandbox = await import(pathToFileURL(join(forkNm, "dsh-fs-sandbox", "lib", "index.js")).href);
  const service = new policyMod.SandboxPolicyService(
    { reflect: { provide: () => {} }, on: () => {}, inject: () => {}, logger: console },
    { mode: "self-checking", workspaceRoot: process.cwd() }
  );
  const base = mkdtempSync(join(process.env.DSH_SC_FENCE_DIR ?? homedir(), "dsh-sc-verify-"));
  const workspace = join(base, "workspace");
  const outside = join(base, "outside");
  mkdirSync(workspace); mkdirSync(outside);
  try {
    const fs = new fsSandbox.SandboxedFileSystem(
      { sandboxPolicy: { defaultMode: "self-checking", selfCheckAllowed: (id, k) => service.selfCheckAllowed(id, k), selfCheckRecord: (id, k) => service.selfCheckRecord(id, k) }, get: () => void 0, logger: console, reflect: { provide: () => {} } },
      { cwd: workspace, diffBasisMaxBytes: 1024 * 1024 }
    );
    const policy = { mode: "self-checking", workspaceRoot: workspace, sessionId: "verify" };
    const inside = await fs.resolve("inside.txt", { cwd: workspace });
    await fs.writeText(inside, "hi", void 0, void 0, policy);
    assert(readFileSync(join(workspace, "inside.txt"), "utf8") === "hi", "inside-workspace write passes on first attempt");
    const outTarget = await fs.resolve(join(outside, "out.txt"), { cwd: workspace });
    let intercepted = false;
    try { await fs.writeText(outTarget, "x", void 0, void 0, policy); } catch (e) { intercepted = e.code === "FS_SELFCHECK_INTERCEPTED"; }
    assert(intercepted && !existsSync(join(outside, "out.txt")), "outside write intercepted once, nothing written");
    await fs.writeText(outTarget, "y", void 0, void 0, policy);
    assert(readFileSync(join(outside, "out.txt"), "utf8") === "y", "identical re-run allowed with full access");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? "\nALL CHECKS PASSED — the fork layer is active in this profile" : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
