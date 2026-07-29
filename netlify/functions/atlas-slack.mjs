// netlify/functions/atlas-slack.mjs
//
// ATLAS — Slack entry point. Handles both:
//   - Slash command  POST  /atlas <question>        (content-type: form-urlencoded)
//   - Events API     POST  DMs + url_verification    (content-type: application/json)
//
// Slack requires a response within 3 seconds, so this function ONLY
// verifies the request and acknowledges immediately. The actual retrieval
// + Claude call happens in atlas-ask-background.mjs, fired here and not
// awaited to completion.

import crypto from "node:crypto";

const SLACK_SIGNING_SECRET = Netlify.env.get("SLACK_SIGNING_SECRET");

// Slack signs every request: v0=HMAC-SHA256(signing_secret, "v0:{ts}:{raw_body}").
// Verifying this (rather than trusting the payload) is what stops anyone
// who finds this URL from posting fake questions as Oscar.
function verifySlackSignature(rawBody, timestamp, signature) {
  if (!SLACK_SIGNING_SECRET || !timestamp || !signature) return false;

  // Reject requests older than 5 minutes — replay protection.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (age > 60 * 5) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const expected =
    "v0=" + crypto.createHmac("sha256", SLACK_SIGNING_SECRET).update(base).digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Fires atlas-ask-background WITHOUT blocking the response to Slack.
// Slack requires a reply within 3 seconds -- awaiting this fetch first
// (network round trip + a cold start on the receiving function) can
// easily blow past that, which is exactly what was happening before this
// used context.waitUntil: Slack showed "the app did not respond" even
// though nothing had actually errored.
function fireBackground(context, origin, payload) {
  const promise = fetch(`${origin}/.netlify/functions/atlas-ask-background`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-atlas-trigger-secret": Netlify.env.get("ATLAS_TRIGGER_SECRET") || "",
    },
    body: JSON.stringify(payload),
  }).catch((e) => {
    console.error("atlas-slack: failed to trigger atlas-ask-background:", e.message);
  });
  context.waitUntil(promise);
}

export default async (req, context) => {
  const rawBody = await req.text();
  const timestamp = req.headers.get("x-slack-request-timestamp");
  const signature = req.headers.get("x-slack-signature");

  if (!verifySlackSignature(rawBody, timestamp, signature)) {
    console.warn("atlas-slack: rejected a request with an invalid Slack signature.");
    return new Response("Forbidden", { status: 403 });
  }

  const contentType = req.headers.get("content-type") || "";
  const origin = new URL(req.url).origin;

  // ---- Events API (JSON): DMs + the one-time URL verification handshake ----
  if (contentType.includes("application/json")) {
    const body = JSON.parse(rawBody);

    // Slack's one-time handshake when you first enable Event Subscriptions.
    if (body.type === "url_verification") {
      return new Response(JSON.stringify({ challenge: body.challenge }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (body.type === "event_callback") {
      const event = body.event || {};
      const isDirectMessage = event.type === "message" && event.channel_type === "im";
      // bot_id/subtype present means it's a bot message or an edit/join/etc,
      // not a real question — skip, or ATLAS would loop on its own replies.
      const isRealUserMessage = !event.bot_id && !event.subtype;

      if (isDirectMessage && isRealUserMessage) {
        fireBackground(context, origin, {
          source: "dm",
          question: event.text,
          user_id: event.user,
          channel_id: event.channel,
        });
      }
    }

    return new Response("", { status: 200 });
  }

  // ---- Slash command (form-urlencoded) ----
  const params = new URLSearchParams(rawBody);
  const question = (params.get("text") || "").trim();
  const userId = params.get("user_id");
  const channelId = params.get("channel_id");
  const responseUrl = params.get("response_url");

  if (!question) {
    return new Response(
      JSON.stringify({
        response_type: "ephemeral",
        text: "Ask me something — e.g. `/atlas what did I promise Acme Roofing last call?`",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  fireBackground(context, origin, {
    source: "slash",
    question,
    user_id: userId,
    channel_id: channelId,
    response_url: responseUrl,
  });

  // Immediate ack Slack shows right away; the real answer follows via
  // response_url once atlas-ask-background finishes.
  return new Response(
    JSON.stringify({ response_type: "ephemeral", text: "Looking into that — one sec…" }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
};
