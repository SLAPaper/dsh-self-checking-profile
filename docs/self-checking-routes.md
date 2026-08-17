# Decision record: Self Checking delivery routes

Status: accepted for the current dsh baseline (`0.1.0-rc.6`).

## Background

Self Checking can be delivered two ways:

1. **Plugin route (`plugin/`)** — a single dsh bundle package whose host
   plugin subclasses the upstream sandbox shell/fs services. The
   `self-checking` permission preset reuses the existing `workspace-write`
   sandbox knob.
2. **Legacy profile route (`legacy/`)** — a standalone profile with 12
   shadowing forks of `@deepseek-ai` packages and a real `self-checking`
   `SandboxMode`.

## Decision

- Keep **both routes** in this repository.
- Treat the **plugin route** as the primary everyday install path.
- Keep the **legacy route** for byte-reproducible fork archaeology, patch
  generation, and upstream baseline three-way merging.
- **Do not publish `dsh-self-checking` to npm yet.** The local
  `install-plugin.*` scripts install `plugin/` as a `file:` package.
- Keep legacy release packaging (`dsh-profile-self-checking-<version>.zip`)
  under `legacy/`.

## Comparison summary

| | Plugin | Legacy |
|---|---|---|
| Delivery unit | one bundle package | profile + 12 forks |
| Sandbox implementation | existing `workspace-write` + service subclass | new `self-checking` mode in forked executors/fence |
| Upstream dependency | peer deps on upstream classes | vendored snapshot + fork + patches |
| Installation | `dsh plugin add` | profile copy + fork assembly |
| Failure mode if layer absent | fails closed to `workspace-write + ask` | fails loud |
| Upgrade path | bump peers, rerun plugin tests | three-way merge + patch rebuild |
| Real-runner coverage | Windows pwsh live tests; bash stub coverage | Windows ACL probes; platform-independent code |

## Acceptance criteria

- Both installers must verify their installed profile automatically.
- Plugin route model-facing behavior is accepted when the native tool-layer
  tests show the defensive markers and exact-retry unlock; byte-identical
  output with the legacy renderer is not required.
- Linux/macOS live tests are accepted as unavailable in the current
  environment.
- Emoji (`🛡️🔍`) picker decoration is accepted instead of an SVG glyph.

## Rollback

- Plugin route users: remove the package and its bundle entry, or stop using
  that profile. The preset then disappears.
- Legacy route users: keep using the existing profile; the two routes do not
  shadow each other when installed under different profile names.
- If the plugin route proves unmaintainable after an upstream upgrade, switch
  the root README back to the legacy route as primary and archive `plugin/`.

## Manual acceptance checklist (pre-publish)

- [ ] Select `🛡️🔍 Self Checking` in the web picker.
- [ ] Inside-workspace write/command succeeds on the first attempt.
- [ ] Outside-workspace write/command is intercepted once and does not happen.
- [ ] After the user says the access is intentional, re-running the exact same
      command/operation succeeds with full access.
- [ ] A confined non-zero failure produces the `[sandbox: self-check failed ...]`
      notice.
- [ ] Switching to plain `workspace-write` restores a normal denial + escalation
      hint.
- [ ] Switching to `danger-full-access` disables all Self Checking behavior.
- [ ] `dsh-self-checking-verify --profile <name> --strict` passes.

## Release notes (current)

- No npm publish yet.
- Legacy zip output moved to `legacy/`.
- Version strategy: plugin package follows its own `0.1.x`; legacy zip keeps
  the dsh baseline suffix (`dsh-profile-self-checking-<dsh-version>.zip`).

## Migration

- Existing fork-profile installs keep working unchanged.
- New installs should prefer `install-plugin.sh` / `install-plugin.ps1`.
- Do not install the plugin into the legacy `self-checking` profile; use a
  separate profile name (default `web`) for the plugin route.
