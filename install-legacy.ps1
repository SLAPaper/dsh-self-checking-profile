# Legacy profile/fork installation route.
# Thin wrapper: forwards arguments to legacy/install.ps1.
param(
  [string]$Profile = "self-checking",
  [string]$DshHome = "$env:USERPROFILE\.dsh",
  [switch]$Force
)
$ErrorActionPreference = "Stop"
$installer = Join-Path $PSScriptRoot "legacy\install.ps1"
& $installer -Profile $Profile -DshHome $DshHome -Force:$Force
exit $LASTEXITCODE
