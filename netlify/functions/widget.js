/*!
 * Niche Inc. Chat Widget (2026-07-15)
 * Embeddable AI lead-capture chat widget. Drop this on any client website:
 *   <script src="https://niche-client-hub.netlify.app/widget.js" data-widget-id="YOUR_WIDGET_ID"></script>
 *
 * Architecture notes:
 * - Runs inside a Shadow DOM so its styles can never leak into (or be
 *   broken by) the host site's own CSS, and vice versa.
 * - Reads its own config (agent name, color, welcome prompt, what to
 *   collect) directly from Supabase via the public anon key -- safe,
 *   since that config has no lead PII in it, just widget settings.
 * - All actual conversation (messages, lead info) goes through the
 *   widget-chat Netlify Function, never directly to Supabase -- that
 *   function is the only thing with write access to lead data, using a
 *   service-role key that never appears in this file. This script never
 *   sees or needs that key.
 * - conversation_id is kept in this visitor's own localStorage (scoped per
 *   widget id) so refreshing the page continues the same conversation
 *   instead of starting over.
 */
(function () {
  const SCRIPT_TAG = document.currentScript;
  const WIDGET_ID = SCRIPT_TAG && SCRIPT_TAG.getAttribute('data-widget-id');
  if (!WIDGET_ID) {
    console.warn('[Niche Chat Widget] Missing data-widget-id attribute — widget will not load.');
    return;
  }

  const SUPABASE_URL = 'https://banmahudemvjkygwihsd.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJhbm1haHVkZW12amt5Z3dpaHNkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5MjIzOTIsImV4cCI6MjA5ODQ5ODM5Mn0.01Y4i_nAFt-wmN-YNcE3dw_3od0NoU4HgvjwSCWw0cc';
  const CHAT_ENDPOINT = 'https://niche-client-hub.netlify.app/.netlify/functions/widget-chat';
  const STORAGE_KEY = 'niche_widget_conv_' + WIDGET_ID;

  let widgetConfig = null;
  let conversationId = null;
  try { conversationId = localStorage.getItem(STORAGE_KEY) || null; } catch (e) {}
  let isOpen = false;
  let isSending = false;

  async function fetchWidgetConfig() {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/chat_widgets?id=eq.${encodeURIComponent(WIDGET_ID)}&select=*`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
    const rows = await res.json();
    return Array.isArray(rows) ? rows[0] : null;
  }

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === 'style') node.style.cssText = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    });
    children.flat().forEach((c) => {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  async function init() {
    try {
      widgetConfig = await fetchWidgetConfig();
    } catch (e) {
      console.warn('[Niche Chat Widget] Could not load widget config:', e.message);
      return;
    }
    if (!widgetConfig || widgetConfig.active === false) return;

    const host = el('div', { id: 'niche-chat-widget-host', style: 'position:fixed;bottom:20px;right:20px;z-index:2147483000;' });
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });

    const color = widgetConfig.orb_color || '#e2541f';
    const style = el('style', {}, `
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      .orb {
        width: 60px; height: 60px; border-radius: 50%; cursor: pointer; border: none;
        background: radial-gradient(circle at 35% 30%, #fff, ${color} 45%, ${color});
        box-shadow: 0 0 24px ${color}, 0 4px 16px rgba(0,0,0,.3);
        display: flex; align-items: center; justify-content: center; font-size: 26px;
        transition: transform .2s ease;
      }
      .orb:hover { transform: scale(1.08); }
      .panel {
        position: absolute; bottom: 76px; right: 0; width: 340px; max-width: calc(100vw - 40px);
        height: 480px; max-height: calc(100vh - 120px); background: #0f0906; border: 1px solid #332318;
        border-radius: 16px; box-shadow: 0 12px 40px rgba(0,0,0,.5); display: none; flex-direction: column;
        overflow: hidden;
      }
      .panel.open { display: flex; }
      .panel-hd { padding: 14px 16px; background: linear-gradient(135deg, ${color}, ${color}); display: flex; align-items: center; gap: 10px; }
      .panel-hd .name { color: #fff; font-weight: 700; font-size: 14px; }
      .panel-hd .sub { color: rgba(255,255,255,.85); font-size: 11px; }
      .panel-hd .close { margin-left: auto; background: none; border: none; color: #fff; font-size: 18px; cursor: pointer; opacity: .85; }
      .thread { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; background: #0f0906; }
      .msg { max-width: 82%; padding: 8px 12px; border-radius: 12px; font-size: 13px; line-height: 1.5; }
      .msg.lead { align-self: flex-end; background: ${color}; color: #fff; border-bottom-right-radius: 3px; }
      .msg.assistant { align-self: flex-start; background: #1c150f; color: #f3ede7; border-bottom-left-radius: 3px; }
      .typing { align-self: flex-start; color: #8a7a6c; font-size: 12px; padding: 4px 12px; }
      .composer { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #262626; background: #0f0906; }
      .composer input { flex: 1; background: #1c150f; border: 1px solid #332318; border-radius: 20px; padding: 9px 14px; color: #f3ede7; font-size: 13px; outline: none; }
      .composer button { background: ${color}; border: none; color: #fff; border-radius: 50%; width: 36px; height: 36px; cursor: pointer; font-size: 15px; flex-shrink: 0; }
      .composer button:disabled { opacity: .5; cursor: default; }
    `);
    shadow.appendChild(style);

    const orb = el('button', { class: 'orb', 'aria-label': 'Open chat', onclick: togglePanel }, '💬');
    const closeBtn = el('button', { class: 'close', 'aria-label': 'Close chat', onclick: togglePanel }, '✕');
    const thread = el('div', { class: 'thread' });
    const input = el('input', { type: 'text', placeholder: 'Type a message…', onkeydown: (e) => { if (e.key === 'Enter') sendMessage(); } });
    const sendBtn = el('button', { onclick: sendMessage }, '➤');
    const panel = el('div', { class: 'panel' },
      el('div', { class: 'panel-hd' },
        el('div', {}, el('div', { class: 'name' }, widgetConfig.agent_name || 'Assistant'), el('div', { class: 'sub' }, 'AI Assistant')),
        closeBtn
      ),
      thread,
      el('div', { class: 'composer' }, input, sendBtn)
    );
    const wrap = el('div', { style: 'position:relative' }, panel, orb);
    shadow.appendChild(wrap);

    function togglePanel() {
      isOpen = !isOpen;
      panel.classList.toggle('open', isOpen);
      if (isOpen && thread.children.length === 0) {
        appendMessage('assistant', widgetConfig.welcome_prompt || `Hi! I'm ${widgetConfig.agent_name || 'your AI assistant'}. How can I help?`);
      }
      if (isOpen) input.focus();
    }

    function appendMessage(role, text) {
      const bubble = el('div', { class: `msg ${role}` }, text);
      thread.appendChild(bubble);
      thread.scrollTop = thread.scrollHeight;
    }

    async function sendMessage() {
      const text = input.value.trim();
      if (!text || isSending) return;
      input.value = '';
      appendMessage('lead', text);
      isSending = true;
      sendBtn.disabled = true;
      const typingEl = el('div', { class: 'typing' }, `${widgetConfig.agent_name || 'Assistant'} is typing…`);
      thread.appendChild(typingEl);
      thread.scrollTop = thread.scrollHeight;
      try {
        const res = await fetch(CHAT_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ widget_id: WIDGET_ID, conversation_id: conversationId, message: text }),
        });
        const data = await res.json();
        typingEl.remove();
        if (!res.ok) throw new Error(data.error || 'Something went wrong.');
        conversationId = data.conversation_id;
        try { localStorage.setItem(STORAGE_KEY, conversationId); } catch (e) {}
        appendMessage('assistant', data.reply || "Sorry, I didn't catch that — could you try again?");
      } catch (e) {
        typingEl.remove();
        appendMessage('assistant', "Sorry, I'm having trouble connecting right now. Please try again in a moment.");
        console.warn('[Niche Chat Widget]', e.message);
      } finally {
        isSending = false;
        sendBtn.disabled = false;
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
