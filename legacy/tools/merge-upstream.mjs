// Three-way merge of a new upstream baseline into the fork layer — the
// "merge mechanism" half of the upgrade story.
//
// Usage:
//   node tools/merge-upstream.mjs <new-version> <new-upstream-dir> [--dry-run]
//
//   <new-version>     the dsh version being upgraded to (e.g. 0.1.0-rc.7).
//   <new-upstream-dir> an npm-style extraction whose subdirectory
//                     @deepseek-ai/ contains the NEW upstream packages
//                     (obtained e.g. by running
//                     `node tools/snapshot-upstream.mjs <new-version> <tmp>`
//                     against a staging dir, or by unpacking the new tarballs).
//   --dry-run         report what would change without writing anything.
//
// For every file the merge considers:
//   base   = the old upstream snapshot, read from git HEAD (upstream/ must be
//            committed — run snapshot-upstream.mjs and commit first)
//   ours   = the current fork layer (profile/forks/<pkg>/<file>)
//   theirs = the new upstream package content
//
// Decision matrix (per package, per file):
//   - pristine-copy packages (dsh-permission-presets) simply follow upstream.
//   - modified packages: upstream-untouched files keep our changes; our
//     untouched files take upstream; files changed on both sides are merged
//     with git merge-file (diff3); genuine conflicts are written into the fork
//     layer with conflict markers and reported (exit code 1).
//   - new upstream files are adopted; files upstream deleted are removed when
//     we did not modify them, otherwise kept with a warning.
//
// After a successful merge run:
//   - the vendored snapshot (upstream/) is replaced by the new baseline and
//     upstream/VERSION is updated (commit both afterwards),
//   - then regenerate the patch set and re-verify:
//       node tools/gen-patches.mjs upstream/@deepseek-ai profile/forks patches
//       node tools/rebuild-fork.mjs --upstream upstream/@deepseek-ai --out <tmp> --check profile/forks
//       node tests/verify-self-checking.mjs
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync, existsSync, cpSync, mkdtempSync, openSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(ROOT, "..");
const UPSTREAM_ROOT = join(ROOT, "upstream");
const UPSTREAM_PKGS = join(UPSTREAM_ROOT, "@deepseek-ai");
const VERSION_FILE = join(UPSTREAM_ROOT, "VERSION");
const FORKS_ROOT = join(ROOT, "profile", "forks");
// scratch space for git plumbing under the repo (inside the workspace so the
// tool runs under workspace-write confinement; stdout/stderr of git are
// captured via file descriptors instead of pipes, which restricted sandboxes
// deny)
const GIT_TMP = join(REPO_ROOT, ".git", "dsh-merge-tmp");

const MODIFIED = ["dsh-sandbox", "dsh-sandbox-policy", "dsh-pwsh-sandbox", "dsh-bash-sandbox", "dsh-fs-sandbox", "dsh-tool-pwsh", "dsh-tool-bash", "dsh-terminal-bash", "dsh-sandbox-local", "dsh-client-ui-conversation", "dsh-tool-fs"];
const PRISTINE_COPY = ["dsh-permission-presets"];
const ALL = [...MODIFIED, ...PRISTINE_COPY];

const README_RE = /^README/;

function git(args, opts = {}) {
  mkdirSync(GIT_TMP, { recursive: true });
  const tag = `${process.pid}-${(Math.random() * 1e9) | 0}`;
  const outFile = join(GIT_TMP, `out-${tag}`), errFile = join(GIT_TMP, `err-${tag}`);
  const outFd = openSync(outFile, "w"), errFd = openSync(errFile, "w");
  let status;
  try {
    const r = spawnSync("git", args, { cwd: opts.cwd ?? ROOT, stdio: ["ignore", outFd, errFd] });
    status = r.status;
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  const stdout = readFileSync(outFile, "utf8");
  rmSync(outFile, { force: true });
  rmSync(errFile, { force: true });
  return { status, stdout };
}

function gitShow(path) {
  const r = git(["show", `HEAD:${path}`]);
  if (r.status !== 0) return null;
  return r.stdout;
}

function gitLsTree(dir) {
  const r = git(["ls-tree", "-r", "--name-only", `HEAD:${dir}`]);
  if (r.status !== 0) return [];
  const prefix = `${dir}/`;
  return r.stdout.split("\n").filter(Boolean).map((p) => p.startsWith(prefix) ? p.slice(prefix.length) : p);
}

function walkFiles(dir) {
  const out = [];
  const collect = (d, rel) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const r = rel ? `${rel}/${entry}` : entry;
      if (statSync(full).isDirectory()) collect(full, r);
      else out.push(r);
    }
  };
  collect(dir, "");
  return out;
}

function mergeFile(ours, base, theirs) {
  const dir = mkdtempSync(join(GIT_TMP, "mf-"));
  try {
    const o = join(dir, "ours"), b = join(dir, "base"), t = join(dir, "theirs");
    writeFileSync(o, ours);
    writeFileSync(b, base);
    writeFileSync(t, theirs);
    const r = git(["merge-file", "-p", "--diff3", "ours", "base", "theirs"], { cwd: dir });
    return { ok: r.status === 0, out: r.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readOrNull(path) {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

const [newVersion, newDir, maybeDry] = process.argv.slice(2);
const dryRun = maybeDry === "--dry-run";
if (!newVersion || !newDir) {
  console.error("usage: node tools/merge-upstream.mjs <new-version> <new-upstream-dir> [--dry-run]");
  process.exit(1);
}
const newPkgs = join(newDir, "@deepseek-ai");
for (const pkg of ALL) {
  if (!existsSync(join(newPkgs, pkg))) {
    console.error(`missing new upstream package: ${join(newPkgs, pkg)}`);
    process.exit(1);
  }
}

// base snapshot must be committed
const oldVersion = gitShow("legacy/upstream/VERSION")?.trim();
if (!oldVersion) {
  console.error("no committed upstream snapshot found — run tools/snapshot-upstream.mjs and commit first");
  process.exit(1);
}
console.log(`merging upstream ${oldVersion} -> ${newVersion}${dryRun ? " (dry run)" : ""}`);
if (oldVersion === newVersion) {
  console.error(`new version equals the vendored baseline (${newVersion}); nothing to do`);
  process.exit(1);
}

const stats = { merged: 0, taken: 0, kept: 0, new: 0, deleted: 0, keptDeleted: 0, conflicts: [] };

for (const pkg of ALL) {
  const oldFiles = new Set(gitLsTree(`legacy/upstream/@deepseek-ai/${pkg}`));
  const oldRead = (rel) => gitShow(`legacy/upstream/@deepseek-ai/${pkg}/${rel}`);
  const newDirPkg = join(newPkgs, pkg);
  const newFiles = existsSync(newDirPkg) ? new Set(walkFiles(newDirPkg)) : new Set();
  const newRead = (rel) => existsSync(join(newDirPkg, rel)) ? readFileSync(join(newDirPkg, rel), "utf8") : null;
  const forkDirPkg = join(FORKS_ROOT, pkg);
  const forkFiles = existsSync(forkDirPkg) ? new Set(walkFiles(forkDirPkg)) : new Set();
  const forkRead = (rel) => readOrNull(join(forkDirPkg, rel));
  const forkWrite = (rel, content) => {
    if (dryRun) return;
    const dest = join(forkDirPkg, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  };
  const forkDelete = (rel) => {
    if (dryRun) return;
    rmSync(join(forkDirPkg, rel), { force: true });
  };

  const pristine = PRISTINE_COPY.includes(pkg);
  const union = new Set([...oldFiles, ...newFiles, ...forkFiles]);
  for (const rel of [...union].sort()) {
    if (README_RE.test(rel.split("/").pop())) continue; // fork layer carries no README*
    if (pristine) {
      // pristine-copy package: follow upstream byte-for-byte (runtime files only)
      const theirs = newRead(rel);
      if (theirs !== null) { forkWrite(rel, theirs); stats.taken++; }
      else if (forkFiles.has(rel)) { forkDelete(rel); stats.deleted++; }
      continue;
    }
    const base = oldFiles.has(rel) ? oldRead(rel) : null;
    const theirs = newFiles.has(rel) ? newRead(rel) : null;
    const ours = forkFiles.has(rel) ? forkRead(rel) : null;
    const label = `${pkg}/${rel}`;

    if (theirs === null) {
      // upstream removed the file
      if (ours === null) continue;
      if (base !== null && ours === base) { forkDelete(rel); stats.deleted++; console.log(`deleted ${label} (follows upstream)`); }
      else {
        stats.keptDeleted++;
        console.warn(`KEEP   ${label} — upstream deleted it but the fork modified it; resolve manually`);
      }
      continue;
    }
    if (ours === null) {
      if (base !== null) {
        stats.keptDeleted++;
        console.warn(`CONFLICT ${label} — upstream renamed/kept the file but the fork dropped it; adopted upstream`);
      } else {
        stats.new++;
        console.log(`new    ${label} (adopted from upstream)`);
      }
      forkWrite(rel, theirs);
      continue;
    }
    if (ours === theirs) continue;
    if (theirs === base) continue; // upstream untouched: keep our change
    if (ours === base) { forkWrite(rel, theirs); stats.taken++; console.log(`taken  ${label} (upstream change only)`); continue; }

    // both sides changed: three-way merge
    if (ours.includes("\0") || base.includes("\0") || theirs.includes("\0")) {
      stats.conflicts.push(label);
      console.error(`CONFLICT ${label} — binary file changed on both sides; resolve manually`);
      continue;
    }
    const m = mergeFile(ours, base, theirs);
    if (m.ok) {
      forkWrite(rel, m.out);
      stats.merged++;
      console.log(`merged ${label}`);
    } else {
      forkWrite(rel, m.out); // conflict markers, for manual resolution
      stats.conflicts.push(label);
      console.error(`CONFLICT ${label} — conflict markers written into the fork layer; resolve manually`);
    }
  }
}

if (dryRun) {
  console.log("\ndry run — nothing written.");
} else {
  // replace the vendored snapshot with the new baseline
  rmSync(UPSTREAM_PKGS, { recursive: true, force: true });
  mkdirSync(UPSTREAM_PKGS, { recursive: true });
  cpSync(newPkgs, UPSTREAM_PKGS, { recursive: true });
  writeFileSync(VERSION_FILE, `${newVersion}\n`);
  console.log(`\nvendored snapshot updated to ${newVersion}`);
}

console.log(`\nsummary: merged ${stats.merged}, taken ${stats.taken}, new ${stats.new}, deleted ${stats.deleted}, kept-ours-warn ${stats.keptDeleted}, conflicts ${stats.conflicts.length}`);
if (stats.conflicts.length > 0) {
  console.error("conflicts to resolve:");
  for (const c of stats.conflicts) console.error(`  - ${c}`);
  console.error("resolve the conflict markers in legacy/profile/forks, then run gen-patches.mjs + rebuild-fork.mjs --check + verify-self-checking.mjs, and commit the snapshot + forks together.");
  process.exitCode = 1;
} else {
  console.log("next steps:");
  console.log("  node legacy/tools/gen-patches.mjs legacy/upstream/@deepseek-ai legacy/profile/forks legacy/patches");
  console.log("  node legacy/tools/rebuild-fork.mjs --upstream legacy/upstream/@deepseek-ai --out <tmp> --check legacy/profile/forks");
  console.log("  node legacy/tests/verify-self-checking.mjs");
  console.log("  git add legacy/upstream legacy/profile/forks legacy/patches && git commit");
}
