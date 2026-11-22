'use strict';

const LASTPASS_ID = 'hdokiejnpimakedhajhdlcegeplioahd';
const extensionBase = 'chrome-extension://' + LASTPASS_ID + '/';
const secureLastPassHost = /(?:^|\.)lastpass\.(?:com|eu)$/i;
const tabFields = ['id', 'windowId', 'index', 'active', 'selected', 'highlighted', 'pinned', 'audible', 'mutedInfo',
  'status', 'discarded', 'incognito', 'groupId', 'autoDiscardable', 'openerTabId', 'width', 'height'];
const windowFields = ['id', 'focused', 'top', 'left', 'width', 'height', 'type', 'state', 'incognito', 'alwaysOnTop'];
const menuContexts = new Set(['all', 'page', 'frame', 'selection', 'link', 'editable', 'image', 'video', 'audio']);

function object(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected extension options.');
  return value;
}

function select(value, keys) {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
}

function text(value, limit) {
  if (typeof value !== 'string' || value.length > limit) throw new TypeError('Invalid extension text.');
  return value;
}

function boolean(value) {
  if (typeof value !== 'boolean') throw new TypeError('Invalid extension option.');
  return value;
}

function chromeId(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid browser ID.');
  return value;
}

function permissionsOf(manifest) {
  const permissions = (manifest.permissions || []).filter(value => typeof value === 'string' && !value.includes('://') && value !== '<all_urls>');
  const origins = [...(manifest.host_permissions || []),
    ...(manifest.permissions || []).filter(value => typeof value === 'string' && (value.includes('://') || value === '<all_urls>'))];
  return { permissions, origins };
}

function originPattern(value) {
  if (value === '<all_urls>') return { schemes: ['http', 'https', 'file', 'ftp'], host: '*', pathname: '/*' };
  const match = typeof value === 'string' && /^(\*|https?|file|ftp):\/\/(\*|\*\.[\w.-]+|[\w.-]+|)(\/.*)$/i.exec(value);
  if (!match || (!match[2] && match[1] !== 'file')) return null;
  const scheme = match[1].toLowerCase();
  return {
    schemes: scheme === '*' ? ['http', 'https'] : [scheme],
    host: match[2].toLowerCase(),
    pathname: match[3],
  };
}

function hostCovers(grant, host) {
  return grant === '*' || grant === host || (grant.startsWith('*.') &&
    (host === grant.slice(2) || host.endsWith(grant.slice(1))));
}

function webURL(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\\]/.test(value)) return null;
  const url = URL.parse(value);
  return url && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url : null;
}

function hostAllowed(manifest, url) {
  return Boolean(url && permissionsOf(manifest).origins.some(pattern => {
    const rule = originPattern(pattern);
    return rule && rule.schemes.includes(url.protocol.slice(0, -1)) && hostCovers(rule.host, url.hostname);
  }));
}

function containsPermission(manifest, details) {
  const { permissions = [], origins = [] } = object(details);
  if (!Array.isArray(permissions) || !Array.isArray(origins) || permissions.length > 100 || origins.length > 100) {
    throw new TypeError('Invalid permission request.');
  }
  const granted = permissionsOf(manifest);
  const hostGrants = granted.origins.map(originPattern).filter(Boolean);
  return permissions.every(permission => granted.permissions.includes(permission)) &&
    origins.every(pattern => {
      const target = originPattern(pattern);
      return target && target.schemes.every(scheme => hostGrants.some(rule =>
        rule.schemes.includes(scheme) && hostCovers(rule.host, target.host)));
    });
}

function ownResource(value) {
  const input = text(value, 8192);
  if (/[\u0000-\u0020\\]/.test(input)) throw new TypeError('Invalid extension resource URL.');
  const url = URL.parse(input, extensionBase);
  if (!url || url.protocol !== 'chrome-extension:' || url.hostname !== LASTPASS_ID ||
      url.username || url.password || url.port || url.pathname === '/') throw new TypeError('Invalid extension resource URL.');
  return url.href;
}

function navigationURL(value, manifest) {
  if (value === 'about:blank') return value;
  const url = webURL(value);
  if (url && hostAllowed(manifest, url)) return url.href;
  return ownResource(value);
}

function patternMatches(pattern, value) {
  const rule = originPattern(pattern);
  const url = webURL(value);
  if (!rule || !url || !rule.schemes.includes(url.protocol.slice(0, -1)) || !hostCovers(rule.host, url.hostname)) return false;
  const target = url.pathname + url.search;
  const parts = rule.pathname.split('*');
  if (parts.length === 1) return target === parts[0];
  const prefix = parts.shift();
  const suffix = parts.pop();
  if (!target.startsWith(prefix) || !target.endsWith(suffix)) return false;
  let index = prefix.length;
  const end = target.length - suffix.length;
  for (const part of parts) {
    const match = target.indexOf(part, index);
    if (match === -1) return false;
    index = match + part.length;
  }
  return index <= end;
}

function iconURL(value) {
  if (typeof value === 'string') return ownResource(value);
  const paths = object(value);
  const dimensions = Object.keys(paths).filter(key => /^[1-9][0-9]{0,3}$/.test(key));
  const size = dimensions.sort((first, second) => Math.abs(first - 32) - Math.abs(second - 32))[0];
  return size ? ownResource(paths[size]) : null;
}

function badgeColor(value) {
  if (Array.isArray(value) && value.length === 4 &&
      value.every(part => Number.isInteger(part) && part >= 0 && part <= 255)) return value.slice();
  if (typeof value === 'string') {
    const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value)?.[1];
    if (hex) {
      const data = hex.length < 5 ? [...hex].map(part => part + part).join('') : hex;
      return (data.length === 6 ? data + 'ff' : data).match(/../g).map(part => Number.parseInt(part, 16));
    }
  }
  throw new TypeError('Invalid extension badge color.');
}

function createLastPassApi({ browserSession, getExtension, controller, emit }) {
  const defaults = {};
  const tabActions = new Map();
  const contextMenu = new Map();

  function installed() {
    const extension = getExtension(LASTPASS_ID);
    return extension?.id === LASTPASS_ID && extension.manifest ? extension : null;
  }

  function requirePermission(manifest, key) {
    if (!permissionsOf(manifest).permissions.includes(key)) throw new TypeError('This extension permission was not granted.');
  }

  function tabs() {
    return controller.getTabs();
  }

  function tabForId(id) {
    const tab = id === undefined ? controller.getActiveTab() : tabs().find(tab => tab.id === chromeId(id));
    if (!tab) throw new Error('This browser tab is no longer available.');
    return tab;
  }

  function publicTab(tab, manifest) {
    if (!tab) return undefined;
    const visible = permissionsOf(manifest).permissions.includes('tabs') || hostAllowed(manifest, webURL(tab.url));
    return select(tab, visible ? [...tabFields, 'url', 'pendingUrl', 'title', 'favIconUrl'] : tabFields);
  }

  function windows() {
    return (controller.getWindows?.() ?? [controller.getWindow()]).filter(Boolean);
  }

  function windowForId(id) {
    const wanted = id === -2 ? controller.getWindow()?.id : chromeId(id);
    const window = windows().find(window => window.id === wanted);
    if (!window) throw new Error('This browser window is no longer available.');
    return window;
  }

  function publicWindow(window, manifest, { populate = false } = {}) {
    if (!window) return undefined;
    const result = select(window, windowFields);
    if (populate) result.tabs = tabs().filter(tab => tab.windowId === window.id).map(tab => publicTab(tab, manifest));
    return result;
  }

  function call(name, ...args) {
    if (typeof controller[name] !== 'function') throw new Error('This extension operation is not available.');
    return controller[name](...args);
  }

  function tabChanges(details, manifest) {
    const changes = select(object(details), ['url', 'active', 'pinned', 'muted']);
    if (changes.url !== undefined) changes.url = navigationURL(changes.url, manifest);
    for (const key of ['active', 'pinned', 'muted']) if (changes[key] !== undefined) boolean(changes[key]);
    return changes;
  }

  function windowChanges(details, manifest, creating = false) {
    const changes = select(object(details), [ ...(creating ? ['url'] : []), 'focused', 'incognito', 'drawAttention', 'width', 'height', 'top', 'left', 'type', 'state']);
    if (changes.url !== undefined) {
      if (Array.isArray(changes.url)) {
        if (!changes.url.length || changes.url.length > 8) throw new TypeError('Invalid extension window URL list.');
        changes.url = changes.url.map(url => navigationURL(url, manifest));
      } else changes.url = navigationURL(changes.url, manifest);
    }
    for (const key of ['focused', 'incognito', 'drawAttention']) if (changes[key] !== undefined) boolean(changes[key]);
    if (changes.incognito) throw new Error('An extension cannot open an incognito Relay window.');
    for (const key of ['width', 'height', 'top', 'left']) {
      const value = changes[key];
      const isSize = key === 'width' || key === 'height';
      if (value !== undefined && (!Number.isInteger(value) || value < (isSize ? 100 : -100000) || value > (isSize ? 16384 : 100000))) {
        throw new TypeError('Invalid extension window bounds.');
      }
    }
    if (changes.type !== undefined && !['normal', 'popup'].includes(changes.type)) throw new TypeError('Invalid extension window type.');
    if (changes.state !== undefined && !['normal', 'minimized', 'maximized', 'fullscreen'].includes(changes.state)) {
      throw new TypeError('Invalid extension window state.');
    }
    return changes;
  }

  function queryTabs(query, manifest) {
    const options = object(query);
    const current = controller.getWindow()?.id;
    const focused = windows().find(window => window.focused)?.id ?? current;
    const fields = ['active', 'audible', 'discarded', 'highlighted', 'index', 'pinned', 'status', 'groupId'];
    return tabs().filter(tab => {
      if ((options.currentWindow !== undefined && (tab.windowId === current) !== options.currentWindow) ||
          (options.lastFocusedWindow !== undefined && (tab.windowId === focused) !== options.lastFocusedWindow)) return false;
      if (options.windowId !== undefined && tab.windowId !== (options.windowId === -2 ? current : options.windowId)) return false;
      if (options.windowType !== undefined && windows().find(window => window.id === tab.windowId)?.type !== options.windowType) return false;
      if (fields.some(key => options[key] !== undefined && options[key] !== tab[key])) return false;
      if (options.muted !== undefined && options.muted !== tab.mutedInfo?.muted) return false;
      const visibleTab = publicTab(tab, manifest);
      return (options.title === undefined || visibleTab.title === options.title) &&
        (options.url === undefined || [options.url].flat().some(pattern => patternMatches(pattern, visibleTab.url)));
    }).map(tab => publicTab(tab, manifest));
  }

  async function readCookie(manifest, details) {
    requirePermission(manifest, 'cookies');
    const { url: input, name, storeId, partitionKey } = object(details);
    const url = webURL(input);
    if (!url || url.protocol !== 'https:' || url.port || !secureLastPassHost.test(url.hostname) || !hostAllowed(manifest, url)) {
      throw new TypeError('Cookie access is limited to granted HTTPS LastPass hosts.');
    }
    if (typeof name !== 'string' || !name || name.length > 256 || /[\u0000-\u0020;=]/.test(name) ||
        (storeId !== undefined && storeId !== '0') || partitionKey !== undefined) {
      throw new TypeError('Invalid LastPass cookie request.');
    }
    const cookies = await browserSession.cookies.get({ url: url.href, name });
    const cookie = cookies.reduce((longest, candidate) =>
      !longest || (candidate.path?.length ?? 0) > (longest.path?.length ?? 0) ? candidate : longest, null);
    return cookie && {
      ...select(cookie, ['name', 'value', 'domain', 'hostOnly', 'path', 'secure', 'httpOnly', 'sameSite', 'session', 'expirationDate']),
      storeId: '0',
    };
  }

  function getAction(tabId) {
    const extension = installed();
    if (!extension) return null;
    const manifest = extension.manifest.action || extension.manifest.browser_action || {};
    return {
      title: manifest.default_title || extension.name || 'LastPass',
      popup: manifest.default_popup ? ownResource(manifest.default_popup) : '',
      icon: iconURL(manifest.default_icon),
      badgeText: '',
      badgeBackgroundColor: [0, 0, 0, 255],
      enabled: true,
      ...defaults,
      ...tabActions.get(tabId),
    };
  }

  function actionState(name, details) {
    const options = ['disable', 'enable', 'isEnabled'].includes(name) ? { tabId: details } : object(details);
    const tabId = options.tabId;
    if (tabId !== undefined) tabForId(tabId);
    const state = getAction(tabId);
    switch (name) {
      case 'getUserSettings': return { isOnToolbar: true };
      case 'openPopup': return call('openPopup', options.windowId === undefined ? {} : { windowId: windowForId(options.windowId).id });
      case 'getTitle': return state.title;
      case 'getPopup': return state.popup;
      case 'getBadgeText': return state.badgeText;
      case 'getBadgeBackgroundColor': return state.badgeBackgroundColor.slice();
      case 'isEnabled': return state.enabled;
    }
    let changes;
    switch (name) {
      case 'setTitle': changes = { title: text(options.title, 256) }; break;
      case 'setPopup': changes = { popup: options.popup === '' ? '' : ownResource(options.popup) }; break;
      case 'setIcon':
        changes = { icon: iconURL(options.path) };
        if (!changes.icon) throw new TypeError('A packaged extension icon path is required.');
        break;
      case 'setBadgeText': changes = { badgeText: options.text === null ? '' : text(options.text, 32) }; break;
      case 'setBadgeBackgroundColor': changes = { badgeBackgroundColor: badgeColor(options.color) }; break;
      case 'enable':
      case 'disable': changes = { enabled: name === 'enable' }; break;
      default: throw new TypeError('This extension action is not available.');
    }
    if (tabId === undefined) Object.assign(defaults, changes);
    else tabActions.set(tabId, { ...tabActions.get(tabId), ...changes });
    controller.actionChanged?.();
  }

  function menuItem(id, details, current = {}) {
    if (!((typeof id === 'string' && id.length > 0 && id.length <= 256) || Number.isSafeInteger(id))) {
      throw new TypeError('Invalid context menu ID.');
    }
    const changes = select(object(details), ['title', 'type', 'contexts', 'parentId', 'checked', 'enabled', 'visible',
      'documentUrlPatterns', 'targetUrlPatterns']);
    const item = { type: 'normal', contexts: ['page'], enabled: true, visible: true, ...current, ...changes, id };
    if (!['normal', 'checkbox', 'radio', 'separator'].includes(item.type)) throw new TypeError('Invalid context menu type.');
    if (item.type !== 'separator' && !text(item.title, 256)) throw new TypeError('Invalid context menu title.');
    if (!Array.isArray(item.contexts) || !item.contexts.length || item.contexts.some(context => !menuContexts.has(context))) {
      throw new TypeError('Invalid context menu contexts.');
    }
    for (const key of ['checked', 'enabled', 'visible']) if (item[key] !== undefined) boolean(item[key]);
    for (const key of ['documentUrlPatterns', 'targetUrlPatterns']) {
      const patterns = item[key];
      if (patterns !== undefined && (!Array.isArray(patterns) || patterns.length > 100 ||
          patterns.some(pattern => typeof pattern !== 'string' || pattern.length > 2048 || !originPattern(pattern)))) {
        throw new TypeError('Invalid context menu URL patterns.');
      }
    }
    let parentId = item.parentId;
    while (parentId !== undefined) {
      if (parentId === id || !contextMenu.has(parentId)) throw new TypeError('Invalid context menu parent.');
      parentId = contextMenu.get(parentId).parentId;
    }
    return item;
  }

  function removeMenuItem(id) {
    for (const item of contextMenu.values()) if (item.parentId === id) removeMenuItem(item.id);
    contextMenu.delete(id);
  }

  function menuOperation(name, args, manifest) {
    requirePermission(manifest, 'contextMenus');
    const [first, second] = args;
    switch (name) {
      case 'create': {
        const id = object(first).id;
        if (contextMenu.has(id) || contextMenu.size >= 100) throw new Error('Could not add the extension context menu item.');
        contextMenu.set(id, menuItem(id, first));
        return id;
      }
      case 'update': {
        const item = contextMenu.get(first);
        if (!item) throw new Error('This extension context menu item no longer exists.');
        contextMenu.set(first, menuItem(first, second, item));
        return undefined;
      }
      case 'remove': return removeMenuItem(first);
      case 'removeAll': return contextMenu.clear();
      default: throw new TypeError('This context menu operation is not available.');
    }
  }

  function appendContextMenu(template, params, tab) {
    const extension = installed();
    const pageUrl = params.pageURL || tab?.url;
    const frameUrl = params.frameURL;
    if (!extension || !permissionsOf(extension.manifest).permissions.includes('contextMenus') ||
        !hostAllowed(extension.manifest, webURL(pageUrl)) ||
        (frameUrl && !hostAllowed(extension.manifest, webURL(frameUrl)))) return;
    const contexts = [
      'all', 'page',
      frameUrl && frameUrl !== pageUrl && 'frame',
      params.selectionText && 'selection',
      params.linkURL && 'link',
      params.isEditable && 'editable',
      params.mediaType,
    ];
    const items = [...contextMenu.values()];
    function entries(parentId) {
      return items.filter(item => item.parentId === parentId && item.visible &&
        item.contexts.some(context => contexts.includes(context)) &&
        (!item.documentUrlPatterns || item.documentUrlPatterns.some(pattern => patternMatches(pattern, frameUrl || pageUrl))) &&
        (!item.targetUrlPatterns || item.targetUrlPatterns.some(pattern => patternMatches(pattern, params.linkURL || params.srcURL))))
        .map(item => {
          if (item.type === 'separator') return { type: 'separator' };
          const submenu = entries(item.id);
          const label = item.title.replace(/%s/g, () => (params.selectionText || '').slice(0, 80)).replace(/&/g, '&&');
          const clickable = {
            label,
            enabled: item.enabled,
            ...(['checkbox', 'radio'].includes(item.type) ? { type: item.type, checked: Boolean(item.checked) } : {}),
            click: (menu) => {
              const current = installed();
              if (!current || contextMenu.get(item.id) !== item || !permissionsOf(current.manifest).permissions.includes('contextMenus')) return;
              const info = {
                menuItemId: item.id, parentMenuItemId: item.parentId,
                pageUrl, frameUrl, frameId: params.frameId, linkUrl: params.linkURL, srcUrl: params.srcURL,
                editable: Boolean(params.isEditable), selectionText: params.selectionText, mediaType: params.mediaType,
              };
              if (['checkbox', 'radio'].includes(item.type)) {
                info.wasChecked = Boolean(item.checked);
                info.checked = Boolean(menu.checked);
                item.checked = info.checked;
              }
              emit('contextMenus.onClicked', [info, publicTab(tab, current.manifest)]);
            }
          };
          return submenu.length ? { label, enabled: item.enabled, submenu } : clickable;
        });
    }
    const menu = entries(undefined);
    if (menu.length) template.push({ type: 'separator' }, { label: 'LastPass', submenu: menu });
  }

  async function invoke(name, args) {
    const extension = installed();
    if (!extension || typeof name !== 'string' || !/^[a-zA-Z]+\.[a-zA-Z]+$/.test(name) || !Array.isArray(args) || args.length > 2) {
      throw new TypeError('Invalid LastPass API request.');
    }
    const { manifest } = extension;
    const [first, second] = args;
    if (name.startsWith('browserAction.') || name.startsWith('action.')) return actionState(name.split('.')[1], first);
    if (name.startsWith('contextMenus.')) return menuOperation(name.split('.')[1], args, manifest);
    switch (name) {
      case 'permissions.getAll': return permissionsOf(manifest);
      case 'permissions.contains':
      case 'permissions.request': return containsPermission(manifest, first);
      case 'cookies.get': return readCookie(manifest, first);
      case 'tabs.get': return publicTab(tabForId(chromeId(first)), manifest);
      case 'tabs.getCurrent': return undefined; // A worker or toolbar popup is not a browser tab.
      case 'tabs.query': return queryTabs(first, manifest);
      case 'tabs.create': return publicTab(await call('createTab', tabChanges(first, manifest)), manifest);
      case 'tabs.update': {
        const implicit = first === undefined || typeof first === 'object';
        const tab = tabForId(implicit ? undefined : first);
        return publicTab(await call('updateTab', tab.id, tabChanges(implicit ? (second ?? first) : second, manifest)), manifest);
      }
      case 'tabs.remove': {
        const identifiers = Array.isArray(first) ? first : [first];
        if (identifiers.length > 100) throw new TypeError('Too many tabs to remove.');
        const targets = [...new Set(identifiers)].map(id => tabForId(chromeId(id)));
        for (const tab of targets) await call('removeTab', tab.id);
        return undefined;
      }
      case 'windows.getCurrent': return publicWindow(controller.getWindow(), manifest, object(first));
      case 'windows.getLastFocused':
        return publicWindow(windows().find(window => window.focused) ?? controller.getWindow(), manifest, object(first));
      case 'windows.getAll': {
        const options = object(first);
        return windows().filter(window => !options.windowTypes || options.windowTypes.includes(window.type))
          .map(window => publicWindow(window, manifest, options));
      }
      case 'windows.get': return publicWindow(windowForId(first), manifest, object(second));
      case 'windows.create': return publicWindow(await call('createWindow', windowChanges(first, manifest, true)), manifest, { populate: true });
      case 'windows.update': return publicWindow(await call('updateWindow', windowForId(first).id, windowChanges(second, manifest)), manifest);
      case 'windows.remove': return call('removeWindow', windowForId(first).id);
      default: throw new TypeError('This LastPass API operation is not available.');
    }
  }

  function clearTab(id) {
    tabActions.delete(id);
  }

  function reset() {
    for (const key of Object.keys(defaults)) delete defaults[key];
    tabActions.clear();
    contextMenu.clear();
  }

  return { invoke, appendContextMenu, getAction, clearTab, reset };
}

module.exports = { LASTPASS_ID, createLastPassApi };
