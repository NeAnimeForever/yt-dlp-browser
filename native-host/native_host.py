from __future__ import annotations

import json
import re
import os
import struct
import subprocess
import sys
import threading
import uuid
import shutil
from pathlib import Path

HOST_DIR = Path(sys.executable).resolve().parent if getattr(sys, 'frozen', False) else Path(__file__).resolve().parent
BIN_DIR = HOST_DIR / 'bin'
YTDLP_PATH = BIN_DIR / 'yt-dlp.exe'
FFMPEG_PATH = BIN_DIR / 'ffmpeg.exe'

jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()
cancelled_jobs: set[str] = set()
write_lock = threading.Lock()


def write_message(message: dict) -> None:
    payload = json.dumps(message, ensure_ascii=True, separators=(',', ':')).encode('utf-8')
    with write_lock:
        sys.stdout.buffer.write(struct.pack('@I', len(payload)))
        sys.stdout.buffer.write(payload)
        sys.stdout.buffer.flush()


def read_message() -> dict | None:
    header = sys.stdin.buffer.read(4)
    if not header:
        return None
    if len(header) != 4:
        raise EOFError('Incomplete native messaging header')
    length = struct.unpack('@I', header)[0]
    payload = sys.stdin.buffer.read(length)
    if len(payload) != length:
        raise EOFError('Incomplete native messaging payload')
    return json.loads(payload.decode('utf-8'))


def resolve_binary(name: str, bundled: Path) -> str:
    if bundled.exists():
        return str(bundled)
    return name


def emit_error(request_id: str | None, error: str, tab_id: int | None = None) -> None:
    write_message({'requestId': request_id, 'tabId': tab_id, 'type': 'error', 'ok': False, 'error': error})


def handle_ping(request: dict) -> None:
    write_message({
        'requestId': request.get('requestId'), 'tabId': request.get('tabId'), 'type': 'ping', 'ok': True,
        'ytDlp': resolve_binary('yt-dlp.exe', YTDLP_PATH), 'ffmpeg': resolve_binary('ffmpeg.exe', FFMPEG_PATH),
    })


def normalize_format(fmt: dict) -> dict:
    return {
        'id': fmt.get('format_id'),
        'ext': fmt.get('ext'),
        'width': fmt.get('width'),
        'height': fmt.get('height'),
        'fps': fmt.get('fps'),
        'vcodec': fmt.get('vcodec'),
        'acodec': fmt.get('acodec'),
        'tbr': fmt.get('tbr'),
        'vbr': fmt.get('vbr'),
        'abr': fmt.get('abr'),
        'filesize': fmt.get('filesize'),
        'filesizeApprox': fmt.get('filesize_approx'),
        'protocol': fmt.get('protocol'),
        'dynamicRange': fmt.get('dynamic_range'),
        'hasVideo': fmt.get('vcodec') not in (None, 'none'),
        'hasAudio': fmt.get('acodec') not in (None, 'none'),
    }


def build_video_qualities(formats: list[dict]) -> list[dict]:
    best: dict[tuple[int, int], dict[str, float | int]] = {}
    for fmt in formats:
        height = fmt.get('height')
        if not isinstance(height, int) or height <= 0 or fmt.get('vcodec') in (None, 'none'):
            continue
        fps = fmt.get('fps')
        fps_value = int(round(fps)) if isinstance(fps, (int, float)) and fps > 0 else 0
        key = (height, fps_value)
        current = best.get(key)
        if current is None or fps_value > current['fps']:
            best[key] = {'height': height, 'fps': fps_value}
    return sorted(best.values(), key=lambda item: (item['height'], item['fps']), reverse=True)


def handle_info(request: dict) -> None:
    request_id, tab_id, url = request.get('requestId'), request.get('tabId'), request.get('url')
    if not isinstance(url, str) or not url:
        return emit_error(request_id, 'Missing URL.', tab_id)
    yt_dlp = resolve_binary('yt-dlp.exe', YTDLP_PATH)
    command = [yt_dlp, '--dump-single-json', '--skip-download', '--no-warnings', '--', url]
    try:
        result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=120)
    except Exception as exc:
        return emit_error(request_id, str(exc), tab_id)
    if result.returncode != 0:
        return emit_error(request_id, result.stderr.strip() or f'yt-dlp exited with code {result.returncode}.', tab_id)
    try:
        info = json.loads(result.stdout)
    except json.JSONDecodeError:
        return emit_error(request_id, 'yt-dlp returned invalid JSON.', tab_id)

    formats = [normalize_format(fmt) for fmt in info.get('formats') or [] if fmt.get('format_id') is not None]
    video_formats = [fmt for fmt in formats if fmt['hasVideo']]
    audio_formats = [fmt for fmt in formats if fmt['hasAudio'] and not fmt['hasVideo']]
    subtitles = sorted((info.get('subtitles') or {}).keys())
    automatic_subtitles = sorted((info.get('automatic_captions') or {}).keys())

    write_message({
        'requestId': request_id, 'tabId': tab_id, 'type': 'info', 'ok': True,
        'info': {
            'id': info.get('id'), 'title': info.get('title'), 'uploader': info.get('uploader'),
            'duration': info.get('duration'), 'thumbnail': info.get('thumbnail'), 'webpageUrl': info.get('webpage_url'),
            'formats': len(formats), 'videoQualities': build_video_qualities(info.get('formats') or []),
            'formatsList': formats, 'videoFormats': video_formats, 'audioFormats': audio_formats,
            'subtitles': subtitles, 'automaticSubtitles': automatic_subtitles,
        },
    })


def cleanup_cancelled_job(job: dict) -> None:
    for raw_path in list(job.get('paths', set())):
        path = Path(raw_path)
        try:
            if str(path) in job.get('preexisting', set()):
                continue
            candidates = [
                path,
                Path(f'{path}.part'),
                Path(f'{path}.ytdl'),
                Path(f'{path}.part.ytdl'),
            ]
            candidates.extend(path.parent.glob(f'{path.name}.part-*'))
            for candidate in candidates:
                try:
                    if candidate.is_file():
                        candidate.unlink()
                except OSError:
                    pass
        except Exception:
            pass
    temp_dir = job.get('tempDir')
    if temp_dir:
        try:
            shutil.rmtree(temp_dir, ignore_errors=True)
        except Exception:
            pass


def parse_download_line(line: str, request_id: str, tab_id: int | None) -> bool:
    line = line.replace('\x1b[0m', '').rstrip('\r\n')
    if line.startswith('PROGRESS|'):
        parts = line.split('|', 6)
        write_message({
            'requestId': request_id, 'tabId': tab_id, 'type': 'progress', 'ok': True,
            'status': parts[1] if len(parts) > 1 else None, 'percent': parts[2] if len(parts) > 2 else None,
            'eta': parts[3] if len(parts) > 3 else None, 'speed': parts[4] if len(parts) > 4 else None,
            'downloaded': parts[5] if len(parts) > 5 else None, 'total': parts[6] if len(parts) > 6 else None,
            'stage': 'download',
        })
        return True
    if line.startswith('POST|'):
        write_message({'requestId': request_id, 'tabId': tab_id, 'type': 'progress', 'ok': True, 'stage': 'postprocess', 'percent': None, 'eta': None, 'speed': None, 'downloaded': None, 'total': None, 'status': line[5:]})
        return True
    if line.startswith('TARGET|'):
        path = line[7:]
        with jobs_lock:
            job = jobs.get(request_id)
            if job and path:
                normalized = str(Path(path))
                job.setdefault('paths', set()).add(normalized)
                if Path(path).exists():
                    job.setdefault('preexisting', set()).add(normalized)
        return True
    if line.startswith('FILE|'):
        write_message({'requestId': request_id, 'tabId': tab_id, 'type': 'file', 'ok': True, 'path': line[5:]})
        return True
    # Fallback for yt-dlp's normal progress output if a future version ignores the custom template.
    if line.lstrip().startswith('[download]'):
        match = re.search(r'(?P<pct>\d+(?:\.\d+)?)%.*?(?P<speed>\S+/s).*?ETA\s+(?P<eta>\S+)', line)
        if match:
            write_message({
                'requestId': request_id, 'tabId': tab_id, 'type': 'progress', 'ok': True,
                'status': 'downloading', 'percent': match.group('pct') + '%', 'eta': match.group('eta'),
                'speed': match.group('speed'), 'downloaded': None, 'total': None, 'stage': 'download',
            })
            return True
    return False


def _read_stream(stream, request_id: str, tab_id: int | None, stderr_lines: list[str]) -> None:
    try:
        for raw_line in stream:
            line = raw_line.rstrip('\r\n')
            if parse_download_line(line, request_id, tab_id):
                continue
            stderr_lines.append(line)
    except Exception:
        pass


def stream_download(request: dict, process: subprocess.Popen[str]) -> None:
    request_id, tab_id = request.get('requestId'), request.get('tabId')
    stderr_lines: list[str] = []
    try:
        assert process.stdout is not None and process.stderr is not None
        stdout_thread = threading.Thread(target=_read_stream, args=(process.stdout, request_id, tab_id, stderr_lines), daemon=True)
        stderr_thread = threading.Thread(target=_read_stream, args=(process.stderr, request_id, tab_id, stderr_lines), daemon=True)
        stdout_thread.start()
        stderr_thread.start()
        stdout_thread.join()
        stderr_thread.join(timeout=2)
        return_code = process.wait()
        with jobs_lock:
            job = jobs.pop(request_id, None)
            was_cancelled = request_id in cancelled_jobs
            cancelled_jobs.discard(request_id)
        if was_cancelled:
            if job:
                cleanup_cancelled_job(job)
            write_message({'requestId': request_id, 'tabId': tab_id, 'type': 'cancelled', 'ok': True, 'cleaned': True})
        elif return_code == 0:
            if job and job.get('tempDir'):
                shutil.rmtree(job['tempDir'], ignore_errors=True)
            write_message({'requestId': request_id, 'tabId': tab_id, 'type': 'complete', 'ok': True})
        else:
            if job and job.get('tempDir'):
                shutil.rmtree(job['tempDir'], ignore_errors=True)
            error = '\n'.join(stderr_lines[-20:]).strip() or f'yt-dlp exited with code {return_code}.'
            emit_error(request_id, error, tab_id)
    except Exception as exc:
        with jobs_lock:
            job = jobs.pop(request_id, None)
            was_cancelled = request_id in cancelled_jobs
            cancelled_jobs.discard(request_id)
        if was_cancelled:
            if job:
                cleanup_cancelled_job(job)
            write_message({'requestId': request_id, 'tabId': tab_id, 'type': 'cancelled', 'ok': True, 'cleaned': True})
        else:
            emit_error(request_id, str(exc), tab_id)


def add_option(command: list[str], flag: str, value: str | None = None) -> None:
    if value is None:
        command.append(flag)
    elif value != '':
        command.extend([flag, value])


def handle_download(request: dict) -> None:
    request_id = request.get('requestId') or str(uuid.uuid4())
    tab_id = request.get('tabId')
    url = request.get('url')
    options = request.get('options') if isinstance(request.get('options'), dict) else {}
    if not isinstance(url, str) or not url:
        return emit_error(request_id, 'Missing URL.', tab_id)

    output_dir = options.get('outputDir') or str(Path.home() / 'Downloads')
    if not isinstance(output_dir, str) or not output_dir:
        return emit_error(request_id, 'Invalid output directory.', tab_id)
    try:
        Path(output_dir).mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        return emit_error(request_id, f'Cannot create output directory: {exc}', tab_id)

    yt_dlp = resolve_binary('yt-dlp.exe', YTDLP_PATH)
    ffmpeg = resolve_binary('ffmpeg.exe', FFMPEG_PATH)
    mode = options.get('mode') or 'video'
    format_value = options.get('format') or ('bestaudio/best' if mode == 'audio' else 'bv*+ba/b')
    output_template = str(options.get('outputTemplate') or '%(title)s [%(id)s].%(ext)s')
    temp_dir = Path(output_dir) / f'.ytdlp-browser-{request_id}'

    command = [yt_dlp]
    add_option(command, '--no-playlist') if options.get('noPlaylist', True) else None
    command += ['--newline', '--progress', '--progress-delta', '0.2']
    command += ['--progress-template', 'download:PROGRESS|%(progress.status)s|%(progress._percent_str)s|%(progress._eta_str)s|%(progress._speed_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s']
    command += ['--progress-template', 'postprocess:POST|%(progress.status)s']
    command += ['--print', 'before_dl:TARGET|%(filepath)s', '--print', 'after_move:FILE|%(filepath)s', '--ffmpeg-location', ffmpeg, '--no-warnings']
    if os.path.isabs(output_template):
        command += ['--output', output_template]
    else:
        temp_dir.mkdir(parents=True, exist_ok=True)
        command += ['--paths', f'home:{output_dir}', '--paths', f'temp:{temp_dir}', '--output', output_template]
    add_option(command, '-f', str(format_value))

    if options.get('mergeFormat'): add_option(command, '--merge-output-format', str(options['mergeFormat']))
    if options.get('formatSort'): add_option(command, '-S', str(options['formatSort']))
    if options.get('videoMultistreams'): add_option(command, '--video-multistreams')
    if options.get('audioMultistreams'): add_option(command, '--audio-multistreams')
    if options.get('checkFormats'): add_option(command, '--check-formats')

    if options.get('continue'): add_option(command, '--continue')
    if options.get('noOverwrites'): add_option(command, '--no-overwrites')
    if options.get('forceOverwrites'): add_option(command, '--force-overwrites')
    if options.get('restrictFilenames'): add_option(command, '--restrict-filenames')
    if options.get('writeThumbnail'): add_option(command, '--write-thumbnail')
    if options.get('writeInfoJson'): add_option(command, '--write-info-json')
    if options.get('writeDescription'): add_option(command, '--write-description')
    if options.get('writeComments'): add_option(command, '--write-comments')
    if options.get('outputArchive'): add_option(command, '--download-archive', str(options['outputArchive']))

    if options.get('writeSubs'): add_option(command, '--write-subs')
    if options.get('writeAutoSubs'): add_option(command, '--write-auto-subs')
    if options.get('embedSubs'): add_option(command, '--embed-subs')
    if options.get('subLangs'): add_option(command, '--sub-langs', str(options['subLangs']))
    if options.get('subFormat'): add_option(command, '--sub-format', str(options['subFormat']))

    if options.get('embedMetadata'): add_option(command, '--embed-metadata')
    if options.get('embedThumbnail'): add_option(command, '--embed-thumbnail')
    if options.get('embedChapters'): add_option(command, '--embed-chapters')
    if options.get('splitChapters'): add_option(command, '--split-chapters')
    if options.get('remux'): add_option(command, '--remux-video', str(options['remux']))
    if options.get('recode'): add_option(command, '--recode-video', str(options['recode']))

    if mode == 'audio':
        add_option(command, '-x')
        if options.get('audioFormat') and options.get('audioFormat') != 'best': add_option(command, '--audio-format', str(options['audioFormat']))
        if options.get('audioQuality'): add_option(command, '--audio-quality', str(options['audioQuality']))

    if options.get('cookiesChrome'): add_option(command, '--cookies-from-browser', 'chrome')
    if options.get('proxy'): add_option(command, '--proxy', str(options['proxy']))
    if options.get('socketTimeout'): add_option(command, '--socket-timeout', str(options['socketTimeout']))
    if options.get('concurrentFragments'): add_option(command, '--concurrent-fragments', str(options['concurrentFragments']))
    if options.get('rateLimit'): add_option(command, '--limit-rate', str(options['rateLimit']))
    if options.get('sponsorMark'): add_option(command, '--sponsorblock-mark', str(options['sponsorMark']))
    if options.get('sponsorRemove'): add_option(command, '--sponsorblock-remove', str(options['sponsorRemove']))

    raw_args = options.get('rawArgs') if isinstance(options.get('rawArgs'), list) else []
    command.extend(str(arg) for arg in raw_args if isinstance(arg, str) and arg)
    command += ['--', url]

    try:
        process = subprocess.Popen(
            command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding='utf-8', errors='replace', bufsize=1,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
    except Exception as exc:
        return emit_error(request_id, str(exc), tab_id)

    job = {'process': process, 'paths': set(), 'preexisting': set(), 'tempDir': str(temp_dir) if temp_dir.exists() else None}
    with jobs_lock:
        jobs[request_id] = job
    threading.Thread(target=stream_download, args=(request, process), daemon=True).start()
    write_message({'requestId': request_id, 'tabId': tab_id, 'type': 'started', 'ok': True})


def handle_browse_folder(request: dict) -> None:
    request_id, tab_id = request.get('requestId'), request.get('tabId')
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        folder = filedialog.askdirectory(title='Choose download folder')
        root.destroy()
        write_message({'requestId': request_id, 'tabId': tab_id, 'type': 'browse_folder', 'ok': True, 'path': folder or None})
    except Exception as exc:
        emit_error(request_id, f'Unable to open folder picker: {exc}', tab_id)


def terminate_process_tree(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    if os.name == 'nt':
        try:
            subprocess.run(
                ['taskkill', '/PID', str(process.pid), '/T', '/F'],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                check=False, timeout=10,
            )
        except Exception:
            pass
    try:
        process.terminate()
        process.wait(timeout=5)
    except Exception:
        try:
            process.kill()
        except Exception:
            pass


def handle_cancel(request: dict) -> None:
    request_id = request.get('requestId')
    if not request_id:
        return emit_error(request_id, 'Missing requestId.', request.get('tabId'))
    with jobs_lock:
        job = jobs.get(request_id)
        if not job:
            return emit_error(request_id, 'Download job not found.', request.get('tabId'))
        cancelled_jobs.add(request_id)
        process = job['process']
    terminate_process_tree(process)


def main() -> int:
    for raw_request in iter(read_message, None):
        action = raw_request.get('action') if isinstance(raw_request, dict) else None
        try:
            if action == 'ping': handle_ping(raw_request)
            elif action == 'info': handle_info(raw_request)
            elif action == 'download': handle_download(raw_request)
            elif action == 'browse_folder': handle_browse_folder(raw_request)
            elif action == 'cancel': handle_cancel(raw_request)
            else: emit_error(raw_request.get('requestId'), f'Unknown action: {action!r}', raw_request.get('tabId'))
        except Exception as exc:
            emit_error(raw_request.get('requestId'), str(exc), raw_request.get('tabId'))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
