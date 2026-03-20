/* global window, document, location, EventSource */

(function () {
  let wallet = null;
  let myAddress = null;
  let myKeypair = null;
  let activeConversation = null;
  let eventSource = null;
  let expiryTimers = [];
  let isRegistered = false;

  const $ = (id) => document.getElementById(id);

  function shortAddr(addr) {
    return addr.slice(0, 6) + '..' + addr.slice(-4);
  }

  function setStatus(msg, type) {
    const el = $('status');
    el.textContent = msg;
    el.className = 'status' + (type ? ' ' + type : '');
  }

  function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function ttlLabel(seconds) {
    if (seconds < 60) return seconds + 's';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
    return Math.floor(seconds / 3600) + 'h';
  }

  function clearExpiryTimers() {
    for (const t of expiryTimers) clearTimeout(t);
    expiryTimers = [];
  }

  function scheduleExpiry(msgEl, expiresAt) {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      msgEl.remove();
      return;
    }

    // Start fade 5s before expiry
    const fadeStart = Math.max(remaining - 5000, 0);
    const fadeTimer = setTimeout(() => {
      msgEl.classList.add('fading');
    }, fadeStart);
    expiryTimers.push(fadeTimer);

    const removeTimer = setTimeout(() => {
      msgEl.remove();
    }, remaining);
    expiryTimers.push(removeTimer);
  }

  function renderMessage(msg, plaintext) {
    const isMine = msg.sender === myAddress;
    const el = document.createElement('div');
    el.className = 'msg ' + (isMine ? 'msg-mine' : 'msg-theirs');
    el.dataset.id = msg.id;

    const ttl = ttlLabel(msg.ttl_seconds);
    el.innerHTML =
      '<div class="msg-text"></div>' +
      '<div class="msg-meta">' +
        '<span class="msg-time">' + formatTime(msg.created_at) +
        '</span>' +
        '<span class="msg-ttl">' + ttl + '</span>' +
      '</div>';
    el.querySelector('.msg-text').textContent = plaintext;

    return el;
  }

  async function decryptMessage(msg) {
    const isMine = msg.sender === myAddress;
    const ct = isMine ? msg.ct_sender : msg.ct_recipient;
    const eph = isMine
      ? msg.ephemeral_pub_sender
      : msg.ephemeral_pub_recipient;
    const iv = isMine ? msg.iv_sender : msg.iv_recipient;

    return window.chatCrypto.decrypt(ct, eph, iv, myKeypair.seed);
  }

  async function loadConversations() {
    const res = await window.chatSession.authedFetch(
      '/api/conversations',
    );
    const { conversations } = await res.json();

    const list = $('convList');
    list.innerHTML = '';
    for (const conv of conversations) {
      const el = document.createElement('div');
      el.className = 'conv-item';
      if (
        activeConversation
        && conv.counterparty === activeConversation
      ) {
        el.classList.add('active');
      }
      el.dataset.address = conv.counterparty;
      el.innerHTML =
        '<div class="conv-addr">' +
          shortAddr(conv.counterparty) +
        '</div>' +
        '<div class="conv-time">' +
          formatTime(conv.last_message_at) +
        '</div>';
      el.addEventListener('click', () => {
        openConversation(conv.counterparty);
      });
      list.appendChild(el);
    }
  }

  async function loadMessages(address) {
    const res = await window.chatSession.authedFetch(
      '/api/messages/' + address,
    );
    const { messages } = await res.json();

    const container = $('messages');
    container.innerHTML = '';
    clearExpiryTimers();

    // Messages come newest-first; reverse for display
    const sorted = messages.reverse();
    for (const msg of sorted) {
      try {
        const plaintext = await decryptMessage(msg);
        const el = renderMessage(msg, plaintext);
        container.appendChild(el);
        scheduleExpiry(el, msg.expires_at);
      } catch {
        const el = document.createElement('div');
        el.className = 'msg msg-error';
        el.textContent = '[decryption failed]';
        container.appendChild(el);
      }
    }

    container.scrollTop = container.scrollHeight;
  }

  async function openConversation(address) {
    activeConversation = address.toLowerCase();

    // Update URL without reload
    window.history.replaceState(
      null, '', '/chat/' + activeConversation,
    );

    // Update sidebar highlight
    const items = document.querySelectorAll('.conv-item');
    for (const el of items) {
      el.classList.toggle(
        'active', el.dataset.address === activeConversation,
      );
    }

    // Show chat pane
    $('chatEmpty').style.display = 'none';
    $('chatPane').style.display = 'flex';
    $('chatWith').textContent = shortAddr(activeConversation);

    // On mobile, hide sidebar
    if (window.innerWidth <= 640) {
      $('sidebar').classList.add('hidden');
      $('chatArea').classList.add('mobile-active');
    }

    await loadMessages(activeConversation);
    $('msgInput').focus();
  }

  async function sendMessage() {
    if (!activeConversation || !myKeypair) return;
    if (!isRegistered) {
      setStatus('Register your encryption key first', 'error');
      return;
    }
    const input = $('msgInput');
    const text = input.value.trim();
    if (!text) return;

    const ttlSelect = $('ttlSelect');
    const ttl = Number(ttlSelect.value);

    // Fetch recipient pubkey
    const pubRes = await fetch(
      '/api/pubkey/' + activeConversation,
    );
    if (!pubRes.ok) {
      setStatus('Recipient not registered', 'error');
      return;
    }
    const { pubkey: recipientPubkey } = await pubRes.json();

    // Double encrypt: once for recipient, once for sender
    const [forRecipient, forSender] = await Promise.all([
      window.chatCrypto.encrypt(text, recipientPubkey),
      window.chatCrypto.encrypt(text, myKeypair.pubkey),
    ]);

    const res = await window.chatSession.authedFetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: activeConversation,
        ct_recipient: forRecipient.ciphertext,
        ephemeral_pub_recipient: forRecipient.ephemeral_pubkey,
        iv_recipient: forRecipient.iv,
        ct_sender: forSender.ciphertext,
        ephemeral_pub_sender: forSender.ephemeral_pubkey,
        iv_sender: forSender.iv,
        ttl: ttl,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      setStatus(err.error || 'Send failed', 'error');
      return;
    }

    input.value = '';
    await loadMessages(activeConversation);
  }

  function connectSSE() {
    const token = window.chatSession.getToken();
    if (!token) return;

    if (eventSource) eventSource.close();
    eventSource = new EventSource(
      '/api/events?token=' + encodeURIComponent(token),
    );

    eventSource.addEventListener('message', async (e) => {
      const data = JSON.parse(e.data);
      const other = data.sender === myAddress
        ? data.recipient
        : data.sender;
      try {
        if (
          activeConversation
          && (other === activeConversation
            || data.sender === activeConversation)
        ) {
          await loadMessages(activeConversation);
        }
        await loadConversations();
      } catch (err) {
        if (err.message === 'Session expired') {
          eventSource.close();
          showConnectPrompt();
          setStatus('Session expired — reconnect to continue', 'error');
        }
      }
    });

    eventSource.addEventListener('error', () => {
      // Auto-reconnect is built into EventSource
    });
  }

  function showNewChatDialog() {
    const addr = window.prompt('Enter ETH address:');
    if (!addr) return;
    const clean = addr.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(clean)) {
      setStatus('Invalid address format', 'error');
      return;
    }
    openConversation(clean);
  }

  async function checkRegistration(address) {
    const res = await fetch('/api/pubkey/' + address);
    return res.ok;
  }

  function showConnectPrompt() {
    $('connectPrompt').hidden = false;
    $('walletArea').style.display = 'none';
  }

  function hideConnectPrompt() {
    $('connectPrompt').hidden = true;
  }

  function showRegistrationBanner() {
    $('registerBanner').hidden = false;
  }

  async function afterConnect(address) {
    hideConnectPrompt();
    myAddress = address;
    $('myAddr').textContent = shortAddr(myAddress);
    $('walletArea').style.display = 'flex';
    wallet.onAccountChange(() => location.reload());

    setStatus('Authenticating...');
    try {
      await window.chatSession.authenticate(wallet, myAddress);
    } catch (e) {
      setStatus('Auth failed: ' + (e.message || String(e)), 'error');
      showConnectPrompt();
      return;
    }

    setStatus('Checking registration...');
    isRegistered = await checkRegistration(myAddress);
    if (!isRegistered) showRegistrationBanner();

    setStatus('Deriving keypair...');
    try {
      myKeypair = await window.chatCrypto.deriveKeypair(wallet, myAddress);
    } catch (e) {
      setStatus(window.walletErrorMessage(e), 'error');
      return;
    }

    setStatus('');
    await loadConversations();
    connectSSE();

    const pathMatch = location.pathname.match(/^\/chat\/(0x[0-9a-f]{40})$/i);
    if (pathMatch) await openConversation(pathMatch[1]);

    $('sendBtn').addEventListener('click', sendMessage);
    $('msgInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    $('newChatBtn').addEventListener('click', showNewChatDialog);
    $('backBtn').addEventListener('click', () => {
      $('sidebar').classList.remove('hidden');
      $('chatArea').classList.remove('mobile-active');
    });
    $('disconnectBtn').addEventListener('click', () => {
      window.chatSession.clearToken();
      if (eventSource) eventSource.close();
      location.reload();
    });
  }

  async function init() {
    setStatus('Loading wallet...');
    try {
      wallet = await import('/wallet.js');
    } catch {
      setStatus('Failed to load wallet module', 'error');
      return;
    }

    // Attach connect button listener before any async work
    $('connectBtn').addEventListener('click', async () => {
      try {
        const address = await wallet.connectWallet(window.WC_PROJECT_ID, location.origin);
        await afterConnect(address);
      } catch (e) {
        setStatus(
          e.message === 'Connection cancelled'
            ? 'Connection cancelled.'
            : window.walletErrorMessage(e),
          'error',
        );
      }
    });

    setStatus('Reconnecting wallet...');
    const address = await wallet.reconnectIfAvailable(window.WC_PROJECT_ID);

    if (address) {
      await afterConnect(address);
    } else {
      showConnectPrompt();
      setStatus('');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
