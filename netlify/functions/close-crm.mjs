// netlify/functions/close-crm.mjs
//
// Server-side proxy for Close CRM API calls. The Close API key lives ONLY
// in this function's environment (Netlify env var CLOSE_API_KEY) -- it is
// never sent to or stored in the browser or Supabase. Close uses HTTP
// Basic Auth with the API key as username and an empty password (see
// https://developer.close.com/api/overview/api-key-authentication).
//
// Actions (POST body: { action, ... }):
//   search { q }        -> up to 10 candidate leads matching a free-text
//                          business name query, for the fuzzy-match picker
//   lead   { leadId }    -> a single lead's core info + its Close contacts
//   notes  { leadId }    -> that lead's notes (Close stores notes as a type
//                          of Activity, fetched from a separate endpoint)

const SUPABASE_URL = "https://banmahudemvjkygwihsd.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJhbm1haHVkZW12amt5Z3dpaHNkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5MjIzOTIsImV4cCI6MjA5ODQ5ODM5Mn0.01Y4i_nAFt-wmN-YNcE3dw_3od0NoU4HgvjwSCWw0cc";
const CLOSE_API_BASE = "https://api.close.com/api/v1";

async function getVerifiedEmail(authHeader) {
  if (!authHeader) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: authHeader },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data && data.email ? data.email.toLowerCase() : null;
}

function closeAuthHeader() {
  const apiKey = Netlify.env.get("CLOSE_API_KEY");
  if (!apiKey) return null;
  // Basic auth: API key as username, empty password.
  return "Basic " + Buffer.from(`${apiKey}:`).toString("base64");
}

export default async (req) => {
  try {
    const email = await getVerifiedEmail(req.headers.get("authorization"));
    if (!email) {
      return new Response(JSON.stringify({ error: "Not signed in." }), { status: 401 });
    }

    const authHeader = closeAuthHeader();
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Close CRM isn't configured for this Hub yet — an Admin needs to add a CLOSE_API_KEY environment variable in Netlify." }), { status: 400 });
    }

    const body = await req.json();
    const { action } = body;

    if (action === "search") {
      const q = (body.q || "").trim();
      if (!q) return new Response(JSON.stringify({ error: "A search query is required." }), { status: 400 });
      const url = `${CLOSE_API_BASE}/lead/?query=${encodeURIComponent(q)}&_limit=10&_fields=id,display_name,name,status_label,description,contacts`;
      const res = await fetch(url, { headers: { Authorization: authHeader } });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        return new Response(JSON.stringify({ error: `Close API search failed (${res.status})`, detail }), { status: res.status });
      }
      const data = await res.json();
      const leads = (data.data || []).map(l => ({
        id: l.id,
        name: l.display_name || l.name,
        status: l.status_label || null,
        contact_count: (l.contacts || []).length,
      }));
      return new Response(JSON.stringify({ leads }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (action === "lead") {
      const leadId = body.leadId;
      if (!leadId) return new Response(JSON.stringify({ error: "leadId is required." }), { status: 400 });
      const res = await fetch(`${CLOSE_API_BASE}/lead/${encodeURIComponent(leadId)}/`, { headers: { Authorization: authHeader } });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        return new Response(JSON.stringify({ error: `Could not fetch that Close lead (${res.status})`, detail }), { status: res.status });
      }
      const lead = await res.json();
      const contacts = (lead.contacts || []).map(c => ({
        name: c.name || null,
        title: c.title || null,
        emails: (c.emails || []).map(e => e.email),
        phones: (c.phones || []).map(p => p.phone),
      }));
      return new Response(JSON.stringify({
        id: lead.id,
        name: lead.display_name || lead.name,
        status: lead.status_label || null,
        description: lead.description || null,
        contacts,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (action === "notes") {
      const leadId = body.leadId;
      if (!leadId) return new Response(JSON.stringify({ error: "leadId is required." }), { status: 400 });
      const url = `${CLOSE_API_BASE}/activity/note/?lead_id=${encodeURIComponent(leadId)}&_limit=20&_fields=note,date_created,user_name`;
      const res = await fetch(url, { headers: { Authorization: authHeader } });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        return new Response(JSON.stringify({ error: `Could not fetch notes from Close (${res.status})`, detail }), { status: res.status });
      }
      const data = await res.json();
      const notes = (data.data || []).map(n => ({ text: n.note, author: n.user_name || null, created_at: n.date_created }));
      return new Response(JSON.stringify({ notes }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400 });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};
