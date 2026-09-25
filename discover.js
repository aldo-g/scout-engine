// Discovery agent: widens the search beyond the one query the user typed.
//
// The model gets one tool, search_linkedin_companies, plus the seed query and
// a query budget. It decides which variants to run (translations, adjacent
// terms, neighbouring cities, region names), sees how many new companies each
// one adds, and stops when queries stop paying off or the budget is spent.
// Every tool call is reported through the `emit` callback so the page can
// show the trace as it happens.

const fs = require('fs');
const path = require('path');
const { search, providerFor } = require('./search');

const MODEL = 'claude-opus-5';
const DEFAULT_BUDGET = Number(process.env.DISCOVER_BUDGET) || (process.env.SERPER_API_KEY ? 12 : 8);
const gapFor = (q) => (providerFor(q) === 'brave' ? 10000 : 300); // Brave allows only a few requests a minute
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let client = null;
function getClient() {
  if (client) return client;
  const hasCreds = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || fs.existsSync(path.join(process.env.HOME || '', '.config', 'anthropic'));
  if (!hasCreds) return null;
  const mod = require('@anthropic-ai/sdk');
  client = new (mod.default || mod)();
  return client;
}

const SYSTEM = `You are the discovery agent for a startup scouting tool. The user wants every early-stage company in a sector and place that has a LinkedIn company page. One query never finds them all: pages are written in the local language, use adjacent vocabulary, and name nearby towns or the region instead of the city.

You have one tool, search_linkedin_companies. Every query must keep the site: operator on a LinkedIn company subdomain, for example site:nl.linkedin.com/company. Keep the after: date filter the user chose. Put multi-word phrases in double quotes.

If the user gave a description, suggested searches or notes, they come first: their vocabulary and places outrank your own guesses, and their suggested searches should run before your variants. Then plan variants along these lines, most promising first:
- the seed query as given;
- the sector in the local language(s) of the country, and common spellings;
- adjacent or narrower terms people actually put in company descriptions (for "circular economy": circulair, recycling, reuse, upcycling, refurbished, waste-to-value, materials passport, sustainable packaging, and so on);
- the region or province and two or three neighbouring cities instead of the city;
- generic startup words combined with the sector (startup, scale-up, platform, software, app) when the plain sector query is dominated by institutions;
- the neighbouring country subdomain only if the place sits on a border.

Read every result: it tells you how many companies were found and how many were new. Stop when two queries in a row add fewer than two new companies, when the tool reports rate limiting, or when the budget is spent. Do not repeat a query. Run one query at a time.

When you stop, reply with a short summary in plain sentences, no markdown, no bullet points, no bold: how many queries you ran, which ones paid off, why you stopped, and what a human could still try.`;

// Phase 1: the agent plans its key terms and queries before anything runs.
const GROUPS = ['seed', 'local language', 'adjacent term', 'nearby place', 'startup framing', 'user suggestion'];

function planSchema() {
  const { z } = require('zod');
  return z.object({
    items: z.array(z.object({
      term: z.string().describe('The key term or phrase this query is built around, two to four words, as shown to the user'),
      query: z.string().describe('The full query, keeping the site: operator, the size clause and the after: filter exactly as in the seed'),
      why: z.string().describe('One short clause: what this is meant to catch'),
      group: z.enum(GROUPS.slice(1)),
      priority: z.number().int().min(1).describe('1 = run first'),
    })).min(3).max(11),
  });
}

async function plan(cl, { query, sector, location, country, since, sizeClause, brief, count }) {
  const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
  const res = await cl.messages.parse({
    model: MODEL,
    max_tokens: 3000,
    output_config: { effort: 'medium', format: zodOutputFormat(planSchema()) },
    system: SYSTEM,
    messages: [{ role: 'user', content: [
      `Seed query (already run): ${query}`,
      `Sector: ${sector || '(not given)'}; place: ${location || '(not given)'}; country subdomain: ${country ? country + '.linkedin.com' : 'linkedin.com (any)'}; since: ${since || '(none)'}.`,
      sizeClause ? `Company-size clause to keep verbatim in every query: ${sizeClause}` : '',
      brief && brief.description ? `Brief from the user: ${brief.description}` : '',
      `Plan the ${count} queries you would run next, best first. Give each a short key term for display, the full query, why, a group and a priority. Do not include the seed query itself.`,
    ].filter(Boolean).join('\n') }],
  });
  const items = (res.parsed_output && res.parsed_output.items) || [];
  return items
    .sort((a, b) => a.priority - b.priority)
    .slice(0, count)
    .map((it, i) => ({ ...it, priority: i + 2, query: fixQuery(it.query, { query, sizeClause, since }) }));
}

// Make sure a planned query keeps the scaffolding the user chose.
// A display term for an agent-written query: the first quoted phrase or OR group.
function shortTerm(q) {
  const body = q.replace(/site:\S+/, '').replace(/\(("[^"]*\s(?:employees|medewerkers|Mitarbeiter|employés|ansatte|anställda)"(?:\s+OR\s+)?)+\)/i, '').replace(/after:\S+/, '');
  const m = body.match(/\(([^)]+)\)/) || body.match(/"([^"]+)"/);
  return (m ? m[1] : body).replace(/"/g, '').replace(/\s+OR\s+/g, ' / ').trim().slice(0, 40) || q.slice(0, 40);
}

function fixQuery(q, { query: seed, sizeClause, since }) {
  q = q.trim();
  if (!/site:[a-z]{0,3}\.?linkedin\.com\/company/i.test(q)) {
    const site = (seed.match(/site:\S+/) || ['site:linkedin.com/company'])[0];
    q = site + ' ' + q;
  }
  if (sizeClause && q.indexOf(sizeClause) === -1) q = q.replace(/\s*after:\S+/, '') + ' ' + sizeClause + (since ? ' after:' + since : '');
  else if (since && !/after:\S+/.test(q)) q += ' after:' + since;
  return q.replace(/\s+/g, ' ').trim();
}

// Runs the agent. emit(event) is called for every trace event; resolves with
// { companies, queries, summary, provider, notes }.
async function discover({ query, sector, location, country, since, budget = DEFAULT_BUDGET, sizeClause = '', brief = {} }, emit = () => {}) {
  const cl = getClient();
  const found = new Map(); // slug -> company with sources[]
  const queries = [];
  const notes = new Set();
  let rateLimited = false;

  async function runQuery(q, why, extra = {}) {
    const t0 = Date.now();
    const r = await search(q);
    r.notes.forEach((n) => notes.add(n));
    let added = 0;
    for (const c of r.results) {
      const ex = found.get(c.slug);
      if (ex) { if (!ex.sources.includes(q)) ex.sources.push(q); }
      else { found.set(c.slug, { ...c, sources: [q] }); added++; }
    }
    if (r.rate_limited) rateLimited = true;
    const rec = { query: q, why: why || '', found: r.count, added, total: found.size, ms: Date.now() - t0, rate_limited: !!r.rate_limited };
    queries.push(rec);
    emit({ type: 'query', ...rec, ...extra, examples: r.results.filter((c) => found.get(c.slug).sources.length === 1 && found.get(c.slug).sources[0] === q).slice(0, 4).map((c) => c.name) });
    return rec;
  }

  const started = new Set([query.toLowerCase()]); // every query that has begun, planned or adaptive

  // Seed query always runs first, agent or not.
  await runQuery(query, 'Seed query as typed', { plan_index: 0 });

  if (!cl) {
    emit({ type: 'note', text: 'No ANTHROPIC_API_KEY set, so only the seed query ran.' });
    return finish('Only the seed query ran: no model key is set.');
  }

  // Phase 1: plan. The seed is item 0; the plan fills most of the budget and
  // leaves a couple of queries for the agent to adapt with afterwards.
  const planCount = Math.max(3, Math.min(11, budget - 3));
  let planned = [];
  try {
    planned = await plan(cl, { query, sector, location, country, since, sizeClause, brief, count: planCount });
  } catch (e) {
    emit({ type: 'note', text: 'Planning failed (' + e.message + '); the agent will improvise instead.' });
  }
  const seedItem = { term: sector || 'seed query', query, why: 'Seed query as typed', group: 'seed', priority: 1 };
  emit({ type: 'plan', items: [seedItem, ...planned] });

  // Phase 2: run the plan in priority order. Stop only on rate limiting.
  let used = 1;
  for (let i = 0; i < planned.length; i++) {
    const it = planned[i];
    if (started.has(it.query.toLowerCase())) { emit({ type: 'skip', plan_index: i + 1, reason: 'duplicate of an earlier query' }); continue; }
    started.add(it.query.toLowerCase());
    await sleep(gapFor(it.query));
    used++;
    const rec = await runQuery(it.query, it.why, { plan_index: i + 1, group: it.group, term: it.term });
    if (rec.rate_limited) { emit({ type: 'note', text: 'Search engine rate-limited the run; stopping the plan here.' }); return finish('Stopped early: the search engine rate-limited the run after ' + queries.length + ' queries.'); }
  }
  if (used >= budget) return finish(`Ran the ${queries.length}-query plan; budget spent.`);

  // Phase 3: let the agent adapt with whatever budget is left.
  let nextIndex = planned.length + 1; // display slot for adaptive queries; tool calls may run in parallel
  const { z } = require('zod');
  const { betaZodTool } = require('@anthropic-ai/sdk/helpers/beta/zod');
  const tool = betaZodTool({
    name: 'search_linkedin_companies',
    description: 'Run one search restricted to LinkedIn company pages and add the companies found to the pool. Returns how many were found, how many were new, and the running total.',
    inputSchema: z.object({
      query: z.string().describe('Full query including the site:xx.linkedin.com/company operator and any after: filter'),
      why: z.string().describe('One short clause: what this variant is meant to catch'),
    }),
    run: async ({ query: q0, why }) => {
      if (used >= budget) return JSON.stringify({ error: `Query budget of ${budget} is spent. Stop and summarise.` });
      const q = fixQuery(q0, { query, sizeClause, since }); // keeps site:, size clause and after: as the user chose
      const key = q.toLowerCase();
      if (started.has(key)) return JSON.stringify({ error: 'Already ran this exact query. Try a different variant or stop.' });
      started.add(key); // recorded before any await, so parallel tool calls cannot both run it
      used++; // reserve the slot before waiting, so parallel tool calls cannot both pass the budget check
      await sleep(gapFor(q));
      const idx = nextIndex++;
      emit({ type: 'plan-add', item: { term: shortTerm(q), query: q, why, group: 'adaptive', priority: idx + 1, plan_index: idx } });
      const rec = await runQuery(q, why, { plan_index: idx, group: 'adaptive', term: shortTerm(q) });
      const remaining = budget - used;
      return JSON.stringify({
        found: rec.found, new_companies: rec.added, total_companies: found.size, queries_remaining: remaining,
        rate_limited: rec.rate_limited || undefined,
        note: rec.rate_limited ? 'Search engine is rate limiting; stop now.' : remaining <= 0 ? 'Budget spent; stop and summarise.' : undefined,
      });
    },
  });

  const seed = queries[0];
  const opening = [
    `Seed query: ${query}`,
    `Sector: ${sector || '(not given)'}; place: ${location || '(not given)'}; country subdomain: ${country ? country + '.linkedin.com' : 'linkedin.com (any)'}; since: ${since || '(none)'}.`,
    `Search provider: ${providerFor(query) === 'serper' ? 'Google via Serper (10 results per query, so each query is a narrow probe; overlap between queries is normal)' : 'Brave Search (one page per query, ignores after:, rate-limits bursts)'}.`,
    sizeClause ? `Company-size filter: keep this clause verbatim in every query: ${sizeClause}. It is the exact wording LinkedIn uses on this mirror, so do not translate or reword it.` : '',
    brief.description ? `Brief from the user (may include what they are looking for, searches to try, places to include or things to skip; their vocabulary and places outrank your guesses, and any searches they name should run before your own variants, wrapped in the same site:, size and date scaffolding as the seed): ${brief.description}` : '',
    brief.suggestions && brief.suggestions.length ? `Searches the user suggested (run these early; a bare term means: wrap it in the same site:, place, size and date scaffolding as the seed; a full query with site: is used as given, with the size and date clauses added if missing):\n- ${brief.suggestions.join('\n- ')}` : '',
    brief.notes ? `Other notes from the user: ${brief.notes}` : '',
    `Queries already run, with new companies each added:\n${queries.map((x) => `- ${x.query} -> +${x.added} new (${x.found} found)`).join('\n')}`,
    `Pool so far: ${found.size} companies. You have ${budget - used} more queries. If the last two queries added fewer than two new companies each, stop now and summarise; otherwise try what the plan missed.`,
  ].filter(Boolean).join('\n');

  let summary = '';
  try {
    const runner = cl.beta.messages.toolRunner({
      model: MODEL,
      max_tokens: 4000,
      max_iterations: budget + 3,
      output_config: { effort: 'medium' },
      system: SYSTEM,
      tools: [tool],
      messages: [{ role: 'user', content: opening }],
    });
    let last = null;
    for await (const message of runner) {
      last = message;
      const isFinal = !message.content.some((b) => b.type === 'tool_use');
      if (!isFinal) for (const block of message.content) {
        if (block.type === 'text' && block.text.trim()) emit({ type: 'note', text: block.text.trim() });
      }
      if (message.stop_reason === 'refusal') { emit({ type: 'note', text: 'The model declined to continue.' }); break; }
    }
    const finalMsg = typeof runner.done === 'function' ? await runner.done() : last;
    summary = (finalMsg && finalMsg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  } catch (e) {
    emit({ type: 'note', text: 'Agent stopped early: ' + e.message });
    summary = 'Agent stopped early: ' + e.message;
  }
  return finish(summary);

  function finish(summary) {
    const companies = [...found.values()];
    const out = { companies, queries, summary, provider: providerFor(query), notes: [...notes], rate_limited: rateLimited, budget };
    emit({ type: 'done', ...out });
    return out;
  }
}

module.exports = { discover };
