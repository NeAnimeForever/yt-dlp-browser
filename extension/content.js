(() => {
  const BUTTON_ID = 'ytdlp-browser-download-button';
  const STYLE_ID = 'ytdlp-browser-style';
  const MODAL_HOST_ID = 'ytdlp-browser-modal-host';
  const SETTINGS_KEY = 'ytdlpBrowserSettings';

  const state = {
    currentUrl: location.href,
    pendingInfoId: null,
    activeDownloadId: null,
    pendingBrowseId: null,
    activeInfo: null,
    closeAfterCancel: false,
    settings: {
      outputDir: '',
      formatSelector: 'bv*+ba/b',
      outputTemplate: '%(title)s [%(id)s].%(ext)s'
    }
  };

  function getVideoUrl() { return location.href; }

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  }

  function findActionToolbar() {
    const selectors = [
      'ytd-watch-metadata #actions-inner #top-level-buttons-computed',
      'ytd-watch-metadata #top-level-buttons-computed',
      '#actions-inner #top-level-buttons-computed',
      '#top-level-buttons-computed'
    ];
    for (const selector of selectors) {
      const candidates = [...document.querySelectorAll(selector)].filter(isVisible);
      if (candidates.length) return candidates[candidates.length - 1];
    }
    return null;
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${BUTTON_ID}{display:inline-flex!important;align-items:center!important;justify-content:center!important;gap:6px!important;box-sizing:border-box!important;min-width:0!important;height:36px!important;margin-left:8px!important;padding:0 14px!important;border:0!important;border-radius:18px!important;background:var(--yt-spec-badge-chip-background,rgba(0,0,0,.05))!important;color:var(--yt-spec-text-primary,#0f0f0f)!important;font:500 14px Roboto,Arial,sans-serif!important;line-height:20px!important;white-space:nowrap!important;cursor:pointer!important;transition:background-color .15s ease,opacity .15s ease!important;vertical-align:middle!important}
      html[dark] #${BUTTON_ID}{background:rgba(255,255,255,.1)!important;color:#f1f1f1!important}
      #${BUTTON_ID}:hover{background:rgba(0,0,0,.1)!important} html[dark] #${BUTTON_ID}:hover{background:rgba(255,255,255,.2)!important}
      #${BUTTON_ID}:disabled{opacity:.65!important;cursor:default!important}
      #${BUTTON_ID} svg{width:20px!important;height:20px!important;flex:0 0 20px!important;fill:currentColor!important}
      #${BUTTON_ID} span{color:inherit!important}
    `;
    (document.head || document.documentElement).append(style);
  }

  function setButtonState(button, text, disabled = false) {
    const label = button?.querySelector('span');
    if (label) label.textContent = text;
    if (button) button.disabled = disabled;
  }

  function getDownloadIcon() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3a1 1 0 0 1 1 1v9.17l2.59-2.58L17 12l-5 5-5-5 1.41-1.41L11 13.17V4a1 1 0 0 1 1-1Zm-7 15h14v2H5v-2Z"/></svg>';
  }

  function createButton(toolbar) {
    let button = document.getElementById(BUTTON_ID);
    if (button?.parentElement === toolbar) return button;
    button?.remove();
    button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.title = 'Download with yt-dlp Browser';
    button.setAttribute('aria-label', 'Download with yt-dlp Browser');
    button.innerHTML = `${getDownloadIcon()}<span>Download</span>`;
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (!button.disabled) requestInfo(button);
    });
    toolbar.appendChild(button);
    return button;
  }

  function requestInfo(button) {
    const requestId = crypto.randomUUID();
    state.pendingInfoId = requestId;
    setButtonState(button, 'Checking…', true);
    chrome.runtime.sendMessage({
      type: 'native-request',
      request: { action: 'info', requestId, url: getVideoUrl() }
    }, response => {
      if (chrome.runtime.lastError || !response?.ok) {
        state.pendingInfoId = null;
        setButtonState(button, 'Download');
        showError(`Unable to contact yt-dlp: ${response?.error ?? chrome.runtime.lastError?.message ?? 'Native host is not available.'}`);
      }
    });
  }

  function maybeCreateButton() {
    if (!location.pathname.startsWith('/watch')) return;
    const toolbar = findActionToolbar();
    if (!toolbar) return;
    ensureStyles();
    createButton(toolbar);
  }

  function handleNavigation() {
    if (state.currentUrl === location.href) return;
    state.currentUrl = location.href;
    state.pendingInfoId = null;
    if (state.activeDownloadId) cancelDownload(false, false);
    state.activeDownloadId = null;
    state.activeInfo = null;
    document.getElementById(MODAL_HOST_ID)?.remove();
    document.getElementById(BUTTON_ID)?.remove();
    setTimeout(maybeCreateButton, 250);
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '';
    const total = Math.floor(seconds), h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
  }

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    const units = ['B','KiB','MiB','GiB','TiB'];
    let size = bytes, unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
    return `${size >= 100 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
  }

  function formatSpeed(value) {
    const bytes = Number(value);
    return Number.isFinite(bytes) && bytes > 0 ? `${formatBytes(bytes)}/s` : String(value ?? '');
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[char]));
  }

  function qualitySelector(info) {
    const qualities = Array.isArray(info?.videoQualities) ? info.videoQualities : [];
    const options = ['<option value="bv*+ba/b">Best available</option>'];
    for (const item of qualities) {
      const fps = item.fps ? ` · ${Math.round(item.fps)} fps` : '';
      const label = `${item.height}p${fps}`;
      const expr = item.fps ? `bv*[height<=${item.height}][fps<=${Math.round(item.fps)}]+ba/b[height<=${item.height}]` : `bv*[height<=${item.height}]+ba/b[height<=${item.height}]`;
      options.push(`<option value="${escapeHtml(expr)}">${escapeHtml(label)}</option>`);
    }
    return options.join('');
  }

  function buildFormatRows(info) {
    const rows = [];
    for (const fmt of (info?.formatsList ?? [])) {
      const type = fmt.hasVideo ? (fmt.hasAudio ? 'AV' : 'V') : (fmt.hasAudio ? 'A' : '-');
      const resolution = fmt.height ? `${fmt.width || '?'}×${fmt.height}` : '-';
      const fps = fmt.fps ? `${Math.round(fmt.fps)} fps` : '-';
      const bitrate = fmt.tbr ? `${Number(fmt.tbr).toFixed(0)} kb/s` : '-';
      const size = formatBytes(fmt.filesize ?? fmt.filesizeApprox);
      const codec = fmt.hasVideo ? (fmt.vcodec || '-') : (fmt.acodec || '-');
      const details = [codec, fmt.ext || '-', fps, bitrate, size].join(' · ');
      const selector = fmt.hasVideo && !fmt.hasAudio ? `${fmt.id}+ba/b` : String(fmt.id);
      rows.push(`<button class="format-row" data-format="${escapeHtml(selector)}"><span class="format-type">${type}</span><span class="format-id">${escapeHtml(fmt.id)}</span><span class="format-main">${escapeHtml(resolution)}<small>${escapeHtml(details)}</small></span></button>`);
    }
    return rows.join('') || '<div class="empty">No individual formats were returned by yt-dlp.</div>';
  }

  function checkboxHtml(cls, label, checked = false) {
    return `<label class="check"><input type="checkbox" class="${cls}"${checked ? ' checked' : ''}><span>${escapeHtml(label)}</span></label>`;
  }

  function openModal(info) {
    closeModal();
    state.activeInfo = info;
    loadSettings();
    const host = document.createElement('div');
    host.id = MODAL_HOST_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host{all:initial} *{box-sizing:border-box}
        @keyframes yb-backdrop-in{from{opacity:0}to{opacity:1}}@keyframes yb-modal-in{from{opacity:0;transform:translateY(18px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}@keyframes yb-item-in{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:translateY(0)}}@keyframes yb-pulse{0%,100%{opacity:1}50%{opacity:.58}}.backdrop{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:flex-start;justify-content:center;padding:7vh 20px 28px;background:rgba(0,0,0,.62);font-family:Roboto,Arial,sans-serif;color:#0f0f0f;animation:yb-backdrop-in .18s ease-out both}
        .modal{width:min(720px,calc(100vw - 28px));max-height:86vh;overflow:auto;border-radius:18px;background:#fff;box-shadow:0 20px 80px rgba(0,0,0,.42);animation:yb-modal-in .24s cubic-bezier(.2,.8,.2,1) both}
        .dark .modal{background:#212121;color:#f1f1f1}.header{display:flex;gap:14px;align-items:center;padding:18px 20px 12px;animation:yb-item-in .25s .04s ease-out both}.thumb{width:150px;aspect-ratio:16/9;object-fit:cover;border-radius:9px;background:#eee}.heading{min-width:0}.title{font-size:17px;font-weight:600;line-height:1.35}.meta{margin-top:5px;font-size:12px;opacity:.68}.close{margin-left:auto;align-self:flex-start;border:0;background:transparent;color:inherit;font-size:25px;cursor:pointer}.body{padding:8px 20px 18px}.tabs{display:flex;gap:8px;margin:6px 0 18px;animation:yb-item-in .25s .08s ease-out both}.tab{border:0;border-radius:18px;padding:8px 14px;background:#eee;color:inherit;cursor:pointer;font:500 13px Roboto,Arial,sans-serif;transition:transform .16s ease,background-color .16s ease,box-shadow .16s ease}.tab:hover{transform:translateY(-1px)}.dark .tab{background:#333}.tab.active{background:#0f0f0f;color:#fff}.dark .tab.active{background:#fff;color:#0f0f0f}.section{margin-bottom:15px;animation:yb-item-in .24s .11s ease-out both}.label{display:block;margin-bottom:7px;font-size:12px;font-weight:600;opacity:.72}.row{display:grid;grid-template-columns:1fr auto;gap:8px}.row>*{min-width:0}.select,select,input[type=text],input[type=number],textarea{width:100%;border:1px solid rgba(127,127,127,.35);border-radius:10px;padding:10px 12px;background:transparent;color:inherit;font:inherit;outline:none}.select:focus,select:focus,input[type=text]:focus,input[type=number]:focus,textarea:focus{border-color:#888}.backdrop select{background:#fff!important;color:#111!important;color-scheme:light}.backdrop select option{background:#fff;color:#111}.dark select{background:#2b2b2b!important;color:#f1f1f1!important;color-scheme:dark}.dark select option{background:#2b2b2b;color:#f1f1f1}.hint{margin-top:6px;font-size:11px;opacity:.55}.path-row{display:grid;grid-template-columns:1fr auto;gap:8px}.small-btn,.browse{border:0;border-radius:10px;padding:10px 13px;background:#eee;color:inherit;cursor:pointer;font:500 12px Roboto,Arial,sans-serif;transition:transform .16s ease,filter .16s ease}.small-btn:hover,.browse:hover{transform:translateY(-1px);filter:brightness(.97)}.dark .small-btn,.dark .browse{background:#333}.advanced-toggle{width:100%;display:flex;align-items:center;justify-content:space-between;margin:6px 0 4px;padding:12px 14px;border:0;border-radius:11px;background:#f2f2f2;color:inherit;cursor:pointer;font:600 13px Roboto,Arial,sans-serif;transition:transform .16s ease,background-color .16s ease}.advanced-toggle:hover{transform:translateY(-1px)}.dark .advanced-toggle{background:#2b2b2b}.advanced-toggle .chevron{transition:transform .22s cubic-bezier(.2,.8,.2,1)}.advanced-toggle.open .chevron{transform:rotate(180deg)}.advanced{display:grid;grid-template-rows:0fr;padding-top:0;opacity:0;transition:grid-template-rows .25s ease,opacity .18s ease,padding-top .25s ease}.advanced>div{min-height:0;overflow:hidden}.advanced.open{grid-template-rows:1fr;padding-top:8px;opacity:1}.advanced-group{padding:12px 0;border-top:1px solid rgba(127,127,127,.18)}.advanced-group:first-child{border-top:0}.group-title{margin-bottom:9px;font-size:12px;font-weight:700}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}.check{display:flex;align-items:center;gap:8px;margin:7px 0;font-size:12px;cursor:pointer}.check input{width:auto;margin:0}.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px}.chip{border:1px solid rgba(127,127,127,.28);border-radius:16px;padding:5px 8px;background:transparent;color:inherit;cursor:pointer;font:500 11px Roboto,Arial,sans-serif}.format-list{max-height:250px;overflow:auto;border:1px solid rgba(127,127,127,.24);border-radius:10px;margin-top:8px}.format-row{display:grid;grid-template-columns:34px 44px 1fr;gap:8px;width:100%;padding:8px 10px;border:0;border-bottom:1px solid rgba(127,127,127,.12);background:transparent;color:inherit;text-align:left;cursor:pointer;font:500 12px Roboto,Arial,sans-serif}.format-row:last-child{border-bottom:0}.format-row{transition:background-color .14s ease,transform .14s ease}.format-row:hover{background:rgba(127,127,127,.10);transform:translateX(2px)}.format-type{opacity:.6}.format-id{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.format-main small{display:block;margin-top:2px;font-size:10px;opacity:.56;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.empty{padding:12px;font-size:11px;opacity:.56}.raw{min-height:130px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:1.45}.progress{margin-top:16px;display:none;padding:12px 0 4px}.progress .bar{margin-top:2px}.progress-row{display:flex;justify-content:space-between;gap:12px;font-size:12px;margin-bottom:8px}.percent{font-weight:700}.eta{opacity:.72}.bar{height:8px;border-radius:4px;background:rgba(127,127,127,.22);overflow:hidden}.fill{height:100%;width:0%;background:#ff0000;transition:width .22s cubic-bezier(.2,.8,.2,1)}.status{margin-top:8px;font-size:11px;opacity:.72;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.error{color:#d93025;font-size:12px;margin-top:10px;display:none;white-space:pre-wrap}.footer{display:flex;justify-content:flex-end;gap:8px;padding:0 20px 18px}.button{border:0;border-radius:20px;padding:10px 18px;font:600 14px Roboto,Arial,sans-serif;cursor:pointer;transition:transform .16s ease,filter .16s ease,opacity .16s ease}.button:not(:disabled):hover{transform:translateY(-1px);filter:brightness(.97)}.button:not(:disabled):active{transform:translateY(0) scale(.98)}.secondary{background:#eee;color:inherit}.dark .secondary{background:#333}.primary{background:#0f0f0f;color:#fff}.dark .primary{background:#fff;color:#0f0f0f}.button:disabled{opacity:.5;cursor:default}.file{margin-top:6px;font-size:10px;opacity:.6;word-break:break-all;animation:yb-item-in .2s ease-out both}.progress .status{animation:yb-pulse 1.8s ease-in-out infinite}.close{transition:transform .16s ease,opacity .16s ease}.close:hover{transform:rotate(8deg) scale(1.08);opacity:.75}
        @media(max-width:640px){.header{align-items:flex-start}.thumb{width:112px}.grid2{grid-template-columns:1fr}.backdrop{padding:4vh 8px 12px}.modal{width:calc(100vw - 12px)}}
      @media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}
      </style>
      <div class="backdrop"><div class="modal">
        <div class="header">
          ${info.thumbnail ? `<img class="thumb" src="${escapeHtml(info.thumbnail)}">` : '<div class="thumb"></div>'}
          <div class="heading"><div class="title">${escapeHtml(info.title || 'Video')}</div><div class="meta">${escapeHtml(info.uploader || '')}${info.duration ? ` · ${escapeHtml(formatDuration(Number(info.duration)))}` : ''} · ${Number(info.formats || 0)} formats</div></div>
          <button class="close" title="Close">×</button>
        </div>
        <div class="body">
          <div class="tabs"><button class="tab active" data-mode="video">Video</button><button class="tab" data-mode="audio">Audio only</button></div>
          <div class="section video-section"><label class="label">Quality</label><select class="quality">${qualitySelector(info)}</select></div>
          <div class="section audio-section" style="display:none"><div class="grid2"><div><label class="label">Audio format</label><select class="audio-format"><option value="best">Best / original</option><option value="aac">AAC</option><option value="alac">ALAC</option><option value="flac">FLAC</option><option value="m4a">M4A</option><option value="mp3">MP3</option><option value="opus">Opus</option><option value="vorbis">Vorbis</option><option value="wav">WAV</option></select></div><div><label class="label">Audio quality</label><input type="text" class="audio-quality" value="5" placeholder="0–10 or 128K"></div></div></div>
          <div class="section"><label class="label">Save to</label><div class="path-row"><input type="text" class="path" value="${escapeHtml(state.settings.outputDir)}" placeholder="Leave empty for Downloads"><button class="browse">Browse</button></div><div class="hint">Windows folder path. The last used path is remembered locally.</div></div>
          <button class="advanced-toggle"><span>Advanced options</span><span class="chevron">⌄</span></button>
          <div class="advanced"><div>
            <div class="advanced-group"><div class="group-title">Format & selection</div><label class="label">yt-dlp format selector</label><input type="text" class="format-selector" value="${escapeHtml(state.settings.formatSelector)}"><div class="hint">This is the exact value passed to <code>-f</code>. You can use any yt-dlp format selector here.</div><div class="format-list">${buildFormatRows(info)}</div><div class="grid2" style="margin-top:10px"><div><label class="label">Merge container</label><select class="merge-format"><option value="">Auto</option><option>mp4</option><option>mkv</option><option>webm</option><option>mov</option><option>avi</option><option>flv</option><option>ts</option></select></div><div><label class="label">Format sort</label><input type="text" class="format-sort" placeholder="e.g. res,fps,codec"></div></div>${checkboxHtml('video-multistreams','Allow multiple video streams')}${checkboxHtml('audio-multistreams','Allow multiple audio streams')}${checkboxHtml('check-formats','Check selected formats are downloadable')}</div>
            <div class="advanced-group"><div class="group-title">Files & naming</div><label class="label">Output template</label><input type="text" class="output-template" value="${escapeHtml(state.settings.outputTemplate)}"><div class="grid2" style="margin-top:10px"><div>${checkboxHtml('continue','Resume partial downloads',true)}${checkboxHtml('no-overwrites','Do not overwrite existing files')}${checkboxHtml('force-overwrites','Overwrite existing files')}</div><div>${checkboxHtml('restrict-filenames','Restrict filenames to ASCII')}${checkboxHtml('write-thumbnail','Write thumbnail')}${checkboxHtml('write-info-json','Write info JSON')}</div></div><label class="label" style="margin-top:8px">Download archive file</label><input type="text" class="download-archive" placeholder="Optional path to an archive file"></div>
            <div class="advanced-group"><div class="group-title">Subtitles</div>${checkboxHtml('write-subs','Write manual subtitles')}${checkboxHtml('write-auto-subs','Write automatic subtitles')}${checkboxHtml('embed-subs','Embed subtitles into video')}<div class="grid2"><div><label class="label">Languages</label><input type="text" class="sub-langs" placeholder="en.*,ja or all"></div><div><label class="label">Subtitle format</label><input type="text" class="sub-format" value="best" placeholder="ass/srt/best"></div></div></div>
            <div class="advanced-group"><div class="group-title">Metadata & post-processing</div>${checkboxHtml('embed-metadata','Embed metadata')}${checkboxHtml('embed-thumbnail','Embed thumbnail')}${checkboxHtml('embed-chapters','Embed chapter markers')}${checkboxHtml('write-description','Write description')}${checkboxHtml('write-comments','Write comments')}${checkboxHtml('split-chapters','Split by chapters')}<div class="grid2" style="margin-top:8px"><div><label class="label">Remux video</label><select class="remux"><option value="">Off</option><option>mp4</option><option>mkv</option><option>webm</option><option>mov</option><option>avi</option><option>flv</option><option>ts</option></select></div><div><label class="label">Re-encode video</label><select class="recode"><option value="">Off</option><option>mp4</option><option>mkv</option><option>webm</option><option>mov</option></select></div></div></div>
            <div class="advanced-group"><div class="group-title">SponsorBlock</div><label class="label">Mark categories as chapters</label><input type="text" class="sponsor-mark" placeholder="sponsor,intro,outro,all"><label class="label" style="margin-top:8px">Remove categories</label><input type="text" class="sponsor-remove" placeholder="sponsor,intro,outro"></div>
            <div class="advanced-group"><div class="group-title">Network & access</div>${checkboxHtml('cookies-chrome','Use Chrome cookies')}${checkboxHtml('no-playlist','Do not download playlists',true)}<div class="grid2"><div><label class="label">Proxy</label><input type="text" class="proxy" placeholder="http://127.0.0.1:8080"></div><div><label class="label">Socket timeout</label><input type="number" min="0" class="socket-timeout" placeholder="seconds"></div><div><label class="label">Concurrent fragments</label><input type="number" min="1" class="concurrent-fragments" value="1"></div><div><label class="label">Rate limit</label><input type="text" class="rate-limit" placeholder="e.g. 5M"></div></div></div>
            <div class="advanced-group"><div class="group-title">Extra yt-dlp arguments</div><label class="label">Raw arguments</label><textarea class="raw" placeholder="One argument per line. Example:\n--sleep-requests\n1\n--user-agent\nMyAgent"></textarea><div class="hint">Anything supported by your installed yt-dlp can be passed here, including options this UI does not expose yet.</div></div>
          </div></div>
          <div class="progress"><div class="progress-row"><span class="percent">0%</span><span class="eta"></span></div><div class="bar"><div class="fill"></div></div><div class="status"></div><div class="file"></div></div><div class="error"></div>
        </div>
        <div class="footer"><button class="button secondary cancel">Cancel</button><button class="button primary download">Download</button></div>
      </div></div>`;

    const backdrop = shadow.querySelector('.backdrop');
    const modal = shadow.querySelector('.modal');
    if (document.documentElement.hasAttribute('dark')) backdrop.classList.add('dark');
    const tabs = [...shadow.querySelectorAll('.tab')];
    const videoSection = shadow.querySelector('.video-section');
    const audioSection = shadow.querySelector('.audio-section');
    const advancedToggle = shadow.querySelector('.advanced-toggle');
    const advanced = shadow.querySelector('.advanced');
    let mode = 'video';

    const setMode = next => {
      mode = next;
      tabs.forEach(tab => tab.classList.toggle('active', tab.dataset.mode === mode));
      videoSection.style.display = mode === 'video' ? '' : 'none';
      audioSection.style.display = mode === 'audio' ? '' : 'none';
    };
    tabs.forEach(tab => tab.addEventListener('click', () => setMode(tab.dataset.mode)));
    advancedToggle.addEventListener('click', () => {
      const open = advanced.classList.toggle('open');
      advancedToggle.classList.toggle('open', open);
    });
    shadow.querySelector('.quality').addEventListener('change', e => {
      const selector = shadow.querySelector('.format-selector');
      if (selector) selector.value = e.target.value;
    });
    shadow.querySelectorAll('.format-row').forEach(row => row.addEventListener('click', () => {
      shadow.querySelector('.format-selector').value = row.dataset.format || '';
      advanced.classList.add('open');
      advancedToggle.classList.add('open');
    }));
    shadow.querySelector('.close').addEventListener('click', () => requestCloseModal());
    shadow.querySelector('.cancel').addEventListener('click', () => {
      if (state.activeDownloadId) cancelDownload(false, true);
      else closeModal();
    });
    backdrop.addEventListener('click', event => { if (event.target === backdrop) requestCloseModal(); });
    shadow.querySelector('.browse').addEventListener('click', () => browseFolder(shadow));
    shadow.querySelector('.download').addEventListener('click', () => startDownload(shadow, mode));
    document.body.appendChild(host);
  }

  function queryOptions(shadow, mode) {
    const get = cls => shadow.querySelector(`.${cls}`);
    const checked = cls => Boolean(get(cls)?.checked);
    const value = cls => get(cls)?.value?.trim() || '';
    return {
      mode,
      format: mode === 'audio' ? 'bestaudio/best' : (value('format-selector') || 'bv*+ba/b'),
      audioFormat: value('audio-format') || 'best',
      audioQuality: value('audio-quality') || '5',
      outputDir: value('path'),
      outputTemplate: value('output-template') || '%(title)s [%(id)s].%(ext)s',
      mergeFormat: value('merge-format'),
      formatSort: value('format-sort'),
      outputArchive: value('download-archive'),
      subLangs: value('sub-langs'),
      subFormat: value('sub-format') || 'best',
      proxy: value('proxy'),
      socketTimeout: value('socket-timeout'),
      concurrentFragments: value('concurrent-fragments'),
      rateLimit: value('rate-limit'),
      sponsorMark: value('sponsor-mark'),
      sponsorRemove: value('sponsor-remove'),
      remux: value('remux'),
      recode: value('recode'),
      rawArgs: value('raw').split(/\r?\n/).map(s => s.trim()).filter(Boolean),
      videoMultistreams: checked('video-multistreams'),
      audioMultistreams: checked('audio-multistreams'),
      checkFormats: checked('check-formats'),
      continue: checked('continue'),
      noOverwrites: checked('no-overwrites'),
      forceOverwrites: checked('force-overwrites'),
      restrictFilenames: checked('restrict-filenames'),
      writeThumbnail: checked('write-thumbnail'),
      writeInfoJson: checked('write-info-json'),
      writeSubs: checked('write-subs'),
      writeAutoSubs: checked('write-auto-subs'),
      embedSubs: checked('embed-subs'),
      embedMetadata: checked('embed-metadata'),
      embedThumbnail: checked('embed-thumbnail'),
      embedChapters: checked('embed-chapters'),
      writeDescription: checked('write-description'),
      writeComments: checked('write-comments'),
      splitChapters: checked('split-chapters'),
      cookiesChrome: checked('cookies-chrome'),
      noPlaylist: checked('no-playlist')
    };
  }

  function rememberSettings(options) {
    state.settings.outputDir = options.outputDir;
    state.settings.formatSelector = options.format;
    state.settings.outputTemplate = options.outputTemplate;
    chrome.storage.local.set({ [SETTINGS_KEY]: state.settings }).catch(() => {});
  }

  function loadSettings() {
    chrome.storage.local.get(SETTINGS_KEY, result => {
      const saved = result?.[SETTINGS_KEY];
      if (!saved) return;
      state.settings = { ...state.settings, ...saved };
      const shadow = document.getElementById(MODAL_HOST_ID)?.shadowRoot;
      if (!shadow) return;
      const path = shadow.querySelector('.path');
      const format = shadow.querySelector('.format-selector');
      const template = shadow.querySelector('.output-template');
      if (path && state.settings.outputDir) path.value = state.settings.outputDir;
      if (format && state.settings.formatSelector) format.value = state.settings.formatSelector;
      if (template && state.settings.outputTemplate) template.value = state.settings.outputTemplate;
    });
  }

  function startDownload(shadow, mode) {
    const requestId = crypto.randomUUID();
    state.activeDownloadId = requestId;
    const options = queryOptions(shadow, mode);
    rememberSettings(options);
    const button = document.getElementById(BUTTON_ID);
    const downloadButton = shadow.querySelector('.download');
    const cancelButton = shadow.querySelector('.cancel');
    const progress = shadow.querySelector('.progress');
    shadow.querySelector('.error').style.display = 'none';
    progress.style.display = 'block';
    downloadButton.disabled = true;
    cancelButton.disabled = false;
    cancelButton.textContent = 'Cancel';
    if (button) setButtonState(button, 'Downloading…', true);
    chrome.runtime.sendMessage({
      type: 'native-request',
      request: { action: 'download', requestId, url: getVideoUrl(), options }
    }, response => {
      if (chrome.runtime.lastError || !response?.ok) {
        showModalError(shadow, response?.error ?? chrome.runtime.lastError?.message ?? 'Native host is not available.');
        state.activeDownloadId = null;
        if (button) setButtonState(button, 'Download');
      }
    });
  }

  function cancelDownload(closeAfterCancel = false, askConfirmation = true) {
    if (!state.activeDownloadId) return closeAfterCancel ? closeModal() : undefined;
    if (askConfirmation && !window.confirm('Cancel this download? Any incomplete files will be removed.')) return;
    const shadow = document.getElementById(MODAL_HOST_ID)?.shadowRoot;
    if (shadow) {
      const status = shadow.querySelector('.status');
      const cancel = shadow.querySelector('.cancel');
      const download = shadow.querySelector('.download');
      if (status) status.textContent = 'Cancelling… Cleaning up temporary files…';
      if (cancel) { cancel.disabled = true; cancel.textContent = 'Cancelling…'; }
      if (download) download.disabled = true;
      shadow.querySelector('.close').disabled = true;
    }
    state.closeAfterCancel = closeAfterCancel;
    const requestId = state.activeDownloadId;
    chrome.runtime.sendMessage({ type: 'native-request', request: { action: 'cancel', requestId } }).catch(() => {});
  }

  function requestCloseModal() {
    if (state.activeDownloadId) cancelDownload(true, true);
    else closeModal();
  }

  function browseFolder(shadow) {
    const requestId = crypto.randomUUID();
    state.pendingBrowseId = requestId;
    chrome.runtime.sendMessage({ type: 'native-request', request: { action: 'browse_folder', requestId } });
  }

  function showModalError(shadow, message) {
    const error = shadow.querySelector('.error');
    if (!error) return;
    error.textContent = message;
    error.style.display = '';
    shadow.querySelector('.download').disabled = false;
  }

  function showError(message) { console.error(message); }
  function closeModal() { document.getElementById(MODAL_HOST_ID)?.remove(); }

  function handleNativeResult(message) {
    const button = document.getElementById(BUTTON_ID);
    if (message.type === 'browse_folder') {
      if (message.requestId === state.pendingBrowseId) {
        state.pendingBrowseId = null;
        const shadow = document.getElementById(MODAL_HOST_ID)?.shadowRoot;
        if (message.ok && message.path && shadow) shadow.querySelector('.path').value = message.path;
        if (!message.ok && shadow) showModalError(shadow, message.error ?? 'Unable to open folder picker.');
      }
      return;
    }
    if (message.type === 'info') {
      if (message.requestId !== state.pendingInfoId) return;
      state.pendingInfoId = null;
      const shadow = document.getElementById(MODAL_HOST_ID)?.shadowRoot;
      if (message.ok) {
        state.activeInfo = message.info;
        if (button) setButtonState(button, 'Download');
        openModal(message.info);
      } else {
        if (button) setButtonState(button, 'Download');
        state.pendingInfoId = null;
        if (shadow) showModalError(shadow, message.error ?? 'Unable to read video information.');
        else showError(message.error ?? 'Unable to read video information.');
      }
      return;
    }
    if (message.requestId && state.activeDownloadId && message.requestId !== state.activeDownloadId) return;
    const shadow = document.getElementById(MODAL_HOST_ID)?.shadowRoot;
    if (message.type === 'started' && shadow) { shadow.querySelector('.status').textContent = 'Starting…'; return; }
    if (message.type === 'progress' && shadow) {
      const rawPercent = message.percent ?? '';
      const percent = Number.parseFloat(String(rawPercent).replace(/[^0-9.]+/g,''));
      const total = message.total || message.totalEstimate;
      shadow.querySelector('.percent').textContent = Number.isFinite(percent) ? `${percent.toFixed(1)}%` : 'Working…';
      if (Number.isFinite(percent)) shadow.querySelector('.fill').style.width = `${Math.max(0, Math.min(100, percent))}%`;
      shadow.querySelector('.eta').textContent = message.eta && !['NA','Unknown',''].includes(String(message.eta)) ? `ETA ${message.eta}` : '';
      const speed = message.speed ? formatSpeed(message.speed) : '';
      const downloaded = formatBytes(message.downloaded);
      const totalText = formatBytes(total);
      shadow.querySelector('.status').textContent = [speed, downloaded && totalText ? `${downloaded} / ${totalText}` : downloaded, message.stage === 'postprocess' ? 'Processing…' : 'Downloading…'].filter(Boolean).join(' · ');
      return;
    }
    if (message.type === 'file' && shadow) {
      shadow.querySelector('.file').textContent = message.path ? `Saved to ${message.path}` : 'Saved.';
      return;
    }
    if (message.type === 'complete') {
      state.activeDownloadId = null;
      if (button) setButtonState(button, 'Download');
      if (shadow) {
        shadow.querySelector('.percent').textContent = '100%';
        shadow.querySelector('.fill').style.width = '100%';
        shadow.querySelector('.status').textContent = 'Download complete.';
        shadow.querySelector('.cancel').textContent = 'Close';
        shadow.querySelector('.cancel').disabled = false;
        shadow.querySelector('.download').disabled = false;
        shadow.querySelector('.close').disabled = false;
      }
      state.closeAfterCancel = false;
      return;
    }
    if (message.type === 'cancelled') {
      state.activeDownloadId = null;
      if (button) setButtonState(button, 'Download');
      const closeAfterCancel = state.closeAfterCancel;
      state.closeAfterCancel = false;
      if (shadow) {
        shadow.querySelector('.status').textContent = message.cleaned ? 'Download cancelled. Incomplete files removed.' : 'Download cancelled.';
        shadow.querySelector('.cancel').textContent = 'Close';
        shadow.querySelector('.cancel').disabled = false;
        shadow.querySelector('.download').disabled = false;
        shadow.querySelector('.close').disabled = false;
      }
      if (closeAfterCancel) closeModal();
      return;
    }
    if (message.type === 'error') {
      state.activeDownloadId = null;
      state.closeAfterCancel = false;
      if (button) setButtonState(button, 'Download');
      if (shadow) {
        showModalError(shadow, message.error ?? 'Unknown error.');
        shadow.querySelector('.cancel').textContent = 'Close';
        shadow.querySelector('.cancel').disabled = false;
      } else showError(message.error ?? 'Unknown error.');
    }
  }

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.getElementById(MODAL_HOST_ID)) requestCloseModal();
  });

  window.addEventListener('beforeunload', () => {
    if (state.activeDownloadId) {
      const requestId = state.activeDownloadId;
    chrome.runtime.sendMessage({ type: 'native-request', request: { action: 'cancel', requestId } }).catch(() => {});
    }
  });

  let observeTimer = 0;
  const observer = new MutationObserver(() => {
    handleNavigation();
    if (observeTimer) return;
    observeTimer = window.setTimeout(() => { observeTimer = 0; maybeCreateButton(); }, 150);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  chrome.runtime.onMessage.addListener(({ type, message }) => {
    if (type === 'native-result' && message) handleNativeResult(message);
  });
  maybeCreateButton();
})();
