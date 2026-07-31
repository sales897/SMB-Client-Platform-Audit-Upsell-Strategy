// netlify/functions/atlas-weekly-trends-background.mjs
//
// ATLAS — weekly trends report, Fridays. Distinct from the daily
// brief/EOD's risk watchlist (which flags the SAME client repeating
// within 30 days) -- this looks ACROSS clients for shared underlying
// themes, and tracks sentiment trajectory within the week per client.
//
// Sentiment-shift detection is computed deterministically in code, NOT
// left to Claude -- same reasoning as schedule-conflict detection in the
// morning brief: comparing an ordinal progression (positive -> negative)
// is a mechanical comparison, exactly the kind of thing worth getting
// from code rather than asking an LLM to reason about correctly. Cross-
// client THEME clustering ("multiple different clients mentioned pricing
// concerns") is genuinely a synthesis task, left to Claude.
//
// Reuses the same Block Kit / executive-summary / KPI-snapshot / priority
// pattern as the morning brief and EOD, for consistency -- a third
// distinct report shouldn't invent a fourth format.

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ANTHROPIC_API_KEY = Netlify.env.get("ANTHROPIC_API_KEY");
const SLACK_BOT_TOKEN = Netlify.env.get("SLACK_BOT_TOKEN");
const CLAUDE_MODEL = "claude-sonnet-5";

const SLACK_CHANNEL_ID = "C0BLMCCAM3Q"; // #account-management-goats
const SLACK_USER_ID = "U07KALYMG3Z"; // Oscar
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

function mexicoCityDateString(offsetDays = 0, now = new Date()) {
  const local = new Date(now.getTime() + -6 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000);
  return local.toISOString().slice(0, 10);
}

async function getThisWeeksNotes() {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const res = await sbFetch(
    `atlas_notes?select=client_name,note_date,sentiment,risk_signals,opportunity_signals,summary` +
      `&note_date=gte.${since}&order=note_date.asc&limit=200`
  );
  if (!res.ok) {
    console.error("atlas-weekly-trends-background: notes fetch failed:", await res.text().catch(() => ""));
    return [];
  }
  return res.json();
}

// ---- Deterministic sentiment-shift detection -- NOT left to Claude.
// Ordinal ranking lets a "positive -> negative" progression be detected
// as a hard fact, same reasoning as schedule-conflict detection. ----
function sentimentRank(s) {
  return { positive: 2, neutral: 1, mixed: 1, negative: 0 }[s] ?? 1;
}

function detectSentimentShifts(notes) {
  const byClient = {};
  for (const n of notes) {
    if (!n.client_name) continue;
    (byClient[n.client_name] ||= []).push(n);
  }
  const shifts = [];
  for (const [client, list] of Object.entries(byClient)) {
    if (list.length < 2) continue; // need at least 2 notes this week to detect a shift at all
    const sorted = [...list].sort((a, b) => new Date(a.note_date) - new Date(b.note_date));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const delta = sentimentRank(last.sentiment) - sentimentRank(first.sentiment);
    if (delta <= -1) {
      shifts.push({ client, direction: "declining", from: first.sentiment, to: last.sentiment, noteCount: sorted.length });
    } else if (delta >= 1) {
      shifts.push({ client, direction: "improving", from: first.sentiment, to: last.sentiment, noteCount: sorted.length });
    }
  }
  return shifts;
}

const WEEKLY_TRENDS_SYSTEM_PROMPT = `You are ATLAS, composing Oscar's weekly trends report for Slack, rendered as Slack Block Kit. Respond with ONLY a JSON object, no prose, no markdown fences, matching exactly this shape:

{
  "executive_summary": "1-2 sentences: the shape of the week at a glance",
  "sections": [
    { "emoji": "one emoji matching this section's actual content", "title": "short, concrete title, 2-4 words", "body_lines": ["line one", "line two"], "priority": "high" | "medium" | "low" }
  ],
  "signoff": "one short closing line"
}

"body_lines" is an array -- one entry per line, never one string with embedded line breaks (that produces invalid JSON).

Formatting (Slack mrkdwn, NOT standard markdown):
- Bold is *single asterisks*, never **double asterisks**.
- Bullets are lines starting with "- ".

You'll receive: this week's notes (client, date, sentiment, risk signals, opportunity signals, summary) across ALL clients, and a pre-computed list of SENTIMENT SHIFTS (already confirmed by exact ordinal comparison -- state these plainly, do not re-derive or second-guess them).

Your real job here is different from the daily brief: look ACROSS clients for shared underlying THEMES, not just list each client's individual risk again.
- **Risk Themes**: if multiple DIFFERENT clients this week mention a similar underlying issue (pricing/budget concerns, service quality, communication gaps, competitor mentions, etc.), name the theme explicitly and which clients — e.g. "3 clients (X, Y, Z) raised pricing concerns this week." A single client's risk, even if serious, belongs in the DAILY brief, not here — only include it here if it's part of a genuine cross-client pattern. If nothing rises to a real cross-client theme, omit this section rather than forcing individual risks into it.
- **Sentiment Shifts**: report the pre-computed shifts plainly, grouped by direction (declining is priority: high, improving is priority: low but worth noting positively).
- **Opportunity Themes**: same cross-client theme logic as Risk Themes, applied to opportunity signals.
- Only include a section if there's genuine cross-client signal for it — a report with fewer, well-supported sections is better than one padded with restated single-client data.
- HARD CAP: at most 5 lines per section, regardless of how much data exists. Pick the most significant and add "- plus N more" if there's overflow.
- Never invent a fact, client name, or date not present in the data.
- Do not write a greeting — that's added separately, outside your output.`;

async function composeWithClaude(notes, sentimentShifts) {
  const parts = [];

  if (sentimentShifts.length) {
    parts.push(
      "SENTIMENT SHIFTS THIS WEEK (pre-computed, confirmed by exact ordinal comparison):\n" +
        sentimentShifts.map((s) => `- ${s.client}: ${s.from} → ${s.to} (${s.direction}, across ${s.noteCount} notes)`).join("\n")
    );
  }

  const withRisk = notes.filter((n) => n.risk_signals?.length);
  if (withRisk.length) {
    parts.push(
      "ALL RISK SIGNALS THIS WEEK (across all clients, look for shared themes):\n" +
        withRisk.map((n) => `- ${n.client_name}: ${n.risk_signals.join("; ")}`).join("\n")
    );
  }

  const withOpp = notes.filter((n) => n.opportunity_signals?.length);
  if (withOpp.length) {
    parts.push(
      "ALL OPPORTUNITY SIGNALS THIS WEEK (across all clients, look for shared themes):\n" +
        withOpp.map((n) => `- ${n.client_name}: ${n.opportunity_signals.join("; ")}`).join("\n")
    );
  }

  if (parts.length === 0) {
    return {
      executive_summary: "A quiet week — no risk or opportunity signals logged, no notable sentiment shifts.",
      sections: [],
      signoff: "Nothing trending either direction this week.",
    };
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 3000, // generous from the start -- learned this lesson twice already today on the daily reports
      system: WEEKLY_TRENDS_SYSTEM_PROMPT,
      messages: [{ role: "user", content: parts.join("\n\n---\n\n") }],
    }),
  });
  if (!res.ok) throw new Error(`Claude weekly trends composition failed (${res.status}): ${await res.text().catch(() => "")}`);
  const data = await res.json();
  if (data.stop_reason === "max_tokens") {
    console.error("atlas-weekly-trends-background: Claude hit max_tokens -- response was truncated.");
  }
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("Claude response had no text block");

  const cleaned = textBlock.text.trim().replace(/^```json\s*/i, "").replace(/```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error("atlas-weekly-trends-background: JSON.parse failed:", e.message);
    console.error("atlas-weekly-trends-background: raw response was:", cleaned.slice(0, 2000));
    throw e;
  }
}

function greetingFor(audience) {
  return audience === "team" ? "Weekly Trends — Team 📊" : "Weekly Trends, Oscar 📊";
}

function buildKpiSnapshot(notes, sentimentShifts) {
  return {
    notes_analyzed: notes.length,
    clients_covered: new Set(notes.map((n) => n.client_name).filter(Boolean)).size,
    sentiment_declines: sentimentShifts.filter((s) => s.direction === "declining").length,
    sentiment_improvements: sentimentShifts.filter((s) => s.direction === "improving").length,
  };
}

function buildSlackBlocks(report, greeting, kpi) {
  const blocks = [{ type: "header", text: { type: "plain_text", text: greeting, emoji: true } }];

  if (report.executive_summary) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Executive Summary*\n${report.executive_summary}` } });
  }

  blocks.push({
    type: "section",
    fields: [
      { type: "mrkdwn", text: `*📝 Notes*\n${kpi.notes_analyzed}` },
      { type: "mrkdwn", text: `*👥 Clients*\n${kpi.clients_covered}` },
      { type: "mrkdwn", text: `*📉 Declining*\n${kpi.sentiment_declines}` },
      { type: "mrkdwn", text: `*📈 Improving*\n${kpi.sentiment_improvements}` },
    ],
  });
  blocks.push({ type: "divider" });

  const priorityRank = { high: 0, medium: 1, low: 2 };
  const ordered = [...report.sections].sort((a, b) => (priorityRank[a.priority] ?? 1) - (priorityRank[b.priority] ?? 1));

  ordered.forEach((s, i) => {
    const body = (s.body_lines || []).join("\n");
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${s.emoji ? s.emoji + " " : ""}${s.title}*\n${body}` } });
    if (i < ordered.length - 1) blocks.push({ type: "divider" });
  });

  if (report.signoff) {
    if (ordered.length) blocks.push({ type: "divider" });
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: report.signoff }] });
  }

  return blocks;
}

function flattenToText(report, greeting, kpi) {
  const lines = [greeting];
  if (report.executive_summary) lines.push("", "Executive Summary", report.executive_summary);
  lines.push("", `Notes: ${kpi.notes_analyzed} | Clients: ${kpi.clients_covered} | Declining: ${kpi.sentiment_declines} | Improving: ${kpi.sentiment_improvements}`);
  const priorityRank = { high: 0, medium: 1, low: 2 };
  const ordered = [...report.sections].sort((a, b) => (priorityRank[a.priority] ?? 1) - (priorityRank[b.priority] ?? 1));
  for (const s of ordered) {
    lines.push("", `${s.emoji || ""} ${s.title}`.trim(), ...(s.body_lines || []));
  }
  if (report.signoff) lines.push("", report.signoff);
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
    if (!data.ok) console.error(`atlas-weekly-trends-background: Slack post to ${target} failed:`, data.error);
  } catch (e) {
    console.error(`atlas-weekly-trends-background: Slack post to ${target} threw:`, e.message);
  }
}

export default async (req) => {
  if (!isAuthorizedTrigger(req)) {
    console.warn("atlas-weekly-trends-background: rejected an unauthorized trigger attempt.");
    return new Response("Forbidden", { status: 403 });
  }

  // Same run-started logging pattern as the morning brief -- so a silent
  // failure is diagnosable from Supabase alone, not just Netlify's logs.
  await sbFetch("integration_sync_log", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify([{ integration: "atlas_weekly_trends", event_type: "run_started", direction: "internal", detail: "triggered by schedule", actor_email: null }]),
  }).catch((e) => console.error("atlas-weekly-trends-background: run_started log failed:", e.message));

  try {
    const notes = await getThisWeeksNotes();
    const sentimentShifts = detectSentimentShifts(notes);
    const report = await composeWithClaude(notes, sentimentShifts);
    const kpi = buildKpiSnapshot(notes, sentimentShifts);

    const channelBlocks = buildSlackBlocks(report, greetingFor("team"), kpi);
    const channelText = flattenToText(report, greetingFor("team"), kpi);
    const dmBlocks = buildSlackBlocks(report, greetingFor("oscar"), kpi);
    const dmText = flattenToText(report, greetingFor("oscar"), kpi);

    await postToSlack(SLACK_CHANNEL_ID, channelBlocks, channelText);
    await postToSlack(SLACK_USER_ID, dmBlocks, dmText);

    const dateStr = mexicoCityDateString();
    await sbFetch("atlas_digests", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify([
        {
          digest_type: "weekly_trends",
          for_email: OWNER_EMAIL,
          period_start: `${mexicoCityDateString(-7)}T00:00:00-06:00`,
          period_end: `${dateStr}T23:59:59-06:00`,
          content: dmText,
          delivered_to: `${SLACK_CHANNEL_ID},${SLACK_USER_ID}`,
          delivered_at: new Date().toISOString(),
        },
      ]),
    });

    console.log("atlas-weekly-trends-background: report sent.", "notes:", notes.length, "sentiment shifts:", sentimentShifts.length);
  } catch (e) {
    console.error("atlas-weekly-trends-background: failed:", e.message);
  }
};
