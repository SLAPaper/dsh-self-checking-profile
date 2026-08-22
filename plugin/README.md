# dsh-self-checking

A single-package DeepSeek Harness (dsh) permission preset that keeps the
Self Checking semantics from the fork profile without shadowing any
`@deepseek-ai/*` package: commands and file operations run under
`workspace-write` first; an outside-workspace access is intercepted once, and
re-running the exact same command/operation executes with full access.

## Install

Requirements:

- dsh `0.1.1-rc.2` (run `npx @deepseek-ai/dsh@0.1.1-rc.2` once so the shared profile
  fallback exists).

Once published:

```bash
dsh plugin --profile web add dsh-self-checking
dsh web
```

Then select **🛡️🔍 Self Checking** in the permission picker or run
`/permission self-checking`.

Until the package is published, the same path works from this checkout:

```bash
dsh plugin --profile web add file:/path/to/dsh-self-checking/plugin
```

Restart dsh web and hard-refresh the browser after changing the bundle list.

## Verify an installed profile

```bash
dsh-self-checking-verify --profile web --strict
# or, without the bin link:
node <profile>/node_modules/dsh-self-checking/scripts/verify-installed.mjs \
  --profile <profile> --dsh-home "$DSH_HOME" --strict
```

The verifier checks the profile bundle list, the installed package, and the
composed dsh config (native service rows disabled, preset and plugin row
present).

## Design

- `self-checking` is a permission **preset** whose sandbox knob is the
  existing `workspace-write` + `approval: ask`. No `SANDBOX_MODES` change.
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
cd plugin
npm test          # gate, fs fence + native write/edit tools, registration
npm run test:live # real pwsh + windows-acl runner and native pwsh tool layer
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
- **native tool layer**: the real `dsh-tool-fs` `write`/`edit` tools throw and
  pass the `FS_SELFCHECK_INTERCEPTED` marker through, an ordinary `edit`
  failure keeps its structured code plus the self-check hint, and the real
  `dsh-tool-pwsh` plugin (Windows) shows the notice in model-facing text with
  no generic denial marker; both native tool layers keep the explicit
  `sandbox_permissions=danger-full-access` + approval channel working;
- **same-session preset switching**: appending workspace-write or
  danger-full-access permission events to the same session immediately turns
  the gate off and restores native behavior;
- Cordis registration: the package plugin mounts both replacement services.

Also validated against a real dsh `0.1.1-rc.2` profile:

```bash
# The intended one-package install path, against a scratch DSH_HOME:
dsh plugin --profile web add file:/path/to/dsh-self-checking/plugin
dsh --profile web --port 0

# Without pnpm, a dev-profile copier is available:
npm run install:dev-profile -- --dsh-home "$DSH_HOME" --profile self-checking

dsh --profile self-checking --dump-default-config
dsh --profile self-checking --port 0
```

`dsh plugin add` appends the bundle to `dsh.profile.bundles`; both boot paths
activate cleanly. `--dump-default-config` shows the three native service rows
disabled and the permission preset inserted.

## Known limitations / accepted differences

1. **The native tool renderer is untouched.** The notice is embedded in
   `stdout` before the native exit-code marker. Byte-identical output with
   the fork layer is explicitly NOT a goal: acceptance is that the model sees
   the same defensive guidance in real tool results. The real
   `dsh-tool-pwsh` integration test covers exactly that path.
2. **Live kernel-sandbox coverage is Windows-only.** Real pwsh foreground
   and background runs are covered by `test:live`. Linux bwrap/Landlock and
   macOS Seatbelt live runs are not covered because this project has no
   Linux/macOS environment; the bash subclass currently has surface/stub
   coverage only. This is an accepted environmental limitation.
3. **No custom SVG permission-picker icon.** The preset name embeds
   `🛡️🔍` emojis instead (shield + magnifier, matching the fork glyph's
   intent), which the picker renders because non-kebab host names pass
   through `displayName` unchanged. Accepted as a decorative difference.
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

## Upgrading to a new dsh baseline

1. Bump the `@deepseek-ai/dsh-*` peer ranges in `package.json`.
2. Run `npm test` and (on Windows) `npm run test:live`.
3. Install into a scratch profile with `dsh plugin --profile web add
   file:/path/to/dsh-self-checking/plugin`, boot with `--port 0`, and run
   `verify-installed.mjs --strict`.
4. Review the tool-layer test output by hand: the model-facing notice must
   still appear, with no generic denial marker, and the exact re-run must
   succeed.

Upstream internals this package relies on:

- `SandboxBashExecutor` / `SandboxPwshExecutor`: `run`, `start`,
  `processFacts`, `onProcessDone`, inherited `runArgv`/`startArgv`, and
  `confine`.
- `SandboxedFileSystem`: `writeText`, `editText`, `checkedTarget`, and the
  `FS_SANDBOX_DENIED` error code contract.
- dsh tool renderers: `dsh-tool-pwsh` canonical result/rendering must keep
  accepting the native sandbox fields while ignoring our extra flags.
- `dsh-sandbox-policy`: resolved policies must keep carrying
  `mode`/`workspaceRoot`/`sessionId`.
- `dsh-permission-presets`: session creation must keep pinning a
  `permission/preset` event.

## Development without pnpm

`npm test` links the local dsh fallback packages into `node_modules/` via
`scripts/link-test-deps.mjs`; `npm run install:dev-profile` copies this
package into a local profile for boot testing.
