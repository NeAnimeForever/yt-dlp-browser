param(
    [string]$Version = "0.3.6",
    [string]$Output = "$PSScriptRoot\..\release"
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path "$PSScriptRoot\..").Path
$HostPath = Join-Path $Root "dist\ytdlp-browser-host.exe"
$BinPath = Join-Path $Root "dist\bin"
if (-not (Test-Path $HostPath)) { throw "Build the native host first with scripts\build-host.ps1." }
foreach ($name in @("yt-dlp.exe", "ffmpeg.exe", "ffprobe.exe")) {
    if (-not (Test-Path (Join-Path $BinPath $name))) { throw "Missing dist\bin\$name." }
}

if (Test-Path $Output) { Remove-Item $Output -Recurse -Force }
$Stage = Join-Path $Output "yt-dlp-browser"
New-Item -ItemType Directory -Force -Path $Stage | Out-Null
Copy-Item (Join-Path $Root "extension") (Join-Path $Stage "extension") -Recurse
New-Item -ItemType Directory -Force -Path (Join-Path $Stage "native-host\bin") | Out-Null
Copy-Item $HostPath (Join-Path $Stage "native-host\ytdlp-browser-host.exe")
foreach ($name in @("yt-dlp.exe", "ffmpeg.exe", "ffprobe.exe")) {
    Copy-Item (Join-Path $BinPath $name) (Join-Path $Stage "native-host\bin\$name")
}
Copy-Item (Join-Path $Root "scripts\install-host.ps1") (Join-Path $Stage "install-host.ps1")
Copy-Item (Join-Path $Root "README.md") (Join-Path $Stage "README.md")
Copy-Item (Join-Path $Root "LICENSE") (Join-Path $Stage "LICENSE")
Copy-Item (Join-Path $Root "THIRD_PARTY_NOTICES.md") (Join-Path $Stage "THIRD_PARTY_NOTICES.md")

$Zip = Join-Path $Output "yt-dlp-browser-v$Version-windows.zip"
Compress-Archive -Path $Stage -DestinationPath $Zip -Force
Write-Host "Created $Zip"
