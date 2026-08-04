// netlify/functions/atlas-status-background.mjs
//
// ATLAS — on-demand internal client status report, `/atlas-status
// <Client Name>`. Scoped with Oscar 2026-08-01: internal review only (not
// client-facing), on-demand like /atlas-prep, and folds in BOTH angles of
// "smart note templates" he asked for -- a "What to Cover Next" section
// (the before-a-call need) and a fixed, reusable note-writing template
// (the after-a-call need) -- rather than building two separate commands
// for what's really one underlying need: a consistent structure to work
// from.
//
// Distinct from /atlas-prep: that's a quick 5-bullet pre-call glance at
// the last 2 weeks. This is the fuller picture -- all-time history (up to
// 180 days), sentiment trajectory over that whole window, every risk and
// opportunity signal ever logged for this client, current billing
// snapshot. Internal document, DM only, never posted to the shared
// channel.

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ANTHROPIC_API_KEY = Netlify.env.get("ANTHROPIC_API_KEY");
const SLACK_BOT_TOKEN = Netlify.env.get("SLACK_BOT_TOKEN");
const CLAUDE_MODEL = "claude-sonnet-5";
const HISTORY_DAYS = 180;

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

// Same exact-then-fuzzy matching as atlas-prep-background.mjs -- people
// type client names from memory, not exact stored casing/spelling.
async function findClient(clientNameInput) {
  const exact = await sbFetch(
    `portfolio_clients?select=name,customer_status,billing_status,monthly_rate,last_billing_date,cancellation_date&name=eq.${encodeURIComponent(clientNameInput)}&limit=1`
  );
  if (exact.ok) {
    const rows = await exact.json();
    if (rows.length) return rows[0];
  }
  const fuzzy = await sbFetch(
    `portfolio_clients?select=name,customer_status,billing_status,monthly_rate,last_billing_date,cancellation_date&name=ilike.*${encodeURIComponent(clientNameInput)}*&limit=1`
  );
  if (fuzzy.ok) {
    const rows = await fuzzy.json();
    if (rows.length) return rows[0];
  }
  return null;
}

async function getHistory(clientName) {
  const since = new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const res = await sbFetch(
    `atlas_notes?select=note_date,summary,sentiment,risk_signals,opportunity_signals,my_commitments,their_commitments,amounts_mentioned` +
      `&client_name=eq.${encodeURIComponent(clientName)}&note_date=gte.${since}&order=note_date.asc&limit=100`
  );
  if (!res.ok) return [];
  return res.json();
}

async function getUnpaidBalances(clientName) {
  const [ledgerRes, collectionsRes] = await Promise.all([
    sbFetch(`ledger_entries?select=amount,category,description,due_date&client_name=eq.${encodeURIComponent(clientName)}&resolved_at=is.null`),
    sbFetch(`collections_accounts?select=amount,status&name=eq.${encodeURIComponent(clientName)}&resolved_date=is.null`),
  ]);
  return {
    ledger: ledgerRes.ok ? await ledgerRes.json() : [],
    collections: collectionsRes.ok ? await collectionsRes.json() : [],
  };
}

async function getOpenCommitments(clientName, notes) {
  const hasCommitments = notes.some((n) => n.my_commitments?.length || n.their_commitments?.length);
  if (!hasCommitments) return [];
  const tasksRes = await sbFetch(`client_tasks?select=created_at&client_name=eq.${encodeURIComponent(clientName)}`);
  const tasks = tasksRes.ok ? await tasksRes.json() : [];
  return notes.filter((n) => {
    if (!n.my_commitments?.length && !n.their_commitments?.length) return false;
    return !tasks.some((t) => new Date(t.created_at) > new Date(n.note_date));
  });
}

// ---- Sentiment trajectory: computed deterministically, NOT left to
// Claude -- same reasoning as schedule-conflict detection and the weekly
// trends report's sentiment-shift logic. An ordinal comparison (earliest
// vs. most recent sentiment across the whole history window) is a
// mechanical fact. ----
function sentimentRank(s) {
  return { positive: 2, neutral: 1, mixed: 1, negative: 0 }[s] ?? 1;
}

function computeTrajectory(notes) {
  const withSentiment = notes.filter((n) => n.sentiment);
  if (withSentiment.length < 2) return null;
  const first = withSentiment[0];
  const last = withSentiment[withSentiment.length - 1];
  const delta = sentimentRank(last.sentiment) - sentimentRank(first.sentiment);
  return {
    from: first.sentiment,
    to: last.sentiment,
    direction: delta <= -1 ? "declining" : delta >= 1 ? "improving" : "stable",
    noteCount: withSentiment.length,
  };
}

// ---- Fixed, reusable note-writing template -- the "after a call" half
// of what Oscar asked for. Deliberately NOT generated fresh by Claude
// each time: it should be the same every time (that's the point of a
// template), and it mirrors ATLAS's own enrichment schema fields
// directly, so notes written to this structure enrich more reliably too.
const NOTE_TEMPLATE_LINES = [
  "Discussion Summary — what was actually covered",
  "My Commitments — what I said I'd do, with dates",
  "Their Commitments — what they said they'd do, with dates",
  "Risks or Concerns — anything that sounded like hesitation, frustration, or churn risk",
  "Opportunities — anything that sounded like upsell/expansion interest",
  "Amounts Discussed — any dollar figures mentioned, as stated",
  "Next Step — the single clearest next action",
];

const STATUS_SYSTEM_PROMPT = `You are ATLAS, writing an internal client status report for Oscar's own review — NOT client-facing, never shown to the client. Respond with ONLY a JSON object, no prose, no markdown fences, matching exactly this shape:

{
  "executive_summary": "2-3 sentences: the overall shape of this relationship over the covered period",
  "sections": [
    { "emoji": "one emoji matching this section's actual content", "title": "short, concrete title", "body_lines": ["line one", "line two"], "priority": "high" | "medium" | "low" }
  ],
  "next_to_cover": ["1-3 concrete things worth raising on the next call, based on open items"]
}

"body_lines" and "next_to_cover" are arrays -- one entry per line, never one string with embedded line breaks.

Formatting (Slack mrkdwn, NOT standard markdown): bold is *single asterisks* never **double**, bullets start with "- ".

You'll receive: the full note history for this client (up to 180 days), a pre-computed sentiment trajectory (already confirmed by exact ordinal comparison -- state it plainly, don't re-derive it), current billing/account status, and open commitments.

Rules:
- Only include a section if there's real signal for it in the data given.
- HARD CAP: at most 5 lines per section. Pick the most significant if there's more, add "- plus N more" rather than listing everything.
- Never invent a fact, date, or dollar amount not present in the data.
- This is a relationship-over-time view, not a single-call summary -- synthesize patterns across the whole window, don't just list each note chronologically.
- "next_to_cover" should be concrete and actionable, drawn only from real open items in the data -- not generic advice.`;

async function composeReport(clientName, client, notes, trajectory, balances, openCommitments) {
  const parts = [];

  if (client) {
    const lines = [
      `- Customer status: ${client.customer_status || "unknown"}`,
      `- Billing status: ${client.billing_status || "unknown"}`,
      client.monthly_rate ? `- Monthly rate: $${client.monthly_rate}` : null,
      client.cancellation_date ? `- Cancellation date on file: ${client.cancellation_date}` : null,
    ].filter(Boolean);
    parts.push(`ACCOUNT STATUS:\n${lines.join("\n")}`);
  }

  const unpaidLines = [
    ...balances.ledger.map((l) => `- ${l.category || "charge"}: $${l.amount}${l.due_date ? `, due ${l.due_date}` : ""} — ${l.description || ""}`),
    ...balances.collections.map((c) => `- Collections: $${c.amount}, status: ${c.status}`),
  ];
  if (unpaidLines.length) parts.push(`UNPAID/OUTSTANDING:\n${unpaidLines.join("\n")}`);

  if (trajectory) {
    parts.push(
      `SENTIMENT TRAJECTORY (pre-computed, confirmed by exact ordinal comparison across ${trajectory.noteCount} notes with sentiment):\n` +
        `${trajectory.from} → ${trajectory.to} (${trajectory.direction})`
    );
  }

  if (notes.length) {
    parts.push(
      `FULL NOTE HISTORY (last ${HISTORY_DAYS} days, ${notes.length} notes):\n` +
        notes
          .map(
            (n) =>
              `- ${new Date(n.note_date).toDateString()} (${n.sentiment || "unknown"}): ${n.summary}` +
              (n.risk_signals?.length ? ` [risk: ${n.risk_signals.join("; ")}]` : "") +
              (n.opportunity_signals?.length ? ` [opportunity: ${n.opportunity_signals.join("; ")}]` : "")
          )
          .join("\n")
    );
  } else {
    parts.push(`FULL NOTE HISTORY: none in the last ${HISTORY_DAYS} days.`);
  }

  if (openCommitments.length) {
    parts.push(
      "OPEN COMMITMENTS (no matching task found yet):\n" +
        openCommitments
          .map((n) => `- ${new Date(n.note_date).toDateString()}: mine: ${JSON.stringify(n.my_commitments)}, theirs: ${JSON.stringify(n.their_commitments)}`)
          .join("\n")
    );
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 3000, // generous from day one -- learned this lesson twice already on the daily reports, applying it proactively here
      system: STATUS_SYSTEM_PROMPT,
      messages: [{ role: "user", content: parts.join("\n\n---\n\n") }],
    }),
  });
  if (!res.ok) throw new Error(`Claude status report failed (${res.status}): ${await res.text().catch(() => "")}`);
  const data = await res.json();
  if (data.stop_reason === "max_tokens") {
    console.error("atlas-status-background: Claude hit max_tokens -- response was truncated.");
  }
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("Claude response had no text block");

  const cleaned = textBlock.text.trim().replace(/^```json\s*/i, "").replace(/```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error("atlas-status-background: JSON.parse failed:", e.message);
    console.error("atlas-status-background: raw response was:", cleaned.slice(0, 2000));
    throw e;
  }
}

function buildSlackBlocks(clientName, report) {
  const blocks = [{ type: "header", text: { type: "plain_text", text: `📋 Status: ${clientName}`, emoji: true } }];

  if (report.executive_summary) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Executive Summary*\n${report.executive_summary}` } });
    blocks.push({ type: "divider" });
  }

  const priorityRank = { high: 0, medium: 1, low: 2 };
  const ordered = [...(report.sections || [])].sort((a, b) => (priorityRank[a.priority] ?? 1) - (priorityRank[b.priority] ?? 1));
  ordered.forEach((s, i) => {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${s.emoji ? s.emoji + " " : ""}${s.title}*\n${(s.body_lines || []).join("\n")}` } });
    if (i < ordered.length - 1 || report.next_to_cover?.length) blocks.push({ type: "divider" });
  });

  if (report.next_to_cover?.length) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*🎯 What to Cover Next*\n${report.next_to_cover.map((l) => `- ${l}`).join("\n")}` } });
    blocks.push({ type: "divider" });
  }

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*📝 Note Template for Your Next Write-Up*\n${NOTE_TEMPLATE_LINES.map((l) => `- ${l}`).join("\n")}` },
  });

  return blocks;
}

function flattenToText(clientName, report) {
  const lines = [`Status: ${clientName}`];
  if (report.executive_summary) lines.push("", "Executive Summary", report.executive_summary);
  const priorityRank = { high: 0, medium: 1, low: 2 };
  const ordered = [...(report.sections || [])].sort((a, b) => (priorityRank[a.priority] ?? 1) - (priorityRank[b.priority] ?? 1));
  for (const s of ordered) {
    lines.push("", `${s.emoji || ""} ${s.title}`.trim(), ...(s.body_lines || []));
  }
  if (report.next_to_cover?.length) lines.push("", "What to Cover Next", ...report.next_to_cover.map((l) => `- ${l}`));
  lines.push("", "Note Template for Your Next Write-Up", ...NOTE_TEMPLATE_LINES.map((l) => `- ${l}`));
  return lines.join("\n");
}

async function postDm(userId, blocks, fallbackText) {
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
      body: JSON.stringify({ channel: userId, blocks, text: fallbackText }),
    });
    const data = await res.json();
    if (!data.ok) console.error("atlas-status-background: DM post failed:", data.error);
  } catch (e) {
    console.error("atlas-status-background: DM post threw:", e.message);
  }
}

export default async (req) => {
  if (!isAuthorizedTrigger(req)) {
    console.warn("atlas-status-background: rejected an unauthorized trigger attempt.");
    return new Response("Forbidden", { status: 403 });
  }

  const payload = await req.json().catch(() => null);
  if (!payload?.client_name || !payload?.user_id) {
    console.error("atlas-status-background: missing client_name or user_id in payload");
    return;
  }

  try {
    const client = await findClient(payload.client_name);
    const resolvedName = client?.name || payload.client_name;

    const notes = await getHistory(resolvedName);
    const trajectory = computeTrajectory(notes);
    const [balances, openCommitments] = await Promise.all([
      getUnpaidBalances(resolvedName),
      getOpenCommitments(resolvedName, notes),
    ]);

    const report = await composeReport(resolvedName, client, notes, trajectory, balances, openCommitments);
    const blocks = buildSlackBlocks(resolvedName, report);
    const fallbackText = flattenToText(resolvedName, report);

    await postDm(payload.user_id, blocks, fallbackText);
    console.log(`atlas-status-background: status report sent for "${resolvedName}" to ${payload.user_id}. Notes: ${notes.length}.`);
  } catch (e) {
    console.error("atlas-status-background: failed:", e.message);
    await postDm(
      payload.user_id,
      [{ type: "section", text: { type: "mrkdwn", text: `Something went wrong building the status report for ${payload.client_name}: ${e.message}` } }],
      `Something went wrong building the status report for ${payload.client_name}.`
    ).catch(() => {});
  }
};
