// netlify/functions/atlas-prep-background.mjs
//
// ATLAS — on-demand client prep packet, triggered by `/atlas-prep <client
// name>` in Slack. Scoped per Kevin's request (2026-07-29):
//   - On-demand only, no schedule
//   - Last 2 weeks of call notes
//   - Flag: risk signals, unpaid balances, upcoming renewal, open follow-ups
//   - Quick 5-bullet summary, delivered as a Slack DM
//
// IMPORTANT GAP, called out on purpose, not silently worked around: Kevin
// also wants Yelp Business Partner Dashboard data (Ads Performance,
// Keywords trending, promos). That data does not exist anywhere in this
// Supabase project -- confirmed via a live schema check, no Yelp-specific
// table exists. It's sitting in Yelp's own external partner portal, which
// nothing here has API access to. Rather than fabricate or silently drop
// this, the composed packet always includes an explicit line telling the
// requester to check Yelp's dashboard directly. Building real Yelp Ads
// API access is a separate, larger task (real credentials, a new ingest
// pipeline) -- out of scope for this build.
//
// Similarly, there is no explicit "renewal date" anywhere in the schema.
// This computes an approximate next-billing estimate from
// portfolio_clients.last_billing_date (+1 month) and labels it clearly as
// an estimate, not a real contract date -- worth adding a real field
// later if this proves useful, not fabricated here.
//
// Unlike the morning brief / EOD recap (which always target Oscar), this
// DMs whoever actually typed the slash command -- Kevin included -- since
// it's meant to serve any CS rep who requests it, not just Oscar.

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ANTHROPIC_API_KEY = Netlify.env.get("ANTHROPIC_API_KEY");
const SLACK_BOT_TOKEN = Netlify.env.get("SLACK_BOT_TOKEN");
const CLAUDE_MODEL = "claude-sonnet-5";
const NOTE_LOOKBACK_DAYS = 14; // Kevin: "last two weeks of calls"

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

// ---- Client matching: exact name first, then a fuzzy ilike fallback,
// since Kevin will type a client name from memory, not necessarily
// matching the exact stored casing/spelling. ----
async function findClient(clientNameInput) {
  const exact = await sbFetch(
    `portfolio_clients?select=name,organization,customer_status,billing_status,monthly_rate,last_billing_date,cancellation_date&name=eq.${encodeURIComponent(clientNameInput)}&limit=1`
  );
  if (exact.ok) {
    const rows = await exact.json();
    if (rows.length) return rows[0];
  }
  const fuzzy = await sbFetch(
    `portfolio_clients?select=name,organization,customer_status,billing_status,monthly_rate,last_billing_date,cancellation_date&name=ilike.*${encodeURIComponent(clientNameInput)}*&limit=1`
  );
  if (fuzzy.ok) {
    const rows = await fuzzy.json();
    if (rows.length) return rows[0];
  }
  return null;
}

async function getRecentNotes(clientName) {
  const since = new Date(Date.now() - NOTE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const res = await sbFetch(
    `atlas_notes?select=note_date,summary,sentiment,risk_signals,my_commitments,their_commitments` +
      `&client_name=eq.${encodeURIComponent(clientName)}&note_date=gte.${since}&order=note_date.desc&limit=20`
  );
  if (!res.ok) return [];
  return res.json();
}

async function getUnpaidBalances(clientName) {
  const [ledgerRes, collectionsRes] = await Promise.all([
    sbFetch(`ledger_entries?select=amount,category,description,due_date&client_name=eq.${encodeURIComponent(clientName)}&resolved_at=is.null`),
    sbFetch(`collections_accounts?select=amount,status,notes&name=eq.${encodeURIComponent(clientName)}&resolved_date=is.null`),
  ]);
  const ledger = ledgerRes.ok ? await ledgerRes.json() : [];
  const collections = collectionsRes.ok ? await collectionsRes.json() : [];
  return { ledger, collections };
}

async function getOpenFollowUps(clientName, notes) {
  const hasCommitments = notes.some((n) => n.my_commitments?.length || n.their_commitments?.length);
  if (!hasCommitments) return [];
  const tasksRes = await sbFetch(
    `client_tasks?select=created_at&client_name=eq.${encodeURIComponent(clientName)}`
  );
  const tasks = tasksRes.ok ? await tasksRes.json() : [];
  return notes.filter((n) => {
    if (!n.my_commitments?.length && !n.their_commitments?.length) return false;
    const hasTaskAfter = tasks.some((t) => new Date(t.created_at) > new Date(n.note_date));
    return !hasTaskAfter;
  });
}

function estimateNextBilling(lastBillingDate) {
  if (!lastBillingDate) return null;
  const d = new Date(lastBillingDate);
  d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}

const PREP_SYSTEM_PROMPT = `You are ATLAS, generating a quick pre-call prep packet for a Client Success rep about to talk to a specific client. Respond with ONLY a JSON object, no prose, no markdown fences, matching exactly this shape:

{
  "bullets": ["bullet one", "bullet two", "up to 5 total"]
}

Rules:
- MAXIMUM 5 bullets. This is a quick-glance packet before a call, not a report.
- Each bullet is one Slack mrkdwn line: *bold* for single asterisks (never **double**), no bullets-within-bullets.
- Prioritize in this order if multiple things compete for the 5 slots: (1) unpaid balances or billing risk, (2) risk signals from recent notes, (3) open follow-ups/commitments, (4) upcoming billing estimate, (5) general recent note context.
- If there's a standing note about Yelp dashboard data (ads performance, keywords, promos) being unavailable here, always include it as the LAST bullet, using the exact wording given in the data -- don't paraphrase or omit it, this is a known limitation being surfaced on purpose, not something to hide.
- Never invent a fact, a number, or a date not present in the data given.
- If genuinely nothing is available for this client (no notes, no billing record found), say so plainly in a single bullet rather than force 5 bullets from nothing.`;

async function composePrep(clientName, client, notes, balances, openFollowUps) {
  const parts = [];

  if (client) {
    const nextBilling = estimateNextBilling(client.last_billing_date);
    parts.push(
      `BILLING STATUS:\n- Status: ${client.billing_status || "unknown"}\n- Monthly rate: ${client.monthly_rate ? `$${client.monthly_rate}` : "unknown"}` +
        (nextBilling ? `\n- Next billing (ESTIMATE from last billing date + 1 month, not a real contract date): ${nextBilling}` : "") +
        (client.cancellation_date ? `\n- Cancellation date on file: ${client.cancellation_date}` : "")
    );
  } else {
    parts.push(`BILLING STATUS:\n- No matching record found in portfolio_clients for "${clientName}" -- check the spelling or look it up directly in the Hub.`);
  }

  const unpaidLines = [
    ...balances.ledger.map((l) => `- Ledger: ${l.category || "charge"} — $${l.amount}${l.due_date ? `, due ${l.due_date}` : ""} — ${l.description || ""}`),
    ...balances.collections.map((c) => `- Collections: $${c.amount} — status: ${c.status}`),
  ];
  if (unpaidLines.length) parts.push(`UNPAID / OUTSTANDING BALANCES:\n${unpaidLines.join("\n")}`);

  if (notes.length) {
    parts.push(
      `RECENT NOTES (last ${NOTE_LOOKBACK_DAYS} days):\n` +
        notes
          .map((n) => `- ${new Date(n.note_date).toDateString()} (${n.sentiment || "unknown"}): ${n.summary}${n.risk_signals?.length ? ` [risk: ${n.risk_signals.join("; ")}]` : ""}`)
          .join("\n")
    );
  } else {
    parts.push(`RECENT NOTES: none in the last ${NOTE_LOOKBACK_DAYS} days.`);
  }

  if (openFollowUps.length) {
    parts.push(
      "OPEN FOLLOW-UPS (no matching task found yet):\n" +
        openFollowUps
          .map((n) => `- ${new Date(n.note_date).toDateString()}: mine: ${JSON.stringify(n.my_commitments)}, theirs: ${JSON.stringify(n.their_commitments)}`)
          .join("\n")
    );
  }

  parts.push(
    "STANDING NOTE (always include verbatim as the last bullet): \"Yelp Ads Dashboard data (performance, keywords, promos) isn't available here yet — check Yelp's Partner Dashboard directly for that.\""
  );

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1000,
      system: PREP_SYSTEM_PROMPT,
      messages: [{ role: "user", content: parts.join("\n\n---\n\n") }],
    }),
  });
  if (!res.ok) throw new Error(`Claude prep composition failed (${res.status}): ${await res.text().catch(() => "")}`);
  const data = await res.json();
  if (data.stop_reason === "max_tokens") {
    console.error("atlas-prep-background: Claude hit max_tokens.");
  }
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("Claude response had no text block");

  const cleaned = textBlock.text.trim().replace(/^```json\s*/i, "").replace(/```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error("atlas-prep-background: JSON.parse failed:", e.message);
    console.error("atlas-prep-background: raw response was:", cleaned.slice(0, 1500));
    throw e;
  }
}

function buildSlackBlocks(clientName, prep) {
  return [
    { type: "header", text: { type: "plain_text", text: `📋 Prep: ${clientName}`, emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: (prep.bullets || []).map((b) => `- ${b}`).join("\n") } },
  ];
}

async function postDmToRequester(userId, blocks, fallbackText) {
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
      body: JSON.stringify({ channel: userId, blocks, text: fallbackText }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error("atlas-prep-background: DM post failed:", data.error);
    }
  } catch (e) {
    console.error("atlas-prep-background: DM post threw:", e.message);
  }
}

export default async (req) => {
  if (!isAuthorizedTrigger(req)) {
    console.warn("atlas-prep-background: rejected an unauthorized trigger attempt.");
    return new Response("Forbidden", { status: 403 });
  }

  const payload = await req.json().catch(() => null);
  if (!payload?.client_name || !payload?.user_id) {
    console.error("atlas-prep-background: missing client_name or user_id in payload");
    return;
  }

  try {
    const client = await findClient(payload.client_name);
    const resolvedName = client?.name || payload.client_name;

    const [notes, balances] = await Promise.all([
      getRecentNotes(resolvedName),
      getUnpaidBalances(resolvedName),
    ]);
    const openFollowUps = await getOpenFollowUps(resolvedName, notes);

    const prep = await composePrep(resolvedName, client, notes, balances, openFollowUps);
    const blocks = buildSlackBlocks(resolvedName, prep);
    const fallbackText = `Prep: ${resolvedName}\n\n${(prep.bullets || []).map((b) => `- ${b}`).join("\n")}`;

    await postDmToRequester(payload.user_id, blocks, fallbackText);

    console.log(`atlas-prep-background: prep sent for "${resolvedName}" to ${payload.user_id}.`);
  } catch (e) {
    console.error("atlas-prep-background: failed:", e.message);
    await postDmToRequester(
      payload.user_id,
      [{ type: "section", text: { type: "mrkdwn", text: `Something went wrong building the prep packet for ${payload.client_name}: ${e.message}` } }],
      `Something went wrong building the prep packet for ${payload.client_name}.`
    ).catch(() => {});
  }
};
