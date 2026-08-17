# dsh Self Checking

![Self Checking option in the input permission picker](legacy/docs/self-checking-permission-picker.png)

[中文](README.zh-CN.md) | English

This repository ships **Self Checking** for [DeepSeek Harness / dsh](https://github.com/deepseek-ai/deepseek-harness)
through two installable routes:

- **Plugin route (`plugin/`)** — one normal dsh bundle package,
  `dsh-self-checking`, installed with `dsh plugin add`.
- **Legacy profile route (`legacy/`)** — a reproducible fork layer over the
  upstream `@deepseek-ai` packages, installed as a standalone profile.

Both routes expose the same permission preset (**🛡️🔍 Self Checking** in the
web picker, `/permission self-checking` in a session) and the same model-facing
behavior: commands and file operations run under `workspace-write` first; an
access outside the workspace is intercepted once; re-running the exact same
command/operation executes it with full access.

## Quick install

### Plugin route

```bash
# from this checkout
./install-plugin.sh            # defaults to the `web` profile
# or explicitly:
./install-plugin.sh -p web -h ~/.dsh
```

```powershell
powershell -ExecutionPolicy Bypass -File install-plugin.ps1
```

Then start dsh and select **🛡️🔍 Self Checking** in the permission picker.

> The package is not published to npm yet, so `install-plugin.*` installs the
> local `plugin/` directory. The published command will become:
> `dsh plugin --profile web add dsh-self-checking`.

### Legacy profile/fork route

```bash
# from this checkout
./install-legacy.sh                 # profile name: self-checking
npx @deepseek-ai/dsh --profile self-checking
```

```powershell
powershell -ExecutionPolicy Bypass -File install-legacy.ps1
```

See [legacy/README.md](legacy/README.md) for the full fork-rebuild,
patch-generation, and upstream-merge workflow.

## How the two routes differ

| | Plugin route (`plugin/`) | Legacy profile route (`legacy/`) |
|---|---|---|
| Install unit | One bundle package (`dsh-self-checking`) added to an existing profile | A complete profile + 12 shadowing fork packages under `node_modules/@deepseek-ai` |
| How Self Checking works | Preset reuses sandbox `workspace-write`; a host plugin subclasses the upstream shell and fs services and adds the intercept gate | Adds a real `self-checking` sandbox mode to `SANDBOX_MODES` / `WIDER_MODES`, implemented inside forked executors and fs fence |
| Upstream packages | Used as-is through peer dependencies; the plugin imports upstream service classes | Vendored byte-for-byte under `upstream/`, forked in `profile/forks/`, reproducible via `patches/*.json` |
| Install UX | `dsh plugin --profile web add dsh-self-checking` (currently local `file:` via `install-plugin.*`) | `install-legacy.*` copies a profile and assembles the fork layer |
| Picker icon | `🛡️🔍` emoji embedded in the preset name | Dedicated SVG glyph forked into `dsh-client-ui-conversation` |
| `sandbox_permissions` enum | `workspace-write`, `danger-full-access` only; Self Checking is a preset, not a mode | `workspace-write`, `self-checking`, `danger-full-access` |
| Session log `sandbox/mode` | `workspace-write` while the preset is active | `self-checking` |
| Degradation if the layer is missing | Fails closed: the preset degrades to plain `workspace-write + ask` | Fails loud at profile load / execution |
| Baseline upgrade | Bump package peer ranges and re-run the plugin test suite; adaptation points are the upstream service classes | Three-way merge of `upstream/`, regenerate patches, byte-for-byte rebuild |

Model-facing semantics are intentionally the same: the intercepted/failed
markers, the one-time exact re-run unlock, the defensive fs failure hint, and
the explicit `sandbox_permissions + justification` approval channel all match.

## Repository layout

```
├── plugin/                      dsh-self-checking bundle package (new route)
│   ├── lib/                     host plugin + shell/fs service subclasses
│   ├── cordis.patch.yml         disables native service rows, adds the preset
│   ├── scripts/                 dev-profile installer and installed verifier
│   └── tests/                   unit, Cordis, native tool-layer, live runner
├── legacy/                      original fork/profile route
│   ├── profile/forks/           12 shadowing fork packages
│   ├── upstream/                byte-exact upstream baseline (0.1.0-rc.6)
│   ├── patches/                 anchored patch manifests + review diffs
│   ├── tools/                   snapshot / merge / gen-patches / rebuild / release
│   ├── tests/                   legacy regression + ACL probes
│   ├── install.sh / install.ps1
│   ├── verify.mjs
│   └── docs/                    picker screenshot used by the legacy README
├── install-plugin.sh / .ps1     plugin-route installer (local file package)
├── install-legacy.sh / .ps1     wrappers around legacy/install.*
├── docs/self-checking-routes.md delivery decision record
├── CHANGELOG.md
└── LICENSE
```

## Which route should I use?

- Use the **plugin route** for everyday installation and testing.
- Use the **legacy route** when you need the byte-reproducible fork layer,
  upstream-baseline archaeology, or the exact `self-checking` sandbox mode in
  the session log and escalation vocabulary.

## Requirements

- dsh **0.1.0-rc.6** (run any dsh profile once first so
  `~/.dsh/profiles/node_modules` exists);
- Windows, macOS, or Linux. The plugin route's real-runner test coverage is
  currently Windows-only; the legacy route is platform-independent.

## Development

```bash
# Plugin route
cd plugin
npm test
npm run test:live    # real Windows pwsh + windows-acl runner

# Legacy route
node legacy/tests/verify-self-checking.mjs
node legacy/tests/verify-acl-probe.mjs    # real Windows ACL probe
```

See [plugin/README.md](plugin/README.md), [legacy/README.md](legacy/README.md),
and [docs/self-checking-routes.md](docs/self-checking-routes.md).
