const { BrowserWindow, screen } = require('electron');

const DEFAULT_SIZE = { width: 410, height: 540 };
const MIN_SIZE = { width: 320, height: 360 };
const MAX_SIZE = { width: 800, height: 600 };
const MARGIN = 8;

function parseURL(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.hostname && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function extensionURL(value, expectedId) {
  const url = parseURL(value);
  if (!url || url.protocol !== 'chrome-extension:' || url.port || !/^[a-p]{32}$/.test(url.hostname)) return null;
  return !expectedId || expectedId === url.hostname ? url : null;
}

function webURL(value) {
  const url = parseURL(value);
  return url && (url.protocol === 'http:' || url.protocol === 'https:') ? url.href : null;
}

function canNavigate(url, extensionId, isMainFrame) {
  // These local subdocuments can inherit the extension's origin and carry no remote document.
  return Boolean(extensionURL(url, extensionId)) || (!isMainFrame && (url === 'about:blank' || url === 'about:srcdoc'));
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function popupBounds(parentBounds, anchor, size) {
  const { x, y, width, height } = parentBounds;
  const hasAnchor = anchor && [anchor.x, anchor.y, anchor.width, anchor.height].every(Number.isFinite) &&
    anchor.width > 0 && anchor.height > 0;
  const right = x + (hasAnchor ? clamp(Math.round(anchor.x + anchor.width), 0, width) : width - MARGIN);
  const bottom = y + (hasAnchor ? clamp(Math.round(anchor.y + anchor.height), 0, height) : Math.min(100, height));
  const area = screen.getDisplayNearestPoint({ x: right, y: bottom }).workArea;
  const popupWidth = Math.min(size.width, Math.max(1, area.width - 2 * MARGIN));
  let popupHeight = Math.min(size.height, Math.max(1, area.height - 2 * MARGIN));

  const leftEdge = area.x + MARGIN;
  const rightEdge = area.x + area.width - MARGIN;
  const topEdge = area.y + MARGIN;
  const bottomEdge = area.y + area.height - MARGIN;
  const below = Math.max(topEdge, bottom + MARGIN);
  const availableBelow = bottomEdge - below;

  // Leave the browser controls above the popup when the display has enough room.
  if (availableBelow >= MIN_SIZE.height) popupHeight = Math.min(popupHeight, availableBelow);
  return {
    x: clamp(right - popupWidth, leftEdge, Math.max(leftEdge, rightEdge - popupWidth)),
    y: clamp(below, topEdge, Math.max(topEdge, bottomEdge - popupHeight)),
    width: popupWidth,
    height: popupHeight,
  };
}

function createExtensionPopup({ parent, browserSession, openExternalPage }) {
  let current;

  function getWindow() {
    return current && !current.window.isDestroyed() ? current.window : null;
  }

  function close() {
    const popup = getWindow();
    current = undefined;
    popup?.destroy();
  }

  function reposition() {
    const popup = getWindow();
    if (!popup || parent.isDestroyed()) return;
    const bounds = popupBounds(parent.getContentBounds(), current.anchor, current.size);
    const existing = popup.getBounds();
    if (Object.keys(bounds).some((key) => bounds[key] !== existing[key])) popup.setBounds(bounds);
  }

  parent.on('move', reposition);
  parent.on('resize', reposition);
  parent.on('minimize', close);
  parent.on('hide', close);
  parent.once('closed', close);

  async function open(value, anchor) {
    const url = extensionURL(value);
    if (!url || !browserSession.extensions.getExtension(url.hostname)) throw new Error('The extension popup is unavailable.');
    if (parent.isDestroyed()) throw new Error('The browser window has closed.');

    if (getWindow() && current.url === url.href) {
      if (anchor) current.anchor = anchor;
      reposition();
      if (current.window.isVisible()) current.window.focus();
      return current.ready;
    }
    close();

    const popup = new BrowserWindow({
      ...popupBounds(parent.getContentBounds(), anchor, DEFAULT_SIZE),
      parent,
      frame: false,
      show: false,
      skipTaskbar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      webPreferences: {
        session: browserSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        devTools: false,
        disableHtmlFullscreenWindowResize: true,
        enablePreferredSizeMode: true,
      },
    });
    const entry = { window: popup, url: url.href, anchor, size: DEFAULT_SIZE, ready: null };
    current = entry;
    const wc = popup.webContents;
    const extensionId = url.hostname;
    const dismiss = () => { if (current === entry) close(); };

    function openWebLink(value) {
      const target = webURL(value);
      if (!target) return;
      setImmediate(async () => {
        if (current !== entry) return;
        try {
          await openExternalPage(target);
        } catch {
          console.error('Could not open the link from the extension popup.');
        }
      });
    }

    function guardNavigation(event) {
      if (canNavigate(event.url, extensionId, event.isMainFrame)) return;
      event.preventDefault();
      if (event.isMainFrame) openWebLink(event.url);
    }

    wc.on('will-frame-navigate', guardNavigation);
    wc.on('will-redirect', guardNavigation);
    wc.on('did-frame-navigate', (_event, next, _code, _message, isMainFrame) => {
      // Chromium can initiate a navigation without dispatching will-frame-navigate.
      if (!canNavigate(next, extensionId, isMainFrame)) dismiss();
    });
    wc.setWindowOpenHandler(({ url: target, postBody }) => {
      if (!postBody) openWebLink(target);
      return { action: 'deny' };
    });
    wc.on('will-attach-webview', (event) => event.preventDefault());
    wc.on('content-bounds-updated', (event) => event.preventDefault());
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.key !== 'Escape' || input.isComposing) return;
      event.preventDefault();
      dismiss();
    });
    wc.on('preferred-size-changed', (_event, preferred) => {
      if (current !== entry || !Number.isFinite(preferred.width) || !Number.isFinite(preferred.height) ||
          preferred.width <= 0 || preferred.height <= 0) return;
      entry.size = {
        width: clamp(Math.ceil(preferred.width), MIN_SIZE.width, MAX_SIZE.width),
        height: clamp(Math.ceil(preferred.height), MIN_SIZE.height, MAX_SIZE.height),
      };
      reposition();
    });
    wc.once('render-process-gone', dismiss);
    popup.on('blur', dismiss);
    popup.once('closed', () => { if (current === entry) current = undefined; });

    entry.ready = (async () => {
      try {
        await wc.loadURL(url.href);
        if (current !== entry || popup.isDestroyed()) return null;
        if (!extensionURL(wc.getURL(), extensionId) || !browserSession.extensions.getExtension(extensionId)) {
          throw new Error('The extension popup is unavailable.');
        }
        popup.show();
        return popup;
      } catch (error) {
        if (current !== entry) return null;
        dismiss();
        throw error;
      }
    })();
    return entry.ready;
  }

  return { open, close, getWindow };
}

module.exports = { createExtensionPopup };
