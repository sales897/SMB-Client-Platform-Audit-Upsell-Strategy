// netlify/functions/atlas-task-action-background.mjs
//
// ATLAS — finishes the task-suggestion loop from atlas-enrich-background.mjs.
// That file only ever SUGGESTS (writes to atlas_task_suggestions, a review
// queue) -- this is the first time ATLAS writes to the real client_tasks
// table, and only in direct response to an explicit slash command, never
// automatically. Matches the "typing the command IS the confirmation"
// pattern /atlas-prep already uses, rather than inventing a separate
// multi-turn yes/no flow.
//
// Triggered by:
//   /atlas-approve-task <client name>   -- creates the real client_tasks row
//   /atlas-dismiss-task <client name>   -- marks the suggestion dismissed, no task created
//
// Acts on the MOST RECENT pending suggestion for that client. If more than
// one is pending, mentions the remaining count in the response rather than
// silently batch-processing all of them -- one explicit action, one result.

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
const SLACK_BOT_TOKEN = Netlify.env.get("SLACK_BOT_TOKEN");

// Suggestions currently only ever surface in the Oscar-facing morning
// brief, so approval realistically always comes from Oscar. If this ever
// extends to other requesters (e.g. a Kevin-facing suggestion feed),
// this needs a real Slack-user-id -> email mapping instead of assuming.
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

async function findPendingSuggestions(clientNameInput) {
  // Exact match first, then a fuzzy ilike fallback -- same reasoning as
  // atlas-prep-background.mjs's client matching: people type from memory.
  const exact = await sbFetch(
    `atlas_task_suggestions?select=id,client_name,suggested_title,note_date&client_name=eq.${encodeURIComponent(clientNameInput)}&status=eq.pending&order=created_at.desc`
  );
  if (exact.ok) {
    const rows = await exact.json();
    if (rows.length) return rows;
  }
  const fuzzy = await sbFetch(
    `atlas_task_suggestions?select=id,client_name,suggested_title,note_date&client_name=ilike.*${encodeURIComponent(clientNameInput)}*&status=eq.pending&order=created_at.desc`
  );
  if (fuzzy.ok) return fuzzy.json();
  return [];
}

async function postDm(userId, text) {
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
      body: JSON.stringify({ channel: userId, text }),
    });
    const data = await res.json();
    if (!data.ok) console.error("atlas-task-action-background: DM post failed:", data.error);
  } catch (e) {
    console.error("atlas-task-action-background: DM post threw:", e.message);
  }
}

export default async (req) => {
  if (!isAuthorizedTrigger(req)) {
    console.warn("atlas-task-action-background: rejected an unauthorized trigger attempt.");
    return new Response("Forbidden", { status: 403 });
  }

  const payload = await req.json().catch(() => null);
  const { action, client_name, requester_user_id } = payload || {};
  if (!action || !client_name || !requester_user_id) {
    console.error("atlas-task-action-background: missing action, client_name, or requester_user_id");
    return;
  }

  try {
    const pending = await findPendingSuggestions(client_name);
    if (pending.length === 0) {
      await postDm(requester_user_id, `No pending task suggestions found for "${client_name}".`);
      return;
    }

    const [target, ...rest] = pending;
    const remainingNote = rest.length ? ` (${rest.length} more pending suggestion${rest.length === 1 ? "" : "s"} for ${target.client_name} — same command again to handle the next one.)` : "";

    if (action === "approve") {
      const insertRes = await sbFetch("client_tasks", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify([
          {
            client_name: target.client_name,
            title: target.suggested_title,
            status: "open",
            created_by_email: OWNER_EMAIL,
            created_by_name: "ATLAS",
            assigned_to_email: OWNER_EMAIL,
          },
        ]),
      });
      if (!insertRes.ok) {
        const detail = await insertRes.text().catch(() => "");
        throw new Error(`client_tasks insert failed (${insertRes.status}): ${detail}`);
      }

      await sbFetch(`atlas_task_suggestions?id=eq.${target.id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: "created", reviewed_at: new Date().toISOString() }),
      });

      await postDm(requester_user_id, `✅ Created task for *${target.client_name}*: "${target.suggested_title}"${remainingNote}`);
    } else if (action === "dismiss") {
      await sbFetch(`atlas_task_suggestions?id=eq.${target.id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: "dismissed", reviewed_at: new Date().toISOString() }),
      });
      await postDm(requester_user_id, `Dismissed suggestion for *${target.client_name}*: "${target.suggested_title}"${remainingNote}`);
    } else {
      console.error("atlas-task-action-background: unknown action:", action);
    }
  } catch (e) {
    console.error("atlas-task-action-background: failed:", e.message);
    await postDm(requester_user_id, `Something went wrong: ${e.message}`).catch(() => {});
  }
};
