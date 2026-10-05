Put "yt-dlp.exe", "ffmpeg.exe", and "ffprobe.exe" into "native-host/bin/", then run:

powershell:
.\scripts\build-host.ps1

Load "extension/" as an unpacked extension, copy its ID, then register the helper:

powershell:
.\scripts\install-host.ps1 -ExtensionId "YOUR_EXTENSION_ID"

To prepare a distributable Windows package after building the host:

powershell:
.\scripts\package-release.ps1