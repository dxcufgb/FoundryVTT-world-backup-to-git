<#
.SYNOPSIS
Installs the built installer silently on this (disposable, elevated) Windows machine, checks that the service answers,
then uninstalls it again. Used by CI; do not run it on a machine whose real service you care about.

.EXAMPLE
.\packaging\windows\smoke-test.ps1 -Installer dist\foundry-world-backup-1.2.0-setup.exe
#>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Installer)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$Installer = (Resolve-Path -LiteralPath $Installer).Path
$data = Join-Path $env:ProgramData 'FoundryWorldBackup'
$app = Join-Path $env:ProgramFiles 'FoundryWorldBackup'
# A fake Foundry user data folder with one world.
$foundry = Join-Path $env:TEMP 'fwb-smoke-foundry'
if (Test-Path -LiteralPath $foundry) { Remove-Item -LiteralPath $foundry -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $foundry 'Data\worlds\smoke-world\packs') -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $foundry 'Data\worlds\smoke-world\world.json'), '{"title":"Smoke World","system":"dnd5e"}')
[IO.File]::WriteAllText((Join-Path $foundry 'Data\worlds\smoke-world\packs\actors.ldb'), 'actors')

function Show-Log {
    foreach ($f in @((Join-Path $app 'install.log'), (Join-Path $data 'logs\service.log'), (Join-Path $env:TEMP 'fwb-setup.log'))) {
        if (Test-Path -LiteralPath $f) { Write-Output "---- $f"; Get-Content -LiteralPath $f }
    }
}

# One HTTPS request to the admin page with the self-signed certificate accepted; returns [status, body].
function Invoke-Admin([string]$Method, [string]$Path, [string]$Body, [string]$Cookie, [string]$Csrf) {
    $node = "$env:ProgramFiles\FoundryWorldBackup-Node\node.exe"
    $script = @"
const https = require('https');
const body = process.argv[2];
const req = https.request({ host: 'localhost', port: 8484, path: process.argv[1], method: process.argv[3], rejectUnauthorized: false,
  headers: { 'Content-Type': 'application/json', Cookie: process.argv[4], 'X-CSRF-Token': process.argv[5] } }, (r) => {
  let data = ''; r.on('data', (c) => data += c);
  r.on('end', () => console.log(JSON.stringify({ status: r.statusCode, cookie: (r.headers['set-cookie'] || [''])[0].split(';')[0], body: data })));
});
req.on('error', (e) => console.log(JSON.stringify({ status: 0, body: e.message })));
if (body) req.write(body);
req.end();
"@
    $out = & $node -e $script -- $Path $Body $Method $Cookie $Csrf
    "$out" | ConvertFrom-Json
}

try {
    # The token is fake: the service only has to be up and list the world (the backup itself would fail).
    $env:FOUNDRY_BACKUP_GITHUB_TOKEN = 'github_pat_smoke_test_not_a_real_token'
    $adminPassword = 'smoke-test-admin-password'
    $env:FOUNDRY_BACKUP_ADMIN_PASSWORD = $adminPassword
    $p = Start-Process -FilePath $Installer -Wait -PassThru -ArgumentList @(
        '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=$(Join-Path $env:TEMP 'fwb-setup.log')",
        "/FOUNDRYDATA=$foundry")
    if ($p.ExitCode -ne 0) { throw "installer exited with $($p.ExitCode)" }
    Remove-Item Env:FOUNDRY_BACKUP_GITHUB_TOKEN, Env:FOUNDRY_BACKUP_ADMIN_PASSWORD

    foreach ($path in @("$app\src\server.js", "$app\scripts\install-service.ps1", "$env:ProgramFiles\FoundryWorldBackup-Node\node.exe",
            "$data\env", "$data\config.json", "$data\admin.json", "$data\state", "$data\admin-tls.crt")) {
        if (-not (Test-Path -LiteralPath $path)) { throw "missing $path" }
    }
    if ((Get-Content -LiteralPath "$data\env" -Raw) -notmatch 'GIT_BIN=') { throw 'env lacks GIT_BIN' }
    if (-not (Get-ScheduledTask -TaskName 'FoundryWorldBackup')) { throw 'scheduled task FoundryWorldBackup missing' }
    if (-not (Get-NetFirewallRule -Name 'FoundryWorldBackup-Admin' -ErrorAction SilentlyContinue)) { throw 'firewall rule missing' }

    # The admin page answers over HTTPS on 8484 and, after a login, lists the world the service (LOCAL SERVICE) can read.
    $status = 0
    for ($i = 0; $i -lt 30 -and $status -ne 200; $i++) {
        $status = (Invoke-Admin 'GET' '/_admin/' '' '' '').status
        if ($status -ne 200) { Start-Sleep -Seconds 2 }
    }
    if ($status -ne 200) { throw "the admin page https://localhost:8484/_admin/ answered: $status" }
    Write-Output 'admin page answers over HTTPS'
    $login = Invoke-Admin 'POST' '/_admin/api/login' (@{ password = $adminPassword } | ConvertTo-Json -Compress) '' ''
    if ($login.status -ne 200) { throw "login answered $($login.status): $($login.body)" }
    $state = $login.body | ConvertFrom-Json
    if (-not $state.csrf) { throw 'admin login returned no CSRF token' }
    $world = $state.worlds | Where-Object { $_.id -eq 'smoke-world' }
    if (-not $world) { throw "the world list lacks smoke-world: $($login.body)" }
    if (-not $world.readable) { throw "LOCAL SERVICE cannot read the world: $($world.problem)" }
    if (-not $state.token.canChange) { throw "the admin page cannot change the token: $($state.token.problem)" }
    Write-Output 'admin page logs in, lists the world and may change the token'

    # A world setting written by LOCAL SERVICE into config.json.
    $put = Invoke-Admin 'PUT' '/_admin/api/worlds/smoke-world' (@{ enabled = $false } | ConvertTo-Json -Compress) $login.cookie $state.csrf
    if ($put.status -ne 200) { throw "saving a world setting answered $($put.status): $($put.body)" }
    if ((Get-Content -LiteralPath "$data\config.json" -Raw) -notmatch '"smoke-world"') { throw 'the admin page did not write config.json' }
    Write-Output 'admin page saves settings'

    # "Update now": the service (LOCAL SERVICE) may start the SYSTEM task (the update fails: the token is fake).
    $before = (Get-ScheduledTaskInfo -TaskName 'FoundryWorldBackup-UpdateNow').LastRunTime
    $post = Invoke-Admin 'POST' '/_admin/api/update' '{}' $login.cookie $state.csrf
    if ($post.status -ne 202) { throw "update request answered $($post.status): $($post.body)" }
    $ran = $false
    for ($i = 0; $i -lt 30 -and -not $ran; $i++) {
        Start-Sleep -Seconds 2
        $ran = (Get-ScheduledTaskInfo -TaskName 'FoundryWorldBackup-UpdateNow').LastRunTime -ne $before
    }
    if (-not $ran) { throw 'the admin page could not start the FoundryWorldBackup-UpdateNow task' }
    Write-Output 'admin page starts the update task'

    $unins = Get-ChildItem -LiteralPath $app -Filter 'unins*.exe' | Select-Object -First 1
    if (-not $unins) { throw 'uninstaller missing' }
    $p = Start-Process -FilePath $unins.FullName -Wait -PassThru -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART')
    if ($p.ExitCode -ne 0) { throw "uninstaller exited with $($p.ExitCode)" }
    Start-Sleep -Seconds 2
    if (Get-ScheduledTask -TaskName 'FoundryWorldBackup' -ErrorAction SilentlyContinue) { throw 'scheduled task still registered' }
    if (Get-ScheduledTask -TaskName 'FoundryWorldBackup-UpdateNow' -ErrorAction SilentlyContinue) { throw 'update task still registered' }
    if (Test-Path -LiteralPath $app) { throw "$app still exists after uninstall" }
    if (Get-NetFirewallRule -Name 'FoundryWorldBackup-Admin' -ErrorAction SilentlyContinue) { throw 'firewall rule left behind' }
    if (-not (Test-Path -LiteralPath "$data\env")) { throw 'a silent uninstall must keep the token and settings' }
    Write-Output 'install and uninstall OK'
}
catch {
    Show-Log
    throw
}
