'use strict';

/**
 * Offline cache for the launcher web app.
 *
 * Registered as an https handler on the session, so every request the page makes
 * passes through here. Behaviour is stale-while-revalidate:
 *   - a cached response is returned immediately and refreshed in the background;
 *   - a miss is fetched, stored, and returned;
 *   - a miss while offline returns a friendly page for navigations, and a 504
 *     for sub-resources (which makes the app fall back to its own error paths).
 *
 * Only first-party hosts are cached: the app shell on launcher.skn.net.cn and the
 * device definitions / i18n / API it loads from launcher.keychron.cn (the SKN
 * launcher resolves to the platform's "other" profile, whose data host is
 * keychron.cn). Analytics hosts are never cached.
 */

const { net } = require('electron');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const CACHEABLE_HOSTS = [
  'launcher.skn.net.cn',
  'launcher.keychron.cn',
  'launcher.keychron.com',
];

const DENY_HOSTS = [
  'erpapik.keychron.cn',
  'statistic.keychron.com',
  'www.googletagmanager.com',
  'www.google-analytics.com',
  'google-analytics.com',
];

const CACHEABLE_CONTENT_TYPE = /^(text\/|application\/(javascript|json|xml|x-javascript|x-www-form-urlencoded)|image\/|font\/)/i;
const MAX_ENTRY_BYTES = 12 * 1024 * 1024;

// Test hook: pretend the network is down so offline behaviour can be verified
// deterministically without unplugging anything.
const FORCE_OFFLINE = process.env.SKN_FORCE_OFFLINE === '1';

class WebCache {
  constructor(dir) {
    this.dir = dir;
    this.stats = { hits: 0, misses: 0, stored: 0, offlineFallbacks: 0 };
    this.offlinePage = null;
    this.inflight = new Map();
    this.storeInflight = new Map();
    this.tmpSeq = 0;
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
  }

  setOfflinePage(file) {
    this.offlinePage = file;
  }

  keyFor(url) {
    return crypto.createHash('sha1').update(url).digest('hex');
  }

  pathsFor(url) {
    const key = this.keyFor(url);
    return { body: path.join(this.dir, `${key}.body`), meta: path.join(this.dir, `${key}.meta.json`) };
  }

  isCacheable(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (u.protocol !== 'https:') return false;
    if (DENY_HOSTS.includes(u.hostname)) return false;
    return CACHEABLE_HOSTS.includes(u.hostname);
  }

  async read(url) {
    const { body, meta } = this.pathsFor(url);
    try {
      const [rawMeta, data] = await Promise.all([fsp.readFile(meta, 'utf8'), fsp.readFile(body)]);
      const parsed = JSON.parse(rawMeta);
      const headers = new Headers(parsed.headers || {});
      headers.set('x-skn-cache', 'HIT');
      return new Response(data, { status: parsed.status || 200, statusText: parsed.statusText || 'OK', headers });
    } catch {
      return null;
    }
  }

  /**
   * Store a response body. Concurrent stores of the same URL are de-duplicated:
   * the page often requests one asset several times at once, and two writers
   * sharing a temp filename would race each other on rename.
   */
  store(url, response) {
    const existing = this.storeInflight.get(url);
    if (existing) return existing;
    const task = this.storeOnce(url, response)
      .catch((err) => {
        console.warn('[cache] store failed:', err.message);
      })
      .finally(() => this.storeInflight.delete(url));
    this.storeInflight.set(url, task);
    return task;
  }

  async storeOnce(url, response) {
    const contentType = response.headers.get('content-type') || '';
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared && declared > MAX_ENTRY_BYTES) return;
    if (contentType && !CACHEABLE_CONTENT_TYPE.test(contentType)) return;

    const buf = Buffer.from(await response.arrayBuffer());
    if (!buf.length || buf.length > MAX_ENTRY_BYTES) return;

    const headers = {};
    for (const name of ['content-type', 'content-encoding', 'cache-control', 'etag', 'last-modified', 'content-language']) {
      const v = response.headers.get(name);
      if (v) headers[name] = v;
    }

    const { body, meta } = this.pathsFor(url);
    const tmp = `${body}.${process.pid}.${++this.tmpSeq}.tmp`;
    try {
      await fsp.writeFile(tmp, buf);
      await fsp.rename(tmp, body);
      await fsp.writeFile(
        meta,
        JSON.stringify({
          url,
          status: response.status,
          statusText: response.statusText || 'OK',
          headers,
          size: buf.length,
          storedAt: Date.now(),
        }),
        'utf8'
      );
      this.stats.stored += 1;
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  /** Refresh a cached entry in the background; failures are ignored. */
  revalidate(url) {
    if (FORCE_OFFLINE) return;
    if (this.inflight.has(url)) return;
    const task = net
      .fetch(url, { bypassCustomProtocolHandlers: true })
      .then((res) => (res.ok ? this.store(url, res) : undefined))
      .catch(() => undefined)
      .finally(() => this.inflight.delete(url));
    this.inflight.set(url, task);
  }

  async offlineResponse(request) {
    this.stats.offlineFallbacks += 1;
    const isNavigation = request.destination === 'document' || (request.headers.get('accept') || '').includes('text/html');
    if (isNavigation && this.offlinePage) {
      try {
        const html = await fsp.readFile(this.offlinePage);
        return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      } catch {
        /* fall through */
      }
    }
    return new Response('', { status: 504, statusText: 'Offline and not cached' });
  }

  /**
   * Forward a request untouched. Method, headers and body have to be copied
   * explicitly: forwarding only the URL would silently turn a POST into a GET.
   */
  async passthrough(request) {
    const init = {
      method: request.method,
      headers: request.headers,
      bypassCustomProtocolHandlers: true,
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      try {
        init.body = Buffer.from(await request.arrayBuffer());
      } catch {
        /* nothing to forward */
      }
    }
    return net.fetch(request.url, init);
  }

  async handle(request) {
    const url = request.url;

    if (request.method !== 'GET' || !this.isCacheable(url)) return this.passthrough(request);

    const cached = await this.read(url);
    if (cached) {
      this.stats.hits += 1;
      this.revalidate(url);
      return cached;
    }

    this.stats.misses += 1;
    if (FORCE_OFFLINE) return this.offlineResponse(request);
    try {
      const res = await net.fetch(url, { bypassCustomProtocolHandlers: true });
      if (res.ok) await this.store(url, res.clone());
      return res;
    } catch {
      return this.offlineResponse(request);
    }
  }

  /** Drop everything (used by “force refresh”). */
  async clear() {
    try {
      const entries = await fsp.readdir(this.dir);
      await Promise.all(
        entries.map((e) => fsp.rm(path.join(this.dir, e), { force: true, recursive: true }).catch(() => undefined))
      );
    } catch {
      /* nothing to clear */
    }
  }

  async summary() {
    let bytes = 0;
    let files = 0;
    try {
      for (const e of await fsp.readdir(this.dir)) {
        if (!e.endsWith('.body')) continue;
        files += 1;
        try {
          bytes += (await fsp.stat(path.join(this.dir, e))).size;
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    return { ...this.stats, entries: files, megabytes: +(bytes / 1048576).toFixed(2) };
  }
}

module.exports = { WebCache, CACHEABLE_HOSTS };