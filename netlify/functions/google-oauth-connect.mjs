// netlify/functions/google-oauth-connect.mjs
//
// Completes the initial Google Calendar connection. The browser gets a
// one-time authorization CODE from Google (via google.accounts.oauth2.
// initCodeClient with access_type:'offline', NOT the old initTokenClient
// flow), and sends that code here. This function exchanges it for both an
// access token (short-lived, handed back to the browser to use immediately)
// and a refresh token (long-lived, stored server-side so future access
// tokens can be minted silently forever after, without the person ever
// seeing the Google popup again).
//
// SETUP REQUIRED: GOOGLE_OAUTH_CLIENT_SECRET must be set as a Netlify
// environment variable (Site configuration -> Environment variables,
// "Contains secret values" checked) -- generated in Google Cloud Console
// under Google Auth Platform -> Clients -> [the existing client] -> Add
// Secret. This is a DIFFERENT credential from GOOGLE_CALENDAR_CLIENT_ID
// (which is public and already embedded client-side) -- the secret must
// never appear in browser code.

const SUPABASE_URL = "https://banmahudemvjkygwihsd.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJhbm1haHVkZW12amt5Z3dpaHNkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5MjIzOTIsImV4cCI6MjA5ODQ5ODM5Mn0.01Y4i_nAFt-wmN-YNcE3dw_3od0NoU4HgvjwSCWw0cc";
const GOOGLE_CALENDAR_CLIENT_ID = "512550241298-me0g34krgime9v61pij5ir9610h7iqlo.apps.googleusercontent.com";

// Verifies the caller's identity from their own Supabase session token --
// never trust a client-supplied email directly, since that could let anyone
// claim to be anyone and read/write someone else's calendar connection.
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
    if (!clientSecret) {
      return new Response(JSON.stringify({ error: "GOOGLE_OAUTH_CLIENT_SECRET is not configured on the server." }), { status: 500 });
    }

    const { code } = await req.json();
    if (!code) {
      return new Response(JSON.stringify({ error: "Missing authorization code." }), { status: 400 });
    }

    // "postmessage" is a special literal redirect_uri Google requires
    // specifically for the JS popup-based code flow (initCodeClient with
    // ux_mode:'popup') -- not a real URL, don't swap it for the site's URL.
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
      // Happens if the person had already granted consent recently and
      // Google didn't re-issue a refresh token this time -- connectGoogle
      // Calendar() client-side always requests prompt:'consent' precisely
      // to avoid this, but guard here too rather than silently storing
      // nothing and having refresh fail later with a confusing error.
      return new Response(JSON.stringify({ error: "Google didn't return a refresh token. Try disconnecting and reconnecting." }), { status: 400 });
    }

    const serviceKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/google_calendar_tokens`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({ owner_email: email, refresh_token: tokenData.refresh_token, updated_at: new Date().toISOString() }),
    });
    if (!upsertRes.ok) {
      const body = await upsertRes.text().catch(() => "");
      return new Response(JSON.stringify({ error: `Could not save the connection: ${body}` }), { status: 500 });
    }

    return new Response(JSON.stringify({
      access_token: tokenData.access_token,
      expires_in: tokenData.expires_in,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};
