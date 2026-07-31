// netlify/functions/atlas-eod-schedule.mjs
//
// Fires the end-of-day recap every day at 6:00 PM Mexico City time.
// Same fixed-UTC-6 reasoning as atlas-brief-schedule.mjs: 18:00 local is
// always 00:00 UTC (the next calendar day), no seasonal adjustment needed.

export default async (req) => {
  try {
    const origin = new URL(req.url).origin;
    await fetch(`${origin}/.netlify/functions/atlas-eod-background`, {
      method: "POST",
      headers: { "x-atlas-trigger-secret": Netlify.env.get("ATLAS_TRIGGER_SECRET") || "" },
    });
    console.log("atlas-eod-schedule: triggered the EOD recap.");
  } catch (e) {
    console.error("atlas-eod-schedule: failed to trigger:", e.message);
  }
};

export const config = {
  schedule: "0 0 * * *",
};
