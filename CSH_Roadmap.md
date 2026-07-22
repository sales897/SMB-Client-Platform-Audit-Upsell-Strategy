# CSH Roadmap

## In Progress / Just Shipped (2026-07-21)
- Client matching, confirm-before-overwrite, and audit trail (client_activity_log)
  rolled out across every entry point: Bulk Reconcile Import, Add Client modal,
  CSV/Excel imports (Client Directory, Ad Spend, Collections), Onboarding
  graduation, and Nirvana's create_client / update_client_contact /
  activate_onboarding_as_client tools. New Nirvana tool: get_client_activity_history.
  **Status: built, not yet tested end-to-end by Oscar.**

## Pending / Queued
1. [Placeholder — awaiting details. Oscar referenced an item via an attachment
   that came through empty twice; add real description once provided.]
2. Structured "Business Profile" UI section for the Chat Widget (real fields for
   services/pricing/FAQs, replacing the current freeform Knowledge Base article
   approach). Carried over from the 2026-07-20 session handoff.
3. Broader white-label customization scope, beyond what's already built
   (org name/logo/colors/portfolio labels), if Oscar has more specific asks —
   note: Nirvana's own persona name ("Nirvana") is NOT currently white-label
   configurable at the org_settings level, only company_name/product_name are.
4. Ad Spend Management routing for Bulk Reconcile Import — Ledger and Collections
   are wired, Ad Spend is not. Carried over from the 2026-07-20 session handoff.

## Open Architectural Decision
- Whether to keep CSH as a single-file, no-build-step vanilla JS app (the
  documented stance as of earlier sessions) or begin modularizing / adopting
  a build step and possibly a component framework. Discussion started
  2026-07-21 — see Claude's response in that session for the tradeoffs laid
  out. No decision made yet.

## Explicitly Out of Scope (unless revisited)
- New design system or CSS framework
- (Previously) any build step or bundler — **this is the item currently under
  re-discussion above**
