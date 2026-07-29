# Handoff Note — ATLAS build in progress

**For:** whichever agent (Codex or otherwise) next works on The HUB / `index.html`
**From:** Claude, 2026-07-29
**Paste this into:** `CSH_Changelog.md` and/or `CSH_Known_Bugs.md` as relevant, or read as-is.

---

## TL;DR

A new personal assistant, **ATLAS**, is being built alongside Nirvana. It has its
own database tables and its own backend logic. **`index.html` has NOT been
touched for ATLAS yet** — no UI, no functions, no changes to existing code.
Only the Supabase schema changed so far.

**Oscar has asked that `index.html` not be edited by other agents until ATLAS
Phase 3 (HUB UI integration) begins**, to avoid two agents editing the same
single-file app concurrently. If you're reading this and about to make changes
to `index.html`, check with Oscar first — the file may be mid-build on the
ATLAS side even if this note is stale.

---

## What ATLAS is

A personal assistant for Oscar — separate from Nirvana. Ingests his Close CRM
notes into a searchable knowledge base, pushes briefings to Slack, and will
eventually get a docked panel in The HUB next to Nirvana.

**Division of labor (do not blur this):**
- **Nirvana** owns: client records, portfolios, workflows, HUB product data
- **ATLAS** owns: Oscar's notes, tasks, prep, reporting, automation

They share the same Supabase project and are meant to hand off to each other,
not compete or duplicate work.

---

## What changed in Supabase (2026-07-29)

Migration `atlas_phase1_schema` applied to project `banmahudemvjkygwihsd`.

**New, currently empty:**
- `atlas_notes` — durable archive of Close CRM notes + Claude-enriched fields
  (action items, commitments, risk signals, sentiment, next step)
- `atlas_note_chunks` — chunked text + `vector(384)` embeddings (gte-small,
  Supabase's built-in Edge Function model — no external embeddings vendor)
- `atlas_digests` — generated briefings/recaps/reports
- `atlas_conversations` — ATLAS chat history, mirrors `nirvana_conversations`
  exactly (`id` = user email)

**New function:** `public.match_atlas_notes(...)` — vector similarity search
over `atlas_note_chunks`, filters pushed inside the function (not chained
`.eq()` after `.rpc()`).

**Also enabled:** `pgvector` extension (schema: `extensions`).

**RLS:** all four tables have RLS on, policies match the existing
`current_app_role()` pattern used elsewhere in CSH. No `USING (true)`
anywhere. Security advisor confirmed clean — zero new findings from this
migration; all pre-existing warnings (`client_errors_insert`,
`check_and_log_ai_usage`, etc.) predate ATLAS and are unrelated.

**Nothing else changed.** No existing table, policy, or function was altered.

---

## Table/function naming convention going forward

Everything ATLAS owns is prefixed `atlas_`. If you see a table or function
with that prefix, it belongs to ATLAS — don't repurpose it, and don't add a
similarly-named one for something else.

ATLAS reuses (does not duplicate) these existing tables:
`client_tasks` (task write path), `notifications`, `reminders`,
`knowledge_base`, `portfolio_clients`, `ledger_entries`,
`collections_accounts`, `ai_usage_log`.

---

## What changed since — 2026-07-29, later same day

**New Supabase Edge Function (live):** `atlas-embed`
`https://banmahudemvjkygwihsd.supabase.co/functions/v1/atlas-embed`
Runs gte-small (384-dim), verify_jwt is ON — call with the service role key
as Bearer token, server-to-server only. This is the ONLY place embeddings
are generated; Netlify Functions run on Node and can't load this model.

**New Netlify function files (delivered, NOT yet deployed — Oscar needs to
add these to the repo and deploy):**
- `atlas-ingest-background.mjs` — pulls FULL Close note history per client
  (existing `close-crm.mjs`'s `notes` action caps at 20 with no paging;
  this one pages through everything). Talks to Close directly rather than
  through `close-crm.mjs`, because that function requires a signed-in
  Supabase user and there's no browser session in a scheduled job.
- `atlas-ingest-schedule.mjs` — cron trigger (`*/30 * * * *`), fires the
  above. Kept thin because scheduled functions cap at 30s execution.
- `atlas-enrich-background.mjs` — Claude structured extraction (summary,
  action items, commitments, risk signals, sentiment, next step, dollar
  amounts) + chunking + calls to `atlas-embed`, writes `atlas_note_chunks`.

**No new env vars needed** — `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`,
`CLOSE_API_KEY` all already existed in Netlify.

**If you're the next agent touching Netlify functions:** these three files
are new and additive — they don't modify `close-crm.mjs` or anything else.
Don't merge their Close-calling logic back into `close-crm.mjs`; it's
intentionally separate because the auth models differ (user-session vs.
server-to-server).

---

## What's coming next (not yet built)

- Deploying the three Netlify function files above (Oscar to add to repo)
- Slack app (channel + DM) — /atlas slash command, Q&A with citations
- Morning brief / EOD recap scheduled digests
- **Phase 3 only:** a docked ATLAS panel in `index.html`, next to Nirvana

If you reach Phase 3 territory before Oscar clears you to edit `index.html`,
stop and confirm with him first.
