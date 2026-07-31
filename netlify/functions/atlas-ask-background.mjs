// netlify/functions/atlas-ask-background.mjs
//
// ATLAS — the actual Q&A pipeline. Triggered only by atlas-slack.mjs
// (never directly reachable from Slack), gated by the same shared-secret
// pattern as the ingest/enrich functions.
//
//   1. Embed the question via atlas-embed (gte-small, same model used
//      to embed every note chunk — must match, or similarity is meaningless)
//   2. Retrieve relevant note chunks (match_atlas_notes) AND Knowledge Base
//      chunks (match_atlas_kb) in parallel
//   3. Ask Claude to answer USING ONLY the retrieved chunks, with citations
//   4. Post the answer back to Slack — response_url for slash commands,
//      chat.postMessage for DMs

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ANTHROPIC_API_KEY = Netlify.env.get("ANTHROPIC_API_KEY");
const SLACK_BOT_TOKEN = Netlify.env.get("SLACK_BOT_TOKEN");

const ATLAS_EMBED_URL = `${SUPABASE_URL}/functions/v1/atlas-embed`;
const CLAUDE_MODEL = "claude-sonnet-5"; // answer quality matters more here than in bulk enrichment
const MATCH_COUNT = 8;
const MATCH_THRESHOLD = 0.5; // lowered from 0.72 (2026-07-31): a real query
// ("what did we tell Zoom Drain last call") failed to retrieve confirmed-
// existing, correctly-embedded notes for that client. gte-small (a small,
// lightweight model) likely doesn't produce high enough similarity between
// a natural-language question and short, terse call-note snippets that
// don't share much surface vocabulary with it, even when the content is
// clearly the right answer. This is a well-reasoned hypothesis based on
// the evidence (data confirmed present + embedded, no code bug found),
// not a confirmed root cause -- worth re-testing after this change to
// confirm it actually fixes real queries, not just declaring it fixed.
// KB_MATCH_THRESHOLD left untouched -- KB retrieval has demonstrated
// success at 0.72 already, no evidence it has the same problem.
const KB_MATCH_COUNT = 4;
const KB_MATCH_THRESHOLD = 0.72;

function isAuthorizedTrigger(req) {
  const expected = Netlify.env.get("ATLAS_TRIGGER_SECRET");
  if (!expected) return false;
  return req.headers.get("x-atlas-trigger-secret") === expected;
}

async function embedQuery(text) {
  const res = await fetch(ATLAS_EMBED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ texts: [text] }),
  });
  if (!res.ok) throw new Error(`atlas-embed failed (${res.status}): ${await res.text().catch(() => "")}`);
  const data = await res.json();
  return data.embeddings[0];
}

async function retrieveChunks(embedding) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_atlas_notes`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      // Same JSON.stringify-as-text trick as the note chunk inserts —
      // pgvector's input parser reads the bracketed-number string.
      query_embedding: JSON.stringify(embedding),
      match_threshold: MATCH_THRESHOLD,
      match_count: MATCH_COUNT,
      filter_client: null,
      filter_since: null,
    }),
  });
  if (!res.ok) {
    throw new Error(`match_atlas_notes failed (${res.status}): ${await res.text().catch(() => "")}`);
  }
  return res.json();
}

async function retrieveKbChunks(embedding) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_atlas_kb`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query_embedding: JSON.stringify(embedding),
      match_threshold: KB_MATCH_THRESHOLD,
      match_count: KB_MATCH_COUNT,
    }),
  });
  if (!res.ok) {
    throw new Error(`match_atlas_kb failed (${res.status}): ${await res.text().catch(() => "")}`);
  }
  return res.json();
}

const ANSWER_SYSTEM_PROMPT = `You are ATLAS, Oscar's personal assistant. You answer questions using excerpts from his Close CRM call notes AND the team's Knowledge Base (SOPs and reference docs). You are separate from Nirvana, the Hub's product AI — you only know Oscar's notes and the Knowledge Base, not live account or billing data, and you don't guess about things Nirvana would know instead.

Casual conversation ("good morning," "thanks," "how's it going") is NOT a question that needs looking up. Respond naturally and warmly, like a helpful colleague would — don't force a citation, don't mention notes or excerpts, don't say you don't have information about it. Only the rules below about citing sources apply to actual questions about clients, notes, or the Knowledge Base — never to small talk.

Formatting — this is Slack, not standard markdown:
- Bold is *single asterisks*, never **double asterisks** — double asterisks show up as literal characters in Slack and look broken.
- Bullets are a line starting with "- ". No nested bullets, no markdown headers (##).

Rules for actual questions (not casual conversation):
- Answer ONLY using the provided excerpts. Never invent a fact or a date.
- Cite call notes by client name and date, like "(Acme Roofing, Jul 12)".
- Cite Knowledge Base entries by their title, like "(SOP: New Client Onboarding)".
- If the excerpts don't answer the question, say so plainly instead of guessing.
- Keep it tight and scannable for Slack: short paragraphs, no headers, no tables.`;

async function answerWithClaude(question, noteChunks, kbChunks) {
  const contextParts = [];
  if (noteChunks.length) {
    contextParts.push(
      "CALL NOTES:\n" +
        noteChunks
          .map((c) => `[${c.client_name || "Unknown client"} | ${new Date(c.note_date).toDateString()}]\n${c.chunk_text}`)
          .join("\n\n---\n\n")
    );
  }
  if (kbChunks.length) {
    contextParts.push(
      "KNOWLEDGE BASE:\n" +
        kbChunks.map((c) => `[SOP: ${c.kb_title || "Untitled"}]\n${c.chunk_text}`).join("\n\n---\n\n")
    );
  }
  const context = contextParts.length ? contextParts.join("\n\n===\n\n") : "(No matching notes or Knowledge Base entries were found for this question.)";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 700,
      system: ANSWER_SYSTEM_PROMPT,
      messages: [{ role: "user", content: `${context}\n\nQuestion: ${question}` }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Claude answer failed (${res.status}): ${await res.text().catch(() => "")}`);
  }
  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  return textBlock ? textBlock.text : "I couldn't generate an answer just now.";
}

async function postToSlack({ source, response_url, channel_id }, text) {
  try {
    if (source === "slash" && response_url) {
      const res = await fetch(response_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response_type: "in_channel", text }),
      });
      // response_url posts don't return Slack's usual {ok, error} JSON body
      // on failure the same way chat.postMessage does — a non-2xx here is
      // the signal to check, since there's no data.ok field to read.
      if (!res.ok) {
        console.error("atlas-ask-background: response_url post failed:", res.status, await res.text().catch(() => ""));
      }
      return;
    }
    // DM, or slash fallback if response_url has expired (valid ~30 min).
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({ channel: channel_id, text }),
    });
    const data = await res.json();
    // Slack's API returns HTTP 200 even on failure -- the real signal is
    // the "ok" field in the JSON body, not the status code.
    if (!data.ok) {
      console.error("atlas-ask-background: chat.postMessage failed:", data.error);
    }
  } catch (e) {
    console.error("atlas-ask-background: Slack post threw:", e.message);
  }
}

export default async (req) => {
  if (!isAuthorizedTrigger(req)) {
    console.warn("atlas-ask-background: rejected an unauthorized trigger attempt.");
    return new Response("Forbidden", { status: 403 });
  }

  const payload = await req.json().catch(() => null);
  if (!payload || !payload.question) {
    console.error("atlas-ask-background: missing payload or question");
    return;
  }

  try {
    const embedding = await embedQuery(payload.question);
    const [noteChunks, kbChunks] = await Promise.all([retrieveChunks(embedding), retrieveKbChunks(embedding)]);
    const answer = await answerWithClaude(payload.question, noteChunks, kbChunks);
    await postToSlack(payload, answer);
  } catch (e) {
    console.error("atlas-ask-background: failed:", e.message);
    try {
      await postToSlack(payload, `Something went wrong looking that up: ${e.message}`);
    } catch (_) {
      // best effort — if even the error message can't post, there's nothing left to do
    }
  }
};
