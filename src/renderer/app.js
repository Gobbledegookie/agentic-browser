(function () {
  'use strict';

  const relay = window.relay;
  const appearance = window.relayAppearance;
  const get = (id) => document.getElementById(id);
  const address = get('address');
  const page = get('page');
  const workspaceFrame = get('workspaceFrame');
  const startPage = get('startPage');
  const errorPage = get('errorPage');
  const panel = get('panel');
  const panelBody = get('panelBody');
  const findBar = get('findBar');
  const findQuery = get('findQuery');
  const findCount = get('findCount');
  const topTabs = get('topTabs');
  const sideTabs = get('sideTabs');
  const workspaceCurrent = get('workspaceCurrent');
  const workspaceBreadcrumbs = get('workspaceBreadcrumbs');
  const workspaceFooter = get('workspaceFooter');
  const workspacePopover = get('workspacePopover');
  const workspaceName = get('workspaceName');
  const workspaceNameSubmit = get('workspaceNameSubmit');
  const bookmarkBar = get('bookmarkBar');
  const notice = get('notice');
  const storeStrip = get('storeStrip');
  const storeAction = get('storeAction');
  const lastPassButton = get('lastPassButton');
  const lastPassBadge = get('lastPassBadge');
  const searchDialog = get('searchProviderDialog');
  const searchOptions = get('searchProviderOptions');
  const searchCancel = get('cancelSearchProvider');
  const searchError = get('searchProviderError');
  const pendingStoreInstalls = new Set();
  const shortcuts = new Map([
    ['focusAddress', focusAddress],
    ['showHistory', () => showPanel('history')],
    ['showBookmarks', () => showPanel('bookmarks')],
    ['showDownloads', () => showPanel('downloads')],
    ['showMenu', () => showPanel('menu')],
    ['showCustomization', () => showPanel('customization')],
    ['toggleAgent', () => togglePanel('agent')],
    ['showFind', showFind],
    ['zoomIn', () => changeZoom(0.1)],
    ['zoomOut', () => changeZoom(-0.1)],
    ['zoomReset', () => run('zoom', { factor: 1 })],
  ]);
  const panels = {
    settings: ['Customize Relay', 'sliders', renderSettings],
    customization: ['Runtime customization', 'code', renderCustomization],
    agent: ['Agent connection', 'agent', renderAgent],
    bookmarks: ['Bookmarks', 'star', renderBookmarks],
    history: ['History', 'history', renderHistory],
    downloads: ['Downloads', 'download', renderDownloads],
    extensions: ['Extensions', 'extensions', renderExtensions],
    menu: ['Browser menu', 'menu', renderMenu],
    workspaces: ['Workspaces', 'workspaces', renderWorkspacesPanel],
    tab: ['Tab actions', 'tab-top', renderTabPanel],
  };

  let state;
  let selectedPanel = null;
  let panelTrigger = null;
  let contextTabId = null;
  let panelSnapshot;
  let workspaceSnapshot;
  let workspaceEditor;
  let tabSnapshot;
  let lastTabId;
  let bookmarkSnapshot;
  let lastViewport;
  let viewportFrame = 0;
  let noticeTimer;
  let findTimer;
  let appliedCss = '';
  let appliedNewTabHtml = '';
  let contributionSnapshot;
  let agentAdvancedOpen = false;
  let searchPrompt = null;
  let searchSubmission = null;
  let openingLastPass = false;

  const tabStrip = node('div', 'tabs-strip');
  tabStrip.setAttribute('role', 'tablist');
  tabStrip.setAttribute('aria-label', 'Open tabs');

  const addTopTab = iconButton('plus', 'New tab (Ctrl+T)', () => createTab());
  topTabs.append(tabStrip, addTopTab);
  const customNewTabButtons = node('div', 'custom-controls custom-newtab-controls');
  customNewTabButtons.setAttribute('aria-label', 'Custom new-tab controls');
  const controlTargets = {
    address: get('addressForm'), back: get('backButton'), forward: get('forwardButton'), reload: get('reloadButton'),
    home: document.querySelector('.home-button'), bookmark: get('bookmarkButton'),
    extensions: document.querySelector('[data-panel="extensions"]'), downloads: document.querySelector('[data-panel="downloads"]'),
    menu: document.querySelector('[data-panel="menu"]'), topNewTab: addTopTab, sidebarNewTab: get('addSidebarTab'),
    newTabShortcuts: get('startShortcuts'), customizeShortcut: get('customizeShortcut'),
  };
  const defaultCustomization = { css: '', newTabHtml: '', buttons: [], shortcuts: [], hiddenControls: [] };
  const runtimeDraft = new Map();

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function icon(name) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS(element.namespaceURI, 'use');
    element.setAttribute('class', 'icon');
    element.setAttribute('aria-hidden', 'true');
    use.setAttribute('href', '#i-' + name);
    element.append(use);
    return element;
  }

  function setIcon(element, name) {
    element.querySelector('use')?.setAttribute('href', '#i-' + name);
  }

  function iconButton(name, label, listener, className = '') {
    const button = node('button', 'icon-button ' + className);
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.append(icon(name));
    button.addEventListener('click', listener);
    return button;
  }

  function textButton(label, listener, className = 'secondary-button', iconName) {
    const button = node('button', className);
    button.type = 'button';
    if (iconName) button.append(icon(iconName));
    button.append(document.createTextNode(label));
    button.addEventListener('click', listener);
    return button;
  }

  function applyState(update) {
    state = update;
    const active = activeTab();
    document.body.dataset.tabPosition = state.preferences.tabPosition;
    document.body.dataset.theme = state.preferences.theme;
    get('agentDot').hidden = !state.agent.enabled && !hasConnectedProvider();
    const lastPass = state.lastPassAction;
    lastPassButton.hidden = !lastPass;
    lastPassButton.disabled = openingLastPass || !lastPass?.enabled;
    lastPassBadge.textContent = lastPass?.badgeText.slice(0, 4) || '';
    lastPassBadge.hidden = !lastPassBadge.textContent;
    if (lastPass) {
      const [r, g, b, a] = lastPass.badgeColor;
      lastPassBadge.style.backgroundColor = `rgba(${r}, ${g}, ${b}, ${a / 255})`;
    }

    const maximize = get('maximize');
    maximize.title = state.maximized ? 'Restore' : 'Maximize';
    maximize.setAttribute('aria-label', maximize.title);
    setIcon(maximize, state.maximized ? 'restore' : 'maximize');

    const tabChanged = lastTabId !== active?.id;
    if (tabChanged || document.activeElement !== address) {
      address.value = active?.url || '';
    }
    if (tabChanged && !findBar.hidden) closeFind(false);
    lastTabId = active?.id;

    get('backButton').disabled = !active?.canGoBack;
    get('forwardButton').disabled = !active?.canGoForward;
    get('reloadButton').disabled = !active?.url && !active?.loading;
    const reloadLabel = active?.loading ? 'Stop loading' : 'Reload (Ctrl+R)';
    get('reloadButton').title = reloadLabel;
    get('reloadButton').setAttribute('aria-label', reloadLabel);
    setIcon(get('reloadButton'), active?.loading ? 'close' : 'reload');
    const securePage = active?.url?.startsWith('https:') && !active.loading && !active.error;
    setIcon(get('siteIcon'), securePage ? 'lock' : (active?.url ? 'globe' : 'search'));
    const bookmark = get('bookmarkButton');
    bookmark.disabled = !/^https?:\/\//i.test(active?.url || '');
    const bookmarked = !bookmark.disabled && state.bookmarks.some((item) => item.url === active.url);
    bookmark.setAttribute('aria-pressed', String(bookmarked));
    const bookmarkLabel = bookmarked ? 'Remove bookmark' : 'Bookmark this page';
    bookmark.setAttribute('aria-label', bookmarkLabel);
    bookmark.title = bookmarkLabel + ' (Ctrl+D)';

    startPage.hidden = Boolean(active?.url || active?.error);
    errorPage.hidden = !active?.error;
    get('errorDescription').textContent = active?.error || '';
    renderTabs(tabChanged);
    renderWorkspaceSwitcher();
    applyCustomization();
    renderBookmarkBar();
    renderStoreStrip();
    renderPanel();
    renderSearchChooser();
    scheduleViewport();
  }

  function activeTab() {
    return state?.tabs.find((tab) => tab.id === state.activeTabId);
  }

  function currentCustomization() {
    return { ...defaultCustomization, ...state?.customization };
  }

  function applyCustomization() {
    const { css, newTabHtml, buttons, hiddenControls } = currentCustomization();
    if (appliedCss !== css) {
      appliedCss = css;
      appearance.applyCss(css);
    }
    if (appliedNewTabHtml !== newTabHtml) {
      appliedNewTabHtml = newTabHtml;
      const frame = get('customStartFrame');
      if (newTabHtml.trim()) frame.srcdoc = appearance.buildNewTabDocument(newTabHtml);
      else frame.removeAttribute('srcdoc');
    }
    const hasCustomNewTab = Boolean(newTabHtml.trim());
    get('defaultStart').hidden = hasCustomNewTab;
    get('customStart').hidden = !hasCustomNewTab;
    const footer = get(hasCustomNewTab ? 'customStartActions' : 'defaultStartActions');
    if (customNewTabButtons.parentElement !== footer) footer.prepend(customNewTabButtons);

    for (const [key, element] of Object.entries(controlTargets)) element.hidden = hiddenControls.includes(key);
    const snapshot = JSON.stringify(buttons);
    if (contributionSnapshot !== snapshot) {
      contributionSnapshot = snapshot;
      for (const [location, target] of [['toolbar', get('customToolbarButtons')], ['sidebar', get('customSidebarButtons')], ['newTab', customNewTabButtons]]) {
        const children = renderContributedButtons(location, buttons);
        target.hidden = children.length === 0;
        target.replaceChildren(...children);
      }
    }
  }

  function renderContributedButtons(location, buttons = currentCustomization().buttons) {
    return buttons.filter((button) => button.location === location).map(({ id, label }) => {
      const invoke = () => run('runCustomCommand', { id });
      const button = location === 'menu'
        ? menuEntry(label, 'code', invoke)
        : textButton(label, invoke, 'secondary-button custom-control');
      button.dataset.customControl = id;
      return button;
    });
  }

  function renderWorkspaceSwitcher() {
    const previousWorkspaceId = workspaceBreadcrumbs.querySelector('[aria-current="true"]')?.dataset.workspaceId;
    const snapshot = JSON.stringify(state.workspaces);
    const workspacesChanged = snapshot !== workspaceSnapshot;
    if (workspacesChanged) {
      workspaceSnapshot = snapshot;
      const remaining = new Map(Array.from(workspaceBreadcrumbs.children, (button) => [button.dataset.workspaceId, button]));
      for (const [index, { id, name }] of state.workspaces.entries()) {
        const button = remaining.get(id) || createWorkspaceBreadcrumb(id);
        remaining.delete(id);
        button.title = name;
        button.setAttribute('aria-label', name);
        const atIndex = workspaceBreadcrumbs.children[index];
        if (button !== atIndex) workspaceBreadcrumbs.insertBefore(button, atIndex || null);
      }
      for (const button of remaining.values()) button.remove();
    }
    const active = state.workspaces.find(({ id }) => id === state.activeWorkspaceId);
    if (workspaceCurrent.textContent !== active?.name) {
      workspaceCurrent.textContent = active?.name || '';
      workspaceCurrent.title = active?.name || '';
    }
    const next = nextWorkspace();
    if (active && next && active.id !== next.id) {
      workspaceCurrent.setAttribute('aria-label', active.name + '. Switch to ' + next.name);
    } else {
      workspaceCurrent.removeAttribute('aria-label');
    }
    for (const button of workspaceBreadcrumbs.children) {
      if (button.dataset.workspaceId === state.activeWorkspaceId) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    }
    if (workspacesChanged || previousWorkspaceId !== state.activeWorkspaceId) {
      scrollActiveBreadcrumbIntoView();
    }
  }

  function createWorkspaceBreadcrumb(id) {
    const button = node('button', 'workspace-crumb');
    button.type = 'button';
    button.dataset.workspaceId = id;
    button.addEventListener('click', () => switchWorkspace(id));
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showWorkspaceEditor('rename', button, id);
    });
    return button;
  }

  function scrollActiveBreadcrumbIntoView() {
    const button = workspaceBreadcrumbs.querySelector('[aria-current="true"]');
    if (!button || sideTabs.hidden) return;
    const { left, right } = button.getBoundingClientRect();
    const strip = workspaceBreadcrumbs.getBoundingClientRect();
    if (left < strip.left) workspaceBreadcrumbs.scrollLeft += left - strip.left;
    else if (right > strip.right) workspaceBreadcrumbs.scrollLeft += right - strip.right;
  }

  function nextWorkspace() {
    const current = state.workspaces.findIndex(({ id }) => id === state.activeWorkspaceId);
    return state.workspaces[(current + 1) % state.workspaces.length];
  }

  function switchWorkspace(workspaceId) {
    if (state && workspaceId && workspaceId !== state.activeWorkspaceId) {
      run('selectWorkspace', { workspaceId });
    }
  }

  function renderTabs(tabChanged) {
    const side = state.preferences.tabPosition !== 'top';
    const parent = side ? sideTabs : topTabs;
    const moved = tabStrip.parentElement !== parent;
    topTabs.hidden = side;
    sideTabs.hidden = !side;
    tabStrip.setAttribute('aria-orientation', side ? 'vertical' : 'horizontal');
    if (moved) {
      if (side) sideTabs.insertBefore(tabStrip, workspaceFooter);
      else topTabs.prepend(tabStrip);
    }

    const key = JSON.stringify([state.activeTabId, state.tabs.map((tab) => [
      tab.id, tab.title, Boolean(tab.url), tab.loading, tab.pinned, tab.muted, tab.audible,
    ])]);
    if (key !== tabSnapshot) {
      tabSnapshot = key;
      const focused = document.activeElement;
      const focusedId = focused?.closest('.tab-entry')?.dataset.id;
      const closeFocused = focused?.classList.contains('tab-close');
      const previousScroll = [tabStrip.scrollLeft, tabStrip.scrollTop];
      const tabs = state.tabs.map(renderTab);
      tabStrip.replaceChildren(...tabs);
      tabStrip.scrollTo(...previousScroll);

      const focusedIndex = state.tabs.findIndex((tab) => String(tab.id) === focusedId);
      if (focusedIndex >= 0) tabs[focusedIndex].children[closeFocused ? 1 : 0].focus({ preventScroll: true });
    }
    if (tabChanged || moved) {
      tabStrip.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  function renderTab(tab) {
    const label = tab.title || (tab.url ? 'Untitled' : 'New tab');
    const isActive = tab.id === state.activeTabId;
    const entry = node('div', 'tab-entry');
    entry.dataset.id = String(tab.id);
    entry.classList.toggle('active', isActive);
    entry.classList.toggle('pinned', Boolean(tab.pinned));

    const select = node('button', 'tab-select');
    select.type = 'button';
    select.title = label;
    select.setAttribute('aria-label', label);
    select.setAttribute('role', 'tab');
    select.setAttribute('aria-selected', String(isActive));
    select.tabIndex = isActive ? 0 : -1;
    const indicator = tab.loading
      ? node('span', 'tab-loading-icon')
      : icon(tab.url ? 'globe' : 'mark');
    if (!tab.loading && !tab.url) indicator.classList.add('is-new-tab');
    select.append(indicator, node('span', 'tab-title', label));

    if (tab.muted || tab.audible) {
      const audio = icon(tab.muted ? 'mute' : 'audio');
      audio.classList.add('tab-indicator');
      select.append(audio);
    }
    if (tab.pinned) {
      const pin = icon('pin');
      pin.classList.add('tab-indicator');
      select.append(pin);
    }

    select.addEventListener('click', () => run('selectTab', { id: tab.id }));
    select.addEventListener('keydown', (event) => handleTabKey(event, tab.id));
    const close = iconButton('close', 'Close ' + label, () => run('closeTab', { id: tab.id }), 'tab-close');
    close.tabIndex = -1;
    entry.append(select, close);
    entry.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showTabPanel(tab.id, select);
    });
    entry.addEventListener('auxclick', (event) => {
      if (event.button === 1) run('closeTab', { id: tab.id });
    });
    return entry;
  }

  async function handleTabKey(event, id) {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      showTabPanel(id, event.currentTarget);
      return;
    }
    const direction = state.preferences.tabPosition === 'top'
      ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    const position = state.tabs.findIndex((tab) => tab.id === id);
    let nextIndex;
    if (direction.includes(event.key)) {
      const step = event.key === direction[0] ? -1 : 1;
      nextIndex = (position + step + state.tabs.length) % state.tabs.length;
    } else if (event.key === 'Home' || event.key === 'End') {
      nextIndex = event.key === 'Home' ? 0 : state.tabs.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    const next = state.tabs[nextIndex];
    await run('selectTab', { id: next.id });
    tabStrip.children[nextIndex]?.querySelector('.tab-select')?.focus();
  }

  function renderBookmarkBar() {
    const visible = state.preferences.bookmarksBar && !currentCustomization().hiddenControls.includes('bookmarksBar');
    bookmarkBar.hidden = !visible;
    const snapshot = JSON.stringify(state.bookmarks);
    if (!visible || snapshot === bookmarkSnapshot) return;
    bookmarkSnapshot = snapshot;
    const chips = state.bookmarks.map((bookmark) => {
      const chip = textButton(bookmark.title || bookmark.url,
        () => run('navigate', { input: bookmark.url }), 'bookmark-chip', 'star');
      const label = chip.lastChild;
      chip.replaceChild(node('span', '', label.textContent), label);
      chip.title = bookmark.url;
      return chip;
    });
    if (!chips.length) {
      chips.push(textButton('Bookmarks', () => showPanel('bookmarks'), 'bookmark-chip', 'star'));
    }
    bookmarkBar.replaceChildren(...chips);
  }

  function scheduleViewport() {
    if (viewportFrame) return;
    viewportFrame = requestAnimationFrame(() => {
      viewportFrame = 0;
      positionWorkspacePopover();
      const active = activeTab();
      const rect = page.getBoundingClientRect();
      const frame = workspaceFrame.getBoundingClientRect();
      const pageStyle = getComputedStyle(page);
      const xScale = rect.width / page.offsetWidth || 1;
      const yScale = rect.height / page.offsetHeight || 1;
      const inset = (side) => parseFloat(pageStyle['border' + side + 'Width']) + parseFloat(pageStyle['padding' + side]);
      const left = Math.max(rect.left + inset('Left') * xScale, frame.left);
      const top = Math.max(rect.top + inset('Top') * yScale, frame.top);
      const right = Math.min(rect.right - inset('Right') * xScale, frame.right);
      const bottom = Math.min(rect.bottom - inset('Bottom') * yScale, frame.bottom);
      const visible = active?.url && !active.error && !state.pendingSearch;
      const bounds = visible && pageStyle.visibility !== 'hidden' && pageStyle.opacity !== '0'
        ? { x: Math.ceil(left), y: Math.ceil(top), width: Math.max(0, Math.floor(right) - Math.ceil(left)), height: Math.max(0, Math.floor(bottom) - Math.ceil(top)) }
        : { x: 0, y: 0, width: 0, height: 0 };
      const key = JSON.stringify(bounds);
      if (key === lastViewport) return;
      lastViewport = key;
      relay.setViewport(bounds);
    });
  }

  async function request(name, payload, successMessage, onError = (message) => showNotice(message, true)) {
    if (!relay) return null;
    try {
      const result = await relay.action(name, payload);
      if (!result.ok) {
        onError(result.error || 'The operation could not be completed.');
        return null;
      }
      if (result.value === false) return null;
      if (successMessage) showNotice(successMessage);
      return result;
    } catch {
      onError('Relay could not complete this operation.');
      return null;
    }
  }

  async function run(name, payload, successMessage) {
    return Boolean(await request(name, payload, successMessage));
  }

  function searchProviderOptions() {
    return state.searchProviders ?? [
      { id: 'google', label: 'Google' },
      { id: 'duckduckgo', label: 'DuckDuckGo' },
      { id: 'bing', label: 'Bing' },
    ];
  }

  function renderSearchChooser() {
    const pending = state.pendingSearch;
    if (!pending) {
      if (!searchPrompt) return;
      const { origin, query, cancelled } = searchPrompt;
      searchPrompt = null;
      searchDialog.close();

      if (cancelled) {
        const field = origin.getClientRects().length ? origin : address;
        field.value = query;
        field.focus();
        field.setSelectionRange(query.length, query.length);
      } else if (origin !== address) {
        origin.value = '';
      }
      return;
    }
    if (searchPrompt?.id === pending.id) return;

    const origin = searchSubmission?.query === pending.query ? searchSubmission.input : address;
    searchSubmission = null;
    searchPrompt = { ...pending, origin, cancelled: true, busy: false };
    get('pendingSearchQuery').textContent = pending.query;
    searchError.hidden = true;
    searchCancel.disabled = false;
    searchOptions.replaceChildren(...searchProviderOptions().map(({ id, label }) => {
      const option = textButton(label, () => resolveSearchChooser(id), 'search-provider-option');
      option.dataset.searchEngine = id;
      option.append(icon('forward'));
      return option;
    }));
    if (!searchDialog.open) searchDialog.showModal();
    (searchOptions.firstElementChild || searchCancel).focus({ preventScroll: true });
  }

  async function resolveSearchChooser(engine) {
    const prompt = searchPrompt;
    if (!prompt || prompt.busy) return;
    prompt.busy = true;
    prompt.cancelled = !engine;
    searchError.hidden = true;
    const buttons = [...searchOptions.children, searchCancel];
    const focused = document.activeElement;
    for (const button of buttons) button.disabled = true;
    const action = engine ? 'chooseSearchProvider' : 'cancelSearchProvider';
    const payload = engine ? { id: prompt.id, engine } : { id: prompt.id };
    const result = await request(action, payload, undefined, (message) => {
      if (searchPrompt !== prompt) return;
      searchError.textContent = message;
      searchError.hidden = false;
    });
    if (!result && searchPrompt === prompt) {
      prompt.cancelled = true;
      prompt.busy = false;
      for (const button of buttons) button.disabled = false;
      if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
    }
  }

  function renderStoreStrip() {
    const listing = state.storeListing;
    storeStrip.hidden = !listing;
    if (!listing) return;

    const installing = pendingStoreInstalls.has(listing.id);
    const status = get('storeStatus');
    const startupFailure = !installing && listing.installed && listing.runtimeError;
    status.hidden = !installing && !listing.installed;
    status.classList.toggle('store-runtime-error', Boolean(startupFailure));
    status.title = startupFailure || '';
    if (startupFailure) status.textContent = 'Couldn’t start. ' + startupFailure;
    else if (installing) status.textContent = 'Preparing installation…';
    else status.textContent = listing.installed ? 'Installed in Relay' : '';
    storeAction.disabled = installing;
    storeAction.className = listing.installed ? 'secondary-button' : 'primary-button';
    storeAction.textContent = installing ? 'Installing…' : (listing.installed ? 'Manage extensions' : 'Add to Relay');
  }

  async function installCurrentStoreListing(id) {
    if (state.storeListing?.id !== id || state.storeListing.installed || pendingStoreInstalls.has(id)) return;
    pendingStoreInstalls.add(id);
    renderStoreStrip();
    renderPanel();
    try {
      await run('installStoreListing', { id }, 'Extension installed.');
    } finally {
      pendingStoreInstalls.delete(id);
      renderStoreStrip();
      renderPanel();
    }
  }

  function showNotice(message, error = false) {
    clearTimeout(noticeTimer);
    notice.hidden = false;
    notice.textContent = message;
    notice.classList.toggle('error', error);
    noticeTimer = setTimeout(() => { notice.hidden = true; }, error ? 6500 : 3000);
  }

  function focusAddress() {
    address.focus();
    address.select();
  }

  async function createTab() {
    if (await run('newTab')) focusAddress();
  }

  function changeZoom(step) {
    const current = activeTab()?.zoomFactor || 1;
    const factor = Math.max(0.25, Math.min(5, Math.round((current + step) * 100) / 100));
    run('zoom', { factor });
  }

  function showFind() {
    findBar.hidden = false;
    findQuery.focus();
    findQuery.select();
  }

  function searchPage(findNext = false, forward = true) {
    clearTimeout(findTimer);
    const query = findQuery.value;
    if (query) run('find', { query, findNext, forward });
    else {
      findCount.textContent = '';
      run('stopFind');
    }
  }

  function closeFind(focus = true) {
    clearTimeout(findTimer);
    findBar.hidden = true;
    findQuery.value = '';
    findCount.textContent = '';
    run('stopFind');
    if (focus) focusAddress();
  }

  function togglePanel(name, trigger) {
    if (selectedPanel === name) closePanel();
    else showPanel(name, trigger);
  }

  function showPanel(name, trigger) {
    if (!panels[name] || !state) return;
    closeWorkspaceEditor();
    if (trigger && !panel.contains(trigger)) panelTrigger = trigger;
    if (!trigger && !selectedPanel) panelTrigger = document.activeElement;
    if (name === 'agent' && selectedPanel !== 'agent') agentAdvancedOpen = false;
    selectedPanel = name;
    panel.hidden = false;
    panelBody.toggleAttribute('data-customizable', name !== 'agent' && name !== 'customization');
    for (const button of document.querySelectorAll('[data-panel]')) {
      button.setAttribute('aria-expanded', String(button.dataset.panel === name));
    }
    renderPanel();
    panel.querySelector('[data-panel-close]').focus({ preventScroll: true });
  }

  function showTabPanel(id, trigger) {
    contextTabId = id;
    showPanel('tab', trigger);
  }

  function closePanel(restoreFocus = true) {
    if (!selectedPanel) return;
    if (workspaceEditor && !sideTabs.contains(workspaceEditor.trigger)) closeWorkspaceEditor();
    panel.hidden = true;
    selectedPanel = null;
    panelSnapshot = null;
    panelBody.replaceChildren();
    for (const button of document.querySelectorAll('[data-panel]')) {
      button.setAttribute('aria-expanded', 'false');
    }
    if (restoreFocus) {
      if (panelTrigger?.isConnected) panelTrigger.focus({ preventScroll: true });
      else tabStrip.querySelector('.active .tab-select')?.focus({ preventScroll: true });
    }
    panelTrigger = null;
  }

  function renderPanel() {
    if (!selectedPanel || !state) return;
    const [title, emblem, renderer] = panels[selectedPanel];
    const snapshot = JSON.stringify([selectedPanel, panelData()]);
    if (snapshot === panelSnapshot) return;
    const samePanel = get('panelHeading').textContent === title;
    const focused = samePanel && panelBody.contains(document.activeElement) ? document.activeElement : null;
    const focusedName = focused?.getAttribute('name');
    const focusedProvider = focused?.closest('[data-provider]')?.dataset.provider;
    const focusedValue = focused?.type === 'text' ? focused.value : undefined;
    const caret = focused instanceof HTMLTextAreaElement ? [focused.selectionStart, focused.selectionEnd] : null;
    const scrollTop = samePanel ? panelBody.scrollTop : 0;
    panelSnapshot = snapshot;

    get('panelHeading').textContent = title;
    get('panelIcon').replaceChildren(icon(emblem));
    panelBody.replaceChildren(renderer());
    panelBody.scrollTop = scrollTop;
    if (focusedName) {
      const input = panelBody.querySelector('[name="' + CSS.escape(focusedName) + '"]');
      if (input && focusedValue !== undefined) {
        input.value = focusedValue;
        if (focusedName === 'historySearch') input.dispatchEvent(new Event('input'));
      }
      const providerCard = focusedProvider && panelBody.querySelector('[data-provider="' + CSS.escape(focusedProvider) + '"]');
      const focusTarget = input || providerCard?.querySelector('button:not([disabled])') || providerCard;
      focusTarget?.focus({ preventScroll: true });
      if (caret && input instanceof HTMLTextAreaElement) input.setSelectionRange(...caret);
    }
  }

  function panelData() {
    switch (selectedPanel) {
      case 'settings': return [state.preferences, state.searchProviderChosen, state.version];
      case 'customization': return currentCustomization();
      case 'agent': return [state.agent, state.providers, hasRuntimeCustomization()];
      case 'bookmarks': return state.bookmarks;
      case 'history': return state.history;
      case 'downloads': return state.downloads;
      case 'extensions': return [state.extensions, state.storeListing, pendingStoreInstalls.has(state.storeListing?.id)];
      case 'workspaces': return [state.workspaces, state.activeWorkspaceId];
      case 'tab': return [state.tabs.find((tab) => tab.id === contextTabId), state.workspaces, state.activeWorkspaceId];
      case 'menu': return [activeTab()?.zoomFactor, state.fullScreen, currentCustomization().buttons];
      default: return null;
    }
  }

  function stack(...children) {
    const result = node('div', 'panel-stack');
    result.append(...children);
    return result;
  }

  function section(heading, ...children) {
    const result = node('section', 'panel-section');
    result.append(node('h3', '', heading), ...children);
    return result;
  }

  function group(...children) {
    const result = node('div', 'panel-group');
    result.append(...children);
    return result;
  }

  function field(label, input) {
    const wrapper = node('label', 'field-label', label);
    wrapper.append(input);
    return wrapper;
  }

  function input(name, value, placeholder) {
    const element = node('input');
    element.name = name;
    element.value = value || '';
    element.placeholder = placeholder || '';
    element.type = 'text';
    element.spellcheck = false;
    element.autocomplete = 'off';
    return element;
  }

  function select(name, options, current) {
    const element = node('select');
    element.name = name;
    for (const [value, label] of options) {
      const option = node('option', '', label);
      option.value = value;
      option.selected = value === current;
      element.append(option);
    }
    return element;
  }

  function empty(iconName, heading, description) {
    const element = node('div', 'panel-empty');
    const mark = node('span', 'empty-icon');
    mark.append(icon(iconName));
    element.append(mark, node('h3', '', heading), node('p', '', description));
    return element;
  }

  function item(title, detail, onClick, iconName) {
    const row = node('div', 'panel-item');
    if (iconName) row.append(icon(iconName));
    const content = node(onClick ? 'button' : 'div', 'panel-item-text');
    if (onClick) {
      content.type = 'button';
      content.addEventListener('click', onClick);
    }
    if (detail) content.title = detail;
    content.append(node('span', 'panel-item-title', title), node('span', 'panel-item-detail', detail));
    row.append(content);
    return row;
  }

  function list(records) {
    const result = node('div', 'panel-list');
    result.append(...records);
    return result;
  }

  function renderSettings() {
    const prefs = state.preferences;
    const locations = node('div', 'segmented');
    locations.setAttribute('role', 'group');
    locations.setAttribute('aria-label', 'Tab position');
    for (const [value, label] of [['top', 'Top'], ['left', 'Left'], ['right', 'Right']]) {
      const choice = textButton(label, () => run('preferences', { tabPosition: value }), '', 'tab-' + value);
      choice.setAttribute('aria-pressed', String(prefs.tabPosition === value));
      locations.append(choice);
    }
    const theme = select('theme', [['dark', 'Dark'], ['light', 'Light'], ['system', 'Match Windows']], prefs.theme);
    theme.addEventListener('change', () => run('preferences', { theme: theme.value }));
    const bar = node('label', 'checkbox-label');
    const check = node('input');
    check.type = 'checkbox';
    check.checked = prefs.bookmarksBar;
    check.addEventListener('change', () => run('preferences', { bookmarksBar: check.checked }));
    bar.append(check, 'Show bookmarks bar');

    const engines = searchProviderOptions().map(({ id, label }) => [id, label]);
    if (!state.searchProviderChosen) engines.unshift(['', 'Choose on first search']);
    const engine = select('engine', engines, state.searchProviderChosen ? prefs.searchEngine : '');
    if (!state.searchProviderChosen) engine.options[0].disabled = true;
    engine.addEventListener('change', () => run('preferences', { searchEngine: engine.value }));
    const homepage = input('homepage', prefs.homepage, 'New tab page');
    const form = node('form', 'panel-stack');
    const save = node('button', 'primary-button', 'Save home page');
    save.type = 'submit';
    form.append(field('Home page', homepage), group(save));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      run('preferences', { homepage: homepage.value.trim() }, 'Home page saved.');
    });

    return stack(
      section('Tab position', locations),
      section('Appearance', field('Theme', theme), bar),
      section('Navigation', field('Search engine', engine), form),
      textButton('Runtime customization', () => showPanel('customization'), 'secondary-button', 'code'),
      node('p', 'muted', 'Relay Browser ' + (state.version || '')),
    );
  }

  function hasRuntimeCustomization() {
    const configuration = currentCustomization();
    return Boolean(configuration.css || configuration.newTabHtml || configuration.buttons.length ||
      configuration.shortcuts.length || configuration.hiddenControls.length);
  }

  function resetCustomizationButton() {
    const button = textButton('Restore default interface', async () => {
      if (await run('resetCustomization', undefined, 'Default interface restored.')) {
        runtimeDraft.clear();
        if (selectedPanel === 'customization') {
          panelSnapshot = undefined;
          renderPanel();
        }
      }
    });
    button.disabled = !hasRuntimeCustomization();
    return button;
  }

  function editor(name, value, placeholder, rows) {
    const textarea = node('textarea');
    textarea.name = name;
    textarea.value = runtimeDraft.get(name) ?? value;
    textarea.placeholder = placeholder;
    textarea.rows = rows;
    textarea.spellcheck = false;
    textarea.addEventListener('input', () => {
      if (textarea.value === value) runtimeDraft.delete(name);
      else runtimeDraft.set(name, textarea.value);
    });
    return textarea;
  }

  function renderCustomization() {
    const configuration = currentCustomization();
    const css = editor('runtimeCss', configuration.css, '.shortcut { border-radius: 20px; }', 4);
    const html = editor('runtimeHtml', configuration.newTabHtml, '<h1>My workspace</h1>', 4);
    const { buttons, shortcuts, hiddenControls } = configuration;
    const commands = editor('runtimeControls', JSON.stringify({ buttons, shortcuts, hiddenControls }, null, 2), '', 6);
    const form = node('form', 'panel-stack');
    const submit = node('button', 'primary-button', 'Apply changes');
    submit.type = 'submit';
    const actions = group(submit, resetCustomizationButton());
    actions.classList.add('runtime-actions');
    const guide = 'https://github.com/Gobbledegookie/agentic-browser/blob/main/docs/customization.md';
    form.append(
      section('Appearance',
        node('p', '', 'Style the tab strips, toolbar, start page, and most panels with CSS.'),
        field('Browser CSS', css)),
      section('New tab',
        node('p', '', 'Replace the start page with offline HTML and CSS. Leave this blank to use Relay’s start page.'),
        field('New-tab HTML', html)),
      section('Controls',
        node('p', '', 'Register buttons and keyboard shortcuts that run browser commands, or hide built-in controls.'),
        field('Controls JSON', commands),
        textButton('Read setup guide', () => run('newTab', { input: guide }), 'text-button', 'external')),
      actions,
    );
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      let parsed;
      try {
        parsed = JSON.parse(commands.value.trim() || '{}');
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' ||
          Object.keys(parsed).some((key) => !['buttons', 'shortcuts', 'hiddenControls'].includes(key))) throw new Error();
      } catch {
        showNotice('Controls JSON must be an object with buttons, shortcuts, or hiddenControls.', true);
        commands.focus();
        return;
      }
      const patch = {};
      if (css.value !== configuration.css) patch.css = css.value;
      if (html.value !== configuration.newTabHtml) patch.newTabHtml = html.value;
      for (const key of ['buttons', 'shortcuts', 'hiddenControls']) {
        const replacement = Object.hasOwn(parsed, key) ? parsed[key] : [];
        if (JSON.stringify(replacement) !== JSON.stringify(configuration[key])) patch[key] = replacement;
      }
      const submitted = [css, html, commands].map((field) => [field.name, field.value]);
      submit.disabled = true;
      try {
        if (!Object.keys(patch).length || await run('customization', patch, 'Interface updated.')) {
          for (const [name, value] of submitted) {
            if (runtimeDraft.get(name) === value) runtimeDraft.delete(name);
          }
        }
      } finally {
        submit.disabled = false;
      }
    });
    return form;
  }

  function renderAgent() {
    const providers = node('div', 'provider-list');
    providers.append(
      renderProvider('chatgpt', 'ChatGPT', 'Codex · Full access', 'agent'),
      renderProvider('claude', 'Claude', 'Claude Code', 'code'),
    );
    const permissions = node('p', 'provider-permissions',
      'Connected agents can control Relay and read visible webpage text, tabs, history, bookmarks, downloads, and extensions.');
    const content = stack(permissions, providers);
    if (hasConnectedProvider()) {
      content.append(node('p', 'provider-example', 'Try asking “Move my tabs to the left.”'));
    }
    const advanced = node('details', 'agent-advanced');
    advanced.open = agentAdvancedOpen;
    const summary = node('summary', 'agent-advanced-summary');
    summary.append(icon('sliders'), node('span', '', 'Advanced settings'), icon('down'));
    advanced.append(summary, renderAdvancedAgent());
    advanced.addEventListener('toggle', () => {
      if (advanced.isConnected) agentAdvancedOpen = advanced.open;
    });
    content.append(advanced);
    return content;
  }

  function hasConnectedProvider() {
    return Object.values(state.providers || {}).some((provider) => provider.status === 'connected');
  }

  function renderProvider(id, name, product, iconName) {
    const labels = {
      checking: 'Checking', available: 'Ready', missing: 'Not installed',
      connecting: 'Signing in', connected: 'Connected', error: 'Needs attention',
    };
    const provider = state.providers?.[id];
    const status = Object.hasOwn(labels, provider?.status) ? provider.status : 'checking';
    const card = node('section', 'provider-card');
    card.dataset.provider = id;
    card.dataset.status = status;
    card.setAttribute('aria-labelledby', id + 'ProviderName');
    card.tabIndex = -1;

    const header = node('div', 'provider-card-header');
    const mark = node('span', 'provider-mark ' + id);
    mark.append(icon(iconName));
    const nameBlock = node('div', 'provider-name');
    const heading = node('h3', '', name);
    heading.id = id + 'ProviderName';
    nameBlock.append(heading, node('span', '', 'via ' + product));
    const badge = node('span', 'provider-badge', labels[status]);
    badge.setAttribute('role', 'status');
    header.append(mark, nameBlock, badge);
    card.append(header);

    const controls = group();
    const button = (action, label, variant, buttonIcon) => {
      const control = textButton(label, async () => {
        control.disabled = true;
        try {
          await run(action, action === 'refreshProviders' ? undefined : { id });
        } finally {
          control.disabled = false;
        }
      }, variant, buttonIcon);
      control.name = id + '-' + action;
      controls.append(control);
    };

    switch (status) {
      case 'available':
        button('connectProvider', 'Connect', 'primary-button');
        break;
      case 'connected':
        button('openProvider', 'Open ' + name, 'primary-button', 'external');
        button('disconnectProvider', 'Disconnect');
        break;
      case 'missing':
        button('installProvider', 'Install', 'primary-button', 'external');
        button('refreshProviders', 'Check again');
        break;
      case 'connecting':
        card.append(node('p', 'provider-message', 'Complete any sign-in prompts, then return to Relay.'));
        button('cancelProvider', 'Cancel');
        break;
      case 'error': {
        const message = typeof provider.message === 'string' && provider.message.trim()
          ? provider.message.trim().slice(0, 400)
          : 'Relay couldn’t connect to ' + name + '.';
        card.append(node('p', 'item-error provider-message', message));
        button('connectProvider', 'Try again', 'primary-button');
        button('refreshProviders', 'Check again');
        break;
      }
    }
    if (controls.childElementCount) card.append(controls);
    return card;
  }

  function renderAdvancedAgent() {
    const agent = state.agent;
    const status = node('div', 'connection-status' + (agent.enabled ? ' enabled' : ''),
      agent.enabled ? 'Agent bridge enabled' : 'Agent bridge disabled');
    const toggle = textButton(agent.enabled ? 'Disable bridge' : 'Enable bridge',
      () => run('agentEnable', { enabled: !agent.enabled }),
      agent.enabled ? 'secondary-button' : 'primary-button', 'key');
    const content = stack(
      section('Browser interface', group(
        textButton('Runtime customization', () => showPanel('customization'), 'secondary-button', 'code'),
        resetCustomizationButton(),
      )),
      section('Manual connection', status, group(toggle)),
    );
    content.classList.add('agent-advanced-content');

    if (agent.enabled) {
      const example = '“Move my tabs to the left and turn on the bookmarks bar.”';
      const config = { mcpServers: { 'relay-browser': { command: agent.mcpCommand, args: agent.mcpArgs, env: agent.mcpEnv } } };
      const guide = 'https://github.com/Gobbledegookie/agentic-browser/blob/main/docs/agent-connection.md';
      content.append(section('Connect an MCP client',
        node('p', '', 'Install Node.js 22.12 or newer and add Relay’s server configuration to your agent.'),
        group(
          textButton('Copy MCP config', () => run('copy', { text: JSON.stringify(config, null, 2) },
            'MCP configuration copied.'), 'primary-button', 'copy'),
          textButton('Setup guide', () => run('newTab', { input: guide }), 'secondary-button', 'external'),
        ),
        node('p', 'muted', 'Try asking ' + example),
      ));
      content.append(section('Local API',
        node('div', 'agent-endpoint', agent.endpoint || ''),
        group(
          textButton('Copy access token', () => run('copy', { text: agent.token }, 'Access token copied.'), 'secondary-button', 'copy'),
          textButton('Rotate token', () => run('agentRotate', undefined, 'Access token rotated.'), 'secondary-button'),
        ),
      ));
    }
    return content;
  }

  function renderBookmarks() {
    if (!state.bookmarks.length) return empty('star', 'No bookmarks yet', 'Use the star in the address bar to save a page.');
    return list(state.bookmarks.map((bookmark) => {
      const row = item(bookmark.title || bookmark.url, bookmark.url, () => openSaved(bookmark.url), 'star');
      row.append(iconButton('trash', 'Remove bookmark', () => run('removeBookmark', { id: bookmark.id })));
      return row;
    }));
  }

  function renderHistory() {
    if (!state.history.length) return empty('history', 'No browsing history', 'Pages you visit will appear here.');
    const search = input('historySearch', '', 'Search history');
    search.className = 'panel-search';
    search.setAttribute('aria-label', 'Search history');
    const records = state.history.map((entry) => {
      const row = item(entry.title || entry.url, entry.url, () => openSaved(entry.url), 'history');
      const date = new Date(entry.visitedAt);
      if (!Number.isNaN(date.valueOf())) row.title = date.toLocaleString();
      return { row, term: (entry.title + ' ' + entry.url).toLowerCase() };
    });
    const rows = list(records.map(({ row }) => row));
    function filter() {
      const query = search.value.trim().toLowerCase();
      for (const { row, term } of records) row.hidden = !term.includes(query);
    }
    search.addEventListener('input', filter);
    const clear = textButton('Clear history', (event) => {
      const button = event.currentTarget;
      if (button.dataset.confirmed === 'true') {
        run('clearHistory', undefined, 'Browsing history cleared.');
      } else {
        button.dataset.confirmed = 'true';
        button.textContent = 'Confirm clear history';
      }
    }, 'secondary-button danger');
    return stack(search, group(clear), rows);
  }

  async function openSaved(url) {
    if (await run('navigate', { input: url })) closePanel(false);
  }

  const byteFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
  function bytes(count) {
    if (!Number.isFinite(count) || count < 0) return '0 B';
    if (count < 1024) return count + ' B';
    if (count < 1024 ** 2) return byteFormat.format(count / 1024) + ' KB';
    if (count < 1024 ** 3) return byteFormat.format(count / 1024 ** 2) + ' MB';
    return byteFormat.format(count / 1024 ** 3) + ' GB';
  }

  function renderDownloads() {
    if (!state.downloads.length) return empty('download', 'No downloads yet', 'Files you download will appear here.');
    return list(state.downloads.map((download) => {
      const { id, name, state: status, receivedBytes, totalBytes } = download;
      const active = status === 'progressing' || status === 'paused';
      const detail = active ? bytes(receivedBytes) + (totalBytes ? ' of ' + bytes(totalBytes) : '')
        : (status ? status[0].toUpperCase() + status.slice(1) : '');
      const row = item(name || 'Download', detail);
      row.classList.add('vertical');
      if (active) {
        const progress = node('progress');
        progress.setAttribute('aria-label', 'Download progress');
        if (totalBytes > 0) {
          progress.max = totalBytes;
          progress.value = receivedBytes;
        }
        row.append(progress, group(textButton('Cancel', () => run('downloadCancel', { id }))));
      } else if (status === 'completed') {
        row.append(group(
          textButton('Open', () => run('downloadOpen', { id }), 'secondary-button', 'external'),
          textButton('Show in folder', () => run('downloadReveal', { id }), 'secondary-button', 'folder'),
        ));
      }
      return row;
    }));
  }

  function renderExtensions() {
    const entry = input('extensionInput', '', 'Chrome Web Store URL or extension ID');
    const form = node('form', 'panel-stack');
    const submit = node('button', 'primary-button', 'Install from Store');
    submit.type = 'submit';
    form.append(field('Extension', entry), group(submit,
      textButton('Load unpacked', () => run('loadExtension'), 'secondary-button', 'folder')));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!entry.value.trim()) return;
      submit.disabled = true;
      try {
        if (await run('installExtension', { input: entry.value.trim() }, 'Extension installed.')) entry.value = '';
      } finally {
        submit.disabled = false;
      }
    });
    const manage = state.extensions.length ? list(state.extensions.map((extension) => {
      const { id, name, version, description, source, enabled, error, runtimeError, hasPage } = extension;
      const row = item(name || id,
        [version, source === 'store' ? 'Chrome Web Store' : 'Unpacked', enabled === false ? 'Inactive' : ''].filter(Boolean).join(' · '));
      row.classList.add('vertical');
      if (description) row.append(node('p', 'muted', description));
      if (error && error !== runtimeError) row.append(node('p', 'item-error', error));
      const startupStatusId = 'extension-startup-' + id;
      if (runtimeError) {
        const failure = node('div', 'extension-startup-failure');
        failure.id = startupStatusId;
        failure.setAttribute('role', 'status');
        failure.append(node('strong', '', 'Couldn’t start'), node('p', '', runtimeError));
        row.append(failure);
      }
      const controls = group();
      if (hasPage) {
        const open = textButton(runtimeError ? 'Try again' : 'Open extension',
          () => run('openExtension', { id }), runtimeError ? 'primary-button' : 'secondary-button',
          runtimeError ? 'reload' : 'external');
        open.name = 'extension-open-' + id;
        if (runtimeError) open.setAttribute('aria-describedby', startupStatusId);
        controls.append(open);
      }
      controls.append(textButton('Remove', () => run('removeExtension', { id }), 'secondary-button', 'trash'));
      row.append(controls);
      return row;
    })) : empty('extensions', 'No extensions installed', 'Add a compatible Chrome extension to get started.');

    const sections = [
      section('Add extension', form,
        textButton('Browse Chrome Web Store', () => run('newTab', { input: 'https://chromewebstore.google.com/' }), 'text-button', 'external')),
      section('Installed extensions', manage),
    ];
    const currentListing = state.storeListing;
    if (currentListing) {
      const { id, installed, runtimeError } = currentListing;
      const installing = pendingStoreInstalls.has(id);
      const attach = textButton(installing ? 'Installing…' : 'Add to Relay', () => installCurrentStoreListing(id), 'primary-button');
      attach.disabled = installing;
      const installedMessage = runtimeError
        ? 'This extension couldn’t start. See Installed extensions for details.'
        : 'This extension is installed in Relay.';
      sections.unshift(section('Current Chrome Web Store listing',
        installed ? node('p', '', installedMessage) : group(attach)));
    }
    return stack(...sections);
  }

  function menuEntry(label, iconName, listener, key) {
    const element = node('button', 'menu-entry');
    element.type = 'button';
    element.append(icon(iconName), node('span', '', label));
    if (key) element.append(node('kbd', '', key));
    element.addEventListener('click', listener);
    return element;
  }

  function showWorkspaceEditor(mode, trigger, workspaceId = state?.activeWorkspaceId) {
    if (!state) return;
    closeWorkspaceEditor();
    const creating = mode === 'create';
    workspaceEditor = { mode, workspaceId, trigger };
    get('workspacePopoverHeading').textContent = creating ? 'New workspace' : 'Rename workspace';
    workspaceName.value = creating ? '' : state.workspaces.find(({ id }) => id === workspaceId)?.name || '';
    workspaceNameSubmit.textContent = creating ? 'Create' : 'Save';
    workspaceNameSubmit.disabled = false;
    trigger.setAttribute('aria-expanded', 'true');
    workspacePopover.showPopover({ source: trigger });
    positionWorkspacePopover();
    workspaceName.focus({ preventScroll: true });
    workspaceName.select();
  }

  function positionWorkspacePopover() {
    if (!workspaceEditor) return;
    const originalTrigger = workspaceEditor.trigger;
    const trigger = originalTrigger.isConnected ? originalTrigger : get(originalTrigger.id);
    if (!trigger?.getClientRects().length) return closeWorkspaceEditor();

    const region = sideTabs.contains(trigger) ? sideTabs : panel;
    const bounds = region.getBoundingClientRect();
    const anchor = trigger.getBoundingClientRect();
    const width = Math.min(222, bounds.width - 16);
    workspacePopover.style.width = width + 'px';
    workspacePopover.style.left = bounds.left + (bounds.width - width) / 2 + 'px';
    const height = workspacePopover.offsetHeight;
    const top = anchor.bottom + height + 14 <= bounds.bottom ? anchor.bottom + 6 : anchor.top - height - 6;
    workspacePopover.style.top = Math.max(bounds.top + 8, top) + 'px';
  }

  function closeWorkspaceEditor(restoreFocus = false) {
    const trigger = workspaceEditor?.trigger;
    if (!trigger) return;
    workspacePopover.hidePopover();
    if (restoreFocus) {
      (trigger.isConnected ? trigger : get(trigger.id))?.focus({ preventScroll: true });
    }
  }

  function renderWorkspacesPanel() {
    const entries = state.workspaces.map(({ id, name }) => {
      const button = menuEntry(name, 'folder', async () => {
        if (id === state.activeWorkspaceId || await run('selectWorkspace', { workspaceId: id })) {
          if (selectedPanel === 'workspaces') closePanel();
        }
      });
      button.classList.add('workspace-entry');
      if (id === state.activeWorkspaceId) button.setAttribute('aria-current', 'true');
      return button;
    });
    const add = textButton('New workspace', (event) => showWorkspaceEditor('create', event.currentTarget), 'primary-button', 'plus');
    add.id = 'managerAddWorkspace';
    const rename = textButton('Rename current', (event) => showWorkspaceEditor('rename', event.currentTarget), 'secondary-button', 'edit');
    rename.id = 'managerRenameWorkspace';
    return stack(list(entries), group(add, rename));
  }

  function renderMenu() {
    const zoom = node('div', 'zoom-row');
    const factor = activeTab()?.zoomFactor || 1;
    const zoomOut = iconButton('minimize', 'Zoom out', () => changeZoom(-0.1));
    const zoomIn = iconButton('plus', 'Zoom in', () => changeZoom(0.1));
    zoom.append(node('span', '', 'Zoom'), zoomOut,
      textButton(Math.round(factor * 100) + '%', () => run('zoom', { factor: 1 })), zoomIn);
    return stack(
      list([
        menuEntry('New tab', 'plus', () => { closePanel(false); createTab(); }, 'Ctrl+T'),
        menuEntry('Reopen closed tab', 'return', () => run('reopenTab'), 'Ctrl+Shift+T'),
        menuEntry('Workspaces', 'workspaces', () => showPanel('workspaces')),
        menuEntry('Bookmarks', 'star', () => showPanel('bookmarks'), 'Ctrl+Shift+O'),
        menuEntry('History', 'history', () => showPanel('history'), 'Ctrl+H'),
        menuEntry('Downloads', 'download', () => showPanel('downloads'), 'Ctrl+J'),
        menuEntry('Extensions', 'extensions', () => showPanel('extensions')),
        menuEntry('Find in page', 'search', () => { closePanel(false); showFind(); }, 'Ctrl+F'),
        menuEntry(state.fullScreen ? 'Exit full screen' : 'Full screen', 'screen', () => run('fullScreen'), 'F11'),
        menuEntry('Customize Relay', 'sliders', () => showPanel('settings')),
      menuEntry('Runtime customization', 'code', () => showPanel('customization')),
      ...renderContributedButtons('menu'),
      ]),
      section('Page size', zoom),
    );
  }

  function renderTabPanel() {
    const tab = state.tabs.find((record) => record.id === contextTabId);
    if (!tab) return empty('tab-top', 'Tab closed', 'Choose a tab to see its actions.');
    const actions = section(tab.title || 'New tab', list([
      menuEntry(tab.pinned ? 'Unpin tab' : 'Pin tab', 'pin', () => run('pinTab', { id: tab.id })),
      menuEntry(tab.muted ? 'Unmute tab' : 'Mute tab', tab.muted ? 'audio' : 'mute',
        () => run('muteTab', { id: tab.id })),
      menuEntry('Close tab', 'close', () => { closePanel(false); run('closeTab', { id: tab.id }); }),
    ]));
    const destinations = state.workspaces.filter(({ id }) => id !== state.activeWorkspaceId);
    if (!destinations.length) return stack(actions);

    const moves = destinations.map(({ id, name }) => {
      const button = menuEntry(name, 'folder', async () => {
        const moved = await run('moveTabToWorkspace', { tabId: tab.id, workspaceId: id });
        if (!moved || selectedPanel !== 'tab' || contextTabId !== tab.id) return;
        closePanel(false);
        const tabButton = tabStrip.querySelector('.active .tab-select');
        (tabButton || (sideTabs.hidden ? addTopTab : get('addSidebarTab'))).focus({ preventScroll: true });
      });
      button.classList.add('workspace-entry');
      return button;
    });
    return stack(actions, section('Move to workspace', list(moves)));
  }

  async function navigateForm(event, input, clear = false) {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) return;

    const submission = { input, query: value };
    searchSubmission = submission;
    const result = await request('navigate', { input: value });
    if (result?.value?.pendingSearch) return;
    if (searchSubmission === submission) searchSubmission = null;
    if (result) {
      if (clear) input.value = '';
      input.blur();
      address.value = activeTab()?.url || '';
    }
  }

  searchCancel.addEventListener('click', () => resolveSearchChooser());
  searchDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    resolveSearchChooser();
  });
  storeAction.addEventListener('click', () => {
    const listing = state?.storeListing;
    if (!listing) return;
    if (listing.installed) showPanel('extensions', storeAction);
    else installCurrentStoreListing(listing.id);
  });
  lastPassButton.addEventListener('click', async () => {
    const { x, y, width, height } = lastPassButton.getBoundingClientRect();
    openingLastPass = true;
    lastPassButton.disabled = true;
    try {
      await run('openExtension', { id: 'hdokiejnpimakedhajhdlcegeplioahd', anchor: { x, y, width, height } });
    } finally {
      openingLastPass = false;
      lastPassButton.disabled = !state?.lastPassAction?.enabled;
    }
  });
  workspaceCurrent.addEventListener('click', () => {
    if (state) switchWorkspace(nextWorkspace()?.id);
  });
  workspaceCurrent.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    showWorkspaceEditor('rename', workspaceCurrent);
  });
  for (const id of ['addWorkspace', 'addWorkspaceFooter']) {
    get(id).addEventListener('click', (event) => showWorkspaceEditor('create', event.currentTarget));
  }
  get('renameWorkspace').addEventListener('click', (event) => showWorkspaceEditor('rename', event.currentTarget));
  workspacePopover.addEventListener('beforetoggle', (event) => {
    if (event.newState !== 'closed') return;
    workspaceEditor?.trigger.removeAttribute('aria-expanded');
    workspaceEditor = null;
  });
  get('workspaceNameCancel').addEventListener('click', () => closeWorkspaceEditor(true));
  get('workspaceNameForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const editor = workspaceEditor;
    if (!editor || workspaceNameSubmit.disabled) return;
    const name = workspaceName.value.trim();
    workspaceNameSubmit.disabled = true;
    const saved = editor.mode === 'create'
      ? await run('createWorkspace', { name })
      : await run('renameWorkspace', { workspaceId: editor.workspaceId, name });
    if (workspaceEditor !== editor) return;
    workspaceNameSubmit.disabled = false;
    if (saved) closeWorkspaceEditor(true);
  });
  panelBody.addEventListener('scroll', positionWorkspacePopover, { passive: true });
  window.addEventListener('blur', () => closeWorkspaceEditor());
  get('addressForm').addEventListener('submit', (event) => navigateForm(event, address));
  get('startForm').addEventListener('submit', (event) => navigateForm(event, get('startSearch'), true));
  findBar.addEventListener('submit', (event) => {
    event.preventDefault();
    searchPage(true);
  });
  findQuery.addEventListener('input', () => {
    clearTimeout(findTimer);
    findTimer = setTimeout(searchPage, 110);
  });
  findQuery.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault();
      searchPage(true, false);
    }
  });

  document.addEventListener('click', (event) => {
    const target = event.target.closest('button');
    if (!target || target.disabled) return;
    const { panel: name, action, window: windowCommand, url, find } = target.dataset;
    if (name) togglePanel(name, target);
    if (windowCommand) run('window', { command: windowCommand });
    if (url) run('navigate', { input: url });
    if (action === 'newTab') createTab();
    else if (action) run(action);
    if (target.hasAttribute('data-panel-close')) closePanel();
    if (find === 'previous') searchPage(true, false);
    if (find === 'close') closeFind();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || searchDialog.open) return;
    if (workspaceEditor) {
      event.preventDefault();
      closeWorkspaceEditor(true);
    } else if (!findBar.hidden) closeFind();
    else if (selectedPanel) closePanel();
    else if (document.activeElement === address) {
      address.value = activeTab()?.url || '';
      address.blur();
    }
  });

  if (relay) {
    const resize = new ResizeObserver(scheduleViewport);
    resize.observe(page);
    resize.observe(workspaceFrame);
    new ResizeObserver(scrollActiveBreadcrumbIntoView).observe(workspaceBreadcrumbs);
    window.addEventListener('resize', scheduleViewport);
    let receivedState = false;
    relay.onState((update) => {
      receivedState = true;
      applyState(update);
    });
    relay.onCommand((command) => {
      if (!searchDialog.open) shortcuts.get(command)?.();
    });
    relay.onPanel?.((name) => {
      if (name === 'close') closePanel();
      else showPanel(name);
    });
    relay.onFind(({ activeMatchOrdinal, matches, finalUpdate }) => {
      if (findBar.hidden || !findQuery.value) return;
      if (matches > 0) findCount.textContent = activeMatchOrdinal + ' of ' + matches;
      else if (finalUpdate) findCount.textContent = 'No matches';
    });
    relay.getState().then((update) => {
      if (!receivedState) applyState(update);
    }).catch(() => showNotice('Relay could not load browser state.', true));
  }
})();
