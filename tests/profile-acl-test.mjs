// Decisive test: run the REAL windows-acl runner from the pnpm-installed
// profile (self-checking) end to end — grant materialization via the profile's
// windows-acl FFI (koffi native via @koromix), workspace write allowed,
// outside-workspace write denied with a matchable signature.
import { mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const PROFILE = "C:/Users/slapa/.dsh/profiles/self-checking";
const NM = join(PROFILE, "node_modules", "@deepseek-ai");
const acl = await import(pathToFileURL(join(NM, "dsh-sandbox-windows-acl", "lib", "index.js")).href);
const runnerPath = join(NM, "dsh-sandbox-windows-acl", "lib", "runner.js");

const base = mkdtempSync(join("C:/Users/slapa/workspace/dsh-self-checking", "acl-probe-"));
const workspace = join(base, "workspace");
const outside = join(base, "outside");
mkdirSync(workspace);
mkdirSync(outside);

let grant = null;
let tempGrant = null;
let tempDir = null;
try {
  const writeSid = acl.workspaceWriteSid(workspace);
  tempDir = mkdtempSync(join(base, "temp"));
  const tempSid = acl.tempWriteSid(tempDir);
  grant = acl.AclWriteGrant.create(writeSid);
  grant.add(workspace, true);
  tempGrant = acl.AclWriteGrant.create(tempSid);
  tempGrant.add(tempDir);

  const run = (cmd) => {
    const argv = [process.execPath, runnerPath,
      "--workspace", workspace, "--temp", tempDir, "--mode", "workspace-write",
      "--write-sid", writeSid, "--temp-write-sid", tempSid, "--",
      "pwsh", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", cmd];
    const r = spawnSync(argv[0], argv.slice(1), { stdio: "inherit" });
    return r.status;
  };

  console.log("=== inside-workspace write (expect exit 0, file created) ===");
  const insideCmd = `Set-Content -LiteralPath ${JSON.stringify(join(workspace, "ok.txt"))} -Value hi; Write-Output INSIDE_OK`;
  const inside = run(insideCmd);
  console.log("exit:", inside, "| file exists:", existsSync(join(workspace, "ok.txt")));

  console.log("=== outside-workspace write (expect denied, NO file) ===");
  const outsideCmd = `Set-Content -LiteralPath ${JSON.stringify(join(outside, "probe.txt"))} -Value hi; Write-Output OUTSIDE_OK`;
  const outsideRun = run(outsideCmd);
  const denied = !existsSync(join(outside, "probe.txt"));
  console.log("exit:", outsideRun, "| denied (no file):", denied);

  const ok = existsSync(join(workspace, "ok.txt")) && denied;
  console.log(ok ? "\nPROFILE ACL CHAIN PASSED — sandbox fully functional in the pnpm-installed profile" : "\nPROFILE ACL CHAIN FAILED");
  process.exitCode = ok ? 0 : 1;
} finally {
  if (grant !== null) { try { grant.dispose(); } catch { /* best effort */ } }
  if (tempGrant !== null) { try { tempGrant.dispose(); } catch { /* best effort */ } }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
}
