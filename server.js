// Madifyx Clips: a small self-hosted screen recorder with share links.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { storage } = require('./storage');

const PORT = process.env.PORT || 3000;
const APP_NAME = process.env.APP_NAME || 'Madifyx Clips';
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 2048);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const VIDEO_DIR = path.join(DATA_DIR, 'videos');
const DB_FILE = path.join(DATA_DIR, 'db.json');

fs.mkdirSync(VIDEO_DIR, { recursive: true });

const ffmpegCheck = spawnSync('ffmpeg', ['-version']);
const HAS_FFMPEG = !ffmpegCheck.error && ffmpegCheck.status === 0;

// ---------- tiny JSON database ----------
let db = { videos: {}, users: {}, sessions: {} };
if (fs.existsSync(DB_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { console.error('Could not read db.json', e); }
}
db.videos ||= {}; db.users ||= {}; db.sessions ||= {}; db.invites ||= {};
let saveTimer = null;
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  }, 100);
  pushDb();
}

// When cloud storage is on, the database is copied there too, so nothing is lost
// if the host wipes its disk (Render's free plan does this on every restart).
let pushTimer = null, pushChain = Promise.resolve();
function pushDb(delay = 1500) {
  if (!storage.enabled) return pushChain;
  clearTimeout(pushTimer);
  return new Promise(resolve => {
    pushTimer = setTimeout(() => {
      pushChain = pushChain
        .then(() => storage.putBuffer('db.json', Buffer.from(JSON.stringify(db)), 'application/json'))
        .catch(e => console.error('Could not save database to cloud storage:', e.message))
        .then(resolve);
    }, delay);
  });
}
function normalizeDb() { db.videos ||= {}; db.users ||= {}; db.sessions ||= {}; db.invites ||= {}; }

function newId() {
  let id;
  do { id = crypto.randomBytes(6).toString('base64url'); } while (db.videos[id]);
  return id;
}

function publicVideo(v) {
  const file = v.mp4 || v.original;
  return {
    id: v.id,
    title: v.title,
    createdAt: v.createdAt,
    duration: v.duration || null,
    views: v.views || 0,
    status: v.status,
    src: '/media/' + file,
    mime: v.mp4 ? 'video/mp4' : v.mime,
    thumb: v.thumb ? '/media/' + v.thumb : null,
    sizeBytes: v.sizeBytes,
    owner: db.users[v.ownerId] ? db.users[v.ownerId].name : null,
    reactions: v.reactions || {},
    commentCount: (v.comments || []).length,
  };
}

const REACTIONS = ['\u{1F44D}', '\u2764\uFE0F', '\u{1F602}', '\u{1F389}', '\u{1F525}', '\u{1F440}'];
function publicComment(c) {
  return { id: c.id, name: c.name, text: c.text, t: c.t, at: c.at, userId: c.userId || null };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}


// ---------- video processing (optional, needs ffmpeg) ----------
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-y', '-loglevel', 'error', ...args]);
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(err || 'ffmpeg failed'))));
  });
}

function probeDuration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  const n = parseFloat(String(r.stdout || ''));
  return Number.isFinite(n) ? n : null;
}

// One video at a time keeps memory use low on small servers.
let queue = Promise.resolve();
function enqueue(id) { queue = queue.then(() => handleNewVideo(id)).catch(e => console.error(e)); }

const localPath = f => path.join(VIDEO_DIR, f);
const rmLocal = f => f && fs.rm(localPath(f), () => {});

async function handleNewVideo(id) {
  const v = db.videos[id];
  if (!v) return;
  // 1. Make sure the recording is safe in cloud storage before anything else
  if (storage.enabled && !v.cloud?.original) {
    if (!fs.existsSync(localPath(v.original))) return;
    try {
      await storage.putFile(v.original, localPath(v.original), v.mime);
      v.cloud = { ...(v.cloud || {}), original: true }; saveDb();
    } catch (e) { console.error('Could not copy recording to cloud storage:', e.message); }
  }
  // 2. Convert to mp4 and make a thumbnail
  if (HAS_FFMPEG && v.status === 'processing') await processVideo(id);
  else if (v.status === 'processing') { v.status = 'ready'; saveDb(); }
}

async function processVideo(id) {
  const v = db.videos[id];
  if (!v) return;
  const input = localPath(v.original);
  try {
    if (!fs.existsSync(input)) {
      if (!storage.enabled || !v.cloud?.original) throw new Error('Original recording is missing');
      await storage.getToFile(v.original, input);
    }
    const mp4 = id + '.mp4';
    // Converting to mp4 makes the video seekable everywhere and play on iPhone/Safari.
    await runFfmpeg(['-i', input, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-threads', '2',
      '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', localPath(mp4)]);
    const thumb = id + '.jpg';
    await runFfmpeg(['-ss', '1', '-i', localPath(mp4), '-frames:v', '1', '-vf', 'scale=640:-2', localPath(thumb)])
      .catch(() => runFfmpeg(['-i', localPath(mp4), '-frames:v', '1', '-vf', 'scale=640:-2', localPath(thumb)]));
    const hasThumb = fs.existsSync(localPath(thumb));
    const duration = probeDuration(localPath(mp4));
    if (storage.enabled) {
      await storage.putFile(mp4, localPath(mp4), 'video/mp4');
      if (hasThumb) await storage.putFile(thumb, localPath(thumb), 'image/jpeg');
      v.cloud = { ...(v.cloud || {}), mp4: true, thumb: hasThumb };
    }
    v.mp4 = mp4;
    v.thumb = hasThumb ? thumb : null;
    v.duration = duration || v.duration;
    v.status = 'ready';
    if (storage.enabled) { rmLocal(mp4); rmLocal(thumb); }
    if (process.env.KEEP_ORIGINAL !== '1') {
      rmLocal(v.original);
      if (storage.enabled && v.cloud?.original) storage.remove(v.original).then(() => { v.cloud.original = false; saveDb(); }).catch(() => {});
    } else if (storage.enabled) rmLocal(v.original);
  } catch (e) {
    console.error('Processing failed for', id, e.message);
    v.status = 'ready'; // the original recording still plays in Chrome/Edge/Firefox
  }
  saveDb();
}

// ---------- small helpers (no external packages needed) ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, ...extra });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json');

function readJson(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

// Serves a file with Range support so video seeking works.
function serveFile(req, res, dir, rel, maxAge) {
  const file = path.normalize(path.join(dir, rel));
  if (!file.startsWith(dir + path.sep)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': `public, max-age=${maxAge}` };
    const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (range) {
      let startB = range[1] === '' ? st.size - Number(range[2]) : Number(range[1]);
      let endB = range[1] !== '' && range[2] !== '' ? Number(range[2]) : st.size - 1;
      startB = Math.max(0, startB); endB = Math.min(endB, st.size - 1);
      if (startB > endB) return send(res, 416, '', type, { 'Content-Range': `bytes */${st.size}` });
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${startB}-${endB}/${st.size}`, 'Content-Length': endB - startB + 1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start: startB, end: endB }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---------- accounts and sessions ----------
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
function checkPassword(user, password) {
  const { hash } = hashPassword(password, user.salt);
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, createdAt: u.createdAt };
}
const findUserByEmail = email => Object.values(db.users).find(u => u.email === String(email).trim().toLowerCase());
const hasUsers = () => Object.keys(db.users).length > 0;

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function isHttps(req) { return req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted; }

function createSession(req, res, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.sessions[token] = { userId: user.id, expires: Date.now() + SESSION_DAYS * 864e5 };
  saveDb();
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_DAYS * 86400}`];
  if (isHttps(req)) flags.push('Secure');
  res.setHeader('Set-Cookie', `sid=${token}; ${flags.join('; ')}`);
}
function currentUser(req) {
  const token = parseCookies(req).sid;
  const s = token && db.sessions[token];
  if (!s) return null;
  if (s.expires < Date.now()) { delete db.sessions[token]; saveDb(); return null; }
  return db.users[s.userId] || null;
}
function clearSession(req, res) {
  const token = parseCookies(req).sid;
  if (token) { delete db.sessions[token]; saveDb(); }
  res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}
function endSessionsFor(userId, exceptToken) {
  for (const [t, s] of Object.entries(db.sessions)) if (s.userId === userId && t !== exceptToken) delete db.sessions[t];
}

// Slow down password guessing: 10 failed tries per IP per 15 minutes
const loginFails = new Map();
function tooManyFails(ip) {
  const r = loginFails.get(ip);
  return r && r.count >= 10 && Date.now() - r.first < 15 * 60e3;
}
function noteFail(ip) {
  const r = loginFails.get(ip);
  if (!r || Date.now() - r.first > 15 * 60e3) loginFails.set(ip, { count: 1, first: Date.now() });
  else r.count++;
}
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const r = hits.get(key);
  if (!r || now - r.first > windowMs) { hits.set(key, { n: 1, first: now }); return false; }
  r.n++;
  return r.n > max;
}
const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

function validateNewUser(body) {
  const name = String(body.name || '').trim().slice(0, 80);
  const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
  const password = String(body.password || '');
  if (!name) return { error: 'Please enter a name' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Please enter a valid email' };
  if (password.length < 8) return { error: 'Password must be at least 8 characters' };
  if (findUserByEmail(email)) return { error: 'That email already has an account' };
  return { name, email, password };
}
function addUser({ name, email, password }, role) {
  const id = crypto.randomBytes(8).toString('base64url');
  const { salt, hash } = hashPassword(password);
  db.users[id] = { id, name, email, role, salt, hash, createdAt: new Date().toISOString() };
  saveDb();
  return db.users[id];
}
const baseUrl = req => `${req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')}://${req.headers.host}`;
const redirect = (res, to) => { res.writeHead(302, { Location: to }); res.end(); };
const canEdit = (user, v) => user.role === 'owner' || v.ownerId === user.id;

function page(file, vars = {}) {
  let html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8').replaceAll('{{APP_NAME}}', escapeHtml(APP_NAME));
  for (const [k, v] of Object.entries(vars)) html = html.replaceAll(`{{${k}}}`, v);
  return html;
}

// ---------- upload ----------
function handleUpload(req, res, query, user) {
  const mime = String(req.headers['content-type'] || 'video/webm').split(';')[0];
  const ext = mime.includes('mp4') ? 'mp4' : 'webm';
  const id = newId();
  const original = `${id}.orig.${ext}`;
  const dest = path.join(VIDEO_DIR, original);
  const out = fs.createWriteStream(dest);
  let bytes = 0, aborted = false;

  req.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > MAX_UPLOAD_MB * 1024 * 1024 && !aborted) {
      aborted = true;
      req.unpipe(out); out.destroy(); fs.rm(dest, () => {});
      json(res, 413, { error: 'Video is too large' });
      req.destroy();
    }
  });
  req.on('aborted', () => { aborted = true; out.destroy(); fs.rm(dest, () => {}); });
  req.pipe(out);
  out.on('finish', () => {
    if (aborted) return;
    if (bytes === 0) { fs.rm(dest, () => {}); return json(res, 400, { error: 'Empty upload' }); }
    const title = String(query.get('title') || '').trim().slice(0, 200) || `Recording ${new Date().toLocaleString('en-US')}`;
    const duration = parseFloat(query.get('duration'));
    db.videos[id] = {
      id, title, original, mime, sizeBytes: bytes, ownerId: user.id,
      createdAt: new Date().toISOString(),
      duration: Number.isFinite(duration) ? duration : null,
      views: 0, status: HAS_FFMPEG || storage.enabled ? 'processing' : 'ready',
    };
    saveDb();
    json(res, 200, { id, url: `/v/${id}` });
    enqueue(id);
  });
  out.on('error', e => { if (!res.headersSent) json(res, 500, { error: e.message }); });
}

// ---------- routes ----------
const PUBLIC_DIR = path.join(__dirname, 'public');

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    const m = req.method;
    let match;

    if ((m === 'GET' || m === 'HEAD') && p.startsWith('/media/')) {
      const file = p.slice(7);
      const v = db.videos[file.split('.')[0]];
      if (!v || ![v.original, v.mp4, v.thumb].includes(file)) return send(res, 404, 'Not found');
      const download = url.searchParams.get('download') === '1'
        ? (v.title.replace(/[^\w .-]+/g, '').trim() || 'video') + path.extname(file) : null;
      if (fs.existsSync(localPath(file))) {
        if (download) res.setHeader('Content-Disposition', `attachment; filename="${download}"`);
        return serveFile(req, res, VIDEO_DIR, file, 604800);
      }
      if (storage.enabled) {
        res.writeHead(302, { Location: storage.link(file, { download }), 'Cache-Control': 'private, max-age=600' });
        return res.end();
      }
      return send(res, 404, 'Not found');
    }
    if ((m === 'GET' || m === 'HEAD') && p.startsWith('/static/')) return serveFile(req, res, PUBLIC_DIR, p.slice(8), 3600);

    // Share page (public)
    if (m === 'GET' && (match = /^\/v\/([\w-]+)$/.exec(p))) {
      const v = db.videos[match[1]];
      if (!v) return send(res, 404, '<h1>Video not found</h1>', MIME['.html']);
      const base = baseUrl(req);
      const pv = publicVideo(v);
      return send(res, 200, page('view.html', {
        TITLE: escapeHtml(v.title), ID: escapeHtml(v.id),
        OG_IMAGE: pv.thumb ? escapeHtml(base + pv.thumb) : '', OG_URL: escapeHtml(`${base}/v/${v.id}`),
      }), MIME['.html']);
    }
    if (m === 'GET' && (match = /^\/api\/videos\/([\w-]+)\/public$/.exec(p))) {
      const v = db.videos[match[1]];
      if (!v) return json(res, 404, { error: 'Not found' });
      const me = currentUser(req);
      return json(res, 200, { ...publicVideo(v), canEdit: !!(me && canEdit(me, v)), me: me ? { id: me.id, name: me.name, role: me.role } : null });
    }
    if (m === 'POST' && (match = /^\/api\/videos\/([\w-]+)\/view$/.exec(p))) {
      const v = db.videos[match[1]];
      if (!v) return json(res, 404, { error: 'Not found' });
      v.views = (v.views || 0) + 1; saveDb();
      return json(res, 200, { views: v.views });
    }
    if (m === 'GET' && p === '/api/config') return json(res, 200, { appName: APP_NAME, ffmpeg: HAS_FFMPEG });

    // ---------- comments and reactions (anyone with the link) ----------
    if ((match = /^\/api\/videos\/([\w-]+)\/comments(?:\/([\w-]+))?$/.exec(p))) {
      const v = db.videos[match[1]];
      if (!v) return json(res, 404, { error: 'Not found' });
      v.comments ||= [];
      if (m === 'GET' && !match[2]) return json(res, 200, v.comments.map(publicComment));
      const me = currentUser(req);
      if (m === 'POST' && !match[2]) {
        if (limited('c:' + clientIp(req), 20, 10 * 60e3)) return json(res, 429, { error: 'Too many comments. Try again in a few minutes.' });
        const body = await readJson(req);
        const text = String(body.text || '').trim().slice(0, 1000);
        const name = me ? me.name : String(body.name || '').trim().slice(0, 60);
        if (!text) return json(res, 400, { error: 'Write a comment first' });
        if (!name) return json(res, 400, { error: 'Add your name so they know who commented' });
        const t = body.t === null || body.t === undefined || body.t === '' ? NaN : Number(body.t);
        const c = { id: crypto.randomBytes(5).toString('base64url'), name, text, t: Number.isFinite(t) && t >= 0 ? Math.round(t * 10) / 10 : null, at: new Date().toISOString(), userId: me ? me.id : null };
        v.comments.push(c); saveDb();
        return json(res, 200, publicComment(c));
      }
      if (m === 'DELETE' && match[2]) {
        const c = v.comments.find(x => x.id === match[2]);
        if (!c) return json(res, 404, { error: 'Not found' });
        if (!me || !(canEdit(me, v) || c.userId === me.id)) return json(res, 403, { error: 'You can only delete your own comments' });
        v.comments = v.comments.filter(x => x.id !== c.id); saveDb();
        return json(res, 200, { ok: true });
      }
    }
    if (m === 'POST' && (match = /^\/api\/videos\/([\w-]+)\/react$/.exec(p))) {
      const v = db.videos[match[1]];
      if (!v) return json(res, 404, { error: 'Not found' });
      if (limited('r:' + clientIp(req), 60, 10 * 60e3)) return json(res, 429, { error: 'Slow down a little' });
      const body = await readJson(req);
      if (!REACTIONS.includes(body.emoji)) return json(res, 400, { error: 'Unknown reaction' });
      v.reactions ||= {};
      v.reactions[body.emoji] = (v.reactions[body.emoji] || 0) + 1; saveDb();
      return json(res, 200, { reactions: v.reactions });
    }

    // ---------- invites ----------
    if ((match = /^\/invite\/([\w-]+)$/.exec(p)) && m === 'GET') {
      const inv = db.invites[match[1]];
      if (!inv || inv.expires < Date.now()) return send(res, 200, page('login.html', { MODE: 'expired', INVITER: '' }), MIME['.html']);
      const by = db.users[inv.createdBy];
      return send(res, 200, page('login.html', { MODE: 'invite', INVITER: escapeHtml(by ? by.name : 'Your team') }), MIME['.html']);
    }
    if ((match = /^\/api\/invite\/([\w-]+)$/.exec(p)) && m === 'POST') {
      const inv = db.invites[match[1]];
      if (!inv || inv.expires < Date.now()) return json(res, 410, { error: 'This invite link has expired. Ask for a new one.' });
      const body = await readJson(req);
      const v = validateNewUser(body);
      if (v.error) return json(res, 400, v);
      const user = addUser(v, inv.role === 'owner' ? 'owner' : 'member');
      delete db.invites[match[1]]; saveDb();
      createSession(req, res, user);
      return json(res, 200, { ok: true });
    }

    // ---------- sign in / first time setup ----------
    if (m === 'GET' && p === '/setup') {
      if (hasUsers()) return redirect(res, '/login');
      return send(res, 200, page('login.html', { MODE: 'setup', INVITER: '' }), MIME['.html']);
    }
    if (m === 'POST' && p === '/api/setup') {
      if (hasUsers()) return json(res, 403, { error: 'Setup is already done' });
      const body = await readJson(req);
      const v = validateNewUser(body);
      if (v.error) return json(res, 400, v);
      const user = addUser(v, 'owner');
      // Videos recorded before logins existed now belong to the owner
      for (const vid of Object.values(db.videos)) if (!vid.ownerId) vid.ownerId = user.id;
      createSession(req, res, user);
      return json(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/login') {
      if (!hasUsers()) return redirect(res, '/setup');
      if (currentUser(req)) return redirect(res, '/');
      return send(res, 200, page('login.html', { MODE: 'login', INVITER: '' }), MIME['.html']);
    }
    if (m === 'POST' && p === '/api/login') {
      const ip = clientIp(req);
      if (tooManyFails(ip)) return json(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
      const body = await readJson(req);
      const user = findUserByEmail(body.email || '');
      if (!user || !checkPassword(user, body.password || '')) {
        noteFail(ip);
        return json(res, 401, { error: 'Wrong email or password' });
      }
      loginFails.delete(ip);
      createSession(req, res, user);
      return json(res, 200, { ok: true });
    }
    if (p === '/logout') { clearSession(req, res); return redirect(res, '/login'); }

    // ---------- everything below needs a signed in user ----------
    const user = currentUser(req);
    if (!user) {
      if (p.startsWith('/api/')) return json(res, 401, { error: 'Please sign in' });
      return redirect(res, hasUsers() ? '/login' : '/setup');
    }

    if (m === 'GET' && p === '/') return send(res, 200, page('app.html'), MIME['.html']);
    if (m === 'GET' && p === '/team') return send(res, 200, page('team.html'), MIME['.html']);
    if (m === 'GET' && (p === '/library' || p === '/account' || p === '/record')) return redirect(res, p === '/account' ? '/team' : p === '/record' ? '/?record=1' : '/');
    if (m === 'GET' && p === '/api/me') return json(res, 200, publicUser(user));

    if (m === 'POST' && p === '/api/me/password') {
      const body = await readJson(req);
      if (!checkPassword(user, body.current || '')) return json(res, 400, { error: 'Current password is wrong' });
      if (String(body.next || '').length < 8) return json(res, 400, { error: 'New password must be at least 8 characters' });
      Object.assign(user, hashPassword(body.next));
      endSessionsFor(user.id, parseCookies(req).sid);
      saveDb();
      return json(res, 200, { ok: true });
    }

    // Invites (owner only)
    if (p === '/api/invites' || p.startsWith('/api/invites/')) {
      if (user.role !== 'owner') return json(res, 403, { error: 'Only admins can invite people' });
      for (const [t, inv] of Object.entries(db.invites)) if (inv.expires < Date.now()) delete db.invites[t];
      if (m === 'GET' && p === '/api/invites') {
        return json(res, 200, Object.entries(db.invites).map(([token, inv]) => ({ token, role: inv.role, expires: inv.expires, url: `${baseUrl(req)}/invite/${token}` })));
      }
      if (m === 'POST' && p === '/api/invites') {
        const body = await readJson(req);
        const token = crypto.randomBytes(18).toString('base64url');
        db.invites[token] = { role: body.role === 'owner' ? 'owner' : 'member', createdBy: user.id, expires: Date.now() + 7 * 864e5 };
        saveDb();
        return json(res, 200, { token, role: db.invites[token].role, expires: db.invites[token].expires, url: `${baseUrl(req)}/invite/${token}` });
      }
      if (m === 'DELETE' && (match = /^\/api\/invites\/([\w-]+)$/.exec(p))) {
        delete db.invites[match[1]]; saveDb();
        return json(res, 200, { ok: true });
      }
    }

    // Team management (owner only)
    if (p === '/api/users' || p.startsWith('/api/users/')) {
      if (user.role !== 'owner') return json(res, 403, { error: 'Only the owner can manage the team' });
      if (m === 'GET' && p === '/api/users') {
        const counts = {};
        for (const v of Object.values(db.videos)) counts[v.ownerId] = (counts[v.ownerId] || 0) + 1;
        return json(res, 200, Object.values(db.users)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map(u => ({ ...publicUser(u), videos: counts[u.id] || 0 })));
      }
      if (m === 'POST' && p === '/api/users') {
        const body = await readJson(req);
        const v = validateNewUser(body);
        if (v.error) return json(res, 400, v);
        return json(res, 200, publicUser(addUser(v, body.role === 'owner' ? 'owner' : 'member')));
      }
      if ((match = /^\/api\/users\/([\w-]+)(\/password)?$/.exec(p))) {
        const target = db.users[match[1]];
        if (!target) return json(res, 404, { error: 'Not found' });
        if (m === 'POST' && match[2]) {
          const body = await readJson(req);
          if (String(body.password || '').length < 8) return json(res, 400, { error: 'Password must be at least 8 characters' });
          Object.assign(target, hashPassword(body.password));
          endSessionsFor(target.id);
          saveDb();
          return json(res, 200, { ok: true });
        }
        if (m === 'DELETE') {
          if (target.id === user.id) return json(res, 400, { error: "You can't remove yourself" });
          // Their videos move to the owner doing the removal, so share links keep working
          for (const v of Object.values(db.videos)) if (v.ownerId === target.id) v.ownerId = user.id;
          endSessionsFor(target.id);
          delete db.users[target.id];
          saveDb();
          return json(res, 200, { ok: true });
        }
      }
    }

    if (m === 'GET' && p === '/api/videos') {
      const all = user.role === 'owner' && url.searchParams.get('scope') === 'all';
      const list = Object.values(db.videos)
        .filter(v => all || v.ownerId === user.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicVideo);
      return json(res, 200, list);
    }
    if (m === 'POST' && p === '/api/videos') return handleUpload(req, res, url.searchParams, user);
    if ((match = /^\/api\/videos\/([\w-]+)$/.exec(p))) {
      const v = db.videos[match[1]];
      if (!v) return json(res, 404, { error: 'Not found' });
      if (!canEdit(user, v)) return json(res, 403, { error: 'Not your video' });
      if (m === 'PATCH') {
        const body = await readJson(req);
        if (typeof body.title === 'string' && body.title.trim()) v.title = body.title.trim().slice(0, 200);
        saveDb();
        return json(res, 200, publicVideo(v));
      }
      if (m === 'DELETE') {
        for (const f of [v.original, v.mp4, v.thumb]) if (f) {
          rmLocal(f);
          if (storage.enabled) storage.remove(f).catch(e => console.error('Could not delete from cloud storage:', e.message));
        }
        delete db.videos[match[1]];
        saveDb();
        return json(res, 200, { ok: true });
      }
    }
    send(res, 404, 'Not found');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, 'Server error');
  }
});

setInterval(() => {
  let changed = false;
  for (const [t, ses] of Object.entries(db.sessions)) if (ses.expires < Date.now()) { delete db.sessions[t]; changed = true; }
  if (changed) saveDb();
}, 3600e3).unref();

server.requestTimeout = 0; // allow long uploads

async function start() {
  if (storage.enabled) {
    try {
      const saved = await storage.getBuffer('db.json');
      if (saved) { db = JSON.parse(saved.toString('utf8')); normalizeDb(); console.log('Loaded data from cloud storage.'); }
      else console.log('Cloud storage is connected and empty. Starting fresh.');
    } catch (e) {
      // Refuse to start rather than overwrite good data with an empty database
      console.error('Could not read cloud storage. Check the S3_* settings.', e.message);
      process.exit(1);
    }
  }
  // Pick up videos that were still being processed when the server last stopped
  for (const v of Object.values(db.videos)) if (v.status === 'processing') enqueue(v.id);
  listen();
}

// Save the database before the host shuts the app down
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (storage.enabled) await pushDb(0);
    process.exit(0);
  });
}

start();
function listen() { server.listen(PORT, () => {
  console.log(`${APP_NAME} running at http://localhost:${PORT}`);
  console.log(HAS_FFMPEG ? 'ffmpeg found: videos will be converted to mp4 with thumbnails.' : 'ffmpeg not found: videos are kept as recorded (install ffmpeg for mp4 + thumbnails).');
  console.log(storage.enabled ? 'Videos and data are saved to cloud storage.' : 'Videos and data are saved on this computer in ' + DATA_DIR);
  if (!hasUsers()) console.log(`First time? Open http://localhost:${PORT} to create your owner account.`);
}); }
