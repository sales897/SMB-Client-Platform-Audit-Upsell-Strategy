// netlify/functions/atlas-kb-ingest-background.mjs
//
// ATLAS — Knowledge Base ingest. Embeds knowledge_base entries so /atlas
// and DMs can retrieve SOPs/docs alongside call notes, not just notes
// alone. Respects visible_to_atlas: only embeds entries marked visible,
// and un-embeds (deletes chunks for) entries that get toggled off.
//
// Re-embeds an entry when knowledge_base.updated_at is newer than
// atlas_embedded_at (or atlas_embedded_at is null) -- so editing an SOP
// through the Hub's own Knowledge Base page picks up the change here on
// the next run, not just brand-new entries.
//
// Trigger: netlify/functions/atlas-kb-ingest-schedule.mjs (cron, hourly --
// this content changes far less often than call notes, so a tighter
// cadence isn't needed).

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");

const ATLAS_EMBED_URL = `${SUPABASE_URL}/functions/v1/atlas-embed`;
// Lowered from 32 to 4 (2026-07-29): Supabase Edge Functions have a hard
// 2-second CPU-time budget per request, and atlas-embed runs the model
// once per text sequentially. Batches of 7+ texts reliably triggered a
// 546 WORKER_LIMIT error. atlas-embed itself now enforces 4 as a hard
// ceiling too -- this constant just avoids sending oversized batches
// that would get rejected in the first place.
const EMBED_BATCH_SIZE = 4;
const CHUNK_CHARS = 1600; // ~400 tokens at ~4 chars/token, same sizing as note chunks
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

async function deleteChunksFor(kbId) {
  await sbFetch(`atlas_kb_chunks?kb_id=eq.${encodeURIComponent(kbId)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
}

async function markEmbedded(kbId, timestamp) {
  await sbFetch(`knowledge_base?id=eq.${encodeURIComponent(kbId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ atlas_embedded_at: timestamp }),
  });
}

export default async (req) => {
  if (!isAuthorizedTrigger(req)) {
    console.warn("atlas-kb-ingest-background: rejected an unauthorized trigger attempt.");
    return new Response("Forbidden", { status: 403 });
  }

  try {
    // Entries visible to ATLAS that are new or edited since last embed.
    const visibleRes = await sbFetch(
      "knowledge_base?select=id,title,category,content,updated_at,atlas_embedded_at&visible_to_atlas=eq.true"
    );
    if (!visibleRes.ok) throw new Error(`Could not load knowledge_base (${visibleRes.status})`);
    const visibleRows = await visibleRes.json();
    const toEmbed = visibleRows.filter(
      (r) => !r.atlas_embedded_at || new Date(r.updated_at || 0) > new Date(r.atlas_embedded_at)
    );

    // Entries previously embedded but now toggled off — un-embed them.
    const hiddenRes = await sbFetch(
      "knowledge_base?select=id&visible_to_atlas=eq.false&atlas_embedded_at=not.is.null"
    );
    const hiddenRows = hiddenRes.ok ? await hiddenRes.json() : [];

    let embeddedCount = 0;
    let chunkCount = 0;
    const errors = [];

    for (const row of toEmbed) {
      try {
        await deleteChunksFor(row.id); // clear any stale chunks from a prior version first
        const content = (row.content || "").trim();
        if (!content) {
          await markEmbedded(row.id, new Date().toISOString());
          continue;
        }
        const chunks = chunkText(content);
        const embeddings = await embedChunks(chunks);
        const chunkRows = chunks.map((chunk_text, idx) => ({
          kb_id: row.id,
          kb_title: row.title,
          kb_category: row.category,
          chunk_index: idx,
          chunk_text,
          embedding: JSON.stringify(embeddings[idx]), // text form so pgvector's input parser reads it, same as note chunks
        }));
        const insertRes = await sbFetch("atlas_kb_chunks", {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify(chunkRows),
        });
        if (!insertRes.ok) throw new Error(`chunk insert failed (${insertRes.status}): ${await insertRes.text().catch(() => "")}`);

        await markEmbedded(row.id, new Date().toISOString());
        embeddedCount += 1;
        chunkCount += chunkRows.length;
      } catch (e) {
        errors.push({ kb_id: row.id, title: row.title, error: e.message });
        console.error(`atlas-kb-ingest-background: ${row.title} failed:`, e.message);
      }
    }

    let unembeddedCount = 0;
    for (const row of hiddenRows) {
      try {
        await deleteChunksFor(row.id);
        await sbFetch(`knowledge_base?id=eq.${encodeURIComponent(row.id)}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ atlas_embedded_at: null }),
        });
        unembeddedCount += 1;
      } catch (e) {
        console.error(`atlas-kb-ingest-background: failed to un-embed ${row.id}:`, e.message);
      }
    }

    console.log(
      `atlas-kb-ingest-background: ${toEmbed.length} candidates, ${embeddedCount} embedded, ` +
        `${chunkCount} chunks, ${unembeddedCount} un-embedded (hidden), ${errors.length} errors.`
    );
  } catch (e) {
    console.error("atlas-kb-ingest-background: failed:", e.message);
  }
};
