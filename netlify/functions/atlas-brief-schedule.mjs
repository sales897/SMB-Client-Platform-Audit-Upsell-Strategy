// netlify/functions/atlas-brief-schedule.mjs
//
// Fires the morning brief every day at 10:00 AM Mexico City time.
// Mexico's "Zona Centro" (which includes Mexico City / Coacalco) has used
// a fixed UTC-6 offset with no DST since 2022, so this cron time never
// needs seasonal adjustment: 10:00 local is always 16:00 UTC.
//
// Same pattern as atlas-ingest-schedule.mjs: stays thin, just triggers the
// real work in a background function and returns immediately.

export default async (req) => {
  try {
    const origin = new URL(req.url).origin;
    await fetch(`${origin}/.netlify/functions/atlas-brief-background`, {
      method: "POST",
      headers: { "x-atlas-trigger-secret": Netlify.env.get("ATLAS_TRIGGER_SECRET") || "" },
    });
    console.log("atlas-brief-schedule: triggered the morning brief.");
  } catch (e) {
    console.error("atlas-brief-schedule: failed to trigger the brief:", e.message);
  }
};

export const config = {
  schedule: "0 16 * * *",
};
