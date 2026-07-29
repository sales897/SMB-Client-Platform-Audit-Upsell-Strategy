// netlify/functions/atlas-ingest-schedule.mjs
//
// Fires the ATLAS Close ingest on a schedule. Scheduled functions have a
// hard 30-second execution limit, so this does the minimum: trigger the
// background function and return. It does not wait for ingestion itself
// to finish (that can take several minutes across all linked clients).
//
// Cadence: every 30 minutes. Adjust below if Oscar wants tighter turnaround
// once real usage patterns are visible — there's no strong reason it needs
// to be faster than Close call volume actually warrants.

export default async (req) => {
  const { next_run } = await req.json().catch(() => ({}));
  try {
    const origin = new URL(req.url).origin;
    await fetch(`${origin}/.netlify/functions/atlas-ingest-background`, { method: "POST" });
    console.log("atlas-ingest-schedule: triggered ingest. Next run:", next_run);
  } catch (e) {
    console.error("atlas-ingest-schedule: failed to trigger ingest:", e.message);
  }
};

export const config = {
  schedule: "*/30 * * * *",
};
