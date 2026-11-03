// Shared helpers: icons, sidebar, toasts, small utilities.
const ICONS = {
  shield: '<path d="M12 3.5 5 6v5.5c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6z"/><path d="m9 12 2 2 4-4"/>',
  card: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3 10h18M7 15h3"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  film: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7.5 4.5v15M16.5 4.5v15M3 9.5h4.5M3 14.5h4.5M16.5 9.5H21M16.5 14.5H21"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  library: '<rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M10.2 9.4v5.2l4.3-2.6z"/>',
  team: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19c.6-3 2.9-4.7 5.5-4.7s4.9 1.7 5.5 4.7"/><circle cx="17" cy="9.5" r="2.4"/><path d="M16.4 14.4c2.2.1 3.7 1.5 4.1 4"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  more: '<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  chat: '<path d="M4.5 5.5h15v10.5h-9l-4.5 3.5v-3.5H4.5z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  screen: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16.5V20"/>',
  screencam: '<rect x="2.5" y="4" width="15" height="10.5" rx="2"/><circle cx="17.5" cy="16.5" r="4"/>',
  camera: '<rect x="3" y="6.5" width="12.5" height="11" rx="2"/><path d="m15.5 10.5 5.5-3v9l-5.5-3"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9L17.5 7"/>',
  pause: '<path d="M9 6v12M15 6v12"/>',
  play: '<path d="M8 5.5 18.5 12 8 18.5z"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>',
  edit: '<path d="M4.5 19.5h4l10-10-4-4-10 10z"/>',
  logout: '<path d="M14.5 4.5h4.5v15h-4.5M10 8l-4 4 4 4M6 12h9.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  speaker: '<path d="M4.5 9.5h3.5l4.5-4v13l-4.5-4H4.5z"/><path d="M16 9a4 4 0 0 1 0 6"/>',
};
function icon(name, cls = '') {
  return `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}
function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  if (s < 86400 * 7) { const d = Math.floor(s / 86400); return d === 1 ? 'yesterday' : d + ' days ago'; }
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}
// "5 minutes", "90 seconds" or "1:30" for a recording limit
function limitLabel(sec) { return sec % 60 === 0 ? `${sec / 60} minute${sec === 60 ? '' : 's'}` : sec < 60 ? `${sec} seconds` : fmtDur(sec); }
const AVATAR_COLORS = ['linear-gradient(135deg,#00C3FF,#0077B6)', 'linear-gradient(135deg,#00C8D7,#00897B)', 'linear-gradient(135deg,#8B7CFF,#5B3FD6)', 'linear-gradient(135deg,#FFB547,#E07A12)', 'linear-gradient(135deg,#FF6B8A,#C2255C)', 'linear-gradient(135deg,#4ADE80,#15803D)', 'linear-gradient(135deg,#60A5FA,#2563EB)'];
function avatar(name, size = '') {
  name = String(name || '?').trim();
  let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const initials = name.split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
  return `<span class="avatar ${size}" style="background:${AVATAR_COLORS[h % AVATAR_COLORS.length]}">${esc(initials)}</span>`;
}

function toast(msg) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = document.createElement('div');
  t.className = 'toast'; t.setAttribute('role', 'status');
  t.innerHTML = icon('check') + '<span></span>';
  t.querySelector('span').textContent = msg;
  (document.querySelector('dialog[open]') || document.body).appendChild(t);
  setTimeout(() => t.remove(), 2400);
}

async function api(url, method = 'GET', body) {
  const r = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && !url.includes('/login')) { location.href = '/login'; throw new Error('Please sign in'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Something went wrong. Try again.');
  return j;
}

async function copyText(text, msg = 'Link copied') {
  try { await navigator.clipboard.writeText(text); toast(msg); }
  catch { prompt('Copy this link:', text); }
}

// Loom-style frame for signed-in pages: slim icon rail, top bar with search and avatar menu.
// `active` is 'library' or 'team'.
function renderShell(active) {
  const onApp = location.pathname === '/';
  const record = () => { if (onApp && window.openRecorder) window.openRecorder(); else location.href = '/?record=1'; };
  $('side').innerHTML = `
    <a class="rail-logo" href="/" aria-label="Madifyx Clips home"><img src="/static/brand/logo.png" alt=""></a>
    <nav class="rail-nav" aria-label="Main">
      <a href="/" class="${active === 'library' ? 'active' : ''}" data-tip="Library">${icon('library')}<span>Library</span></a>
      <button class="rail-rec" id="newVideo" data-tip="New video" aria-label="New video">${icon('camera')}</button>
      <a href="/team" class="${active === 'team' ? 'active' : ''}" data-tip="Team" id="teamLink">${icon('team')}<span>Team</span></a>
      <a href="/admin" class="hidden rail-admin ${active === 'admin' ? 'active' : ''}" data-tip="Admin" id="adminLink">${icon('shield')}<span>Admin</span></a>
    </nav>`;
  const main = document.querySelector('.main');
  main.insertAdjacentHTML('afterbegin', `
    <header class="appbar">
      <a class="top-logo" href="/" aria-label="Madifyx Clips home"><img src="/static/brand/logo.png" alt=""></a>
      <label class="tsearch"><span class="hidden">Search</span>${icon('search')}
        <input id="search" type="search" placeholder="Search videos and people" autocomplete="off"></label>
      <div class="tright">
        <button class="btn upg hidden" id="upgradeTop">${icon('spark')}<span>Upgrade</span></button>
        <button class="btn primary newv" id="newVideo2"><span class="dot"></span><span>New video</span></button>
        <div class="avwrap"><button class="avbtn" id="avBtn" aria-haspopup="menu" aria-label="Your account"></button></div>
      </div>
    </header>`);
  $('newVideo').onclick = record;
  $('newVideo2').onclick = record;
  if (!onApp) $('search').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.value.trim()) location.href = '/?q=' + encodeURIComponent(e.target.value.trim()); });
  const q = new URLSearchParams(location.search).get('q');
  if (q && onApp) $('search').value = q;

  window.meReady = api('/api/me').then(me => {
    window.ME = me;
    const label = me.role === 'owner' ? 'Team' : 'Account';
    $('teamLink').dataset.tip = label; $('teamLink').querySelector('span').textContent = label;
    if (me.isAdmin) $('adminLink').classList.remove('hidden');
    if (me.workspace.plan === 'free') { $('upgradeTop').classList.remove('hidden'); $('upgradeTop').onclick = () => showUpgrade(); }
    $('avBtn').innerHTML = avatar(me.name);
    $('avBtn').onclick = e => {
      e.stopPropagation();
      const old = document.querySelector('.avmenu'); if (old) { old.remove(); return; }
      const m = document.createElement('div');
      m.className = 'menu avmenu'; m.setAttribute('role', 'menu');
      m.innerHTML = `<div class="avhead">${avatar(me.name, 'lg')}<div><div class="nm"></div><div class="em"></div></div></div>
        <div class="avws"><span></span><b class="plan-badge ${me.workspace.plan}">${esc(me.workspace.planName)}</b></div>
        <a role="menuitem" href="/team">${icon('team')} ${me.role === 'owner' ? 'Team and settings' : 'Account settings'}</a>
        ${me.role === 'owner' ? `<a role="menuitem" href="/team#billing">${icon('card')} Plan and billing</a>` : ''}
        ${me.isAdmin ? `<a role="menuitem" href="/admin">${icon('shield')} Admin</a>` : ''}
        <a role="menuitem" href="/logout">${icon('logout')} Sign out</a>`;
      m.querySelector('.nm').textContent = me.name; m.querySelector('.em').textContent = me.email;
      m.querySelector('.avws span').textContent = me.workspace.name;
      $('avBtn').parentElement.appendChild(m);
    };
    document.addEventListener('click', e => { const m = document.querySelector('.avmenu'); if (m && !m.contains(e.target)) m.remove(); });
    return me;
  });
  return window.meReady;
}

// ---------- plans ----------
const PAID_PERKS = ['Unlimited videos', 'Record as long as you like', 'Invite your teammates', 'Your workspace name on share pages instead of Madifyx'];

// `say` shows a message right next to the button (toasts would hide behind the pop-up)
async function startCheckout(btn, say = msg => alert(msg)) {
  const me = window.ME || await window.meReady;
  if (me.role !== 'owner') { say('Only your workspace admin can upgrade.'); return; }
  if (!me.billing.ready) {
    say(me.isAdmin ? 'Payments are not switched on yet. Add STRIPE_SECRET_KEY and STRIPE_PRICE_ID in Render, then try again.'
                   : "Upgrades aren't available just yet. Please try again a little later.");
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Opening secure checkout'; }
  try { const r = await api('/api/billing/checkout', 'POST', {}); location.href = r.url; }
  catch (e) { say(e.message); if (btn) { btn.disabled = false; btn.textContent = 'Upgrade now'; } }
}

// Pop-up that explains what upgrading unlocks. `reason` is a short sentence shown on top.
async function showUpgrade(reason) {
  const me = window.ME || await window.meReady;
  document.querySelectorAll('dialog.upgrade').forEach(d => d.remove());
  const d = document.createElement('dialog');
  d.className = 'upgrade';
  const owner = me.role === 'owner';
  d.innerHTML = `<div class="dlg-body up-body">
    <button class="btn ghost icon up-x" aria-label="Close">${icon('x')}</button>
    <div class="up-badge">${icon('spark')} Pro</div>
    <h2>${reason ? esc(reason) : 'Get more from Madifyx Clips'}</h2>
    <ul class="up-perks">${PAID_PERKS.map(p => `<li>${icon('check')}${esc(p)}</li>`).join('')}</ul>
    ${me.billing.price ? `<div class="up-price"><span class="num">${esc(me.billing.price.split('/')[0])}</span> per ${esc(me.billing.price.split('/')[1])} for your whole workspace</div>` : ''}
    ${owner ? `<button class="btn primary block up-go">Upgrade now</button><p class="up-msg hidden" role="alert"></p><p class="up-note">Secure checkout by Stripe. Cancel any time.</p>`
            : `<p class="up-note">Only your workspace admin can upgrade. Let them know you need more.</p>`}
  </div>`;
  document.body.appendChild(d);
  d.querySelector('.up-x').onclick = () => d.close();
  d.addEventListener('close', () => d.remove());
  const msg = d.querySelector('.up-msg');
  const go = d.querySelector('.up-go'); if (go) go.onclick = () => startCheckout(go, t => { msg.textContent = t; msg.classList.remove('hidden'); });
  d.showModal();
}
