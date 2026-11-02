// Library: the home page grid of videos.
(function () {
  let videos = [];
  let scope = 'mine';
  let pollTimer;

  renderShell('library').then(me => {
    if (me.role === 'owner') $('scope').classList.remove('hidden');
  });

  function card(v) {
    const thumb = v.thumb
      ? `<img src="${esc(v.thumb)}" alt="" loading="lazy">`
      : `<video src="${esc(v.src)}#t=0.5" preload="metadata" muted playsinline></video>`;
    return `
      <article class="vid" data-id="${esc(v.id)}">
        <a class="thumb" href="/v/${esc(v.id)}" aria-label="${esc(v.title)}">
          ${thumb}
          ${v.duration ? `<span class="dur">${fmtDur(v.duration)}</span>` : ''}
          ${v.status === 'processing' ? '<span class="proc">Processing</span>' : ''}
        </a>
        <div class="tools">
          <button class="btn sm" data-act="copy">${icon('link')} Copy link</button>
          <button class="btn sm icon" data-act="more" aria-label="More actions" aria-haspopup="menu">${icon('more')}</button>
        </div>
        <a class="t" href="/v/${esc(v.id)}">${esc(v.title)}</a>
        <div class="meta">
          ${avatar(v.owner, 'sm')}
          <span>${scope === 'all' && v.owner ? esc(v.owner.split(' ')[0]) + ', ' : ''}${ago(v.createdAt)}</span>
          <span class="stat" title="Views">${icon('eye')}${v.views}</span>
          ${v.commentCount ? `<span class="stat" style="margin-left:0" title="Comments">${icon('chat')}${v.commentCount}</span>` : ''}
        </div>
      </article>`;
  }

  function render() {
    const q = $('search').value.trim().toLowerCase();
    const list = videos.filter(v => !q || v.title.toLowerCase().includes(q) || (v.owner || '').toLowerCase().includes(q));
    $('libTitle').textContent = scope === 'all' ? 'Team library' : 'Your library';
    $('count').textContent = videos.length ? `${videos.length} ${videos.length === 1 ? 'video' : 'videos'}` : ' ';
    $('empty').classList.toggle('hidden', videos.length > 0);
    $('noMatch').classList.toggle('hidden', !(videos.length && !list.length));
    $('grid').innerHTML = list.map(card).join('');
  }

  async function load() {
    clearTimeout(pollTimer);
    videos = await api('/api/videos' + (scope === 'all' ? '?scope=all' : ''));
    render();
    if (videos.some(v => v.status === 'processing')) pollTimer = setTimeout(load, 4000);
  }
  window.reloadLibrary = load;

  // Menu for rename / download / delete
  let openMenu = null;
  function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }
  document.addEventListener('click', e => { if (openMenu && !openMenu.contains(e.target) && !e.target.closest('[data-act="more"]')) closeMenu(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });

  $('grid').addEventListener('click', async e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const el = btn.closest('.vid');
    const v = videos.find(x => x.id === el.dataset.id);
    if (btn.dataset.act === 'copy') return copyText(`${location.origin}/v/${v.id}`);
    if (btn.dataset.act === 'more') {
      const wasOpen = openMenu && openMenu.dataset.id === v.id;
      closeMenu();
      if (wasOpen) return;
      const m = document.createElement('div');
      m.className = 'menu'; m.setAttribute('role', 'menu'); m.dataset.id = v.id;
      m.style.top = '46px'; m.style.right = '8px';
      m.innerHTML = `
        <button role="menuitem" data-m="rename">${icon('edit')} Rename</button>
        <a role="menuitem" href="${esc(v.src)}?download=1">${icon('download')} Download</a>
        <button role="menuitem" class="danger" data-m="delete">${icon('trash')} Delete</button>`;
      el.appendChild(m); openMenu = m;
      m.querySelector('button').focus();
      m.addEventListener('click', async ev => {
        const it = ev.target.closest('[data-m]');
        if (!it) return;
        closeMenu();
        if (it.dataset.m === 'rename') {
          $('renameInput').value = v.title;
          $('renamer').showModal(); $('renameInput').select();
          $('renamer').onclose = async () => {
            if ($('renamer').returnValue !== 'save') return;
            const title = $('renameInput').value.trim();
            if (!title || title === v.title) return;
            await api('/api/videos/' + v.id, 'PATCH', { title });
            v.title = title; render(); toast('Renamed');
          };
        }
        if (it.dataset.m === 'delete') {
          if (!confirm(`Delete "${v.title}"? The share link will stop working. This can't be undone.`)) return;
          await api('/api/videos/' + v.id, 'DELETE');
          videos = videos.filter(x => x.id !== v.id); render(); toast('Video deleted');
        }
      });
    }
  });

  $('scope').addEventListener('click', e => {
    const b = e.target.closest('button[data-scope]'); if (!b) return;
    scope = b.dataset.scope;
    $('scope').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    load();
  });
  $('search').addEventListener('input', render);
  $('emptyRecord').onclick = () => window.openRecorder && window.openRecorder();

  load();
})();
