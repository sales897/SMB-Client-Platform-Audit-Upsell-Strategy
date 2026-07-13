// netlify/functions/google-oauth-disconnect.mjs
//
// Deletes the caller's own stored refresh token. Needed because
// google_calendar_tokens has zero RLS policies by design (see its migration
// comment) -- the browser can never write to that table directly, even to
// delete its own row, so disconnecting has to go through a server function
// too, same as connecting does.

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
    await fetch(`${SUPABASE_URL}/rest/v1/google_calendar_tokens?owner_email=eq.${encodeURIComponent(email)}`, {
      method: "DELETE",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};
