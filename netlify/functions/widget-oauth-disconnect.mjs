// netlify/functions/widget-oauth-disconnect.mjs
//
// Removes a Chat Widget's connected Google Calendar. Mirrors
// google-oauth-disconnect.mjs but keyed by widget_id instead of the
// caller's own email.

const SUPABASE_URL = "https://banmahudemvjkygwihsd.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJhbm1haHVkZW12amt5Z3dpaHNkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5MjIzOTIsImV4cCI6MjA5ODQ5ODM5Mn0.01Y4i_nAFt-wmN-YNcE3dw_3od0NoU4HgvjwSCWw0cc";

async function getVerifiedEmail(authHeader) {
  if (!authHeader) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: authHeader },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data && data.email ? data.email.toLowerCase() : null;
}

export default async (req) => {
  try {
    const email = await getVerifiedEmail(req.headers.get("authorization"));
    if (!email) {
      return new Response(JSON.stringify({ error: "Not signed in." }), { status: 401 });
    }

    const serviceKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!serviceKey) {
      return new Response(JSON.stringify({ error: "Server is not fully configured." }), { status: 500 });
    }

    const url = new URL(req.url);
    const widgetId = url.searchParams.get("widgetId");
    if (!widgetId) {
      return new Response(JSON.stringify({ error: "Missing widgetId." }), { status: 400 });
    }

    await fetch(`${SUPABASE_URL}/rest/v1/widget_calendar_tokens?widget_id=eq.${encodeURIComponent(widgetId)}`, {
      method: "DELETE",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });

    await fetch(`${SUPABASE_URL}/rest/v1/chat_widgets?id=eq.${encodeURIComponent(widgetId)}`, {
      method: "PATCH",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ calendar_connected: false, calendar_email: null, updated_at: new Date().toISOString() }),
    });

    return new Response(JSON.stringify({ disconnected: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};
