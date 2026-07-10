// Netlify Function (modern/streaming format) — secure backend proxy for the
// Client Success Hub's AI Agent, now with real token-by-token streaming.
//
// REPLACES the old ai-agent.js. That file used Netlify's older Lambda-style
// format, which can only return a complete, buffered response — it has no
// way to stream. This file uses Netlify's newer function format (a default
// export receiving a standard Request and returning a standard Response)
// specifically because that's what unlocks streaming: Anthropic's own
// response body is already a byte stream when you ask for one, and this
// function just pipes it straight through to the browser untouched.
//
// SETUP (one-time):
//   1. DELETE netlify/functions/ai-agent.js (the old version) from your repo
//      — both files would otherwise try to claim the same
//      /.netlify/functions/ai-agent endpoint.
//   2. Add this file at netlify/functions/ai-agent.mjs (note the .mjs
//      extension — that's what tells Netlify to use modern ES module syntax;
//      using .js here could fail depending on your project's module config).
//   3. Your ANTHROPIC_API_KEY environment variable in Netlify carries over —
//      no change needed there.
//
// KNOWN LIMIT: Netlify's streaming functions currently have a 10-second
// execution limit. For a normal reply this is not an issue — but a very long
// answer over a slow connection could theoretically get cut off mid-stream.
// If that ever happens in practice, splitting the ask into more focused
// questions is the workaround (there's no config to raise this limit
// ourselves; it's a platform-level ceiling).

export default async (req, context) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'ANTHROPIC_API_KEY is not set in this site\'s environment variables.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let payload;
  try {
    payload = await req.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { system, messages, tools } = payload;
  if (!Array.isArray(messages)) {
    return new Response(JSON.stringify({ error: 'messages must be an array' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let anthropicRes;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
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
        stream: true,
      }),
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Could not reach Anthropic API: ' + e.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!anthropicRes.ok) {
    // Anthropic rejected the request (bad input, rate limit, etc.) — pass its
    // real error body straight through so the frontend shows the actual reason.
    const errBody = await anthropicRes.text();
    return new Response(errBody, {
      status: anthropicRes.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Success — pipe Anthropic's own event stream straight through, untouched.
  return new Response(anthropicRes.body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
};
