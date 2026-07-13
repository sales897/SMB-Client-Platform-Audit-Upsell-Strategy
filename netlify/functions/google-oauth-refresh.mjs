// netlify/functions/google-oauth-refresh.mjs
//
// Given the caller's own identity (verified via their Supabase session
// token, never a client-supplied email), looks up their stored Google
// Calendar refresh token and exchanges it for a fresh short-lived access
// token. This is what makes the connection actually persist -- called
// silently whenever the client's cached access token has expired, instead
// of ever showing the Google popup again.

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

    const lookupRes = await fetch(
      `${SUPABASE_URL}/rest/v1/google_calendar_tokens?owner_email=eq.${encodeURIComponent(email)}&select=refresh_token`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
    );
    const rows = await lookupRes.json();
    if (!rows || rows.length === 0) {
      // Not an error -- this is the normal, expected state for anyone who
      // has never connected Google Calendar at all. The client treats this
      // as "not connected" silently, no toast, no popup.
      return new Response(JSON.stringify({ error: "not_connected" }), { status: 404 });
    }

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: rows[0].refresh_token,
        client_id: GOOGLE_CALENDAR_CLIENT_ID,
        client_secret: clientSecret,
        grant_type: "refresh_token",
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      // A refresh token can itself expire or get revoked (the person removed
      // access from their Google Account settings, or it's been unused long
      // enough that Google invalidated it). Delete the stale row so future
      // checks fail fast via the 404 path above instead of hitting Google
      // with a doomed request every time.
      if (tokenData.error === "invalid_grant") {
        await fetch(`${SUPABASE_URL}/rest/v1/google_calendar_tokens?owner_email=eq.${encodeURIComponent(email)}`, {
          method: "DELETE",
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        }).catch(() => {});
        return new Response(JSON.stringify({ error: "not_connected", reason: "revoked" }), { status: 404 });
      }
      return new Response(JSON.stringify({ error: `Google token refresh failed: ${tokenData.error_description || tokenData.error || tokenRes.status}` }), { status: 400 });
    }

    return new Response(JSON.stringify({
      access_token: tokenData.access_token,
      expires_in: tokenData.expires_in,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};
