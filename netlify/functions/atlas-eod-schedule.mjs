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
  // Weekdays only (Mon-Fri evenings, local time), added 2026-08-08 per
  // Oscar's request. NOT the same "1-5" as the morning brief -- 00:00 UTC
  // is 6:00 PM the PREVIOUS day at Mexico City (-6h crosses midnight), so
  // a local Monday evening is actually UTC Tuesday 00:00. Mapped out
  // explicitly: UTC dow 2 (Tue) = Mon 6pm local, ... UTC dow 6 (Sat) =
  // Fri 6pm local. UTC dow 1 (Mon) would incorrectly fire Sunday evening
  // local -- do not "simplify" this back to 1-5, it would be wrong.
  schedule: "0 0 * * 2-6",
};
