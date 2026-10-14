/**
 * Integration test for src/cache.js, run outside Electron.
 *
 * The `electron` module is stubbed so the cache can be exercised with plain Node,
 * against the real launcher site. This proves the stale-while-revalidate logic,
 * the POST/body passthrough and the offline fallbacks without needing a GUI.
 *
 *   node tools/cache-test.mjs online  <cacheDir>
 *   node tools/cache-test.mjs offline <cacheDir>     (run with SKN_FORCE_OFFLINE=1)
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const mode = process.argv[2] || 'online';
const cacheDir = process.argv[3];
if (!cacheDir) throw new Error('usage: cache-test.mjs <online|offline> <cacheDir>');

// ---- stub electron.net so cache.js can run under plain Node -----------------
const netCalls = [];
const electronStub = {
  net: {
    async fetch(url, init = {}) {
      const method = init.method || 'GET';
      netCalls.push({ url, method, bypass: init.bypassCustomProtocolHandlers === true });
      const headers = {};
      if (init.headers && typeof init.headers.entries === 'function') {
        for (const [k, v] of init.headers.entries()) headers[k] = v;
      }
      const res = await fetch(url, { method, headers, body: init.body, redirect: 'follow' });
      return res;
    },
  },
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return electronStub;
  return originalLoad.call(this, request, ...rest);
};
const { WebCache } = require('../src/cache.js');
Module._load = originalLoad;

// ---- helpers ---------------------------------------------------------------
let passed = 0;
let failed = 0;

function check(name, condition, extra = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

const request = (url, { method = 'GET', destination = 'document', headers = {}, body = null } = {}) => ({
  url,
  method,
  destination,
  headers: new Headers(headers),
  arrayBuffer: async () => (body ? new TextEncoder().encode(body).buffer : new ArrayBuffer(0)),
});

const cache = new WebCache(cacheDir);
await cache.init();
cache.setOfflinePage(path.resolve('src/offline.html'));

const SHELL = 'https://launcher.skn.net.cn/';

if (mode === 'online') {
  console.log('online: first fetch stores the app shell');
  const first = await cache.handle(request(SHELL));
  check('shell fetch succeeds', first.status === 200, `(status=${first.status})`);
  const firstBody = await first.text();
  check('shell body is the real app HTML', /<app-root>/.test(firstBody) && firstBody.length > 1000, `(len=${firstBody.length})`);
  check('first response was not a cache hit', first.headers.get('x-skn-cache') !== 'HIT');
  check('something was written to the cache', cache.stats.stored >= 1, `(stored=${cache.stats.stored})`);

  console.log('online: second fetch is served from cache');
  const second = await cache.handle(request(SHELL));
  check('second response is a cache HIT', second.headers.get('x-skn-cache') === 'HIT');
  check('cached body matches the app shell', /<app-root>/.test(await second.text()));

  console.log('online: second first-party host is cacheable');
  const kc = await cache.handle(request('https://launcher.keychron.cn/'));
  check('keychron.cn host is cached', cache.isCacheable('https://launcher.keychron.cn/static/x.json') === true);

  console.log('online: POST keeps its method and body');
  netCalls.length = 0;
  const postRes = await cache.handle(
    request('https://launcher.skn.net.cn/vapi/anything', { method: 'POST', body: '{"hello":"world"}' })
  );
  check('POST was forwarded as POST', netCalls.some((c) => c.method === 'POST'), JSON.stringify(netCalls));
  check('POST used bypassCustomProtocolHandlers', netCalls.every((c) => c.bypass === true));
  check('POST got a response', postRes.status > 0);

  console.log('online: non-cacheable hosts are passed through, never stored');
  const before = cache.stats.stored;
  await cache.handle(request('https://erpapik.keychron.cn/launcher/vapi/ai-question-statistics'));
  await cache.handle(request('https://example.com/'));
  check('analytics + third-party hosts are not cacheable',
    cache.isCacheable('https://erpapik.keychron.cn/x') === false && cache.isCacheable('https://example.com/x') === false);
  check('nothing extra was stored', cache.stats.stored === before, `(stored=${cache.stats.stored})`);

  await cache.handle(request('https://launcher.skn.net.cn/styles.92ffbc2b429acee3.css', { destination: 'style', headers: { accept: 'text/css' } }));
  const summary = await cache.summary();
  console.log('  cache summary:', JSON.stringify(summary));
  check('cache holds real entries', summary.entries >= 2, `(entries=${summary.entries})`);

  // Regression: the packaged app hit "rename .tmp -> .body ENOENT" because two
  // concurrent stores of one URL shared a temp filename.
  console.log('online: concurrent duplicate requests must not collide');
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...a) => warnings.push(a.map(String).join(' '));
  const dupUrl = 'https://launcher.skn.net.cn/runtime.618c62daa700bc01.js';
  const dupReq = () => request(dupUrl, { destination: 'script', headers: { accept: '*/*' } });
  await Promise.all([cache.handle(dupReq()), cache.handle(dupReq()), cache.handle(dupReq())]);
  console.warn = originalWarn;
  check('no store failures under concurrent duplicate requests',
    !warnings.some((w) => w.includes('store failed')), warnings.join(' | '));
  const dupAgain = await cache.handle(dupReq());
  check('entry readable after concurrent stores', dupAgain.headers.get('x-skn-cache') === 'HIT');
  const leftovers = (await fs.promises.readdir(cacheDir)).filter((f) => f.endsWith('.tmp'));
  check('no stray temp files left behind', leftovers.length === 0, leftovers.join(','));
} else {
  console.log('offline: cached shell is still served');
  netCalls.length = 0;
  const cached = await cache.handle(request(SHELL));
  check('cached shell served offline', cached.status === 200 && cached.headers.get('x-skn-cache') === 'HIT');
  check('cached shell body intact', /<app-root>/.test(await cached.text()));
  check('no network call was attempted for the cached shell', netCalls.length === 0, JSON.stringify(netCalls));

  console.log('offline: uncached navigation shows the offline page');
  const miss = await cache.handle(request('https://launcher.skn.net.cn/some-new-page'));
  const missBody = await miss.text();
  check('offline page served for navigation', miss.status === 200 && /离线/.test(missBody), `(status=${miss.status})`);
  check('offline page is html', /text\/html/.test(miss.headers.get('content-type') || ''));

  console.log('offline: uncached sub-resource is a clean 504');
  const sub = await cache.handle(request('https://launcher.skn.net.cn/main.newhash.js', { destination: 'script', headers: { accept: '*/*' } }));
  check('sub-resource miss returns 504', sub.status === 504, `(status=${sub.status})`);
  check('no network call attempted', netCalls.length === 0, JSON.stringify(netCalls));
  check('offline fallbacks were counted', cache.stats.offlineFallbacks >= 2, `(${cache.stats.offlineFallbacks})`);
}

console.log(`\n[${mode}] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);