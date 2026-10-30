# Copies the live mod from Herdr's home into this repo (Herdr only hot-reloads real files there).
$ErrorActionPreference = 'Stop'
$home_ = if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $HOME '.config/herdr-app' }
$src = Join-Path $home_ 'mods/perforce'
$dst = Join-Path $PSScriptRoot '../mods/perforce'
# herdr-app is a GUI-subsystem exe: pipe it so PowerShell waits for its exit code.
herdr-app check $src 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { throw "herdr-app check failed" }
robocopy $src $dst /MIR /XF gpui-kit.d.ts jsconfig.json /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
Write-Host "Copied $src -> $dst"
