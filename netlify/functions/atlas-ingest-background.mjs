// netlify/functions/atlas-ingest-background.mjs
//
// ATLAS — full Close CRM note history ingest.
//
// Unlike close-crm.mjs's `notes` action (capped at 20 notes, no paging,
// used by the browser's bulk-enrichment UI which only ever keeps the 5
// most recent), this pulls the COMPLETE note history per client and
// writes it into atlas_notes as a durable, accumulating archive.
//
// Why this isn't just a call to close-crm.mjs: that function requires a
// signed-in Supabase user (it verifies the caller's JWT via Supabase Auth).
// There's no browser session in a scheduled background job, so this talks
// to Close directly instead — same Basic-auth pattern, same 429 retry
// logic, same CLOSE_API_KEY env var, just without the user-auth gate that
// only makes sense for browser-originated requests.
//
// Trigger: netlify/functions/atlas-ingest-schedule.mjs (cron, every 30 min)
// or a manual POST to this function's URL.
// On completion: fires atlas-enrich-background.mjs to process new rows.
//
// Runs as a Netlify BACKGROUND function (note the -background suffix,
// required by Netlify) so it has a 15-minute execution budget instead of
// the 30s limit scheduled functions are held to — needed because pacing
// Close calls at ~3.5s apart across many clients easily exceeds 30s.

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
const CLOSE_API_BASE = "https://api.close.com/api/v1";

const NOTE_PAGE_LIMIT = 100;    // Close's practical max per page for this endpoint
const MAX_PAGES_PER_LEAD = 10;  // safety cap: 1,000 notes/client ceiling
const CLOSE_DELAY_MS = 3500;    // matches existing UI pacing — Close allows 60 req/min per org

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- Close auth + fetch (mirrors close-crm.mjs's pattern exactly) ----

function closeAuthHeader() {
  const apiKey = Netlify.env.get("CLOSE_API_KEY");
  if (!apiKey) return null;
  return "Basic " + Buffer.from(`${apiKey}:`).toString("base64");
}

async function fetchClose(url, authHeader) {
  let res = await fetch(url, { headers: { Authorization: authHeader } });
  if (res.status === 429) {
    const retryAfterSec = Number(res.headers.get("retry-after")) || 2;
    await sleep(Math.min(retryAfterSec, 5) * 1000);
    res = await fetch(url, { headers: { Authorization: authHeader } });
  }
  return res;
}

// ---- Dedup key ----
// Prefer Close's own activity id (globally unique already — no need to
// hash it). Fall back to a content hash only for the rare case an id is
// somehow missing, so historical data without one still dedupes sanely.
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function contentHashFor(leadId, note) {
  if (note.id) return `close:${note.id}`;
  return "hash:" + (await sha256Hex(`${leadId}|${note.date_created}|${note.text || ""}`));
}

// ---- Pull ALL notes for one lead, paging through Close ----
async function fetchAllNotesForLead(leadId, authHeader) {
  const notes = [];
  let skip = 0;
  for (let page = 0; page < MAX_PAGES_PER_LEAD; page++) {
    const url =
      `${CLOSE_API_BASE}/activity/note/?lead_id=${encodeURIComponent(leadId)}` +
      `&_limit=${NOTE_PAGE_LIMIT}&_skip=${skip}&_fields=id,note,date_created,user_name`;
    const res = await fetchClose(url, authHeader);
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Close notes fetch failed (${res.status}) for lead ${leadId}: ${detail}`);
    }
    const data = await res.json();
    const pageNotes = (data.data || [])
      .map((n) => ({
        id: n.id || null,
        text: n.note || "",
        author: n.user_name || null,
        date_created: n.date_created,
      }))
      .filter((n) => n.text.trim().length > 0);
    notes.push(...pageNotes);
    if (!data.has_more) break;
    skip += NOTE_PAGE_LIMIT;
    await sleep(CLOSE_DELAY_MS);
  }
  return notes;
}

// ---- Supabase REST helpers (service role — bypasses RLS by design;
// this function is never reachable from the browser) ----
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

async function getCloseCrmLinks() {
  const res = await sbFetch("close_crm_links?select=client_name,close_lead_id");
  if (!res.ok) throw new Error(`Could not load close_crm_links (${res.status})`);
  return res.json();
}

async function upsertNotes(rows) {
  if (rows.length === 0) return { inserted: 0 };
  const res = await sbFetch("atlas_notes?on_conflict=content_hash", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Supabase insert failed (${res.status}): ${detail}`);
  }
  return { inserted: rows.length };
}

async function logSync(detail) {
  await sbFetch("integration_sync_log", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify([
      {
        integration: "atlas_close_ingest",
        event_type: "synced",
        direction: "from_close",
        detail,
        actor_email: null,
      },
    ]),
  }).catch(() => {});
}

export default async (req) => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error("atlas-ingest-background: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    return;
  }
  const authHeader = closeAuthHeader();
  if (!authHeader) {
    console.error("atlas-ingest-background: CLOSE_API_KEY not configured, aborting.");
    return;
  }

  let links;
  try {
    links = await getCloseCrmLinks();
  } catch (e) {
    console.error("atlas-ingest-background: failed to load close_crm_links:", e.message);
    return;
  }

  let totalFetched = 0;
  let totalInserted = 0;
  const errors = [];

  for (const link of links) {
    try {
      const notes = await fetchAllNotesForLead(link.close_lead_id, authHeader);
      totalFetched += notes.length;

      const rows = await Promise.all(
        notes.map(async (n) => ({
          content_hash: await contentHashFor(link.close_lead_id, n),
          client_name: link.client_name,
          close_lead_id: link.close_lead_id,
          source: "close",
          note_type: null, // classified during enrichment (call_summary | transcript | typed_note)
          author: n.author,
          note_date: n.date_created,
          raw_text: n.text,
        }))
      );

      const { inserted } = await upsertNotes(rows);
      totalInserted += inserted;
    } catch (e) {
      errors.push({ client_name: link.client_name, error: e.message });
      console.error(`atlas-ingest-background: ${link.client_name} failed:`, e.message);
    }
    await sleep(CLOSE_DELAY_MS);
  }

  const summary = `${links.length} clients, ${totalFetched} notes fetched, ${errors.length} errors`;
  console.log(`atlas-ingest-background: ${summary}`);
  await logSync(summary);

  // Kick off enrichment for whatever just landed. Background functions ack
  // with 202 immediately, so this fire call doesn't extend our own window.
  try {
    await fetch(`${new URL(req.url).origin}/.netlify/functions/atlas-enrich-background`, {
      method: "POST",
    });
  } catch (e) {
    console.error("atlas-ingest-background: failed to trigger enrichment:", e.message);
  }
};
