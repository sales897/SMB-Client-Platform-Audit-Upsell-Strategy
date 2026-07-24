// netlify/functions/team-status.mjs
//
// Returns real last-sign-in data per team member, pulled from Supabase
// Auth's admin API (auth.users.last_sign_in_at) -- this is NOT available
// in the team_members table itself (which only has id/name/email/role/
// created_at/avatar), and reading another user's auth record requires the
// service role key, so it can't be done client-side. Only callers who are
// themselves an Admin in team_members get this data.

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
    if (!email) return new Response(JSON.stringify({ error: "Not signed in." }), { status: 401 });

    const serviceKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const svcHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

    // Confirm the caller is actually an Admin before handing back everyone's
    // sign-in history -- team_members is readable via the anon key elsewhere,
    // but this endpoint returns more than a non-admin should see.
    const roleRes = await fetch(`${SUPABASE_URL}/rest/v1/team_members?email=eq.${encodeURIComponent(email)}&select=role`, { headers: svcHeaders });
    const roleRows = await roleRes.json();
    if (!roleRes.ok || !roleRows[0] || roleRows[0].role !== "admin") {
      return new Response(JSON.stringify({ error: "Only Admins can view team sign-in status." }), { status: 403 });
    }

    // Supabase's admin Auth API paginates; team sizes here are small, but
    // loop through pages defensively rather than assuming one page covers everyone.
    let page = 1;
    const byEmail = {};
    while (true) {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=200`, { headers: svcHeaders });
      if (!res.ok) break;
      const data = await res.json();
      const users = data.users || [];
      users.forEach(u => {
        if (u.email) byEmail[u.email.toLowerCase()] = { last_sign_in_at: u.last_sign_in_at || null, created_at: u.created_at || null };
      });
      if (users.length < 200) break;
      page++;
      if (page > 10) break; // sane upper bound
    }

    return new Response(JSON.stringify({ users: byEmail }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};
