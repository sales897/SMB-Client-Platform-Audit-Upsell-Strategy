// netlify/functions/atlas-kb-ingest-schedule.mjs
//
// Fires the Knowledge Base ingest hourly. KB content (SOPs/docs) changes
// far less often than call notes, so this doesn't need the 30-min cadence
// atlas-ingest-schedule uses for Close notes.

export default async (req) => {
  try {
    const origin = new URL(req.url).origin;
    await fetch(`${origin}/.netlify/functions/atlas-kb-ingest-background`, {
      method: "POST",
      headers: { "x-atlas-trigger-secret": Netlify.env.get("ATLAS_TRIGGER_SECRET") || "" },
    });
    console.log("atlas-kb-ingest-schedule: triggered KB ingest.");
  } catch (e) {
    console.error("atlas-kb-ingest-schedule: failed to trigger:", e.message);
  }
};

export const config = {
  schedule: "0 * * * *",
};
