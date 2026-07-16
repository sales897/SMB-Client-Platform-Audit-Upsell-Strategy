// netlify/functions/widget-oauth-connect.mjs
//
// Connects a Google Calendar to a specific Chat Widget (not a team
// member's own calendar -- see google-oauth-connect.mjs for that). This is
// what lets the embeddable widget actually book real appointments: the
// resulting refresh token is stored keyed by widget_id in
// widget_calendar_tokens, and widget-chat.mjs uses it to check
// availability and create events when a lead books a call.
//
// Still requires the CALLER (whoever clicks "Connect Calendar" in the Hub's
// Chat Widget settings) to be a signed-in Hub team member -- this is an
// admin action on behalf of a widget, not something the public embeddable
// script ever calls directly.
//
// SETUP REQUIRED: same GOOGLE_OAUTH_CLIENT_SECRET and
// SUPABASE_SERVICE_ROLE_KEY already used by google-oauth-connect.mjs --
// no new secrets needed if those are already configured.

const SUPABASE_URL = "https://banmahudemvjkygwihsd.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJhbm1haHVkZW12amt5Z3dpaHNkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5MjIzOTIsImV4cCI6MjA5ODQ5ODM5Mn0.01Y4i_nAFt-wmN-YNcE3dw_3od0NoU4HgvjwSCWw0cc";
const GOOGLE_CALENDAR_CLIENT_ID = "512550241298-me0g34krgime9v61pij5ir9610h7iqlo.apps.googleusercontent.com";

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

    const clientSecret = Netlify.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
    const serviceKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!clientSecret || !serviceKey) {
      return new Response(JSON.stringify({ error: "Server is not fully configured for Google Calendar." }), { status: 500 });
    }

    const { code, widgetId } = await req.json();
    if (!code || !widgetId) {
      return new Response(JSON.stringify({ error: "Missing authorization code or widgetId." }), { status: 400 });
    }

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CALENDAR_CLIENT_ID,
        client_secret: clientSecret,
        redirect_uri: "postmessage",
        grant_type: "authorization_code",
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      return new Response(JSON.stringify({ error: `Google token exchange failed: ${tokenData.error_description || tokenData.error || tokenRes.status}` }), { status: 400 });
    }
    if (!tokenData.refresh_token) {
      return new Response(JSON.stringify({ error: "Google didn't return a refresh token. Try disconnecting and reconnecting." }), { status: 400 });
    }

    // Confirm which real calendar/email this is, so the Hub can show it
    // back to the person who connected it.
    let connectedEmail = null;
    try {
      const calRes = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (calRes.ok) {
        const calData = await calRes.json();
        connectedEmail = calData.id || calData.summary || null;
      }
    } catch (e) {
      // Non-fatal -- connection still works without this, just won't show an email label.
    }

    const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/widget_calendar_tokens`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        widget_id: widgetId,
        refresh_token: tokenData.refresh_token,
        connected_email: connectedEmail,
        connected_by: email,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!upsertRes.ok) {
      const body = await upsertRes.text().catch(() => "");
      return new Response(JSON.stringify({ error: `Could not save the connection: ${body}` }), { status: 500 });
    }

    const widgetPatchRes = await fetch(`${SUPABASE_URL}/rest/v1/chat_widgets?id=eq.${encodeURIComponent(widgetId)}`, {
      method: "PATCH",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ calendar_connected: true, calendar_email: connectedEmail, updated_at: new Date().toISOString() }),
    });
    if (!widgetPatchRes.ok) {
      const body = await widgetPatchRes.text().catch(() => "");
      return new Response(JSON.stringify({ error: `Connected, but couldn't update the widget record: ${body}` }), { status: 500 });
    }

    return new Response(JSON.stringify({ connected: true, connectedEmail }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};
