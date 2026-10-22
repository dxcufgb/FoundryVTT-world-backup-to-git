<#
.SYNOPSIS
Installs (or removes) the Foundry world backup on Windows as a scheduled task that starts at boot.

.DESCRIPTION
Run from an elevated Windows PowerShell 5.1 (or newer) prompt in the unpacked release folder:

  .\scripts\install-service.ps1 -FoundryData C:\Users\me\AppData\Local\FoundryVTT   # first install
  .\scripts\install-service.ps1                      install or update the code, then (re)start
  .\scripts\install-service.ps1 -AutoUpdate          same, and turn on automatic updates
  .\scripts\install-service.ps1 -EnableAutoUpdate    turn automatic updates on for an existing install
  .\scripts\install-service.ps1 -DisableAutoUpdate   turn them off again
  .\scripts\install-service.ps1 -Check               is a newer release available? (report only)
  .\scripts\install-service.ps1 -UpdateNow           install the latest release now
  .\scripts\install-service.ps1 -Uninstall           remove tasks, updater and code (keeps settings, env and state)
  .\scripts\install-service.ps1 -GrantAccess         let the service read the worlds folder again (ACL)
  .\scripts\install-service.ps1 -SetAdminPassword    change the password of the administration page
  .\scripts\install-service.ps1 -SetNotify           (re)enter the notification e-mail settings
  .\scripts\install-service.ps1 -RenewAdminCert      a new self-signed certificate for the admin page

Layout (settings and env are created once and never overwritten):
  C:\Program Files\FoundryWorldBackup\               code (replaced on every run)
  C:\Program Files\FoundryWorldBackup.prev\          previous code, kept by the updater for rollback
  C:\ProgramData\FoundryWorldBackup\config.json      schedule and per-world settings (LOCAL SERVICE rewrites it: admin page)
  C:\ProgramData\FoundryWorldBackup\admin.json       admin page password hash + notification e-mail settings
                                                    (Administrators/SYSTEM + LOCAL SERVICE read/write)
  C:\ProgramData\FoundryWorldBackup\env              GITHUB_TOKEN, FOUNDRY_DATA, ADMIN_PORT, ... (Administrators/SYSTEM +
                                                    LOCAL SERVICE read/write: the admin page rewrites its GITHUB_TOKEN line)
  C:\ProgramData\FoundryWorldBackup\state\           one git directory per world (repos\) and status.json (LOCAL SERVICE
                                                    read/write)
  C:\ProgramData\FoundryWorldBackup\admin-tls.crt/.key  self-signed certificate of the admin page
  C:\ProgramData\FoundryWorldBackup\logs\service.log service log
  C:\ProgramData\FoundryWorldBackup\auto-update.conf, auto-update.log, updater-token (Administrators/SYSTEM only)

The service runs as the scheduled task "FoundryWorldBackup" under LOCAL SERVICE (node --env-file, Node.js >= 20.6) and
reads the worlds folder through an ACL this script sets (LOCAL SERVICE: read). git must be installed for all users
(Git for Windows); its path goes into env as GIT_BIN. The admin page is served on ADMIN_PORT (default 8484) with
HTTPS; -FoundryData / FOUNDRY_BACKUP_DATA names the Foundry user data folder (the one with Config, Data and Logs).
The updater runs daily (random delay) as the task "FoundryWorldBackup-Update" under SYSTEM. "Update now" on the admin
page starts the task "FoundryWorldBackup-UpdateNow" (SYSTEM, no schedule; LOCAL SERVICE may only run it).
Tokens come from a hidden prompt or the FOUNDRY_BACKUP_GITHUB_TOKEN / UPDATER_GITHUB_TOKEN environment variables,
never from the command line. The same goes for the admin page password (FOUNDRY_BACKUP_ADMIN_PASSWORD, required on a
first install) and the notification settings (FOUNDRY_BACKUP_NOTIFY_EMAILS, FOUNDRY_BACKUP_SMTP_HOST, _PORT, _SECURITY,
_USER, _PASSWORD, _FROM). FOUNDRY_BACKUP_ADMIN_PORT, FOUNDRY_BACKUP_ADMIN_PUBLIC_URL and FOUNDRY_BACKUP_FOUNDRY_URL set
the admin port, its public address and where Foundry answers (default http://localhost:30000).
Automatic updates need no token (the repository is public); UPDATER_GITHUB_TOKEN, or else the service's GITHUB_TOKEN,
is only used to raise GitHub's rate limit.
#>
[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$AutoUpdate,
    [switch]$NoAutoUpdate,
    [switch]$EnableAutoUpdate,
    [switch]$DisableAutoUpdate,
    [switch]$Check,
    [switch]$UpdateNow,
    [switch]$GrantAccess,
    [switch]$SetAdminPassword,
    [switch]$SetNotify,
    [switch]$RenewAdminCert,
    # Non-interactive re-install that keeps every setting; used by the updater.
    [switch]$Upgrade,
    [string]$NodePath,
    [string]$FoundryData,
    [string]$AdminPort
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$InformationPreference = 'Continue'

$AppName = 'FoundryWorldBackup'
$AppDir = Join-Path $env:ProgramFiles $AppName
$BackupDir = "$AppDir.prev"
$DataDir = Join-Path $env:ProgramData $AppName
$LogDir = Join-Path $DataDir 'logs'
$StateDir = Join-Path $DataDir 'state'
$EnvFile = Join-Path $DataDir 'env'
$ConfigFile = Join-Path $DataDir 'config.json'
$AdminFile = Join-Path $DataDir 'admin.json'
$AdminCert = Join-Path $DataDir 'admin-tls.crt'
$AdminKey = Join-Path $DataDir 'admin-tls.key'
$FirewallRule = "$AppName-Admin"
$AutoConf = Join-Path $DataDir 'auto-update.conf'
$UpdaterTokenFile = Join-Path $DataDir 'updater-token'
$TaskName = $AppName
$UpdateTaskName = "$AppName-Update"
$UpdateNowTaskName = "$AppName-UpdateNow"
$UpdateRepo = 'dxcufgb/FoundryVTT-world-backup-to-git'
$DefaultAdminPort = '8484'
$SrcDir = Split-Path -Parent $PSScriptRoot
$Utf8 = New-Object System.Text.UTF8Encoding $false
$IsUpgrade = [bool]$Upgrade
$NodeOverride = $NodePath

# Well-known SIDs, so nothing depends on the Windows display language.
$SidAdmins = 'S-1-5-32-544'
$SidSystem = 'S-1-5-18'
$SidLocalService = 'S-1-5-19'

function Write-BackupLog([string]$Message) {
    Write-Information -MessageData $Message
}

function Get-AccountName([string]$Sid) {
    (New-Object System.Security.Principal.SecurityIdentifier $Sid).Translate([System.Security.Principal.NTAccount]).Value
}

function Test-Interactive {
    -not $IsUpgrade -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
}

# KEY=value from auto-update.conf.
function Get-Setting([string]$Key) {
    if (-not (Test-Path -LiteralPath $AutoConf)) { return '' }
    $value = ''
    foreach ($line in [IO.File]::ReadAllLines($AutoConf)) {
        if ($line.StartsWith("$Key=")) { $value = $line.Substring($Key.Length + 1) }
    }
    $value
}

# Replaces the ACL of a path with exactly the given grants (icacls syntax), with inheritance from the parent cut.
function Protect-Path([string]$Path, [string[]]$Grant) {
    & icacls.exe $Path /reset /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls /reset failed for $Path" }
    $grantArgs = @()
    foreach ($g in $Grant) { $grantArgs += '/grant:r'; $grantArgs += $g }
    & icacls.exe $Path /inheritance:r @grantArgs /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls failed for $Path" }
}

# Files only Administrators and SYSTEM may read (updater token, auto-update.conf).
function Protect-AdminFile([string]$Path) {
    Protect-Path $Path @("*${SidAdmins}:F", "*${SidSystem}:F")
}

# Files the service (LOCAL SERVICE) must only read: the admin page's certificate and key.
function Protect-ServiceFile([string]$Path) {
    Protect-Path $Path @("*${SidAdmins}:F", "*${SidSystem}:F", "*${SidLocalService}:R")
}

# Files the service (LOCAL SERVICE) reads and rewrites in place from the admin page: config.json, admin.json and env.
# (R,W) and no DELETE: it cannot remove or replace them, and it cannot create files in the data folder.
function Protect-ServiceWritableFile([string]$Path) {
    Protect-Path $Path @("*${SidAdmins}:F", "*${SidSystem}:F", "*${SidLocalService}:(R,W)")
}

function Write-TextFile([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text, $Utf8)
}

function Read-Secret([string]$Prompt) {
    $secure = Read-Host -Prompt $Prompt -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

$NotifyVars = @('FOUNDRY_BACKUP_NOTIFY_EMAILS', 'FOUNDRY_BACKUP_SMTP_HOST', 'FOUNDRY_BACKUP_SMTP_PORT',
    'FOUNDRY_BACKUP_SMTP_SECURITY', 'FOUNDRY_BACKUP_SMTP_USER', 'FOUNDRY_BACKUP_SMTP_PASSWORD', 'FOUNDRY_BACKUP_SMTP_FROM')

# Asks for a new admin page password (twice, hidden); returns '' when none was given.
function Read-AdminPassword {
    while ($true) {
        $pw = Read-Secret 'Password for the administration page (at least 8 characters)'
        if (-not $pw) { return '' }
        if ($pw.Length -lt 8) { Write-BackupLog 'Too short; use at least 8 characters.'; continue }
        if ((Read-Secret 'Repeat the password') -ceq $pw) { return $pw }
        Write-BackupLog 'The passwords do not match; try again.'
    }
}

# Asks for the notification e-mail settings and puts them into the FOUNDRY_BACKUP_* variables of this process.
function Read-NotifySetting {
    Write-BackupLog 'The service can e-mail you when a backup fails (and when it has updated itself).'
    $emails = Read-Host -Prompt 'E-mail addresses for these notifications (comma separated; Enter = none)'
    if (-not $emails) { return }
    $env:FOUNDRY_BACKUP_NOTIFY_EMAILS = $emails
    $env:FOUNDRY_BACKUP_SMTP_HOST = Read-Host -Prompt 'SMTP server (e.g. smtp.gmail.com)'
    $security = Read-Host -Prompt 'SMTP security, starttls / tls / none [starttls]'
    if (-not $security) { $security = 'starttls' }
    $env:FOUNDRY_BACKUP_SMTP_SECURITY = $security
    $port = switch ($security) { 'tls' { '465' } 'none' { '25' } default { '587' } }
    $answer = Read-Host -Prompt "SMTP port [$port]"
    if ($answer) { $port = $answer }
    $env:FOUNDRY_BACKUP_SMTP_PORT = $port
    $env:FOUNDRY_BACKUP_SMTP_USER = Read-Host -Prompt 'SMTP user name (Enter = no login)'
    if ($env:FOUNDRY_BACKUP_SMTP_USER) { $env:FOUNDRY_BACKUP_SMTP_PASSWORD = Read-Secret 'SMTP password' }
    $env:FOUNDRY_BACKUP_SMTP_FROM = Read-Host -Prompt 'Sender address (From)'
}

# Creates or updates admin.json through src\admin.js; secrets only travel in environment variables of this process.
# $What: first = new file (asks for everything when interactive; the password is required), password / notify = change that part.
function Write-AdminSetting([string]$What, [string]$Node) {
    if (Test-Interactive) {
        if ($What -ne 'notify' -and -not $env:FOUNDRY_BACKUP_ADMIN_PASSWORD) {
            $pw = ''
            while (-not $pw) {
                $pw = Read-AdminPassword
                if (-not $pw) { Write-BackupLog 'The administration page is where the backups are set up, so it needs a password.' }
            }
            $env:FOUNDRY_BACKUP_ADMIN_PASSWORD = $pw
        }
        if ($What -ne 'password' -and -not $env:FOUNDRY_BACKUP_NOTIFY_EMAILS) { Read-NotifySetting }
    }
    if ($What -ne 'notify' -and -not $env:FOUNDRY_BACKUP_ADMIN_PASSWORD) {
        throw 'No admin password given (set FOUNDRY_BACKUP_ADMIN_PASSWORD, at least 8 characters, or run this in a console).'
    }
    if ($What -eq 'password') {
        foreach ($name in $NotifyVars) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
    }
    elseif ($What -eq 'notify') {
        Remove-Item -LiteralPath 'Env:FOUNDRY_BACKUP_ADMIN_PASSWORD' -ErrorAction SilentlyContinue
    }
    # An empty file with its final ACL first, so the secrets never sit in a file with looser rights.
    if (-not (Test-Path -LiteralPath $AdminFile)) { Write-TextFile $AdminFile '' }
    Protect-ServiceWritableFile $AdminFile
    try {
        & $Node (Join-Path $AppDir 'src\admin.js') setup $AdminFile | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "could not write $AdminFile (see the message above)" }
    }
    finally {
        Remove-Item -LiteralPath 'Env:FOUNDRY_BACKUP_ADMIN_PASSWORD', 'Env:FOUNDRY_BACKUP_SMTP_PASSWORD' -ErrorAction SilentlyContinue
    }
}

# KEY=value from env (the last line wins); '' when not set.
function Get-EnvValue([string]$Key) {
    if (-not (Test-Path -LiteralPath $EnvFile)) { return '' }
    $value = ''
    foreach ($line in [IO.File]::ReadAllLines($EnvFile)) {
        if ($line.StartsWith("$Key=")) { $value = $line.Substring($Key.Length + 1) }
    }
    $value
}

# Sets KEY=value in env (in place, so its ACL stays), or removes KEY when the value is ''.
function Write-EnvValue([string]$Key, [string]$Value) {
    $lines = @([IO.File]::ReadAllLines($EnvFile) | Where-Object { -not $_.StartsWith("$Key=") })
    if ($Value) { $lines += "$Key=$Value" }
    Write-TextFile $EnvFile (($lines -join "`r`n") + "`r`n")
}

# True when ADMIN_TLS turns HTTPS off for the admin page.
function Test-TlsOff { (Get-EnvValue 'ADMIN_TLS') -match '^(off|0|false|no)$' }

# Self-signed certificate for the admin page (made once; -Force makes a new one); LOCAL SERVICE may only read it.
function Write-AdminCert([string]$Node, [switch]$Force) {
    if ((Test-Path -LiteralPath $AdminCert) -and (Test-Path -LiteralPath $AdminKey) -and -not $Force) { return }
    $names = @()
    $public = Get-EnvValue 'ADMIN_PUBLIC_URL'
    if ($public) { $names += ([Uri]$public).Host }
    foreach ($f in @($AdminCert, $AdminKey)) {
        if (-not (Test-Path -LiteralPath $f)) { Write-TextFile $f '' }
        Protect-ServiceFile $f
    }
    & $Node (Join-Path $AppDir 'src\selfsigned.js') $AdminCert $AdminKey @names | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'could not make the admin certificate' }
    foreach ($f in @($AdminCert, $AdminKey)) { Protect-ServiceFile $f }
}

# The Windows Firewall rule for the admin page (Domain and Private networks).
function Register-AdminFirewallRule([string]$Port) {
    Get-NetFirewallRule -Name $FirewallRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -Name $FirewallRule -DisplayName 'Foundry World Backup admin page' -Direction Inbound `
        -Protocol TCP -LocalPort $Port -Action Allow -Profile Domain, Private | Out-Null
}

# The worlds folder of a Foundry user data folder (or '' when it is not one).
function Get-WorldsDir([string]$Dir) {
    foreach ($candidate in @((Join-Path (Join-Path $Dir 'Data') 'worlds'), (Join-Path $Dir 'worlds'), $Dir)) {
        if ((Test-Path -LiteralPath $candidate -PathType Container) -and ((Split-Path -Leaf $candidate) -eq 'worlds')) { return $candidate }
    }
    ''
}

# A likely Foundry user data folder on this PC, for the prompt ('' when none is found).
function Find-FoundryData {
    $users = Join-Path $env:SystemDrive 'Users'
    foreach ($userDir in Get-ChildItem -LiteralPath $users -Directory -ErrorAction SilentlyContinue) {
        $candidate = Join-Path $userDir.FullName 'AppData\Local\FoundryVTT'
        if (Test-Path -LiteralPath (Join-Path $candidate 'Data\worlds')) { return $candidate }
    }
    ''
}

# Lets LOCAL SERVICE read the worlds folder and everything below it, now and later (inherited), leaving the rest of
# the ACL as it is. (LOCAL SERVICE has "Bypass traverse checking", so the parents need nothing.)
function Grant-WorldsAccess([string]$Worlds) {
    & icacls.exe $Worlds /grant "*${SidLocalService}:(OI)(CI)RX" /Q | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Could not give LOCAL SERVICE read access to $Worlds; no world can be backed up until it has it (icacls `"$Worlds`" /grant *S-1-5-19:(OI)(CI)RX)."
        return
    }
    Write-BackupLog "LOCAL SERVICE may read $Worlds (inherited by new worlds)."
}

# Restarts the service task (unless it is disabled).
function Invoke-ServiceRestart {
    Invoke-ServiceShutdown
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task -and $task.State -ne 'Disabled') {
        Start-ScheduledTask -TaskName $TaskName
        Write-BackupLog "Saved; restarted $TaskName."
    }
    else { Write-BackupLog "Saved; $TaskName is not registered or disabled, so it was not started." }
}

# Logs where the admin page is reachable, for the end of a run.
function Write-AdminInfo {
    $port = Get-EnvValue 'ADMIN_PORT'
    if (-not $port) { $port = $DefaultAdminPort }
    $scheme = 'https'
    if (Test-TlsOff) { $scheme = 'http' }
    Write-BackupLog "Admin:  $($scheme)://$($env:COMPUTERNAME.ToLower()):$port/ in a browser on any computer here (Windows Firewall: allowed on Domain and Private networks)"
    $public = Get-EnvValue 'ADMIN_PUBLIC_URL'
    if ($public) { Write-BackupLog "        $public (public address)" }
    if ($scheme -eq 'https' -and (Test-Path -LiteralPath $AdminCert)) {
        try {
            $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList $AdminCert
            Write-BackupLog "        self-signed certificate: the browser warns once; SHA-1 thumbprint $($cert.Thumbprint)"
        }
        catch { Write-BackupLog '        self-signed certificate: the browser warns once' }
    }
}

function Test-Admin {
    $principal = New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())
    $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Resolve-NodePath {
    $node = $NodeOverride
    if (-not $node) { $node = Get-Setting 'NODE_PATH' }
    if (-not $node) {
        $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($cmd) { $node = $cmd.Source }
    }
    if (-not $node -or -not (Test-Path -LiteralPath $node)) {
        throw 'node.exe not found. Install Node.js 20.6 or newer for all users, or pass -NodePath C:\path\to\node.exe'
    }
    $node = (Resolve-Path -LiteralPath $node).Path
    $usersDir = Join-Path $env:SystemDrive 'Users'
    if ($node.StartsWith($usersDir, [StringComparison]::OrdinalIgnoreCase)) {
        throw "node.exe at $node is inside a user profile (nvm?), which LOCAL SERVICE cannot use. Install Node.js for all users or pass -NodePath."
    }
    $version = & $node -p 'process.versions.node'
    if ($LASTEXITCODE -ne 0 -or -not $version) { throw "cannot run $node to read its version" }
    $version = "$version".Trim()
    $parts = $version.Split('.') | ForEach-Object { [int]$_ }
    if ($parts[0] -lt 20 -or ($parts[0] -eq 20 -and $parts[1] -lt 6)) {
        throw "Node.js $version is too old; the Windows service needs 20.6 or newer (node --env-file)."
    }
    $node
}

# A git.exe installed for all users (Git for Windows): in PATH, or in its usual folder.
function Resolve-GitPath {
    $candidates = @()
    $cmd = Get-Command git.exe -ErrorAction SilentlyContinue
    if ($cmd) { $candidates += $cmd.Source }
    $candidates += (Join-Path $env:ProgramFiles 'Git\cmd\git.exe')
    if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Git\cmd\git.exe') }
    $usersDir = Join-Path $env:SystemDrive 'Users'
    foreach ($git in $candidates) {
        if ((Test-Path -LiteralPath $git) -and -not $git.StartsWith($usersDir, [StringComparison]::OrdinalIgnoreCase)) {
            return (Resolve-Path -LiteralPath $git).Path
        }
    }
    throw 'git.exe not found. Install Git for Windows for all users (https://git-scm.com/download/win); the backups need it.'
}

function Invoke-ServiceShutdown {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
    # The task runs node through cmd.exe; make sure no service node.exe outlives it.
    $pattern = "*$(Join-Path $AppDir 'src\server.js')*"
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object { $_.CommandLine -like $pattern } |
        ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }
    Start-Sleep -Seconds 1
}

function Unregister-UpdaterTask {
    if (Get-ScheduledTask -TaskName $UpdateTaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $UpdateTaskName -Confirm:$false
    }
}

# "Update now" on the admin page: a SYSTEM task without a schedule that runs the same update as the daily task,
# whether or not daily updates are on. LOCAL SERVICE (the service) may read and run it, not change it; a run takes no
# arguments, so the service can only say "run now".
function Register-UpdateNowTask {
    $script = Join-Path $AppDir 'scripts\auto-update.ps1'
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $DataDir `
        -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`" -Apply"
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
    $principal = New-ScheduledTaskPrincipal -UserId (Get-AccountName $SidSystem) -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $UpdateNowTaskName -Action $action -Settings $settings -Principal $principal `
        -Description "Update the Foundry world backup now (from its admin page)" -Force | Out-Null
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    $task = $scheduler.GetFolder('\').GetTask($UpdateNowTaskName)
    $task.SetSecurityDescriptor("D:(A;;FA;;;$SidAdmins)(A;;FA;;;$SidSystem)(A;;GRGX;;;$SidLocalService)", 0)
}

function Unregister-UpdateNowTask {
    if (Get-ScheduledTask -TaskName $UpdateNowTaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $UpdateNowTaskName -Confirm:$false
    }
}

function Invoke-Updater([string]$Mode) {
    $script = Join-Path $AppDir 'scripts\auto-update.ps1'
    if (-not (Test-Path -LiteralPath $script)) { throw "$AppDir has no updater; install this version first." }
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script $Mode | Out-Host
    $LASTEXITCODE
}

function Write-AutoUpdateConf([string]$Enabled, [string]$TokenFile, [string]$Node) {
    Write-TextFile $AutoConf "AUTO_UPDATE=$Enabled`r`nTOKEN_FILE=$TokenFile`r`nNODE_PATH=$Node`r`n"
    Protect-AdminFile $AutoConf
}

# Where the updater may take a token from. None is needed (the repository is public); a token only raises GitHub's
# rate limit: UPDATER_GITHUB_TOKEN, the token file already configured, else env, whose GITHUB_TOKEN is used when it is
# set (no token otherwise). Never asks for a token.
function Get-UpdaterTokenFile {
    $current = Get-Setting 'TOKEN_FILE'
    $token = ''
    if ($env:UPDATER_GITHUB_TOKEN) {
        $token = $env:UPDATER_GITHUB_TOKEN
    }
    elseif ($current -and (Test-Path -LiteralPath $current)) {
        return $current
    }
    if ($token) {
        if (-not (Test-Path -LiteralPath $UpdaterTokenFile)) { Write-TextFile $UpdaterTokenFile '' }
        Protect-AdminFile $UpdaterTokenFile
        Write-TextFile $UpdaterTokenFile "$token`r`n"
        return $UpdaterTokenFile
    }
    $EnvFile
}

function Register-UpdaterTask {
    $script = Join-Path $AppDir 'scripts\auto-update.ps1'
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $DataDir `
        -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`" -Apply"
    $trigger = New-ScheduledTaskTrigger -Daily -At '03:00' -RandomDelay (New-TimeSpan -Hours 6)
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
    $principal = New-ScheduledTaskPrincipal -UserId (Get-AccountName $SidSystem) -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $UpdateTaskName -Action $action -Trigger $trigger -Settings $settings `
        -Principal $principal -Description "Daily update check for the Foundry world backup ($UpdateRepo)" -Force | Out-Null
}

function Enable-AutoUpdate([string]$Node) {
    $tokenFile = Get-UpdaterTokenFile
    Write-AutoUpdateConf -Enabled 'yes' -TokenFile $tokenFile -Node $Node
    Register-UpdaterTask
    Write-BackupLog "Automatic updates on: daily check (random time) of $UpdateRepo (public; a token in $tokenFile is used if set)."
    if (-not $IsUpgrade) {
        $rc = Invoke-Updater '-Check'
        if ($rc -eq 75) {
            Write-BackupLog 'Another update run is in progress; check later with: .\scripts\install-service.ps1 -Check'
        }
        elseif ($rc -ne 0 -and $rc -ne 10) {
            Write-Warning "The update check failed (no network, or GitHub's rate limit); automatic updates stay on. Try: .\scripts\install-service.ps1 -Check"
        }
    }
}

function Disable-AutoUpdate([string]$Node) {
    Unregister-UpdaterTask
    if (Test-Path -LiteralPath $UpdaterTokenFile) { Remove-Item -LiteralPath $UpdaterTokenFile -Force }
    Write-AutoUpdateConf -Enabled 'no' -TokenFile '' -Node $Node
    Write-BackupLog 'Automatic updates off.'
}

if (-not (Test-Admin)) {
    Write-Error 'Please run this from an elevated PowerShell (Run as administrator).'
    exit 1
}

if ($Uninstall) {
    Unregister-UpdaterTask
    Unregister-UpdateNowTask
    Invoke-ServiceShutdown
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    # Before the files: the Inno uninstaller runs from $AppDir, so removing that folder can fail below.
    Get-NetFirewallRule -Name $FirewallRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    foreach ($dir in @($AppDir, $BackupDir, (Join-Path $DataDir 'update-tmp'))) {
        if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
    }
    foreach ($file in @($UpdaterTokenFile, $AutoConf)) {
        if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
    }
    Write-BackupLog "Removed the $TaskName tasks, the updater and $AppDir."
    Write-BackupLog "Kept $DataDir (settings, env with the token, the local git copies, logs); delete it by hand if wanted."
    exit 0
}

if ($Check) { exit (Invoke-Updater '-Check') }
if ($UpdateNow) { exit (Invoke-Updater '-Apply') }

$node = Resolve-NodePath

if ($SetAdminPassword -or $SetNotify) {
    if (-not (Test-Path -LiteralPath (Join-Path $AppDir 'src\admin.js')) -or -not (Test-Path -LiteralPath $EnvFile)) {
        throw "The service is not installed; run .\scripts\install-service.ps1 first."
    }
    if ($SetAdminPassword) { Write-AdminSetting 'password' $node } else { Write-AdminSetting 'notify' $node }
    Invoke-ServiceRestart
    exit 0
}

if ($RenewAdminCert -or $GrantAccess) {
    if (-not (Test-Path -LiteralPath (Join-Path $AppDir 'src\selfsigned.js')) -or -not (Test-Path -LiteralPath $EnvFile)) {
        throw "The service is not installed; run .\scripts\install-service.ps1 first."
    }
    if ($RenewAdminCert) {
        Write-AdminCert $node -Force
        Invoke-ServiceRestart
        Write-AdminInfo
    }
    else {
        $worlds = Get-WorldsDir (Get-EnvValue 'FOUNDRY_DATA')
        if (-not $worlds) { throw "FOUNDRY_DATA in $EnvFile is not a Foundry user data folder." }
        Grant-WorldsAccess $worlds
    }
    exit 0
}

if ($EnableAutoUpdate -or $DisableAutoUpdate) {
    if (-not (Test-Path -LiteralPath (Join-Path $AppDir 'src\updater.js'))) {
        throw "$AppDir is not installed (or too old for auto-update); run .\scripts\install-service.ps1 -AutoUpdate"
    }
    if ($EnableAutoUpdate) { Enable-AutoUpdate $node } else { Disable-AutoUpdate $node }
    exit 0
}

$git = Resolve-GitPath

# A first install needs the Foundry data folder and an admin password; fail before anything is changed.
$firstInstall = -not (Test-Path -LiteralPath $EnvFile)
$dataFolder = ''
if ($firstInstall) {
    $dataFolder = $FoundryData
    if (-not $dataFolder) { $dataFolder = $env:FOUNDRY_BACKUP_DATA }
    if (-not $dataFolder) {
        $guess = Find-FoundryData
        if (Test-Interactive) {
            $prompt = 'Foundry user data folder (the one with Config, Data and Logs)'
            if ($guess) { $prompt += " [$guess]" }
            $dataFolder = Read-Host -Prompt $prompt
            if (-not $dataFolder) { $dataFolder = $guess }
        }
        else { $dataFolder = $guess }
    }
    if (-not $dataFolder) { throw 'No Foundry data folder: pass -FoundryData DIR (or set FOUNDRY_BACKUP_DATA).' }
    $dataFolder = (Resolve-Path -LiteralPath $dataFolder).Path.TrimEnd('\')
    if (-not (Get-WorldsDir $dataFolder)) { throw "$dataFolder has no Data\worlds folder; is it the Foundry user data folder?" }
    if (-not (Test-Interactive) -and -not $env:FOUNDRY_BACKUP_ADMIN_PASSWORD) {
        throw 'No admin password: set FOUNDRY_BACKUP_ADMIN_PASSWORD (at least 8 characters) for an unattended first install.'
    }
}
$port = $AdminPort
if (-not $port) { $port = $env:FOUNDRY_BACKUP_ADMIN_PORT }
if ($port) {
    $n = 0
    if (-not [int]::TryParse($port, [ref]$n) -or $n -lt 1 -or $n -gt 65535) { throw "Invalid admin port '$port' (1-65535)." }
}

# Data folder: Administrators and SYSTEM only; LOCAL SERVICE may list it (and rewrite config.json, admin.json, env).
if (-not (Test-Path -LiteralPath $DataDir)) { New-Item -ItemType Directory -Path $DataDir | Out-Null }
Protect-Path $DataDir @("*${SidAdmins}:(OI)(CI)F", "*${SidSystem}:(OI)(CI)F", "*${SidLocalService}:RX")
if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
Protect-Path $LogDir @("*${SidAdmins}:(OI)(CI)F", "*${SidSystem}:(OI)(CI)F", "*${SidLocalService}:(OI)(CI)M")
if (-not (Test-Path -LiteralPath $StateDir)) { New-Item -ItemType Directory -Path $StateDir | Out-Null }
Protect-Path $StateDir @("*${SidAdmins}:(OI)(CI)F", "*${SidSystem}:(OI)(CI)F", "*${SidLocalService}:(OI)(CI)M")

# Code: replaced on each run (stop the service first so nothing holds the folder).
Invoke-ServiceShutdown
$appFull = [IO.Path]::GetFullPath($AppDir).TrimEnd('\')
if ([IO.Path]::GetFullPath($SrcDir).TrimEnd('\') -ne $appFull) {
    if (Test-Path -LiteralPath $AppDir) { Remove-Item -LiteralPath $AppDir -Recurse -Force }
    New-Item -ItemType Directory -Path $AppDir | Out-Null
    foreach ($item in @('src', 'scripts', 'package.json', 'README.md', 'LICENSE', 'config.example.json', '.env.example')) {
        $path = Join-Path $SrcDir $item
        if (Test-Path -LiteralPath $path) { Copy-Item -LiteralPath $path -Destination $AppDir -Recurse -Force }
    }
}

# Settings + env: created once, never overwritten.
if (-not (Test-Path -LiteralPath $ConfigFile)) {
    Write-TextFile $ConfigFile "{}`r`n"
    Write-BackupLog "Wrote $ConfigFile (the administration page fills it in)."
}
Protect-ServiceWritableFile $ConfigFile
# admin.json: created once (asks for the admin password and notification e-mails), never overwritten here.
if (-not (Test-Path -LiteralPath $AdminFile)) { Write-AdminSetting 'first' $node }
Protect-ServiceWritableFile $AdminFile
if ($firstInstall) {
    $token = 'REPLACE_ME'
    if ($env:FOUNDRY_BACKUP_GITHUB_TOKEN) {
        $token = $env:FOUNDRY_BACKUP_GITHUB_TOKEN
    }
    elseif (Test-Interactive) {
        $entered = Read-Secret 'GitHub token (fine-grained: Contents read/write + Administration read/write; Enter to paste it on the admin page later)'
        if ($entered) { $token = $entered }
    }
    if (-not $port) { $port = $DefaultAdminPort }
    $foundryUrl = 'http://localhost:30000'
    if ($null -ne $env:FOUNDRY_BACKUP_FOUNDRY_URL) { $foundryUrl = $env:FOUNDRY_BACKUP_FOUNDRY_URL }
    Write-TextFile $EnvFile ''
    Protect-ServiceWritableFile $EnvFile
    $text = "GITHUB_TOKEN=$token`r`nFOUNDRY_DATA=$dataFolder`r`nCONFIG_FILE=$ConfigFile`r`nSTATE_DIR=$StateDir`r`n" +
        "GIT_BIN=$git`r`nADMIN_PORT=$port`r`nADMIN_HOST=0.0.0.0`r`nFOUNDRY_URL=$foundryUrl`r`n"
    if ($env:FOUNDRY_BACKUP_ADMIN_PUBLIC_URL) { $text += "ADMIN_PUBLIC_URL=$($env:FOUNDRY_BACKUP_ADMIN_PUBLIC_URL)`r`n" }
    Write-TextFile $EnvFile $text
    Write-BackupLog "Wrote $EnvFile."
}
else {
    if ($port -and $port -ne (Get-EnvValue 'ADMIN_PORT')) { Write-EnvValue 'ADMIN_PORT' $port; Write-BackupLog "Admin port changed to $port." }
    if ((Get-EnvValue 'GIT_BIN') -ne $git) { Write-EnvValue 'GIT_BIN' $git }
}
Protect-ServiceWritableFile $EnvFile
if (-not (Test-TlsOff)) { Write-AdminCert $node }
Register-AdminFirewallRule (Get-EnvValue 'ADMIN_PORT')

# Read access to the worlds (a warning, not an error: the page shows which worlds cannot be read).
$worlds = Get-WorldsDir (Get-EnvValue 'FOUNDRY_DATA')
if ($worlds) { Grant-WorldsAccess $worlds } else { Write-Warning "FOUNDRY_DATA in $EnvFile is not a Foundry user data folder." }

# Launcher: rotates the log at 5 MB, then runs node with the env file.
$launcher = Join-Path $AppDir 'run-service.cmd'
$log = Join-Path $LogDir 'service.log'
Write-TextFile $launcher (@(
        '@echo off',
        "for %%F in (`"$log`") do if %%~zF GTR 5000000 move /y `"$log`" `"$log.1`" >nul",
        "`"$node`" --env-file=`"$EnvFile`" `"$(Join-Path $AppDir 'src\server.js')`" >> `"$log`" 2>&1"
    ) -join "`r`n")

# Service task: at boot, plus every 5 minutes so a crashed service comes back (IgnoreNew skips it while running).
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/d /c `"$launcher`"" -WorkingDirectory $DataDir
$triggers = @(
    (New-ScheduledTaskTrigger -AtStartup),
    (New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 5))
)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId (Get-AccountName $SidLocalService) -LogonType ServiceAccount -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal `
    -Description 'Foundry VTT world backup to GitHub' -Force | Out-Null
Register-UpdateNowTask

Start-ScheduledTask -TaskName $TaskName
Write-BackupLog "Installed task $TaskName (account: LOCAL SERVICE, code: $AppDir, settings: $DataDir)."
$placeholder = [IO.File]::ReadAllLines($EnvFile) | Where-Object { $_ -eq 'GITHUB_TOKEN=REPLACE_ME' }
if ($placeholder) { Write-BackupLog 'No GitHub token yet: paste one on the administration page (GitHub) before the first backup.' }

# Automatic updates: the command line wins, then the saved choice, then (first install only) a prompt.
$saved = Get-Setting 'AUTO_UPDATE'
$choice = ''
if ($AutoUpdate) { $choice = 'yes' }
elseif ($NoAutoUpdate) { $choice = 'no' }
elseif ($saved) { $choice = $saved }
elseif (Test-Interactive) {
    $answer = Read-Host -Prompt 'Turn on automatic updates (daily check for new releases of this service)? [y/N]'
    if ($answer -match '^[Yy]') { $choice = 'yes' } else { $choice = 'no' }
}
else { $choice = 'no' }

if ($choice -eq 'yes') { Enable-AutoUpdate $node }
elseif ($saved -eq 'yes' -or (Get-ScheduledTask -TaskName $UpdateTaskName -ErrorAction SilentlyContinue)) { Disable-AutoUpdate $node }
else { Write-AutoUpdateConf -Enabled 'no' -TokenFile '' -Node $node }

Write-BackupLog "Status: Get-ScheduledTask $TaskName | Select-Object State"
Write-BackupLog "Logs:   Get-Content -Wait $log"
Write-AdminInfo
exit 0
