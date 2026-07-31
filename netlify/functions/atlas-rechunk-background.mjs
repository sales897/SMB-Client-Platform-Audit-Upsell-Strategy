// netlify/functions/atlas-rechunk-background.mjs
//
// ONE-TIME BACKFILL, not part of the regular pipeline. Fixes the retrieval
// bug found 2026-07-31: every existing atlas_note_chunks row was embedded
// from bare chunk text with no client-name/date context, so a name-
// anchored query ("what did we tell Zoom Drain") had nothing to match
// against in the actual embedded content. atlas-enrich-background.mjs is
// already fixed for NEW notes going forward -- this repairs the notes
// that were already processed before that fix existed.
//
// Deliberately does NOT re-run Claude enrichment (the summary/risk/
// commitments/etc. fields are already correct and don't need redoing --
// only the embedding step was broken) -- just re-chunks raw_text with the
// same context-prefixed embedding approach and replaces the old chunks.
//
// Safe to run more than once: deletes a note's existing chunks before
// rebuilding them, so re-running just re-does the same work, doesn't
// duplicate anything.

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");

const ATLAS_EMBED_URL = `${SUPABASE_URL}/functions/v1/atlas-embed`;
const EMBED_BATCH_SIZE = 4; // same hard limit as atlas-embed itself enforces (546 WORKER_LIMIT lesson)
const CHUNK_CHARS = 1600;
const CHUNK_OVERLAP_CHARS = 200;

function isAuthorizedTrigger(req) {
  const expected = Netlify.env.get("ATLAS_TRIGGER_SECRET");
  if (!expected) return false;
  return req.headers.get("x-atlas-trigger-secret") === expected;
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

async function embedChunks(texts) {
  const embeddings = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const res = await fetch(ATLAS_EMBED_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
      body: JSON.stringify({ texts: batch }),
    });
    if (!res.ok) throw new Error(`atlas-embed failed (${res.status}): ${await res.text().catch(() => "")}`);
    const data = await res.json();
    embeddings.push(...data.embeddings);
  }
  return embeddings;
}

export default async (req) => {
  if (!isAuthorizedTrigger(req)) {
    console.warn("atlas-rechunk-background: rejected an unauthorized trigger attempt.");
    return new Response("Forbidden", { status: 403 });
  }

  try {
    // Every enriched note is a backfill candidate -- this function is
    // idempotent (deletes-then-rebuilds a note's chunks), so processing
    // all of them in one run is simplest and safe to re-run if needed.
    // No pagination -- at this project's actual note volume (a few
    // hundred), fetching and processing everything in one invocation
    // comfortably fits the 15-minute background budget.
    const notesRes = await sbFetch(
      `atlas_notes?select=id,client_name,raw_text,note_date&enriched_at=not.is.null&order=note_date.asc&limit=1000`
    );
    if (!notesRes.ok) throw new Error(`Could not load notes (${notesRes.status})`);
    const notes = await notesRes.json();

    let rebuiltCount = 0;
    let chunkCount = 0;
    const errors = [];

    for (const note of notes) {
      try {
        await sbFetch(`atlas_note_chunks?note_id=eq.${note.id}`, {
          method: "DELETE",
          headers: { Prefer: "return=minimal" },
        });

        const content = (note.raw_text || "").trim();
        if (!content) continue;

        const chunks = chunkText(content);
        const textsForEmbedding = chunks.map(
          (c) => `Client: ${note.client_name || "Unknown"} (${new Date(note.note_date).toDateString()})\n${c}`
        );
        const embeddings = await embedChunks(textsForEmbedding);

        const chunkRows = chunks.map((chunk_text, idx) => ({
          note_id: note.id,
          chunk_index: idx,
          chunk_text,
          client_name: note.client_name,
          note_date: note.note_date,
          embedding: JSON.stringify(embeddings[idx]),
        }));

        const insertRes = await sbFetch("atlas_note_chunks", {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify(chunkRows),
        });
        if (!insertRes.ok) throw new Error(`chunk insert failed (${insertRes.status}): ${await insertRes.text().catch(() => "")}`);

        rebuiltCount += 1;
        chunkCount += chunkRows.length;
      } catch (e) {
        errors.push({ note_id: note.id, client_name: note.client_name, error: e.message });
        console.error(`atlas-rechunk-background: note ${note.id} (${note.client_name}) failed:`, e.message);
      }
    }

    console.log(
      `atlas-rechunk-background: rebuilt ${rebuiltCount} of ${notes.length} enriched notes, ` +
        `${chunkCount} chunks, ${errors.length} errors.`
    );
  } catch (e) {
    console.error("atlas-rechunk-background: failed:", e.message);
  }
};
