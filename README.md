# Scout Engine

Startup scouting for accelerators, incubators and investors. This repo holds two things:

- `index.html`: the public landing page (GitHub Pages).
- `search.html` + `server.js`: a local prototype of the scouting pipeline.

## The pipeline

Six steps, one tab each on `search.html`:

1. **Search.** One Google query limited to LinkedIn company pages (`site:nl.linkedin.com/company "circular economy" Amsterdam ...`) with an optional company-size clause and a "first seen since" date. A discovery agent then plans its own key terms (local language, adjacent terms, nearby places, startup framing, anything in your brief), shows them as a word cloud that sorts by priority, runs them, and adds a couple of adaptive queries at the end. Results are deduped by LinkedIn slug.
2. **First pass.** Each company's public LinkedIn page gives its logo, tagline, description, size, founded year, HQ, industry and type. Deterministic rules eliminate consultancies, networks, nonprofits and the like. The model scores logo, name and description and writes a one-line summary and USP for every company.
3. **Review unsure.** Confirm or unconfirm the unsure ones. Any row can be overridden.
4. **Passed first pass.** The survivors, with CSV export.
5. **Second pass.** Each website is fetched and screenshotted with headless Chrome. The domain, founder titles, menu pages, calls to action, colours and rounded shapes are checked, and the model judges the screenshot against the rubric and picks a category.
6. **Ranked report.** Startups ranked by a weighted score, an executive summary and next steps from the model, a funnel, and an appendix of everything eliminated with reasons. Download as HTML, print, or CSV.

Every decision stays visible with its reasons, and `window.scout` in the browser console exposes the state and render functions for debugging.

## Running it

```
npm install
cp .env.example .env   # then fill in the keys
node server.js
```

Open http://localhost:8765/search.html.

Keys in `.env`:

- `ANTHROPIC_API_KEY`: needed for the model judgements, the discovery agent and the report. Without it the first pass runs rules only and the search runs the seed query only.
- `SERPER_API_KEY`: Google results via serper.dev. The free tier returns 10 results per query, which is why the agent runs many narrow queries. Without it the server scrapes Brave Search, which ignores the date filter and rate-limits bursts.
- `CHROME_PATH`: optional, defaults to Google Chrome on macOS. Without Chrome the second pass runs without screenshots.

Fetched LinkedIn pages and screenshots are cached under `.cache/` for a week.

## Files

| File | Role |
|---|---|
| `server.js` | HTTP server: static pages plus `/api/search`, `/api/discover` (server-sent events), `/api/screen`, `/api/second`, `/api/report` |
| `search.js` | Search providers (Serper, Brave fallback) and result normalisation |
| `discover.js` | Discovery agent: plans key terms, runs them, adapts with the SDK tool runner |
| `screen.js` | First pass: LinkedIn parsing, exclusion rules, model judgement |
| `second.js` | Second pass: website analysis, screenshots, model judgement, ranking score |
| `report.js` | Executive summary for the report |
| `assets/site.css` | Shared styles for both pages |

## Limits worth knowing

- LinkedIn pages are fetched two at a time with one retry; LinkedIn throttles bursts with HTTP 999.
- The first pass accepts up to 100 companies per run and the second pass up to 50.
- Founder titles come from the company website only, since LinkedIn's People tab needs a login.
- Model verdicts vary a little between runs on the same input. A labelled set of past decisions is the way to measure precision and recall before trusting any prompt change.
