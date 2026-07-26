// ============================================================
// Per-deployment configuration.
//
// This is the ONLY file that should differ between org deployments
// of the Client Success Hub. index.html itself stays identical
// across every org — it reads its Supabase connection from
// window.CSH_CONFIG, set here, instead of from hardcoded values.
//
// Setting up a new org: copy this file, replace the two values
// below with that org's Supabase project URL and anon (public) key
// — never the service_role key, that one is a secret and never
// belongs in a browser-loaded file — and deploy it alongside a copy
// of the unmodified index.html.
//
// The anon key is safe to expose here; it's protected by RLS
// policies on the database side, the same as it is today.
// ============================================================
window.CSH_CONFIG = {
  supabaseUrl: 'https://banmahudemvjkygwihsd.supabase.co',
  supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJhbm1haHVkZW12amt5Z3dpaHNkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5MjIzOTIsImV4cCI6MjA5ODQ5ODM5Mn0.01Y4i_nAFt-wmN-YNcE3dw_3od0NoU4HgvjwSCWw0cc',
};
