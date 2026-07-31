// netlify/functions/atlas-hub-chat.mjs
//
// ATLAS — browser-callable endpoint for the new ATLAS tab in the HUB's
// existing AI panel (alongside Nirvana). Everything ATLAS has done until
// now (Slack) ran as a background function with no real end-user session
// to verify. This is different: it's called directly from index.html by
// a signed-in HUB user, so it needs real auth -- mirrors close-crm.mjs's
// getVerifiedEmail() pattern (call Supabase's own /auth/v1/user with the
// caller's token) rather than inventing a different check.
//
// Classic (non-background) Netlify Function -- same reason as ai-agent.mjs:
// this needs to return a real HTTP response to the browser, not just ack
// and finish later. Netlify's classic function ceiling is 10 seconds.
//
// DELIBERATE V1 SCOPE CUT: non-streaming. Nirvana's ai-agent.mjs streams
// token-by-token; this returns one complete JSON response instead. Full
// SSE streaming would mean re-implementing Anthropic's stream-parsing
// logic a second time for a first version -- the Slack version of this
// same retrieval+answer logic already completes in a few seconds, so a
// single "thinking..." wait is a reasonable v1 trade rather than matching
// Nirvana's streaming exactly out of the gate.
//
// Reuses the exact same retrieval logic as atlas-ask-background.mjs
// (embed -> match_atlas_notes + match_atlas_kb -> Claude with citations),
// just returns the answer directly instead of posting to Slack.

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Netlify.env.get("SUPABASE_ANON_KEY");
const SERVICE_ROLE_KEY = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ANTHROPIC_API_KEY = Netlify.env.get("ANTHROPIC_API_KEY");

const ATLAS_EMBED_URL = `${SUPABASE_URL}/functions/v1/atlas-embed`;
const CLAUDE_MODEL = "claude-sonnet-5";
const MATCH_COUNT = 8;
const MATCH_THRESHOLD = 0.72;
const KB_MATCH_COUNT = 4;
const KB_MATCH_THRESHOLD = 0.72;

// Same pattern as close-crm.mjs's getVerifiedEmail() -- verifies the
// caller's real Supabase session token, doesn't just trust the request.
async function getVerifiedEmail(authHeader) {
  if (!authHeader) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: authHeader, apikey: SUPABASE_ANON_KEY },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user?.email || null;
  } catch {
    return null;
  }
}

async function sbFetch(path, options = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
}

async function embedQuery(text) {
  const res = await fetch(ATLAS_EMBED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ texts: [text] }),
  });
  if (!res.ok) throw new Error(`atlas-embed failed (${res.status})`);
  const data = await res.json();
  return data.embeddings[0];
}

async function retrieveChunks(embedding) {
  const res = await sbFetch("rpc/match_atlas_notes", {
    method: "POST",
    body: JSON.stringify({
      query_embedding: JSON.stringify(embedding),
      match_threshold: MATCH_THRESHOLD,
      match_count: MATCH_COUNT,
      filter_client: null,
      filter_since: null,
    }),
  });
  if (!res.ok) throw new Error(`match_atlas_notes failed (${res.status})`);
  return res.json();
}

async function retrieveKbChunks(embedding) {
  const res = await sbFetch("rpc/match_atlas_kb", {
    method: "POST",
    body: JSON.stringify({
      query_embedding: JSON.stringify(embedding),
      match_threshold: KB_MATCH_THRESHOLD,
      match_count: KB_MATCH_COUNT,
    }),
  });
  if (!res.ok) throw new Error(`match_atlas_kb failed (${res.status})`);
  return res.json();
}

// Same system prompt as atlas-ask-background.mjs -- one behavior for
// ATLAS regardless of whether the question came from Slack or the HUB.
const ANSWER_SYSTEM_PROMPT = `You are ATLAS, Oscar's personal assistant. You answer questions using excerpts from his Close CRM call notes AND the team's Knowledge Base (SOPs and reference docs). You are separate from Nirvana, the Hub's product AI — you only know Oscar's notes and the Knowledge Base, not live account or billing data, and you don't guess about things Nirvana would know instead.

Casual conversation ("good morning," "thanks," "how's it going") is NOT a question that needs looking up. Respond naturally and warmly, like a helpful colleague would — don't force a citation, don't mention notes or excerpts, don't say you don't have information about it. Only the rules below about citing sources apply to actual questions about clients, notes, or the Knowledge Base — never to small talk.

Rules for actual questions (not casual conversation):
- Answer ONLY using the provided excerpts. Never invent a fact or a date.
- Cite call notes by client name and date, like "(Acme Roofing, Jul 12)".
- Cite Knowledge Base entries by their title, like "(SOP: New Client Onboarding)".
- If the excerpts don't answer the question, say so plainly instead of guessing.
- Keep responses concise and scannable.`;

async function answerWithClaude(question, noteChunks, kbChunks) {
  const contextParts = [];
  if (noteChunks.length) {
    contextParts.push(
      "CALL NOTES:\n" +
        noteChunks.map((c) => `[${c.client_name || "Unknown client"} | ${new Date(c.note_date).toDateString()}]\n${c.chunk_text}`).join("\n\n---\n\n")
    );
  }
  if (kbChunks.length) {
    contextParts.push("KNOWLEDGE BASE:\n" + kbChunks.map((c) => `[SOP: ${c.kb_title || "Untitled"}]\n${c.chunk_text}`).join("\n\n---\n\n"));
  }
  const context = contextParts.length ? contextParts.join("\n\n===\n\n") : "(No matching notes or Knowledge Base entries were found for this question.)";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 700,
      system: ANSWER_SYSTEM_PROMPT,
      messages: [{ role: "user", content: `${context}\n\nQuestion: ${question}` }],
    }),
  });
  if (!res.ok) throw new Error(`Claude answer failed (${res.status})`);
  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  return textBlock ? textBlock.text : "I couldn't generate an answer just now.";
}

export default async (req) => {
  const authHeader = req.headers.get("authorization");
  const email = await getVerifiedEmail(authHeader);
  if (!email) {
    return new Response(JSON.stringify({ error: "Your session has expired — please refresh and sign in again." }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body." }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  const question = (body?.question || "").trim();
  if (!question) {
    return new Response(JSON.stringify({ error: "Ask me something first." }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  try {
    const embedding = await embedQuery(question);
    const [noteChunks, kbChunks] = await Promise.all([retrieveChunks(embedding), retrieveKbChunks(embedding)]);
    const answer = await answerWithClaude(question, noteChunks, kbChunks);
    return new Response(JSON.stringify({ answer }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("atlas-hub-chat: failed:", e.message);
    return new Response(JSON.stringify({ error: "Something went wrong looking that up. Try again in a moment." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
