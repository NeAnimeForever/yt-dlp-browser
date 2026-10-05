const HOST_NAME = 'com.neanime.ytdlp_browser';

let nativePort = null;
let connectPromise = null;
const activeDownloads = new Map();

function connectNative() {
  if (nativePort) return Promise.resolve(nativePort);
  if (connectPromise) return connectPromise;

  connectPromise = new Promise((resolve, reject) => {
    try {
      const port = chrome.runtime.connectNative(HOST_NAME);
      nativePort = port;
      nativePort.onDisconnect.addListener(() => {
        nativePort = null;
        connectPromise = null;
      });
      nativePort.onMessage.addListener(handleNativeMessage);
      resolve(port);
    } catch (error) {
      connectPromise = null;
      reject(error);
    }
  });

  return connectPromise;
}

function handleNativeMessage(message) {
  if (message?.requestId) {
    if (['complete', 'cancelled', 'error'].includes(message.type)) activeDownloads.delete(message.requestId);
    if (message.tabId != null) {
      chrome.tabs.sendMessage(message.tabId, { type: 'native-result', message }).catch(() => {});
    } else {
      chrome.runtime.sendMessage({ type: 'native-result', message }).catch(() => {});
    }
  }
}

function cancelNative(requestId, tabId = null) {
  if (!requestId) return;
  sendNative({ action: 'cancel', requestId, tabId }).catch(() => {});
}

function sendNative(request) {
  return connectNative().then(port => {
    port.postMessage(request);
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'native-request') return;

  const request = {
    ...message.request,
    tabId: sender.tab?.id ?? null
  };

  if (request.action === 'download' && request.requestId) {
    activeDownloads.set(request.requestId, { tabId: request.tabId });
  }

  sendNative(request)
    .then(() => sendResponse({ ok: true }))
    .catch(error => {
      if (request.action === 'download') activeDownloads.delete(request.requestId);
      sendResponse({ ok: false, error: String(error?.message ?? error) });
    });

  return true;
});

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'debug') return;
  port.onMessage.addListener(message => {
    if (message?.action === 'ping') {
      sendNative({ action: 'ping', requestId: crypto.randomUUID() })
        .catch(error => port.postMessage({ ok: false, error: String(error?.message ?? error) }));
      return;
    }
    if (message?.action === 'download') {
      sendNative({
        action: 'download',
        requestId: crypto.randomUUID(),
        url: message.url,
        outputDir: message.outputDir,
        format: message.format,
        audioOnly: message.audioOnly === true,
        audioFormat: message.audioFormat
      }).catch(error => port.postMessage({ ok: false, error: String(error?.message ?? error) }));
    }
  });
});


chrome.tabs.onRemoved.addListener(tabId => {
  for (const [requestId, download] of activeDownloads) {
    if (download.tabId === tabId) {
      cancelNative(requestId, tabId);
      activeDownloads.delete(requestId);
    }
  }
});
