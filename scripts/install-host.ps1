param(
    [Parameter(Mandatory=$true)][string]$ExtensionId,
    [string]$InstallRoot = "$env:LOCALAPPDATA\yt-dlp-browser"
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path "$PSScriptRoot\..").Path
$RepoHost = Join-Path $Root "dist\ytdlp-browser-host.exe"
$PackagedHost = Join-Path $Root "native-host\ytdlp-browser-host.exe"
$HostSource = if (Test-Path $RepoHost) { $RepoHost } elseif (Test-Path $PackagedHost) { $PackagedHost } else { $null }
if (-not $HostSource) { throw "Native host not found. Build it first with scripts\build-host.ps1 or use a Windows release package." }

New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $InstallRoot "bin") | Out-Null
Copy-Item $HostSource (Join-Path $InstallRoot "ytdlp-browser-host.exe") -Force

$BinSource = if (Test-Path (Join-Path $Root "dist\bin")) { Join-Path $Root "dist\bin" } else { Join-Path $Root "native-host\bin" }
foreach ($name in @("yt-dlp.exe", "ffmpeg.exe", "ffprobe.exe")) {
    $source = Join-Path $BinSource $name
    if (Test-Path $source) { Copy-Item $source (Join-Path $InstallRoot "bin\$name") -Force }
}

$manifestPath = Join-Path $InstallRoot "com.neanime.ytdlp_browser.json"
$manifest = [ordered]@{
    name = "com.neanime.ytdlp_browser"
    description = "Native host for yt-dlp Browser"
    path = (Join-Path $InstallRoot "ytdlp-browser-host.exe")
    type = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -Path $manifestPath -Encoding UTF8

$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.neanime.ytdlp_browser"
New-Item -Path $registryPath -Force | Out-Null
Set-ItemProperty -Path $registryPath -Name '(default)' -Value $manifestPath

Write-Host "Native host installed to $InstallRoot"
Write-Host "Extension ID: $ExtensionId"
