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

// Error logging (operational readiness, 2026-07-25) -- reports genuine
// backend failures (can't reach Anthropic, Anthropic itself errors) to the
// same client_errors table the browser logs to. Fire-and-forget: a logging
// failure must never affect the actual response to the user.
const SUPABASE_URL = Netlify.env.get("SUPABASE_URL") || "https://banmahudemvjkygwihsd.supabase.co";
const SUPABASE_ANON_KEY = Netlify.env.get("SUPABASE_ANON_KEY") || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJhbm1haHVkZW12amt5Z3dpaHNkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5MjIzOTIsImV4cCI6MjA5ODQ5ODM5Mn0.01Y4i_nAFt-wmN-YNcE3dw_3od0NoU4HgvjwSCWw0cc";
function logServerError(message) {
  try {
    fetch(`${SUPABASE_URL}/rest/v1/client_errors`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'ai-agent', message: String(message).slice(0, 2000) }),
    }).catch(() => {});
  } catch (e) { /* never let the error logger itself throw */ }
}

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
        max_tokens: 4096,
        system: system || undefined,
        messages,
        tools: tools || undefined,
        stream: true,
      }),
    });
  } catch (e) {
    logServerError('Could not reach Anthropic API: ' + e.message);
    return new Response(JSON.stringify({ error: 'Could not reach Anthropic API: ' + e.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!anthropicRes.ok) {
    // Anthropic rejected the request (bad input, rate limit, etc.) — pass its
    // real error body straight through so the frontend shows the actual reason.
    const errBody = await anthropicRes.text();
    logServerError(`Anthropic API returned ${anthropicRes.status}: ${errBody.slice(0, 500)}`);
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
