(() => {
  'use strict';
  const HISTORY_KEY = 'ohanashi-caption-history-v1';
  const SIZE_KEY = 'ohanashi-caption-font-v1';
  const speakerNames = ['A', 'B', 'C'];
  const clamp = (x, low, high) => Math.min(high, Math.max(low, x));
  const $ = id => document.getElementById(id);
  const el = {
    stage: $('historyStage'), list: $('historyList'), empty: $('emptyHistory'), draft: $('liveDraft'), draftText: $('bubbleText'),
    draftState: $('speechState'), draftSpeaker: $('draftSpeaker'), count: $('entryCount'), jump: $('jumpButton'),
    session: $('sessionStatus'), mic: $('micStatus'), message: $('message'), duration: $('durationStatus'), toggle: $('toggleButton'),
    volumeBar: $('volumeBar'), volumeStatus: $('volumeStatus'),
    localControls: $('localControls'), localStatus: $('localStatus'), install: $('installButton'),
    cloudConsent: $('cloudConsent'), cloudCheck: $('cloudCheck'), font: $('fontSize'), fontOutput: $('fontOutput'),
    nextSpeaker: $('nextSpeaker'), copy: $('copyButton'), save: $('saveButton'), clear: $('clearButton'),
    dialog: $('clearDialog'), fullscreen: $('fullscreenButton'), settingsDialog: $('settingsDialog'),
    settingsButton: $('settingsButton'), closeSettings: $('closeSettings'), headerMessage: $('headerMessage')
  };
  let entries = readHistory();
  let recognizer = null, stream = null, audioContext = null, analyser = null, audioTimer = null;
  let wakeLock = null, clockTimer = null, startedAt = 0, followHistory = true, visibleCount = 200;
  let localAvailability = 'unknown', busy = false, saveTimer = null;
  let autoScrolling = false, scrollReleaseTimer = null, sessionBase = '● 停止中';
  let level = 0, segmentStarted = false, segmentFeatures = [], recentFeatures = [];
  let timeData = null, frequencyData = null;
  const speakerProfiles = [];

  function readHistory() {
    try {
      const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(x => x && typeof x.text === 'string' && typeof x.at === 'string').map(x => ({
        text: x.text, at: x.at, speaker: speakerNames.includes(x.speaker) ? x.speaker : 'A',
        source: x.source === 'auto' ? 'auto' : 'manual',
        voiceHint: ['低めの声', '中くらいの声', '高めの声'].includes(x.voiceHint) ? x.voiceHint : ''
      }));
    } catch { return []; }
  }
  function saveNow() {
    clearTimeout(saveTimer); saveTimer = null;
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(entries)); return true; }
    catch { showMessage('履歴をブラウザに保存できません。空き容量を確認し、テキスト保存してください。', true); return false; }
  }
  function queueSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 450); }
  function showMessage(text, error = false) {
    el.message.textContent = text; el.message.classList.toggle('error', error);
    el.headerMessage.hidden = !error; if (error) el.headerMessage.textContent = text;
  }
  function setSession(text, kind = '') { sessionBase = text; el.session.textContent = text; el.session.className = 'status-pill ' + kind; }
  function setToggleVisual(running) {
    const label = running ? '認識を停止' : '認識を開始';
    el.toggle.classList.toggle('stop', running);
    el.toggle.querySelector('.control-icon').className = `control-icon icon-${running ? 'stop' : 'start'}`;
    el.toggle.querySelector('.button-text').textContent = label;
    el.toggle.setAttribute('aria-label', label);
    el.toggle.title = label;
  }
  function openSettings() { if (!el.settingsDialog.open) el.settingsDialog.showModal(); }
  function formatTime(at) {
    const date = new Date(at);
    return Number.isNaN(date.getTime()) ? '--:--:--' : new Intl.DateTimeFormat('ja-JP', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }).format(date);
  }
  function selectedMode() { return document.querySelector('input[name="mode"]:checked').value; }
  function speakerMode() { return document.querySelector('input[name="speakerMode"]:checked').value; }
  function currentManualSpeaker() { return el.nextSpeaker.value; }

  function createEntry(item, index) {
    const li = document.createElement('li');
    const card = document.createElement('article');
    card.className = `message-card speaker-${item.speaker.toLowerCase()}`;
    const meta = document.createElement('div'); meta.className = 'message-meta';
    const badge = document.createElement('span'); badge.className = 'speaker-label'; badge.textContent = `話者${item.speaker}`;
    const time = document.createElement('time'); time.dateTime = item.at; time.textContent = formatTime(item.at);
    const source = document.createElement('span'); source.className = 'source-tag';
    source.textContent = item.source === 'auto' ? `推定${item.voiceHint ? '・' + item.voiceHint : ''}` : '手動';
    source.title = item.source === 'auto' ? '声の特徴による実験的な推定。誤判定する場合があります。' : '手動で指定した話者';
    const label = document.createElement('label'); label.className = 'speaker-edit';
    const select = document.createElement('select'); select.setAttribute('aria-label', `${formatTime(item.at)}の話者を修正`);
    select.title = 'この発言の話者を変更';
    for (const letter of speakerNames) { const option = document.createElement('option'); option.value = letter; option.textContent = `話者${letter}`; select.append(option); }
    select.value = item.speaker;
    select.addEventListener('change', () => {
      entries[index].speaker = select.value; entries[index].source = 'manual';
      card.className = `message-card speaker-${select.value.toLowerCase()}`;
      badge.textContent = `話者${select.value}`; source.textContent = '手動'; source.title = '手動で指定した話者';
      syncLatestEmphasis(); queueSave();
    });
    label.append(select); meta.append(badge, time, source, label);
    const text = document.createElement('div'); text.className = 'message-text'; text.textContent = item.text;
    card.append(meta, text); li.append(card); return li;
  }
  function updateCount() {
    el.count.textContent = `${entries.length}件`; el.empty.hidden = entries.length > 0;
    for (const button of [el.copy, el.save, el.clear]) button.disabled = entries.length === 0;
  }
  function syncLatestEmphasis() {
    for (const card of el.list.querySelectorAll('.message-card.latest')) card.classList.remove('latest');
    el.draft.classList.remove('latest');
    if (el.draft.classList.contains('active') && !el.draft.hidden) el.draft.classList.add('latest');
    else el.list.firstElementChild?.querySelector('.message-card')?.classList.add('latest');
  }
  function renderHistory(keepPosition = false) {
    const oldTop = el.stage.scrollTop;
    const start = Math.max(0, entries.length - visibleCount);
    el.list.replaceChildren();
    for (let index = entries.length - 1; index >= start; index--) el.list.append(createEntry(entries[index], index));
    if (start > 0) {
      const li = document.createElement('li');
      const button = document.createElement('button'); button.className = 'older-button'; button.type = 'button';
      button.textContent = `↓ 古い履歴を表示（残り${start}件）`;
      button.addEventListener('click', () => { visibleCount += 200; renderHistory(true); });
      li.append(button); el.list.append(li);
    }
    updateCount();
    syncLatestEmphasis();
    requestAnimationFrame(() => { if (keepPosition) el.stage.scrollTop = oldTop; else if (followHistory) scrollToLatest(); });
  }
  function scrollToLatest() {
    autoScrolling = true;
    clearTimeout(scrollReleaseTimer);
    el.stage.scrollTop = 0;
    followHistory = true; el.jump.hidden = true;
    scrollReleaseTimer = setTimeout(() => { autoScrolling = false; }, 180);
  }
  function preserveOldView(anchor, top) {
    if (!anchor) return;
    const shift = anchor.getBoundingClientRect().top - top;
    if (!shift) return;
    autoScrolling = true;
    clearTimeout(scrollReleaseTimer);
    el.stage.scrollTop += shift;
    scrollReleaseTimer = setTimeout(() => { autoScrolling = false; }, 180);
  }
  function setDraft(text, state = 'idle', speaker = null) {
    const speakerLabel = speaker ? `話者${speaker}` : speakerMode() === 'auto' ? '話者を推定中' : '次の発言';
    if (el.draftText.textContent === text && el.draft.classList.contains(state) && el.draftSpeaker.textContent === speakerLabel) return;
    const anchor = !followHistory ? el.list.firstElementChild : null;
    const anchorTop = anchor?.getBoundingClientRect().top;
    el.draft.hidden = state !== 'active';
    el.draft.className = `message-card draft ${state}${speaker ? ` speaker-${speaker.toLowerCase()}` : ''}`;
    el.draftText.textContent = text;
    el.draftState.textContent = state === 'active' ? '認識途中' : '待機中';
    el.draftSpeaker.textContent = speakerLabel;
    syncLatestEmphasis();
    if (followHistory) requestAnimationFrame(scrollToLatest);
    else preserveOldView(anchor, anchorTop);
  }
  function addFinal(text, options = {}) {
    const cleaned = String(text).trim(); if (!cleaned) return;
    const item = { text: cleaned, at: options.at || new Date().toISOString(),
      speaker: options.speaker || currentManualSpeaker(),
      source: options.source === 'auto' ? 'auto' : 'manual', voiceHint: options.voiceHint || '' };
    entries.push(item); queueSave();
    const anchor = !followHistory ? el.list.firstElementChild : null;
    const anchorTop = anchor?.getBoundingClientRect().top;
    el.list.prepend(createEntry(item, entries.length - 1));
    let older = el.list.lastElementChild?.querySelector('.older-button');
    const cardCount = el.list.childElementCount - (older ? 1 : 0);
    if (cardCount > visibleCount) (older ? older.parentElement.previousElementSibling : el.list.lastElementChild)?.remove();
    const remaining = Math.max(0, entries.length - visibleCount);
    if (remaining && !older) {
      const li = document.createElement('li');
      older = document.createElement('button'); older.className = 'older-button'; older.type = 'button';
      older.addEventListener('click', () => { visibleCount += 200; renderHistory(true); });
      li.append(older); el.list.append(li);
    }
    if (older) {
      if (remaining) older.textContent = `↓ 古い履歴を表示（残り${remaining}件）`;
      else older.parentElement.remove();
    }
    updateCount();
    syncLatestEmphasis();
    setDraft('次の発言を待っています。', 'idle', null);
    if (!followHistory) { preserveOldView(anchor, anchorTop); el.jump.hidden = false; }
  }
  function historyText() { return entries.map(x => `${formatTime(x.at)}  話者${x.speaker}  ${x.text}`).join('\n'); }
  function applyFont() {
    const value = Number(el.font.value); const sizes = [1.65, 1.9, 2.25, 2.6, 3];
    document.documentElement.style.setProperty('--history-size', `${sizes[value]}rem`);
    el.fontOutput.textContent = ['小', 'やや小', '標準', '大', '特大'][value];
    try { localStorage.setItem(SIZE_KEY, String(value)); } catch {}
    if (followHistory) requestAnimationFrame(scrollToLatest);
  }
  function updateMode() {
    const cloud = selectedMode() === 'cloud';
    el.cloudConsent.hidden = !cloud; el.localControls.hidden = cloud;
    if (!cloud) el.cloudCheck.checked = false;
    if (recognizer?.running) stopRecognition();
    showMessage(cloud ? '音声はChrome/Googleの認識サービスへ送られます。確認チェック後に開始してください。' : '端末内認識の可否を確認してから開始してください。');
  }
  async function checkLocal() {
    if (!window.JimakuRecognizer || !(window.SpeechRecognition || window.webkitSpeechRecognition)) {
      localAvailability = 'unsupported'; el.localStatus.textContent = 'このブラウザは音声認識に対応していません。Chromeで開いてください。'; return;
    }
    localAvailability = await window.JimakuRecognizer.localAvailability('ja-JP');
    const labels = { available:'端末内の日本語認識を利用できます', downloadable:'端末内の日本語モデルを準備できます', downloading:'日本語モデルをダウンロード中です', unavailable:'端末内の日本語認識を利用できません', unknown:'端末内認識の可否を確認できません' };
    el.localStatus.textContent = labels[localAvailability] || labels.unknown;
    el.install.hidden = localAvailability !== 'downloadable';
  }

  function estimatePitch(data, sampleRate) {
    const minLag = Math.floor(sampleRate / 350), maxLag = Math.min(Math.floor(sampleRate / 85), Math.floor(data.length / 2));
    let best = 0, bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag += 2) {
      let dot = 0, energy1 = 0, energy2 = 0;
      for (let i = 0; i < 640 && i + lag < data.length; i += 2) {
        const a = data[i], b = data[i + lag]; dot += a * b; energy1 += a * a; energy2 += b * b;
      }
      const correlation = dot / Math.sqrt(energy1 * energy2 || 1);
      if (correlation > best) { best = correlation; bestLag = lag; }
    }
    return best > .62 && bestLag ? sampleRate / bestLag : null;
  }
  function audioSample() {
    if (!analyser || !audioContext) return;
    const data = timeData;
    analyser.getFloatTimeDomainData(data);
    let power = 0; for (const sample of data) power += sample * sample;
    const rms = Math.sqrt(power / data.length);
    const db = 20 * Math.log10(Math.max(rms, 0.00001));
    const target = clamp((db + 46) / 29, 0, 1);
    level = level * .72 + target * .28;
    el.volumeBar.style.width = `${Math.round(level * 100)}%`;
    el.volumeStatus.textContent = rms > .001 ? '端末内で測定中' : '静か';
    // Voice profiling is experimental. Manual speaker mode needs only the
    // meter, so skip FFT and pitch work on each tablet update.
    if (rms < .008 || speakerMode() !== 'auto') return;
    const spectrum = frequencyData;
    analyser.getFloatFrequencyData(spectrum);
    const hzPerBin = audioContext.sampleRate / analyser.fftSize;
    const bands = [0, 0, 0];
    for (let i = 1; i < spectrum.length; i++) {
      const hz = i * hzPerBin;
      const band = hz < 500 ? 0 : hz < 1600 ? 1 : hz < 4000 ? 2 : -1;
      if (band >= 0 && hz >= 100) bands[band] += Math.pow(10, spectrum[i] / 10);
    }
    const pitch = estimatePitch(data, audioContext.sampleRate);
    const feature = pitch ? [Math.log2(pitch / 160), Math.log10((bands[1] + 1e-8) / (bands[0] + 1e-8)), Math.log10((bands[2] + 1e-8) / (bands[1] + 1e-8))] : null;
    const frame = { at: Date.now(), feature };
    recentFeatures.push(frame); recentFeatures = recentFeatures.filter(x => frame.at - x.at < 2200);
    if (segmentStarted) { segmentFeatures.push(frame); if (segmentFeatures.length > 200) segmentFeatures.shift(); }
  }
  function segmentVector() {
    const frames = (segmentFeatures.length ? segmentFeatures : recentFeatures).filter(x => x.feature);
    if (frames.length < 8) return null;
    return [0, 1, 2].map(i => {
      const values = frames.map(x => x.feature[i]).sort((a, b) => a - b);
      return values[Math.floor(values.length / 2)];
    });
  }
  function voiceHintForVector(vector) {
    if (!vector) return '';
    const pitch = 160 * 2 ** vector[0];
    return pitch < 145 ? '低めの声' : pitch > 230 ? '高めの声' : '中くらいの声';
  }
  function classifySpeaker(vector) {
    if (!vector) return null;
    const distance = (a, b) => Math.sqrt((a[0]-b[0])**2 + .2*(a[1]-b[1])**2 + .2*(a[2]-b[2])**2);
    let best = null, bestDistance = Infinity;
    for (const profile of speakerProfiles) {
      const d = distance(profile.vector, vector);
      if (d < bestDistance) { bestDistance = d; best = profile; }
    }
    if ((!best || bestDistance > .38) && speakerProfiles.length < 3) {
      const created = { speaker: speakerNames[speakerProfiles.length], vector, count: 1 };
      speakerProfiles.push(created); return created.speaker;
    }
    if (!best) return null;
    const weight = Math.min(1 / (best.count + 1), .15);
    best.vector = best.vector.map((v, i) => v * (1 - weight) + vector[i] * weight);
    best.count++; return best.speaker;
  }
  function beginSegment() {
    if (segmentStarted) return;
    segmentStarted = true; segmentFeatures = recentFeatures.slice();
  }
  function finishSegment() {
    const vector = segmentVector();
    segmentStarted = false; segmentFeatures = [];
    if (speakerMode() === 'auto') {
      const speaker = classifySpeaker(vector);
      if (speaker) return { speaker, source: 'auto', voiceHint: voiceHintForVector(vector) };
    }
    return { speaker: currentManualSpeaker(), source: 'manual' };
  }
  async function startAudio() {
    const supported = navigator.mediaDevices.getSupportedConstraints?.() || {};
    const audio = supported.autoGainControl ? { autoGainControl: { ideal: true } } : true;
    stream = await navigator.mediaDevices.getUserMedia({ audio });
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = .7;
    timeData = new Float32Array(analyser.fftSize);
    frequencyData = new Float32Array(analyser.frequencyBinCount);
    source.connect(analyser);
    await audioContext.resume();
    audioTimer = setInterval(audioSample, 100);
    el.volumeStatus.textContent = '端末内で測定中';
    return stream.getAudioTracks()[0];
  }
  function stopAudio() {
    clearInterval(audioTimer); audioTimer = null;
    if (stream) stream.getTracks().forEach(track => track.stop()); stream = null;
    if (audioContext) audioContext.close().catch(() => {}); audioContext = null; analyser = null;
    timeData = null; frequencyData = null;
    level = 0; segmentStarted = false; segmentFeatures = []; recentFeatures = [];
    el.volumeBar.style.width = '0%'; el.volumeStatus.textContent = '未測定';
  }
  async function holdScreen() {
    if (!recognizer?.running || document.hidden || !navigator.wakeLock?.request) return;
    try { wakeLock = await navigator.wakeLock.request('screen'); updateDuration(); }
    catch { updateDuration(); }
  }
  function releaseScreen() { if (wakeLock) wakeLock.release().catch(() => {}); wakeLock = null; }
  function updateDuration() {
    const seconds = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
    const hh = Math.floor(seconds / 3600), mm = Math.floor(seconds % 3600 / 60), ss = seconds % 60;
    const elapsed = hh ? `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}` : `${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
    el.duration.textContent = `連続時間 ${elapsed} · 画面保持 ${wakeLock ? '有効' : '停止中／非対応'}`;
    if (startedAt && recognizer?.running) el.session.textContent = `${sessionBase} ${elapsed}`;
  }
  function stopRecognition() {
    const current = recognizer; recognizer = null;
    if (current) current.stop();
    stopAudio(); releaseScreen(); clearInterval(clockTimer); clockTimer = null; startedAt = 0; updateDuration(); saveNow();
    busy = false; el.toggle.disabled = false; setToggleVisual(false);
    el.mic.textContent = 'マイク：停止中'; setSession('● 停止中');
    if (el.draft.classList.contains('active')) setDraft('認識途中の言葉は確定していないため保存されませんでした。', 'idle');
  }
  async function startRecognition() {
    if (busy) return;
    const mode = selectedMode();
    if (!window.JimakuRecognizer || !(window.SpeechRecognition || window.webkitSpeechRecognition)) { showMessage('このブラウザは音声認識に対応していません。Chromeで開いてください。', true); return; }
    if (mode === 'local') {
      await checkLocal();
      if (localAvailability !== 'available') { openSettings(); showMessage('端末内認識を利用できません。モデルを準備するか、送信先を確認してクラウド方式を選んでください。', true); return; }
    } else if (!el.cloudCheck.checked) {
      openSettings(); showMessage('クラウドの送信先を確認し、チェックを入れてから開始してください。', true); el.cloudCheck.focus(); return;
    }
    busy = true; el.toggle.disabled = true; el.mic.textContent = 'マイク：許可待ち'; setSession('● 接続中');
    showMessage('ブラウザのマイク許可が表示されたら内容を確認してください。');
    let track;
    try { track = await startAudio(); }
    catch (error) { stopAudio(); busy = false; el.toggle.disabled = false; el.mic.textContent = 'マイク：利用不可'; setSession('● エラー','error'); showMessage(`マイクを使えません：${error.message}`, true); return; }
    const current = new window.JimakuRecognizer({ lang:'ja-JP', processLocally:mode === 'local', mode:'restart', shortPause:0, audioTrack:track });
    recognizer = current;
    current.addEventListener('interim', event => {
      if (recognizer !== current || !current.running) return;
      const text = event.detail.text.trim(); if (!text) return;
      beginSegment(); setDraft(text, 'active', speakerMode() === 'manual' ? currentManualSpeaker() : null);
    });
    current.addEventListener('final', event => {
      if (recognizer !== current || !current.running) return;
      addFinal(event.detail.text, finishSegment());
    });
    current.addEventListener('state', event => {
      if (recognizer !== current) return;
      if (!event.detail.running) { stopRecognition(); return; }
      busy = false; el.toggle.disabled = false; setToggleVisual(true);
      el.mic.textContent = event.detail.listening ? 'マイク：聞き取り中' : 'マイク：再接続中';
      setSession(event.detail.listening ? '● 認識中' : '● 再接続中', 'running');
    });
    current.addEventListener('error', event => {
      if (recognizer !== current) return;
      showMessage(`音声認識エラー：${event.detail.message || event.detail.error}`, true);
      if (event.detail.fatal) { stopRecognition(); setSession('● エラー','error'); }
    });
    current.addEventListener('recovered', () => showMessage('音声認識を再接続しました。'));
    current.addEventListener('noresult', () => showMessage('声を検出しましたが文字になっていません。マイクと周囲の音を確認してください。', true));
    try { await current.start(); }
    catch (error) { stopRecognition(); setSession('● エラー','error'); showMessage(`開始できませんでした：${error.message}`, true); return; }
    startedAt = Date.now(); clockTimer = setInterval(updateDuration, 1000); updateDuration(); holdScreen();
  }

  el.toggle.addEventListener('click', () => recognizer?.running ? stopRecognition() : startRecognition());
  el.settingsButton.addEventListener('click', openSettings);
  el.closeSettings.addEventListener('click', () => el.settingsDialog.close());
  document.querySelectorAll('input[name="mode"]').forEach(input => input.addEventListener('change', updateMode));
  document.querySelectorAll('input[name="speakerMode"]').forEach(input => input.addEventListener('change', () => {
    if (speakerMode() === 'auto') showMessage('話者の自動推定は実験機能です。誤判定した発言は話者を修正してください。');
    setDraft(el.draftText.textContent, el.draft.classList.contains('active') ? 'active' : 'idle', speakerMode() === 'manual' ? currentManualSpeaker() : null);
  }));
  el.nextSpeaker.addEventListener('change', () => { if (speakerMode() === 'manual') setDraft(el.draftText.textContent, el.draft.classList.contains('active') ? 'active' : 'idle', currentManualSpeaker()); });
  el.install.addEventListener('click', async () => {
    el.install.disabled = true; el.localStatus.textContent = '日本語モデルを準備しています。通信が必要な場合があります…';
    const installed = await window.JimakuRecognizer.installLocal('ja-JP'); await checkLocal();
    if (!installed || localAvailability !== 'available') showMessage('端末内モデルを準備できませんでした。Chromeの設定・対応状況を確認してください。', true);
    el.install.disabled = false;
  });
  el.stage.addEventListener('scroll', () => {
    if (autoScrolling) return;
    followHistory = el.stage.scrollTop < 55;
    el.jump.hidden = followHistory;
  });
  el.jump.addEventListener('click', () => { visibleCount = 200; renderHistory(); scrollToLatest(); });
  el.copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(historyText()); showMessage('履歴をコピーしました。'); }
    catch { showMessage('コピーできませんでした。ブラウザの権限を確認してください。', true); }
  });
  el.save.addEventListener('click', () => {
    const blob = new Blob([historyText() + '\n'], { type:'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `おはなし字幕_履歴_${new Date().toISOString().slice(0,10)}.txt`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); showMessage('テキストファイルを保存しました。');
  });
  el.clear.addEventListener('click', () => el.dialog.showModal());
  $('cancelClear').addEventListener('click', () => el.dialog.close());
  $('confirmClear').addEventListener('click', () => {
    entries = []; clearTimeout(saveTimer); saveTimer = null; localStorage.removeItem(HISTORY_KEY);
    renderHistory(); el.dialog.close(); showMessage('このアプリの履歴を消去しました。');
  });
  el.font.addEventListener('input', applyFont);
  window.addEventListener('resize', () => { if (followHistory) requestAnimationFrame(scrollToLatest); });
  el.fullscreen.addEventListener('click', async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
    catch { showMessage('全画面表示を開始できませんでした。', true); }
  });
  document.addEventListener('fullscreenchange', () => { el.fullscreen.textContent = document.fullscreenElement ? '⛶ 全画面を終了' : '⛶ 全画面'; });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && recognizer?.running && !wakeLock) holdScreen(); if (document.hidden) saveNow(); });
  window.addEventListener('pagehide', saveNow);
  try { const size = localStorage.getItem(SIZE_KEY); if (/^[0-4]$/.test(size || '')) el.font.value = size; } catch {}
  setToggleVisual(false); applyFont(); renderHistory(); setDraft('認識を開始すると、話している途中の言葉がここに表示されます。'); checkLocal(); updateDuration();

  if (location.hostname === '127.0.0.1' && new URLSearchParams(location.search).has('test')) {
    const box = document.createElement('aside'); box.className = 'test-controls';
    box.innerHTML = '<strong>検証用の文字入力（マイク不使用）</strong><input id="testText" aria-label="検証用テキスト" value="おはようございます。"><button id="testInterim" type="button">途中を表示</button><button id="testFinal" type="button">確定して履歴へ</button>';
    document.querySelector('.controls').before(box);
    $('testInterim').addEventListener('click', () => setDraft($('testText').value, 'active', currentManualSpeaker()));
    $('testFinal').addEventListener('click', () => addFinal($('testText').value, { speaker:currentManualSpeaker() }));
    window.__captionTest = { classifySpeaker, voiceHintForVector, addFinal, setDraft, stopRecognition };
  }
})();
