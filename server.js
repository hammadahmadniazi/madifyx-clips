// Madifyx Clips: a small self-hosted screen recorder with share links.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { storage } = require('./storage');
const { sendMail, verificationEmail, mailReady } = require('./mailer');
const billing = require('./billing');

const PORT = process.env.PORT || 3000;
const APP_NAME = process.env.APP_NAME || 'Madifyx Clips';
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
// When set, only this email can create the owner account, and it is always an owner.
const OWNER_EMAIL = String(process.env.OWNER_EMAIL || '').trim().toLowerCase();
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
db.videos ||= {}; db.users ||= {}; db.sessions ||= {}; db.invites ||= {}; db.settings ||= {}; db.pending ||= {}; db.workspaces ||= {};
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
function normalizeDb() { db.videos ||= {}; db.users ||= {}; db.sessions ||= {}; db.invites ||= {}; db.settings ||= {}; db.pending ||= {}; db.workspaces ||= {}; }
// ---------- workspaces and plans ----------
// Every account belongs to one workspace. Each customer's workspace is private:
// they only ever see their own people and videos.
const PLANS = {
  free: { key: 'free', name: 'Free', maxVideos: Number(process.env.FREE_MAX_VIDEOS || 25), maxSeconds: Number(process.env.FREE_MAX_SECONDS || 300), team: false, branding: true },
  pro: { key: 'pro', name: 'Pro', maxVideos: null, maxSeconds: null, team: true, branding: false },
};
const activeStatus = s => ['active', 'trialing', 'past_due'].includes(s);
const planOf = ws => (ws && (ws.comp || activeStatus(ws.subStatus)) ? PLANS.pro : PLANS.free);
const wsOf = user => user && db.workspaces[user.workspaceId];
const wsVideoCount = wsId => Object.values(db.videos).filter(v => v.workspaceId === wsId).length;
function createWorkspace(name, ownerId, extra = {}) {
  const id = crypto.randomBytes(8).toString('base64url');
  db.workspaces[id] = { id, name: String(name).slice(0, 80), ownerId, createdAt: new Date().toISOString(), comp: false, subStatus: null, ...extra };
  saveDb();
  return db.workspaces[id];
}
function workspaceInfo(ws) {
  const plan = planOf(ws);
  return {
    id: ws.id, name: ws.name, plan: plan.key, planName: ws.comp ? 'Free forever' : plan.name, comp: !!ws.comp,
    subStatus: ws.subStatus || null, hasBilling: !!ws.stripeCustomerId,
    limits: { maxVideos: plan.maxVideos, maxSeconds: plan.maxSeconds, team: plan.team, branding: plan.branding },
    usage: { videos: wsVideoCount(ws.id) },
  };
}
// Older data (before workspaces) moves into one home workspace that is free forever.
function migrateWorkspaces() {
  const users = Object.values(db.users);
  if (!users.length) return;
  let home = db.settings.homeWorkspace && db.workspaces[db.settings.homeWorkspace];
  const needs = users.some(u => !u.workspaceId || !db.workspaces[u.workspaceId]);
  if (!needs && home) return;
  if (!home) {
    const owner = users.find(u => u.email === OWNER_EMAIL) || users.find(u => u.role === 'owner') || users[0];
    home = createWorkspace(process.env.HOME_WORKSPACE_NAME || 'Madifyx', owner.id, { comp: true });
    db.settings.homeWorkspace = home.id;
  }
  for (const u of users) if (!u.workspaceId || !db.workspaces[u.workspaceId]) u.workspaceId = home.id;
  for (const v of Object.values(db.videos)) if (!v.workspaceId) v.workspaceId = (db.users[v.ownerId] || {}).workspaceId || home.id;
  for (const inv of Object.values(db.invites)) if (!inv.workspaceId) inv.workspaceId = home.id;
  saveDb();
  console.log('Moved existing accounts into the "' + home.name + '" workspace (free forever).');
}
// The platform admin (you) can see all workspaces and give any of them free access
const isPlatformAdmin = u => !!u && (OWNER_EMAIL ? u.email === OWNER_EMAIL : (u.role === 'owner' && u.workspaceId === db.settings.homeWorkspace));

// Make sure the owner email always has owner rights
function applyOwnerEmail() {
  if (!OWNER_EMAIL) return;
  const u = Object.values(db.users).find(x => x.email === OWNER_EMAIL);
  if (u && u.role !== 'owner') { u.role = 'owner'; saveDb(); console.log(`${OWNER_EMAIL} is now an owner.`); }
}

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
function brandingFor(v) {
  const ws = db.workspaces[v.workspaceId];
  const plan = planOf(ws);
  return { branding: plan.branding, workspaceName: plan.branding ? null : (ws ? ws.name : null) };
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
    const trim = v.limitSeconds ? ['-t', String(v.limitSeconds)] : [];
    await runFfmpeg(['-i', input, ...trim, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-threads', '2',
      '-pix_fmt', 'yuv420p', '-vf', "scale='min(iw,1920)':'min(ih,1920)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2",
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
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
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
function addUser({ name, email, password, salt: s0, hash: h0 }, role, workspaceId) {
  const id = crypto.randomBytes(8).toString('base64url');
  const { salt, hash } = s0 && h0 ? { salt: s0, hash: h0 } : hashPassword(password);
  db.users[id] = { id, name, email, role, salt, hash, workspaceId, createdAt: new Date().toISOString() };
  saveDb();
  return db.users[id];
}
const baseUrl = req => `${req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')}://${req.headers.host}`;
const redirect = (res, to) => { res.writeHead(302, { Location: to }); res.end(); };
const canEdit = (user, v) => v.workspaceId === user.workspaceId && (user.role === 'owner' || v.ownerId === user.id);

// A fingerprint of the app's files. It changes with every update, so browsers
// always load the newest styles and scripts instead of an old saved copy.
const ASSET_VERSION = (() => {
  const h = crypto.createHash('sha1');
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).forEach(e => {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f); else h.update(e.name).update(fs.readFileSync(f));
  });
  walk(path.join(__dirname, 'public'));
  return h.digest('hex').slice(0, 10);
})();

function page(file, vars = {}) {
  let html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8').replaceAll('{{APP_NAME}}', escapeHtml(APP_NAME));
  for (const [k, v] of Object.entries(vars)) html = html.replaceAll(`{{${k}}}`, v);
  html = html.replace(/{{[A-Z_]+}}/g, '');
  return html.replace(/(["'(])\/static\/([\w./-]+\.(?:css|js|png|svg))(?=["')])/g, `$1/static/$2?v=${ASSET_VERSION}`);
}
// Public sign ups (new customers get their own workspace) need email verification,
// so they only work once email sending is set up. The platform admin switches them on or off.
const signupOpen = () => !!db.settings.openSignup && mailReady();

// ---------- email verification ----------
// New accounts wait here until the person enters the code from their email
// (or clicks the link). Nothing is created for an email its owner never confirmed.
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const PENDING_MINUTES = 30;
async function startVerification(req, v, role, inviteToken, joinWorkspaceId) {
  for (const [k, pend] of Object.entries(db.pending)) if (pend.email === v.email || pend.expires < Date.now()) delete db.pending[k];
  const { salt, hash } = hashPassword(v.password);
  const pend = {
    id: crypto.randomBytes(18).toString('base64url'),
    linkToken: crypto.randomBytes(24).toString('base64url'),
    name: v.name, email: v.email, salt, hash, role, inviteToken: inviteToken || null, joinWorkspaceId: joinWorkspaceId || null,
    expires: Date.now() + PENDING_MINUTES * 60e3, attempts: 0, sends: 0, sentAt: 0,
  };
  db.pending[pend.id] = pend;
  await sendCode(req, pend);
  saveDb();
  return pend;
}
async function sendCode(req, pend) {
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  pend.codeHash = sha(pend.id + code); pend.attempts = 0; pend.sends++; pend.sentAt = Date.now();
  pend.expires = Date.now() + PENDING_MINUTES * 60e3;
  const base = baseUrl(req);
  const mail = verificationEmail({ appName: APP_NAME, name: pend.name, code, link: `${base}/verify/${pend.linkToken}`, logoUrl: `${base}/static/brand/logo.png` });
  await sendMail({ to: pend.email, ...mail });
}
function finishVerification(req, res, pend) {
  delete db.pending[pend.id];
  if (findUserByEmail(pend.email)) { saveDb(); return { error: 'That email already has an account. Sign in instead.' }; }
  let role = pend.role, wsId = pend.joinWorkspaceId;
  if (pend.inviteToken) {
    const inv = db.invites[pend.inviteToken];
    if (!inv || inv.expires < Date.now()) { saveDb(); return { error: 'This invite has expired. Ask for a new one.' }; }
    delete db.invites[pend.inviteToken];
    wsId = inv.workspaceId;
  }
  if (wsId && (!db.workspaces[wsId] || !planOf(db.workspaces[wsId]).team)) { saveDb(); return { error: "This team can't add people right now. Ask its admin." }; }
  const user = addUser({ name: pend.name, email: pend.email, salt: pend.salt, hash: pend.hash }, role, wsId || null);
  if (!wsId) {
    // A new customer: their own private workspace, on the Free plan
    const ws = createWorkspace(`${pend.name.split(' ')[0]}'s workspace`, user.id);
    user.workspaceId = ws.id; user.role = 'owner';
  }
  if (pend.email === OWNER_EMAIL && user.workspaceId === db.settings.homeWorkspace) user.role = 'owner';
  saveDb();
  createSession(req, res, user);
  return { user };
}

// ---------- upload ----------
function handleUpload(req, res, query, user) {
  const ws = wsOf(user), plan = planOf(ws);
  if (plan.maxVideos !== null && wsVideoCount(ws.id) >= plan.maxVideos) {
    req.resume();
    return json(res, 402, { error: `You've used all ${plan.maxVideos} videos on the Free plan. Upgrade for unlimited videos, or delete old ones.`, upgrade: true });
  }
  const mime = String(req.headers['content-type'] || 'video/webm').split(';')[0];
  const ext = mime.includes('mp4') || mime.includes('m4v') ? 'mp4' : mime.includes('quicktime') ? 'mov' : 'webm';
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
      id, title, original, mime, sizeBytes: bytes, ownerId: user.id, workspaceId: ws.id,
      limitSeconds: plan.maxSeconds || null,
      createdAt: new Date().toISOString(),
      duration: Number.isFinite(duration) ? (plan.maxSeconds ? Math.min(duration, plan.maxSeconds) : duration) : null,
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

    // ---------- Stripe tells us about payments here (signed, so it can't be faked) ----------
    if (m === 'POST' && p === '/api/stripe/webhook') {
      const chunks = [];
      for await (const c of req) { chunks.push(c); if (chunks.length > 2000) break; }
      let event;
      try { event = billing.verifyWebhook(Buffer.concat(chunks).toString('utf8'), req.headers['stripe-signature']); }
      catch (e) { console.error('Stripe webhook rejected:', e.message); return json(res, 400, { error: e.message }); }
      try { await handleStripeEvent(event); } catch (e) { console.error('Stripe webhook failed:', e.message); return json(res, 500, { error: 'Failed' }); }
      return json(res, 200, { received: true });
    }

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
    if ((m === 'GET' || m === 'HEAD') && p.startsWith('/static/')) {
      // Versioned links (?v=...) can be kept for a year; anything else is checked every time
      if (url.searchParams.get('v') === ASSET_VERSION) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return serveFile(req, res, PUBLIC_DIR, p.slice(8), url.searchParams.has('v') ? 31536000 : 0);
    }

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
      return json(res, 200, { ...publicVideo(v), ...brandingFor(v), canEdit: !!(me && canEdit(me, v)), me: me && me.workspaceId === v.workspaceId ? { id: me.id, name: me.name, role: me.role } : null });
    }
    if (m === 'POST' && (match = /^\/api\/videos\/([\w-]+)\/view$/.exec(p))) {
      const v = db.videos[match[1]];
      if (!v) return json(res, 404, { error: 'Not found' });
      v.views = (v.views || 0) + 1; saveDb();
      return json(res, 200, { views: v.views });
    }
    if (m === 'GET' && p === '/api/config') return json(res, 200, { appName: APP_NAME, ffmpeg: HAS_FFMPEG });
    // Plans shown on the public homepage
    if (m === 'GET' && p === '/api/pricing') {
      return json(res, 200, { price: await billing.priceLabel(), signupOpen: signupOpen(),
        free: { maxVideos: PLANS.free.maxVideos, maxSeconds: PLANS.free.maxSeconds } });
    }

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
      return send(res, 200, page('login.html', { MODE: 'invite' }), MIME['.html']);
    }
    if ((match = /^\/api\/invite\/([\w-]+)$/.exec(p)) && m === 'POST') {
      const inv = db.invites[match[1]];
      if (!inv || inv.expires < Date.now()) return json(res, 410, { error: 'This invite link has expired. Ask for a new one.' });
      const body = await readJson(req);
      const v = validateNewUser(body);
      if (v.error) return json(res, 400, v);
      const role = inv.role === 'owner' ? 'owner' : 'member';
      if (!db.workspaces[inv.workspaceId] || !planOf(db.workspaces[inv.workspaceId]).team) return json(res, 403, { error: "This team can't add people right now. Ask its admin." });
      if (mailReady()) {
        if (limited('j:' + clientIp(req), 10, 60 * 60e3)) return json(res, 429, { error: 'Too many sign ups from here. Try again later.' });
        try { const pend = await startVerification(req, v, role, match[1]); return json(res, 200, { verify: true, id: pend.id, email: pend.email }); }
        catch (e) { console.error('Could not send verification email:', e.message); return json(res, 502, { error: "We couldn't send the verification email. Try again in a minute." }); }
      }
      const user = addUser(v, role, inv.workspaceId);
      delete db.invites[match[1]]; saveDb();
      createSession(req, res, user);
      return json(res, 200, { ok: true });
    }

    // ---------- public sign up at /signup: new customers get their own free workspace ----------
    if (m === 'GET' && p === '/signup') {
      if (!hasUsers()) return redirect(res, '/setup');
      if (currentUser(req)) return redirect(res, '/');
      return send(res, 200, page('login.html', { MODE: signupOpen() ? 'signup' : 'closed' }), MIME['.html']);
    }
    // ---------- team join link: joins an existing (paid) workspace ----------
    if ((match = /^\/join\/([\w-]+)$/.exec(p)) && m === 'GET') {
      const ws = Object.values(db.workspaces).find(w => w.joinCode && w.joinCode === match[1]);
      if (!ws || !planOf(ws).team) return send(res, 200, page('login.html', { MODE: 'expired' }), MIME['.html']);
      return send(res, 200, page('login.html', { MODE: 'invite' }), MIME['.html']);
    }
    if ((match = /^\/api\/join\/([\w-]+)$/.exec(p)) && m === 'POST') {
      const ws = Object.values(db.workspaces).find(w => w.joinCode && w.joinCode === match[1]);
      if (!ws || !planOf(ws).team) return json(res, 410, { error: 'This join link is no longer active. Ask your admin for a new one.' });
      if (!mailReady()) return json(res, 503, { error: 'Email verification is not set up yet. Ask your admin for an invite.' });
      if (limited('j:' + clientIp(req), 10, 60 * 60e3)) return json(res, 429, { error: 'Too many sign ups from here. Try again later.' });
      const body = await readJson(req);
      const v = validateNewUser(body);
      if (v.error) return json(res, 400, v);
      try { const pend = await startVerification(req, v, 'member', null, ws.id); return json(res, 200, { verify: true, id: pend.id, email: pend.email }); }
      catch (e) { console.error('Could not send verification email:', e.message); return json(res, 502, { error: "We couldn't send the verification email. Try again in a minute." }); }
    }
    if (m === 'POST' && p === '/api/signup') {
      if (!signupOpen()) return json(res, 403, { error: 'Sign ups are closed. Ask your admin for an invite.' });
      if (limited('j:' + clientIp(req), 10, 60 * 60e3)) return json(res, 429, { error: 'Too many sign ups from here. Try again later.' });
      const body = await readJson(req);
      const v = validateNewUser(body);
      if (v.error) return json(res, 400, v);
      try { const pend = await startVerification(req, v, 'owner'); return json(res, 200, { verify: true, id: pend.id, email: pend.email }); }
      catch (e) { console.error('Could not send verification email:', e.message); return json(res, 502, { error: "We couldn't send the verification email. Try again in a minute." }); }
    }

    // ---------- confirm email: by code, by link, or ask for a new code ----------
    if (m === 'POST' && p === '/api/verify') {
      const body = await readJson(req);
      const pend = db.pending[String(body.id || '')];
      if (!pend || pend.expires < Date.now()) return json(res, 410, { error: 'This code has expired. Start again to get a new one.' });
      if (pend.attempts >= 5) return json(res, 429, { error: 'Too many wrong codes. Ask for a new code.' });
      const code = String(body.code || '').replace(/\D/g, '');
      if (sha(pend.id + code) !== pend.codeHash) { pend.attempts++; saveDb(); return json(res, 400, { error: `That code isn't right. ${5 - pend.attempts} tries left.` }); }
      const r = finishVerification(req, res, pend);
      return r.error ? json(res, 409, r) : json(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/verify/resend') {
      const body = await readJson(req);
      const pend = db.pending[String(body.id || '')];
      if (!pend || pend.expires < Date.now()) return json(res, 410, { error: 'This sign up has expired. Start again.' });
      if (pend.sends >= 5) return json(res, 429, { error: 'Too many codes sent. Start again in a while.' });
      const wait = Math.ceil((pend.sentAt + 60e3 - Date.now()) / 1000);
      if (wait > 0) return json(res, 429, { error: `Wait ${wait} seconds before asking for a new code.` });
      try { await sendCode(req, pend); saveDb(); return json(res, 200, { ok: true }); }
      catch (e) { console.error('Could not send verification email:', e.message); return json(res, 502, { error: "We couldn't send the email. Try again in a minute." }); }
    }
    if (m === 'GET' && (match = /^\/verify\/([\w-]+)$/.exec(p))) {
      const pend = Object.values(db.pending).find(x => x.linkToken === match[1]);
      if (!pend || pend.expires < Date.now()) return send(res, 200, page('login.html', { MODE: 'expired' }), MIME['.html']);
      const r = finishVerification(req, res, pend);
      return r.error ? send(res, 200, page('login.html', { MODE: 'expired' }), MIME['.html']) : redirect(res, '/');
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
      if (OWNER_EMAIL && v.email !== OWNER_EMAIL) return json(res, 403, { error: 'This workspace is reserved for its owner. Use the owner email to set it up.' });
      const user = addUser(v, 'owner', null);
      const home = createWorkspace(process.env.HOME_WORKSPACE_NAME || 'Madifyx', user.id, { comp: true });
      user.workspaceId = home.id; db.settings.homeWorkspace = home.id;
      // Videos recorded before logins existed now belong to the owner
      for (const vid of Object.values(db.videos)) { if (!vid.ownerId) vid.ownerId = user.id; if (!vid.workspaceId) vid.workspaceId = home.id; }
      saveDb();
      createSession(req, res, user);
      return json(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/login') {
      if (!hasUsers()) return redirect(res, '/setup');
      if (currentUser(req)) return redirect(res, '/');
      return send(res, 200, page('login.html', { MODE: 'login', SIGNUP: signupOpen() ? '1' : '' }), MIME['.html']);
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
      // Visitors who aren't signed in see the public homepage
      if (m === 'GET' && (p === '/' || p === '/pricing' || p === '/home') && hasUsers()) return send(res, 200, page('home.html', { OG_URL: escapeHtml(baseUrl(req) + '/'), OG_IMAGE: escapeHtml(baseUrl(req) + '/static/brand/logo.png') }), MIME['.html']);
      return redirect(res, hasUsers() ? '/login' : '/setup');
    }

    if (m === 'GET' && p === '/') return send(res, 200, page('app.html'), MIME['.html']);
    if (m === 'GET' && p === '/pricing') return redirect(res, '/team#billing');
    if (m === 'GET' && p === '/home') return send(res, 200, page('home.html', { OG_URL: escapeHtml(baseUrl(req) + '/'), OG_IMAGE: escapeHtml(baseUrl(req) + '/static/brand/logo.png') }), MIME['.html']);
    if (m === 'GET' && p === '/team') return send(res, 200, page('team.html'), MIME['.html']);
    if (m === 'GET' && p === '/admin') return isPlatformAdmin(user) ? send(res, 200, page('admin.html'), MIME['.html']) : redirect(res, '/');
    if (m === 'GET' && (p === '/library' || p === '/account' || p === '/record')) return redirect(res, p === '/account' ? '/team' : p === '/record' ? '/?record=1' : '/');
    if (m === 'GET' && p === '/api/me') {
      return json(res, 200, { ...publicUser(user), workspace: workspaceInfo(wsOf(user)), isAdmin: isPlatformAdmin(user),
        billing: { ready: billing.billingReady(), price: await billing.priceLabel() } });
    }
    if (m === 'PATCH' && p === '/api/workspace') {
      if (user.role !== 'owner') return json(res, 403, { error: 'Only admins can rename the workspace' });
      const body = await readJson(req);
      const name = String(body.name || '').trim().slice(0, 80);
      if (!name) return json(res, 400, { error: "The workspace name can't be empty" });
      wsOf(user).name = name; saveDb();
      return json(res, 200, workspaceInfo(wsOf(user)));
    }

    // ---------- billing (workspace admins) ----------
    if (p.startsWith('/api/billing/')) {
      const ws = wsOf(user);
      if (user.role !== 'owner') return json(res, 403, { error: 'Only workspace admins can manage billing' });
      if (!billing.billingReady()) return json(res, 503, { error: 'Payments are not set up yet.' });
      const base = baseUrl(req);
      try {
        if (m === 'POST' && p === '/api/billing/checkout') {
          if (ws.comp) return json(res, 400, { error: 'This workspace already has free access to everything.' });
          if (activeStatus(ws.subStatus)) return json(res, 400, { error: 'You already have the paid plan. Use Manage billing to change it.' });
          const s = await billing.createCheckout({ workspaceId: ws.id, email: user.email, customerId: ws.stripeCustomerId,
            successUrl: `${base}/team?billing=success&session_id={CHECKOUT_SESSION_ID}`, cancelUrl: `${base}/team?billing=cancelled` });
          return json(res, 200, { url: s.url });
        }
        if (m === 'POST' && p === '/api/billing/portal') {
          if (!ws.stripeCustomerId) return json(res, 400, { error: 'There is no billing account yet. Upgrade first.' });
          const s = await billing.createPortal({ customerId: ws.stripeCustomerId, returnUrl: `${base}/team` });
          return json(res, 200, { url: s.url });
        }
        if (m === 'POST' && p === '/api/billing/sync') {
          // Called when someone comes back from Stripe, so the plan updates even before the webhook arrives
          const body = await readJson(req);
          if (body.sessionId) {
            const cs = await billing.getCheckout(String(body.sessionId));
            if (cs.client_reference_id !== ws.id) return json(res, 403, { error: 'That payment belongs to another workspace' });
            ws.stripeCustomerId = cs.customer || ws.stripeCustomerId;
            if (cs.subscription) { const sub = await billing.getSubscription(cs.subscription); ws.stripeSubId = sub.id; ws.subStatus = sub.status; }
          } else if (ws.stripeCustomerId) {
            const subs = await billing.listSubscriptions(ws.stripeCustomerId);
            const sub = (subs.data || [])[0];
            if (sub) { ws.stripeSubId = sub.id; ws.subStatus = sub.status; }
          }
          saveDb();
          return json(res, 200, workspaceInfo(ws));
        }
      } catch (e) {
        console.error('Stripe error:', e.message);
        return json(res, 502, { error: "Couldn't reach Stripe. Try again in a minute." });
      }
    }

    // ---------- platform admin (you): every workspace ----------
    if (p.startsWith('/api/admin/')) {
      if (!isPlatformAdmin(user)) return json(res, 403, { error: 'Admins only' });
      if (m === 'GET' && p === '/api/admin/workspaces') {
        const members = {}, vids = {};
        for (const u of Object.values(db.users)) (members[u.workspaceId] ||= []).push(u);
        for (const v of Object.values(db.videos)) vids[v.workspaceId] = (vids[v.workspaceId] || 0) + 1;
        const list = Object.values(db.workspaces).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(w => {
          const owner = db.users[w.ownerId];
          return { id: w.id, name: w.name, createdAt: w.createdAt, owner: owner ? { name: owner.name, email: owner.email } : null,
            members: (members[w.id] || []).length, videos: vids[w.id] || 0, plan: planOf(w).key, comp: !!w.comp, subStatus: w.subStatus || null,
            home: w.id === db.settings.homeWorkspace };
        });
        return json(res, 200, list);
      }
      if (m === 'POST' && (match = /^\/api\/admin\/workspaces\/([\w-]+)$/.exec(p))) {
        const w = db.workspaces[match[1]];
        if (!w) return json(res, 404, { error: 'Not found' });
        const body = await readJson(req);
        if (w.id === db.settings.homeWorkspace && !body.comp) return json(res, 400, { error: 'Your own workspace always stays free.' });
        w.comp = !!body.comp; saveDb();
        return json(res, 200, { ok: true, plan: planOf(w).key });
      }
      if (p === '/api/admin/settings') {
        if (m === 'POST') {
          const body = await readJson(req);
          if (body.openSignup && !mailReady()) return json(res, 400, { error: 'Set up email sending first, so new accounts can confirm their email.' });
          db.settings.openSignup = !!body.openSignup; saveDb();
        }
        return json(res, 200, { openSignup: signupOpen(), emailReady: mailReady(), billingReady: billing.billingReady(), signupUrl: `${baseUrl(req)}/signup` });
      }
    }

    if (m === 'POST' && p === '/api/me/password') {
      const body = await readJson(req);
      if (!checkPassword(user, body.current || '')) return json(res, 400, { error: 'Current password is wrong' });
      if (String(body.next || '').length < 8) return json(res, 400, { error: 'New password must be at least 8 characters' });
      Object.assign(user, hashPassword(body.next));
      endSessionsFor(user.id, parseCookies(req).sid);
      saveDb();
      return json(res, 200, { ok: true });
    }

    // Your profile
    if (m === 'PATCH' && p === '/api/me') {
      const body = await readJson(req);
      const name = String(body.name || '').trim().slice(0, 80);
      if (!name) return json(res, 400, { error: "Your name can't be empty" });
      user.name = name; saveDb();
      return json(res, 200, publicUser(user));
    }

    // Team join link for this workspace (paid plans)
    if (p === '/api/join-link') {
      const ws = wsOf(user);
      if (user.role !== 'owner') return json(res, 403, { error: 'Only admins can manage the join link' });
      if (m !== 'GET' && !planOf(ws).team) return json(res, 402, { error: 'Upgrade to add teammates.', upgrade: true });
      if (m === 'POST') { ws.joinCode = crypto.randomBytes(9).toString('base64url'); saveDb(); }
      if (m === 'DELETE') { ws.joinCode = null; saveDb(); }
      return json(res, 200, { enabled: !!ws.joinCode && planOf(ws).team, url: ws.joinCode ? `${baseUrl(req)}/join/${ws.joinCode}` : null, emailReady: mailReady() });
    }

    // Invites (owner only)
    if (p === '/api/invites' || p.startsWith('/api/invites/')) {
      if (user.role !== 'owner') return json(res, 403, { error: 'Only admins can invite people' });
      for (const [t, inv] of Object.entries(db.invites)) if (inv.expires < Date.now()) delete db.invites[t];
      if (m === 'GET' && p === '/api/invites') {
        return json(res, 200, Object.entries(db.invites).filter(([, inv]) => inv.workspaceId === user.workspaceId).map(([token, inv]) => ({ token, role: inv.role, expires: inv.expires, url: `${baseUrl(req)}/invite/${token}` })));
      }
      if (m === 'POST' && p === '/api/invites') {
        if (!planOf(wsOf(user)).team) return json(res, 402, { error: 'Upgrade to add teammates.', upgrade: true });
        const body = await readJson(req);
        const token = crypto.randomBytes(18).toString('base64url');
        db.invites[token] = { role: body.role === 'owner' ? 'owner' : 'member', createdBy: user.id, workspaceId: user.workspaceId, expires: Date.now() + 7 * 864e5 };
        saveDb();
        return json(res, 200, { token, role: db.invites[token].role, expires: db.invites[token].expires, url: `${baseUrl(req)}/invite/${token}` });
      }
      if (m === 'DELETE' && (match = /^\/api\/invites\/([\w-]+)$/.exec(p))) {
        if (db.invites[match[1]] && db.invites[match[1]].workspaceId === user.workspaceId) delete db.invites[match[1]];
        saveDb();
        return json(res, 200, { ok: true });
      }
    }

    // Team management (owner only)
    if (p === '/api/users' || p.startsWith('/api/users/')) {
      if (user.role !== 'owner') return json(res, 403, { error: 'Only the owner can manage the team' });
      if (m === 'GET' && p === '/api/users') {
        const counts = {};
        for (const v of Object.values(db.videos)) counts[v.ownerId] = (counts[v.ownerId] || 0) + 1;
        return json(res, 200, Object.values(db.users).filter(u => u.workspaceId === user.workspaceId)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map(u => ({ ...publicUser(u), videos: counts[u.id] || 0 })));
      }
      if ((match = /^\/api\/users\/([\w-]+)(\/password)?$/.exec(p))) {
        const target = db.users[match[1]];
        if (!target || target.workspaceId !== user.workspaceId) return json(res, 404, { error: 'Not found' });
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
          if (target.id === wsOf(user).ownerId) return json(res, 400, { error: "The workspace creator can't be removed" });
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
        .filter(v => v.workspaceId === user.workspaceId && (all || v.ownerId === user.id))
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

// Keeps each workspace's plan in step with Stripe
async function handleStripeEvent(event) {
  const o = event.data && event.data.object || {};
  if (event.type === 'checkout.session.completed') {
    const ws = db.workspaces[o.client_reference_id || (o.metadata || {}).workspace_id];
    if (!ws) return;
    ws.stripeCustomerId = o.customer || ws.stripeCustomerId;
    if (o.subscription) {
      ws.stripeSubId = o.subscription;
      try { ws.subStatus = (await billing.getSubscription(o.subscription)).status; } catch (e) { ws.subStatus = 'active'; }
    }
    saveDb();
  } else if (event.type.startsWith('customer.subscription.')) {
    const ws = Object.values(db.workspaces).find(w => (o.metadata || {}).workspace_id === w.id) || Object.values(db.workspaces).find(w => w.stripeCustomerId && w.stripeCustomerId === o.customer);
    if (!ws) return;
    ws.stripeCustomerId = o.customer || ws.stripeCustomerId;
    ws.stripeSubId = o.id;
    ws.subStatus = event.type === 'customer.subscription.deleted' ? 'canceled' : o.status;
    saveDb();
    console.log(`Workspace "${ws.name}" is now ${planOf(ws).name} (${ws.subStatus}).`);
  }
}

setInterval(() => {
  let changed = false;
  for (const [t, ses] of Object.entries(db.sessions)) if (ses.expires < Date.now()) { delete db.sessions[t]; changed = true; }
  for (const [k, pend] of Object.entries(db.pending)) if (pend.expires < Date.now()) { delete db.pending[k]; changed = true; }
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
  migrateWorkspaces();
  applyOwnerEmail();
  // Pick up videos that were still being processed when the server last stopped
  for (const v of Object.values(db.videos)) if (v.status === 'processing') enqueue(v.id);
  listen();
}

// Save the database before the host shuts the app down
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    // Write anything still waiting to be saved before exiting
    if (saveTimer) { clearTimeout(saveTimer); const tmp = DB_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db, null, 2)); fs.renameSync(tmp, DB_FILE); }
    if (storage.enabled) await pushDb(0);
    process.exit(0);
  });
}

start();
function listen() { server.listen(PORT, () => {
  console.log(`${APP_NAME} running at http://localhost:${PORT}`);
  console.log(HAS_FFMPEG ? 'ffmpeg found: videos will be converted to mp4 with thumbnails.' : 'ffmpeg not found: videos are kept as recorded (install ffmpeg for mp4 + thumbnails).');
  console.log(mailReady() ? 'Email verification is on.' : 'Email sending is not set up, so self sign up stays off.');
  console.log(billing.billingReady() ? 'Stripe payments are on.' : 'Stripe is not set up, so everyone stays on their current plan.');
  console.log(storage.enabled ? 'Videos and data are saved to cloud storage.' : 'Videos and data are saved on this computer in ' + DATA_DIR);
  if (!hasUsers()) console.log(`First time? Open http://localhost:${PORT} to create your owner account${OWNER_EMAIL ? ' with ' + OWNER_EMAIL : ''}.`);
}); }
