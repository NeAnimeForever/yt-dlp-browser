param(
    [string]$Python = "python",
    [string]$Output = "$PSScriptRoot\..\dist"
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path "$PSScriptRoot\..").Path
$HostDir = Join-Path $Root "native-host"
$OutputDir = (New-Item -ItemType Directory -Force -Path $Output).FullName
$BuildDir = Join-Path $Root "build"
$SpecDir = Join-Path $Root "build"

& $Python -m PyInstaller `
    --onefile `
    --clean `
    --name ytdlp-browser-host `
    --distpath $OutputDir `
    --workpath (Join-Path $BuildDir "pyinstaller") `
    --specpath $SpecDir `
    "$HostDir\native_host.py"

if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed." }

$BinDir = New-Item -ItemType Directory -Force -Path (Join-Path $OutputDir "bin")

if (Test-Path "$HostDir\bin\yt-dlp.exe") {
    Copy-Item "$HostDir\bin\yt-dlp.exe" $BinDir.FullName -Force
}

if (Test-Path "$HostDir\bin\ffmpeg.exe") {
    Copy-Item "$HostDir\bin\ffmpeg.exe" $BinDir.FullName -Force
}

if (Test-Path "$HostDir\bin\ffprobe.exe") {
    Copy-Item "$HostDir\bin\ffprobe.exe" $BinDir.FullName -Force
}

Write-Host "Built host: $(Join-Path $OutputDir 'ytdlp-browser-host.exe')"
Write-Host "Runtime files: $OutputDir"
