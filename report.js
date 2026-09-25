// Report: a short executive summary written by the model over the ranked
// final list, plus the funnel numbers. The page assembles the rest of the
// report from data it already holds.

const fs = require('fs');
const path = require('path');

const MODEL = 'claude-opus-5';

let client = null;
function getClient() {
  if (client) return client;
  const hasCreds = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || fs.existsSync(path.join(process.env.HOME || '', '.config', 'anthropic'));
  if (!hasCreds) return null;
  const mod = require('@anthropic-ai/sdk');
  client = new (mod.default || mod)();
  return client;
}

async function report({ query, sector, location, funnel, companies }) {
  const cl = getClient();
  if (!cl) return { model: null, headline: '', executive_summary: '', note: 'No ANTHROPIC_API_KEY set; report has no executive summary.' };
  const { z } = require('zod');
  const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
  const schema = z.object({
    headline: z.string().describe('One line naming the sector and place and what was found.'),
    executive_summary: z.string().describe('One paragraph for the client: how many companies were gathered and screened, what the shortlist looks like, which one or two stand out and why, and any caveat about coverage.'),
    next_steps: z.array(z.string()).max(4),
  });
  const lines = companies.map((c, i) => `${i + 1}. ${c.name} (score ${c.score}, ${c.category}) — ${c.summary}`);
  const res = await cl.messages.parse({
    model: MODEL,
    max_tokens: 1500,
    output_config: { effort: 'low', format: zodOutputFormat(schema) },
    system: 'You write concise scouting reports for accelerator and investment teams. Plain language, no hype, specific about what was found and what was not. Do not invent facts beyond the data given.',
    messages: [{
      role: 'user',
      content: [
        `Search: ${query}`,
        sector || location ? `Sector: ${sector || '-'}; place: ${location || '-'}` : '',
        `Funnel: ${funnel.gathered} gathered from LinkedIn company pages; ${funnel.firstEliminated} eliminated in the first pass (logo, name, description); ${funnel.secondEliminated} eliminated in the second pass (website); ${funnel.unsure} left unsure; ${companies.length} identified as startups.`,
        'Ranked startups:',
        lines.join('\n') || '(none)',
      ].filter(Boolean).join('\n'),
    }],
  });
  if (res.stop_reason === 'refusal' || !res.parsed_output) return { model: MODEL, headline: '', executive_summary: '', note: 'Model returned no summary.' };
  return { model: MODEL, ...res.parsed_output };
}

module.exports = { report };
