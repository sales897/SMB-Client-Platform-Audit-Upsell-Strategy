# CSH Roadmap

## In Progress / Just Shipped (2026-07-21)
- Client matching, confirm-before-overwrite, and audit trail (client_activity_log)
  rolled out across every entry point: Bulk Reconcile Import, Add Client modal,
  CSV/Excel imports (Client Directory, Ad Spend, Collections), Onboarding
  graduation, and Nirvana's create_client / update_client_contact /
  activate_onboarding_as_client tools. New Nirvana tool: get_client_activity_history.
  New KB article documenting the system. **Status: built, awaiting Oscar's
  end-to-end test.**

## Pending / Queued
1. [Placeholder — Oscar referenced an item via an attachment that came through
   empty twice; add real description once provided.]
2. Structured "Business Profile" UI section for the Chat Widget (real fields for
   services/pricing/FAQs, replacing the freeform Knowledge Base article approach).
3. Broader white-label customization scope beyond what's built (org name/logo/
   colors/portfolio labels) — note: Nirvana's own persona name isn't currently
   white-label configurable, only company_name/product_name are.
4. Ad Spend Management routing for Bulk Reconcile Import (Ledger + Collections
   are wired, Ad Spend is not).

## Scoped, Not Yet Started: Split index.html into multiple files (no build step)

**Why:** every hard bug from the 2026-07-20/21 sessions (a missing `</div>`
silently breaking everything after it, a CSS rule scoped too broadly hitting
checkboxes app-wide, a flex-direction bug) was harder to find specifically
because it was buried in one ~25,000-line file. This doesn't fix bugs, but
makes the next one dramatically faster to localize, and reduces the risk of
duplicate-function-name collisions (which have broken this app before).

**Approach:** plain `<script src="...">` / `<link rel="stylesheet">` — zero
bundler, zero framework, same shared global scope as today. Fully reversible.

**Proposed file breakdown** (based on the file's own existing section
comments as of 2026-07-21, ~24,960 total lines — approximate, needs a careful
line-by-line pass during actual execution since some features' code is
scattered across more than one section, e.g. Collections' CSV import wizard
lives ~1,300 lines away from its main section):

| File | Contents | Approx. lines |
|---|---|---|
| `core-shared.js` | Navigation, Portfolio registry, Theme, Master rebuild, Empty states, Toast/Confirm dialogs (incl. the new confirmClientFieldChanges), CSV export, Resizable columns, Data ingestion, Supabase connection + helpers (incl. logClientActivity), Roles & permissions, Duplicate client cleanup, Smart Paste, White-label branding, Boot + Auth boot | ~4,600 |
| `portfolio-data.js` | Sample data, Product catalogs | ~360 |
| `client-directory.js` | All Clients Directory, Import Wizard, Manage Products | ~4,000 |
| `ledger.js` | Ledger, Bulk Reconcile Import | ~1,850 |
| `collections.js` | Collections + its import wizard | ~1,600 (scattered, needs verification) |
| `adspend.js` | Ad Spend Management | ~600 |
| `onboarding.js` | Onboarding (all pipelines/stages) | ~2,600 |
| `workflows.js` | Workflow automation engine | ~2,460 |
| `chat-widget.js` | Chat Widget Hub-side inbox/settings | ~1,690 |
| `nirvana.js` | AI Agent: system prompt, tools, tool-case handlers | ~2,120 |
| `knowledge-base.js` | Knowledge Base | ~240 |
| `notes-reminders.js` | Client Notes/Tasks/Notifications, Reminders | ~500 |
| `google-calendar.js` | Google Calendar sync | ~575 |
| `kpis.js` | Client Success KPIs (SuccessOS) | ~445 |
| `styles.css` | Everything currently in `<style>` (~2,740 lines) — may split further by page if still unwieldy | ~2,740 |

**Load order matters** since everything shares global scope (no modules) —
`core-shared.js` and `portfolio-data.js` must load first; the rest can follow
in any order since they're function declarations (hoisted) and event
handlers, not top-level executing code that depends on each other. This needs
real testing, not just an assumption, before considering it done.

**When to actually do this — the risk/timing signal, not a line-count number:**
The right trigger isn't a specific file size — it's timing. Do this during a
genuinely quiet week with no urgent client-facing feature or bug competing
for attention, so it gets a full regression pass without being rushed. Two
concrete signals that it's becoming overdue rather than just "someday":
- We hit another 2-3 bugs of this *same structural class* (something in one
  feature silently breaking something unrelated) in upcoming sessions.
- Before adding a third regular contributor beyond Oscar + Codex — more
  people editing raises collision risk faster than size alone does.
Short of those, there's no fixed "line 30,000, now it's mandatory" threshold —
it's a real cost/benefit call each time it comes up, not a hard limit.
