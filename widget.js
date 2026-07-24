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
  const POLL_ENDPOINT = 'https://niche-client-hub.netlify.app/.netlify/functions/widget-poll';
  const STORAGE_KEY = 'niche_widget_conv_' + WIDGET_ID;
  const POLL_INTERVAL_MS = 4000;

  let widgetConfig = null;
  let conversationId = null;
  try { conversationId = localStorage.getItem(STORAGE_KEY) || null; } catch (e) {}
  let isOpen = false;
  let isSending = false;
  let pollTimer = null;
  let lastSeenAt = null; // ISO timestamp of the newest message already shown -- polling only asks for messages after this
  let handledByHuman = false;
  const shownMessageIds = new Set(); // guards against polling re-delivering a message already shown directly

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

    const dockLeft = widgetConfig.dock_position === 'left';
    const host = el('div', { id: 'niche-chat-widget-host', style: `position:fixed;bottom:20px;${dockLeft ? 'left' : 'right'}:20px;z-index:2147483000;` });
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });

    const color = widgetConfig.orb_color || '#e2541f';
    const isCompact = widgetConfig.dock_size === 'compact';
    const orbSize = isCompact ? 48 : 60;
    const panelW = isCompact ? 300 : 340;
    const panelH = isCompact ? 420 : 480;
    const style = el('style', {}, `
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      .orb {
        width: ${orbSize}px; height: ${orbSize}px; border-radius: 50%; cursor: pointer; border: none;
        background: radial-gradient(circle at 35% 30%, #fff, ${color} 45%, ${color});
        box-shadow: 0 0 24px ${color}, 0 4px 16px rgba(0,0,0,.3);
        display: flex; align-items: center; justify-content: center; overflow: hidden;
        transition: transform .2s ease;
      }
      .orb svg { width: 100%; height: 100%; }
      .orb:hover { transform: scale(1.08); }
      .panel {
        position: absolute; bottom: 76px; ${dockLeft ? 'left' : 'right'}: 0; width: ${panelW}px; max-width: calc(100vw - 40px);
        height: ${panelH}px; max-height: calc(100vh - 120px); background: #0f0906; border: 1px solid #332318;
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
      .msg.human { align-self: flex-start; background: #16213a; color: #f3ede7; border-bottom-left-radius: 3px; border: 1px solid #2a3d5c; }
      .msg-who { font-size: 10px; font-weight: 700; opacity: .65; margin-bottom: 3px; text-transform: uppercase; letter-spacing: .03em; }
      .status-banner { font-size: 11px; color: #8ecbff; background: #16213a; padding: 6px 14px; text-align: center; border-bottom: 1px solid #2a3d5c; display: none; }
      .status-banner.show { display: block; }
      .typing { align-self: flex-start; color: #8a7a6c; font-size: 12px; padding: 4px 12px; }
      .composer { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #262626; background: #0f0906; }
      .composer input { flex: 1; background: #1c150f; border: 1px solid #332318; border-radius: 20px; padding: 9px 14px; color: #f3ede7; font-size: 16px; outline: none; }
      .composer button { background: ${color}; border: none; color: #fff; border-radius: 50%; width: 36px; height: 36px; cursor: pointer; font-size: 15px; flex-shrink: 0; }
      .composer button:disabled { opacity: .5; cursor: default; }
    `);
    shadow.appendChild(style);

    // Same illustrated avatar set as the Hub's Configure Widget panel --
    // kept in sync manually since this is a separate deployed file.
    const CW_AVATAR_SVGS = {
      nova: '<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg"><defs><radialGradient id="novaG" cx="35%" cy="30%" r="70%"><stop offset="0%" stop-color="#fff"/><stop offset="45%" stop-color="#e2541f"/><stop offset="100%" stop-color="#a83913"/></radialGradient></defs><circle cx="20" cy="20" r="20" fill="url(#novaG)"/><path d="M20 10l2 6 6 2-6 2-2 6-2-6-6-2 6-2z" fill="#fff" opacity=".9"/></svg>',
      robot: '<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg"><circle cx="20" cy="20" r="20" fill="#3b3226"/><rect x="10" y="12" width="20" height="16" rx="5" fill="#e2541f"/><circle cx="16" cy="20" r="2.4" fill="#fff"/><circle cx="24" cy="20" r="2.4" fill="#fff"/><rect x="18" y="6" width="4" height="5" rx="2" fill="#e2541f"/></svg>',
      male1: '<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg"><circle cx="20" cy="20" r="20" fill="#3b82f6"/><path d="M6 40a14 14 0 0 1 28 0z" fill="#d9a066"/><circle cx="20" cy="16" r="8" fill="#d9a066"/><path d="M12 14c0-5 4-9 8-9s8 4 8 9h-2c-1-3-3-6-6-6s-5 3-6 6z" fill="#3a2a1a"/></svg>',
      male2: '<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg"><circle cx="20" cy="20" r="20" fill="#22c55e"/><path d="M6 40a14 14 0 0 1 28 0z" fill="#c98a52"/><circle cx="20" cy="16" r="8" fill="#c98a52"/><path d="M12 14c0-5 4-8 8-8s8 3 8 8h-2c-1-2-3-4-6-4s-5 2-6 4z" fill="#2b2118"/><path d="M13 19c0 4 3 7 7 7s7-3 7-7" fill="none" stroke="#2b2118" stroke-width="2.5" stroke-linecap="round"/></svg>',
      female1: '<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg"><circle cx="20" cy="20" r="20" fill="#ec4899"/><path d="M6 40a14 14 0 0 1 28 0z" fill="#e8b48a"/><circle cx="20" cy="16" r="8" fill="#e8b48a"/><path d="M9 31c-1-9 3-19 11-19s12 10 11 19c-1-3-2-5-2-5v-5a9 9 0 0 0-18 0v5s-1 2-2 5z" fill="#5a3a2a"/></svg>',
      female2: '<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg"><circle cx="20" cy="20" r="20" fill="#a855f7"/><path d="M6 40a14 14 0 0 1 28 0z" fill="#f0c29a"/><circle cx="20" cy="16" r="8" fill="#f0c29a"/><path d="M12 14c0-5 4-8 8-8s8 3 8 8c0 1-1 2-1 2s0-4-3-5c-1 2-3 3-5 3s-4-1-5-3c-3 1-3 5-3 5s-1-1-1-2z" fill="#3a2a1a"/><circle cx="20" cy="5" r="3.2" fill="#3a2a1a"/></svg>',
    };
    const orb = el('button', { class: 'orb', 'aria-label': 'Open chat', onclick: togglePanel });
    if (widgetConfig.avatar_image_url) {
      orb.style.backgroundImage = `url(${widgetConfig.avatar_image_url})`;
      orb.style.backgroundSize = 'cover';
      orb.style.backgroundPosition = 'center';
    } else {
      orb.innerHTML = CW_AVATAR_SVGS[widgetConfig.avatar] || CW_AVATAR_SVGS.nova;
    }
    const closeBtn = el('button', { class: 'close', 'aria-label': 'Close chat', onclick: togglePanel }, '✕');
    const statusBanner = el('div', { class: 'status-banner' }, '');
    const thread = el('div', { class: 'thread' });
    const input = el('input', { type: 'text', placeholder: 'Type a message…', onkeydown: (e) => { if (e.key === 'Enter') sendMessage(); } });
    const sendBtn = el('button', { onclick: sendMessage }, '➤');
    const panel = el('div', { class: 'panel' },
      el('div', { class: 'panel-hd' },
        el('div', {}, el('div', { class: 'name' }, widgetConfig.agent_name || 'Assistant'), el('div', { class: 'sub' }, 'AI Assistant')),
        closeBtn
      ),
      statusBanner,
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
        lastSeenAt = new Date().toISOString();
      }
      if (isOpen) {
        input.focus();
        startPolling();
      } else {
        stopPolling();
      }
    }

    function appendMessage(role, text, who) {
      const bubble = el('div', { class: `msg ${role}` },
        who ? el('div', { class: 'msg-who' }, who) : null,
        text
      );
      thread.appendChild(bubble);
      thread.scrollTop = thread.scrollHeight;
      return bubble;
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
        if (data.handled_by === 'human') {
          // A team member already has this conversation -- the AI
          // deliberately did not generate a reply. Show the connected
          // banner and let polling deliver the human's actual reply,
          // rather than showing a confusing fallback error message.
          if (!handledByHuman) {
            handledByHuman = true;
            statusBanner.textContent = "You're now connected with a team member.";
            statusBanner.classList.add('show');
          }
        } else {
          if (data.message_id) shownMessageIds.add(data.message_id);
          appendMessage('assistant', data.reply || "Sorry, I didn't catch that — could you try again?");
        }
        lastSeenAt = new Date().toISOString();
        if (!pollTimer) startPolling();
      } catch (e) {
        typingEl.remove();
        appendMessage('assistant', "Sorry, I'm having trouble connecting right now. Please try again in a moment.");
        console.warn('[Niche Chat Widget]', e.message);
      } finally {
        isSending = false;
        sendBtn.disabled = false;
      }
    }

    // Polling picks up messages this widget didn't just send itself --
    // specifically, a human team member replying live from the Hub's
    // Inbox. Only runs while the panel is open, and only against this
    // one conversation_id (never a list of conversations).
    function startPolling() {
      if (pollTimer || !conversationId) return;
      pollTimer = setInterval(pollForNewMessages, POLL_INTERVAL_MS);
    }
    function stopPolling() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }
    async function pollForNewMessages() {
      if (!conversationId) return;
      try {
        const params = new URLSearchParams({ conversation_id: conversationId });
        if (lastSeenAt) params.set('after', lastSeenAt);
        const res = await fetch(`${POLL_ENDPOINT}?${params.toString()}`);
        if (!res.ok) return;
        const data = await res.json();
        const newMessages = (data.messages || []).filter((m) => m.role !== 'lead' && !shownMessageIds.has(m.id)); // never echo the visitor's own messages back, and never re-show one already displayed directly
        newMessages.forEach((m) => {
          shownMessageIds.add(m.id);
          appendMessage(m.role, m.content, m.role === 'human' ? 'Team member' : null);
          lastSeenAt = m.created_at;
        });
        if (data.handled_by === 'human' && !handledByHuman) {
          handledByHuman = true;
          statusBanner.textContent = "You're now connected with a team member.";
          statusBanner.classList.add('show');
        } else if (data.handled_by !== 'human' && handledByHuman) {
          handledByHuman = false;
          statusBanner.classList.remove('show');
        }
      } catch (e) {
        // Silent -- polling failures shouldn't interrupt the visitor's chat.
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
