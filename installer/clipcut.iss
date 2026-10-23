[Setup]
AppId={{6F0B2C1E-7A53-4C1D-9E0A-C11D0C7A5A01}
AppName=ClipCut
AppVersion={#AppVersion}
AppPublisher=ClipCut
DefaultDirName={autopf}\ClipCut
DefaultGroupName=ClipCut
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist
OutputBaseFilename=ClipCut-Setup
SetupIconFile=icon.ico
UninstallDisplayIcon={app}\icon.ico
Compression=lzma2
SolidCompression=yes
WizardStyle=modern

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "..\dist\ClipCut.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\ffmpeg.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\ffprobe.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "ClipCut.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "icon.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\ClipCut"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\ClipCut.vbs"""; IconFilename: "{app}\icon.ico"
Name: "{autodesktop}\ClipCut"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\ClipCut.vbs"""; IconFilename: "{app}\icon.ico"; Tasks: desktopicon

[Run]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\ClipCut.vbs"""; Description: "Open ClipCut now"; Flags: postinstall nowait skipifsilent
