// Live probe of the REAL windows-acl runner: materialize workspace-write
// grants the way dsh-sandbox-local does, run pwsh under the restricted token,
// and confirm that writing outside the workspace is DENIED with stderr that
// matches the shipped denial signatures (the premise of the self-checking
// probe), while an inside-workspace write succeeds.
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const ROOT = "C:/Users/slapa/scoop/persist/nodejs/cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai";
const load = (pkg) => import(pathToFileURL(join(ROOT, pkg, "lib/index.js")).href);

const acl = await load("dsh-sandbox-windows-acl");
const runnerPath = join(ROOT, "dsh-sandbox-windows-acl/lib/runner.js");

const base = mkdtempSync(join(homedir(), "dsh-sc-live-"));
const workspace = join(base, "workspace");
const outside = join(base, "outside");
mkdirSync(workspace);
mkdirSync(outside);

let grant = null;
let tempGrant = null;
let tempDir = null;
try {
  const writeSid = acl.workspaceWriteSid(workspace);
  tempDir = mkdtempSync(join(tmpdir(), "dsh-live-"));
  const tempSid = acl.tempWriteSid(tempDir);

  // materialize exactly like sandbox-local: standing workspace grant + private temp grant
  grant = acl.AclWriteGrant.create(writeSid);
  grant.add(workspace, true);
  tempGrant = acl.AclWriteGrant.create(tempSid);
  tempGrant.add(tempDir);

  const argv = (cmd) => [
    process.execPath, runnerPath,
    "--workspace", workspace,
    "--temp", tempDir,
    "--mode", "workspace-write",
    "--write-sid", writeSid,
    "--temp-write-sid", tempSid,
    "--",
    "pwsh", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", cmd
  ];

  const insideCmd = `Set-Content -LiteralPath ${JSON.stringify(join(workspace, "ok.txt"))} -Value hi; Write-Output INSIDE_OK`;
  const insideArgv = argv(insideCmd);
  const inside = spawnSync(insideArgv[0], insideArgv.slice(1), { stdio: "pipe", encoding: "utf8" });
  console.log("inside write: exit", inside.status, "stdout:", inside.stdout.trim());
  console.log("inside write: stderr:", inside.stderr.trim());
  console.log("inside file exists:", existsSync(join(workspace, "ok.txt")));

  const outsideCmd = `Set-Content -LiteralPath ${JSON.stringify(join(outside, "probe.txt"))} -Value hi; Write-Output OUTSIDE_OK`;
  const outsideArgv = argv(outsideCmd);
  const outsideRun = spawnSync(outsideArgv[0], outsideArgv.slice(1), { stdio: "pipe", encoding: "utf8" });
  console.log("outside write: exit", outsideRun.status);
  console.log("outside write stderr:", JSON.stringify(outsideRun.stderr.trim()));
  const stderrLower = outsideRun.stderr.toLowerCase();
  const matched = ["access is denied", "access to the path", "permission denied"].some((s) => stderrLower.includes(s));
  const denied = !existsSync(join(outside, "probe.txt"));
  console.log("outside write denied:", denied, "| denial signature matched:", matched);
  console.log("NOTE: pwsh reports the denied Set-Content as a NON-TERMINATING error — exit", outsideRun.status, "with the denial on stderr. The self-checking probe classifies denials by stderr, so this still intercepts.");
  if (outsideRun.status === 0 && !existsSync(join(outside, "probe.txt"))) {
    console.log("stdout:", JSON.stringify(outsideRun.stdout.trim()));
  }

  const ok = existsSync(join(workspace, "ok.txt"))
    && denied
    && matched;
  console.log(ok ? "\nLIVE ACL PROBE PASSED" : "\nLIVE ACL PROBE FAILED");
  process.exitCode = ok ? 0 : 1;
} finally {
  if (grant !== null) { try { grant.dispose(); } catch { /* best effort */ } }
  if (tempGrant !== null) { try { tempGrant.dispose(); } catch { /* best effort */ } }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
  if (tempDir !== null) { try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ } }
}
