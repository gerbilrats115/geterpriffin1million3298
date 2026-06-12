const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

// === In-memory store (no files, no persistence) ===
let MESSAGES = [];             // { user, text, enc, time, color }
let CLIENTS = new Map();       // username -> { ws, color }
const COLORS = ['#f66','#6f6','#66f','#ff6','#f6f','#6ff','#fa6','#a6f','#6af','#faa'];
const MAX_MESSAGES = 1000;

// === HTTP Server ===
const server = http.createServer((req, res) => {
  const url = req.url;

  // Health check
  if (url === '/healthz') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      clients: CLIENTS.size,
      messages: MESSAGES.length,
      memory: process.memoryUsage().heapUsed
    }));
    return;
  }

  // Restart endpoint — wipes all state, clients reconnect clean
  if (url === '/restart') {
    // Close all WebSocket connections
    for (const [, c] of CLIENTS) {
      try { c.ws.close(1001, 'server restart'); } catch { /* */ }
    }
    // Wipe state
    MESSAGES = [];
    CLIENTS = new Map();
    // Force garbage collection isn't possible in JS, but this dereferences everything
    console.log('server restarted by /restart endpoint');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'restarted', timestamp: Date.now() }));
    return;
  }

  // Main chat client
  if (url === '/') return serveClient(res);

  res.writeHead(404);
  res.end('not found');
});

// === WebSocket Server ===
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ server, maxPayload: 131072 });  // 128KB for up to 10k char messages

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const [, c] of CLIENTS) {
    if (c.ws.readyState === 1) {
      try { c.ws.send(msg); } catch { /* client gone */ }
    }
  }
}

function sendTo(ws, obj) {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
  }
}

wss.on('connection', (ws, req) => {
  let username = null;
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];

  // Send current history
  sendTo(ws, { type: 'history', msgs: MESSAGES.map(m => ({ ...m })) });

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }

    if (!data.user || typeof data.text !== 'string') return;
    if (data.user.length > 20 || data.text.length > 10000) return;

    if (username && username !== data.user) CLIENTS.delete(username);
    username = data.user;

    const existing = CLIENTS.get(username);
    if (existing && existing.ws !== ws) {
      try { existing.ws.close(4000, 'duplicate login'); } catch { /* */ }
      CLIENTS.delete(username);
    }

    CLIENTS.set(username, { ws, color });

    const msg = {
      user: username,
      text: data.text,
      enc: !!data.enc,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      color
    };

    MESSAGES.push(msg);

    if (MESSAGES.length > MAX_MESSAGES) {
      MESSAGES.splice(0, MESSAGES.length - MAX_MESSAGES);
    }

    broadcast({ type: 'msg', msg });
  });

  ws.on('close', () => {
    if (username) CLIENTS.delete(username);
  });

  ws.on('error', () => {
    if (username) CLIENTS.delete(username);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`chat server listening on 0.0.0.0:${PORT}`);
});

// === Inline Client HTML ===
function serveClient(res) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>encrypted chat</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font:14px/1.4 system-ui,sans-serif;background:#0d0d0d;color:#ccc;height:100vh;display:flex;flex-direction:column}
header{background:#1a1a1a;padding:10px 14px;border-bottom:1px solid #333;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
header label{color:#888;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
header input[type=password]{background:#222;border:1px solid #444;color:#ccc;padding:6px 10px;border-radius:4px;font:13px monospace;flex:1;min-width:140px;font-family:monospace}
header input[type=password]:focus{outline:none;border-color:#6af}
header input[type=password]::placeholder{color:#555}
#status{font-size:12px;color:#888}
#status.online{color:#4c4}
#status.error{color:#c44}
#chat{flex:1;overflow-y:auto;padding:10px 14px;display:flex;flex-direction:column;gap:2px;scroll-behavior:smooth}
.msg{padding:3px 0;line-height:1.5;word-break:break-word}
.msg .user{font-weight:600;cursor:default}
.msg .time{font-size:11px;color:#555;margin-left:8px}
.msg .text{color:#ddd}
.msg.enc .text{color:#a60;font-style:italic}
#bottom{border-top:1px solid #333;background:#1a1a1a;padding:10px 14px;display:flex;gap:8px}
#nameInput{background:#222;border:1px solid #444;color:#ccc;padding:6px 10px;border-radius:4px;font:13px monospace;width:110px}
#msgInput{background:#222;border:1px solid #444;color:#ccc;padding:6px 10px;border-radius:4px;font:13px;flex:1}
#msgInput:focus{outline:none;border-color:#6af}
button{background:#2a6;border:none;color:#fff;padding:6px 16px;border-radius:4px;font:13px;cursor:pointer;font-weight:500}
button:hover{background:#3a8}
button:active{background:#295}
</style>
</head>
<body>
<header>
  <label for="keyField">key</label>
  <input type="password" id="keyField" placeholder="enter shared key" autocomplete="off" spellcheck="false">
  <span id="status">connecting...</span>
</header>
<div id="chat"></div>
<div id="bottom">
  <input type="text" id="nameInput" placeholder="name" value="username" maxlength="20">
  <input type="text" id="msgInput" placeholder="type message..." autocomplete="off">
  <button id="sendBtn">send</button>
</div>
<script>
(function(){
'use strict';

let cryptoKey = null;
let keyTimer = null;
const PBKDF2_ITERATIONS = 600000;
const SALT = new TextEncoder().encode('hackerchat-v1');

async function deriveKey(passphrase) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: SALT, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function aesEncrypt(plaintext) {
  if (!cryptoKey) return { data: plaintext, encrypted: false };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, cryptoKey, encoded
  );
  const combined = new Uint8Array(iv.length + new Uint8Array(cipherBuf).length);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipherBuf), iv.length);
  return { data: btoa(String.fromCharCode(...combined)), encrypted: true };
}

async function aesDecrypt(payload) {
  if (!cryptoKey) return null;
  try {
    const raw = Uint8Array.from(atob(payload), c => c.charCodeAt(0));
    if (raw.length < 13) return null;
    const iv = raw.slice(0, 12);
    const data = raw.slice(12);
    const decBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv }, cryptoKey, data
    );
    return new TextDecoder().decode(decBuf);
  } catch {
    return null;
  }
}

const chat = document.getElementById('chat');
const keyField = document.getElementById('keyField');
const statusEl = document.getElementById('status');
const nameInput = document.getElementById('nameInput');
const msgInput = document.getElementById('msgInput');
const sendBtn = document.getElementById('sendBtn');

let messageCache = [];

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

async function renderAll() {
  chat.innerHTML = '';
  for (const m of messageCache) {
    await renderMsg(m, true);
  }
  chat.scrollTop = chat.scrollHeight;
}

async function renderMsg(m, append = true) {
  const div = document.createElement('div');
  div.className = 'msg' + (m.enc ? ' enc' : '');

  let displayText;
  if (m.enc && cryptoKey) {
    const dec = await aesDecrypt(m.text);
    if (dec !== null) {
      displayText = escHtml(dec);
    } else {
      displayText = '<span style="color:#a60">wrong key</span>';
    }
  } else if (m.enc) {
    displayText = '<span style="color:#666">encrypted</span>';
  } else {
    displayText = escHtml(m.text);
  }

  div.innerHTML = '<span class="user" style="color:' + escHtml(m.color) + '">' +
    escHtml(m.user) + '</span>' +
    '<span class="time">' + escHtml(m.time) + '</span>' +
    '<span class="text"> ' + displayText + '</span>';

  if (append) chat.appendChild(div);
  else chat.insertBefore(div, chat.firstChild);
}

keyField.addEventListener('input', () => {
  clearTimeout(keyTimer);
  keyTimer = setTimeout(async () => {
    const phrase = keyField.value;
    if (!phrase) {
      cryptoKey = null;
      renderAll();
      return;
    }
    try {
      cryptoKey = await deriveKey(phrase);
    } catch {
      cryptoKey = null;
    }
    renderAll();
  }, 150);
});

const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(proto + '//' + location.host);

ws.onopen = () => {
  statusEl.textContent = 'connected';
  statusEl.className = 'online';
};
ws.onclose = () => {
  statusEl.textContent = 'disconnected';
  statusEl.className = 'error';
};
ws.onerror = () => {
  statusEl.textContent = 'connection error';
  statusEl.className = 'error';
};

ws.onmessage = async (ev) => {
  const data = JSON.parse(ev.data);
  if (data.type === 'history') {
    messageCache = data.msgs;
    renderAll();
  } else if (data.type === 'msg') {
    messageCache.push(data.msg);
    await renderMsg(data.msg, true);
    chat.scrollTop = chat.scrollHeight;
  }
};

async function sendMessage() {
  const text = msgInput.value.trim();
  const user = nameInput.value.trim() || 'anon';
  if (!text) return;
  msgInput.value = '';

  let payload, isEnc;
  if (cryptoKey) {
    const result = await aesEncrypt(text);
    payload = result.data;
    isEnc = result.encrypted;
  } else {
    payload = text;
    isEnc = false;
  }

  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ user, text: payload, enc: isEnc }));
  }
}

sendBtn.addEventListener('click', sendMessage);
msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendMessage();
});

})();
</script>
</body>
</html>`;
  res.writeHead(200, {
    'Content-Type': 'text/html',
    'Cache-Control': 'no-cache, no-store, must-revalidate'
  });
  res.end(html);
}