// netlify/functions/widget-poll.mjs
//
// Lets the embeddable widget check for new messages in its OWN
// conversation that it didn't just send itself -- specifically, a human
// team member's reply sent from the Hub's Inbox. Without this, a team
// member "taking over" a conversation would write a message to Supabase
// that the visitor's browser would never find out about, since the widget
// otherwise only ever sees a reply as part of its own POST to
// widget-chat.mjs.
//
// Security model matches widget-chat.mjs: conversation_id is treated like
// a bearer token (long random string the visitor's browser already holds
// in localStorage) rather than requiring real per-visitor auth -- this
// endpoint only ever returns messages for the ONE conversation_id given,
// via the service-role key server-side, never a list of conversations.

const SUPABASE_URL = "https://banmahudemvjkygwihsd.supabase.co";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const serviceKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceKey) {
    return new Response(JSON.stringify({ error: "Server is not fully configured." }), {
      status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const url = new URL(req.url);
  const conversationId = url.searchParams.get("conversation_id");
  const after = url.searchParams.get("after"); // ISO timestamp -- only messages newer than this
  if (!conversationId) {
    return new Response(JSON.stringify({ error: "Missing conversation_id." }), {
      status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const sbHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  let query = `${SUPABASE_URL}/rest/v1/widget_messages?conversation_id=eq.${encodeURIComponent(conversationId)}&order=created_at.asc&select=id,role,content,created_at`;
  if (after) query += `&created_at=gt.${encodeURIComponent(after)}`;

  try {
    const res = await fetch(query, { headers: sbHeaders });
    if (!res.ok) throw new Error(`Supabase query failed: ${res.status}`);
    const messages = await res.json();

    // Also report current resolution, so the widget can show a subtle
    // "connected with a team member" state if a human has taken over.
    const convRes = await fetch(`${SUPABASE_URL}/rest/v1/widget_conversations?id=eq.${encodeURIComponent(conversationId)}&select=handled_by,resolution`, { headers: sbHeaders });
    const convRows = convRes.ok ? await convRes.json() : [];
    const conv = convRows[0] || {};

    return new Response(JSON.stringify({ messages, handled_by: conv.handled_by || "ai", resolution: conv.resolution || null }), {
      status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
};
