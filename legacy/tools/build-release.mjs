// Build the LEGACY profile/fork release archive.
//   node legacy/tools/build-release.mjs [version]
// Assembles a staging directory with the legacy distributable files
// (profile/ minus node_modules, patches, tools, tests, docs, install scripts)
// and packages it into legacy/dsh-profile-self-checking-<version>.zip.
import { cpSync, mkdirSync, rmSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(ROOT, "..");
const VERSION = process.argv[2] ?? "0.1.0-rc.6";
const DIST = join(ROOT, "dist");
const OUT = join(ROOT, `dsh-profile-self-checking-${VERSION}.zip`);

const COPY = ["README.md", "README.zh-CN.md", "install.ps1", "install.sh", "verify.mjs", "patches", "tools", "tests", "docs", "upstream"];
const PROFILE_SKIP = new Set(["node_modules", ".pnpm-store"]);

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
for (const entry of COPY) {
  const src = join(ROOT, entry);
  if (!existsSync(src)) { console.error(`missing: ${src}`); process.exit(1); }
  cpSync(src, join(DIST, entry), { recursive: true });
}
for (const entry of ["LICENSE", "CHANGELOG.md"]) {
  const src = join(REPO_ROOT, entry);
  if (!existsSync(src)) { console.error(`missing: ${src}`); process.exit(1); }
  cpSync(src, join(DIST, entry), { recursive: true });
}
// profile/ minus generated node_modules
const profileOut = join(DIST, "profile");
mkdirSync(profileOut, { recursive: true });
for (const entry of readdirSync(join(ROOT, "profile"))) {
  if (PROFILE_SKIP.has(entry)) continue;
  cpSync(join(ROOT, "profile", entry), join(profileOut, entry), { recursive: true });
}
console.log("staged:", readdirSync(DIST).join(", "));
console.log("output:", OUT);

rmSync(OUT, { force: true });
let result;
if (process.platform === "win32") {
  const args = ["-NoProfile", "-Command", `Compress-Archive -Path '${join(DIST, "*")}' -DestinationPath '${OUT}' -Force`];
  result = spawnSync("powershell", args, { stdio: "inherit" });
} else {
  result = spawnSync("zip", ["-rq", OUT, "."], { cwd: DIST, stdio: "inherit" });
  if (result.status !== 0) {
    result = spawnSync("tar", ["-czf", OUT, "."], { cwd: DIST, stdio: "inherit" });
  }
}
rmSync(DIST, { recursive: true, force: true });
if (result.status !== 0) {
  console.error("packaging failed");
  process.exit(result.status ?? 1);
}
console.log(`built ${OUT}`);
