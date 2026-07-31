// netlify/functions/atlas-weekly-trends-schedule.mjs
//
// Fires the weekly trends report every Friday at 4:00 PM Mexico City time
// (fixed UTC-6, no DST since 2022 -- same reasoning as the other
// schedules). Cron day-of-week 5 = Friday. Deliberately positioned before
// the 6pm EOD recap on the same day, not colliding with it.
//
// "Friday afternoon" was the ask, not an exact time -- 4pm was picked as
// a clear mid-afternoon slot. Easy one-line change if a different time
// is wanted.

export default async (req) => {
  try {
    const origin = new URL(req.url).origin;
    await fetch(`${origin}/.netlify/functions/atlas-weekly-trends-background`, {
      method: "POST",
      headers: { "x-atlas-trigger-secret": Netlify.env.get("ATLAS_TRIGGER_SECRET") || "" },
    });
    console.log("atlas-weekly-trends-schedule: triggered the weekly trends report.");
  } catch (e) {
    console.error("atlas-weekly-trends-schedule: failed to trigger:", e.message);
  }
};

export const config = {
  schedule: "0 22 * * 5",
};
