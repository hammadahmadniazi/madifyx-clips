// Recorder: screen + camera, screen only, or camera only. Uploads when you finish,
// then opens the video's share page.
(function () {
  const S = {
    mode: 'screencam',
    cam: null, mic: null, screen: null, mixed: null, audioCtx: null, meterCtx: null,
    recorder: null, chunks: [], blob: null, mime: '', duration: 0,
    startedAt: 0, pausedTotal: 0, pausedAt: 0, timer: null, discard: false, raf: null,
    floatWin: null, noDocPip: false, starting: false,
  };
  const dlg = $('recorder');

  // ---------- helpers ----------
  const stop = s => s && s.getTracks().forEach(t => t.stop());
  const usesScreen = () => S.mode !== 'cam';
  const usesCam = () => S.mode !== 'screen';
  function pickMime() {
    return ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4;codecs=avc1,mp4a', 'video/mp4']
      .find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
  }

  async function listDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const fill = (sel, kind, noneLabel) => {
        const cur = sel.value;
        const list = devices.filter(d => d.kind === kind);
        sel.innerHTML = list.map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || (kind === 'audioinput' ? 'Microphone ' : 'Camera ') + (i + 1))}</option>`).join('')
          + `<option value="none">${noneLabel}</option>`;
        if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
      };
      fill($('micSelect'), 'audioinput', 'No microphone');
      fill($('camSelect'), 'videoinput', 'No camera');
    } catch (e) { console.warn(e); }
  }

  async function startCam() {
    stop(S.cam); S.cam = null;
    const want = usesCam() && $('camSelect').value !== 'none';
    $('camBox').classList.toggle('hidden', !want);
    if (!want) return;
    try {
      const id = $('camSelect').value;
      S.cam = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: id ? { exact: id } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      });
      $('camPreview').srcObject = S.cam;
    } catch (e) {
      console.warn('Camera unavailable', e);
      $('camBox').classList.add('hidden');
      if (S.mode === 'cam') toast('Camera is blocked. Allow it in your browser settings.');
    }
  }

  async function startMic() {
    stop(S.mic); S.mic = null;
    cancelAnimationFrame(S.raf);
    if (S.meterCtx) { S.meterCtx.close(); S.meterCtx = null; }
    $('micMeter').style.width = '0';
    if ($('micSelect').value === 'none') return;
    try {
      const id = $('micSelect').value;
      S.mic = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: id ? { exact: id } : undefined, echoCancellation: true, noiseSuppression: true } });
      const ctx = S.meterCtx = new AudioContext();
      const an = ctx.createAnalyser(); an.fftSize = 512;
      ctx.createMediaStreamSource(S.mic).connect(an);
      const data = new Uint8Array(an.fftSize);
      const tick = () => {
        an.getByteTimeDomainData(data);
        let peak = 0; for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
        $('micMeter').style.width = Math.min(100, peak * 1.6) + '%';
        S.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) {
      console.warn('Mic unavailable', e);
      toast('Microphone is blocked. Allow it in your browser settings.');
    }
  }

  function applyMode() {
    dlg.querySelectorAll('.mode').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === S.mode)));
    $('stage').classList.toggle('cam-only', S.mode === 'cam');
    $('screenHint').classList.toggle('hidden', S.mode === 'cam');
    $('camDev').style.visibility = usesCam() ? 'visible' : 'hidden';
    $('sysRow').style.visibility = usesScreen() ? 'visible' : 'hidden';
    $('tip').textContent = S.mode === 'screencam'
      ? 'Share your entire screen so your camera bubble shows up in the video.'
      : S.mode === 'screen' ? 'You can share a whole screen, one window, or a single tab.' : 'Look at the camera and press start when you are ready.';
    try { localStorage.setItem('clips.mode', S.mode); } catch (e) {}
  }

  // ---------- open / close ----------
  async function openRecorder() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      alert('This browser cannot record video. Use Chrome, Edge, Firefox or Safari.');
      return;
    }
    if (S.recorder && S.recorder.state !== 'inactive') return;
    try { S.mode = localStorage.getItem('clips.mode') || 'screencam'; } catch (e) {}
    // Phones and tablets can't share their screen, so only camera mode is offered there
    const canScreen = !!navigator.mediaDevices.getDisplayMedia;
    dlg.querySelectorAll('.mode').forEach(b => { if (b.dataset.mode !== 'cam') b.classList.toggle('hidden', !canScreen); });
    dlg.querySelector('.modes').style.gridTemplateColumns = canScreen ? '' : '1fr';
    if (!canScreen) S.mode = 'cam';
    applyMode();
    dlg.showModal();
    await Promise.all([startCam(), startMic()]);
    await listDevices();
  }
  window.openRecorder = openRecorder;

  function closeRecorder() {
    if (dlg.open) dlg.close();
  }
  dlg.addEventListener('close', () => {
    if (S.starting || (S.recorder && S.recorder.state !== 'inactive')) return;
    stop(S.cam); S.cam = null; stop(S.mic); S.mic = null;
    cancelAnimationFrame(S.raf);
    if (S.meterCtx) { S.meterCtx.close(); S.meterCtx = null; }
  });
  $('recClose').onclick = closeRecorder;
  dlg.querySelectorAll('.mode').forEach(b => b.onclick = () => { S.mode = b.dataset.mode; applyMode(); startCam(); });
  $('camSelect').onchange = startCam;
  $('micSelect').onchange = startMic;

  // ---------- recording controls (page bar + floating window) ----------
  function barHtml() {
    return `<span class="pulse"></span><span class="timer" data-timer>0:00</span>
      <button data-act="pause" class="icon-only" aria-label="Pause">${icon('pause')}</button>
      <button data-act="discard" class="icon-only" aria-label="Discard">${icon('trash')}</button>
      <button data-act="finish" class="finish"><span class="sq"></span> Finish</button>`;
  }
  function wireBar(root) {
    root.querySelector('[data-act="pause"]').onclick = togglePause;
    root.querySelector('[data-act="finish"]').onclick = () => finishRecording(false);
    root.querySelector('[data-act="discard"]').onclick = () => {
      const w = S.floatWin && !S.floatWin.closed ? S.floatWin : window;
      if (w.confirm('Discard this recording?')) finishRecording(true);
    };
  }
  function bars() {
    const list = [$('recbar')];
    if (S.floatWin && !S.floatWin.closed) { const b = S.floatWin.document.querySelector('.recbar'); if (b) list.push(b); }
    return list;
  }

  async function openFloat(withCam) {
    // Chrome/Edge: a small always-on-top window with your camera and the controls.
    if ('documentPictureInPicture' in window && !S.noDocPip) {
      try {
        const w = await documentPictureInPicture.requestWindow({ width: withCam ? 260 : 330, height: withCam ? 320 : 80 });
        const link = w.document.createElement('link');
        link.rel = 'stylesheet'; link.href = '/static/style.css';
        w.document.head.appendChild(link);
        w.document.title = 'Recording';
        w.document.body.className = 'float' + (withCam ? '' : ' bar-only');
        w.document.body.innerHTML = (withCam ? '<div class="fcam"><video autoplay muted playsinline></video></div>' : '') + `<div class="recbar">${barHtml()}</div>`;
        if (withCam) w.document.querySelector('video').srcObject = S.cam;
        wireBar(w.document);
        S.floatWin = w;
        return;
      } catch (e) { console.warn('Floating window unavailable', e); }
    }
    // Other browsers: pop the camera out with regular picture in picture.
    if (withCam && document.pictureInPictureEnabled) {
      $('pipVideo').srcObject = S.cam;
      try { await $('pipVideo').play(); await $('pipVideo').requestPictureInPicture(); } catch (e) { console.warn('PiP failed', e); }
    }
  }
  function closeFloat() {
    if (S.floatWin && !S.floatWin.closed) S.floatWin.close();
    S.floatWin = null;
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  }

  async function countdown() {
    const el = $('countdown');
    el.classList.remove('hidden');
    for (let i = 3; i > 0; i--) {
      el.innerHTML = `<span>${i}</span>`;
      await new Promise(r => setTimeout(r, 800));
    }
    el.classList.add('hidden');
  }

  // ---------- start ----------
  $('startBtn').onclick = async () => {
    if (S.mode === 'cam' && !S.cam) { toast('Turn on a camera first, or pick another mode.'); return; }
    S.discard = false;
    const h = Number($('quality').value);
    const tracks = [];

    if (usesScreen()) {
      await openFloat(S.mode === 'screencam' && !!S.cam);
      try {
        S.screen = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 30 }, height: { ideal: h } },
          audio: $('optSys').checked,
          selfBrowserSurface: 'exclude', systemAudio: 'include', surfaceSwitching: 'include',
        });
      } catch (e) {
        closeFloat();
        if (e && e.name === 'InvalidStateError') { S.noDocPip = true; toast('Press Start recording once more.'); }
        else toast('Screen sharing was cancelled');
        return;
      }
      tracks.push(...S.screen.getVideoTracks());
      S.screen.getVideoTracks()[0].addEventListener('ended', () => finishRecording(false));
    } else {
      tracks.push(S.cam.getVideoTracks()[0]);
    }

    // Mix microphone and computer sound into one track
    const audioSources = [usesScreen() ? S.screen : null, S.mic].filter(s => s && s.getAudioTracks().length);
    if (audioSources.length === 1) tracks.push(audioSources[0].getAudioTracks()[0]);
    else if (audioSources.length > 1) {
      S.audioCtx = new AudioContext();
      const dest = S.audioCtx.createMediaStreamDestination();
      audioSources.forEach(s => S.audioCtx.createMediaStreamSource(s).connect(dest));
      tracks.push(dest.stream.getAudioTracks()[0]);
    }
    S.mixed = new MediaStream(tracks);

    S.starting = true;
    closeRecorder();
    cancelAnimationFrame(S.raf);
    await countdown();

    S.mime = pickMime();
    S.chunks = [];
    const bitrate = h >= 1440 ? 8e6 : h >= 1080 ? 5e6 : 2.5e6;
    S.recorder = new MediaRecorder(S.mixed, { mimeType: S.mime || undefined, videoBitsPerSecond: bitrate, audioBitsPerSecond: 128000 });
    S.recorder.ondataavailable = e => { if (e.data && e.data.size) S.chunks.push(e.data); };
    S.recorder.onstop = onStopped;
    S.recorder.start(1000);
    S.starting = false;

    S.startedAt = Date.now(); S.pausedTotal = 0; S.pausedAt = 0;
    $('recbar').innerHTML = barHtml(); wireBar($('recbar'));
    $('recbar').classList.remove('hidden', 'paused');
    S.timer = setInterval(tick, 250); tick();
  };

  function elapsed() {
    return (Date.now() - S.startedAt - S.pausedTotal - (S.pausedAt ? Date.now() - S.pausedAt : 0)) / 1000;
  }
  function tick() {
    const t = fmtDur(elapsed());
    bars().forEach(b => { b.querySelector('[data-timer]').textContent = t; });
    document.title = (S.pausedAt ? 'Paused ' : 'Recording ') + t;
  }
  function togglePause() {
    const r = S.recorder; if (!r) return;
    if (r.state === 'recording') { r.pause(); S.pausedAt = Date.now(); }
    else if (r.state === 'paused') { r.resume(); S.pausedTotal += Date.now() - S.pausedAt; S.pausedAt = 0; }
    const paused = !!S.pausedAt;
    bars().forEach(b => {
      b.classList.toggle('paused', paused);
      const btn = b.querySelector('[data-act="pause"]');
      btn.innerHTML = icon(paused ? 'play' : 'pause');
      btn.setAttribute('aria-label', paused ? 'Resume' : 'Pause');
    });
  }
  function finishRecording(discard) {
    S.discard = !!discard;
    if (S.recorder && S.recorder.state !== 'inactive') S.recorder.stop();
  }

  function onStopped() {
    S.duration = elapsed();
    clearInterval(S.timer);
    document.title = 'Library';
    $('recbar').classList.add('hidden');
    closeFloat();
    stop(S.screen); S.screen = null;
    stop(S.cam); S.cam = null;
    stop(S.mic); S.mic = null;
    if (S.audioCtx) { S.audioCtx.close(); S.audioCtx = null; }
    S.recorder = null;
    if (S.discard) { toast('Recording discarded'); return; }
    S.blob = new Blob(S.chunks, { type: (S.mime || 'video/webm').split(';')[0] });
    upload();
  }

  // ---------- upload ----------
  function upload() {
    const up = $('uploader');
    if (!up.open) up.showModal();
    $('upTitle').textContent = 'Saving your video';
    $('upText').textContent = 'This takes a few seconds. Keep this tab open.';
    $('upActions').classList.add('hidden');
    $('upBar').style.width = '0';
    const qs = new URLSearchParams({ title: 'Untitled video ' + new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), duration: String(S.duration || '') });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/videos?' + qs);
    xhr.setRequestHeader('Content-Type', S.blob.type || 'video/webm');
    xhr.upload.onprogress = e => { if (e.lengthComputable) $('upBar').style.width = Math.round(e.loaded / e.total * 100) + '%'; };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const res = JSON.parse(xhr.responseText);
        S.blob = null;
        const link = location.origin + res.url;
        navigator.clipboard?.writeText(link).catch(() => {});
        location.href = res.url + '?new=1';
      } else fail(xhr.status === 401 ? 'You were signed out. Download a copy so nothing is lost, then sign in again.' : `The server said no (error ${xhr.status}). Try again or download a copy.`);
    };
    xhr.onerror = () => fail('The upload stopped. Check your internet connection and try again.');
    xhr.send(S.blob);
  }
  function fail(msg) {
    $('upTitle').textContent = "Your video wasn't saved yet";
    $('upText').textContent = msg;
    $('upActions').classList.remove('hidden');
  }
  $('retryBtn').onclick = upload;
  $('saveLocalBtn').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(S.blob);
    a.download = 'recording-' + Date.now() + (S.blob.type.includes('mp4') ? '.mp4' : '.webm');
    a.click();
  };
  $('discardBtn').onclick = () => {
    if (!confirm('Discard this recording? It has not been saved.')) return;
    S.blob = null; $('uploader').close();
  };
  $('uploader').addEventListener('cancel', e => e.preventDefault());

  // Shortcuts while recording: Alt+Shift+P pause, Alt+Shift+S finish
  document.addEventListener('keydown', e => {
    if (!S.recorder || !e.altKey || !e.shiftKey) return;
    if (e.code === 'KeyP') togglePause();
    if (e.code === 'KeyS') finishRecording(false);
  });
  window.addEventListener('beforeunload', e => {
    if ((S.recorder && S.recorder.state !== 'inactive') || S.blob) { e.preventDefault(); e.returnValue = ''; }
  });

  if (new URLSearchParams(location.search).get('record') === '1') {
    history.replaceState(null, '', '/');
    openRecorder();
  }
})();
