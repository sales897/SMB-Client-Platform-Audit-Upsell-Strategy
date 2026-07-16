// netlify/functions/widget-chat.mjs
//
// Public-facing backend for the embeddable Chat Widget (widget.js). This is
// the ONLY thing that reads/writes widget_conversations and widget_messages
// -- the widget script itself never touches Supabase directly for lead
// data. That's a deliberate security boundary: the widget's anon key is
// necessarily public (it ships inside a <script> tag on someone else's
// website), so direct public read/write on lead data would let anyone with
// that key enumerate every lead across every client's widget. Running
// everything through this function with a SERVICE ROLE key means the only
// thing the public can ever do is "send a message for a conversation you
// already started" -- never list, browse, or read anyone else's leads.
//
// SETUP REQUIRED (one-time):
//   1. Add SUPABASE_SERVICE_ROLE_KEY as a Netlify environment variable
//      (Site configuration -> Environment variables, "Contains secret
//      values" checked). Copy it from Supabase Dashboard -> Project
//      Settings -> API -> service_role key (NOT the anon/public key --
//      this one bypasses Row Level Security entirely and must never appear
//      in any browser-side code).
//   2. ANTHROPIC_API_KEY already exists for the main ai-agent function and
//      is reused here as-is.
//
// KNOWN LIMITATION: conversation_id is a client-supplied value used to
// resume an existing thread (stored in the visitor's own localStorage) --
// there's no secondary secret protecting it beyond being a long random
// string, so treat it like a bearer token: fine for "don't make leads
// re-introduce themselves every page reload," not a substitute for real
// per-visitor auth. Good enough for this feature's actual use case (a
// public marketing site's lead-capture chat), not appropriate to lean on
// for anything requiring real security guarantees.

const SUPABASE_URL = "https://banmahudemvjkygwihsd.supabase.co";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function genId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const serviceKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anthropicKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!serviceKey) {
    return new Response(JSON.stringify({ error: "SUPABASE_SERVICE_ROLE_KEY is not configured on the server." }), {
      status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
  if (!anthropicKey) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY is not configured on the server." }), {
      status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  let payload;
  try {
    payload = await req.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const { widget_id, conversation_id, message, lead_info } = payload;
  if (!widget_id || !message) {
    return new Response(JSON.stringify({ error: "widget_id and message are required" }), {
      status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const sbHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
  const sbWriteHeaders = { ...sbHeaders, Prefer: "return=minimal" };

  // 1. Load the widget's own config -- this is what makes each embed
  //    behave differently (agent name, tone, what to collect).
  const widgetRes = await fetch(`${SUPABASE_URL}/rest/v1/chat_widgets?id=eq.${encodeURIComponent(widget_id)}&select=*`, { headers: sbHeaders });
  const widgets = await widgetRes.json();
  const widget = Array.isArray(widgets) ? widgets[0] : null;
  if (!widget || widget.active === false) {
    return new Response(JSON.stringify({ error: "Widget not found or inactive." }), {
      status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // 2. Find or create the conversation this message belongs to.
  let convId = conversation_id || null;
  let conversation = null;
  if (convId) {
    const convRes = await fetch(`${SUPABASE_URL}/rest/v1/widget_conversations?id=eq.${encodeURIComponent(convId)}&widget_id=eq.${encodeURIComponent(widget_id)}&select=*`, { headers: sbHeaders });
    const rows = await convRes.json();
    conversation = Array.isArray(rows) ? rows[0] : null;
  }
  if (!conversation) {
    convId = genId("conv");
    conversation = {
      id: convId, widget_id,
      lead_name: (lead_info && lead_info.name) || null,
      lead_email: (lead_info && lead_info.email) || null,
      lead_phone: (lead_info && lead_info.phone) || null,
      resolution: "exploring", handled_by: "ai",
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    await fetch(`${SUPABASE_URL}/rest/v1/widget_conversations`, { method: "POST", headers: sbWriteHeaders, body: JSON.stringify(conversation) });
  }

  // 3. Pull prior message history for this conversation, to give the AI
  //    real context rather than treating every message as a fresh start.
  const msgsRes = await fetch(`${SUPABASE_URL}/rest/v1/widget_messages?conversation_id=eq.${encodeURIComponent(convId)}&order=created_at.asc`, { headers: sbHeaders });
  const priorMessages = await msgsRes.json();

  // 4. Save the visitor's new message immediately (so it's never lost even
  //    if the AI call below fails).
  await fetch(`${SUPABASE_URL}/rest/v1/widget_messages`, {
    method: "POST", headers: sbWriteHeaders,
    body: JSON.stringify({ id: genId("msg"), conversation_id: convId, role: "lead", content: message, created_at: new Date().toISOString() }),
  });

  // 5. Build the sandboxed system prompt from this widget's own config --
  //    deliberately has NO access to any Hub-internal tool, data, or
  //    client record. This agent only ever talks about this one business
  //    and only ever writes to this one conversation.
  const dataToCollect = [];
  if (widget.collect_name !== false) dataToCollect.push("their name");
  if (widget.collect_phone !== false) dataToCollect.push("phone number");
  if (widget.collect_email !== false) dataToCollect.push("email address");
  if (widget.collect_service_requested !== false) dataToCollect.push("what service or product they're interested in");
  if (widget.collect_company) dataToCollect.push("company name");

  const systemPrompt = `You are ${widget.agent_name || "an AI assistant"}, a friendly, conversational chat widget embedded directly on a business's website. ${widget.instructions || ""}

Your goals, in order: (1) understand what the visitor actually needs, (2) naturally collect ${dataToCollect.length ? dataToCollect.join(", ") : "their contact information"} through the conversation -- never as a rigid form, ask for one or two things at a time, in your own words, (3) once you have enough to work with, offer to book a call or hand off to a real person if that's what fits.

Keep every reply SHORT -- one to three sentences, like a text message, never a wall of text or a script.

After each reply, call update_lead_status with your current read on this lead: any new details you just learned (name/email/phone/service), an "intent" (one short phrase), a "confidence" (High/Medium/Low -- how real and qualified this lead seems), a "resolution" ("exploring" = still gathering info, "booked" = a call/appointment was just scheduled, "transfer" = they want a human or you're stuck, "handled_ai" = you fully answered them and the conversation has a natural close), and a short "next_step" note for whoever on the team picks this up.`;

  const tools = [{
    name: "update_lead_status",
    description: "Call this after every reply to record what you currently know about this lead and where the conversation stands.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" }, email: { type: "string" }, phone: { type: "string" }, service_requested: { type: "string" },
        intent: { type: "string" }, confidence: { type: "string", enum: ["High", "Medium", "Low"] },
        resolution: { type: "string", enum: ["exploring", "booked", "transfer", "handled_ai"] },
        next_step: { type: "string" },
      },
      required: ["intent", "confidence", "resolution", "next_step"],
    },
  }];

  const anthropicMessages = [
    ...priorMessages.map((m) => ({ role: m.role === "lead" ? "user" : "assistant", content: m.content })),
    { role: "user", content: message },
  ];

  let anthropicRes;
  try {
    anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 500, system: systemPrompt, messages: anthropicMessages, tools }),
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: "Could not reach the AI service: " + e.message }), {
      status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    return new Response(JSON.stringify({ error: "AI service error: " + errText }), {
      status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
  const data = await anthropicRes.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  const toolBlock = (data.content || []).find((b) => b.type === "tool_use" && b.name === "update_lead_status");
  const replyText = textBlock ? textBlock.text : "Sorry, could you say that again?";
  const statusUpdate = toolBlock ? toolBlock.input : {};

  // 6. Save the assistant's reply.
  await fetch(`${SUPABASE_URL}/rest/v1/widget_messages`, {
    method: "POST", headers: sbWriteHeaders,
    body: JSON.stringify({ id: genId("msg"), conversation_id: convId, role: "assistant", content: replyText, created_at: new Date().toISOString() }),
  });

  // 7. Update the conversation record with whatever the AI now knows.
  const convPatch = { updated_at: new Date().toISOString() };
  if (statusUpdate.name) convPatch.lead_name = statusUpdate.name;
  if (statusUpdate.email) convPatch.lead_email = statusUpdate.email;
  if (statusUpdate.phone) convPatch.lead_phone = statusUpdate.phone;
  if (statusUpdate.service_requested) convPatch.service_requested = statusUpdate.service_requested;
  if (statusUpdate.intent) convPatch.intent = statusUpdate.intent;
  if (statusUpdate.confidence) convPatch.confidence = statusUpdate.confidence;
  if (statusUpdate.resolution) convPatch.resolution = statusUpdate.resolution;
  if (statusUpdate.next_step) convPatch.next_step = statusUpdate.next_step;
  await fetch(`${SUPABASE_URL}/rest/v1/widget_conversations?id=eq.${encodeURIComponent(convId)}`, {
    method: "PATCH", headers: sbWriteHeaders, body: JSON.stringify(convPatch),
  });

  return new Response(
    JSON.stringify({ conversation_id: convId, reply: replyText, resolution: statusUpdate.resolution || conversation.resolution }),
    { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
  );
};
