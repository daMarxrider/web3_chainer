# Installs everything chainer needs on Windows and checks that it works.
# Uses winget, which ships with Windows 10 and 11. Safe to run again.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1

$ErrorActionPreference = 'Stop'
$NodeMajor = 24
$Repo = Split-Path -Parent $PSScriptRoot

function Say($Message) { Write-Host "`n==> $Message" }

function Update-Path {
    # Programs installed by winget are not visible to this session until PATH is re-read.
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Get-NodeMajor {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return 0 }
    return [int](node -p 'process.versions.node.split(".")[0]')
}

function Install-Package($Id) {
    winget install --id $Id --exact --silent --accept-package-agreements --accept-source-agreements
    # winget exits with -1978335189 when the package is already installed and current.
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) { throw "winget could not install $Id (exit code $LASTEXITCODE)" }
}

function Invoke-Checked($Description, [scriptblock]$Command) {
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$Description failed (exit code $LASTEXITCODE)" }
}

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw 'winget was not found. Install "App Installer" from the Microsoft Store, then run this script again.'
}

# ---- packages -------------------------------------------------------------

Say 'Installing packages with winget'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Install-Package 'Git.Git' }
if ((Get-NodeMajor) -lt $NodeMajor) { Install-Package 'OpenJS.NodeJS.LTS' }
Update-Path

if ((Get-NodeMajor) -lt $NodeMajor) {
    throw "Node.js $NodeMajor or newer is still not on the PATH. Open a new terminal and run this script again."
}
Write-Host "Node.js $(node --version), npm $(npm --version)"

# ---- project --------------------------------------------------------------

Say "Installing the project's packages"
Set-Location $Repo
Invoke-Checked 'npm ci' { npm ci }

Say 'Running the tests'
Invoke-Checked 'npm test' { npm test }

Say 'Adding the chainer command'
# This folder is on every user's PATH by default.
$Shim = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\chainer.cmd'
Set-Content -Path $Shim -Encoding ASCII -Value "@echo off`r`nnode `"$Repo\apps\cli\src\main.ts`" %*"
Invoke-Checked 'chainer --help' { & $Shim --help | Out-Null }

Say 'Done. chainer is installed. Try it: chainer --help'
Write-Host 'Tor is not installed by this script: winget has no standalone Tor package.'
Write-Host 'To route chainer through Tor, start Tor Browser (or the Tor expert bundle) and run:'
Write-Host '  chainer config set proxy socks5://127.0.0.1:9150'
