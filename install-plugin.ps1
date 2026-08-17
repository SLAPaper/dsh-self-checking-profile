# Plugin installation route (local checkout, no npm publish required).
# Usage: powershell -ExecutionPolicy Bypass -File install-plugin.ps1 [-Profile web] [-DshHome <path>]
param(
  [string]$Profile = "web",
  [string]$DshHome = "$env:USERPROFILE\.dsh"
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginDir = Join-Path $here "plugin"
if (-not (Test-Path $pluginDir)) { Write-Error "plugin package not found: $pluginDir"; exit 1 }
$pluginSpec = "file:$($pluginDir.Replace('\', '/'))"

$env:DSH_HOME = $DshHome
$dsh = Get-Command dsh -ErrorAction SilentlyContinue
Write-Host "adding $pluginSpec to profile $Profile (DSH_HOME=$DshHome) ..."
if ($null -ne $dsh) {
  & $dsh.Source plugin --profile $Profile add $pluginSpec
} else {
  & npx --yes @deepseek-ai/dsh plugin --profile $Profile add $pluginSpec
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$verify = Join-Path $DshHome "profiles\$Profile\node_modules\dsh-self-checking\scripts\verify-installed.mjs"
if (Test-Path $verify) {
  Write-Host "running installed-profile verification..."
  $env:DSH_HOME = $DshHome
  & node $verify --profile $Profile --dsh-home $DshHome --strict
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else {
  Write-Warning "installed verifier not found at $verify"
}

Write-Host ""
Write-Host "done. Restart dsh web, then hard-refresh the browser."
Write-Host "Start with: npx @deepseek-ai/dsh --profile $Profile"
