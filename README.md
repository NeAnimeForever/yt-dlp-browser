# yt-dlp Browser

A Chrome extension and local Windows helper for downloading supported media with [yt-dlp](https://github.com/yt-dlp/yt-dlp) directly from the page.

## What it does

The extension adds a **Download** button to supported YouTube video pages. It opens an in-page download dialog with:

- real formats and qualities reported by yt-dlp;
- video and audio-only downloads;
- output folder selection;
- advanced format and yt-dlp options;
- subtitles, metadata, thumbnails, chapters and post-processing;
- SponsorBlock, cookies from Chrome, proxy, rate limits and concurrent fragments;
- raw yt-dlp arguments;
- live download progress, speed, ETA and cancellation.

The browser extension is only the UI and messaging layer. A local native helper runs yt-dlp and FFmpeg on Windows.

## Install

GitHub-only distribution uses Chrome's unpacked extension mode and Native Messaging.

1. Download the latest Windows release from **[Releases](.............)** and extract it.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the extracted `extension` folder.
5. Copy the extension ID shown by Chrome.
6. Open PowerShell in the extracted release folder and run:

   ```powershell
   .\install-host.ps1 -ExtensionId "YOUR_EXTENSION_ID"
   ```

7. Reload the extension in `chrome://extensions`.
8. Open a supported video page and use **Download**.

The native host is registered for the current Windows user and does not require administrator privileges.

## Build from source

Requirements:

- Windows
- Google Chrome
- Python 3.9+
- PyInstaller
- yt-dlp
- FFmpeg (`ffmpeg.exe` and `ffprobe.exe`)

Put `yt-dlp.exe`, `ffmpeg.exe`, and `ffprobe.exe` into `native-host/bin/`, then run:

```powershell
.\scripts\build-host.ps1
```

Load `extension/` as an unpacked extension, copy its ID, then register the helper:

```powershell
.\scripts\install-host.ps1 -ExtensionId "YOUR_EXTENSION_ID"
```

To prepare a distributable Windows package after building the host:

```powershell
.\scripts\package-release.ps1
```

## Notes

The extension targets YouTube today. The native helper itself is not YouTube-specific.

The **Advanced options** section intentionally leaves some yt-dlp features available through the raw argument field instead of trying to duplicate every command-line flag in the UI.

This project is not affiliated with Google, Chrome, YouTube, or yt-dlp. Users are responsible for complying with applicable laws and the terms that apply to content and services they use.

## License

MIT. See [LICENSE](LICENSE).

Third-party resources and license information are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Made by NeAnimeForever.
