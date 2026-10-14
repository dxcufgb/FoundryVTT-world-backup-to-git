<#
.SYNOPSIS
Builds foundry-world-backup-<version>-setup.exe with Inno Setup.

.DESCRIPTION
Run on Windows with Inno Setup 6.3 or newer installed (https://jrsoftware.org/isinfo.php, or `choco install innosetup`):

  .\packaging\windows\build-installer.ps1 [-OutDir dist] [-Version 1.2.3] [-SourceDir <folder>] [-NodeMajor 22]

It downloads the newest Node.js <NodeMajor>.x for Windows x64 from nodejs.org, checks it against the SHA-256 that
nodejs.org publishes, and compiles foundry-world-backup.iss into OutDir. The files come from SourceDir (default: this
repository; release.yml passes the unpacked Windows archive). With -Version they are packed from a staged copy whose
package.json carries that version (the source is not changed); without it the version is the one in package.json.
scripts/build-release.sh adds the fixed-name and legacy copies and the checksums.
#>
[CmdletBinding()]
param(
    [string]$OutDir = 'dist',
    [string]$Version,
    [string]$SourceDir,
    [int]$NodeMajor = 22
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$SemVer = '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$'
if (-not $SourceDir) { $SourceDir = Join-Path $PSScriptRoot '..\..' }
$root = (Resolve-Path -LiteralPath $SourceDir).Path
$sourceVersion = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
if ($Version) { $version = $Version -replace '^v', '' } else { $version = $sourceVersion }
if ($version -cnotmatch $SemVer) { throw "version '$version' is not MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-PRERELEASE" }

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$work = Join-Path ([IO.Path]::GetTempPath()) ("fwb-installer-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null

try {
    if ($version -ne $sourceVersion) {
        # Stamp the version into a staged copy only (the first "version" field, the top-level one).
        $stage = Join-Path $work 'app'
        New-Item -ItemType Directory -Path $stage | Out-Null
        foreach ($item in @('src', 'scripts', 'package.json', 'README.md', 'config.example.json', '.env.example')) {
            Copy-Item -LiteralPath (Join-Path $root $item) -Destination $stage -Recurse
        }
        $package = Join-Path $stage 'package.json'
        $text = [IO.File]::ReadAllText($package)
        $text = ([regex]'"version"\s*:\s*"[^"]*"').Replace($text, "`"version`": `"$version`"", 1)
        [IO.File]::WriteAllText($package, $text, (New-Object System.Text.UTF8Encoding $false))
        if ((Get-Content -LiteralPath $package -Raw | ConvertFrom-Json).version -ne $version) {
            throw "could not stamp version $version into package.json"
        }
        $root = $stage
    }

    # Node.js: newest <NodeMajor>.x win-x64 zip, verified against nodejs.org's SHASUMS256.txt.
    $dist = "https://nodejs.org/dist/latest-v$NodeMajor.x"
    $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$dist/SHASUMS256.txt").Content -split "`n"
    $line = $sums | Where-Object { $_ -match ' node-v[\d.]+-win-x64\.zip\s*$' } | Select-Object -First 1
    if (-not $line) { throw "nodejs.org lists no win-x64 zip for Node.js $NodeMajor" }
    $expected, $zipName = ($line.Trim() -split '\s+')
    $zip = Join-Path $work $zipName
    Invoke-WebRequest -UseBasicParsing -Uri "$dist/$zipName" -OutFile $zip
    $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
    if ($actual -ne $expected.ToUpperInvariant()) { throw "SHA-256 mismatch for $zipName (expected $expected, got $actual)" }
    Expand-Archive -LiteralPath $zip -DestinationPath $work
    $nodeDir = Join-Path $work ([IO.Path]::GetFileNameWithoutExtension($zipName))
    $nodeExe = Join-Path $nodeDir 'node.exe'
    $nodeLicense = Join-Path $nodeDir 'LICENSE'
    if (-not (Test-Path -LiteralPath $nodeExe) -or -not (Test-Path -LiteralPath $nodeLicense)) {
        throw "$zipName does not contain node.exe and LICENSE"
    }
    Write-Information "Using $zipName" -InformationAction Continue

    $iscc = @(
        (Get-Command ISCC.exe -ErrorAction SilentlyContinue | ForEach-Object { $_.Source }),
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
        (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
    if (-not $iscc) { throw 'ISCC.exe not found. Install Inno Setup 6 (choco install innosetup).' }

    & $iscc "/DAppVersion=$version" "/DRepoRoot=$root" "/DNodeExe=$nodeExe" "/DNodeLicense=$nodeLicense" "/O$OutDir" `
        (Join-Path $PSScriptRoot 'foundry-world-backup.iss')
    if ($LASTEXITCODE -ne 0) { throw "ISCC failed with exit code $LASTEXITCODE" }

    $exe = Join-Path $OutDir "foundry-world-backup-$version-setup.exe"
    if (-not (Test-Path -LiteralPath $exe)) { throw "ISCC did not produce $exe" }
    Write-Information "Built $exe" -InformationAction Continue
}
finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
