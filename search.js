// Search providers: run a LinkedIn-scoped query and return company pages.
//
//   SERPER_API_KEY set   Google results via serper.dev (accurate, supports after:)
//   otherwise            Brave Search HTML (no key, one page, ignores after:, rate-limits bursts)
//
// Serper's free tier allows at most 10 results per request ("Query pattern not
// allowed for free accounts" otherwise) and returns no LinkedIn pages beyond
// page 1, so the defaults are num=10, one page. On a paid plan set
// SERPER_NUM (up to 100) and SERPER_PAGES. A Serper rejection falls back to
// Brave rather than failing.

const { execFile } = require('child_process');

const SERPER_API_KEY = process.env.SERPER_API_KEY || '';
const SERPER_NUM = Math.min(100, Number(process.env.SERPER_NUM) || 10); // free tier caps at 10
const SERPER_PAGES = Number(process.env.SERPER_PAGES) || 1;
const BRAVE_PAGES = Number(process.env.BRAVE_PAGES) || 1;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map(); // query -> { at, items }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const provider = () => (SERPER_API_KEY ? 'serper' : 'brave');
const providerFor = () => provider();

// Returns { provider, query, count, results: [{name, slug, url, snippet}], notes, rate_limited }
async function search(query) {
  let p = providerFor(query);
  const notes = [];
  let raw;
  if (p === 'serper') {
    try { raw = await searchSerper(query); }
    catch (e) {
      if (!/not allowed/i.test(e.message)) throw e;
      notes.push('Serper rejected this query pattern (' + e.message.replace(/^Serper \d+: /, '') + '); fell back to Brave Search.');
      p = 'brave';
    }
  }
  if (p === 'brave') raw = await searchBrave(query);
  const results = dedupe(raw.items.map(toCompany).filter(Boolean));
  if (p === 'brave') {
    notes.push('Results come from Brave Search because no SERPER_API_KEY is set: one page only, and the after: date filter is ignored, so older companies appear too. Add a key from serper.dev to .env for Google results.');
  } else if (SERPER_NUM <= 10 && SERPER_PAGES <= 1) {
    notes.push('Google via Serper, 10 results per query (the free tier limit). The discovery agent widens coverage by running more queries.');
  }
  if (raw.rate_limited) notes.push('The search engine rate-limited this query; results may be incomplete. Wait a minute and try again.');
  return { provider: p, query, count: results.length, results, notes, rate_limited: !!raw.rate_limited };
}

// Serper: Google results as JSON. https://serper.dev
async function searchSerper(query) {
  const out = [];
  for (let page = 1; page <= SERPER_PAGES; page++) {
    const r = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: SERPER_NUM, page }),
    });
    if (!r.ok) { let msg = await r.text(); try { msg = JSON.parse(msg).message || msg; } catch (_) {} throw new Error(`Serper ${r.status}: ${msg}`); }
    const data = await r.json();
    const organic = data.organic || [];
    for (const o of organic) out.push({ title: o.title, url: o.link, snippet: o.snippet });
    if (organic.length < SERPER_NUM) break;
  }
  return { items: out };
}

// Brave Search HTML results, no key needed. Supports site: but not after:.
async function searchBrave(query) {
  const q = query.replace(/\s*after:\S+/g, '').trim();
  const hit = cache.get(q);
  if (hit && Date.now() - hit.at < CACHE_MS) return { items: hit.items };

  const out = [];
  let rateLimited = false;
  for (let offset = 0; offset < BRAVE_PAGES; offset++) {
    if (offset > 0) await sleep(3000);
    const params = new URLSearchParams({ q, source: 'web', offset: String(offset), spellcheck: '0' });
    const html = await fetchBrave('https://search.brave.com/search?' + params);
    if (html === null) { rateLimited = true; break; }
    const items = parseBrave(html);
    if (items.length === 0) break;
    out.push(...items);
    if (items.length < 10) break;
  }
  if (out.length) {
    for (const [k, v] of cache) if (Date.now() - v.at > CACHE_MS) cache.delete(k); // evict expired on insert
    if (cache.size >= 200) cache.delete(cache.keys().next().value); // and cap the size
    cache.set(q, { at: Date.now(), items: out });
  }
  return { items: out, rate_limited: rateLimited };
}

// Brave refuses Node's built-in fetch (client fingerprinting) but serves curl.
function fetchBrave(url, attempt = 0) {
  return new Promise((resolve, reject) => {
    execFile('curl', [
      '-s', '--max-time', '20', '-w', '\n%{http_code}',
      '-A', UA,
      '-H', 'Accept: text/html,application/xhtml+xml',
      '-H', 'Accept-Language: en-US,en;q=0.9',
      url,
    ], { maxBuffer: 8 * 1024 * 1024 }, async (err, stdout) => {
      if (err) return reject(new Error('curl failed: ' + err.message));
      const i = stdout.lastIndexOf('\n');
      const status = Number(stdout.slice(i + 1));
      const body = stdout.slice(0, i);
      if (status === 429) {
        if (attempt >= 1) return resolve(null);
        await sleep(15000);
        return fetchBrave(url, attempt + 1).then(resolve, reject);
      }
      if (status !== 200) return reject(new Error(`Brave Search ${status}`));
      resolve(body);
    });
  });
}

function parseBrave(html) {
  const items = [];
  const blocks = html.split(/<div class="snippet [^"]*"[^>]*data-type="web"/).slice(1);
  for (const b of blocks) {
    const url = (b.match(/<a href="([^"]+)"/) || [])[1];
    const title = (b.match(/class="title [^"]*"[^>]*title="([^"]*)"/) || [])[1] || '';
    const snippet = (b.match(/class="content [^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '';
    if (url) items.push({ url: decode(url), title: decode(title), snippet: strip(snippet) });
  }
  return items;
}

// ------------------------------------------------------------ normalisation

const COMPANY_RE = /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/company\/([^/?#]+)/i;

function toCompany(item) {
  const m = COMPANY_RE.exec(item.url || '');
  if (!m) return null;
  const slug = m[1].toLowerCase();
  const name = strip(item.title || '')
    .replace(/\s*[|\-–]\s*LinkedIn\s*$/i, '')
    .replace(/^LinkedIn\s*[|\-–]\s*/i, '')
    .trim() || slug;
  return {
    name,
    slug,
    url: item.url.split('?')[0],
    snippet: strip(item.snippet || '')
      .replace(/^(?:[A-Z][a-z]+ \d{1,2}, \d{4}|\d+ (?:days?|weeks?|months?) ago) - /, '')
      .replace(/^.*? \| \d[\d,.]*\s*(?:followers on|volgers op) LinkedIn\.\s*/i, ''),
  };
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((c) => (seen.has(c.slug) ? false : seen.add(c.slug)));
}

function strip(html) {
  return decode(String(html).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function decode(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

module.exports = { search, provider, providerFor, dedupe };
