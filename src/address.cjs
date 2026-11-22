const SEARCH_PROVIDERS = [
  { id: 'google', label: 'Google' },
  { id: 'duckduckgo', label: 'DuckDuckGo' },
  { id: 'bing', label: 'Bing' }
];

const SEARCH_ENGINES = {
  duckduckgo: 'https://duckduckgo.com/?q=',
  google: 'https://www.google.com/search?q=',
  bing: 'https://www.bing.com/search?q='
};

function webURL(value) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const parsed = new URL(value);
    if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password) return parsed;
  } catch {}
  return null;
}

function classifyAddress(value) {
  if (typeof value !== 'string') throw new Error('Enter an address or search term.');
  const input = value.trim();
  if (!input || input.length > 8192) throw new Error('Enter an address or search term up to 8192 characters.');
  if (/^https?:/i.test(input)) {
    const url = webURL(input);
    if (!url) throw new Error('Enter a valid HTTP or HTTPS address without credentials.');
    return { kind: 'url', url: url.href };
  }
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(input) || /^(?:file|javascript|data|chrome|relay|about|blob|mailto):/i.test(input)) {
    throw new Error('Relay opens HTTP and HTTPS addresses.');
  }
  const host = input.split(/[/?#]/)[0];
  const loopback = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(host);
  if (loopback || (!/\s/.test(input) && /^[^@\\/:]+\.[^@\\/:]+(?::\d+)?$/.test(host))) {
    const url = webURL((loopback ? 'http://' : 'https://') + input);
    if (url) return { kind: 'url', url: url.href };
  }
  return { kind: 'search', query: input };
}

function searchURL(query, engine) {
  const base = Object.hasOwn(SEARCH_ENGINES, engine) ? SEARCH_ENGINES[engine] : SEARCH_ENGINES.duckduckgo;
  return base + new URLSearchParams({ q: query }).toString().slice(2);
}

function resolveAddress(value, engine) {
  const address = classifyAddress(value);
  return address.kind === 'url' ? address.url : searchURL(address.query, engine);
}

module.exports = { classifyAddress, resolveAddress, searchURL, SEARCH_PROVIDERS, webURL };
