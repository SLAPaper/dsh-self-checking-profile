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
