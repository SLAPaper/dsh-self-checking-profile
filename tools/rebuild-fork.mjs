// Rebuild the self-checking fork layer from a pristine upstream install.
//
// Usage:
//   node rebuild-fork.mjs --upstream <dir> --out <dir> [--check <forkDir>]
//
//   --upstream  path to a pristine @deepseek-ai package directory (e.g.
//               $DSH_HOME/profiles/node_modules/@deepseek-ai or an npm
//               extraction of the matching dsh version).
//   --out       directory to write the fork layer into (each package is
//               written as <out>/<pkg>/).
//   --check     optional reference fork layer; every produced file must be
//               byte-identical (used to validate the rebuild against the
//               shipped fork).
//
// The patch manifests in ../patches/<pkg>.json anchor every replacement to
// unique context, so an upstream version whose content drifted from the
// `builtAgainst` baseline fails loudly instead of misapplying.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PATCHES_DIR = join(ROOT, "..", "patches");
const BASELINE = "0.1.0-rc.6";
const MODIFIED = ["dsh-sandbox", "dsh-sandbox-policy", "dsh-pwsh-sandbox", "dsh-bash-sandbox", "dsh-fs-sandbox", "dsh-tool-pwsh", "dsh-tool-bash", "dsh-terminal-bash", "dsh-sandbox-local", "dsh-client-ui-conversation"];
const PRISTINE_COPY = ["dsh-permission-presets"];

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name) => {
    const idx = args.indexOf(name);
    return idx === -1 ? void 0 : args[idx + 1];
  };
  const upstream = get("--upstream");
  const out = get("--out");
  const check = get("--check");
  if (!upstream || !out) throw new Error("usage: node rebuild-fork.mjs --upstream <dir> --out <dir> [--check <forkDir>]");
  return { upstream, out, check };
}

function occurrences(haystack, needle) {
  if (needle === "") return 0;
  let count = 0, idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) { count++; idx += needle.length; }
  return count;
}

function collectFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

function applyPairs(content, pairs, label) {
  let cursor = content;
  for (const pair of pairs) {
    const count = occurrences(cursor, pair.old);
    if (count !== 1) throw new Error(`${label}: anchor matched ${count} time(s) — upstream drifted from baseline ${BASELINE}; re-base with gen-patches.mjs`);
    cursor = cursor.replace(pair.old, pair.new);
  }
  return cursor;
}

const { upstream, out, check } = parseArgs();
mkdirSync(out, { recursive: true });
let files = 0;
for (const pkg of MODIFIED) {
  const manifest = JSON.parse(readFileSync(join(PATCHES_DIR, `${pkg}.json`), "utf8"));
  if (manifest.builtAgainst !== BASELINE) throw new Error(`${pkg}: manifest built against ${manifest.builtAgainst}, expected ${BASELINE}`);
  const srcDir = join(upstream, pkg);
  const destDir = join(out, pkg);
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  for (const file of collectFiles(srcDir)) {
    const rel = file.slice(srcDir.length + 1).replaceAll("\\", "/");
    if (/^README/.test(rel)) continue; // fork layer carries only runtime files (package.json, LICENSE, lib)
    const content = readFileSync(file, "utf8");
    const patched = manifest.files[rel] === void 0 ? content : applyPairs(content, manifest.files[rel], `${pkg}/${rel}`);
    const dest = join(destDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, patched);
    files++;
  }
  console.log(`rebuilt ${pkg} (${Object.keys(manifest.files).length} patched file(s))`);
}
// pristine copies
for (const pkg of PRISTINE_COPY) {
  const srcDir = join(upstream, pkg);
  const destDir = join(out, pkg);
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  for (const file of collectFiles(srcDir)) {
    const rel = file.slice(srcDir.length + 1).replaceAll("\\", "/");
    if (/^README/.test(rel)) continue;
    const dest = join(destDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(file, dest);
    files++;
  }
  console.log(`copied ${pkg} (pristine)`);
}
// verification against a reference fork
if (check !== void 0) {
  let mismatches = 0, compared = 0;
  for (const pkg of [...MODIFIED, ...PRISTINE_COPY]) {
    for (const file of collectFiles(join(out, pkg))) {
      const rel = file.slice(join(out, pkg).length + 1);
      const ref = join(check, pkg, rel);
      const a = readFileSync(file, "utf8");
      const b = readFileSync(ref, "utf8");
      compared++;
      if (a !== b) { mismatches++; console.log(`MISMATCH ${pkg}/${rel}`); }
    }
  }
  console.log(`compared ${compared} files against reference: ${mismatches === 0 ? "byte-identical ✓" : `${mismatches} mismatch(es)`}`);
  if (mismatches > 0) process.exitCode = 1;
}
console.log(`fork layer rebuilt at ${out} (${files} files)`);
