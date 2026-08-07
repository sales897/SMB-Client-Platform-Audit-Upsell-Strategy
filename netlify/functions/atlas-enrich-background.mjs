// netlify/functions/atlas-enrich-background.mjs
//
// ATLAS — enrichment + chunking + embedding pipeline, plus real-time risk
// alerting (added 2026-08-05).
//
// For each atlas_notes row not yet enriched:
//   1. Claude extracts structure (summary, action items, commitments made
//      by Oscar vs. by the client, risk signals, sentiment, next step,
//      dollar amounts) and classifies note_type.
//   2. If the enrichment hits Critical/High severity (deterministic
//      keyword match against the SOP's own escalation language, or
//      negative sentiment + a real risk signal), an immediate Slack
//      alert fires -- Critical to the shared channel + DM, High to DM
//      only -- rather than waiting for the next scheduled brief/EOD.
//      Max one alert per client per hour (cooldown via
//      atlas_realtime_alerts).
//   3. The raw text is split into chunks (~400 tokens, ~50 overlap).
//   4. Chunks are embedded via the atlas-embed Supabase Edge Function
//      (gte-small, 384-dim) — NOT locally. Netlify Functions run on Node
//      and cannot load that model; only Supabase's Edge Runtime can.
//   5. Chunks + embeddings are written to atlas_note_chunks.
//
// Trigger: fired automatically at the end of atlas-ingest-background.mjs,
// or callable directly to process any backlog.
//
// Runs as a Netlify BACKGROUND function (15-min budget) since Claude calls
// for dozens of notes plus embedding round-trips can run long.

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ANTHROPIC_API_KEY = Netlify.env.get("ANTHROPIC_API_KEY");
const SLACK_BOT_TOKEN = Netlify.env.get("SLACK_BOT_TOKEN");

const SLACK_CHANNEL_ID = "C0BLMCCAM3Q"; // #account-management-goats
const SLACK_USER_ID = "U07KALYMG3Z"; // Oscar
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour, per Oscar's explicit scoping

const ATLAS_EMBED_URL = `${SUPABASE_URL}/functions/v1/atlas-embed`;
const CLAUDE_MODEL = "claude-haiku-4-5-20251001"; // cost-effective for structured extraction at volume
const BATCH_SIZE = 20;          // notes processed per run, stays well inside the 15-min budget
// Lowered from 32 to 4 (2026-07-29): Supabase Edge Functions have a hard
// 2-second CPU-time budget per request, and atlas-embed runs the model
// once per text sequentially. Batches of 7+ texts reliably triggered a
// 546 WORKER_LIMIT error against two long Knowledge Base SOPs -- this
// file hadn't hit it yet only because notes have stayed short so far
// (mostly 1 chunk), but a long transcript would trigger the identical
// failure. atlas-embed itself now enforces 4 as a hard ceiling too.
const EMBED_BATCH_SIZE = 4;
const CHUNK_CHARS = 1600;       // ~400 tokens at ~4 chars/token
const CHUNK_OVERLAP_CHARS = 200; // ~50 tokens

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- Supabase REST helpers ----
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

// ---- Real-time risk alerts (Block: 2026-08-05) ----
// Scoped directly with Oscar: reuse the exact Critical/High/Medium/Low
// severity language already established in the Preempting Risks SOP,
// rather than inventing new criteria. Only Critical and High interrupt
// in real time -- the SOP's own timing table says Medium needs action
// within 2 business days and Low within 5, neither of which needs an
// immediate ping; the twice-daily brief/EOD already covers that window.
// "Real-time" here genuinely means "within this ~30-minute enrichment
// cycle, not held until the next scheduled digest" -- Close CRM has no
// webhooks (confirmed early in this build), so a literal instant alert
// isn't possible without a different data source entirely.
//
// Deterministic keyword classification, not an LLM judgment call -- same
// reasoning as every other mechanical detection in this build (schedule
// conflicts, sentiment trajectories, phrase routing). Checked against
// the enrichment's own structured output (summary, risk_signals,
// next_step) rather than raw transcript text, since that's already
// Claude's clean distillation and less prone to false positives than
// scanning a full transcript for a stray keyword mention.
const CRITICAL_KEYWORDS = /\b(cancel|cancellation|refund|lawsuit|legal action|terminate|terminating|unacceptable)\b/i;
const HIGH_KEYWORDS = /\b(competitor|unhappy|disappointed|dissatisfied|frustrated|pause|paused|not working)\b/i;

function classifyAlertSeverity(enrichment) {
  const text = [enrichment.summary, ...(enrichment.risk_signals || []), enrichment.next_step].filter(Boolean).join(" ");
  if (CRITICAL_KEYWORDS.test(text)) return "critical";
  if (HIGH_KEYWORDS.test(text)) return "high";
  // Fallback: negative sentiment plus at least one real risk signal is
  // High-worthy even without hitting an exact keyword -- matches the
  // SOP's own "repeated complaints" framing without requiring a literal
  // complaint word to appear.
  if (enrichment.sentiment === "negative" && (enrichment.risk_signals || []).length > 0) return "high";
  return null;
}

async function isInCooldown(clientName) {
  const since = new Date(Date.now() - ALERT_COOLDOWN_MS).toISOString();
  const res = await sbFetch(
    `atlas_realtime_alerts?select=id&client_name=eq.${encodeURIComponent(clientName)}&created_at=gte.${since}&limit=1`
  );
  if (!res.ok) return false; // fail open -- a missed cooldown check shouldn't block a real alert
  const rows = await res.json();
  return rows.length > 0;
}

async function postAlert(target, blocks, fallbackText) {
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
      body: JSON.stringify({ channel: target, blocks, text: fallbackText }),
    });
    const data = await res.json();
    if (!data.ok) console.error(`atlas-enrich-background: alert post to ${target} failed:`, data.error);
  } catch (e) {
    console.error(`atlas-enrich-background: alert post to ${target} threw:`, e.message);
  }
}

async function sendRealtimeAlert(note, enrichment, severity) {
  const emoji = severity === "critical" ? "🚨" : "⚠️";
  const label = severity === "critical" ? "CRITICAL" : "High Priority";
  const lines = [
    `*Client:* ${note.client_name || "Unknown"}`,
    `*Note date:* ${new Date(note.note_date).toDateString()}`,
    `*Summary:* ${enrichment.summary || "(no summary)"}`,
  ];
  if (enrichment.risk_signals?.length) lines.push(`*Risk signals:* ${enrichment.risk_signals.join("; ")}`);
  if (enrichment.next_step) lines.push(`*Suggested next step:* ${enrichment.next_step}`);

  const blocks = [
    { type: "header", text: { type: "plain_text", text: `${emoji} ${label} Risk Alert`, emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
  ];
  const fallbackText = `${emoji} ${label} Risk Alert — ${note.client_name}: ${enrichment.summary || ""}`;

  // Per Oscar's scoping: Critical goes to both the shared channel and his
  // DM; High goes to his DM only, to keep the channel reserved for the
  // genuinely urgent tier rather than every flagged note.
  if (severity === "critical") {
    await postAlert(SLACK_CHANNEL_ID, blocks, fallbackText);
  }
  await postAlert(SLACK_USER_ID, blocks, fallbackText);

  await sbFetch("atlas_realtime_alerts", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify([{ client_name: note.client_name, severity, note_id: note.id }]),
  }).catch((e) => console.error("atlas-enrich-background: alert log insert failed:", e.message));
}

async function getUnenrichedNotes(limit) {
  const res = await sbFetch(
    `atlas_notes?enriched_at=is.null&order=created_at.asc&limit=${limit}` +
      `&select=id,client_name,raw_text,note_date`
  );
  if (!res.ok) throw new Error(`Could not load unenriched notes (${res.status})`);
  return res.json();
}

async function updateNoteEnrichment(noteId, fields) {
  const res = await sbFetch(`atlas_notes?id=eq.${noteId}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Failed to update note ${noteId} (${res.status}): ${detail}`);
  }
}

async function insertChunks(rows) {
  if (rows.length === 0) return;
  const res = await sbFetch("atlas_note_chunks?on_conflict=note_id,chunk_index", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Failed to insert chunks (${res.status}): ${detail}`);
  }
}

// ---- Claude enrichment ----
const ENRICHMENT_SYSTEM_PROMPT = `You extract structure from a single client-success call note or transcript. Respond with ONLY a JSON object, no prose, no markdown fences, matching exactly this shape:

{
  "note_type": "call_summary" | "transcript" | "typed_note",
  "summary": "one or two sentence summary",
  "action_items": ["..."],
  "my_commitments": ["things the rep/Oscar promised to do, with any date mentioned"],
  "their_commitments": ["things the client promised to do, with any date mentioned"],
  "risk_signals": ["any sign of churn risk, frustration, or dissatisfaction — empty array if none"],
  "opportunity_signals": ["any sign of growth potential — client mentioned expanding, asked about another product, expressed satisfaction that could support an upsell ask, referenced growing their own business — empty array if none"],
  "sentiment": "positive" | "neutral" | "mixed" | "negative",
  "next_step": "the single clearest next step, or null if none is stated",
  "amounts_mentioned": ["any dollar amounts mentioned, as written, e.g. \\"$450/mo\\""]
}

If the note is too short or too vague to extract something, use an empty array or null rather than inventing content. Never invent a fact not present in the text. Don't force a risk or opportunity signal that isn't genuinely there — most notes will have an empty array for one or both, and that's the correct output, not a failure to find something.`;

async function enrichWithClaude(rawText) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: ENRICHMENT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: rawText }],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Claude enrichment failed (${res.status}): ${detail}`);
  }
  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("Claude response had no text block");

  // Defensive parse: strip accidental markdown fences even though the
  // prompt says not to use them — cheap insurance against a bad turn.
  const cleaned = textBlock.text.trim().replace(/^```json\s*/i, "").replace(/```$/, "");
  return JSON.parse(cleaned);
}

// ---- Chunking ----
function chunkText(text) {
  if (text.length <= CHUNK_CHARS) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_CHARS, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start = end - CHUNK_OVERLAP_CHARS;
  }
  return chunks;
}

// ---- Embeddings via atlas-embed edge function ----
async function embedChunks(texts) {
  const embeddings = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const res = await fetch(ATLAS_EMBED_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ texts: batch }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`atlas-embed failed (${res.status}): ${detail}`);
    }
    const data = await res.json();
    embeddings.push(...data.embeddings);
  }
  return embeddings;
}

// Same shared-secret gate as atlas-ingest-background.mjs — this function
// runs Claude calls and embedding calls per note, so it's just as exposed
// to an anonymous trigger racking up real API cost.
function isAuthorizedTrigger(req) {
  const expected = Netlify.env.get("ATLAS_TRIGGER_SECRET");
  if (!expected) return false;
  return req.headers.get("x-atlas-trigger-secret") === expected;
}

export default async (req) => {
  if (!isAuthorizedTrigger(req)) {
    console.warn("atlas-enrich-background: rejected an unauthorized trigger attempt.");
    return new Response("Forbidden", { status: 403 });
  }

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error("atlas-enrich-background: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    return;
  }
  if (!ANTHROPIC_API_KEY) {
    console.error("atlas-enrich-background: ANTHROPIC_API_KEY not configured, aborting.");
    return;
  }

  let notes;
  try {
    notes = await getUnenrichedNotes(BATCH_SIZE);
  } catch (e) {
    console.error("atlas-enrich-background: failed to load notes:", e.message);
    return;
  }

  let enrichedCount = 0;
  let chunkCount = 0;
  const errors = [];

  for (const note of notes) {
    try {
      const enrichment = await enrichWithClaude(note.raw_text);

      await updateNoteEnrichment(note.id, {
        note_type: enrichment.note_type ?? null,
        summary: enrichment.summary ?? null,
        action_items: enrichment.action_items ?? [],
        my_commitments: enrichment.my_commitments ?? [],
        their_commitments: enrichment.their_commitments ?? [],
        risk_signals: enrichment.risk_signals ?? [],
        opportunity_signals: enrichment.opportunity_signals ?? [],
        sentiment: enrichment.sentiment ?? null,
        next_step: enrichment.next_step ?? null,
        amounts_mentioned: enrichment.amounts_mentioned ?? [],
        enriched_at: new Date().toISOString(),
      });

      // Suggest a follow-up task when there's a clear, specific next step --
      // deliberately a SUGGESTION, not a real client_tasks row. Matches this
      // codebase's existing convention (Bulk Close Enrichment, Smart Paste):
      // nothing auto-applies without a human look first. The length check is
      // a simple heuristic to skip near-empty/vague answers ("n/a", "-")
      // rather than suggesting a task from nothing.
      if (enrichment.next_step && enrichment.next_step.trim().length > 10) {
        await sbFetch("atlas_task_suggestions", {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify([
            {
              note_id: note.id,
              client_name: note.client_name,
              suggested_title: enrichment.next_step.trim(),
              source_text: note.raw_text.slice(0, 500),
              note_date: note.note_date,
              status: "pending",
            },
          ]),
        }).catch((e) => console.error("atlas-enrich-background: task suggestion insert failed:", e.message));
      }

      // Real-time risk alert -- only Critical/High interrupt immediately;
      // Medium/Low stay in the normal scheduled-brief flow (see the block
      // comment above classifyAlertSeverity for the full reasoning).
      const severity = classifyAlertSeverity(enrichment);
      if (severity && note.client_name) {
        const cooling = await isInCooldown(note.client_name);
        if (!cooling) {
          await sendRealtimeAlert(note, enrichment, severity);
        } else {
          console.log(`atlas-enrich-background: ${note.client_name} alert suppressed (cooldown active).`);
        }
      }

      const chunks = chunkText(note.raw_text);
      // Embed WITH client-name + date context, but STORE the clean chunk
      // text (no prefix) for display/citation. Real bug found 2026-07-31:
      // chunk_text on its own ("Not gonna increase until he sees a 3x
      // ROI") carries zero lexical connection to "Zoom Drain" or any
      // client name -- a name-anchored query has nothing to match against
      // in the actual embedded text, no matter how lenient the similarity
      // threshold is. This was a structural gap, not a tuning problem.
      const textsForEmbedding = chunks.map(
        (c) => `Client: ${note.client_name || "Unknown"} (${new Date(note.note_date).toDateString()})\n${c}`
      );
      const embeddings = await embedChunks(textsForEmbedding);

      const chunkRows = chunks.map((chunk_text, idx) => ({
        note_id: note.id,
        chunk_index: idx,
        chunk_text, // clean, no prefix -- what gets shown/cited, not what got embedded
        client_name: note.client_name,
        note_date: note.note_date,
        // JSON.stringify per Supabase's documented pattern: pgvector's input
        // parser reads the bracketed-number string, not a raw JSON array.
        embedding: JSON.stringify(embeddings[idx]),
      }));
      await insertChunks(chunkRows);

      enrichedCount += 1;
      chunkCount += chunkRows.length;
    } catch (e) {
      errors.push({ note_id: note.id, error: e.message });
      console.error(`atlas-enrich-background: note ${note.id} failed:`, e.message);
    }
    await sleep(300); // light courtesy pacing on the Anthropic API
  }

  console.log(
    `atlas-enrich-background: ${notes.length} candidates, ${enrichedCount} enriched, ` +
      `${chunkCount} chunks embedded, ${errors.length} errors.`
  );
};
