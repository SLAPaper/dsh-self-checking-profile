// Snapshot a pristine upstream dsh install into the repository's vendored
// baseline (upstream/@deepseek-ai + upstream/VERSION). This is the "explicit
// version tracking" half of the upgrade story: every future baseline upgrade
// replaces this tree, and git history keeps the old snapshot as the merge base
// for tools/merge-upstream.mjs.
//
// Usage:
//   node tools/snapshot-upstream.mjs <version> <src-dir>
//
//   <version>  the dsh version the snapshot corresponds to (e.g. 0.1.1-rc.2);
//              must match the patch baseline (builtAgainst).
//   <src-dir>  an npm-style extraction whose subdirectory @deepseek-ai/
//              contains the upstream packages — e.g. the npx cache
//              node_modules/@deepseek-ai of a matching dsh install, or an
//              unpacked `npm pack @deepseek-ai/dsh...` extraction.
//
// The snapshot keeps the FULL npm package contents (including README* and
// LICENSE), because it is the byte-exact reference baseline; the fork layer
// (profile/forks) intentionally carries only runtime files.
import { readdirSync, statSync, mkdirSync, rmSync, cpSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UPSTREAM_ROOT = join(ROOT, "upstream");
const UPSTREAM_PKGS = join(UPSTREAM_ROOT, "@deepseek-ai");
const VERSION_FILE = join(UPSTREAM_ROOT, "VERSION");

const MODIFIED = ["dsh-sandbox", "dsh-sandbox-policy", "dsh-pwsh-sandbox", "dsh-bash-sandbox", "dsh-fs-sandbox", "dsh-tool-pwsh", "dsh-tool-bash", "dsh-terminal-bash", "dsh-sandbox-local", "dsh-client-ui-conversation", "dsh-tool-fs"];
const PRISTINE_COPY = ["dsh-permission-presets"];
const ALL = [...MODIFIED, ...PRISTINE_COPY];

// Files npm writes into an installed package that are NOT part of the tarball.
const SKIP_NAMES = new Set(["node_modules", ".package-lock.json", ".pnpm-store"]);

const [version, srcDir] = process.argv.slice(2);
if (!version || !srcDir) {
  console.error("usage: node tools/snapshot-upstream.mjs <version> <src-dir>");
  process.exit(1);
}
const srcPkgs = join(srcDir, "@deepseek-ai");
for (const pkg of ALL) {
  if (!existsSync(join(srcPkgs, pkg))) {
    console.error(`missing upstream package: ${join(srcPkgs, pkg)}`);
    process.exit(1);
  }
}

rmSync(UPSTREAM_PKGS, { recursive: true, force: true });
mkdirSync(UPSTREAM_PKGS, { recursive: true });
let files = 0;
for (const pkg of ALL) {
  const src = join(srcPkgs, pkg);
  const dest = join(UPSTREAM_PKGS, pkg);
  const walk = (from, to) => {
    for (const entry of readdirSync(from)) {
      if (SKIP_NAMES.has(entry)) continue;
      const full = join(from, entry);
      const target = join(to, entry);
      if (statSync(full).isDirectory()) {
        mkdirSync(target, { recursive: true });
        walk(full, target);
      } else {
        cpSync(full, target);
        files++;
      }
    }
  };
  walk(src, dest);
}
writeFileSync(VERSION_FILE, `${version}\n`);
console.log(`snapshot: ${version} -> upstream/@deepseek-ai (${files} files, ${ALL.length} packages)`);
console.log("commit this snapshot before running tools/merge-upstream.mjs (it reads the base from git HEAD).");
