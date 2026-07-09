// Netlify Function — secure backend proxy for the Client Success Hub's AI Agent.
//
// The browser can never safely call api.anthropic.com directly: that would mean
// putting a real API key inside the public HTML file, where literally anyone
// viewing the page (or your GitHub repo) could copy it and use it on your bill.
// This function holds the key as a server-side environment variable instead —
// the Hub's frontend only ever talks to this function, never to Anthropic directly.
//
// SETUP (one-time):
//   1. Create an API key at https://console.anthropic.com/settings/keys
//   2. In your Netlify site: Site configuration → Environment variables →
//      Add variable → Key: ANTHROPIC_API_KEY, Value: <paste your key>
//   3. Commit this file to your repo at: netlify/functions/ai-agent.js
//      (same repo as index.html). Netlify auto-detects functions in that folder.
//   4. Redeploy. The Hub calls this at /.netlify/functions/ai-agent automatically.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY is not set in this site\'s environment variables.' }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { system, messages, tools } = payload;
  if (!Array.isArray(messages)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'messages must be an array' }) };
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        system: system || undefined,
        messages,
        tools: tools || undefined,
      }),
    });

    const data = await res.json();
    return {
      statusCode: res.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
  } catch (e) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Could not reach Anthropic API: ' + e.message }),
    };
  }
};
