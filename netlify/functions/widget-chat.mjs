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
const GOOGLE_CALENDAR_CLIENT_ID = "512550241298-me0g34krgime9v61pij5ir9610h7iqlo.apps.googleusercontent.com";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function genId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// Mints a fresh access token from this widget's stored refresh token.
// Widgets never see or hold an access token themselves -- this happens
// fresh, server-side, on every booking attempt.
async function refreshWidgetGoogleToken(refreshToken, clientSecret) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: GOOGLE_CALENDAR_CLIENT_ID,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("[widget-chat] token refresh error:", res.status, JSON.stringify(data));
    throw new Error(data.error_description || data.error || "Google token refresh failed (status " + res.status + ")");
  }
  return data.access_token;
}

// Checks the requested slot against the connected calendar's real
// freebusy data, and only creates the event if it's actually free --
// never trusts the AI's own sense of availability, since it has no live
// visibility into the calendar otherwise.
async function bookOnWidgetCalendar(accessToken, { summary, description, startISO, endISO, attendeeEmail }) {
  const fbRes = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ timeMin: startISO, timeMax: endISO, items: [{ id: "primary" }] }),
  });
  const fbData = await fbRes.json();
  if (!fbRes.ok) {
    console.error("[widget-chat] freeBusy API error:", fbRes.status, JSON.stringify(fbData));
    throw new Error("Could not check calendar availability: " + (fbData.error && fbData.error.message ? fbData.error.message : fbRes.status));
  }
  const busy = (fbData.calendars && fbData.calendars.primary && fbData.calendars.primary.busy) || [];
  if (busy.length > 0) {
    return { booked: false, reason: "That time slot is no longer available -- it was just booked or blocked." };
  }
  const evRes = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      summary,
      description,
      start: { dateTime: startISO },
      end: { dateTime: endISO },
      attendees: attendeeEmail ? [{ email: attendeeEmail }] : undefined,
    }),
  });
  const evData = await evRes.json();
  if (!evRes.ok) {
    console.error("[widget-chat] events.insert API error:", evRes.status, JSON.stringify(evData));
    throw new Error((evData.error && evData.error.message) || "Could not create the calendar event (status " + evRes.status + ").");
  }
  return { booked: true, eventId: evData.id, htmlLink: evData.htmlLink };
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

  // 4b. If a human has already taken this conversation over, the AI must
  //     never jump back in -- just store the visitor's message (done
  //     above) and stop here. The Hub's Inbox + widget-poll.mjs handle
  //     delivering the actual human reply back to the visitor. Without
  //     this check, "Assign Human" in the Hub only changed a database
  //     label while the AI kept auto-replying to every new message.
  if (conversation.handled_by === "human") {
    return new Response(
      JSON.stringify({ conversation_id: convId, reply: null, handled_by: "human", resolution: conversation.resolution }),
      { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  // 5. Check whether this widget has a calendar connected -- only offer
  //    real booking if it does, so the AI never promises something it
  //    can't actually do.
  const calRes = await fetch(`${SUPABASE_URL}/rest/v1/widget_calendar_tokens?widget_id=eq.${encodeURIComponent(widget_id)}&select=refresh_token`, { headers: sbHeaders });
  const calRows = await calRes.json();
  const calendarToken = Array.isArray(calRows) && calRows[0] ? calRows[0].refresh_token : null;
  const canBook = !!calendarToken;

  // 6. Build the sandboxed system prompt from this widget's own config --
  //    deliberately has NO access to any Hub-internal tool, data, or
  //    client record. This agent only ever talks about this one business
  //    and only ever writes to this one conversation.
  //
  // Data fields: prefers the new structured data_fields list (label +
  // required, settable per-widget including custom fields added in the
  // Hub's Agent Builder) -- falls back to the old boolean collect_* flags
  // for any widget that hasn't been re-saved since that was added, so
  // nothing breaks for existing widgets.
  let dataToCollect;
  if (Array.isArray(widget.data_fields) && widget.data_fields.length > 0) {
    dataToCollect = widget.data_fields.filter((f) => f.enabled).map((f) => f.label + (f.required ? " (required)" : ""));
  } else {
    dataToCollect = [];
    if (widget.collect_name !== false) dataToCollect.push("their name");
    if (widget.collect_phone !== false) dataToCollect.push("phone number");
    if (widget.collect_email !== false) dataToCollect.push("email address");
    if (widget.collect_service_requested !== false) dataToCollect.push("what service or product they're interested in");
    if (widget.collect_company) dataToCollect.push("company name");
  }

  const nowStr = new Date().toLocaleString("en-US", { timeZone: widget.timezone || "America/Los_Angeles", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
  const hours = widget.business_hours || {};
  const hoursLines = Object.entries(hours).map(([day, h]) => `${day}: ${h.enabled ? `${h.open}-${h.close}` : "closed"}`).join(", ");

  const bookingInstructions = canBook
    ? `You CAN book real appointments on this business's calendar. Business hours (in ${widget.timezone || "America/Los_Angeles"}): ${hoursLines || "not configured"}. Appointments are ${widget.service_duration_minutes || 60} minutes with a ${widget.buffer_time_minutes || 0}-minute buffer, and need at least ${widget.min_notice_hours || 0} hours' notice from right now. The current date/time is ${nowStr} -- compute any relative time the visitor mentions ("tomorrow", "Friday afternoon") from this. Once the visitor agrees on a specific date and time within business hours, call book_appointment with the exact start time. If it comes back unavailable, apologize and ask for another time -- never claim something is booked unless the tool confirms it.`
    : `You do NOT have calendar booking available for this widget yet -- if the visitor wants to schedule something, say a team member will follow up to find a time, and set resolution to "transfer".`;

  const transferInstructions = widget.transfer_to_human_enabled === false
    ? `Transfer-to-human is turned OFF for this widget -- never tell the visitor a person will follow up; instead do your best to fully resolve things yourself, and if you truly can't, say so honestly.`
    : `If the visitor asks for a human, seems frustrated, or has a question genuinely outside what you can help with, say a team member will follow up and set resolution to "transfer".`;

  // Personality, built from the Hub's Agent Builder tag selections rather
  // than one flat instructions blob -- falls back to a generic personality
  // if none of this has been configured yet.
  const toneTags = Array.isArray(widget.tone_tags) ? widget.tone_tags : [];
  const styleTags = Array.isArray(widget.style_tags) ? widget.style_tags : [];
  const traitTags = Array.isArray(widget.trait_tags) ? widget.trait_tags : [];
  const personalityLine = [
    widget.personality_summary || "",
    toneTags.length ? `Tone: ${toneTags.join(", ")}.` : "",
    styleTags.length ? `Style: ${styleTags.join(", ")}.` : "",
    traitTags.length ? `Traits: ${traitTags.join(", ")}.` : "",
  ].filter(Boolean).join(" ");

  // Conversation flow steps, built in the Hub as a structured sequence
  // rather than one freeform instructions paragraph -- each step is a
  // phase of the conversation to guide toward, not a rigid script to
  // recite verbatim.
  const steps = Array.isArray(widget.conversation_steps) ? widget.conversation_steps : [];
  const stepsBlock = steps.length
    ? `Guide the conversation through these phases, in order, using your own natural words -- don't recite them verbatim, and don't rush past a phase before it's genuinely done:\n${steps.map((s, i) => `${i + 1}. ${s.title}: ${s.description}`).join("\n")}`
    : "";

  // Knowledge Base: any Hub Knowledge Base entries linked to this widget
  // in Agent Builder get included as real reference material, so the
  // widget can accurately answer questions about pricing, services, etc.
  // using content the team actually wrote, not invented.
  let kbBlock = "";
  if (Array.isArray(widget.kb_entry_ids) && widget.kb_entry_ids.length > 0) {
    try {
      const idList = widget.kb_entry_ids.map((id) => `"${id}"`).join(",");
      const kbRes = await fetch(`${SUPABASE_URL}/rest/v1/knowledge_base?id=in.(${idList})&select=title,content`, { headers: sbHeaders });
      const kbRows = kbRes.ok ? await kbRes.json() : [];
      if (kbRows.length > 0) {
        kbBlock = `\nREFERENCE MATERIAL (use this to answer questions accurately -- don't invent details that aren't here):\n${kbRows.map((k) => `--- ${k.title} ---\n${(k.content || "").slice(0, 2000)}`).join("\n\n")}`;
      }
    } catch (e) {
      // Non-fatal -- the widget still works without its knowledge base, just less informed.
    }
  }

  const systemPrompt = `You are ${widget.agent_name || "an AI assistant"}, a friendly, conversational chat widget embedded directly on a business's website. ${personalityLine}

${widget.opening_line ? `Your natural opening line (adapt the wording, don't recite it robotically): "${widget.opening_line}"\n\n` : ""}${stepsBlock}

Naturally collect ${dataToCollect.length ? dataToCollect.join(", ") : "their contact information"} through the conversation -- never as a rigid form, ask for one or two things at a time, in your own words.

${bookingInstructions}

${transferInstructions}

Keep every reply SHORT -- one to three sentences, like a text message, never a wall of text or a script.
${kbBlock}

After each reply, call update_lead_status with your current read on this lead: any new details you just learned (name/email/phone/service), an "intent" (one short phrase), a "confidence" (High/Medium/Low -- how real and qualified this lead seems), a "resolution" ("exploring" = still gathering info, "booked" = a call/appointment was just scheduled, "transfer" = they want a human or you're stuck, "handled_ai" = you fully answered them and the conversation has a natural close), and a short "next_step" note for whoever on the team picks this up.`;

  const tools = [
    {
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
    },
  ];
  if (canBook) {
    tools.push({
      name: "book_appointment",
      description: "Book a real appointment on the business's calendar at a specific date/time the visitor has agreed to. Only call this once you have an exact time, not a vague preference.",
      input_schema: {
        type: "object",
        properties: {
          start_iso: { type: "string", description: "Exact start time in ISO 8601 format WITH timezone offset, e.g. 2026-07-20T14:00:00-07:00" },
          service: { type: "string", description: "What this appointment is for, in a few words" },
        },
        required: ["start_iso", "service"],
      },
    });
  }

  let workingMessages = [
    ...priorMessages.map((m) => ({ role: m.role === "lead" ? "user" : "assistant", content: m.content })),
    { role: "user", content: message },
  ];

  let replyText = "";
  let statusUpdate = {};
  let bookingResult = null;
  let bookedStartISO = null;
  let bookedService = null;

  // Up to 3 rounds: lets the model call update_lead_status and, if it also
  // tries to book_appointment, actually see whether that succeeded before
  // writing its final reply -- otherwise it would have to describe a
  // booking outcome it hasn't actually seen yet.
  for (let round = 0; round < 3; round++) {
    let anthropicRes;
    try {
      anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 500, system: systemPrompt, messages: workingMessages, tools }),
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
    const content = data.content || [];
    const textBlock = content.find((b) => b.type === "text");
    const statusBlock = content.find((b) => b.type === "tool_use" && b.name === "update_lead_status");
    const bookBlock = content.find((b) => b.type === "tool_use" && b.name === "book_appointment");
    if (statusBlock) statusUpdate = statusBlock.input;
    replyText = textBlock ? textBlock.text : replyText;

    if (!bookBlock) break; // no booking attempted this round -- done

    // Execute the real booking against Google Calendar.
    const clientSecret = Netlify.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
    console.log("[widget-chat] booking attempt, raw start_iso from model:", bookBlock.input.start_iso, "service:", bookBlock.input.service);
    try {
      if (!clientSecret) throw new Error("GOOGLE_OAUTH_CLIENT_SECRET is not configured on the server.");
      const accessToken = await refreshWidgetGoogleToken(calendarToken, clientSecret);
      const startISO = bookBlock.input.start_iso;
      const parsedStart = new Date(startISO);
      if (isNaN(parsedStart.getTime())) throw new Error("Model returned an unparseable start_iso: " + startISO);
      const durationMs = (widget.service_duration_minutes || 60) * 60000;
      const endISO = new Date(parsedStart.getTime() + durationMs).toISOString();
      bookedStartISO = startISO;
      bookedService = bookBlock.input.service || null;
      console.log("[widget-chat] checking freebusy for", startISO, "to", endISO);
      bookingResult = await bookOnWidgetCalendar(accessToken, {
        summary: `${bookBlock.input.service || "Appointment"} — ${conversation.lead_name || "New lead"}`,
        description: `Booked via chat widget. Lead: ${conversation.lead_name || "unknown"}, ${conversation.lead_email || ""} ${conversation.lead_phone || ""}`.trim(),
        startISO,
        endISO,
        attendeeEmail: conversation.lead_email || (statusUpdate && statusUpdate.email) || undefined,
      });
      console.log("[widget-chat] booking result:", JSON.stringify(bookingResult));
    } catch (e) {
      console.error("[widget-chat] booking FAILED:", e.message, e.stack);
      bookingResult = { booked: false, reason: e.message };
    }

    // Feed the real outcome back so the model's NEXT reply is accurate.
    workingMessages.push({ role: "assistant", content });
    workingMessages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: bookBlock.id, content: JSON.stringify(bookingResult) }],
    });
    if (statusBlock) {
      // Anthropic requires a tool_result for every tool_use in the same turn.
      workingMessages[workingMessages.length - 1].content.push({ type: "tool_result", tool_use_id: statusBlock.id, content: "Recorded." });
    }
    // Loop again so the model can write its real final reply based on bookingResult.
  }

  if (!replyText) replyText = "Thanks for reaching out! Let me get someone from our team to follow up with you.";

  // 7. Save the assistant's reply. Its id is returned to the client so it
  //    can skip this exact message if polling (widget-poll.mjs) also picks
  //    it up in the same window -- otherwise a poll that was already
  //    in-flight when this reply was saved can re-deliver the identical
  //    message a second time right after it was shown directly.
  const assistantMsgId = genId("msg");
  await fetch(`${SUPABASE_URL}/rest/v1/widget_messages`, {
    method: "POST", headers: sbWriteHeaders,
    body: JSON.stringify({ id: assistantMsgId, conversation_id: convId, role: "assistant", content: replyText, created_at: new Date().toISOString() }),
  });

  // 8. Update the conversation record with whatever the AI now knows,
  //    plus the real appointment details if a booking actually succeeded.
  const convPatch = { updated_at: new Date().toISOString() };
  if (statusUpdate.name) convPatch.lead_name = statusUpdate.name;
  if (statusUpdate.email) convPatch.lead_email = statusUpdate.email;
  if (statusUpdate.phone) convPatch.lead_phone = statusUpdate.phone;
  if (statusUpdate.service_requested) convPatch.service_requested = statusUpdate.service_requested;
  if (statusUpdate.intent) convPatch.intent = statusUpdate.intent;
  if (statusUpdate.confidence) convPatch.confidence = statusUpdate.confidence;
  if (statusUpdate.resolution) convPatch.resolution = statusUpdate.resolution;
  if (statusUpdate.next_step) convPatch.next_step = statusUpdate.next_step;
  if (bookingResult && bookingResult.booked) {
    convPatch.resolution = "booked";
    convPatch.appointment_at = bookedStartISO;
    convPatch.appointment_service = bookedService;
  }
  await fetch(`${SUPABASE_URL}/rest/v1/widget_conversations?id=eq.${encodeURIComponent(convId)}`, {
    method: "PATCH", headers: sbWriteHeaders, body: JSON.stringify(convPatch),
  });

  return new Response(
    JSON.stringify({ conversation_id: convId, reply: replyText, message_id: assistantMsgId, resolution: convPatch.resolution || conversation.resolution, handled_by: conversation.handled_by || "ai" }),
    { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
  );
};
