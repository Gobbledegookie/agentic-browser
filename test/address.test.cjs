'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { classifyAddress, resolveAddress, searchURL, SEARCH_PROVIDERS } = require('../src/address.cjs');

test('classifies typed URLs, hostnames and loopback addresses as navigation', () => {
  const addresses = [
    [' https://EXAMPLE.org/path?q=1#top ', 'https://example.org/path?q=1#top'],
    ['example.org/path', 'https://example.org/path'],
    ['localhost:8080/health', 'http://localhost:8080/health'],
    ['127.0.0.1:3000', 'http://127.0.0.1:3000/'],
    ['[::1]:3000', 'http://[::1]:3000/']
  ];

  for (const [input, url] of addresses) {
    assert.deepEqual(classifyAddress(input), { kind: 'url', url });
    assert.equal(resolveAddress(input, 'google'), url);
  }
});

test('classifies search text independently from provider selection', () => {
  const query = 'Relay browser & tabs';
  assert.deepEqual(classifyAddress('  ' + query + '  '), { kind: 'search', query });
  assert.deepEqual(classifyAddress('example.org documentation'), { kind: 'search', query: 'example.org documentation' });
  assert.deepEqual(SEARCH_PROVIDERS, [
    { id: 'google', label: 'Google' },
    { id: 'duckduckgo', label: 'DuckDuckGo' },
    { id: 'bing', label: 'Bing' }
  ]);

  assert.equal(searchURL(query, 'google'), 'https://www.google.com/search?q=Relay+browser+%26+tabs');
  assert.equal(searchURL(query, 'duckduckgo'), 'https://duckduckgo.com/?q=Relay+browser+%26+tabs');
  assert.equal(searchURL(query, 'unrecognized'), searchURL(query, 'duckduckgo'));
  assert.equal(resolveAddress('  ' + query + '  ', 'bing'), 'https://www.bing.com/search?q=Relay+browser+%26+tabs');
});

test('rejects unsupported schemes and malformed input before searching', () => {
  for (const input of ['file:///C:/private', 'javascript:alert(1)', 'ftp://example.org', 'chrome://extensions', 'mailto:test@example.org']) {
    assert.throws(() => classifyAddress(input), { message: 'Relay opens HTTP and HTTPS addresses.' });
  }
  assert.throws(() => classifyAddress('https://user:password@example.org'), { message: 'Enter a valid HTTP or HTTPS address without credentials.' });
  assert.throws(() => classifyAddress('https://'), { message: 'Enter a valid HTTP or HTTPS address without credentials.' });
  assert.throws(() => classifyAddress(null), { message: 'Enter an address or search term.' });
  for (const input of ['   ', 'a'.repeat(8193)]) {
    assert.throws(() => classifyAddress(input), { message: 'Enter an address or search term up to 8192 characters.' });
  }
});
