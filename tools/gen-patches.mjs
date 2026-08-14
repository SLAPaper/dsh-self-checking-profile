// Generate the self-checking patch manifests: for each modified fork package,
// compute anchored string-replacement pairs (pristine -> fork) per file via a
// line-level LCS path, and write a JSON manifest plus a readable unified diff.
// Applying the manifest to a pristine package must reproduce the fork
// byte-for-byte; every replacement's old-string is verified unique so the
// apply side can never patch the wrong spot.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "upstream", "@deepseek-ai");
const FORK = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "profile", "forks");
const OUT = process.argv[4] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "patches");

const PACKAGES = ["dsh-sandbox", "dsh-sandbox-policy", "dsh-pwsh-sandbox", "dsh-bash-sandbox", "dsh-fs-sandbox", "dsh-tool-pwsh", "dsh-tool-bash", "dsh-terminal-bash", "dsh-sandbox-local", "dsh-client-ui-conversation"];

/** LCS-path line diff; returns ops: {t:'eq'|'del'|'ins', l} in file order. */
function diffOps(original, patched) {
  const a = original.split("\n");
  const b = patched.split("\n");
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: "eq", l: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: "del", l: a[i] }); i++; }
    else { ops.push({ t: "ins", l: b[j] }); j++; }
  }
  while (i < n) { ops.push({ t: "del", l: a[i] }); i++; }
  while (j < m) { ops.push({ t: "ins", l: b[j] }); j++; }
  return ops;
}

/** Count occurrences of a substring (non-overlapping). */
function occurrences(haystack, needle) {
  if (needle === "") return 0;
  let count = 0, idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) { count++; idx += needle.length; }
  return count;
}

/**
* Group ops into anchored replacement pairs. A group is a run of del/ins ops
* between equal lines. Deletions keep their lines; a pure insertion is anchored
* to the FOLLOWING equal line (or, at EOF, to the preceding one); anchors are
* extended with more context lines while the old-string would be ambiguous.
*/
function buildPairs(ops, original) {
  const pairs = [];
  const eqLines = [];
  let cur = { del: [], ins: [] };
  const flush = (nextEq) => {
    if (cur.del.length === 0 && cur.ins.length === 0) { cur = { del: [], ins: [] }; return; }
    let oldLines, newLines;
    if (cur.del.length > 0) {
      oldLines = [...cur.del];
      newLines = [...cur.ins];
    } else {
      // pure insertion: anchor to following eq line (or previous at EOF)
      const anchor = nextEq ?? eqLines[eqLines.length - 1];
      if (anchor === void 0) throw new Error("pure insertion without any context line");
      oldLines = [anchor];
      newLines = [...cur.ins, anchor];
    }
    // extend context backwards while the old-string is ambiguous or empty-adjacent
    let guard = 0;
    while (guard++ < 50) {
      const oldText = oldLines.join("\n");
      if (oldText !== "" && occurrences(original, oldText) === 1) break;
      const prev = eqLines[eqLines.length - 1];
      if (prev === void 0 || oldLines[0] === prev) {
        if (nextEq !== void 0 && oldLines[oldLines.length - 1] !== nextEq) {
          oldLines = [...oldLines, nextEq];
          newLines = [...newLines, nextEq];
          continue;
        }
        throw new Error("cannot anchor replacement uniquely");
      }
      oldLines = [prev, ...oldLines];
      newLines = [prev, ...newLines];
    }
    pairs.push({ old: oldLines.join("\n"), new: newLines.join("\n") });
    cur = { del: [], ins: [] };
  };
  for (const op of ops) {
    if (op.t === "eq") { flush(op.l); eqLines.push(op.l); }
    else if (op.t === "del") cur.del.push(op.l);
    else cur.ins.push(op.l);
  }
  flush(void 0);
  return pairs;
}

/** Render a standard unified diff (3 context lines) from ops. */
function renderUnifiedDiff(original, patched, fileLabel) {
  const ops = diffOps(original, patched);
  let oldLine = 1, newLine = 1;
  const annotated = ops.map((op) => {
    const o = oldLine, n = newLine;
    if (op.t === "eq") { oldLine++; newLine++; }
    else if (op.t === "del") oldLine++;
    else newLine++;
    return { ...op, o, n };
  });
  const changeIdx = [];
  annotated.forEach((op, idx) => { if (op.t !== "eq") changeIdx.push(idx); });
  if (changeIdx.length === 0) return "";
  const out = [`--- a/${fileLabel}`, `+++ b/${fileLabel}`];
  const emitHunk = (group) => {
    const start = Math.max(0, group[0] - 3);
    const end = Math.min(annotated.length - 1, group[group.length - 1] + 3);
    const body = annotated.slice(start, end + 1);
    const oldCount = body.filter((l) => l.t !== "ins").length;
    const newCount = body.filter((l) => l.t !== "del").length;
    out.push(`@@ -${body[0].o},${oldCount} +${body[0].n},${newCount} @@`);
    for (const l of body) out.push(`${l.t === "eq" ? " " : l.t === "del" ? "-" : "+"}${l.l}`);
  };
  let group = [changeIdx[0]];
  for (let k = 1; k < changeIdx.length; k++) {
    if (changeIdx[k] - changeIdx[k - 1] <= 6) group.push(changeIdx[k]);
    else { emitHunk(group); group = [changeIdx[k]]; }
  }
  emitHunk(group);
  return out.join("\n") + "\n";
}

function collectFiles(pkgDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(pkgDir, full).replaceAll("\\", "/"));
    }
  };
  walk(pkgDir);
  return out;
}

mkdirSync(OUT, { recursive: true });
let totalPairs = 0;
for (const pkg of PACKAGES) {
  const upstreamDir = join(UPSTREAM, pkg);
  const forkDir = join(FORK, pkg);
  const manifest = { package: pkg, builtAgainst: "0.1.0-rc.6", files: {} };
  const diffs = [];
  for (const file of collectFiles(forkDir)) {
    const upFile = join(upstreamDir, file);
    const forkFile = join(forkDir, file);
    let original, patched;
    try { original = readFileSync(upFile, "utf8"); } catch { original = ""; }
    patched = readFileSync(forkFile, "utf8");
    if (original === patched) continue;
    const ops = diffOps(original, patched);
    const pairs = buildPairs(ops, original);
    // verify byte-exact reconstruction
    let cursor = original;
    for (const pair of pairs) {
      if (occurrences(cursor, pair.old) !== 1) throw new Error(`ambiguous/missing anchor in ${pkg}/${file}: ${JSON.stringify(pair.old.slice(0, 60))}`);
      cursor = cursor.replace(pair.old, pair.new);
    }
    if (cursor !== patched) throw new Error(`reconstruction mismatch for ${pkg}/${file}`);
    manifest.files[file] = pairs;
    totalPairs += pairs.length;
    diffs.push(renderUnifiedDiff(original, patched, `${pkg}/${file}`));
  }
  if (Object.keys(manifest.files).length === 0) { console.log(`SKIP ${pkg}: no differences`); continue; }
  writeFileSync(join(OUT, `${pkg}.json`), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(OUT, `${pkg}.diff`), diffs.join(""));
  const pairCount = Object.values(manifest.files).reduce((s, v) => s + v.length, 0);
  console.log(`wrote ${pkg}.json + .diff (${Object.keys(manifest.files).length} files, ${pairCount} anchored pairs)`);
}
console.log(`total anchored pairs: ${totalPairs}`);
