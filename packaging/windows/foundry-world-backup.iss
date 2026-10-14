; Inno Setup script for the Foundry world backup (Windows).
;
; Build:  packaging\windows\build-installer.ps1   (downloads Node.js, then runs ISCC with the defines below)
;   ISCC /DAppVersion=1.2.3 [/DRepoRoot=<source folder>] /DNodeExe=<node.exe> /DNodeLicense=<LICENSE> /O<out dir> foundry-world-backup.iss
;
; The installer is a wizard around scripts\install-service.ps1: it copies the code to C:\Program Files\FoundryWorldBackup,
; installs a private Node.js next to it (the service runs as LOCAL SERVICE, so it cannot use a node.exe from a user
; profile), collects the Foundry data folder, the token and the admin page settings and then runs install-service.ps1,
; which creates the data folder with its ACLs, env, admin.json, the scheduled task and (optionally) the auto-updater.
; Existing env, config.json and admin.json are never overwritten, so running the installer again updates the code.
; Git for Windows must be installed for all users: the wizard checks and says so.
;
; Silent install (passwords and the token only through the environment, never on the command line):
;   set FOUNDRY_BACKUP_GITHUB_TOKEN=github_pat_...
;   set FOUNDRY_BACKUP_ADMIN_PASSWORD=...          (required on a first install)
;   set FOUNDRY_BACKUP_SMTP_PASSWORD=...           (optional)
;   foundry-world-backup-X.Y.Z-setup.exe /VERYSILENT /SUPPRESSMSGBOXES /FOUNDRYDATA=C:\Users\me\AppData\Local\FoundryVTT /AUTOUPDATE=1
;     [/ADMINPORT=8484 /NOTIFYEMAILS=a@example.com,b@example.com /SMTPHOST=smtp.example.com /SMTPPORT=587
;      /SMTPSECURITY=starttls /SMTPUSER=user /SMTPFROM=backup@example.com]
; Silent uninstall keeps settings, token and state; add /DELETEDATA=1 to remove C:\ProgramData\FoundryWorldBackup as well.

#ifndef AppVersion
  #error Pass /DAppVersion=MAJOR.MINOR.PATCH
#endif
#ifndef NodeExe
  #error Pass /DNodeExe=path\to\node.exe
#endif
#ifndef NodeLicense
  #error Pass /DNodeLicense=path\to\node\LICENSE
#endif

#define AppName "Foundry World Backup"
#define DataFolder "FoundryWorldBackup"
#define NodeFolder "FoundryWorldBackup-Node"
; The files to pack: this repository, or (release builds) the unpacked Windows archive with the version stamped in.
#ifndef RepoRoot
  #define RepoRoot "..\.."
#endif

[Setup]
AppId={{7E1F3C8A-2B6D-4F0E-9B5A-3D4C2A1E8F60}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=dxcufgb
AppPublisherURL=https://github.com/dxcufgb/FoundryVTT-world-backup-to-git
; install-service.ps1 and the updater expect the code in C:\Program Files\FoundryWorldBackup, so the folder is fixed.
DefaultDirName={commonpf}\{#DataFolder}
DisableDirPage=yes
DisableProgramGroupPage=yes
UsePreviousAppDir=no
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
OutputBaseFilename=foundry-world-backup-{#AppVersion}-setup
UninstallDisplayName={#AppName}
; The service is stopped by PrepareToInstall; there is no application window for Restart Manager to close.
CloseApplications=no
RestartApplications=no

[Files]
Source: "{#RepoRoot}\src\*"; DestDir: "{app}\src"; Flags: ignoreversion recursesubdirs
Source: "{#RepoRoot}\scripts\*.ps1"; DestDir: "{app}\scripts"; Flags: ignoreversion
Source: "{#RepoRoot}\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#RepoRoot}\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#RepoRoot}\config.example.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#RepoRoot}\.env.example"; DestDir: "{app}"; Flags: ignoreversion
; Node.js lives outside {app}: the auto-updater replaces the whole code folder.
Source: "{#NodeExe}"; DestDir: "{commonpf}\{#NodeFolder}"; Flags: ignoreversion
Source: "{#NodeLicense}"; DestDir: "{commonpf}\{#NodeFolder}"; DestName: "Node.js-LICENSE.txt"; Flags: ignoreversion
Source: "stop-service.ps1"; Flags: dontcopy

[UninstallDelete]
; The updater and install-service.ps1 write into these after Inno recorded its own files.
Type: filesandordirs; Name: "{app}"
Type: filesandordirs; Name: "{app}.prev"
Type: filesandordirs; Name: "{commonpf}\{#NodeFolder}"

[Code]
var
  SettingsPage: TInputQueryWizardPage;
  UpdatePage: TInputOptionWizardPage;
  AdminPage: TInputQueryWizardPage;
  SmtpPage: TInputQueryWizardPage;

function SetEnvironmentVariableW(Name, Value: String): Boolean;
  external 'SetEnvironmentVariableW@kernel32.dll stdcall';

function DataDir: String;
begin
  Result := ExpandConstant('{commonappdata}\{#DataFolder}');
end;

function EnvFile: String;
begin
  Result := DataDir + '\env';
end;

function AdminFile: String;
begin
  Result := DataDir + '\admin.json';
end;

function PowerShellExe: String;
begin
  Result := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
end;

function NodeExePath: String;
begin
  Result := ExpandConstant('{commonpf}\{#NodeFolder}\node.exe');
end;

// Git for Windows installed for all users (the service runs as LOCAL SERVICE and cannot use a per-user install).
function GitFound: Boolean;
begin
  Result := FileExists(ExpandConstant('{commonpf}\Git\cmd\git.exe')) or
    FileExists(ExpandConstant('{commonpf32}\Git\cmd\git.exe'));
end;

// A likely Foundry user data folder: the first user profile with AppData\Local\FoundryVTT\Data\worlds.
function GuessFoundryData: String;
var
  FindRec: TFindRec;
  Users, Candidate: String;
begin
  Result := '';
  Users := ExpandConstant('{sd}\Users');
  if FindFirst(Users + '\*', FindRec) then
  begin
    try
      repeat
        if (FindRec.Attributes and FILE_ATTRIBUTE_DIRECTORY <> 0) and (FindRec.Name <> '.') and (FindRec.Name <> '..') then
        begin
          Candidate := Users + '\' + FindRec.Name + '\AppData\Local\FoundryVTT';
          if DirExists(Candidate + '\Data\worlds') and (Result = '') then Result := Candidate;
        end;
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;
end;

function IsFoundryData(Dir: String): Boolean;
begin
  Dir := RemoveBackslashUnlessRoot(Trim(Dir));
  Result := DirExists(Dir + '\Data\worlds') or DirExists(Dir + '\worlds') or
    ((ExtractFileName(Dir) = 'worlds') and DirExists(Dir));
end;

// Returns '' when the wizard answers are usable, otherwise a message for the user.
function SettingsError: String;
var
  Port: Integer;
begin
  Result := '';
  if FileExists(EnvFile) then Exit;
  if not IsFoundryData(SettingsPage.Values[0]) then
    Result := 'Enter the Foundry user data folder (the one with Config, Data and Logs; it must contain Data\worlds).'
  else
  begin
    Port := StrToIntDef(Trim(SettingsPage.Values[2]), 0);
    if (Port < 1) or (Port > 65535) then
      Result := 'The admin page port must be a number between 1 and 65535.';
  end;
end;

function WantsNotify: Boolean;
begin
  Result := Trim(AdminPage.Values[2]) <> '';
end;

// A rough check of the comma separated addresses (src\admin.js does the real validation).
function EmailsLookValid(S: String): Boolean;
var
  Item: String;
  I: Integer;
begin
  Result := True;
  S := S + ',';
  while S <> '' do
  begin
    I := Pos(',', S);
    Item := Trim(Copy(S, 1, I - 1));
    S := Copy(S, I + 1, Length(S));
    if (Item <> '') and ((Pos('@', Item) < 2) or (Pos('.', Item) = 0) or (Pos(' ', Item) > 0)) then Result := False;
  end;
end;

// Returns '' when the admin page password and the addresses are usable, otherwise a message for the user.
function AdminError: String;
begin
  Result := '';
  if FileExists(AdminFile) then Exit;
  if Length(AdminPage.Values[0]) < 8 then
    Result := 'The admin page password needs at least 8 characters (the page is where the backups are set up).'
  else if AdminPage.Values[0] <> AdminPage.Values[1] then
    Result := 'The two admin page passwords differ.'
  else if not EmailsLookValid(AdminPage.Values[2]) then
    Result := 'Enter the notification e-mail addresses separated by commas, like a@example.com, b@example.org.';
end;

// Returns '' when the mail server answers are usable (or not needed), otherwise a message for the user.
function SmtpError: String;
var
  Port: Integer;
begin
  Result := '';
  if FileExists(AdminFile) then Exit;
  if WantsNotify then
  begin
    Port := StrToIntDef(Trim(SmtpPage.Values[1]), 0);
    if Trim(SmtpPage.Values[0]) = '' then
      Result := 'Enter the SMTP server that sends the notification e-mails.'
    else if (Port < 1) or (Port > 65535) then
      Result := 'The SMTP port must be a number between 1 and 65535.'
    else if (Trim(SmtpPage.Values[2]) <> 'starttls') and (Trim(SmtpPage.Values[2]) <> 'tls') and
      (Trim(SmtpPage.Values[2]) <> 'none') then
      Result := 'SMTP security must be starttls, tls or none.'
    else if (Trim(SmtpPage.Values[3]) <> '') and (Trim(SmtpPage.Values[2]) = 'none') then
      Result := 'A login (user name) needs SMTP security starttls or tls.'
    else if not EmailsLookValid(Trim(SmtpPage.Values[5])) or (Trim(SmtpPage.Values[5]) = '') then
      Result := 'Enter the sender (From) address of the notification e-mails.';
  end;
end;

function AutoUpdateWasOn: Boolean;
var
  Text: AnsiString;
begin
  Result := LoadStringFromFile(DataDir + '\auto-update.conf', Text) and (Pos('AUTO_UPDATE=yes', String(Text)) > 0);
end;

function InitializeSetup: Boolean;
begin
  Result := GitFound;
  if not Result then
  begin
    if not WizardSilent then
      MsgBox('Git for Windows is not installed for all users. Install it from https://git-scm.com/download/win ' +
        '(the backups are made with git), then run this installer again.', mbError, MB_OK);
    Log('Git for Windows not found; setup cannot continue.');
  end;
end;

procedure InitializeWizard;
begin
  SettingsPage := CreateInputQueryPage(wpWelcome, 'Foundry and GitHub',
    'The worlds to back up and the token that pushes them',
    'The token is stored in ' + DataDir + '\env, readable only by administrators and the service; it can also be ' +
    'pasted on the administration page later. Existing settings are never overwritten.');
  SettingsPage.Add('Foundry user data folder (the one with Config, Data and Logs):', False);
  SettingsPage.Add('GitHub token (fine-grained: Contents read/write, Administration read/write; optional now):', True);
  SettingsPage.Add('Port of the administration page:', False);
  SettingsPage.Values[0] := ExpandConstant('{param:FOUNDRYDATA|' + GuessFoundryData + '}');
  SettingsPage.Values[1] := GetEnv('FOUNDRY_BACKUP_GITHUB_TOKEN');
  SettingsPage.Values[2] := ExpandConstant('{param:ADMINPORT|8484}');

  UpdatePage := CreateInputOptionPage(SettingsPage.ID, 'Automatic updates',
    'Keep the service itself up to date',
    'Optional. The service checks the GitHub releases of this project once a day and installs newer versions. ' +
    'It uses the token above, so that token also needs Contents: read-only on dxcufgb/FoundryVTT-world-backup-to-git.',
    False, False);
  UpdatePage.Add('Turn on automatic updates');
  UpdatePage.Values[0] := (ExpandConstant('{param:AUTOUPDATE|0}') = '1') or AutoUpdateWasOn;

  AdminPage := CreateInputQueryPage(UpdatePage.ID, 'Administration page and e-mails',
    'Set up the backups in a browser and get e-mails when one fails',
    'The administration page (https://<this PC>:<port>/) lists the worlds, their backups and the schedule. ' +
    'The e-mail addresses get a message whenever a backup fails or the service updates itself; both can be ' +
    'changed later on the administration page.');
  AdminPage.Add('Admin page password (at least 8 characters):', True);
  AdminPage.Add('Repeat the password:', True);
  AdminPage.Add('E-mail addresses for notifications (comma separated):', False);
  AdminPage.Values[0] := GetEnv('FOUNDRY_BACKUP_ADMIN_PASSWORD');
  AdminPage.Values[1] := GetEnv('FOUNDRY_BACKUP_ADMIN_PASSWORD');
  AdminPage.Values[2] := ExpandConstant('{param:NOTIFYEMAILS|}');

  SmtpPage := CreateInputQueryPage(AdminPage.ID, 'Mail server',
    'The SMTP server that sends the notification e-mails',
    'Security: starttls (usually port 587), tls (usually port 465) or none (a local relay without login). ' +
    'The settings are stored in ' + DataDir + '\admin.json, readable only by administrators and the service.');
  SmtpPage.Add('SMTP server (e.g. smtp.gmail.com):', False);
  SmtpPage.Add('Port:', False);
  SmtpPage.Add('Security (starttls, tls or none):', False);
  SmtpPage.Add('User name (empty = no login):', False);
  SmtpPage.Add('Password:', True);
  SmtpPage.Add('Sender address (From):', False);
  SmtpPage.Values[0] := ExpandConstant('{param:SMTPHOST|}');
  SmtpPage.Values[1] := ExpandConstant('{param:SMTPPORT|587}');
  SmtpPage.Values[2] := ExpandConstant('{param:SMTPSECURITY|starttls}');
  SmtpPage.Values[3] := ExpandConstant('{param:SMTPUSER|}');
  SmtpPage.Values[4] := GetEnv('FOUNDRY_BACKUP_SMTP_PASSWORD');
  SmtpPage.Values[5] := ExpandConstant('{param:SMTPFROM|}');
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  // Nothing to ask when env already exists (a re-install or update).
  Result := ((PageID = SettingsPage.ID) and FileExists(EnvFile)) or
    // admin.json exists: its settings are changed on the admin page (or install-service.ps1 -SetAdminPassword)
    (((PageID = AdminPage.ID) or (PageID = SmtpPage.ID)) and FileExists(AdminFile)) or
    ((PageID = SmtpPage.ID) and not WantsNotify);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Msg: String;
begin
  Result := True;
  Msg := '';
  if CurPageID = SettingsPage.ID then Msg := SettingsError
  else if CurPageID = AdminPage.ID then Msg := AdminError
  else if CurPageID = SmtpPage.ID then Msg := SmtpError;
  if Msg <> '' then
  begin
    MsgBox(Msg, mbError, MB_OK);
    Result := False;
  end;
end;

// Stops the service (the old node.exe would be locked) and re-checks the answers for silent installs.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Result := SettingsError;
  if Result = '' then Result := AdminError;
  if Result = '' then Result := SmtpError;
  if Result <> '' then Exit;
  ExtractTemporaryFile('stop-service.ps1');
  Exec(PowerShellExe, '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{tmp}\stop-service.ps1') + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

// Hands the admin page and e-mail answers to install-service.ps1 (which writes admin.json only when it is missing).
procedure SetAdminEnvironment(Clear: Boolean);
var
  I: Integer;
  Names: array[0..7] of String;
  Values: array[0..7] of String;
begin
  Names[0] := 'FOUNDRY_BACKUP_ADMIN_PASSWORD'; Values[0] := AdminPage.Values[0];
  Names[1] := 'FOUNDRY_BACKUP_NOTIFY_EMAILS'; Values[1] := Trim(AdminPage.Values[2]);
  Names[2] := 'FOUNDRY_BACKUP_SMTP_HOST'; Values[2] := Trim(SmtpPage.Values[0]);
  Names[3] := 'FOUNDRY_BACKUP_SMTP_PORT'; Values[3] := Trim(SmtpPage.Values[1]);
  Names[4] := 'FOUNDRY_BACKUP_SMTP_SECURITY'; Values[4] := Trim(SmtpPage.Values[2]);
  Names[5] := 'FOUNDRY_BACKUP_SMTP_USER'; Values[5] := Trim(SmtpPage.Values[3]);
  Names[6] := 'FOUNDRY_BACKUP_SMTP_PASSWORD'; Values[6] := SmtpPage.Values[4];
  Names[7] := 'FOUNDRY_BACKUP_SMTP_FROM'; Values[7] := Trim(SmtpPage.Values[5]);
  for I := 0 to 7 do
  begin
    // the mail server settings only matter with recipients
    if Clear or ((I >= 2) and (I <= 7) and not WantsNotify) then Values[I] := '';
    SetEnvironmentVariableW(Names[I], Values[I]);
  end;
end;

procedure RunInstallScript;
var
  Script, LogFile, Switch, First, Params: String;
  ResultCode: Integer;
begin
  Script := ExpandConstant('{app}\scripts\install-service.ps1');
  LogFile := ExpandConstant('{app}\install.log');
  if UpdatePage.Values[0] then Switch := '-AutoUpdate' else Switch := '-NoAutoUpdate';
  // The data folder and the port only on a first install (a re-install keeps env as it is).
  First := '';
  if not FileExists(EnvFile) then
    First := ' -FoundryData "' + RemoveBackslashUnlessRoot(Trim(SettingsPage.Values[0])) + '" -AdminPort ' +
      Trim(SettingsPage.Values[2]);
  // -Upgrade = never prompt; the token reaches the script through the environment, not the command line.
  Params := '/d /s /c ""' + PowerShellExe + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + Script +
    '" -Upgrade -NodePath "' + NodeExePath + '"' + First + ' ' + Switch + ' > "' + LogFile + '" 2>&1"';
  SetEnvironmentVariableW('FOUNDRY_BACKUP_GITHUB_TOKEN', Trim(SettingsPage.Values[1]));
  SetAdminEnvironment(False);
  try
    if not Exec(ExpandConstant('{cmd}'), Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
      ResultCode := -1;
  finally
    SetEnvironmentVariableW('FOUNDRY_BACKUP_GITHUB_TOKEN', '');
    SetAdminEnvironment(True);
  end;
  if ResultCode <> 0 then
    MsgBox('Setting up the service failed (exit code ' + IntToStr(ResultCode) + '). Details: ' + LogFile,
      mbError, MB_OK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then RunInstallScript;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Script: String;
  ResultCode: Integer;
  Delete: Boolean;
begin
  if CurUninstallStep = usUninstall then
  begin
    // Removes the scheduled tasks and kills the running service so its files can be deleted.
    Script := ExpandConstant('{app}\scripts\install-service.ps1');
    if FileExists(Script) then
      Exec(PowerShellExe, '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + Script + '" -Uninstall',
        '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end
  else if CurUninstallStep = usPostUninstall then
  begin
    if DirExists(DataDir) then
    begin
      if UninstallSilent then
        Delete := ExpandConstant('{param:DELETEDATA|0}') = '1'
      else
        Delete := MsgBox('Also delete the settings, token, local git copies and logs in ' + DataDir + '? ' +
          '(The backups on GitHub stay.)', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
      if Delete then DelTree(DataDir, True, True, True);
    end;
  end;
end;
