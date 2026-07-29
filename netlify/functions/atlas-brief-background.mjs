// netlify/functions/atlas-brief-background.mjs
//
// ATLAS — daily morning brief. Pulls three things and has Claude weave
// them into one Slack-readable brief:
//   1. Today's Google Calendar events
//   2. "Open commitments" — things Oscar or a client promised in a recent
//      call note that don't appear to have a matching client_tasks entry
//   3. Highlights from notes enriched in roughly the last 24 hours
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
  }));
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
      `&note_date=gte.${since}&or=(my_commitments.neq.[],their_commitments.neq.[])`
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

const BRIEF_SYSTEM_PROMPT = `You are ATLAS, composing Oscar's daily morning brief for Slack, rendered as Slack Block Kit. Respond with ONLY a JSON object, no prose, no markdown fences, matching exactly this shape:

{
  "sections": [
    { "emoji": "one emoji that fits this section's actual content", "title": "short title, 2-4 words", "body": "the content, in Slack mrkdwn" }
  ],
  "signoff": "one short warm closing line"
}

Formatting rules for "body" (this is Slack's mrkdwn, NOT standard markdown):
- Bold is *single asterisks*, never **double asterisks** — double asterisks render as literal characters in Slack and look broken.
- Bullets are a line starting with "- ", one item per line. No nested bullets.
- No headers inside body text (## etc.) — the section's own "title" already serves that role.

Content rules:
- Only include a section if there's real data for it. Omit sections entirely rather than writing "nothing today."
- Choose each section's emoji to match its actual content — 📅 for scheduling, 💰 for money or collections, ⚠️ for risk or urgency, 📝 for notes/highlights, ✅ for things on track — not the same icon for everything.
- Within a body, an inline emoji next to one specific flagged item (a risk, a dollar figure) is fine; don't add emoji to every line — sparing and purposeful, not decorative.
- Never invent anything not present in the data given.
- Open commitments are an approximate flag, not a guarantee they're outstanding — phrase as "worth checking," not certainty.
- Keep the whole thing readable in under a minute.
- Do not write a greeting — that's added separately, outside your output.`;

async function composeWithClaude({ calendarEvents, openCommitments, highlights }) {
  const parts = [];
  if (calendarEvents.length) {
    parts.push(
      "TODAY'S CALENDAR:\n" +
        calendarEvents.map((e) => `- ${e.summary} (${e.start} to ${e.end})`).join("\n")
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

  if (parts.length === 0) {
    return {
      sections: [],
      signoff: "Quiet one this morning 🌤️ — no calendar events, no flagged commitments, nothing new in the notes over the last day.",
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
      max_tokens: 1200,
      system: BRIEF_SYSTEM_PROMPT,
      messages: [{ role: "user", content: parts.join("\n\n---\n\n") }],
    }),
  });
  if (!res.ok) throw new Error(`Claude brief composition failed (${res.status}): ${await res.text().catch(() => "")}`);
  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("Claude response had no text block");

  const cleaned = textBlock.text.trim().replace(/^```json\s*/i, "").replace(/```$/, "");
  return JSON.parse(cleaned);
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

  brief.sections.forEach((s, i) => {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${s.emoji ? s.emoji + " " : ""}${s.title}*\n${s.body}` } });
    if (i < brief.sections.length - 1) blocks.push({ type: "divider" });
  });

  if (brief.signoff) {
    if (brief.sections.length) blocks.push({ type: "divider" });
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: brief.signoff }] });
  }

  return blocks;
}

// Plain-text fallback for notifications/screen readers — Slack shows this
// where blocks can't render (push notification previews, etc).
function flattenBriefToText(brief, greeting) {
  const lines = [greeting];
  for (const s of brief.sections) {
    lines.push("", `${s.emoji || ""} ${s.title}`.trim(), s.body);
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

  try {
    const accessToken = await getFreshGoogleAccessToken();
    const [calendarEvents, openCommitments, highlights] = await Promise.all([
      getTodayCalendarEvents(accessToken),
      getOpenCommitments(),
      getRecentHighlights(),
    ]);

    const brief = await composeWithClaude({ calendarEvents, openCommitments, highlights });

    const dmBlocks = buildSlackBlocks(brief, greetingFor("oscar"));
    const dmText = flattenBriefToText(brief, greetingFor("oscar"));
    const channelBlocks = buildSlackBlocks(brief, greetingFor("team"));
    const channelText = flattenBriefToText(brief, greetingFor("team"));

    await postToSlack(SLACK_CHANNEL_ID, channelBlocks, channelText);
    await postToSlack(SLACK_USER_ID, dmBlocks, dmText);

    const dateStr = mexicoCityDateString();
    await sbFetch("atlas_digests", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify([
        {
          digest_type: "morning_brief",
          for_email: OWNER_EMAIL,
          period_start: `${dateStr}T00:00:00-06:00`,
          period_end: `${dateStr}T23:59:59-06:00`,
          content: dmText,
          delivered_to: `${SLACK_CHANNEL_ID},${SLACK_USER_ID}`,
          delivered_at: new Date().toISOString(),
        },
      ]),
    });

    console.log("atlas-brief-background: brief sent.",
      "calendar:", calendarEvents.length, "commitments:", openCommitments.length, "highlights:", highlights.length);
  } catch (e) {
    console.error("atlas-brief-background: failed:", e.message);
  }
};
