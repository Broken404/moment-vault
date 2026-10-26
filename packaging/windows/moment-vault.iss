; Compile only through tools/build-installer.mjs so payload and identity are checked.
#ifndef PayloadDir
  #error PayloadDir is required
#endif
#ifndef AppVersion
  #error AppVersion is required
#endif
#ifdef InstallCheck
  #define ProductId "MomentVault-InstallCheck"
  #define ProductName "Moment Vault Install Check"
  #define HostName "com.momentvault.host.installcheck"
#else
  #define ProductId "MomentVault"
  #define ProductName "Moment Vault"
  #define HostName "com.momentvault.host"
#endif

[Setup]
AppId={#ProductId}
AppName={#ProductName}
AppVersion={#AppVersion}
AppPublisher=Moment Vault contributors
AppPublisherURL=https://github.com/Broken404/moment-vault
DefaultDirName={localappdata}\Programs\{#ProductId}
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
UsePreviousAppDir=yes
DisableProgramGroupPage=yes
DisableDirPage=yes
UninstallDisplayName={#ProductName}
OutputDir={#OutputDir}
OutputBaseFilename=MomentVault-{#AppVersion}-win-x64{#OutputSuffix}
Compression=lzma2/fast
SolidCompression=yes
CloseApplications=no
RestartApplications=no
AllowCancelDuringInstall=no
WizardStyle=modern
LicenseFile={#PayloadDir}\LICENSE
InfoAfterFile={#PayloadDir}\INSTALL.txt
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#PayloadDir}\host\*"; DestDir: "{app}\host"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "com.momentvault.host.json"
Source: "{#PayloadDir}\host\com.momentvault.host.json"; DestDir: "{app}\host"; DestName: "{#HostName}.json"; Flags: ignoreversion; AfterInstall: WriteHostManifest
Source: "{#PayloadDir}\extension\*"; DestDir: "{app}\extension"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PayloadDir}\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadDir}\INSTALL.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadDir}\package-receipt.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadDir}\notices\*"; DestDir: "{app}\notices"; Flags: ignoreversion recursesubdirs createallsubdirs

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Edge\NativeMessagingHosts\{#HostName}"; ValueType: string; ValueData: "{app}\host\{#HostName}.json"
Root: HKCU; Subkey: "Software\Google\Chrome\NativeMessagingHosts\{#HostName}"; ValueType: string; ValueData: "{app}\host\{#HostName}.json"

[Icons]
Name: "{userprograms}\{#ProductName}\Installation instructions"; Filename: "{app}\INSTALL.txt"
Name: "{userprograms}\{#ProductName}\Extension folder"; Filename: "{app}\extension"

[Code]
function CreateFileW(lpFileName: String; dwDesiredAccess, dwShareMode,
  lpSecurityAttributes, dwCreationDisposition, dwFlagsAndAttributes,
  hTemplateFile: LongWord): THandle;
  external 'CreateFileW@kernel32.dll stdcall';
function CloseHandle(hObject: THandle): Boolean;
  external 'CloseHandle@kernel32.dll stdcall';

function HostIsBusy: Boolean;
var
  Exe: String;
  Handle: THandle;
begin
  Result := False;
  Exe := ExpandConstant('{app}\host\MomentVault.Host.exe');
  if not FileExists(Exe) then exit;
  { Exclusive write access fails while Windows has the executable mapped.
    Refuse the upgrade/uninstall; never terminate an active save or browser. }
  Handle := CreateFileW(Exe, $40000000, 0, 0, 3, 0, 0);
  Result := Handle = $FFFFFFFF;
  if not Result then CloseHandle(Handle);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if HostIsBusy then
    Result := 'Moment Vault is in use. Finish saving, close Edge, then retry.';
end;

function InitializeUninstall: Boolean;
begin
  Result := not HostIsBusy;
  if not Result then
    SuppressibleMsgBox('Moment Vault is in use. Finish saving, close Edge, then retry.', mbError, MB_OK, IDOK);
end;

function JsonString(Value: String): String;
begin
  StringChangeEx(Value, '\', '\\', True);
  StringChangeEx(Value, '"', '\"', True);
  Result := '"' + Value + '"';
end;

procedure WriteHostManifest;
var
  Lines: TArrayOfString;
begin
  SetArrayLength(Lines, 1);
  Lines[0] := '{"name":"{#HostName}","description":"Moment Vault local material helper",' +
    '"path":' + JsonString(ExpandConstant('{app}\host\MomentVault.Host.exe')) +
    ',"type":"stdio","allowed_origins":["chrome-extension://{#ExtensionId}/"]}';
  if not SaveStringsToUTF8FileWithoutBOM(ExpandConstant('{app}\host\{#HostName}.json'), Lines, False) then
    RaiseException('Unable to write the native messaging manifest.');
end;

procedure RemoveOwnedRegistration(Subkey: String);
var
  Current: String;
begin
  { A later development registration must survive uninstalling this copy. }
  if RegQueryStringValue(HKCU, Subkey, '', Current) and
    (CompareText(Current, ExpandConstant('{app}\host\{#HostName}.json')) = 0) then
  begin
    RegDeleteValue(HKCU, Subkey, '');
    RegDeleteKeyIfEmpty(HKCU, Subkey);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    RemoveOwnedRegistration('Software\Microsoft\Edge\NativeMessagingHosts\{#HostName}');
    RemoveOwnedRegistration('Software\Google\Chrome\NativeMessagingHosts\{#HostName}');
  end;
end;

{ No recursive deletion and no entries for user configuration/material directories. }
