# Install the Self Checking dsh profile (Windows / PowerShell).
# Works from the repository checkout or the release archive — the layout is
# the same. `profile/` in the repo ships WITHOUT node_modules (build artifact,
# gitignored); this script assembles it from `profile/forks/` after copying.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-Profile self-checking] [-DshHome <path>] [-Force]
param(
  [string]$Profile = "self-checking",
  [string]$DshHome = "$env:USERPROFILE\.dsh",
  [switch]$Force
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $here "profile"
$dest = Join-Path $DshHome "profiles\$Profile"

if (-not (Test-Path $src)) { Write-Error "profile template not found next to this script: $src"; exit 1 }
if (Test-Path $dest) {
  if (-not $Force) { Write-Error "profile '$Profile' already exists at $dest (use -Force to overwrite)"; exit 1 }
  Remove-Item $dest -Recurse -Force
}
New-Item -ItemType Directory -Force (Split-Path -Parent $dest) | Out-Null
Copy-Item $src $dest -Recurse
Copy-Item (Join-Path $here "verify.mjs") $dest -Force

# Assemble the fork layer: profile/forks is the source of truth; node_modules
# is generated (or created by `dsh plugin --profile X install`).
$forkSource = Join-Path $dest "forks"
$forkTarget = Join-Path $dest "node_modules\@deepseek-ai"
if (-not (Test-Path $forkSource)) { Write-Error "fork sources missing at $forkSource"; exit 1 }
if (-not (Test-Path (Join-Path $forkTarget "dsh-sandbox"))) {
  New-Item -ItemType Directory -Force $forkTarget | Out-Null
  Get-ChildItem $forkSource -Directory | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $forkTarget $_.Name) -Recurse -Force
  }
  Write-Host "assembled fork layer ($((Get-ChildItem $forkTarget -Directory).Count) packages)"
} else {
  Write-Host "fork layer already present"
}

Write-Host "installed profile at $dest"
Write-Host "optional: manage the fork layer with pnpm instead — run: dsh plugin --profile $Profile install"

# requirement check: a dsh 0.1.1-rc.2 install must provide the pristine baseline
$fallback = Join-Path $DshHome "profiles\node_modules\@deepseek-ai"
if (-not (Test-Path (Join-Path $fallback "dsh-sandbox"))) {
  Write-Warning "pristine @deepseek-ai install not found at $fallback — run any dsh profile once (or install dsh 0.1.1-rc.2) so the shared module fallback exists"
}
Write-Host "running verification..."
node (Join-Path $dest "verify.mjs") --profile $dest
if ($LASTEXITCODE -ne 0) { Write-Error "verification failed"; exit $LASTEXITCODE }
Write-Host ""
Write-Host "done. Start it with:"
Write-Host "  npx @deepseek-ai/dsh --profile $Profile"
