#!/usr/bin/env pwsh
# codex-cursor-bridge installer (release archive) for Windows.
# Idempotent; supports -DryRun and -Force. Never assumes a specific shell
# beyond PowerShell itself.

[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Force,
  [switch]$PluginsOnly,
  [switch]$CliOnly,
  [string]$BinDir = "$env:LOCALAPPDATA\Programs\codex-cursor-bridge"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Invoke-Step {
  param([string]$Description, [scriptblock]$Action)
  if ($DryRun) { Write-Host "dry-run: $Description" }
  else { & $Action }
}

# node check
$nodeOk = $false
try {
  $v = & node -p 'process.versions.node.split(".")[0]' 2>$null
  if ($LASTEXITCODE -eq 0 -and [int]$v -ge 20) { $nodeOk = $true }
} catch { $nodeOk = $false }
if (-not $nodeOk) { throw "Node.js >= 20.19 is required: https://nodejs.org" }

if (-not $PluginsOnly) {
  $bundle = Join-Path $ScriptDir "codex-cursor-bridge.mjs"
  if (-not (Test-Path $bundle)) {
    $bundle = Join-Path $ScriptDir "..\bundles\codex-cursor-bridge.mjs"
  }
  if (-not (Test-Path $bundle)) { throw "codex-cursor-bridge.mjs not found next to install.ps1 (use the release archive or build the repo)" }
  Invoke-Step "create $BinDir" -Action { New-Item -ItemType Directory -Force -Path $BinDir | Out-Null }
  $dest = Join-Path $BinDir "codex-cursor-bridge.cmd"
  if ((Test-Path $dest) -and -not $Force) {
    Write-Host "existing CLI found at $dest (use -Force to overwrite)"
  } else {
    $shim = @"
@echo off
node "%~dp0codex-cursor-bridge.mjs" %*
"@
    Invoke-Step "write $dest" -Action { Set-Content -Path $dest -Value $shim -Encoding ASCII }
    Invoke-Step "copy bundle" -Action {
      Copy-Item $bundle (Join-Path $BinDir "codex-cursor-bridge.mjs") -Force
    }
    Write-Host "installed CLI: $dest"
    Write-Host "note: add $BinDir to your PATH"
  }
}

if (-not $CliOnly) {
  $cursorPlugins = "$env:USERPROFILE\.cursor\plugins\local"
  $codexPlugins  = "$env:USERPROFILE\.codex\plugins"
  $archivePlugins = Join-Path $ScriptDir "plugins"
  $repoPlugins = Join-Path $ScriptDir "..\plugins"
  $pluginRoot = if (Test-Path (Join-Path $archivePlugins "cursor-delegates-to-codex")) { $archivePlugins }
    elseif (Test-Path (Join-Path $repoPlugins "cursor-delegates-to-codex")) { $repoPlugins }
    else { throw "plugin sources not found next to install.ps1" }
  $pairs = @(
    @{ Src = Join-Path $pluginRoot "cursor-delegates-to-codex"; Dest = Join-Path $cursorPlugins "codex-cursor-bridge"; Name = "Cursor" },
    @{ Src = Join-Path $pluginRoot "codex-plans-cursor-executes"; Dest = Join-Path $codexPlugins "codex-cursor-bridge"; Name = "Codex" }
  )
  foreach ($p in $pairs) {
    if (-not (Test-Path $p.Src)) { throw "plugin source missing: $($p.Src)" }
    if ((Test-Path $p.Dest) -and -not $Force) {
      Write-Host "plugin already present: $($p.Dest) (use -Force to replace)"
      continue
    }
    Invoke-Step "install $($p.Name) plugin to $($p.Dest)" -Action {
      if (Test-Path $p.Dest) {
        $backup = "$($p.Dest).bak.$(Get-Date -UFormat %s)"
        Rename-Item $p.Dest $backup
      }
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $p.Dest) | Out-Null
      Copy-Item -Recurse -Path $p.Src -Destination $p.Dest
    }
  }
}

Write-Host ""
Write-Host "next steps:"
Write-Host "  1. run: codex-cursor-bridge doctor"
Write-Host "  2. restart Cursor / Codex so the plugins are discovered"
