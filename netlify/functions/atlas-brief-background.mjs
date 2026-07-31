// netlify/functions/atlas-brief-background.mjs
//
// ATLAS — daily morning brief. Pulls several kinds of data and has Claude
// synthesize them into one Slack-readable brief, not just transcribe them:
//   1. Today's Google Calendar events, plus deterministically-detected
//      scheduling conflicts (computed in code, not left to Claude)
//   2. "Open commitments" — things Oscar or a client promised in a recent
//      call note that don't appear to have a matching client_tasks entry
//   3. Highlights from notes enriched in roughly the last 24 hours
//   4. A 30-day risk watchlist — flags repeat mentions of the same client
//      as an escalating pattern, not just a list of individual flags
//   5. A 30-day revenue-signal scan (dollar amounts mentioned) — Claude
//      distinguishes genuine upsell/expansion signals from complaints or
//      disputed charges, which look similar at a glance but aren't
//
// Posted to BOTH the shared Slack channel and a DM to Oscar.
//
// GOOGLE CALENDAR NOTE: unlike Close, there is no server-side function
// that lists calendar events — the Hub's Google Calendar integration is
// entirely browser-driven (a per-user OAuth token held client-side). The
// one server-side piece, google-oauth-refresh.mjs, is gated to a signed-in
// browser session, same situation close-crm.mjs was in. So this reads the
// stored refresh token directly from google_calendar_tokens (service role,
// bypasses RLS) and mints its own access token, rather than routing
// through that browser-oriented function.

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ANTHROPIC_API_KEY = Netlify.env.get("ANTHROPIC_API_KEY");
const SLACK_BOT_TOKEN = Netlify.env.get("SLACK_BOT_TOKEN");
const GOOGLE_OAUTH_CLIENT_SECRET = Netlify.env.get("GOOGLE_OAUTH_CLIENT_SECRET");

// Public OAuth client ID — mirrored from index.html's GOOGLE_CALENDAR_CLIENT_ID.
// Client IDs aren't secret (only the client secret is); if that constant
// ever changes in index.html, update it here too.
const GOOGLE_CALENDAR_CLIENT_ID =
  "512550241298-me0g34krgime9v61pij5ir9610h7iqlo.apps.googleusercontent.com";

const SLACK_CHANNEL_ID = "C0BLMCCAM3Q"; // #account-management-goats
const SLACK_USER_ID = "U07KALYMG3Z"; // Oscar — chat.postMessage opens/reuses the DM automatically
const CLAUDE_MODEL = "claude-sonnet-5";
const OWNER_EMAIL = "oscar@nicheandleads.com";

function isAuthorizedTrigger(req) {
  const expected = Netlify.env.get("ATLAS_TRIGGER_SECRET");
  if (!expected) return false;
  return req.headers.get("x-atlas-trigger-secret") === expected;
}

async function sbFetch(path, options = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
}

// ---- Mexico City is fixed UTC-6 (no DST since 2022) ----
function mexicoCityDateString(now = new Date()) {
  const local = new Date(now.getTime() + -6 * 60 * 60 * 1000);
  return local.toISOString().slice(0, 10); // YYYY-MM-DD
}

// ---- Google Calendar: mint our own access token, bypassing the
// browser-session-gated refresh function ----
async function getFreshGoogleAccessToken() {
  const res = await sbFetch(
    `google_calendar_tokens?select=refresh_token&owner_email=eq.${encodeURIComponent(OWNER_EMAIL)}&limit=1`
  );
  if (!res.ok) throw new Error(`Could not load google_calendar_tokens (${res.status})`);
  const rows = await res.json();
  if (!rows.length) return null; // not connected — brief just skips the calendar section

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: rows[0].refresh_token,
      client_id: GOOGLE_CALENDAR_CLIENT_ID,
      client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
    }),
  });
  if (!tokenRes.ok) {
    console.error("atlas-brief-background: Google token refresh failed:", await tokenRes.text().catch(() => ""));
    return null;
  }
  const data = await tokenRes.json();
  return data.access_token || null;
}

async function getTodayCalendarEvents(accessToken) {
  if (!accessToken) return [];
  const dateStr = mexicoCityDateString();
  const timeMin = `${dateStr}T00:00:00-06:00`;
  const timeMax = `${dateStr}T23:59:59-06:00`;
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
    `timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}` +
    `&singleEvents=true&orderBy=startTime`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    console.error("atlas-brief-background: Calendar fetch failed:", await res.text().catch(() => ""));
    return [];
  }
  const data = await res.json();
  return (data.items || []).map((e) => ({
    summary: e.summary || "(untitled event)",
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    // Google's eventType ('outOfOffice', 'focusTime', 'default', etc.) is
    // captured and labeled deterministically here rather than left for
    // Claude to infer from the raw summary text -- same reasoning as
    // schedule-conflict detection: a known, structured field beats a guess.
    eventType: e.eventType || "default",
  }));
}

// ---- HUB tasks (client_tasks) due today -- distinct from the 21-day
// "open commitments" heuristic elsewhere; this is exact due_date matching
// on the HUB's own task system, not a note-derived approximation. NOTE:
// this is NOT Google Tasks (a different API/OAuth scope this integration
// doesn't request) -- if Oscar actually meant Google's own Tasks list
// rather than HUB tasks, that's a separate, later integration. ----
async function getTasksDueToday() {
  const dateStr = mexicoCityDateString();
  const res = await sbFetch(
    `client_tasks?select=client_name,title,status&due_date=eq.${dateStr}&status=neq.completed`
  );
  if (!res.ok) {
    console.error("atlas-brief-background: tasks-due-today fetch failed:", await res.text().catch(() => ""));
    return [];
  }
  return res.json();
}

// ---- Open commitments: notes with commitments from the last 21 days
// that don't appear to have a matching client_tasks entry yet. This is an
// approximation (matched by client name + timing, not exact text), not a
// guaranteed-accurate link -- good enough to prompt Oscar to check, not
// meant to be authoritative. ----
async function getOpenCommitments() {
  const since = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString();
  const notesRes = await sbFetch(
    `atlas_notes?select=client_name,note_date,my_commitments,their_commitments` +
      // Added a limit here too (2026-07-30) -- this had none at all before,
      // genuinely unbounded, same class of risk as the risk watchlist/
      // revenue signals fix above. Same reasoning: the prompt caps output
      // at 5 lines per section regardless, so unbounded input just grows
      // the prompt for no benefit.
      `&note_date=gte.${since}&or=(my_commitments.neq.[],their_commitments.neq.[])&order=note_date.desc&limit=25`
  );
  if (!notesRes.ok) {
    console.error("atlas-brief-background: commitment notes fetch failed:", await notesRes.text().catch(() => ""));
    return [];
  }
  const notes = await notesRes.json();
  if (!notes.length) return [];

  const clientNames = [...new Set(notes.map((n) => n.client_name).filter(Boolean))];
  const tasksRes = await sbFetch(
    `client_tasks?select=client_name,created_at&client_name=in.(${clientNames
      .map((c) => `"${c.replace(/"/g, '\\"')}"`)
      .join(",")})`
  );
  const tasks = tasksRes.ok ? await tasksRes.json() : [];

  return notes.filter((note) => {
    const hasTaskAfter = tasks.some(
      (t) => t.client_name === note.client_name && new Date(t.created_at) > new Date(note.note_date)
    );
    return !hasTaskAfter;
  });
}

// ---- Recent note highlights: enriched in roughly the last 24 hours ----
async function getRecentHighlights() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const res = await sbFetch(
    `atlas_notes?select=client_name,summary,sentiment,risk_signals,note_date` +
      `&enriched_at=gte.${since}&order=note_date.desc&limit=15`
  );
  if (!res.ok) {
    console.error("atlas-brief-background: highlights fetch failed:", await res.text().catch(() => ""));
    return [];
  }
  return res.json();
}

// ---- Risk watchlist: risk_signals across a WIDER window (30 days, all
// clients) than "recent highlights" (24h). The point is to let Claude spot
// a pattern -- e.g. the same client flagged three times in three weeks --
// which a 24h window could never surface even once, let alone as a trend. ----
async function getRiskWatchlist() {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const res = await sbFetch(
    `atlas_notes?select=client_name,note_date,risk_signals,sentiment` +
      // Trimmed from 40 to 20 (2026-07-30): the prompt now caps output at
      // 5 lines per section regardless, so feeding 40 raw candidates just
      // grows the prompt and pushes toward the token ceiling for no benefit
      // -- 20 recent-most is plenty of room to pick the top 5 from.
      `&note_date=gte.${since}&risk_signals=neq.[]&order=note_date.desc&limit=20`
  );
  if (!res.ok) {
    console.error("atlas-brief-background: risk watchlist fetch failed:", await res.text().catch(() => ""));
    return [];
  }
  return res.json();
}

// ---- Revenue signals: reuses amounts_mentioned, which enrichment already
// extracts per note -- no new column needed. Widened to 30 days for the
// same reason as the risk watchlist: a single note rarely reads as an
// "opportunity" on its own, but a client asking about pricing twice in a
// month is a different story. Claude decides what's actually a signal
// worth surfacing vs. noise (a mentioned dollar figure isn't automatically
// an opportunity -- could just as easily be a complaint about a charge). ----
async function getRevenueSignals() {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const res = await sbFetch(
    `atlas_notes?select=client_name,note_date,summary,amounts_mentioned` +
      // Same trim as the risk watchlist, same reasoning.
      `&note_date=gte.${since}&amounts_mentioned=neq.[]&order=note_date.desc&limit=20`
  );
  if (!res.ok) {
    console.error("atlas-brief-background: revenue signals fetch failed:", await res.text().catch(() => ""));
    return [];
  }
  return res.json();
}

// ---- Pending task suggestions: notes with a clear next_step that ATLAS
// suggested as a task, awaiting Oscar's review. Deliberately SURFACED,
// not auto-created -- same "nothing auto-applies" convention this
// codebase already follows elsewhere. Full auto-create (with an approval
// mechanism) is a natural next increment, not built yet. ----
async function getPendingTaskSuggestions() {
  const res = await sbFetch(
    `atlas_task_suggestions?select=client_name,suggested_title,note_date&status=eq.pending&order=created_at.desc&limit=10`
  );
  if (!res.ok) {
    console.error("atlas-brief-background: task suggestions fetch failed:", await res.text().catch(() => ""));
    return [];
  }
  return res.json();
}

// ---- Schedule conflicts: computed deterministically here, NOT left to
// Claude's judgment. Comparing ISO timestamp ranges correctly is exactly
// the kind of precise, mechanical task an LLM can get subtly wrong (off-
// by-one on boundaries, timezone confusion, etc.) -- so this hands Claude
// a confirmed fact to state plainly, rather than asking it to re-derive
// overlaps from raw timestamps itself. All-day events (date, not
// dateTime) are excluded -- a full-day calendar block "overlapping" a
// meeting isn't a real conflict in the way two double-booked calls are. ----
function formatMxTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      timeZone: "America/Mexico_City",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function detectScheduleConflicts(events) {
  const timed = events
    .map((e) => ({
      summary: e.summary,
      start: e.start,
      end: e.end,
      startMs: e.start?.includes("T") ? new Date(e.start).getTime() : null,
      endMs: e.end?.includes("T") ? new Date(e.end).getTime() : null,
    }))
    .filter((e) => e.startMs != null && e.endMs != null)
    .sort((a, b) => a.startMs - b.startMs);

  const conflicts = [];
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      if (timed[j].startMs >= timed[i].endMs) break; // sorted by start -- no later event can overlap once past this one's end
      conflicts.push({
        a: timed[i].summary,
        aRange: `${formatMxTime(timed[i].start)}–${formatMxTime(timed[i].end)}`,
        b: timed[j].summary,
        bRange: `${formatMxTime(timed[j].start)}–${formatMxTime(timed[j].end)}`,
      });
    }
  }
  return conflicts;
}

const BRIEF_SYSTEM_PROMPT = `You are ATLAS, composing Oscar's daily morning brief for Slack, rendered as Slack Block Kit. Respond with ONLY a JSON object, no prose, no markdown fences, matching exactly this shape:

{
  "executive_summary": "1-2 sentences: the state of the day at a glance, before any detail",
  "kpi_snapshot": { "risks_flagged": <integer>, "revenue_opportunities": <integer> },
  "sections": [
    { "emoji": "one emoji that fits this section's actual content", "title": "short, concrete, action-oriented title, 2-4 words", "body_lines": ["line one", "line two"], "priority": "high" | "medium" | "low" }
  ],
  "signoff": "one short closing line"
}

"body_lines" is an array — one array entry per line, NOT one string with line breaks inside it. This matters: a raw line break inside a JSON string produces invalid JSON that fails to parse, so lines must be separate array entries instead.

"kpi_snapshot" counts: report how many distinct items you actually included in a Risk section (risks_flagged) and how many in a Revenue Opportunities section (revenue_opportunities) — 0 if you didn't write that section. These should match your own sections below, not a re-count of raw input data (some of that data won't have made the cut).

"priority" per section: "high" = needs attention today; "medium" = worth knowing, not urgent; "low" = FYI. Sections render in priority order (high first), so this also controls what Oscar sees first.

Section titles — be concrete and action-oriented, not vague:
- Prefer "Immediate Actions" over "Worth Checking On"
- Prefer "Client Risks" over "Things to Watch"
- Prefer "Growth Opportunities" over "Interesting Mentions"

Formatting rules for each line in "body_lines" (this is Slack's mrkdwn, NOT standard markdown):
- Bold is *single asterisks*, never **double asterisks** — double asterisks render as literal characters in Slack and look broken.
- A bullet line starts with "- ". No nested bullets.
- No markdown headers (## etc.) inside lines — the section's own "title" already serves that role.

You'll receive several kinds of data, some narrow (today's calendar, today's tasks, yesterday's notes) and some wide (a 30-day risk watchlist, a 30-day list of notes mentioning dollar amounts). Your job is SYNTHESIS, not transcription:

- **Today's Schedule**: ALWAYS write this section if there is at least one calendar event today — never fold it into or replace it with the Scheduling Conflicts section; they're both needed, not one-or-the-other. List each event with its time range. If an event is marked Out of Office or Focus Time in the data, label it as such plainly (e.g. "🏖️ Out of Office: 2:00–5:00 PM"), don't just list it like a normal meeting. Calendar events only — tasks belong in their own section below, not merged in here.
- **Task Overview**: ALWAYS write this as its own separate section if there's at least one task due today — a distinct section, not folded into Today's Schedule. List each task, with the client it's tied to if there is one.
- **Suggested Follow-Up Tasks**: if a "SUGGESTED FOLLOW-UP TASKS" block appears, write a section for it clearly labeled as suggestions awaiting review, NOT tasks that already exist — e.g. title it "Suggested Follow-Ups (Review)" so it's never confused with the real Task Overview above. Don't claim these are already created. List up to 4 suggestions (not 5, to leave room for the line below), then ALWAYS add this exact line as the final line of this section's body_lines: "Reply /atlas-approve-task <Client Name> to create one, or /atlas-dismiss-task <Client Name> to skip it." This hint line doesn't count against the 5-line cap.
- **Scheduling conflicts**: if a "SCHEDULING CONFLICTS" block appears in the data, those overlaps were already confirmed by exact calendar math — state them plainly as a flagged item (priority: high), IN ADDITION TO the full Today's Schedule section above, not instead of it. Do NOT independently re-check the raw calendar for conflicts yourself; only report what's given in that block, since manually comparing timestamps is exactly the kind of thing worth getting from code, not guessing at.
- **Risk patterns**: don't just repeat each risk_signal verbatim. If the SAME client appears more than once in the 30-day watchlist, say so explicitly — that's an escalating situation, not a one-off, and is far more worth Oscar's attention than a single mention. A client appearing once with a mild flag may not deserve a section at all.
- **Revenue opportunities**: scan the 30-day dollar-amount mentions for genuine expansion/upsell signals (a client asking about upgrading, adding a product, increasing spend) — NOT every dollar figure is an opportunity; a client disputing a charge or asking about a refund is a risk, not an opportunity, and should never be listed here. When genuinely unsure which it is, leave it out rather than guessing.
- **Next best action**: given everything above (commitments, risks, calendar), recommend 1-3 concrete next actions if there's a clear one — skip this if nothing rises to the level of an actual recommendation. Mark this section priority: high when it exists.
- Only include a section if there's real signal for it, EXCEPT Today's Schedule (always included when there's at least one event) and Task Overview (always included when there's at least one task due today) — those two are always shown when they have any data at all. A single lukewarm data point elsewhere is not a "trend" — omit the section entirely rather than manufacturing one, and don't pad a thin section with restated data just to give it substance.
- HARD CAP, regardless of how much raw data you're given: at most 5 lines in any single section's "body_lines". If a section (risk watchlist, revenue signals, open commitments) has more real candidates than that, pick the 5 most significant ones and write one final line like "- plus N more — check the Hub for the full list" rather than trying to list everything. This matters because the underlying data grows over time as more notes accumulate; a fixed line cap keeps output length predictable regardless of how much history exists.
- Never invent a fact, a date, or a client name not present in the data given.
- Open commitments are an approximate flag, not a guarantee they're outstanding — phrase as "worth checking," not certainty.
- Choose each section's emoji to match its actual content — 📅 scheduling, 💰 money/opportunity, ⚠️ risk/urgency, 📝 notes, ✅ on track, 🎯 recommended action — not the same icon for everything.
- Within a line, an inline emoji next to one specific flagged item is fine; don't add emoji to every line.
- Keep the whole thing readable in under a minute.
- "signoff": if a clear top-priority action exists, point at it directly (e.g. "Start with the Yelp escalation — everything else can wait for that.") rather than a generic closing line. Only fall back to a light, warm closer on a genuinely quiet day with no high-priority section.
- Do not write a greeting — that's added separately, outside your output.`;

async function composeWithClaude({ calendarEvents, tasksDueToday, openCommitments, highlights, riskWatchlist, revenueSignals, taskSuggestions }) {
  const parts = [];
  const conflicts = detectScheduleConflicts(calendarEvents);
  if (conflicts.length) {
    parts.push(
      "SCHEDULING CONFLICTS (confirmed by exact time comparison, not an estimate):\n" +
        conflicts.map((c) => `- "${c.a}" (${c.aRange}) overlaps "${c.b}" (${c.bRange})`).join("\n")
    );
  }
  if (calendarEvents.length) {
    parts.push(
      "TODAY'S CALENDAR:\n" +
        calendarEvents
          .map((e) => {
            const label = e.eventType === "outOfOffice" ? " [OUT OF OFFICE]" : e.eventType === "focusTime" ? " [FOCUS TIME]" : "";
            return `- ${e.summary}${label} (${e.start} to ${e.end})`;
          })
          .join("\n")
    );
  }
  if (tasksDueToday.length) {
    parts.push(
      "TASKS DUE TODAY (from the Hub's own task list, not Google Tasks):\n" +
        tasksDueToday.map((t) => `- ${t.title}${t.client_name ? ` (${t.client_name})` : ""}`).join("\n")
    );
  }
  if (taskSuggestions.length) {
    parts.push(
      "SUGGESTED FOLLOW-UP TASKS (ATLAS spotted these in recent notes -- NOT yet real tasks, awaiting Oscar's review):\n" +
        taskSuggestions
          .map((s) => `- ${s.suggested_title}${s.client_name ? ` (${s.client_name})` : ""} — from ${new Date(s.note_date).toDateString()}`)
          .join("\n")
    );
  }
  if (openCommitments.length) {
    parts.push(
      "OPEN COMMITMENTS (from notes, may need a task created):\n" +
        openCommitments
          .map(
            (n) =>
              `- ${n.client_name} (${new Date(n.note_date).toDateString()}): ` +
              `mine: ${JSON.stringify(n.my_commitments)}, theirs: ${JSON.stringify(n.their_commitments)}`
          )
          .join("\n")
    );
  }
  if (highlights.length) {
    parts.push(
      "RECENT NOTE HIGHLIGHTS (last ~24h):\n" +
        highlights
          .map(
            (n) =>
              `- ${n.client_name} (${new Date(n.note_date).toDateString()}, ${n.sentiment || "unknown sentiment"}): ${n.summary}` +
              (n.risk_signals?.length ? ` [risk: ${n.risk_signals.join("; ")}]` : "")
          )
          .join("\n")
    );
  }
  if (riskWatchlist.length) {
    parts.push(
      "RISK WATCHLIST (last 30 days, ALL clients — look for repeat mentions of the same client):\n" +
        riskWatchlist
          .map((n) => `- ${n.client_name} (${new Date(n.note_date).toDateString()}): ${n.risk_signals.join("; ")}`)
          .join("\n")
    );
  }
  if (revenueSignals.length) {
    parts.push(
      "DOLLAR-AMOUNT MENTIONS (last 30 days — decide which are genuine opportunities vs. risks/complaints):\n" +
        revenueSignals
          .map((n) => `- ${n.client_name} (${new Date(n.note_date).toDateString()}): ${n.amounts_mentioned.join(", ")} — context: ${n.summary || "(no summary)"}`)
          .join("\n")
    );
  }

  if (parts.length === 0) {
    return {
      executive_summary: "Quiet one this morning — nothing on the calendar, no flagged commitments, nothing new in the notes over the last day.",
      kpi_snapshot: { meetings: calendarEvents.length, open_follow_ups: openCommitments.length, risks_flagged: 0, revenue_opportunities: 0 },
      sections: [],
      signoff: "🌤️ Nothing urgent today.",
    };
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 4096, // raised again from 3000 (2026-07-30): a third real
      // failure at 3000 confirms this isn't "need a slightly bigger number" --
      // raw data volume (risk watchlist, revenue signals, highlights) grows
      // as ATLAS accumulates history, so any fixed ceiling eventually gets
      // outrun again. The durable fix is bounding OUTPUT length explicitly
      // in the prompt (see "at most N items per section" below), not just
      // repeatedly raising this number as data keeps growing over weeks.
      system: BRIEF_SYSTEM_PROMPT,
      messages: [{ role: "user", content: parts.join("\n\n---\n\n") }],
    }),
  });
  if (!res.ok) throw new Error(`Claude brief composition failed (${res.status}): ${await res.text().catch(() => "")}`);
  const data = await res.json();
  if (data.stop_reason === "max_tokens") {
    console.error("atlas-brief-background: Claude hit max_tokens — response was truncated. Consider raising the budget further.");
  }
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("Claude response had no text block");

  const cleaned = textBlock.text.trim().replace(/^```json\s*/i, "").replace(/```$/, "");
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    // If this ever fails again, the raw text (not just "invalid JSON") is
    // what actually lets someone diagnose it from the function log alone.
    console.error("atlas-brief-background: JSON.parse failed on Claude's response:", e.message);
    console.error("atlas-brief-background: raw response was:", cleaned.slice(0, 2000));
    throw e;
  }

  // meetings/open_follow_ups are known exactly from code (calendarEvents.length,
  // openCommitments.length) -- no reason to trust Claude's arithmetic for
  // numbers we already have precisely. risks_flagged/revenue_opportunities
  // DO need to come from Claude, since they reflect its own post-filtering
  // judgment about what actually counted as a risk vs. an opportunity.
  parsed.kpi_snapshot = {
    meetings: calendarEvents.length,
    open_follow_ups: openCommitments.length,
    risks_flagged: parsed.kpi_snapshot?.risks_flagged ?? 0,
    revenue_opportunities: parsed.kpi_snapshot?.revenue_opportunities ?? 0,
  };
  return parsed;
}

// ---- Turns the structured brief into real Slack Block Kit: a header,
// a section + divider per topic, and a small context block for the
// sign-off — rather than one plain text blob with markdown that Slack
// doesn't actually render (Slack's mrkdwn uses *single* asterisks for
// bold, not standard markdown's **double** asterisks). ----
// Greeting is deterministic, not LLM-generated -- audience (Oscar vs. the
// team channel) is a simple fixed rule, not a judgment call worth leaving
// to chance each run.
function greetingFor(audience) {
  return audience === "team" ? "Good morning, Team ☀️" : "Good morning, Oscar ☀️";
}

function buildSlackBlocks(brief, greeting) {
  const blocks = [{ type: "header", text: { type: "plain_text", text: greeting, emoji: true } }];

  if (brief.executive_summary) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Executive Summary*\n${brief.executive_summary}` } });
  }

  const kpi = brief.kpi_snapshot;
  if (kpi) {
    blocks.push({
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*📅 Meetings*\n${kpi.meetings}` },
        { type: "mrkdwn", text: `*✅ Follow-ups*\n${kpi.open_follow_ups}` },
        { type: "mrkdwn", text: `*⚠️ Risks*\n${kpi.risks_flagged}` },
        { type: "mrkdwn", text: `*💰 Opportunities*\n${kpi.revenue_opportunities}` },
      ],
    });
  }

  if (brief.executive_summary || kpi) blocks.push({ type: "divider" });

  // High-priority sections first -- this is the practical stand-in for
  // "color-coded priority" here: Slack's Block Kit has no real color
  // support (the old attachment color-bar feature is legacy/deprecated),
  // so priority is expressed through emoji plus what Oscar sees first,
  // not an actual color.
  const priorityRank = { high: 0, medium: 1, low: 2 };
  const orderedSections = [...brief.sections].sort(
    (a, b) => (priorityRank[a.priority] ?? 1) - (priorityRank[b.priority] ?? 1)
  );

  orderedSections.forEach((s, i) => {
    const body = (s.body_lines || []).join("\n");
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${s.emoji ? s.emoji + " " : ""}${s.title}*\n${body}` } });
    if (i < orderedSections.length - 1) blocks.push({ type: "divider" });
  });

  if (brief.signoff) {
    if (orderedSections.length) blocks.push({ type: "divider" });
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: brief.signoff }] });
  }

  return blocks;
}

// Plain-text fallback for notifications/screen readers — Slack shows this
// where blocks can't render (push notification previews, etc).
function flattenBriefToText(brief, greeting) {
  const lines = [greeting];
  if (brief.executive_summary) lines.push("", "Executive Summary", brief.executive_summary);
  if (brief.kpi_snapshot) {
    const k = brief.kpi_snapshot;
    lines.push("", `Meetings: ${k.meetings} | Follow-ups: ${k.open_follow_ups} | Risks: ${k.risks_flagged} | Opportunities: ${k.revenue_opportunities}`);
  }
  const priorityRank = { high: 0, medium: 1, low: 2 };
  const orderedSections = [...brief.sections].sort(
    (a, b) => (priorityRank[a.priority] ?? 1) - (priorityRank[b.priority] ?? 1)
  );
  for (const s of orderedSections) {
    lines.push("", `${s.emoji || ""} ${s.title}`.trim(), ...(s.body_lines || []));
  }
  if (brief.signoff) lines.push("", brief.signoff);
  return lines.join("\n");
}

async function postToSlack(target, blocks, fallbackText) {
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
      body: JSON.stringify({ channel: target, blocks, text: fallbackText }),
    });
    const data = await res.json();
    // Slack's API returns HTTP 200 even on failure -- the real success/failure
    // signal is the "ok" field in the JSON body, not the status code. Checking
    // only res.ok (as an earlier version did) let a failed post to a channel
    // the bot isn't a member of disappear with zero trace anywhere.
    if (!data.ok) {
      console.error(`atlas-brief-background: Slack post to ${target} failed:`, data.error);
    }
  } catch (e) {
    console.error(`atlas-brief-background: Slack post to ${target} threw:`, e.message);
  }
}

export default async (req) => {
  if (!isAuthorizedTrigger(req)) {
    console.warn("atlas-brief-background: rejected an unauthorized trigger attempt.");
    return new Response("Forbidden", { status: 403 });
  }

  // Optional on-demand mode: { "on_demand": true, "requester_user_id": "U0..." }
  // Lets someone ask ATLAS for the brief outright (e.g. "please provide
  // brief") instead of waiting for the 10am cron. When on_demand, this
  // DMs only the requester and skips the shared channel post entirely --
  // an ad hoc request shouldn't re-blast the whole team channel every
  // time Oscar happens to ask for it again mid-morning.
  const payload = await req.json().catch(() => ({}));
  const isOnDemand = payload?.on_demand === true;
  const requesterUserId = payload?.requester_user_id || SLACK_USER_ID;

  // Logged BEFORE any real work starts, so a run that fails silently
  // partway through is still visible from Supabase alone -- no need to
  // fight Netlify's log viewer to tell whether a run even began.
  await sbFetch("integration_sync_log", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify([
      {
        integration: "atlas_morning_brief",
        event_type: "run_started",
        direction: "internal",
        detail: isOnDemand ? "triggered on-demand" : "triggered by schedule",
        actor_email: null,
      },
    ]),
  }).catch((e) => console.error("atlas-brief-background: run_started log failed:", e.message));

  try {
    const accessToken = await getFreshGoogleAccessToken();
    const [calendarEvents, tasksDueToday, openCommitments, highlights, riskWatchlist, revenueSignals, taskSuggestions] = await Promise.all([
      getTodayCalendarEvents(accessToken),
      getTasksDueToday(),
      getOpenCommitments(),
      getRecentHighlights(),
      getRiskWatchlist(),
      getRevenueSignals(),
      getPendingTaskSuggestions(),
    ]);

    const brief = await composeWithClaude({ calendarEvents, tasksDueToday, openCommitments, highlights, riskWatchlist, revenueSignals, taskSuggestions });

    const dmBlocks = buildSlackBlocks(brief, greetingFor("oscar"));
    const dmText = flattenBriefToText(brief, greetingFor("oscar"));

    if (isOnDemand) {
      await postToSlack(requesterUserId, dmBlocks, dmText);
    } else {
      const channelBlocks = buildSlackBlocks(brief, greetingFor("team"));
      const channelText = flattenBriefToText(brief, greetingFor("team"));
      await postToSlack(SLACK_CHANNEL_ID, channelBlocks, channelText);
      await postToSlack(SLACK_USER_ID, dmBlocks, dmText);
    }

    const dateStr = mexicoCityDateString();
    await sbFetch("atlas_digests", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify([
        {
          digest_type: isOnDemand ? "morning_brief_on_demand" : "morning_brief",
          for_email: OWNER_EMAIL,
          period_start: `${dateStr}T00:00:00-06:00`,
          period_end: `${dateStr}T23:59:59-06:00`,
          content: dmText,
          delivered_to: isOnDemand ? requesterUserId : `${SLACK_CHANNEL_ID},${SLACK_USER_ID}`,
          delivered_at: new Date().toISOString(),
        },
      ]),
    });

    console.log("atlas-brief-background: brief sent.",
      "on_demand:", isOnDemand,
      "calendar:", calendarEvents.length, "tasks:", tasksDueToday.length, "commitments:", openCommitments.length,
      "highlights:", highlights.length, "risk watchlist:", riskWatchlist.length,
      "revenue signals:", revenueSignals.length);
  } catch (e) {
    console.error("atlas-brief-background: failed:", e.message);
  }
};
