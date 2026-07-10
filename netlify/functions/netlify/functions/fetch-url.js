// Netlify Function — fetches a webpage server-side and extracts plain text.
//
// Browsers can't fetch arbitrary external websites directly from client-side
// JS (CORS blocks it), so this runs server-side instead, where that
// restriction doesn't apply. It does basic HTML-to-text extraction — good
// enough for pulling in docs pages, help articles, and simple marketing
// pages. It won't handle sites that render their content via JavaScript
// (the raw HTML for those is mostly empty until a browser runs their scripts).
//
// SETUP: same as ai-agent.js — just needs to sit at
// netlify/functions/fetch-url.js in your repo. No API key needed for this one.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { url } = payload;
  if (!url || !/^https?:\/\//i.test(url)) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'A valid http(s) URL is required' }) };
  }

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClientSuccessHubBot/1.0; +internal-tool)' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`Page returned ${res.status}`);
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      throw new Error(`This URL returned "${contentType}", not a webpage — can't extract text from it.`);
    }
    const html = await res.text();

    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<\/(p|div|br|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n\n')
      .trim();

    const MAX_CHARS = 20000; // keeps individual knowledge entries a reasonable size
    let truncated = false;
    if (text.length > MAX_CHARS) { text = text.slice(0, MAX_CHARS); truncated = true; }

    if (!text) throw new Error('No readable text found on this page (it may render its content with JavaScript, which this fetcher can\'t execute).');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, length: text.length, truncated }),
    };
  } catch (e) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e.message }),
    };
  }
};
