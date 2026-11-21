const { validateBrowserCommand } = require('./commands.cjs');

const HIDEABLE_CONTROLS = new Set([
  'address', 'back', 'forward', 'reload', 'home', 'bookmark', 'extensions', 'downloads', 'menu', 'bookmarksBar',
  'topNewTab', 'sidebarNewTab', 'newTabShortcuts', 'customizeShortcut'
]);
const BUTTON_LOCATIONS = new Set(['toolbar', 'newTab', 'sidebar', 'menu']);
const MODIFIERS = ['Ctrl', 'Alt', 'Shift'];
const MAX_CUSTOMIZATION_BYTES = 200 * 1024;

function defaultCustomization() {
  return { css: '', newTabHtml: '', hiddenControls: [], buttons: [], shortcuts: [] };
}

function requireShape(value, fields, subject) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${subject} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) throw new TypeError(`Unknown ${subject} field: ${key}.`);
  }
}

function text(value, limit, subject) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > limit) {
    throw new TypeError(`${subject} must be text of at most ${limit} bytes.`);
  }
  return value;
}

function list(value, limit, subject) {
  if (!Array.isArray(value) || value.length > limit) throw new TypeError(`${subject} must be an array of at most ${limit} entries.`);
  return value;
}

function unique(entries, identify, subject) {
  if (new Set(entries.map(identify)).size !== entries.length) throw new TypeError(`${subject} must be unique.`);
  return entries;
}

function controlList(value) {
  const controls = list(value, HIDEABLE_CONTROLS.size, 'Hidden controls');
  if (controls.some((control) => !HIDEABLE_CONTROLS.has(control))) throw new TypeError('Choose a hideable browser control.');
  return unique(controls.slice(), (control) => control, 'Hidden controls');
}

function id(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(value)) throw new TypeError('Use a lowercase contribution ID with letters, numbers, or hyphens.');
  return value;
}

function commandStep(step) {
  requireShape(step, ['command', 'arguments'], 'command step');
  return { command: step.command, arguments: validateBrowserCommand(step.command, step.arguments) };
}

function commandBinding(value) {
  if (!Object.hasOwn(value, 'steps')) return commandStep({ command: value.command, arguments: value.arguments });
  if (Object.hasOwn(value, 'command') || Object.hasOwn(value, 'arguments')) throw new TypeError('Choose one command or a sequence of steps.');
  const steps = list(value.steps, 12, 'Command steps');
  if (!steps.length) throw new TypeError('Add at least one command step.');
  return { steps: steps.map(commandStep) };
}

function buttons(value) {
  const entries = list(value, 24, 'Buttons').map((entry) => {
    requireShape(entry, ['id', 'label', 'location', 'command', 'arguments', 'steps'], 'button');
    const label = text(entry.label, 100, 'Button label').trim();
    if (!label || !BUTTON_LOCATIONS.has(entry.location)) throw new TypeError('Choose a label and a browser location for the button.');
    return { id: id(entry.id), label, location: entry.location, ...commandBinding(entry) };
  });
  return unique(entries, (entry) => entry.id, 'Button IDs');
}

function normalizeAccelerator(value) {
  const parts = text(value, 48, 'Shortcut accelerator').toLowerCase().split('+').map((part) => part.trim());
  const key = parts.pop();
  const modifiers = MODIFIERS.filter((modifier) => parts.includes(modifier.toLowerCase()));
  if (modifiers.length !== parts.length || /^(?:f11|escape)$/.test(key) || !/^(?:[a-z0-9]|f(?:[1-9]|1[02])|arrow(?:up|down|left|right)|home|end|page(?:up|down)|space|tab)$/.test(key)) {
    throw new TypeError('Use a shortcut such as Ctrl+Shift+K, Alt+ArrowUp, or F8.');
  }
  if (!modifiers.includes('Ctrl') && !modifiers.includes('Alt') && !/^f\d+$/.test(key)) {
    throw new TypeError('Add Ctrl or Alt to shortcuts for typing or navigation keys.');
  }
  if (modifiers.join('+') === 'Alt' && key === 'f4') throw new TypeError('Alt+F4 is reserved by Windows.');
  const displayKey = { arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', pageup: 'PageUp', pagedown: 'PageDown' }[key]
    ?? `${key[0].toUpperCase()}${key.slice(1)}`;
  return [...modifiers, displayKey].join('+');
}

function shortcuts(value) {
  const entries = list(value, 32, 'Shortcuts').map((entry) => {
    requireShape(entry, ['id', 'accelerator', 'command', 'arguments', 'steps'], 'shortcut');
    return { id: id(entry.id), accelerator: normalizeAccelerator(entry.accelerator), ...commandBinding(entry) };
  });
  unique(entries, (entry) => entry.id, 'Shortcut IDs');
  return unique(entries, (entry) => entry.accelerator, 'Shortcut accelerators');
}

function updateCustomization(current, patch) {
  const validators = {
    css: (value) => text(value, 64 * 1024, 'CSS'),
    newTabHtml: (value) => text(value, 96 * 1024, 'New tab HTML'),
    hiddenControls: controlList,
    buttons,
    shortcuts
  };
  requireShape(patch, Object.keys(validators), 'customization');
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) next[key] = validators[key](value);
  if (Buffer.byteLength(JSON.stringify(next)) > MAX_CUSTOMIZATION_BYTES) throw new RangeError('The customization document exceeds 200 KiB.');
  return next;
}

function keyboardAccelerator(input) {
  const key = input.key === ' ' ? 'Space' : input.key;
  const modifiers = [input.control && 'Ctrl', input.alt && 'Alt', input.shift && 'Shift'].filter(Boolean);
  return [...modifiers, key].join('+').toLowerCase();
}

module.exports = { defaultCustomization, updateCustomization, keyboardAccelerator };
