# Changelog

All notable changes to this repository are documented here. The baseline
(`builtAgainst`) is the upstream `@deepseek-ai/dsh` 0.1.0-rc.6 install.

## Unreleased

### Changed

- Interception notice is now defensive: it states that a re-run is the
  sanctioned continuation **only when the outside access is intentional** and
  that a non-intentional re-run must not happen. Applied to the shell marker,
  the fs fence notice, the policy context, the tool descriptions, and the
  preset description.
- The Self Checking preset now bundles `approval: ask` (was `never`): the
  re-run flow stays approval-free, but the human approval channel remains
  available so the model can escalate
  (`sandbox_permissions: "danger-full-access"` + `justification`) for
  restrictions the probe cannot intercept.
- Upgrade path replaced: the repo now vendors the baseline npm package bytes
  under `upstream/` (git-tracked, versioned in `upstream/VERSION`), and
  upgrading to a new dsh baseline is a three-way merge
  (`tools/merge-upstream.mjs`, diff3 via `git merge-file`) over the committed
  snapshot instead of a blind re-patch: upstream-only changes are taken,
  fork-only changes are kept, both-changed files are merged, genuine conflicts
  surface with conflict markers, new files are adopted, deletions are followed.
  `tools/snapshot-upstream.mjs` vendors a baseline from scratch. The old
  workflow ("point rebuild-fork.mjs at an external pristine install") is now
  the special case of rebuilding against `upstream/@deepseek-ai`.
- `gen-patches.mjs` defaults to the vendored snapshot + `profile/forks`;
  `.gitattributes` pins LF for `*.d.ts`, `LICENSE`, and `upstream/**` so the
  byte-exact comparisons hold on every checkout.

### Added

- **Failure path for process-level restrictions** (the former interception
  blind spot): under self-checking, a command that runs confined but fails
  (non-zero exit) now records its key and is met with a defensive
  `[sandbox: self-check failed ...]` notice — the failure may be a sandbox
  permission issue the probe cannot classify. Re-running the exact same
  command (only when intentional) retries it with full access, automatically.
  Applied to the foreground and background pwsh/bash paths; the per-session
  gate and the policy-context text were extended to cover both the
  interception and the failure paths.
- **Filesystem failure hint**: `dsh-tool-fs` is now the 12th forked package —
  under self-checking, an ordinary (non-denial) write/edit failure gets the
  defensive self-check notice appended and steers to the explicit escalation
  channel (`sandbox_permissions` + `justification`); filesystem operations
  have no automatic re-run unlock. `FS_SELFCHECK_INTERCEPTED` and
  `FS_SANDBOX_DENIED` pass through unchanged; other modes are untouched.

### Docs

- The blind-spot section now documents the failure path: process-level
  restrictions (named pipes, TLS/credential stores, privilege/Write-DAC
  operations) leave no denial signature and are never intercepted, but a
  failing exit now carries the `[sandbox: self-check failed ...]` notice and
  the sanctioned re-run retries with full access — with the caveats that the
  first run already executed under confinement (a re-run can repeat partial
  side effects) and that a non-permission failure fails again.

- README now credits the upstream project at the top: the profile is based on
  dsh / DeepSeek Harness, citing the source repository
  (<https://github.com/deepseek-ai/deepseek-harness>) and the npm package
  (<https://www.npmjs.com/package/@deepseek-ai/dsh>).
- Added a Chinese translation of the README (`README.zh-CN.md`) with mutual
  English ↔ 中文 links at the top of both documents; the release zip ships both
  files.
- Both READMEs now embed a screenshot of Self Checking in the composer
  permission picker (`docs/self-checking-permission-picker.png`), shipped in
  the release zip via the new `docs/` copy entry.

## 0.1.0 — 2026-08-14

Initial release: the **Self Checking** sandbox mode as a dsh profile.

### Features

- New `self-checking` sandbox mode: commands/operations run under
  `workspace-write` confinement by default; a probe denied for accessing a
  path outside the workspace is intercepted once with a
  `[sandbox: self-check intercepted ...]` notice; re-running the exact same
  command/operation executes it with full access (per-session, in-memory
  gate).
- New **Self Checking** permission preset (sandbox `self-checking` + approval
  `never`), selectable from Settings → Permission and the composer picker.
- Fork layer: 11 forked packages shipped inside the profile's
  `node_modules/@deepseek-ai/` that shadow the identical upstream packages;
  upstream installs stay pristine and reproducible (see `patches/` +
  `tools/rebuild-fork.mjs`).
- Client glyph for Self Checking in the composer permission selector
  (shield + magnifier).
- pnpm-managed install path (`dsh plugin --profile <name> install`) with the
  forks declared as `file:` dependencies; verified: pnpm does not prune the
  forks, fork-internal imports stay consistent, and undeclared dependencies
  resolve from the shared fallback.

### Fixes found during live verification

- Foreground probe crash: `runProbe` results lacked the `sandbox` field that
  `runSelfChecking` reads (`Cannot read properties of undefined (reading
  'enforcement')`) — fixed in `dsh-pwsh-sandbox` / `dsh-bash-sandbox`.
- Node EPERM denials on Windows were not recognized: the windows-acl denial
  dialect now includes `operation not permitted` (Node reports ACL-denied
  file effects as EPERM) — fixed in the `dsh-sandbox-local` fork; without it
  node-based commands could never be intercepted and re-run.
- pwsh reports denied file effects as non-terminating errors with exit 0;
  the probe classifies denials by stderr alone.

### Known limitations

- Reads outside the workspace are not intercepted (workspace-write
  semantics); only denied file effects are.
- Agentless (non-model) calls probe but have no re-run escape hatch (fail
  closed).
- Persistent terminals confine as workspace-write (no re-run flow inside a
  terminal).
- The interception gate is per-session in-memory state; a server restart
  resets it.
