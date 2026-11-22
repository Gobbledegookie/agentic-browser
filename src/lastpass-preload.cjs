'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const extensionId = 'hdokiejnpimakedhajhdlcegeplioahd';
const bridgeName = '__relayLastPassCompatibility';
const callChannel = 'relay:lastpass:call';
const eventChannel = 'relay:lastpass:event';
const methods = {
  windows: ['get', 'getCurrent', 'getLastFocused', 'getAll', 'create', 'update', 'remove'],
  tabs: ['get', 'getCurrent', 'query', 'create', 'update', 'remove'],
  cookies: ['get'],
  contextMenus: ['create', 'update', 'remove', 'removeAll'],
  browserAction: ['setTitle', 'getTitle', 'setIcon', 'setPopup', 'getPopup', 'setBadgeText', 'getBadgeText',
    'setBadgeBackgroundColor', 'getBadgeBackgroundColor', 'enable', 'disable', 'openPopup', 'getUserSettings'],
  permissions: ['contains', 'getAll', 'request']
};
const events = {
  windows: ['onCreated', 'onRemoved', 'onFocusChanged', 'onBoundsChanged'],
  tabs: ['onCreated', 'onUpdated', 'onActivated', 'onRemoved'],
  contextMenus: ['onClicked'],
  browserAction: ['onClicked'],
  permissions: ['onAdded', 'onRemoved'],
  webNavigation: ['onBeforeNavigate', 'onCommitted', 'onDOMContentLoaded', 'onCompleted', 'onErrorOccurred',
    'onCreatedNavigationTarget', 'onReferenceFragmentUpdated', 'onHistoryStateUpdated', 'onTabReplaced']
};

function qualifiedNames(groups) {
  return new Set(Object.entries(groups).flatMap(([namespace, entries]) => entries.map(entry => namespace + '.' + entry)));
}

function isLastPass(id) {
  const url = globalThis.location;
  return url?.protocol === 'chrome-extension:' && url.hostname === id && globalThis.chrome?.runtime?.id === id;
}

function installApi(id, property, methodGroups, eventGroups) {
  const url = globalThis.location;
  const chrome = globalThis.chrome;
  if (url?.protocol !== 'chrome-extension:' || url.hostname !== id || chrome?.runtime?.id !== id) return;
  const bridge = globalThis[property];
  const listenersByEvent = new Map();
  const apis = new Map();

  function api(namespace) {
    if (!apis.has(namespace)) apis.set(namespace, { ...chrome[namespace] });
    return apis.get(namespace);
  }

  function sendResult(promise, callback) {
    if (!callback) return promise;
    void promise.then(value => callback(value), () => {
      const previous = Object.getOwnPropertyDescriptor(chrome.runtime, 'lastError');
      if (previous?.configurable === false) {
        callback();
        return;
      }

      Object.defineProperty(chrome.runtime, 'lastError', {
        configurable: true, value: { message: 'Relay could not complete this extension request.' }
      });
      try {
        callback();
      } finally {
        if (previous) Object.defineProperty(chrome.runtime, 'lastError', previous);
        else delete chrome.runtime.lastError;
      }
    });
  }

  function call(method, args) {
    const callback = typeof args.at(-1) === 'function' ? args.pop() : undefined;
    return sendResult(bridge.call(method, args), callback);
  }

  for (const [namespace, entries] of Object.entries(methodGroups)) {
    for (const method of entries) {
      const name = namespace + '.' + method;
      api(namespace)[method] = (...args) => call(name, args);
    }
  }

  api('contextMenus').create = (properties, callback) => {
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
      throw new TypeError('A context menu item requires an options object.');
    }
    const item = { ...properties, id: properties.id ?? crypto.randomUUID() };
    const result = bridge.call('contextMenus.create', [item]);
    if (typeof callback === 'function') sendResult(result, callback);
    else void result.catch(() => {});
    return item.id;
  };

  const windowApi = api('windows');
  windowApi.WINDOW_ID_NONE = -1;
  windowApi.WINDOW_ID_CURRENT = -2;
  for (const [namespace, entries] of Object.entries(eventGroups)) {
    for (const event of entries) {
      const listeners = new Set();
      listenersByEvent.set(namespace + '.' + event, listeners);
      api(namespace)[event] = Object.freeze({
        addListener(callback) {
          if (typeof callback !== 'function') throw new TypeError('An extension listener must be a function.');
          listeners.add(callback);
        },
        removeListener: callback => listeners.delete(callback),
        hasListener: callback => listeners.has(callback),
        hasListeners: () => listeners.size > 0
      });
    }
  }

  // Keep Chromium's other MV3 action fields and the native runtime/scripting APIs.
  const action = { ...chrome.action, ...api('browserAction') };
  apis.set('action', action);
  apis.set('browserAction', action);
  for (const [name, value] of apis) {
    Object.defineProperty(chrome, name, { configurable: true, enumerable: true, value });
  }

  bridge.subscribe((name, args) => {
    for (const callback of [...(listenersByEvent.get(name) ?? [])]) {
      try { callback(...args); } catch {}
    }
  });
  Reflect.deleteProperty(globalThis, property);
  Object.defineProperty(globalThis, 'browser', { value: chrome, configurable: true, writable: true });
}

if (process.type === 'service-worker' || typeof location !== 'undefined') {
  if (contextBridge.executeInMainWorld({ func: isLastPass, args: [extensionId] })) {
    const allowedMethods = qualifiedNames(methods);
    const allowedEvents = qualifiedNames(events);
    let subscribed = false;

    contextBridge.exposeInMainWorld(bridgeName, {
      async call(method, args) {
        if (!allowedMethods.has(method) || !Array.isArray(args) || args.length > 2) {
          throw new Error('Unsupported LastPass request.');
        }
        try {
          return await ipcRenderer.invoke(callChannel, method, args);
        } catch {
          throw new Error('Relay could not complete this extension request.');
        }
      },
      subscribe(deliver) {
        if (subscribed || typeof deliver !== 'function') return;
        subscribed = true;
        ipcRenderer.on(eventChannel, (_event, name, args) => {
          if (allowedEvents.has(name) && Array.isArray(args)) deliver(name, args);
        });
      }
    });
    contextBridge.executeInMainWorld({ func: installApi, args: [extensionId, bridgeName, methods, events] });
  }
}
