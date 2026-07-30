// netlify/functions/atlas-eod-background.mjs
//
// ATLAS — end-of-day recap. Mirrors atlas-brief-background.mjs's overall
// shape (Block Kit, executive summary, KPI snapshot, priority-ordered
// sections, Claude synthesis) but looking backward at today instead of
// forward, plus a look at tomorrow:
//   1. Today's meetings that have already happened
//   2. Tasks completed today / tasks still outstanding
//   3. Client updates — notes actually logged today
//   4. Growth/sales signals mentioned in today's notes specifically
//   5. Tomorrow's priorities — tomorrow's calendar + still-open commitments/risks
//
// Posted to BOTH the shared Slack channel and a DM to Oscar, same as the
// morning brief. Same Google Calendar approach as atlas-brief-background.mjs
// (mints its own access token from the stored refresh token — see that
// file's header comment for why the browser-oriented refresh function
// can't be used here).

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ANTHROPIC_API_KEY = Netlify.env.get("ANTHROPIC_API_KEY");
const SLACK_BOT_TOKEN = Netlify.env.get("SLACK_BOT_TOKEN");
const GOOGLE_OAUTH_CLIENT_SECRET = Netlify.env.get("GOOGLE_OAUTH_CLIENT_SECRET");

const GOOGLE_CALENDAR_CLIENT_ID =
  "512550241298-me0g34krgime9v61pij5ir9610h7iqlo.apps.googleusercontent.com";

const SLACK_CHANNEL_ID = "C0BLMCCAM3Q"; // #account-management-goats
const SLACK_USER_ID = "U07KALYMG3Z"; // Oscar
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
function mexicoCityDateString(offsetDays = 0, now = new Date()) {
  const local = new Date(now.getTime() + -6 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000);
  return local.toISOString().slice(0, 10);
}

// ---- Google Calendar (same approach as atlas-brief-background.mjs) ----
async function getFreshGoogleAccessToken() {
  const res = await sbFetch(
    `google_calendar_tokens?select=refresh_token&owner_email=eq.${encodeURIComponent(OWNER_EMAIL)}&limit=1`
  );
  if (!res.ok) throw new Error(`Could not load google_calendar_tokens (${res.status})`);
  const rows = await res.json();
  if (!rows.length) return null;

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
    console.error("atlas-eod-background: Google token refresh failed:", await tokenRes.text().catch(() => ""));
    return null;
  }
  const data = await tokenRes.json();
  return data.access_token || null;
}

async function getCalendarEventsForDate(accessToken, dateStr) {
  if (!accessToken) return [];
  const timeMin = `${dateStr}T00:00:00-06:00`;
  const timeMax = `${dateStr}T23:59:59-06:00`;
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
    `timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}` +
    `&singleEvents=true&orderBy=startTime`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    console.error("atlas-eod-background: Calendar fetch failed:", await res.text().catch(() => ""));
    return [];
  }
  const data = await res.json();
  return (data.items || []).map((e) => ({
    summary: e.summary || "(untitled event)",
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
  }));
}

// ---- Tasks: completed today (status=completed, updated today) and
// still outstanding (status != completed) ----
async function getTasksCompletedToday() {
  const dateStr = mexicoCityDateString();
  const since = `${dateStr}T00:00:00-06:00`;
  const res = await sbFetch(
    `client_tasks?select=client_name,title,updated_at&status=eq.completed&updated_at=gte.${since}`
  );
  if (!res.ok) {
    console.error("atlas-eod-background: completed tasks fetch failed:", await res.text().catch(() => ""));
    return [];
  }
  return res.json();
}

async function getOutstandingTasks() {
  const res = await sbFetch(
    `client_tasks?select=client_name,title,due_date,status&status=neq.completed&order=due_date.asc.nullslast&limit=20`
  );
  if (!res.ok) {
    console.error("atlas-eod-background: outstanding tasks fetch failed:", await res.text().catch(() => ""));
    return [];
  }
  return res.json();
}

// ---- Client updates: notes actually logged/dated TODAY specifically
// (not a trailing-24h window like the morning brief's "recent highlights"
// -- this is meant to answer "what happened today", so it's scoped to
// today's calendar date). ----
async function getClientUpdatesToday() {
  const dateStr = mexicoCityDateString();
  const since = `${dateStr}T00:00:00-06:00`;
  const until = `${dateStr}T23:59:59-06:00`;
  const res = await sbFetch(
    `atlas_notes?select=client_name,summary,sentiment,note_date` +
      `&note_date=gte.${since}&note_date=lte.${until}&order=note_date.asc&limit=20`
  );
  if (!res.ok) {
    console.error("atlas-eod-background: client updates fetch failed:", await res.text().catch(() => ""));
    return [];
  }
  return res.json();
}

// ---- Growth/sales signals mentioned specifically in TODAY's notes (the
// morning brief already covers a 30-day trend view of this -- this is
// the narrower "did anything come up today" version). ----
async function getGrowthSignalsToday() {
  const dateStr = mexicoCityDateString();
  const since = `${dateStr}T00:00:00-06:00`;
  const until = `${dateStr}T23:59:59-06:00`;
  const res = await sbFetch(
    `atlas_notes?select=client_name,note_date,summary,amounts_mentioned,opportunity_signals` +
      `&note_date=gte.${since}&note_date=lte.${until}` +
      `&or=(amounts_mentioned.neq.[],opportunity_signals.neq.[])`
  );
  if (!res.ok) {
    console.error("atlas-eod-background: growth signals fetch failed:", await res.text().catch(() => ""));
    return [];
  }
  return res.json();
}

// ---- Tomorrow's priorities: reuses the same "open commitments" and
// "risk watchlist" logic as the morning brief, since those are inherently
// forward-looking regardless of which report is asking. ----
async function getOpenCommitments() {
  const since = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString();
  const notesRes = await sbFetch(
    `atlas_notes?select=client_name,note_date,my_commitments,their_commitments` +
      `&note_date=gte.${since}&or=(my_commitments.neq.[],their_commitments.neq.[])`
  );
  if (!notesRes.ok) return [];
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

function isTimedEventPast(event, now) {
  // All-day events (date, not dateTime) don't get a "past" comparison —
  // a full-day calendar block isn't meaningfully "completed" the way a
  // real meeting with an end time is.
  if (!event.end || !event.end.includes("T")) return false;
  return new Date(event.end).getTime() < now;
}

const EOD_SYSTEM_PROMPT = `You are ATLAS, composing Oscar's end-of-day recap for Slack, rendered as Slack Block Kit. Respond with ONLY a JSON object, no prose, no markdown fences, matching exactly this shape:

{
  "executive_summary": "1-2 sentences: how today actually went, at a glance",
  "sections": [
    { "emoji": "one emoji matching this section's actual content", "title": "short, concrete title, 2-4 words", "body_lines": ["line one", "line two"], "priority": "high" | "medium" | "low" }
  ],
  "signoff": "one short closing line, ideally pointing at tomorrow's most important thing"
}

"body_lines" is an array — one entry per line, never one string with embedded line breaks (that produces invalid JSON).

Formatting (Slack mrkdwn, NOT standard markdown):
- Bold is *single asterisks*, never **double asterisks**.
- Bullets are lines starting with "- ". No nested bullets, no markdown headers.

You'll receive: today's completed meetings, tasks completed/outstanding, client updates logged today, any growth/sales signals from today specifically, and a forward-looking set (tomorrow's calendar, still-open commitments, a 30-day risk watchlist) for the "Tomorrow's Priorities" section.

Rules:
- Only include a section if there's real data for it. No data for a category = no section for it, not a placeholder saying "none today."
- Give a fair, honest recap — this isn't a highlight reel. If today was quiet, say so plainly in the executive summary rather than manufacturing substance.
- "Tomorrow's Priorities" should be forward-looking and concrete: what specifically needs attention first thing tomorrow, drawn from the forward-looking data given.
- Never invent a fact, date, or client name not present in the data.
- Choose emoji to match actual content: 📅 meetings, ✅ completed, 📋 outstanding, 📝 client updates, 💰 growth/sales, 🔭 tomorrow.
- Keep the whole thing readable in under a minute.
- Do not write a greeting — that's added separately, outside your output.`;

async function composeWithClaude(data) {
  const { meetingsCompleted, tasksCompleted, tasksOutstanding, clientUpdates, growthSignals, tomorrowEvents, openCommitments, riskWatchlist } = data;
  const parts = [];

  if (meetingsCompleted.length) {
    parts.push("MEETINGS COMPLETED TODAY:\n" + meetingsCompleted.map((e) => `- ${e.summary}`).join("\n"));
  }
  if (tasksCompleted.length) {
    parts.push(
      "TASKS COMPLETED TODAY:\n" +
        tasksCompleted.map((t) => `- ${t.title}${t.client_name ? ` (${t.client_name})` : ""}`).join("\n")
    );
  }
  if (tasksOutstanding.length) {
    parts.push(
      "OUTSTANDING TASKS:\n" +
        tasksOutstanding
          .map((t) => `- ${t.title}${t.client_name ? ` (${t.client_name})` : ""}${t.due_date ? ` — due ${new Date(t.due_date).toDateString()}` : ""}`)
          .join("\n")
    );
  }
  if (clientUpdates.length) {
    parts.push(
      "CLIENT UPDATES LOGGED TODAY:\n" +
        clientUpdates.map((n) => `- ${n.client_name} (${n.sentiment || "unknown sentiment"}): ${n.summary}`).join("\n")
    );
  }
  if (growthSignals.length) {
    parts.push(
      "GROWTH/SALES SIGNALS FROM TODAY:\n" +
        growthSignals
          .map((n) => {
            const bits = [];
            if (n.amounts_mentioned?.length) bits.push(n.amounts_mentioned.join(", "));
            if (n.opportunity_signals?.length) bits.push(n.opportunity_signals.join("; "));
            return `- ${n.client_name}: ${bits.join(" | ")}`;
          })
          .join("\n")
    );
  }
  if (tomorrowEvents.length) {
    parts.push("TOMORROW'S CALENDAR:\n" + tomorrowEvents.map((e) => `- ${e.summary} (${e.start} to ${e.end})`).join("\n"));
  }
  if (openCommitments.length) {
    parts.push(
      "STILL-OPEN COMMITMENTS:\n" +
        openCommitments
          .map((n) => `- ${n.client_name} (${new Date(n.note_date).toDateString()}): mine: ${JSON.stringify(n.my_commitments)}, theirs: ${JSON.stringify(n.their_commitments)}`)
          .join("\n")
    );
  }
  if (riskWatchlist.length) {
    parts.push(
      "RISK WATCHLIST (last 30 days):\n" +
        riskWatchlist.map((n) => `- ${n.client_name} (${new Date(n.note_date).toDateString()}): ${n.risk_signals.join("; ")}`).join("\n")
    );
  }

  if (parts.length === 0) {
    return {
      executive_summary: "A quiet day — no completed meetings, no task activity, no new client updates logged.",
      sections: [],
      signoff: "Nothing urgent carrying into tomorrow.",
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
      max_tokens: 1600,
      system: EOD_SYSTEM_PROMPT,
      messages: [{ role: "user", content: parts.join("\n\n---\n\n") }],
    }),
  });
  if (!res.ok) throw new Error(`Claude EOD composition failed (${res.status}): ${await res.text().catch(() => "")}`);
  const resData = await res.json();
  const textBlock = (resData.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("Claude response had no text block");

  const cleaned = textBlock.text.trim().replace(/^```json\s*/i, "").replace(/```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error("atlas-eod-background: JSON.parse failed on Claude's response:", e.message);
    console.error("atlas-eod-background: raw response was:", cleaned.slice(0, 2000));
    throw e;
  }
}

function greetingFor(audience) {
  return audience === "team" ? "Evening Recap — Team 🌙" : "Evening Recap, Oscar 🌙";
}

// KPI snapshot here is fully deterministic -- every one of these counts
// (meetings completed, tasks completed/outstanding, client updates
// logged) is already known exactly from code, unlike the morning brief's
// risk/opportunity counts which depend on Claude's own filtering judgment.
function buildKpiSnapshot({ meetingsCompleted, tasksCompleted, tasksOutstanding, clientUpdates }) {
  return {
    meetings_completed: meetingsCompleted.length,
    tasks_completed: tasksCompleted.length,
    tasks_outstanding: tasksOutstanding.length,
    client_updates: clientUpdates.length,
  };
}

function buildSlackBlocks(brief, greeting, kpi) {
  const blocks = [{ type: "header", text: { type: "plain_text", text: greeting, emoji: true } }];

  if (brief.executive_summary) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Executive Summary*\n${brief.executive_summary}` } });
  }

  blocks.push({
    type: "section",
    fields: [
      { type: "mrkdwn", text: `*📅 Meetings*\n${kpi.meetings_completed}` },
      { type: "mrkdwn", text: `*✅ Tasks Done*\n${kpi.tasks_completed}` },
      { type: "mrkdwn", text: `*📋 Outstanding*\n${kpi.tasks_outstanding}` },
      { type: "mrkdwn", text: `*📝 Updates*\n${kpi.client_updates}` },
    ],
  });

  blocks.push({ type: "divider" });

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

function flattenBriefToText(brief, greeting, kpi) {
  const lines = [greeting];
  if (brief.executive_summary) lines.push("", "Executive Summary", brief.executive_summary);
  lines.push(
    "",
    `Meetings: ${kpi.meetings_completed} | Tasks Done: ${kpi.tasks_completed} | Outstanding: ${kpi.tasks_outstanding} | Updates: ${kpi.client_updates}`
  );
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
    if (!data.ok) {
      console.error(`atlas-eod-background: Slack post to ${target} failed:`, data.error);
    }
  } catch (e) {
    console.error(`atlas-eod-background: Slack post to ${target} threw:`, e.message);
  }
}

export default async (req) => {
  if (!isAuthorizedTrigger(req)) {
    console.warn("atlas-eod-background: rejected an unauthorized trigger attempt.");
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const accessToken = await getFreshGoogleAccessToken();
    const todayStr = mexicoCityDateString(0);
    const tomorrowStr = mexicoCityDateString(1);

    const [todayEvents, tomorrowEvents, tasksCompleted, tasksOutstanding, clientUpdates, growthSignals, openCommitments] =
      await Promise.all([
        getCalendarEventsForDate(accessToken, todayStr),
        getCalendarEventsForDate(accessToken, tomorrowStr),
        getTasksCompletedToday(),
        getOutstandingTasks(),
        getClientUpdatesToday(),
        getGrowthSignalsToday(),
        getOpenCommitments(),
      ]);

    // Risk watchlist reused as-is from the morning brief's own 30-day
    // query logic -- inlined here rather than imported, matching this
    // codebase's convention of self-contained files over shared modules.
    const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const riskRes = await sbFetch(
      `atlas_notes?select=client_name,note_date,risk_signals&note_date=gte.${since30}&risk_signals=neq.[]&order=note_date.desc&limit=40`
    );
    const riskWatchlist = riskRes.ok ? await riskRes.json() : [];

    const now = Date.now();
    const meetingsCompleted = todayEvents.filter((e) => isTimedEventPast(e, now));

    const brief = await composeWithClaude({
      meetingsCompleted,
      tasksCompleted,
      tasksOutstanding,
      clientUpdates,
      growthSignals,
      tomorrowEvents,
      openCommitments,
      riskWatchlist,
    });

    const kpi = buildKpiSnapshot({ meetingsCompleted, tasksCompleted, tasksOutstanding, clientUpdates });

    const dmBlocks = buildSlackBlocks(brief, greetingFor("oscar"), kpi);
    const dmText = flattenBriefToText(brief, greetingFor("oscar"), kpi);
    const channelBlocks = buildSlackBlocks(brief, greetingFor("team"), kpi);
    const channelText = flattenBriefToText(brief, greetingFor("team"), kpi);

    await postToSlack(SLACK_CHANNEL_ID, channelBlocks, channelText);
    await postToSlack(SLACK_USER_ID, dmBlocks, dmText);

    await sbFetch("atlas_digests", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify([
        {
          digest_type: "eod_recap",
          for_email: OWNER_EMAIL,
          period_start: `${todayStr}T00:00:00-06:00`,
          period_end: `${todayStr}T23:59:59-06:00`,
          content: dmText,
          delivered_to: `${SLACK_CHANNEL_ID},${SLACK_USER_ID}`,
          delivered_at: new Date().toISOString(),
        },
      ]),
    });

    console.log(
      "atlas-eod-background: recap sent.",
      "meetings:", meetingsCompleted.length, "tasks done:", tasksCompleted.length,
      "outstanding:", tasksOutstanding.length, "updates:", clientUpdates.length
    );
  } catch (e) {
    console.error("atlas-eod-background: failed:", e.message);
  }
};
