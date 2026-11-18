'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
const { URL } = require('url');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const Busboy = require('busboy');
const { WebSocketServer } = require('ws');
const express = require('express');
const rateLimit = require('express-rate-limit');

function loadEnv() {
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  for (const raw of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const s = raw.trim();
    if (!s || s.startsWith('#') || !s.includes('=')) continue;
    const i = s.indexOf('=');
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    const k = s.slice(0, i).trim();
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadEnv();

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8000);
const DATA = path.join(__dirname, 'data');
const MEDIA = path.join(DATA, 'media');
const TMP = path.join(DATA, 'tmp');
fs.mkdirSync(MEDIA, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

function readBackendConfig() {
  try {
    const f = path.join(DATA, 'backend-config.json');
    if (!fs.existsSync(f)) return {};
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function publicBase() {
  const env = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (env && /^https:\/\//i.test(env) && !/your-domain\.example/i.test(env)) return env;
  const cfg = readBackendConfig();
  return String(cfg.backend_url || '').trim().replace(/\/+$/, '');
}

function detectCloudflaredUrl() {
  const candidates = [];
  if (process.env.CLOUDFLARED_LOG) {
    candidates.push(path.resolve(__dirname, process.env.CLOUDFLARED_LOG));
  }
  candidates.push(
    path.join(__dirname, 'logs', 'cloudflared.log'),
    path.join(process.cwd(), 'logs', 'cloudflared.log')
  );
  for (const logPath of candidates) {
    try {
      if (!fs.existsSync(logPath)) continue;
      const text = fs.readFileSync(logPath, 'utf8');
      const matches = text.match(/https:\/\/[-a-z0-9]+\.trycloudflare\.com/ig);
      if (matches?.length) return matches[matches.length - 1];
    } catch {}
  }
  return '';
}

function saveBackendConfig(url, source = 'manual') {
  const clean = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(clean)) throw Error('Backend URL must use HTTPS.');
  fs.mkdirSync(DATA, { recursive: true });
  const payload = {
    backend_url: clean,
    updated_at: new Date().toISOString(),
    source,
  };
  fs.writeFileSync(path.join(DATA, 'backend-config.json'), JSON.stringify(payload, null, 2) + '\n');
  try {
    fs.writeFileSync(
      path.join(__dirname, 'public', 'runtime-config.json'),
      JSON.stringify({ backend_url: clean, updated_at: payload.updated_at }, null, 2) + '\n'
    );
    fs.writeFileSync(path.join(__dirname, 'public', 'backend-url.txt'), clean + '\n');
    fs.writeFileSync(path.join(__dirname, 'backend-url.txt'), clean + '\n');
  } catch {}
  return payload;
}

async function publishFrontendRuntimeConfig(url) {
  const owner = String(process.env.GH_OWNER || '').trim();
  const repo = String(process.env.BACKEND_URL_REPO || process.env.FRONTEND_REPO || 'chat.app').trim();
  const branch = String(process.env.BACKEND_URL_BRANCH || 'main').trim();
  const filePath = String(process.env.BACKEND_URL_FILE || 'backend-url.txt').trim().replace(/^\/+/, '');
  const token = String(process.env.GITHUB_TOKEN || '').trim();

  if (!owner || !repo) throw Error('GH_OWNER and BACKEND_URL_REPO must be set in .env.');
  if (!token) throw Error('GITHUB_TOKEN is not set in .env.');

  const cleanUrl = String(url || '').trim().replace(/\/+$/, '');
  const rawBody = filePath.endsWith('.json')
    ? JSON.stringify({ backend_url: cleanUrl, updated_at: new Date().toISOString() }, null, 2) + '\n'
    : cleanUrl + '\n';
  const contentB64 = Buffer.from(rawBody, 'utf8').toString('base64');
  const apiBase = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'MyChat-Server',
    'Content-Type': 'application/json',
  };

  let sha = undefined;
  try {
    const check = await fetch(`${apiBase}?ref=${encodeURIComponent(branch)}`, { headers });
    if (check.ok) {
      const existing = await check.json();
      if (existing && existing.sha) sha = existing.sha;
    } else if (check.status === 401 || check.status === 403) {
      const errBody = await check.text();
      throw Error(`GitHub auth failed (${check.status}): ${errBody}`);
    }
  } catch (e) {
    if (/GitHub auth failed/i.test(e.message)) throw e;
  }

  const putBody = {
    message: `Update MyChat backend URL (${cleanUrl})`,
    content: contentB64,
    branch,
    ...(sha ? { sha } : {}),
  };

  const resp = await fetch(apiBase, {
    method: 'PUT',
    headers,
    body: JSON.stringify(putBody),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw Error(`GitHub API PUT failed (${resp.status}): ${text}`);
  }
  return { owner, repo, branch, path: filePath };
}

function isLocalAdminRequest(req) {
  const ip = String(req.socket?.remoteAddress || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function absoluteUrl(value) {
  const v = String(value || '');
  if (!v) return v;
  if (/^https?:\/\//i.test(v) || /^wss?:\/\//i.test(v)) return v;
  const b = publicBase();
  return b ? b + (v.startsWith('/') ? v : '/' + v) : v;
}

const pool = new Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'mychat',
  user: process.env.PGUSER || 'mychat',
  password: process.env.PGPASSWORD || 'mychat',
  max: Math.max(4, Math.min(30, Number(process.env.PG_POOL_MAX || 15))),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
  connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS || 5000),
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 8000),
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  maxUses: Number(process.env.PG_MAX_USES || 2000),
});

const connections = new Map();
const meta = new WeakMap();
const runtime = {
  started_at: new Date().toISOString(),
  messages_sent: 0,
  messages_received: 0,
  errors: [],
  last_error: null,
};

function logErr(e, k = 'runtime') {
  runtime.last_error = { kind: k, message: String(e?.message || e), at: new Date().toISOString() };
  runtime.errors.unshift(runtime.last_error);
  runtime.errors = runtime.errors.slice(0, 30);
  writeRuntime();
}

function writeRuntime() {
  try {
    const sockets = [...connections.values()].reduce((n, s) => n + s.size, 0);
    const m = process.memoryUsage();
    fs.writeFileSync(
      path.join(DATA, 'runtime.json'),
      JSON.stringify({
        ...runtime,
        pid: process.pid,
        node: process.version,
        platform: process.platform,
        uptime_sec: Math.round(process.uptime()),
        rss_mb: +(m.rss / 1048576).toFixed(1),
        heap_used_mb: +(m.heapUsed / 1048576).toFixed(1),
        users_with_sockets: connections.size,
        websocket_connections: sockets,
        loadavg: os.loadavg(),
      })
    );
  } catch {}
}

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();

function json(res, status, data, headers = {}) {
  if (res.headersSent) return;
  const b = Buffer.from(JSON.stringify(data));
  res.status(status);
  for (const [k, v] of Object.entries({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })) {
    res.setHeader(k, v);
  }
  res.setHeader('content-length', b.length);
  return res.end(b);
}

function parseCookies(req) {
  const o = {};
  for (const p of String(req.headers.cookie || '').split(';')) {
    const i = p.indexOf('=');
    if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  }
  return o;
}

function setCookie(res, name, value, maxAge = 2592000, req = null) {
  const origin = String(req?.headers?.origin || '');
  const host = String(req?.headers?.host || '');
  const sameOrigin = !origin || origin === `http://${host}` || origin === `https://${host}`;
  const attrs = sameOrigin ? 'SameSite=Lax' : 'SameSite=None; Secure';
  res.setHeader('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; ${attrs}; Max-Age=${maxAge}`);
}

async function body(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const t = Buffer.concat(chunks).toString();
  if (!t) return {};
  try {
    return JSON.parse(t);
  } catch {
    return {};
  }
}

async function q(text, params = []) {
  return pool.query(text, params);
}
async function one(text, params = []) {
  const r = await q(text, params);
  return r.rows[0] || null;
}
async function all(text, params = []) {
  return (await q(text, params)).rows;
}

async function schema() {
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    throw Error(
      `PostgreSQL is unavailable at ${process.env.PGHOST || '127.0.0.1'}:${process.env.PGPORT || 5432}. Ensure Windows PostgreSQL service is running. (${e.message})`
    );
  }

  await q(`
    CREATE TABLE IF NOT EXISTS users(id BIGSERIAL PRIMARY KEY,phone TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password_hash TEXT NOT NULL,recovery_hash TEXT,recovery_created_at TIMESTAMPTZ,dp TEXT,last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),admin_disabled BOOLEAN NOT NULL DEFAULT false);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),expires_at TIMESTAMPTZ NOT NULL,user_agent TEXT);
    CREATE TABLE IF NOT EXISTS recovery_devices(user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,token_hash TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),last_used_at TIMESTAMPTZ,user_agent TEXT,PRIMARY KEY(user_id,token_hash));
    CREATE TABLE IF NOT EXISTS admin_sessions(token_hash TEXT PRIMARY KEY,username TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),expires_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS devices(id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,token TEXT UNIQUE NOT NULL,device_id TEXT,user_agent TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS conversations(id BIGSERIAL PRIMARY KEY,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS conversation_members(conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,PRIMARY KEY(conversation_id,user_id));
    CREATE TABLE IF NOT EXISTS messages(id BIGSERIAL PRIMARY KEY,conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,receiver_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,body TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT now(),reply_to_id BIGINT,media_id UUID);
    CREATE TABLE IF NOT EXISTS media(id UUID PRIMARY KEY,owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,message_id BIGINT,mime TEXT NOT NULL,original_name TEXT NOT NULL,size BIGINT NOT NULL,path TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS media_cache_receipts(message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,cached_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(message_id,user_id));
    CREATE TABLE IF NOT EXISTS message_receipts(message_id BIGINT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,delivered_at TIMESTAMPTZ,read_at TIMESTAMPTZ);
    CREATE TABLE IF NOT EXISTS presence(user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,online BOOLEAN NOT NULL DEFAULT false,last_seen TIMESTAMPTZ);
    CREATE TABLE IF NOT EXISTS settings(user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,notifications BOOLEAN NOT NULL DEFAULT true,read_receipts BOOLEAN NOT NULL DEFAULT true,last_seen_visibility TEXT NOT NULL DEFAULT 'everyone',dp_visibility TEXT NOT NULL DEFAULT 'everyone',theme TEXT NOT NULL DEFAULT 'light',wallpaper TEXT NOT NULL DEFAULT 'classic',typing_indicator BOOLEAN NOT NULL DEFAULT true,enter_to_send BOOLEAN NOT NULL DEFAULT true,compact_bubbles BOOLEAN NOT NULL DEFAULT false,glass_ui BOOLEAN NOT NULL DEFAULT true,glass_intensity INTEGER NOT NULL DEFAULT 70,animations BOOLEAN NOT NULL DEFAULT true,message_density TEXT NOT NULL DEFAULT 'comfortable',notification_preview BOOLEAN NOT NULL DEFAULT true,notification_volume INTEGER NOT NULL DEFAULT 70,notification_vibrate BOOLEAN NOT NULL DEFAULT true);
    CREATE TABLE IF NOT EXISTS blocks(user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,blocked_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(user_id,blocked_user_id));
    CREATE TABLE IF NOT EXISTS privacy_exceptions(user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,target_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,kind TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(user_id,target_user_id,kind));
    CREATE TABLE IF NOT EXISTS hidden_messages(message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(message_id,user_id));
    CREATE TABLE IF NOT EXISTS reactions(message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,emoji TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(message_id,user_id));
    CREATE TABLE IF NOT EXISTS statuses(id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,body TEXT NOT NULL DEFAULT '',media_id UUID REFERENCES media(id) ON DELETE SET NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),expires_at TIMESTAMPTZ NOT NULL DEFAULT (now()+interval '24 hours'));
    CREATE TABLE IF NOT EXISTS status_views(status_id BIGINT NOT NULL REFERENCES statuses(id) ON DELETE CASCADE,user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,viewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(status_id,user_id));
    CREATE TABLE IF NOT EXISTS status_likes(status_id BIGINT NOT NULL REFERENCES statuses(id) ON DELETE CASCADE,user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(status_id,user_id));
    CREATE TABLE IF NOT EXISTS client_errors(id BIGSERIAL PRIMARY KEY,user_id BIGINT,kind TEXT,message TEXT,stack TEXT,context JSONB,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS audit(id BIGSERIAL PRIMARY KEY,admin TEXT NOT NULL,action TEXT NOT NULL,payload JSONB,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS communities(id BIGSERIAL PRIMARY KEY,owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS community_members(community_id BIGINT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,role TEXT NOT NULL DEFAULT 'member',joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(community_id,user_id));

    CREATE INDEX IF NOT EXISTS idx_statuses_expiry ON statuses(expires_at,user_id);
    CREATE INDEX IF NOT EXISTS idx_messages_conv_id ON messages(conversation_id,id);
    CREATE INDEX IF NOT EXISTS idx_messages_receiver_id ON messages(receiver_id,id);
    CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
    CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
    CREATE INDEX IF NOT EXISTS idx_users_name ON users(name);
    CREATE INDEX IF NOT EXISTS idx_media_message ON media(message_id);
    CREATE INDEX IF NOT EXISTS idx_community_members_user ON community_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_communities_owner ON communities(owner_id);
  `);

  await q(`
    ALTER TABLE media ALTER COLUMN path DROP NOT NULL;
    ALTER TABLE settings
      ADD COLUMN IF NOT EXISTS glass_ui BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS glass_intensity INTEGER NOT NULL DEFAULT 70,
      ADD COLUMN IF NOT EXISTS animations BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS message_density TEXT NOT NULL DEFAULT 'comfortable',
      ADD COLUMN IF NOT EXISTS notification_preview BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS notification_volume INTEGER NOT NULL DEFAULT 70,
      ADD COLUMN IF NOT EXISTS notification_vibrate BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS online_visibility TEXT NOT NULL DEFAULT 'everyone',
      ADD COLUMN IF NOT EXISTS status_visibility TEXT NOT NULL DEFAULT 'everyone';
    ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS forwarded_from_id BIGINT,
      ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS pinned_by BIGINT;
    ALTER TABLE conversation_members
      ADD COLUMN IF NOT EXISTS muted_until TIMESTAMPTZ;
  `);
}

async function userById(uid) {
  const u = await one('SELECT id,phone,name,last_seen,admin_disabled FROM users WHERE id=$1', [uid]);
  if (u) u.dp = null;
  return u;
}

async function settings(uid) {
  let r = await one('SELECT * FROM settings WHERE user_id=$1', [uid]);
  if (!r) {
    await q('INSERT INTO settings(user_id) VALUES($1) ON CONFLICT DO NOTHING', [uid]);
    r = await one('SELECT * FROM settings WHERE user_id=$1', [uid]);
  }
  return r;
}

async function blocked(a, b) {
  return !!(await one('SELECT 1 FROM blocks WHERE user_id=$1 AND blocked_user_id=$2', [a, b]));
}

async function privacy(owner, viewer, kind) {
  if (Number(owner) === Number(viewer)) return true;
  const s = await settings(owner);
  const mode =
    kind === 'dp'
      ? s.dp_visibility
      : kind === 'online'
        ? s.online_visibility
        : kind === 'status'
          ? s.status_visibility
          : s.last_seen_visibility;
  if (mode === 'everyone') return true;
  if (mode === 'nobody') return false;
  return !!(await one(
    'SELECT 1 FROM privacy_exceptions WHERE user_id=$1 AND target_user_id=$2 AND kind=$3',
    [owner, viewer, kind]
  ));
}

async function profile(uid, viewer) {
  const u = await userById(uid);
  if (!u) return null;
  if (Number(uid) !== Number(viewer) && ((await blocked(uid, viewer)) || (await blocked(viewer, uid)))) {
    return { ...u, dp: null, last_seen: null, online: false };
  }
  const canOnline = await privacy(uid, viewer, 'online');
  const canLast = await privacy(uid, viewer, 'last_seen');
  const pr = await one('SELECT online FROM presence WHERE user_id=$1', [uid]);
  return { ...u, dp: null, last_seen: canLast ? u.last_seen : null, online: canOnline && !!pr?.online };
}

async function sessionUser(req) {
  const auth = String(req.headers.authorization || '');
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  const token = (bearer?.[1] || parseCookies(req).sid || '').trim();
  if (!token) return null;
  const h = crypto.createHash('sha256').update(token).digest('hex');
  const sess = await one('SELECT user_id, expires_at FROM sessions WHERE token_hash=$1 AND expires_at>now()', [h]);
  if (!sess) return null;
  // Sliding expiration: only update when fewer than 25 days remain
  if (new Date(sess.expires_at).getTime() - Date.now() < 25 * 86400 * 1000) {
    void q("UPDATE sessions SET expires_at=now()+interval '30 days' WHERE token_hash=$1", [h]).catch(() => {});
  }
  return userById(sess.user_id);
}

async function loginUser(u, req, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  const h = crypto.createHash('sha256').update(token).digest('hex');
  await q("INSERT INTO sessions(token_hash,user_id,expires_at,user_agent) VALUES($1,$2,now()+interval '30 days',$3)", [
    h,
    u.id,
    String(req.headers['user-agent'] || '').slice(0, 500),
  ]);
  setCookie(res, 'sid', token, 2592000, req);
  return { user: u, token };
}

async function logout(req, res) {
  const auth = String(req.headers.authorization || '');
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  const t = (bearer?.[1] || parseCookies(req).sid || '').trim();
  if (t) await q('DELETE FROM sessions WHERE token_hash=$1', [crypto.createHash('sha256').update(t).digest('hex')]);
  setCookie(res, 'sid', '', 0, req);
}

async function conversation(a, b) {
  const r = await one(
    'SELECT c.id FROM conversations c JOIN conversation_members a ON a.conversation_id=c.id AND a.user_id=$1 JOIN conversation_members b ON b.conversation_id=c.id AND b.user_id=$2 LIMIT 1',
    [a, b]
  );
  if (r) return Number(r.id);
  const c = await one('INSERT INTO conversations DEFAULT VALUES RETURNING id');
  await q('INSERT INTO conversation_members(conversation_id,user_id) VALUES($1,$2),($1,$3)', [c.id, a, b]);
  return Number(c.id);
}

async function chats(uid) {
  const rows = await all(
    `SELECT u.id,u.phone,u.name,u.dp,u.last_seen,COALESCE(p.online,false) online,c.id conversation_id,
      me.muted_until,
      (SELECT body FROM messages m WHERE m.conversation_id=c.id AND NOT EXISTS(SELECT 1 FROM hidden_messages h WHERE h.message_id=m.id AND h.user_id=$1) ORDER BY m.id DESC LIMIT 1) last_message,
      (SELECT m.created_at FROM messages m WHERE m.conversation_id=c.id AND NOT EXISTS(SELECT 1 FROM hidden_messages h WHERE h.message_id=m.id AND h.user_id=$1) ORDER BY m.id DESC LIMIT 1) last_message_at,
      (SELECT m.sender_id FROM messages m WHERE m.conversation_id=c.id AND NOT EXISTS(SELECT 1 FROM hidden_messages h WHERE h.message_id=m.id AND h.user_id=$1) ORDER BY m.id DESC LIMIT 1) last_message_sender_id,
      (SELECT r.delivered_at FROM message_receipts r JOIN messages m ON m.id=r.message_id WHERE m.conversation_id=c.id AND m.sender_id=$1 AND m.receiver_id=u.id ORDER BY m.id DESC LIMIT 1) last_delivered_at,
      (SELECT r.read_at FROM message_receipts r JOIN messages m ON m.id=r.message_id WHERE m.conversation_id=c.id AND m.sender_id=$1 AND m.receiver_id=u.id ORDER BY m.id DESC LIMIT 1) last_read_at,
      (SELECT count(*) FROM messages m JOIN message_receipts r ON r.message_id=m.id WHERE m.conversation_id=c.id AND m.receiver_id=$1 AND r.read_at IS NULL AND NOT EXISTS(SELECT 1 FROM hidden_messages h WHERE h.message_id=m.id AND h.user_id=$1)) unread_count
    FROM users u
    JOIN conversation_members cm ON cm.user_id=u.id
    JOIN conversation_members me ON me.conversation_id=cm.conversation_id AND me.user_id=$1
    JOIN conversations c ON c.id=cm.conversation_id
    LEFT JOIN presence p ON p.user_id=u.id
    WHERE u.id<>$1
    ORDER BY c.updated_at DESC`,
    [uid]
  );
  const out = [];
  for (const r of rows) {
    const b = (await blocked(uid, r.id)) || (await blocked(r.id, uid));
    const canLast = !b && (await privacy(r.id, uid, 'last_seen'));
    const canOnline = !b && (await privacy(r.id, uid, 'online'));
    const muted = !!(r.muted_until && new Date(r.muted_until).getTime() > Date.now());
    out.push({
      ...r,
      dp: null,
      last_seen: canLast ? r.last_seen : null,
      last_seen_text: canLast ? r.last_seen : null,
      online: canOnline ? !!r.online : false,
      unread_count: Number(r.unread_count || 0),
      muted_until: muted ? r.muted_until : null,
      muted,
      typing: false,
      blocked: b,
    });
  }
  return out;
}

async function msgRow(r) {
  let media = null;
  if (r.media_id) {
    const m = await one('SELECT id,mime,original_name,size,path FROM media WHERE id=$1', [r.media_id]);
    if (m) {
      media = {
        id: m.id,
        mime: m.mime,
        original_name: m.original_name,
        size: Number(m.size),
        url: absoluteUrl('/api/media?id=' + encodeURIComponent(m.id)),
        server_copy: !!m.path,
      };
    }
  }
  let reply = null;
  if (r.reply_to_id) reply = await one('SELECT sender_id,body FROM messages WHERE id=$1', [r.reply_to_id]);
  const sender = await userById(r.sender_id);
  return {
    id: Number(r.id),
    conversation_id: Number(r.conversation_id),
    sender_id: Number(r.sender_id),
    receiver_id: Number(r.receiver_id),
    sender_name: sender?.name || 'User',
    body: r.body,
    created_at: r.created_at,
    edited_at: r.edited_at || null,
    forwarded_from_id: r.forwarded_from_id ? Number(r.forwarded_from_id) : null,
    pinned_at: r.pinned_at || null,
    pinned_by: r.pinned_by ? Number(r.pinned_by) : null,
    delivered_at: r.delivered_at || null,
    read_at: r.read_at || null,
    reactions: await all(
      'SELECT r.user_id,r.emoji,u.name FROM reactions r JOIN users u ON u.id=r.user_id WHERE r.message_id=$1 ORDER BY r.created_at',
      [r.id]
    ),
    reply_to_id: r.reply_to_id ? Number(r.reply_to_id) : null,
    reply_sender_name: reply ? (await userById(reply.sender_id))?.name || 'User' : null,
    reply_body: reply ? String(reply.body || '').slice(0, 240) : null,
    media,
  };
}

function send(ws, p) {
  if (ws.readyState === 1) ws.send(JSON.stringify(p));
}
function userSockets(uid) {
  return connections.get(Number(uid)) || new Set();
}
function broadcast(uid, p, except) {
  for (const ws of userSockets(uid)) if (ws !== except) send(ws, p);
}
function addConn(uid, ws) {
  let s = connections.get(Number(uid));
  if (!s) {
    s = new Set();
    connections.set(Number(uid), s);
  }
  s.add(ws);
  meta.set(ws, { uid: Number(uid), visible: true, lastBeat: Date.now(), typingTo: 0 });
}
function removeConn(ws) {
  const m = meta.get(ws);
  if (!m) return null;
  const s = connections.get(m.uid);
  if (s) {
    s.delete(ws);
    if (!s.size) connections.delete(m.uid);
  }
  return m;
}
async function setOnline(uid, on) {
  await q(
    'INSERT INTO presence(user_id,online,last_seen) VALUES($1,$2,now()) ON CONFLICT(user_id) DO UPDATE SET online=$2,last_seen=now()',
    [uid, on]
  );
  await q('UPDATE users SET last_seen=now(),updated_at=now() WHERE id=$1', [uid]);
}
async function contactIds(uid) {
  return (
    await all(
      'SELECT DISTINCT cm2.user_id FROM conversation_members cm1 JOIN conversation_members cm2 ON cm2.conversation_id=cm1.conversation_id WHERE cm1.user_id=$1 AND cm2.user_id<>$1',
      [uid]
    )
  ).map((x) => Number(x.user_id));
}
async function presenceFanout(uid, on) {
  for (const peer of await contactIds(uid)) {
    const p = await profile(uid, peer);
    broadcast(peer, { type: 'presence', user_id: Number(uid), online: on, last_seen: on ? null : p?.last_seen || null });
  }
}

async function statusList(uid) {
  const rows = await all(
    `SELECT s.id,s.user_id,s.body,s.media_id,s.created_at,s.expires_at,u.name,u.dp,
      EXISTS(SELECT 1 FROM status_views v WHERE v.status_id=s.id AND v.user_id=$1) viewed,
      (SELECT COUNT(*) FROM status_views vv WHERE vv.status_id=s.id)::int view_count,
      (SELECT COUNT(*) FROM status_likes ll WHERE ll.status_id=s.id)::int like_count,
      EXISTS(SELECT 1 FROM status_likes lm WHERE lm.status_id=s.id AND lm.user_id=$1) liked
     FROM statuses s JOIN users u ON u.id=s.user_id
     WHERE s.expires_at>now() AND (s.user_id=$1 OR (NOT EXISTS(SELECT 1 FROM blocks b WHERE b.user_id=s.user_id AND b.blocked_user_id=$1) AND NOT EXISTS(SELECT 1 FROM blocks b WHERE b.user_id=$1 AND b.blocked_user_id=s.user_id)))
     ORDER BY s.created_at DESC LIMIT 500`,
    [uid]
  );
  const out = [];
  for (const r of rows) {
    if (Number(r.user_id) !== Number(uid) && !(await privacy(r.user_id, uid, 'status'))) continue;
    const m = r.media_id ? await one('SELECT id,mime,original_name,size FROM media WHERE id=$1', [r.media_id]) : null;
    const canSeeDp = Number(r.user_id) === Number(uid) ? true : await privacy(r.user_id, uid, 'dp');
    const viewers =
      Number(r.user_id) === Number(uid)
        ? await all(
            'SELECT v.user_id,u.name,u.dp,v.viewed_at FROM status_views v JOIN users u ON u.id=v.user_id WHERE v.status_id=$1 ORDER BY v.viewed_at DESC',
            [r.id]
          )
        : [];
    out.push({
      ...r,
      id: Number(r.id),
      user_id: Number(r.user_id),
      dp: canSeeDp ? absoluteUrl(r.dp) : null,
      size: m ? Number(m.size) : null,
      media: m ? { ...m, size: Number(m.size), url: absoluteUrl('/api/media?id=' + encodeURIComponent(m.id)) } : null,
      viewers,
      has_unviewed: !r.viewed,
    });
  }
  return out;
}

let fcmAccessToken = '';
let fcmAccessTokenExpiresAt = 0;
async function sendFcm(uid, payload) {
  const creds = {
    project: process.env.FCM_PROJECT_ID,
    email: process.env.FCM_CLIENT_EMAIL,
    key: process.env.FCM_PRIVATE_KEY_B64 ? Buffer.from(process.env.FCM_PRIVATE_KEY_B64, 'base64').toString('utf8') : '',
  };
  if (!creds.project || !creds.email || !creds.key) return false;
  const ns = await settings(uid);
  if (ns && ns.notifications === false) return false;
  if (payload.conversation_id) {
    const cm = await one('SELECT muted_until FROM conversation_members WHERE conversation_id=$1 AND user_id=$2', [
      payload.conversation_id,
      uid,
    ]);
    if (cm?.muted_until && new Date(cm.muted_until).getTime() > Date.now()) return false;
  }
  const rows = await all('SELECT token FROM devices WHERE user_id=$1', [uid]);
  if (!rows.length) return false;
  try {
    let access = fcmAccessToken;
    if (!access || Date.now() >= fcmAccessTokenExpiresAt - 60000) {
      const t = Math.floor(Date.now() / 1000);
      const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
      const c = Buffer.from(
        JSON.stringify({
          iss: creds.email,
          scope: 'https://www.googleapis.com/auth/firebase.messaging',
          aud: 'https://oauth2.googleapis.com/token',
          iat: t,
          exp: t + 3600,
        })
      ).toString('base64url');
      const s = crypto.createSign('RSA-SHA256');
      s.update(h + '.' + c);
      s.end();
      const jwt = h + '.' + c + '.' + s.sign(creds.key, 'base64url');
      const tr = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
      });
      const tj = await tr.json();
      if (!tj.access_token) return false;
      fcmAccessToken = tj.access_token;
      fcmAccessTokenExpiresAt = Date.now() + Number(tj.expires_in || 3600) * 1000;
      access = fcmAccessToken;
    }
    const results = await Promise.all(
      rows.map(async (r) => {
        try {
          const resp = await fetch(
            `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(creds.project)}/messages:send`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${access}`, 'content-type': 'application/json' },
              body: JSON.stringify({
                message: {
                  token: r.token,
                  data: {
                    type: 'chat_message',
                    chat_id: String(payload.conversation_id),
                    message_id: String(payload.id),
                    sender_id: String(payload.sender_id),
                    title: String(payload.sender_name || 'MyChat').slice(0, 100),
                    body: ns?.notification_preview === false ? 'New message' : String(payload.body || '').slice(0, 2000),
                    preview: ns?.notification_preview === false ? '0' : '1',
                    vibrate: ns?.notification_vibrate === false ? '0' : '1',
                    backend_url: publicBase(),
                    link: '/?chat=' + encodeURIComponent(payload.sender_id),
                  },
                },
              }),
            }
          );
          if (resp.ok) return 1;
          const text = await resp.text();
          if (resp.status === 404 || /UNREGISTERED|not[-_ ]registered/i.test(text)) {
            await q('DELETE FROM devices WHERE token=$1', [r.token]);
          }
          return 0;
        } catch {
          return 0;
        }
      })
    );
    return results.reduce((a, b) => a + b, 0) > 0;
  } catch (e) {
    logErr(e, 'fcm');
    return false;
  }
}

async function saveMessage(uid, to, bodyText, replyTo, mediaId, forwardedFromId = null) {
  if ((await blocked(uid, to)) || (await blocked(to, uid))) throw Error('Messaging is blocked for this chat.');
  if (!bodyText && !mediaId) throw Error('Message is empty');
  if (bodyText.length > 10000) throw Error('Message too long');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cid = await client.query(
      'SELECT c.id FROM conversations c JOIN conversation_members a ON a.conversation_id=c.id AND a.user_id=$1 JOIN conversation_members b ON b.conversation_id=c.id AND b.user_id=$2 LIMIT 1',
      [uid, to]
    );
    let conv = cid.rows[0]?.id;
    if (!conv) {
      const c = await client.query('INSERT INTO conversations DEFAULT VALUES RETURNING id');
      conv = c.rows[0].id;
      await client.query('INSERT INTO conversation_members(conversation_id,user_id) VALUES($1,$2),($1,$3)', [
        conv,
        uid,
        to,
      ]);
    }
    if (mediaId) {
      const mr = await client.query('SELECT id,owner_id,message_id FROM media WHERE id=$1 FOR UPDATE', [mediaId]);
      if (!mr.rows[0] || Number(mr.rows[0].owner_id) !== Number(uid) || mr.rows[0].message_id) {
        throw Error('Invalid media attachment');
      }
    }
    const r = await client.query(
      'INSERT INTO messages(conversation_id,sender_id,receiver_id,body,reply_to_id,media_id,forwarded_from_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [conv, uid, to, bodyText || '', replyTo || null, mediaId || null, forwardedFromId || null]
    );
    await client.query('INSERT INTO message_receipts(message_id) VALUES($1)', [r.rows[0].id]);
    if (mediaId) await client.query('UPDATE media SET message_id=$1 WHERE id=$2', [r.rows[0].id, mediaId]);
    await client.query('UPDATE conversations SET updated_at=now() WHERE id=$1', [conv]);
    await client.query('COMMIT');
    return await msgRow({ ...r.rows[0], delivered_at: null, read_at: null });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function deliverSavedMessage(ws, senderUid, to, message, requestId) {
  const packet = { type: 'message', message, request_id: requestId };
  if (ws) send(ws, packet);
  broadcast(senderUid, packet, ws);
  broadcast(to, packet);
  broadcast(to, { type: 'chat:list', chats: await chats(to) });
  broadcast(senderUid, { type: 'chat:list', chats: await chats(senderUid) });
  const recipientSockets = userSockets(to);
  const recipientVisible = [...recipientSockets].some((sock) => meta.get(sock)?.visible !== false);
  if (recipientVisible) {
    await q('UPDATE message_receipts SET delivered_at=COALESCE(delivered_at,now()) WHERE message_id=$1', [message.id]);
    const rr = await one('SELECT delivered_at,read_at FROM message_receipts WHERE message_id=$1', [message.id]);
    const receipt = { type: 'delivered', message_id: message.id, delivered_at: rr.delivered_at, read_at: rr.read_at };
    broadcast(senderUid, receipt);
    broadcast(to, receipt);
  } else {
    void sendFcm(to, message);
  }
  runtime.messages_sent++;
}

async function socketMessage(ws, p) {
  runtime.messages_received++;
  const m = meta.get(ws);
  if (!m) return;

  if (p.type === 'ping') return send(ws, { type: 'pong', ts: Date.now() });
  if (p.type === 'app:heartbeat') {
    m.lastBeat = Date.now();
    m.visible = true;
    return;
  }
  if (p.type === 'app:visibility') {
    const nowVisible = p.visible !== false;
    m.visible = nowVisible;
    m.lastBeat = nowVisible ? Date.now() : 0;
    return;
  }
  if (p.type === 'sync') {
    send(ws, { type: 'chat:list', chats: await chats(m.uid) });
    send(ws, { type: 'settings', settings: await settings(m.uid) });
    return;
  }
  if (p.type === 'profile:request') {
    broadcast(m.uid, { type: 'profile:request', from: Number(p.from || 0) });
    return;
  }
  if (p.type === 'chat:list') {
    return send(ws, { type: 'chat:list', request_id: p.request_id, chats: await chats(m.uid) });
  }

  if (p.type === 'community:discover') {
    const rows = await all(
      `SELECT c.id,c.owner_id,c.name,c.description,c.created_at,
        EXISTS(SELECT 1 FROM community_members cm WHERE cm.community_id=c.id AND cm.user_id=$1) joined,
        (SELECT COUNT(*)::int FROM community_members x WHERE x.community_id=c.id) member_count
       FROM communities c ORDER BY c.created_at DESC LIMIT 200`,
      [m.uid]
    );
    return send(ws, {
      type: 'community:discover',
      request_id: p.request_id,
      communities: rows.map((x) => ({
        ...x,
        id: Number(x.id),
        owner_id: Number(x.owner_id),
        member_count: Number(x.member_count || 0),
        joined: !!x.joined,
      })),
    });
  }

  if (p.type === 'community:list') {
    const rows = await all(
      `SELECT c.id,c.owner_id,c.name,c.description,c.created_at,cm.role,
        (SELECT COUNT(*)::int FROM community_members x WHERE x.community_id=c.id) member_count
       FROM communities c JOIN community_members cm ON cm.community_id=c.id AND cm.user_id=$1
       ORDER BY c.created_at DESC`,
      [m.uid]
    );
    return send(ws, {
      type: 'community:list',
      request_id: p.request_id,
      communities: rows.map((x) => ({
        ...x,
        id: Number(x.id),
        owner_id: Number(x.owner_id),
        member_count: Number(x.member_count || 0),
      })),
    });
  }

  if (p.type === 'community:create') {
    const name = String(p.name || '').trim().slice(0, 80);
    const description = String(p.description || '').trim().slice(0, 300);
    if (name.length < 2) throw Error('Community name must be at least 2 characters.');
    const c = await one(
      'INSERT INTO communities(owner_id,name,description) VALUES($1,$2,$3) RETURNING id,owner_id,name,description,created_at',
      [m.uid, name, description]
    );
    await q("INSERT INTO community_members(community_id,user_id,role) VALUES($1,$2,'owner')", [c.id, m.uid]);
    const out = { ...c, id: Number(c.id), owner_id: Number(c.owner_id), member_count: 1, role: 'owner' };
    send(ws, { type: 'community:done', request_id: p.request_id, community: out });
    const rows = await all(
      `SELECT c.id,c.owner_id,c.name,c.description,c.created_at,cm.role,
        (SELECT COUNT(*)::int FROM community_members x WHERE x.community_id=c.id) member_count
       FROM communities c JOIN community_members cm ON cm.community_id=c.id AND cm.user_id=$1
       ORDER BY c.created_at DESC`,
      [m.uid]
    );
    return send(ws, { type: 'community:list', communities: rows });
  }

  if (p.type === 'community:join') {
    const cid = Number(p.community_id || 0);
    const c = await one('SELECT id,owner_id,name,description,created_at FROM communities WHERE id=$1', [cid]);
    if (!c) throw Error('Community not found.');
    await q("INSERT INTO community_members(community_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING", [
      cid,
      m.uid,
    ]);
    return send(ws, {
      type: 'community:done',
      request_id: p.request_id,
      community: { ...c, id: Number(c.id), owner_id: Number(c.owner_id) },
    });
  }

  if (p.type === 'community:leave') {
    const cid = Number(p.community_id || 0);
    const c = await one('SELECT owner_id FROM communities WHERE id=$1', [cid]);
    if (!c) throw Error('Community not found.');
    if (Number(c.owner_id) === m.uid) throw Error('Owner cannot leave. Transfer ownership or delete the community first.');
    await q('DELETE FROM community_members WHERE community_id=$1 AND user_id=$2', [cid, m.uid]);
    return send(ws, { type: 'community:done', request_id: p.request_id, community_id: cid, left: true });
  }

  if (p.type === 'status:list') return send(ws, { type: 'status:list', statuses: await statusList(m.uid) });

  if (p.type === 'status:create') {
    const bodyText = String(p.body || '').trim().slice(0, 700);
    const mediaId = p.media_id ? String(p.media_id) : null;
    if (!bodyText && !mediaId) throw Error('Status is empty');
    if (mediaId) {
      const mm = await one('SELECT id,owner_id,message_id FROM media WHERE id=$1', [mediaId]);
      if (!mm || Number(mm.owner_id) !== Number(m.uid) || mm.message_id) throw Error('Invalid status media');
    }
    await one('INSERT INTO statuses(user_id,body,media_id) VALUES($1,$2,$3) RETURNING id', [m.uid, bodyText, mediaId]);
    send(ws, { type: 'status:done', request_id: p.request_id, statuses: await statusList(m.uid) });
    for (const peer of await contactIds(m.uid)) {
      broadcast(peer, { type: 'status:update', statuses: await statusList(peer) });
    }
    return;
  }

  if (p.type === 'status:view') {
    const sid = Number(p.status_id || 0);
    const st = await one('SELECT user_id FROM statuses WHERE id=$1 AND expires_at>now()', [sid]);
    if (!st) throw Error('Status not found');
    if (Number(st.user_id) !== Number(m.uid) && ((await blocked(st.user_id, m.uid)) || (await blocked(m.uid, st.user_id)))) {
      throw Error('Status unavailable');
    }
    await q('INSERT INTO status_views(status_id,user_id) VALUES($1,$2) ON CONFLICT DO UPDATE SET viewed_at=now()', [
      sid,
      m.uid,
    ]);
    return send(ws, { type: 'status:done', request_id: p.request_id, statuses: await statusList(m.uid) });
  }

  if (p.type === 'status:like') {
    const sid = Number(p.status_id || 0);
    const st = await one('SELECT user_id FROM statuses WHERE id=$1 AND expires_at>now()', [sid]);
    if (!st) throw Error('Status not found');
    if (Number(st.user_id) !== Number(m.uid) && ((await blocked(st.user_id, m.uid)) || (await blocked(m.uid, st.user_id)))) {
      throw Error('Status unavailable');
    }
    if (p.liked) await q('INSERT INTO status_likes(status_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [sid, m.uid]);
    else await q('DELETE FROM status_likes WHERE status_id=$1 AND user_id=$2', [sid, m.uid]);
    send(ws, { type: 'status:done', request_id: p.request_id, statuses: await statusList(m.uid) });
    if (Number(st.user_id) !== Number(m.uid)) {
      broadcast(Number(st.user_id), { type: 'status:update', statuses: await statusList(Number(st.user_id)) });
    }
    return;
  }

  if (p.type === 'status:delete') {
    const sid = Number(p.status_id || 0);
    const st = await one('SELECT media_id FROM statuses WHERE id=$1 AND user_id=$2', [sid, m.uid]);
    if (st?.media_id) {
      const md = await one('SELECT path FROM media WHERE id=$1', [st.media_id]);
      if (md?.path) try { fs.unlinkSync(md.path); } catch {}
      await q('DELETE FROM media WHERE id=$1', [st.media_id]);
    }
    await q('DELETE FROM statuses WHERE id=$1 AND user_id=$2', [sid, m.uid]);
    return send(ws, { type: 'status:done', request_id: p.request_id, statuses: await statusList(m.uid) });
  }

  if (p.type === 'token:save') {
    if (!p.token) return;
    await q(
      'INSERT INTO devices(user_id,token,device_id,user_agent) VALUES($1,$2,$3,$4) ON CONFLICT(token) DO UPDATE SET user_id=$1,device_id=$3,user_agent=$4,updated_at=now()',
      [m.uid, String(p.token), String(p.device_id || '').slice(0, 100), String(p.user_agent || '').slice(0, 500)]
    );
    return send(ws, { type: 'token:saved', request_id: p.request_id });
  }

  if (p.type === 'settings:set') {
    const s = p.settings || {};
    const clamp = (n) => Math.max(0, Math.min(100, Number.isFinite(Number(n)) ? Number(n) : 70));
    const density = ['compact', 'comfortable', 'spacious'].includes(String(s.message_density || ''))
      ? String(s.message_density)
      : 'comfortable';
    await q(
      `INSERT INTO settings(user_id,notifications,read_receipts,last_seen_visibility,dp_visibility,theme,wallpaper,typing_indicator,enter_to_send,compact_bubbles,glass_ui,glass_intensity,animations,message_density,notification_preview,notification_volume,notification_vibrate,online_visibility,status_visibility)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT(user_id) DO UPDATE SET notifications=$2,read_receipts=$3,last_seen_visibility=$4,dp_visibility=$5,theme=$6,wallpaper=$7,typing_indicator=$8,enter_to_send=$9,compact_bubbles=$10,glass_ui=$11,glass_intensity=$12,animations=$13,message_density=$14,notification_preview=$15,notification_volume=$16,notification_vibrate=$17,online_visibility=$18,status_visibility=$19`,
      [
        m.uid,
        !!s.notifications,
        !!s.read_receipts,
        s.last_seen_visibility || 'everyone',
        s.dp_visibility || 'everyone',
        s.theme || 'light',
        s.wallpaper || 'classic',
        !!s.typing_indicator,
        !!s.enter_to_send,
        !!s.compact_bubbles,
        s.glass_ui !== false,
        clamp(s.glass_intensity),
        s.animations !== false,
        density,
        s.notification_preview !== false,
        clamp(s.notification_volume),
        s.notification_vibrate !== false,
        s.online_visibility || 'everyone',
        s.status_visibility || 'everyone',
      ]
    );
    return send(ws, { type: 'settings', request_id: p.request_id, settings: await settings(m.uid) });
  }

  if (p.type === 'profile:set') {
    const name = String(p.name || '').trim();
    if (!name || name.length > 60) return send(ws, { type: 'error', request_id: p.request_id, error: 'Invalid name' });
    await q('UPDATE users SET name=$1,updated_at=now() WHERE id=$2', [name, m.uid]);
    const u = await userById(m.uid);
    send(ws, { type: 'profile', request_id: p.request_id, user: u });
    for (const peer of await contactIds(m.uid)) broadcast(peer, { type: 'profile:update', user: await profile(m.uid, peer) });
    return;
  }

  if (p.type === 'profile:announce') {
    const dp = String(p.dp || '');
    if (dp.length > 700000) throw Error('Profile photo is too large.');
    const target = Number(p.to || 0);
    const announce = async (peer) => {
      if ((await blocked(m.uid, peer)) || (await blocked(peer, m.uid))) return;
      const u = await profile(m.uid, peer);
      const visible = await privacy(m.uid, peer, 'dp');
      broadcast(peer, { type: 'profile:update', user: { ...u, dp: visible ? dp : null, dp_forbidden: !visible } });
    };
    if (target) {
      await announce(target);
      return;
    }
    for (const peer of await contactIds(m.uid)) await announce(peer);
    return;
  }

  if (p.type === 'profile:changed') {
    for (const peer of await contactIds(m.uid)) broadcast(peer, { type: 'profile:update', user: await profile(m.uid, peer) });
    return;
  }

  if (p.type === 'typing') {
    const to = Number(p.to || 0);
    if (to) broadcast(to, { type: 'typing', from: m.uid, active: !!p.active });
    return;
  }

  if (p.type === 'call:signal') {
    const to = Number(p.to || 0);
    if (!to || !(p.signal && typeof p.signal === 'object')) throw Error('Invalid call signal');
    broadcast(to, {
      type: 'call:signal',
      from: Number(m.uid),
      kind: p.kind === 'video' ? 'video' : 'voice',
      call_id: String(p.call_id || ''),
      signal: p.signal,
    });
    return;
  }

  if (p.type === 'call:end') {
    const to = Number(p.to || 0);
    if (to) broadcast(to, { type: 'call:end', from: Number(m.uid), call_id: String(p.call_id || '') });
    return;
  }

  if (p.type === 'presence:subscribe') {
    for (const uid of Array.isArray(p.user_ids) ? p.user_ids : []) {
      const u = await profile(uid, m.uid);
      send(ws, { type: 'presence', user_id: Number(uid), online: userSockets(uid).size > 0, last_seen: u?.last_seen || null });
    }
    return;
  }

  if (p.type === 'chat:mark-read') {
    const to = Number(p.user_id || 0);
    if (!to) return send(ws, { type: 'chat:read:done', user_id: to, updated: 0 });
    const cid = await conversation(m.uid, to);
    const changed = await all(
      'SELECT mr.message_id FROM message_receipts mr JOIN messages msg ON msg.id=mr.message_id WHERE msg.conversation_id=$1 AND msg.receiver_id=$2 AND msg.sender_id=$3 AND mr.read_at IS NULL',
      [cid, m.uid, to]
    );
    const r = await q(
      'UPDATE message_receipts mr SET delivered_at=COALESCE(mr.delivered_at,now()),read_at=now() FROM messages msg WHERE mr.message_id=msg.id AND msg.conversation_id=$1 AND msg.receiver_id=$2 AND msg.sender_id=$3 AND mr.read_at IS NULL',
      [cid, m.uid, to]
    );
    for (const x of changed) broadcast(to, { type: 'read', message_id: Number(x.message_id), read_at: now(), delivered_at: null });
    send(ws, { type: 'chat:read:done', user_id: to, updated: r.rowCount || 0 });
    broadcast(to, { type: 'chat:list', chats: await chats(to) });
    send(ws, { type: 'chat:list', chats: await chats(m.uid) });
    return;
  }

  if (p.type === 'history') {
    const to = Number(p.user_id || 0);
    const cid = await conversation(m.uid, to);
    const after = Number(p.after_id || 0);
    const before = Number(p.before_id || 0);
    const limit = Math.max(10, Math.min(100, Number(p.limit || 40)));

    let rows;
    let hasMore = false;
    if (after > 0) {
      rows = await all(
        `SELECT m.*,r.delivered_at,r.read_at
         FROM messages m LEFT JOIN message_receipts r ON r.message_id=m.id
         WHERE m.conversation_id=$1 AND m.id>$2
           AND NOT EXISTS(SELECT 1 FROM hidden_messages h WHERE h.message_id=m.id AND h.user_id=$3)
         ORDER BY m.id ASC LIMIT 200`,
        [cid, after, m.uid]
      );
    } else if (before > 0) {
      const fetched = await all(
        `SELECT m.*,r.delivered_at,r.read_at
         FROM messages m LEFT JOIN message_receipts r ON r.message_id=m.id
         WHERE m.conversation_id=$1 AND m.id<$2
           AND NOT EXISTS(SELECT 1 FROM hidden_messages h WHERE h.message_id=m.id AND h.user_id=$3)
         ORDER BY m.id DESC LIMIT $4`,
        [cid, before, m.uid, limit + 1]
      );
      hasMore = fetched.length > limit;
      rows = fetched.slice(0, limit).reverse();
    } else {
      const fetched = await all(
        `SELECT m.*,r.delivered_at,r.read_at
         FROM messages m LEFT JOIN message_receipts r ON r.message_id=m.id
         WHERE m.conversation_id=$1
           AND NOT EXISTS(SELECT 1 FROM hidden_messages h WHERE h.message_id=m.id AND h.user_id=$2)
         ORDER BY m.id DESC LIMIT $3`,
        [cid, m.uid, limit + 1]
      );
      hasMore = fetched.length > limit;
      rows = fetched.slice(0, limit).reverse();
    }

    const messages = [];
    for (const r of rows) messages.push(await msgRow(r));
    return send(ws, {
      type: 'history',
      request_id: p.request_id,
      user_id: to,
      before_id: before || null,
      after_id: after || null,
      has_more: hasMore,
      messages,
    });
  }

  if (p.type === 'messages:search') {
    const to = Number(p.user_id || 0);
    const term = String(p.q || '').trim();
    if (!to || term.length < 1) {
      return send(ws, { type: 'messages:search', request_id: p.request_id, user_id: to, q: term, messages: [] });
    }
    const cid = await conversation(m.uid, to);
    const limit = Math.max(1, Math.min(50, Number(p.limit || 40)));
    const rows = await all(
      `SELECT m.*,r.delivered_at,r.read_at
       FROM messages m LEFT JOIN message_receipts r ON r.message_id=m.id
       WHERE m.conversation_id=$1 AND m.body ILIKE $2
         AND NOT EXISTS(SELECT 1 FROM hidden_messages h WHERE h.message_id=m.id AND h.user_id=$3)
       ORDER BY m.id DESC LIMIT $4`,
      [cid, '%' + term + '%', m.uid, limit]
    );
    const messages = [];
    for (const r of rows) messages.push(await msgRow(r));
    return send(ws, { type: 'messages:search', request_id: p.request_id, user_id: to, q: term, messages });
  }

  if (p.type === 'delivered' || p.type === 'read') {
    const mid = Number(p.message_id || 0);
    const msg = await one('SELECT sender_id,receiver_id FROM messages WHERE id=$1', [mid]);
    if (!msg || Number(msg.receiver_id) !== m.uid) {
      return send(ws, { type: 'error', request_id: p.request_id, error: 'Not allowed' });
    }
    if (p.type === 'read' && !m.visible) return;
    const ts = now();
    if (p.type === 'read') {
      await q('UPDATE message_receipts SET delivered_at=COALESCE(delivered_at,$1),read_at=COALESCE(read_at,$1) WHERE message_id=$2', [ts, mid]);
    } else {
      await q('UPDATE message_receipts SET delivered_at=COALESCE(delivered_at,$1) WHERE message_id=$2', [ts, mid]);
    }
    const r = await one('SELECT delivered_at,read_at FROM message_receipts WHERE message_id=$1', [mid]);
    const packet = { type: p.type, message_id: mid, delivered_at: r.delivered_at || null, read_at: r.read_at || null };
    broadcast(msg.sender_id, packet);
    return send(ws, packet);
  }

  if (p.type === 'message') {
    const to = Number(p.receiver_id || 0);
    try {
      const message = await saveMessage(
        m.uid,
        to,
        String(p.body || '').trim(),
        Number(p.reply_to_id || 0) || null,
        p.media?.id || null
      );
      await deliverSavedMessage(ws, m.uid, to, message, p.request_id);
    } catch (e) {
      send(ws, { type: 'error', request_id: p.request_id, error: e.message || 'Could not send message' });
    }
    return;
  }

  if (p.type === 'message:edit') {
    const mid = Number(p.message_id || 0);
    const newBody = String(p.body || '').trim();
    if (!mid || !newBody) throw Error('Message body cannot be empty.');
    if (newBody.length > 10000) throw Error('Message too long.');
    const existing = await one('SELECT id,sender_id,receiver_id,created_at FROM messages WHERE id=$1', [mid]);
    if (!existing || Number(existing.sender_id) !== m.uid) throw Error('Not allowed to edit this message.');
    if (Date.now() - new Date(existing.created_at).getTime() > 15 * 60 * 1000) {
      throw Error('Messages can only be edited within 15 minutes of sending.');
    }
    const upd = await one('UPDATE messages SET body=$1,edited_at=now() WHERE id=$2 RETURNING edited_at', [newBody, mid]);
    const editedAt = upd?.edited_at || now();
    const pack = { type: 'message:edited', message_id: mid, body: newBody, edited_at: editedAt };
    send(ws, { type: 'message:edit:done', request_id: p.request_id, message_id: mid, body: newBody, edited_at: editedAt });
    broadcast(existing.sender_id, pack, ws);
    broadcast(existing.receiver_id, pack);
    broadcast(existing.receiver_id, { type: 'chat:list', chats: await chats(existing.receiver_id) });
    send(ws, { type: 'chat:list', chats: await chats(m.uid) });
    return;
  }

  if (p.type === 'message:forward') {
    const mid = Number(p.message_id || 0);
    const targets = Array.isArray(p.receiver_ids)
      ? p.receiver_ids.map(Number).filter(Boolean)
      : p.receiver_id
        ? [Number(p.receiver_id)]
        : [];
    if (!mid || !targets.length) throw Error('Select at least one recipient.');
    if (targets.length > 20) throw Error('Cannot forward to more than 20 chats at once.');
    const orig = await one('SELECT * FROM messages WHERE id=$1 AND (sender_id=$2 OR receiver_id=$2)', [mid, m.uid]);
    if (!orig) throw Error('Message not found.');
    const origMedia = orig.media_id ? await one('SELECT * FROM media WHERE id=$1', [orig.media_id]) : null;
    let forwardedCount = 0;
    for (const to of targets) {
      let clonedMediaId = null;
      if (origMedia?.path && fs.existsSync(origMedia.path)) {
        clonedMediaId = id();
        const destPath = path.join(MEDIA, clonedMediaId);
        fs.copyFileSync(origMedia.path, destPath);
        await q('INSERT INTO media(id,owner_id,mime,original_name,size,path) VALUES($1,$2,$3,$4,$5,$6)', [
          clonedMediaId,
          m.uid,
          origMedia.mime,
          origMedia.original_name,
          origMedia.size,
          destPath,
        ]);
      }
      const message = await saveMessage(m.uid, to, orig.body || '', null, clonedMediaId, orig.id);
      await deliverSavedMessage(ws, m.uid, to, message, null);
      forwardedCount++;
    }
    return send(ws, { type: 'message:forward:done', request_id: p.request_id, count: forwardedCount });
  }

  if (p.type === 'message:pin') {
    const mid = Number(p.message_id || 0);
    const pinned = p.pinned !== false;
    const mm = await one('SELECT id,conversation_id,sender_id,receiver_id FROM messages WHERE id=$1 AND (sender_id=$2 OR receiver_id=$2)', [
      mid,
      m.uid,
    ]);
    if (!mm) throw Error('Not allowed');
    const upd = await one(
      pinned
        ? 'UPDATE messages SET pinned_at=now(), pinned_by=$2 WHERE id=$1 RETURNING pinned_at, pinned_by'
        : 'UPDATE messages SET pinned_at=NULL, pinned_by=NULL WHERE id=$1 RETURNING pinned_at, pinned_by',
      pinned ? [mid, m.uid] : [mid]
    );
    const pack = {
      type: 'message:pinned',
      message_id: mid,
      conversation_id: Number(mm.conversation_id),
      pinned_at: upd?.pinned_at || null,
      pinned_by: upd?.pinned_by ? Number(upd.pinned_by) : null,
    };
    send(ws, { type: 'message:pin:done', request_id: p.request_id, ...pack });
    broadcast(mm.sender_id, pack, ws);
    broadcast(mm.receiver_id, pack);
    return;
  }

  if (p.type === 'chat:mute') {
    const to = Number(p.user_id || 0);
    if (!to) throw Error('User ID required.');
    const cid = await conversation(m.uid, to);
    const hours = Number(p.duration_hours || 0);
    let mutedUntil = null;
    if (hours < 0) {
      mutedUntil = new Date(Date.now() + 100 * 365 * 86400 * 1000).toISOString();
    } else if (hours > 0) {
      mutedUntil = new Date(Date.now() + Math.min(hours, 24 * 365) * 3600 * 1000).toISOString();
    }
    await q('UPDATE conversation_members SET muted_until=$1 WHERE conversation_id=$2 AND user_id=$3', [mutedUntil, cid, m.uid]);
    send(ws, { type: 'chat:mute:done', request_id: p.request_id, user_id: to, muted_until: mutedUntil, muted: !!mutedUntil });
    send(ws, { type: 'chat:list', chats: await chats(m.uid) });
    return;
  }

  if (p.type === 'media:cached') {
    const mid = Number(p.message_id || 0);
    if (!mid) return;
    const mm = await one('SELECT sender_id,receiver_id,media_id FROM messages WHERE id=$1', [mid]);
    if (!mm || (Number(mm.sender_id) !== m.uid && Number(mm.receiver_id) !== m.uid)) throw Error('Not allowed');
    if (!mm.media_id) return;
    await q('INSERT INTO media_cache_receipts(message_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [mid, m.uid]);
    // Keep server media intact so clearing device cache never destroys media permanently.
    return send(ws, { type: 'media:cached:done', request_id: p.request_id, message_id: mid, server_copy: true });
  }

  if (p.type === 'reaction:set') {
    const mid = Number(p.message_id || 0);
    const emoji = String(p.emoji || '');
    const mm = await one('SELECT sender_id,receiver_id FROM messages WHERE id=$1 AND (sender_id=$2 OR receiver_id=$2)', [mid, m.uid]);
    if (!mm) throw Error('Not allowed');
    if (emoji) {
      await q(
        'INSERT INTO reactions(message_id,user_id,emoji) VALUES($1,$2,$3) ON CONFLICT(message_id,user_id) DO UPDATE SET emoji=$3,created_at=now()',
        [mid, m.uid, emoji]
      );
    } else {
      await q('DELETE FROM reactions WHERE message_id=$1 AND user_id=$2', [mid, m.uid]);
    }
    const rs = await all(
      'SELECT r.user_id,r.emoji,u.name FROM reactions r JOIN users u ON u.id=r.user_id WHERE r.message_id=$1',
      [mid]
    );
    const pack = { type: 'reaction:update', message_id: mid, reactions: rs };
    send(ws, { type: 'reaction:done', request_id: p.request_id, message_id: mid, reactions: rs });
    broadcast(mm.sender_id, pack, ws);
    broadcast(mm.receiver_id, pack, ws);
    return;
  }

  if (p.type === 'block') {
    const to = Number(p.user_id);
    if (p.blocked) await q('INSERT INTO blocks(user_id,blocked_user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [m.uid, to]);
    else await q('DELETE FROM blocks WHERE user_id=$1 AND blocked_user_id=$2', [m.uid, to]);
    send(ws, { type: 'block', request_id: p.request_id, user_id: to, blocked: !!p.blocked });
    return;
  }

  if (p.type === 'blocked:list') {
    const rows = await all(
      'SELECT u.id,u.phone,u.name,u.dp FROM blocks b JOIN users u ON u.id=b.blocked_user_id WHERE b.user_id=$1',
      [m.uid]
    );
    return send(ws, { type: 'blocked:list', request_id: p.request_id, users: rows });
  }

  if (p.type === 'privacy:contacts:list') {
    const kind = ['dp', 'last_seen', 'online', 'status'].includes(p.kind) ? p.kind : 'last_seen';
    const rows = await all('SELECT target_user_id FROM privacy_exceptions WHERE user_id=$1 AND kind=$2', [m.uid, kind]);
    return send(ws, { type: 'privacy:contacts:list', request_id: p.request_id, kind, user_ids: rows.map((x) => Number(x.target_user_id)) });
  }

  if (p.type === 'privacy:contacts') {
    const kind = ['dp', 'last_seen', 'online', 'status'].includes(p.kind) ? p.kind : 'last_seen';
    await q('DELETE FROM privacy_exceptions WHERE user_id=$1 AND kind=$2', [m.uid, kind]);
    for (const x of p.user_ids || []) {
      await q('INSERT INTO privacy_exceptions(user_id,target_user_id,kind) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [
        m.uid,
        Number(x),
        kind,
      ]);
    }
    return send(ws, { type: 'privacy:contacts:done', request_id: p.request_id, kind, user_ids: p.user_ids || [] });
  }

  if (p.type === 'contact:delete') {
    const cid = await one(
      'SELECT c.id FROM conversations c JOIN conversation_members a ON a.conversation_id=c.id AND a.user_id=$1 JOIN conversation_members b ON b.conversation_id=c.id AND b.user_id=$2',
      [m.uid, Number(p.user_id)]
    );
    if (cid) await q('DELETE FROM conversation_members WHERE conversation_id=$1 AND user_id=$2', [cid.id, m.uid]);
    return send(ws, { type: 'contact:deleted', request_id: p.request_id, user_id: Number(p.user_id) });
  }

  if (p.type === 'message:delete') {
    const mid = Number(p.message_id);
    const scope = p.scope;
    const mm = await one('SELECT * FROM messages WHERE id=$1 AND (sender_id=$2 OR receiver_id=$2)', [mid, m.uid]);
    if (!mm) throw Error('Not allowed');
    if (scope === 'me') {
      await q('INSERT INTO hidden_messages(message_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [mid, m.uid]);
    } else if (scope === 'everyone' && Number(mm.sender_id) === m.uid) {
      if (mm.media_id) {
        const md = await one('SELECT path FROM media WHERE id=$1', [mm.media_id]);
        if (md?.path) try { fs.unlinkSync(md.path); } catch {}
        await q('DELETE FROM media WHERE id=$1', [mm.media_id]);
      }
      await q('DELETE FROM messages WHERE id=$1', [mid]);
      broadcast(mm.receiver_id, { type: 'message:deleted', message_id: mid });
      send(ws, { type: 'message:deleted', message_id: mid });
    }
    return send(ws, { type: 'message:delete:done', request_id: p.request_id, message_id: mid, scope });
  }

  if (p.type === 'clear-chats') {
    await q(
      'INSERT INTO hidden_messages(message_id,user_id) SELECT m.id,$1 FROM messages m WHERE (m.sender_id=$1 OR m.receiver_id=$1) ON CONFLICT DO NOTHING',
      [m.uid]
    );
    return send(ws, { type: 'clear-chats:done', request_id: p.request_id });
  }

  if (p.type === 'clear-chat') {
    const to = Number(p.user_id);
    const c = await one(
      'SELECT c.id FROM conversations c JOIN conversation_members a ON a.conversation_id=c.id AND a.user_id=$1 JOIN conversation_members b ON b.conversation_id=c.id AND b.user_id=$2',
      [m.uid, to]
    );
    if (c) {
      const ms = await all('SELECT id,media_id FROM messages WHERE conversation_id=$1', [c.id]);
      for (const x of ms) {
        if (x.media_id) {
          const md = await one('SELECT path FROM media WHERE id=$1', [x.media_id]);
          if (md?.path) try { fs.unlinkSync(md.path); } catch {}
          await q('DELETE FROM media WHERE id=$1', [x.media_id]);
        }
      }
      await q('DELETE FROM messages WHERE conversation_id=$1', [c.id]);
      broadcast(to, { type: 'conversation:cleared', user_id: m.uid });
    }
    return send(ws, { type: 'clear-chats:done', request_id: p.request_id });
  }
}

async function handleApi(req, res, url) {
  const u = url.pathname;
  const uid = (await sessionUser(req))?.id;
  const data = req.method === 'POST' ? await body(req) : {};

  if (u === '/api/backend-url') {
    return json(res, 200, { ok: true, url: publicBase() || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}` });
  }
  if (u === '/api/me') {
    const user = await sessionUser(req);
    return json(res, user ? 200 : 401, { ok: !!user, user: user || null });
  }
  if (u === '/api/login' || u === '/api/register') {
    const phone = String(data.phone || '').trim();
    const pass = String(data.password || '');
    if (pass.length < 6) return json(res, 400, { ok: false, error: 'Password must be at least 6 characters' });
    if (u.endsWith('register')) {
      const name = String(data.name || '').trim();
      if (!name) return json(res, 400, { ok: false, error: 'Name required' });
      if (await one('SELECT id FROM users WHERE phone=$1', [phone])) {
        return json(res, 409, { ok: false, error: 'User ID already exists' });
      }
      const user = await one(
        'INSERT INTO users(phone,name,password_hash) VALUES($1,$2,$3) RETURNING id,phone,name,dp,last_seen',
        [phone, name, await bcrypt.hash(pass, 12)]
      );
      await q('INSERT INTO settings(user_id) VALUES($1)', [user.id]);
      const session = await loginUser(user, req, res);
      user.dp = null;
      return json(res, 200, { ok: true, user, access_token: session.token });
    }
    if (!phone) return json(res, 400, { ok: false, error: 'Phone / User ID is required' });
    const user = await one('SELECT * FROM users WHERE phone=$1', [phone]);
    if (!user) return json(res, 404, { ok: false, error: 'This phone / User ID is not registered' });
    if (user.admin_disabled) return json(res, 403, { ok: false, error: 'This account has been disabled' });
    if (!(await bcrypt.compare(pass, user.password_hash))) return json(res, 401, { ok: false, error: 'Incorrect password' });
    const session = await loginUser(user, req, res);
    return json(res, 200, {
      ok: true,
      user: { id: user.id, phone: user.phone, name: user.name, dp: null, last_seen: user.last_seen },
      access_token: session.token,
    });
  }
  if (u === '/api/forgot-device') {
    const phone = String(data.phone || '').trim();
    const token = String(data.device_recovery_token || '');
    if (!phone) return json(res, 400, { ok: false, error: 'Phone / User ID is required' });
    if (token.length < 20) {
      return json(res, 400, { ok: false, error: 'This device is not trusted for password recovery. Use a device where you previously logged in.' });
    }
    const user = await one('SELECT * FROM users WHERE phone=$1', [phone]);
    if (!user) return json(res, 404, { ok: false, error: 'This phone / User ID is not registered' });
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const trusted = await one('SELECT user_id FROM recovery_devices WHERE user_id=$1 AND token_hash=$2', [user.id, hash]);
    if (!trusted) {
      return json(res, 403, { ok: false, error: 'This device is not trusted for password recovery. Use a device where you previously logged in.' });
    }
    const np = String(data.new_password || '');
    if (np.length < 6) return json(res, 400, { ok: false, error: 'New password must be at least 6 characters' });
    await q('UPDATE users SET password_hash=$1,updated_at=now() WHERE id=$2', [await bcrypt.hash(np, 12), user.id]);
    await q('UPDATE recovery_devices SET last_used_at=now() WHERE user_id=$1 AND token_hash=$2', [user.id, hash]);
    await q('DELETE FROM sessions WHERE user_id=$1', [user.id]);
    return json(res, 200, { ok: true });
  }
  if (u === '/api/forgot-password') {
    return json(res, 410, { ok: false, error: 'Recovery codes have been removed. Use trusted-device recovery instead.' });
  }

  if (!uid) return json(res, 401, { ok: false, error: 'Login required' });

  if (u === '/api/logout') {
    await logout(req, res);
    return json(res, 200, { ok: true });
  }
  if (u === '/api/ice-servers') {
    const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
    if (process.env.TURN_URL) {
      iceServers.push({
        urls: process.env.TURN_URL,
        ...(process.env.TURN_USERNAME ? { username: process.env.TURN_USERNAME } : {}),
        ...(process.env.TURN_PASSWORD ? { credential: process.env.TURN_PASSWORD } : {}),
      });
    }
    return json(res, 200, { ok: true, iceServers });
  }
  if (u === '/api/search') {
    const term = String(data.q || '').trim();
    const rows = await all(
      'SELECT id,phone,name,NULL::text AS dp FROM users WHERE id<>$1 AND (phone ILIKE $2 OR name ILIKE $2) ORDER BY name LIMIT 50',
      [uid, '%' + term + '%']
    );
    return json(res, 200, { ok: true, users: rows });
  }
  if (u === '/api/invite') {
    const phone = String(data.phone || '').trim();
    return json(res, 200, { ok: true, url: `${publicBase() || ''}/?invite=${encodeURIComponent(phone)}` });
  }
  if (u === '/api/settings') {
    if (req.method === 'GET') return json(res, 200, { ok: true, settings: await settings(uid) });
    const s = data || {};
    const clamp = (n) => Math.max(0, Math.min(100, Number.isFinite(Number(n)) ? Number(n) : 70));
    const density = ['compact', 'comfortable', 'spacious'].includes(String(s.message_density || ''))
      ? String(s.message_density)
      : 'comfortable';
    await q(
      `INSERT INTO settings(user_id,notifications,read_receipts,last_seen_visibility,dp_visibility,theme,wallpaper,typing_indicator,enter_to_send,compact_bubbles,glass_ui,glass_intensity,animations,message_density,notification_preview,notification_volume,notification_vibrate,online_visibility,status_visibility)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT(user_id) DO UPDATE SET notifications=$2,read_receipts=$3,last_seen_visibility=$4,dp_visibility=$5,theme=$6,wallpaper=$7,typing_indicator=$8,enter_to_send=$9,compact_bubbles=$10,glass_ui=$11,glass_intensity=$12,animations=$13,message_density=$14,notification_preview=$15,notification_volume=$16,notification_vibrate=$17,online_visibility=$18,status_visibility=$19`,
      [
        uid,
        !!s.notifications,
        !!s.read_receipts,
        s.last_seen_visibility || 'everyone',
        s.dp_visibility || 'everyone',
        s.theme || 'light',
        s.wallpaper || 'classic',
        !!s.typing_indicator,
        !!s.enter_to_send,
        !!s.compact_bubbles,
        s.glass_ui !== false,
        clamp(s.glass_intensity),
        s.animations !== false,
        density,
        s.notification_preview !== false,
        clamp(s.notification_volume),
        s.notification_vibrate !== false,
        s.online_visibility || 'everyone',
        s.status_visibility || 'everyone',
      ]
    );
    return json(res, 200, { ok: true, settings: await settings(uid) });
  }
  if (u === '/api/profile') {
    const user = await userById(uid);
    if (data.name) {
      await q('UPDATE users SET name=$1,updated_at=now() WHERE id=$2', [String(data.name).trim(), uid]);
      user.name = String(data.name).trim();
    }
    return json(res, 200, { ok: true, user });
  }
  if (u === '/api/report-client-error') {
    await q('INSERT INTO client_errors(user_id,kind,message,stack,context) VALUES($1,$2,$3,$4,$5)', [
      uid,
      String(data.kind || ''),
      String(data.message || '').slice(0, 2000),
      String(data.stack || '').slice(0, 10000),
      JSON.stringify(data.context || {}),
    ]);
    return json(res, 200, { ok: true });
  }
  if (u === '/api/device-recovery') {
    if (req.method === 'GET') return json(res, 200, { ok: true, enabled: true });
    const token = crypto.randomBytes(32).toString('base64url');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    await q(
      'INSERT INTO recovery_devices(user_id,token_hash,user_agent) VALUES($1,$2,$3) ON CONFLICT(user_id,token_hash) DO UPDATE SET last_used_at=now(),user_agent=$3',
      [uid, hash, String(req.headers['user-agent'] || '').slice(0, 500)]
    );
    return json(res, 200, { ok: true, device_recovery_token: token });
  }
  if (u === '/api/change-password') {
    const user = await one('SELECT password_hash FROM users WHERE id=$1', [uid]);
    if (!(await bcrypt.compare(String(data.current_password || ''), user.password_hash))) {
      return json(res, 400, { ok: false, error: 'Current password incorrect' });
    }
    await q('UPDATE users SET password_hash=$1,updated_at=now() WHERE id=$2', [
      await bcrypt.hash(String(data.new_password || ''), 12),
      uid,
    ]);
    await q('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2', [
      uid,
      crypto.createHash('sha256').update(parseCookies(req).sid || '').digest('hex'),
    ]);
    return json(res, 200, { ok: true });
  }
  if (u === '/api/resolve-contacts') {
    const cs = Array.isArray(data.contacts) ? data.contacts : [];
    const out = [];
    for (const c of cs) {
      for (const ph of c.phones || []) {
        const phone = String(ph).replace(/\s+/g, '');
        const r = await one('SELECT id,phone,name,NULL::text AS dp FROM users WHERE phone=$1', [phone]);
        out.push(
          r
            ? { ...r, registered: true, contact_name: c.name?.[0] || '' }
            : { phone, registered: false, contact_name: c.name?.[0] || '' }
        );
      }
    }
    return json(res, 200, { ok: true, contacts: out });
  }
  return json(res, 404, { ok: false, error: 'Not found' });
}

async function multipart(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
    const fields = {};
    let file = null;
    let pending = 0;
    let finished = false;
    let rejected = false;
    const done = () => {
      if (finished && !pending && !rejected) resolve({ fields, file });
    };
    bb.on('field', (n, v) => (fields[n] = v));
    bb.on('file', (n, stream, info) => {
      pending++;
      const p = path.join(TMP, id() + '.part');
      const out = fs.createWriteStream(p);
      let size = 0;
      stream.on('data', (c) => (size += c.length));
      stream.on('limit', () => {
        rejected = true;
        stream.resume();
        reject(Error('Uploaded file is too large (max 25 MB).'));
      });
      stream.on('error', reject);
      out.on('error', reject);
      out.on('close', () => {
        pending--;
        file = { path: p, size, name: info.filename, mime: info.mimeType };
        done();
      });
      stream.pipe(out);
    });
    bb.on('finish', () => {
      finished = true;
      done();
    });
    bb.on('error', (e) => {
      rejected = true;
      reject(e);
    });
    req.on('aborted', () => {
      rejected = true;
      reject(Error('Upload aborted'));
    });
    req.pipe(bb);
  });
}

async function mediaApi(req, res, url) {
  const uid = (await sessionUser(req))?.id;
  if (!uid) return json(res, 401, { ok: false, error: 'Login required' });

  if (url.pathname === '/api/media-chunk' && req.method === 'POST') {
    const { fields, file } = await multipart(req);
    if (!file) return json(res, 400, { ok: false, error: 'Chunk missing' });
    const upload = String(fields.upload_id || '');
    const index = Number(fields.index || 0);
    const total = Number(fields.total || 1);
    if (!upload || index < 0 || total < 1 || index >= total) return json(res, 400, { ok: false, error: 'Invalid upload' });
    const dir = path.join(TMP, upload);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, String(index));
    fs.renameSync(file.path, target);
    const complete = fs.readdirSync(dir).filter((x) => /^\d+$/.test(x)).length === total;
    if (!complete) return json(res, 200, { ok: true, complete: false });

    const mediaId = id();
    const finalPath = path.join(MEDIA, mediaId);
    const ws = fs.createWriteStream(finalPath, { flags: 'wx' });
    for (let i = 0; i < total; i++) {
      const part = path.join(dir, String(i));
      if (!fs.existsSync(part)) {
        ws.destroy();
        try { fs.unlinkSync(finalPath); } catch {}
        return json(res, 409, { ok: false, error: `Chunk ${i} missing` });
      }
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(part);
        rs.on('error', reject);
        ws.on('error', reject);
        rs.on('end', resolve);
        rs.pipe(ws, { end: false });
      });
      fs.unlinkSync(part);
    }
    await new Promise((resolve, reject) => {
      ws.once('error', reject);
      ws.end(resolve);
    });
    fs.rmSync(dir, { recursive: true, force: true });
    const st = fs.statSync(finalPath);
    const mime = String(fields.mime || file.mime || 'application/octet-stream');
    const origName = String(fields.name || file.name || 'file').slice(0, 255);
    await q('INSERT INTO media(id,owner_id,mime,original_name,size,path) VALUES($1,$2,$3,$4,$5,$6)', [
      mediaId,
      uid,
      mime,
      origName,
      st.size,
      finalPath,
    ]);
    return json(res, 200, {
      ok: true,
      complete: true,
      media: {
        id: mediaId,
        mime,
        original_name: origName,
        size: st.size,
        url: absoluteUrl('/api/media?id=' + encodeURIComponent(mediaId)),
      },
    });
  }

  if (url.pathname === '/api/dp-chunk' && req.method === 'POST') {
    const { fields, file } = await multipart(req);
    if (!file) return json(res, 400, { ok: false, error: 'Image missing' });
    const dir = path.join(TMP, 'dp-' + String(fields.upload_id || id()));
    fs.mkdirSync(dir, { recursive: true });
    const idx = Number(fields.index || 0);
    fs.renameSync(file.path, path.join(dir, String(idx)));
    const total = Number(fields.total || 1);
    if (fs.readdirSync(dir).filter((x) => /^\d+$/.test(x)).length < total) return json(res, 200, { ok: true, complete: false });
    const name = `${uid}_${crypto.randomBytes(6).toString('hex')}.webp`;
    const dest = path.join(MEDIA, name);
    const out = fs.createWriteStream(dest);
    for (let i = 0; i < total; i++) {
      out.write(fs.readFileSync(path.join(dir, String(i))));
      fs.unlinkSync(path.join(dir, String(i)));
    }
    await new Promise((r) => out.end(r));
    fs.rmSync(dir, { recursive: true, force: true });
    const publicPath = '/api/dp?id=' + encodeURIComponent(uid);
    await q('UPDATE users SET dp=$1,updated_at=now() WHERE id=$2', [publicPath, uid]);
    return json(res, 200, { ok: true, complete: true, dp: publicPath });
  }

  if (url.pathname === '/api/dp' && req.method === 'GET') {
    const targetId = Number(url.searchParams.get('id') || 0);
    if (!targetId) return json(res, 400, { ok: false, error: 'User id required' });
    const target = await one('SELECT id,dp,name FROM users WHERE id=$1', [targetId]);
    if (!target || !target.dp) return json(res, 404, { ok: false, error: 'Profile photo not found' });
    if (Number(target.id) !== Number(uid)) {
      if ((await blocked(target.id, uid)) || (await blocked(uid, target.id))) return json(res, 404, { ok: false, error: 'Not found' });
      if (!(await privacy(target.id, uid, 'dp'))) return json(res, 404, { ok: false, error: 'Not found' });
    }
    const fileName = path.basename(String(target.dp));
    const filePath = path.join(MEDIA, fileName);
    if (!fileName || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return json(res, 404, { ok: false, error: 'Profile photo missing' });
    }
    res.writeHead(200, {
      'content-type': 'image/webp',
      'cache-control': 'private, max-age=300',
      'content-length': fs.statSync(filePath).size,
      'x-content-type-options': 'nosniff',
    });
    return fs.createReadStream(filePath).pipe(res);
  }

  if (url.pathname === '/api/media' && req.method === 'GET') {
    const mid = url.searchParams.get('id');
    const m = await one(
      `SELECT * FROM media WHERE id=$1 AND (
         owner_id=$2
         OR EXISTS(SELECT 1 FROM messages x WHERE x.id=media.message_id AND (x.sender_id=$2 OR x.receiver_id=$2))
         OR EXISTS(SELECT 1 FROM statuses s JOIN users su ON su.id=s.user_id WHERE s.media_id=media.id AND s.expires_at>now() AND NOT EXISTS(SELECT 1 FROM blocks b WHERE b.user_id=su.id AND b.blocked_user_id=$2) AND NOT EXISTS(SELECT 1 FROM blocks b WHERE b.user_id=$2 AND b.blocked_user_id=su.id))
       )`,
      [mid, uid]
    );
    if (!m) return json(res, 404, { ok: false, error: 'Not found' });
    if (!m.path || !fs.existsSync(m.path)) return json(res, 404, { ok: false, error: 'Media file not found on server.' });
    res.writeHead(200, {
      'content-type': m.mime,
      'cache-control': 'private, max-age=3600',
      'content-length': m.size,
      'x-content-type-options': 'nosniff',
    });
    return fs.createReadStream(m.path).pipe(res);
  }

  return json(res, 404, { ok: false, error: 'Not found' });
}

async function adminApi(req, res, url) {
  if (!isLocalAdminRequest(req)) {
    return json(res, 403, { error: 'Admin panel is local-only. Open it on this PC at http://127.0.0.1:' + PORT + '/admin' });
  }
  const token = parseCookies(req).admin_sid;
  let admin = null;
  if (token) {
    admin = await one('SELECT username FROM admin_sessions WHERE token_hash=$1 AND expires_at>now()', [
      crypto.createHash('sha256').update(token).digest('hex'),
    ]);
  }
  if (url.pathname === '/admin-api/login' && req.method === 'POST') {
    const expectedPass = String(process.env.ADMIN_PASSWORD || '');
    if (!expectedPass) return json(res, 503, { error: 'ADMIN_PASSWORD is not configured in .env' });
    const d = await body(req);
    if (String(d.username) !== String(process.env.ADMIN_USERNAME || 'admin') || String(d.password) !== expectedPass) {
      return json(res, 401, { error: 'Invalid admin credentials' });
    }
    const t = crypto.randomBytes(32).toString('base64url');
    await q("INSERT INTO admin_sessions(token_hash,username,expires_at) VALUES($1,$2,now()+interval '7 days')", [
      crypto.createHash('sha256').update(t).digest('hex'),
      String(d.username),
    ]);
    setCookie(res, 'admin_sid', t, 604800, req);
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/admin-api/me') return admin ? json(res, 200, { ok: true, admin: admin.username }) : json(res, 401, { error: 'Login required' });
  if (url.pathname === '/admin-api/logout') {
    const t = parseCookies(req).admin_sid;
    if (t) await q('DELETE FROM admin_sessions WHERE token_hash=$1', [crypto.createHash('sha256').update(t).digest('hex')]);
    setCookie(res, 'admin_sid', '', 0, req);
    return json(res, 200, { ok: true });
  }
  if (!admin) return json(res, 401, { error: 'Login required' });

  if (url.pathname === '/admin-api/runtime' && req.method === 'GET') {
    const local = readBackendConfig();
    const detected = detectCloudflaredUrl();
    return json(res, 200, {
      ok: true,
      backend_url: local.backend_url || '',
      updated_at: local.updated_at || null,
      detected_url: detected,
      github_repo: String(process.env.BACKEND_URL_REPO || process.env.FRONTEND_REPO || 'chat.app'),
    });
  }
  if (url.pathname === '/admin-api/runtime' && req.method === 'POST') {
    const requested = String((await body(req))?.backend_url || '').trim();
    const payload = saveBackendConfig(requested, 'admin');
    let published = false;
    let publishError = '';
    try {
      await publishFrontendRuntimeConfig(payload.backend_url);
      published = true;
    } catch (e) {
      publishError = String(e?.message || e);
    }
    return json(res, 200, {
      ok: true,
      backend_url: payload.backend_url,
      updated_at: payload.updated_at,
      published,
      publishError,
    });
  }

  const d = req.method === 'POST' ? await body(req) : {};
  const p = url.pathname.replace('/admin-api/', '');
  if (p === 'summary') {
    return json(res, 200, {
      users: Number((await one('SELECT count(*) n FROM users')).n),
      online: Number((await one('SELECT count(*) n FROM presence WHERE online')).n),
      conversations: Number((await one('SELECT count(*) n FROM conversations')).n),
      messages: Number((await one('SELECT count(*) n FROM messages')).n),
      media: Number((await one('SELECT count(*) n FROM media')).n),
      devices: Number((await one('SELECT count(*) n FROM devices')).n),
      sessions: Number((await one('SELECT count(*) n FROM sessions')).n),
      storage_bytes: (await one('SELECT COALESCE(sum(size),0) n FROM media')).n,
      node: process.version,
      connections: [...connections.values()].reduce((n, s) => n + s.size, 0),
      uptime: process.uptime(),
    });
  }
  if (p === 'users') {
    const query = url.searchParams.get('q');
    const rows = await all(
      'SELECT id,phone,name,dp,last_seen,created_at,admin_disabled FROM users ' +
        (query ? 'WHERE phone ILIKE $1 OR name ILIKE $1' : '') +
        ' ORDER BY id DESC LIMIT 1000',
      query ? ['%' + query + '%'] : []
    );
    return json(res, 200, { users: rows });
  }
  if (p === 'user/update') {
    await q('UPDATE users SET name=$1,phone=$2,updated_at=now() WHERE id=$3', [String(d.name || '').trim(), String(d.phone || '').trim(), d.id]);
    await q('INSERT INTO audit(admin,action,payload) VALUES($1,$2,$3)', [admin.username, 'user.update', d]);
    return json(res, 200, { ok: true });
  }
  if (p === 'user/password') {
    await q('UPDATE users SET password_hash=$1,updated_at=now() WHERE id=$2', [await bcrypt.hash(String(d.password), 12), d.id]);
    await q('DELETE FROM sessions WHERE user_id=$1', [d.id]);
    await q('INSERT INTO audit(admin,action,payload) VALUES($1,$2,$3)', [admin.username, 'user.password_reset', { id: d.id }]);
    return json(res, 200, { ok: true });
  }
  if (p === 'user/disable') {
    await q('UPDATE users SET admin_disabled=$1 WHERE id=$2', [!!d.disabled, d.id]);
    return json(res, 200, { ok: true });
  }
  if (p === 'user/delete') {
    const files = await all('SELECT path FROM media WHERE owner_id=$1', [d.id]);
    await q('DELETE FROM users WHERE id=$1', [d.id]);
    for (const f of files) try { if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch {}
    await q('INSERT INTO audit(admin,action,payload) VALUES($1,$2,$3)', [admin.username, 'user.delete', { id: d.id }]);
    return json(res, 200, { ok: true });
  }
  if (p === 'devices') {
    return json(res, 200, {
      devices: await all('SELECT d.id,d.device_id,d.user_agent,d.updated_at,u.name,u.phone FROM devices d JOIN users u ON u.id=d.user_id ORDER BY d.updated_at DESC LIMIT 2000'),
    });
  }
  if (p === 'device/revoke') {
    await q('DELETE FROM devices WHERE id=$1', [d.id]);
    return json(res, 200, { ok: true });
  }
  if (p === 'sessions') {
    return json(res, 200, {
      sessions: await all('SELECT s.user_id,s.created_at,s.expires_at,s.user_agent,u.name,u.phone FROM sessions s JOIN users u ON u.id=s.user_id ORDER BY s.created_at DESC LIMIT 2000'),
    });
  }
  if (p === 'session/revoke') {
    await q('DELETE FROM sessions WHERE user_id=$1', [d.user_id]);
    return json(res, 200, { ok: true });
  }
  if (p === 'errors') return json(res, 200, { errors: await all('SELECT * FROM client_errors ORDER BY id DESC LIMIT 1000') });
  if (p === 'audit') return json(res, 200, { audit: await all('SELECT * FROM audit ORDER BY id DESC LIMIT 1000') });
  if (p === 'chats') {
    return json(res, 200, {
      chats: await all(
        "SELECT c.id,c.updated_at,string_agg(u.name,', ' ORDER BY u.id) names,count(m.id)::int message_count FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id JOIN users u ON u.id=cm.user_id LEFT JOIN messages m ON m.conversation_id=c.id GROUP BY c.id ORDER BY c.updated_at DESC LIMIT 1000"
      ),
    });
  }
  if (p === 'messages') {
    return json(res, 200, {
      messages: await all(
        'SELECT m.id,m.conversation_id,m.sender_id,m.receiver_id,m.body,m.created_at,r.delivered_at,r.read_at,u.name sender_name FROM messages m JOIN users u ON u.id=m.sender_id LEFT JOIN message_receipts r ON r.message_id=m.id WHERE m.conversation_id=$1 ORDER BY m.id',
        [url.searchParams.get('conversation_id')]
      ),
    });
  }
  if (p === 'message/delete') {
    const files = await all('SELECT path FROM media WHERE message_id=$1', [d.id]);
    await q('DELETE FROM messages WHERE id=$1', [d.id]);
    for (const f of files) try { if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch {}
    await q('INSERT INTO audit(admin,action,payload) VALUES($1,$2,$3)', [admin.username, 'message.delete', { id: d.id }]);
    return json(res, 200, { ok: true });
  }
  if (p === 'conversation/delete') {
    const files = await all('SELECT path FROM media WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=$1)', [d.id]);
    await q('DELETE FROM conversations WHERE id=$1', [d.id]);
    for (const f of files) try { if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch {}
    return json(res, 200, { ok: true });
  }
  if (p === 'media') {
    const rows = await all(
      'SELECT m.id,m.original_name,m.mime,m.size,m.path,m.created_at,m.message_id,u.name owner_name,u.phone FROM media m JOIN users u ON u.id=m.owner_id ORDER BY m.created_at DESC LIMIT 2000'
    );
    return json(res, 200, { media: rows.map((x) => ({ ...x, size: Number(x.size), exists: !!(x.path && fs.existsSync(x.path)) })) });
  }
  if (p === 'media/delete') {
    const m = await one('SELECT path FROM media WHERE id=$1', [d.id]);
    await q('DELETE FROM media WHERE id=$1', [d.id]);
    if (m?.path) try { if (fs.existsSync(m.path)) fs.unlinkSync(m.path); } catch {}
    return json(res, 200, { ok: true });
  }
  if (p === 'media/download') {
    const m = await one('SELECT * FROM media WHERE id=$1', [url.searchParams.get('id')]);
    if (!m || !m.path || !fs.existsSync(m.path)) return json(res, 404, { error: 'Media not found' });
    res.writeHead(200, {
      'content-type': m.mime,
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(m.original_name)}`,
      'content-length': m.size,
      'cache-control': 'private, max-age=60',
    });
    return fs.createReadStream(m.path).pipe(res);
  }
  if (p === 'storage/cleanup') {
    const rows = await all('SELECT path FROM media WHERE path IS NOT NULL');
    const keep = new Set(rows.map((x) => path.resolve(x.path)));
    let removed = 0;
    for (const f of fs.readdirSync(MEDIA)) {
      const fp = path.resolve(path.join(MEDIA, f));
      if (!keep.has(fp) && fs.statSync(fp).isFile()) {
        try { fs.unlinkSync(fp); removed++; } catch {}
      }
    }
    for (const dir of fs.readdirSync(TMP)) {
      try { fs.rmSync(path.join(TMP, dir), { recursive: true, force: true }); removed++; } catch {}
    }
    return json(res, 200, { ok: true, removed });
  }
  if (p === 'blocks') {
    return json(res, 200, {
      blocks: await all(
        'SELECT b.user_id,u.name user_name,u.phone user_phone,b.blocked_user_id,u2.name blocked_name,u2.phone blocked_phone,b.created_at FROM blocks b JOIN users u ON u.id=b.user_id JOIN users u2 ON u2.id=b.blocked_user_id ORDER BY b.created_at DESC LIMIT 2000'
      ),
    });
  }
  if (p === 'db') {
    const size = await one('SELECT pg_database_size(current_database()) size');
    const tables = await all('SELECT relname name,pg_total_relation_size(relid) size FROM pg_catalog.pg_statio_user_tables ORDER BY size DESC');
    return json(res, 200, {
      integrity: 'PostgreSQL',
      wal: 'MVCC',
      size_bytes: Number(size.size),
      tables: tables.map((x) => ({ ...x, size: Number(x.size) })),
    });
  }
  return json(res, 404, { error: 'Not found' });
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb', type: ['application/json', 'application/*+json'] }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

function corsAllowed(origin) {
  if (!origin) return true;
  const clean = String(origin).replace(/\/$/, '');
  const configured = String(process.env.FRONTEND_ORIGINS || '')
    .split(',')
    .map((x) => x.trim().replace(/\/$/, ''))
    .filter(Boolean);
  const defaults = [
    'https://mychat-frontend-zeta.vercel.app',
    'capacitor://localhost',
    'ionic://localhost',
    'https://localhost',
    'http://localhost',
    'http://localhost:8000',
    'http://127.0.0.1:8000',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ];
  if (configured.includes('*')) return false;
  if ([...new Set([...defaults, ...configured])].includes(clean)) return true;
  try {
    const h = new URL(clean).hostname;
    if (/^(localhost|127\.0\.0\.1)$/i.test(h)) return true;
    if (h.endsWith('.trycloudflare.com') || h.endsWith('.vercel.app')) return true;
  } catch {}
  return false;
}

app.use((req, res, next) => {
  const origin = String(req.headers.origin || '');
  if (origin && corsAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many attempts. Please try again in a few minutes.' },
});
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Search rate limit exceeded. Slow down a bit.' },
});

app.use(['/api/login', '/api/register', '/api/forgot-device', '/admin-api/login'], authLimiter);
app.use('/api/search', searchLimiter);

app.get('/healthz', async (req, res) => {
  try {
    const r = await one('SELECT 1 AS ok');
    return json(res, 200, {
      ok: true,
      node: process.version,
      postgres: r?.ok === 1,
      port: PORT,
      websocket: true,
      backend_url: publicBase() || '',
    });
  } catch (e) {
    return json(res, 503, { ok: false, node: process.version, postgres: false, websocket: true, error: String(e?.message || e) });
  }
});

app.use('/api', async (req, res, next) => {
  try {
    const url = new URL(req.originalUrl, 'http://localhost');
    const name = url.pathname.replace(/^\/api\//, '');
    if (name.startsWith('media') || name.startsWith('dp')) return mediaApi(req, res, url);
    return handleApi(req, res, url);
  } catch (e) {
    next(e);
  }
});

app.get(['/admin', '/admin/'], (req, res) => {
  if (!isLocalAdminRequest(req)) return res.status(403).type('text/plain').send('Admin panel is local-only.');
  return res.sendFile(path.join(__dirname, 'public/admin/index.html'));
});

app.use('/admin-api', async (req, res, next) => {
  try {
    return await adminApi(req, res, new URL(req.originalUrl, 'http://localhost'));
  } catch (e) {
    next(e);
  }
});

app.post('/__realtime/receipt', async (req, res, next) => {
  try {
    const u = await sessionUser(req);
    if (!u) return json(res, 401, { ok: false });
    const d = req.body || {};
    const mm = await one('SELECT sender_id FROM messages WHERE id=$1 AND receiver_id=$2', [d.message_id, u.id]);
    if (mm) {
      await q('UPDATE message_receipts SET delivered_at=COALESCE(delivered_at,now()) WHERE message_id=$1', [d.message_id]);
      const r = await one('SELECT delivered_at,read_at FROM message_receipts WHERE message_id=$1', [d.message_id]);
      broadcast(mm.sender_id, { type: 'delivered', message_id: Number(d.message_id), delivered_at: r.delivered_at, read_at: r.read_at });
    }
    return json(res, 200, { ok: true });
  } catch (e) {
    next(e);
  }
});

app.get('/runtime-config.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return json(res, 200, {
    backend_url: publicBase() || `${req.protocol}://${req.get('host')}`,
    updated_at: new Date().toISOString(),
    source: 'backend',
  });
});

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', etag: true, maxAge: 3600000 }));
app.use((req, res) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/admin-api/') && !req.path.startsWith('/ws')) {
    return res.sendFile(path.join(__dirname, 'public/index.html'));
  }
  return json(res, 404, { error: 'Not found' });
});

app.use((err, req, res, next) => {
  logErr(err, 'http');
  if (!res.headersSent) json(res, 500, { ok: false, error: 'Internal server error' });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, clientTracking: false });

wss.on('connection', async (ws, req, u) => {
  addConn(u.id, ws);

  ws.on('message', (raw) => {
    let p;
    try {
      p = JSON.parse(raw.toString());
    } catch {
      return send(ws, { type: 'error', error: 'Invalid JSON' });
    }
    socketMessage(ws, p).catch((e) =>
      send(ws, { type: 'error', request_id: p?.request_id, error: e.message || 'Realtime error' })
    );
  });

  ws.on('close', () => {
    const m = removeConn(ws);
    if (m && userSockets(m.uid).size === 0) {
      setOnline(m.uid, false)
        .then(() => presenceFanout(m.uid, false))
        .catch((e) => logErr(e, 'presence-close'));
    }
  });
  ws.on('error', () => {});

  try {
    await setOnline(u.id, true);
    send(ws, { type: 'ready', user_id: Number(u.id), server_time: now(), online: true });
    send(ws, { type: 'sync:required', reason: 'connected' });
    send(ws, { type: 'chat:list', chats: await chats(u.id) });
    send(ws, { type: 'settings', settings: await settings(u.id) });
    send(ws, { type: 'status:list', statuses: await statusList(u.id) });
    presenceFanout(u.id, true).catch(() => {});
    for (const peer of await contactIds(u.id)) broadcast(peer, { type: 'profile:request', from: Number(u.id) });
  } catch (e) {
    logErr(e, 'ws-init');
  }
});

server.on('upgrade', async (req, socket, head) => {
  try {
    if (req.url.split('?')[0] !== '/ws') throw Error('Not found');
    const origin = String(req.headers.origin || '');
    if (origin && !corsAllowed(origin)) throw Error('Forbidden origin');
    const token = String(new URL(req.url, 'http://localhost').searchParams.get('access_token') || '');
    if (token) req.headers.authorization = 'Bearer ' + token;
    const u = await sessionUser(req);
    if (!u) throw Error('Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, u));
  } catch {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
  }
});

setInterval(() => {
  for (const [, set] of connections) {
    for (const ws of set) {
      const m = meta.get(ws);
      if (!m || Date.now() - m.lastBeat > 35000) {
        try { ws.terminate(); } catch {}
      } else {
        try { ws.ping(); } catch {}
      }
    }
  }
  writeRuntime();
}, 10000);

let tunnelProc = null;

function stopTunnel() {
  if (tunnelProc && !tunnelProc.killed) {
    try { tunnelProc.kill(); } catch {}
  }
  tunnelProc = null;
}

process.on('uncaughtException', (e) => {
  logErr(e, 'uncaughtException');
  stopTunnel();
  process.exit(1);
});
process.on('unhandledRejection', (e) => logErr(e, 'unhandledRejection'));
process.on('SIGINT', async () => {
  stopTunnel();
  for (const s of connections.values()) for (const ws of s) try { ws.close(); } catch {}
  await pool.end();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  stopTunnel();
  for (const s of connections.values()) for (const ws of s) try { ws.close(); } catch {}
  await pool.end();
  process.exit(0);
});

async function handleDetectedTunnelUrl(detected) {
  try {
    saveBackendConfig(detected, 'cloudflared');
    console.log(`[Tunnel] Active URL: ${detected}`);
    if (process.env.GITHUB_TOKEN && process.env.GH_OWNER) {
      const res = await publishFrontendRuntimeConfig(detected);
      console.log(`[GitHub] Updated ${res.owner}/${res.repo}/${res.path} (${res.branch}) -> ${detected}`);
    }
  } catch (e) {
    console.warn(`[GitHub] Could not auto-publish tunnel URL: ${e.message}`);
  }
}

function startIntegratedTunnel() {
  if (process.env.AUTO_TUNNEL === '0') return;
  const fixedPublic = String(process.env.PUBLIC_URL || '').trim();
  if (fixedPublic && /^https:\/\//i.test(fixedPublic) && !/your-domain\.example/i.test(fixedPublic)) {
    return;
  }
  const logDir = path.join(__dirname, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.resolve(__dirname, process.env.CLOUDFLARED_LOG || 'logs/cloudflared.log');
  fs.writeFileSync(logFile, '');

  const bin = process.env.CLOUDFLARED_BIN || 'cloudflared';
  console.log(`[Tunnel] Starting integrated Cloudflare Quick Tunnel -> http://127.0.0.1:${PORT}`);
  tunnelProc = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let publishedUrl = '';
  const onChunk = (chunk) => {
    const str = chunk.toString();
    try { fs.appendFileSync(logFile, str); } catch {}
    const m = str.match(/https:\/\/[-a-z0-9]+\.trycloudflare\.com/i);
    if (m?.[0] && m[0] !== publishedUrl) {
      publishedUrl = m[0];
      void handleDetectedTunnelUrl(publishedUrl);
    }
  };

  tunnelProc.stdout.on('data', onChunk);
  tunnelProc.stderr.on('data', onChunk);
  tunnelProc.on('error', (err) => {
    console.warn(`[Tunnel] Could not start cloudflared (${err.message}). Running locally only.`);
  });
  tunnelProc.on('exit', (code) => {
    tunnelProc = null;
    if (code !== null && code !== 0) {
      console.warn(`[Tunnel] cloudflared exited with code ${code}.`);
    }
  });
}

(async () => {
  try {
    await schema();
    writeRuntime();
    server.listen(PORT, HOST, () => {
      console.log(`MyChat Express server listening on http://${HOST}:${PORT} | WSS /ws | PostgreSQL ${process.env.PGHOST || '127.0.0.1'}:${process.env.PGPORT || 5432}`);
      console.log(`Admin Panel: http://127.0.0.1:${PORT}/admin`);
      startIntegratedTunnel();
    });
  } catch (e) {
    console.error('Startup failed:', e);
    process.exit(1);
  }
})();
