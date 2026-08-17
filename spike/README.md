# Spike: single-package Self Checking (service-replacement)

Proof of concept for the "can we make Self Checking install like Alnita's
one-package plugin instead of shadowing 12 upstream packages?" question.

**Verdict: viable in principle.** A single bundle package can keep the
Self Checking semantics without adding a new `SandboxMode`, by subclassing the
upstream service providers and disabling their native rows through
`cordis.patch.yml`.

## Design

- `self-checking` is a permission **preset** whose sandbox knob is the existing
  `workspace-write` + `approval: ask`. No `SANDBOX_MODES` change.
- The bundle patch disables the native `bash-sandbox`, `pwsh-sandbox` and
  `fs-sandbox` rows and inserts this package.
- The host plugin mounts:
  - one `ctx.shell` subclass (`SandboxBashExecutor` or `SandboxPwshExecutor`
    depending on platform);
  - one `ctx.fs` subclass (`SandboxedFileSystem`).
- A per-session gate records intercepted/failed command or target keys. The
  preset is read from the session log's last `permission/preset` event
  (deliberately NOT from the `permissionPresets` service, otherwise the shell
  provider and permission service deadlock each other during activation).
- First call probes under `workspace-write`; an outside-workspace denial is
  intercepted once. Re-running the exact same command/target executes with
  `danger-full-access`. Confined non-zero failures get the defensive failure
  marker and the same retry escape.
- Native `dsh-tool-bash/pwsh/fs` renderers are **not forked**. The
  intercepted/failed notice is baked into the model-facing stdout text and the
  fs error message, so the native renderers pass it through.

## What was validated

```bash
cd spike
npm test          # gate, fs fence + native write tool, executor surface, registration
npm run test:live # real pwsh + windows-acl runner and native tool layer
```

- runtime gate and session disposal;
- real filesystem fence via the subclass: inside pass, outside intercept once,
  identical re-run allowed, agentless plain denial, ordinary-failure hint;
- pwsh executor surface with stubbed argv: denied probe, full-access re-run,
  exit-0 stderr denial, confined failure, background denial/failure and
  one-shot notice emission;
- **live runner** on Windows: real `windows-acl` confinement around real pwsh
  foreground and background processes — inside write passes, outside write is
  intercepted once and does not happen, the exact re-run writes with full
  access; normal workspace-write and danger-full-access presets are untouched;
- **native tool layer**: the real `dsh-tool-fs` `write` tool throws and passes
  the `FS_SELFCHECK_INTERCEPTED` marker through, and the real `dsh-tool-pwsh`
  plugin (Windows) shows the notice in model-facing text with no generic
  denial marker;
- Cordis registration: the package plugin mounts both replacement services.

Also validated against a real dsh `0.1.0-rc.6` profile:

```bash
# The intended one-package install path, against a scratch DSH_HOME:
dsh plugin --profile web add file:/path/to/dsh-self-checking/spike
dsh --profile web --port 0

# Without pnpm, a dev-profile copier is available:
npm run install:dev-profile -- --dsh-home "$DSH_HOME" --profile spike

dsh --profile spike --dump-default-config
dsh --profile spike --port 0
```

`dsh plugin add` appends the bundle to `dsh.profile.bundles`; both boot paths
activate cleanly. `--dump-default-config` shows the three native service rows
disabled and the permission preset inserted.

## Current limitations

1. **The native tool renderer is untouched.** The notice is embedded in
   `stdout` before the native exit-code marker; the real `dsh-tool-pwsh`
   integration test confirms the model-facing text reads naturally, but it is
   not automatically byte-diffed against the fork layer's rendered output.
2. **Live kernel-sandbox coverage is Windows-only.** Real pwsh foreground
   and background runs are covered by `test:live`. Real bash (Linux/macOS),
   Linux bwrap/Landlock, and macOS Seatbelt runs are not covered in this
   environment yet.
3. **No custom permission-picker icon.** That fork is cosmetic only; the
   picker falls back to no glyph for `self-checking`.
4. **Depends on upstream class internals** (`processFacts`, `startArgv`,
   `checkedTarget`), so upgrades to a new dsh baseline still need an
   adaptation pass, although no module shadowing is involved.
5. **Preset detection is log-based.** `permissionPresets` pins
   `permission/preset` at session creation, so this is equivalent for normal
   sessions; an exotic caller that only appends `sandbox/mode` without the
   preset event would not be detected.
6. **Terminal/persistent shell:** with the preset's `workspace-write` standing
   mode they stay confined by the native code, which matches the fork layer's
   terminal policy. No intercept/re-run is offered there (same as the fork).

## If this is promoted

- Move the spike package to a real npm package (drop `private`, add
  `@deepseek-ai/dsh-*` peer ranges).
- Replace `profile/` + `built-fork` with `dsh plugin --profile <name> add
  dsh-self-checking` installation.
- Port the full `tests/verify-self-checking.mjs` semantic suite, adding live
  runner cases for bash/pwsh/Windows ACL.
- Decide whether to keep the client-ui icon fork or accept the missing glyph.
