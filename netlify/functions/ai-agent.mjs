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

// Error logging (operational readiness, 2026-07-25; fixed 2026-07-26) -- reports
// genuine backend failures to the same client_errors table the browser logs to.
// IMPORTANT: this must be awaited by every caller. It was originally
// fire-and-forget (not awaited), on the theory that logging shouldn't slow
// down the response -- but real production testing showed it never actually
// wrote anything: this Edge Function runtime tears down the execution context
// the instant a Response is returned, killing any in-flight, un-awaited fetch
// before it completes. Every call site here is on an already-slow,
// already-broken error path (never the successful streaming path), so the
// small added latency from actually awaiting it is the right tradeoff for
// getting real error visibility instead of a logger that silently never worked.
const SUPABASE_URL = Netlify.env.get("SUPABASE_URL") || "https://banmahudemvjkygwihsd.supabase.co";
const SUPABASE_ANON_KEY = Netlify.env.get("SUPABASE_ANON_KEY") || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJhbm1haHVkZW12amt5Z3dpaHNkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5MjIzOTIsImV4cCI6MjA5ODQ5ODM5Mn0.01Y4i_nAFt-wmN-YNcE3dw_3od0NoU4HgvjwSCWw0cc";
async function logServerError(message) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/client_errors`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'ai-agent', message: String(message).slice(0, 2000) }),
    });
  } catch (e) { /* never let the error logger itself throw or block the real response */ }
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

  // ─── Auth check (2026-07-25) ────────────────────────────────────────────
  // This endpoint previously accepted requests from anyone who knew the URL
  // -- no session check at all, despite holding a real, billed API key.
  // The frontend now sends the user's actual Supabase session token in the
  // Authorization header (the same token already used for every other
  // Supabase call, via SB_HEADERS.Authorization); verify it here before
  // doing anything else.
  const authHeader = req.headers.get('authorization') || '';
  const callerToken = authHeader.replace(/^Bearer\s+/i, '');
  if (!callerToken) {
    return new Response(JSON.stringify({ error: 'Not signed in. Please log in and try again.' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let callerEmail;
  async function verifyToken() {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${callerToken}` },
    });
    return res;
  }

  let userRes;
  try {
    userRes = await verifyToken();
    // A genuine 401/403 means Supabase itself rejected the token -- that's a
    // real "please log in again". Anything else non-ok (a 5xx from Supabase's
    // own infrastructure, for instance) is much more likely a transient blip
    // than a real rejection, so it gets one retry before we give up --
    // conflating the two was the actual bug: a brief hiccup calling out to
    // Supabase was previously indistinguishable from a truly expired session,
    // which sent people down the wrong troubleshooting path (re-logging in
    // does nothing for a transient network issue).
    if (!userRes.ok && userRes.status !== 401 && userRes.status !== 403) {
      await logServerError(`Auth check got ${userRes.status} on first try, retrying once`);
      userRes = await verifyToken();
    }
  } catch (e) {
    // The fetch itself threw (DNS/timeout/connection reset) -- also transient,
    // also worth one retry before treating it as a real failure.
    try {
      await logServerError('Auth check network error on first try, retrying once: ' + e.message);
      userRes = await verifyToken();
    } catch (e2) {
      await logServerError('Auth check failed twice, giving up: ' + e2.message);
      return new Response(JSON.stringify({ error: 'Having trouble verifying your session right now -- this is likely temporary, please try again in a moment.' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  if (!userRes.ok) {
    if (userRes.status === 401 || userRes.status === 403) {
      // A real rejection, confirmed on this attempt (or the retry) -- the
      // token genuinely is invalid/expired. "Log in again" is the correct
      // advice here.
      return new Response(JSON.stringify({ error: 'Your session has expired. Please log in again.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // Still failing after a retry, and not a real rejection -- an actual
    // outage on Supabase's side, not something logging in again would fix.
    await logServerError(`Auth check still failing after retry: status ${userRes.status}`);
    return new Response(JSON.stringify({ error: 'Having trouble verifying your session right now -- this is likely temporary, please try again in a moment.' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const userData = await userRes.json();
    callerEmail = userData && userData.email;
    if (!callerEmail) {
      return new Response(JSON.stringify({ error: 'Could not verify your session. Please log in again.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  } catch (e) {
    await logServerError('Auth verification response could not be parsed: ' + e.message);
    return new Response(JSON.stringify({ error: 'Could not verify your session right now. Please try again.' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ─── Rate limit (2026-07-25) ────────────────────────────────────────────
  // Per-minute cap catches a runaway loop; per-day cap catches sustained
  // cost overrun. Checked and logged atomically in one RPC call.
  try {
    const rlRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/check_and_log_ai_usage`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${callerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_email: callerEmail }),
    });
    if (rlRes.ok) {
      const rl = await rlRes.json();
      if (rl && rl.allowed === false) {
        const msg = rl.reason === 'per_minute_limit_exceeded'
          ? `You're sending requests too quickly (limit: ${rl.limit}/minute). Wait a moment and try again.`
          : `Daily AI usage limit reached (${rl.limit}/day). This resets rolling, try again later.`;
        return new Response(JSON.stringify({ error: msg }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    // If the rate-limit check itself fails (rlRes not ok), fail OPEN rather
    // than blocking every legitimate user because of an unrelated outage --
    // logged so it's visible, but doesn't take Nirvana down with it.
    else {
      await logServerError('Rate limit check failed with status ' + rlRes.status + ', failing open');
    }
  } catch (e) {
    await logServerError('Rate limit check errored, failing open: ' + e.message);
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
    await logServerError('Could not reach Anthropic API: ' + e.message);
    return new Response(JSON.stringify({ error: 'Could not reach Anthropic API: ' + e.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!anthropicRes.ok) {
    // Anthropic rejected the request (bad input, rate limit, etc.) — pass its
    // real error body straight through so the frontend shows the actual reason.
    const errBody = await anthropicRes.text();
    await logServerError(`Anthropic API returned ${anthropicRes.status}: ${errBody.slice(0, 500)}`);
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
