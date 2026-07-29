// netlify/functions/atlas-ask-background.mjs
//
// ATLAS — the actual Q&A pipeline. Triggered only by atlas-slack.mjs
// (never directly reachable from Slack), gated by the same shared-secret
// pattern as the ingest/enrich functions.
//
//   1. Embed the question via atlas-embed (gte-small, same model used
//      to embed every note chunk — must match, or similarity is meaningless)
//   2. Retrieve relevant note chunks via match_atlas_notes
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
const MATCH_THRESHOLD = 0.72;

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

const ANSWER_SYSTEM_PROMPT = `You are ATLAS, Oscar's personal assistant. You answer questions using excerpts from his Close CRM call notes. You are separate from Nirvana, the Hub's product AI — you only know Oscar's notes, not live account or billing data, and you don't guess about things Nirvana would know instead.

Rules:
- Answer ONLY using the provided excerpts. Never invent a fact or a date.
- Cite the client name and date for every claim, like "(Acme Roofing, Jul 12)".
- If the excerpts don't answer the question, say so plainly instead of guessing.
- Keep it tight and scannable for Slack: short paragraphs, no headers, no tables.`;

async function answerWithClaude(question, chunks) {
  const context = chunks.length
    ? chunks
        .map(
          (c) =>
            `[${c.client_name || "Unknown client"} | ${new Date(c.note_date).toDateString()}]\n${c.chunk_text}`
        )
        .join("\n\n---\n\n")
    : "(No matching notes were found for this question.)";

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
      messages: [{ role: "user", content: `Notes:\n\n${context}\n\nQuestion: ${question}` }],
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
  if (source === "slash" && response_url) {
    await fetch(response_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: "in_channel", text }),
    });
    return;
  }
  // DM, or slash fallback if response_url has expired (valid ~30 min).
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel: channel_id, text }),
  });
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
    const chunks = await retrieveChunks(embedding);
    const answer = await answerWithClaude(payload.question, chunks);
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
