// ── STATE ──────────────────────────────────────────────────
let profiles = [];
let currentProfile = null;
let builderSteps = [];
let selectedStepIdx = null;
let isRunning = false;
let liveInterval = null;
let builderMode = false;
let builderDefaultAction = 'click';
let sse = null;
let sortable = null;
let currentRunnableProfile = null; // (deprecated)

const BROWSER_W = 1280;
const BROWSER_H = 720;

// ── INIT ───────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  setupSSE();
  loadProfiles();
  startLive();
  setupClickOverlay();
  setupManualInput();
  setupFloatingLogs();
  updateUrl();
});

// ── TABS ──────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.tab-content').forEach(el => {
        el.classList.toggle('active', el.id === 'tab-' + tab);
      });
      builderMode = (tab === 'builder');
      renderBuilderMarkers();
    });
  });
}

// ── LIVE SCREENSHOT ───────────────────────────────────────
function startLive() {
  refreshScreenshot();
  liveInterval = setInterval(refreshScreenshot, 1500);
}

function refreshScreenshot() {
  const img = document.getElementById('liveFrame');
  const ts = Date.now();
  const newSrc = `/screenshot?t=${ts}`;
  const tmp = new Image();
  tmp.onload = () => { img.src = newSrc; };
  tmp.src = newSrc;
  updateUrl();
}

function toggleLive(on) {
  clearInterval(liveInterval);
  if (on) liveInterval = setInterval(refreshScreenshot, 1500);
}

async function updateUrl() {
  try {
    const r = await fetch('/browser/url');
    const { url } = await r.json();
    const bar = document.getElementById('urlBar');
    if (document.activeElement !== bar) bar.value = url || '';
  } catch (_) {}
}

// ── CLICK OVERLAY ─────────────────────────────────────────
function setupClickOverlay() {
  const overlay = document.getElementById('clickOverlay');
  overlay.addEventListener('click', e => {
    const { bx, by, px, py } = getBrowserCoords(e);
    if (builderMode) {
      addBuilderStep(bx, by, px, py);
    } else {
      sendClick(bx, by, px, py);
    }
  });
}

function getBrowserCoords(e) {
  const img = document.getElementById('liveFrame');
  const rect = img.getBoundingClientRect();
  const relX = e.clientX - rect.left;
  const relY = e.clientY - rect.top;
  const scaleX = BROWSER_W / rect.width;
  const scaleY = BROWSER_H / rect.height;
  return {
    bx: Math.round(relX * scaleX),
    by: Math.round(relY * scaleY),
    px: relX,
    py: relY,
    rect
  };
}

async function sendClick(bx, by, px, py) {
  showRipple(px, py);
  try {
    await fetch('/browser/click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: bx, y: by })
    });
    setTimeout(refreshScreenshot, 300);
  } catch (e) {
    addLog('Click failed: ' + e.message, 'error');
  }
}

function showRipple(px, py) {
  const overlay = document.getElementById('clickOverlay');
  const r = document.createElement('div');
  r.className = 'ripple';
  r.style.left = px + 'px';
  r.style.top = py + 'px';
  overlay.appendChild(r);
  setTimeout(() => r.remove(), 550);
}

// ── MANUAL CONTROLS ───────────────────────────────────────
function setupManualInput() {
  const input = document.getElementById('manualInput');
  input.addEventListener('keydown', async e => {
    if (e.key === 'Enter') {
      const text = input.value;
      input.value = '';
      await sendTextWithEnter(text);
    }
  });
}

async function sendTextWithEnter(text) {
  try {
    if (text) {
      await fetch('/browser/type', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, delay: 20 })
      });
    }
    await fetch('/browser/keypress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'Enter' })
    });

    if (document.getElementById('deepseekMonitorToggle')?.checked) {
      addLog('Waiting for DeepSeek response...', 'info');
      try {
        const r = await fetch('/browser/deepseek-monitor', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timeout: 60000, interval: 500, stableThreshold: 3 })
        });
        const data = await r.json();
        if (r.ok && data.result?.text) {
          setResponse(data.result.text);
          addLog('DeepSeek response captured', 'success');
        } else {
          addLog('DeepSeek monitor completed without captured text', 'warn');
        }
      } catch (err) {
        addLog('DeepSeek monitor failed: ' + err.message, 'error');
      }
    }

    if (document.getElementById('liveToggle')?.checked) {
      setTimeout(refreshScreenshot, 400);
    }
  } catch (e) {
    addLog('Send failed: ' + e.message, 'error');
  }
}

async function sendManualKey(key) {
  if (key === 'Backspace') {
    const input = document.getElementById('manualInput');
    if (input.value) {
      input.value = input.value.slice(0, -1);
    }
    await fetch('/browser/keypress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'Backspace' })
    });
  } else if (key === 'Enter') {
    await fetch('/browser/keypress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'Enter' })
    });
    setTimeout(refreshScreenshot, 400);
  }
}

async function sendScroll(deltaY) {
  await fetch('/browser/scroll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ x: BROWSER_W / 2, y: BROWSER_H / 2, deltaY })
  });
  setTimeout(refreshScreenshot, 300);
}

async function navigate() {
  const url = document.getElementById('urlBar').value.trim();
  if (!url) return;
  addLog(`Navigating to ${url}`, 'info');
  await fetch('/browser/navigate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url })
  });
  setTimeout(refreshScreenshot, 1500);
}

// ── SSE ───────────────────────────────────────────────────
function setupSSE() {
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');

  function connect() {
    sse = new EventSource('/logs/stream');
    sse.onopen = () => {
      dot.className = 'status-dot connected';
      txt.textContent = 'Connected';
    };
    sse.onmessage = e => {
      const data = JSON.parse(e.data);
      switch (data.type) {
        case 'log': addLog(data.message, data.level); break;
        case 'status': setRunning(data.running); break;
        case 'response': setResponse(data.text); break;
        case 'step': updateProgress(data.index + 1, data.total, data.label); break;
        case 'done': if (data.result) setResponse(data.result); hideProgress(); break;
        case 'error': addLog('Error: ' + data.message, 'error'); hideProgress(); break;
      }
    };
    sse.onerror = () => {
      dot.className = 'status-dot error';
      txt.textContent = 'Disconnected';
      setTimeout(connect, 3000);
    };
  }
  connect();
}

// ── FLOATING LOGS (Ctrl+L) ─────────────────────────────────
function setupFloatingLogs() {
  window.addEventListener('keydown', e => {
    if (e.ctrlKey && e.key && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      toggleFloatingLogs();
    }
  });
  const closeBtn = document.getElementById('floatingClose');
  if (closeBtn) closeBtn.addEventListener('click', () => toggleFloatingLogs(false));
  const clearBtn = document.getElementById('floatingClear');
  if (clearBtn) clearBtn.addEventListener('click', () => { document.getElementById('floatingLogBox').innerHTML = ''; });
}

function toggleFloatingLogs(forceState) {
  const panel = document.getElementById('floatingLogs');
  if (!panel) return;
  const isOpen = panel.style.display !== 'none' && panel.style.display !== '';
  const show = typeof forceState === 'boolean' ? forceState : !isOpen;
  panel.style.display = show ? 'flex' : 'none';
  panel.setAttribute('aria-hidden', show ? 'false' : 'true');
  if (show) {
    const main = document.getElementById('logBox');
    const dest = document.getElementById('floatingLogBox');
    if (main && dest) {
      dest.innerHTML = main.innerHTML;
      dest.scrollTop = dest.scrollHeight;
    }
  }
}

// ── PROFILES ──────────────────────────────────────────────
async function loadProfiles() {
  try {
    const r = await fetch('/profiles');
    const data = await r.json();
    
    if (!r.ok) {
      throw new Error(data.error || `Server returned ${r.status}`);
    }
    
    if (!Array.isArray(data)) {
      throw new Error('Invalid profiles response: expected an array');
    }
    
    profiles = data;
    
    // Ensure all profiles have slugs
    if (profiles.length && !profiles[0].slug) {
      addLog('⚠ Profiles missing slugs, regenerating...', 'warn');
      profiles = profiles.map((p, i) => ({
        ...p,
        slug: p.slug || (p.name || 'profile').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
      }));
    }
    
    renderBuilderProfileSelect();
    
    // Auto-load first profile into builder
    if (profiles.length) {
      loadBuilderFromProfile(profiles[0]);
      addLog(`✓ Loaded ${profiles.length} flow(s)`, 'info');
    } else {
      addLog('No saved flows found. Create one in the Builder tab.', 'warn');
    }
    
    await loadEndpointDocs();
  } catch (e) {
    addLog('Failed to load profiles: ' + e.message, 'error');
    profiles = [];
    renderBuilderProfileSelect();
    // Retry after delay
    setTimeout(loadProfiles, 3000);
  }
}

function renderBuilderProfileSelect() {
  const sel = document.getElementById('builderProfileSelect');
  if (!sel) return;
  sel.innerHTML = profiles.length
    ? profiles.map(p => `<option value="${escAttr(p.slug)}">${escHtml(p.name)}</option>`).join('')
    : '<option value="">No saved flows</option>';
}

function loadSelectedBuilderProfile() {
  const slug = document.getElementById('builderProfileSelect')?.value;
  if (!slug) {
    addLog('No saved flow selected', 'warn');
    return;
  }
  const profile = profiles.find(p => p.slug === slug);
  if (!profile) {
    addLog('Selected flow not found', 'error');
    return;
  }
  loadBuilderFromProfile(profile);
  document.getElementById('builderName').value = profile.name;
  addLog(`Loaded flow "${profile.name}"`, 'info');
}

// ── Update the active flow indicator in the Automation tab ──
function updateActiveFlowIndicator(name) {
  const el = document.getElementById('activeFlowName');
  if (el) el.textContent = name || '—';
  const endpointEl = document.getElementById('activeFlowEndpoint');
  if (endpointEl) {
    const profile = profiles.find(p => p.name === name);
    endpointEl.textContent = profile?.slug ? `/run/${profile.slug}` : '—';
  }
}

async function loadEndpointDocs() {
  const el = document.getElementById('endpointsList');
  if (!el) return;
  try {
    const r = await fetch('/endpoints');
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to load docs');
    if (!data.endpoints || !data.endpoints.length) {
      el.textContent = 'No saved endpoints found.';
      return;
    }
    el.textContent = data.endpoints.map(item => `${item.name} → ${item.endpoint}${item.url ? ` (starts ${item.url})` : ''}`).join('\n');
  } catch (e) {
    el.textContent = 'Unable to load endpoint docs.';
    addLog('Failed to load endpoint docs: ' + e.message, 'error');
  }
}

// ── AUTOMATION ────────────────────────────────────────────
async function runAutomation() {
  const profileName = document.getElementById('builderName').value.trim();
  const prompt = document.getElementById('promptInput').value.trim();

  if (!profileName) {
    addLog('No flow loaded. Go to the Builder tab, create or load a flow, then come back to run it.', 'warn');
    return;
  }
  if (!prompt) {
    addLog('Enter a prompt first', 'warn');
    return;
  }

  addLog(`▶ Run "${profileName}" — "${prompt.substring(0, 40)}..."`, 'info');
  addLog(`📝 Prompt: "${prompt.substring(0, 60)}${prompt.length > 60 ? '...' : ''}"`, 'info');
  setRunning(true);
  try {
    const r = await fetch('/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: profileName, prompt })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed');
  } catch (e) {
    addLog('Error: ' + e.message, 'error');
    setRunning(false);
  }
}

async function stopAutomation() {
  await fetch('/stop', { method: 'POST' });
  addLog('Stop requested', 'warn');
}

function setRunning(running) {
  isRunning = running;
  document.getElementById('runBtn').disabled = running;
  document.getElementById('stopBtn').disabled = !running;
  const badge = document.getElementById('runningBadge');
  badge.style.display = running ? 'inline-block' : 'none';
  if (!running) hideProgress();
}

function updateProgress(current, total, label) {
  const wrap = document.getElementById('progressWrap');
  wrap.style.display = 'block';
  const pct = Math.round((current / total) * 100);
  document.getElementById('progressBar').style.width = pct + '%';
  document.getElementById('progressLabel').textContent = `${current}/${total}: ${label}`;
}

function hideProgress() {
  document.getElementById('progressWrap').style.display = 'none';
}

function setResponse(text) {
  const box = document.getElementById('responseBox');
  box.textContent = text;
  box.scrollTop = box.scrollHeight;
}

async function copyResponse() {
  const text = document.getElementById('responseBox')?.textContent || '';
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      addLog('Response copied', 'info');
      return;
    } catch (e) {
      addLog('Clipboard API failed: ' + (e && e.message ? e.message : e), 'warn');
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand && document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) addLog('Response copied (fallback)', 'info');
    else addLog('Copy failed', 'error');
  } catch (e) {
    addLog('Copy failed: ' + (e && e.message ? e.message : e), 'error');
  }
}

// ── BUILDER ───────────────────────────────────────────────
function loadBuilderFromProfile(profile) {
  document.getElementById('builderName').value = profile.name || '';
  document.getElementById('builderUrl').value = profile.url || '';
  builderSteps = JSON.parse(JSON.stringify(profile.steps || []));
  renderStepsList();
  renderBuilderMarkers();
  // Keep automation tab in sync
  updateActiveFlowIndicator(profile.name);
}

function loadBuilderProfile() {
  const name = document.getElementById('builderName').value.trim();
  const p = profiles.find(p => p.name === name);
  if (p) loadBuilderFromProfile(p);
  else addLog(`Profile "${name}" not found`, 'warn');
}

async function saveBuilderProfile() {
  const name = document.getElementById('builderName').value.trim();
  const url = document.getElementById('builderUrl').value.trim();
  if (!name) { addLog('Enter a profile name', 'warn'); return; }
  if (builderSteps.length === 0) { addLog('Add steps before saving', 'warn'); return; }
  const payload = { name, url, steps: builderSteps };
  const r = await fetch('/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (r.ok) {
    const stepCount = builderSteps.length;
    addLog(`✓ Profile "${name}" saved with ${stepCount} step(s)`, 'success');
    addLog(`📋 Switch to Automation tab, enter a prompt, and click Run to execute`, 'info');
    await loadProfiles();
    // Re-select the just-saved profile in the builder dropdown
    const sel = document.getElementById('builderProfileSelect');
    if (sel) {
      const saved = profiles.find(p => p.name === name);
      if (saved) sel.value = saved.slug;
    }
    // Update the automation tab indicator
    updateActiveFlowIndicator(name);
  } else {
    addLog('Failed to save profile', 'error');
}

async function saveAsEndpoint() {
  const name = document.getElementById('builderName').value.trim();
  const url = document.getElementById('builderUrl').value.trim();
  if (!name) { addLog('Enter an endpoint name', 'warn'); return; }
  if (builderSteps.length === 0) { addLog('Add steps before creating endpoint', 'warn'); return; }
  const payload = { name, url, steps: builderSteps };
  const r = await fetch('/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (r.ok) {
    const stepCount = builderSteps.length;
    const result = await r.json();
    const profile = profiles.find(p => p.slug === result.slug || p.name === name);
    addLog(`✓ Endpoint "${name}" created with ${stepCount} step(s) ready to execute`, 'success');
    if (profile) {
      updateProfileEndpoint(profile);
      addLog(`🔗 API Endpoint: POST/GET /run/${profile.slug}?prompt=<your-prompt>`, 'info');
      addLog(`These ${stepCount} step(s) will execute when the endpoint is called`, 'info');
    }
    await loadProfiles();
  } else {
    addLog('Failed to create endpoint', 'error');
  }
}

async function deleteBuilderProfile() {
  const name = document.getElementById('builderName').value.trim();
  if (!name || !confirm(`Delete profile "${name}"?`)) return;
  await fetch('/profiles/' + encodeURIComponent(name), { method: 'DELETE' });
  addLog(`Profile "${name}" deleted`, 'warn');
  await loadProfiles();
  builderSteps = [];
  renderStepsList();
  updateActiveFlowIndicator('');
}

function addBuilderStep(bx, by, px, py) {
  const action = document.getElementById('builderDefaultAction')?.value || 'click';
  const step = {
    id: Date.now(),
    action,
    x: bx,
    y: by,
    label: `${action === 'copy' ? 'Copy output' : action === 'goto' ? 'Goto' : 'Click'} (${bx}, ${by})`
  };
  builderSteps.push(step);
  renderStepsList();
  renderBuilderMarkers();
  openStepEditor(builderSteps.length - 1);
  showRipple(px, py);
}

function addManualStep() {
  const step = { id: Date.now(), action: 'wait', ms: 1000, label: 'Wait' };
  builderSteps.push(step);
  renderStepsList();
  openStepEditor(builderSteps.length - 1);
}

function renderStepsList() {
  const list = document.getElementById('stepsList');
  list.innerHTML = '';
  builderSteps.forEach((step, i) => {
    const el = document.createElement('div');
    el.className = 'step-item' + (selectedStepIdx === i ? ' selected' : '');
    el.dataset.idx = i;
    el.innerHTML = `
      <span class="step-drag">⠿</span>
      <span class="step-num">${i + 1}</span>
      <span class="step-action">${escHtml(step.action)}</span>
      <span class="step-lbl">${escHtml(step.label || getStepSummary(step))}</span>
      <button class="step-del" onclick="deleteStep(${i}, event)" title="Delete">✕</button>
    `;
    el.addEventListener('click', () => openStepEditor(i));
    list.appendChild(el);
  });
  if (sortable) sortable.destroy();
  sortable = Sortable.create(list, {
    handle: '.step-drag',
    animation: 150,
    onEnd: e => {
      const moved = builderSteps.splice(e.oldIndex, 1)[0];
      builderSteps.splice(e.newIndex, 0, moved);
      selectedStepIdx = e.newIndex;
      renderStepsList();
      renderBuilderMarkers();
    }
  });
}

function deleteStep(i, e) {
  e.stopPropagation();
  builderSteps.splice(i, 1);
  if (selectedStepIdx === i) { selectedStepIdx = null; closeStepEditor(); }
  else if (selectedStepIdx > i) selectedStepIdx--;
  renderStepsList();
  renderBuilderMarkers();
}

function getStepSummary(step) {
  switch (step.action) {
    case 'click': return `(${step.x}, ${step.y})`;
    case 'type': return step.text ? step.text.substring(0, 30) : '';
    case 'send': return step.text ? `Send: "${step.text.substring(0,20)}..."` : 'Send (Enter)';
    case 'keypress': return step.key;
    case 'wait': return step.ms + 'ms';
    case 'scroll': return `ΔY ${step.deltaY}`;
    case 'waitSelector':
    case 'waitSelectorGone':
    case 'copy':
    case 'read': return step.selector || step.targetSelector || '';
    case 'goto':
    case 'navigate': return step.url || '';
    case 'evaluate': return 'JS';
    default: return '';
  }
}

// ── BUILDER MARKERS ──────────────────────────────────────
function renderBuilderMarkers() {
  const container = document.getElementById('builderMarkers');
  container.innerHTML = '';
  if (!builderMode) return;
  const img = document.getElementById('liveFrame');
  const rect = img.getBoundingClientRect();
  const parentRect = img.parentElement.getBoundingClientRect();
  if (!rect.width) return;
  const scaleX = rect.width / BROWSER_W;
  const scaleY = rect.height / BROWSER_H;
  const clickSteps = builderSteps.filter(s => ['click', 'scroll', 'read', 'copy'].includes(s.action) && s.x !== undefined);
  clickSteps.forEach((step, seq) => {
    const globalIdx = builderSteps.indexOf(step);
    const px = (rect.left - parentRect.left) + step.x * scaleX;
    const py = (rect.top - parentRect.top) + step.y * scaleY;
    const m = document.createElement('div');
    m.className = 'marker' + (selectedStepIdx === globalIdx ? ' selected' : '');
    m.style.left = px + 'px';
    m.style.top = py + 'px';
    m.textContent = globalIdx + 1;
    m.title = step.label || step.action;
    let dragging = false;
    m.addEventListener('mousedown', e => {
      e.stopPropagation();
      dragging = true;
      openStepEditor(globalIdx);
      const onMove = ev => {
        if (!dragging) return;
        const imgRect = img.getBoundingClientRect();
        const relX = ev.clientX - imgRect.left;
        const relY = ev.clientY - imgRect.top;
        const bx = Math.round(Math.max(0, Math.min(BROWSER_W, relX / scaleX)));
        const by = Math.round(Math.max(0, Math.min(BROWSER_H, relY / scaleY)));
        builderSteps[globalIdx].x = bx;
        builderSteps[globalIdx].y = by;
        m.style.left = (imgRect.left - parentRect.left + relX) + 'px';
        m.style.top = (imgRect.top - parentRect.top + relY) + 'px';
        const ex = document.getElementById('edit-x');
        const ey = document.getElementById('edit-y');
        if (ex) ex.value = bx;
        if (ey) ey.value = by;
      };
      const onUp = () => {
        dragging = false;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        renderStepsList();
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
    container.appendChild(m);
  });
}

// ── STEP EDITOR ───────────────────────────────────────────
function openStepEditor(idx) {
  selectedStepIdx = idx;
  const step = builderSteps[idx];
  const editor = document.getElementById('stepEditor');
  editor.style.display = 'flex';
  document.getElementById('editStepNum').textContent = '#' + (idx + 1);
  document.getElementById('editAction').value = step.action;
  document.getElementById('editLabel').value = step.label || '';
  renderStepEditorFields();
  renderStepsList();
}

function closeStepEditor() {
  selectedStepIdx = null;
  document.getElementById('stepEditor').style.display = 'none';
  renderStepsList();
}

function renderStepEditorFields() {
  const action = document.getElementById('editAction').value;
  const step = selectedStepIdx !== null ? builderSteps[selectedStepIdx] : {};
  const fields = document.getElementById('editActionFields');
  let html = '';
  switch (action) {
    case 'click':
    case 'read':
      html = `
        <div class="edit-row">
          <div><label>X</label><input id="edit-x" type="number" value="${step.x || 0}" /></div>
          <div><label>Y</label><input id="edit-y" type="number" value="${step.y || 0}" /></div>
        </div>
        ${action === 'read' ? `<div><label>Selector (optional)</label><input id="edit-selector" type="text" value="${escAttr(step.selector || '')}" /></div>` : ''}
      `;
      break;
    case 'scroll':
      html = `
        <div class="edit-row">
          <div><label>X</label><input id="edit-x" type="number" value="${step.x || 640}" /></div>
          <div><label>Y</label><input id="edit-y" type="number" value="${step.y || 360}" /></div>
        </div>
        <div class="edit-row">
          <div><label>Delta X</label><input id="edit-deltaX" type="number" value="${step.deltaX || 0}" /></div>
          <div><label>Delta Y</label><input id="edit-deltaY" type="number" value="${step.deltaY || 300}" /></div>
        </div>
      `;
      break;
    case 'type':
      html = `
        <div><label>Text (use {{prompt}} for dynamic prompt)</label>
          <textarea id="edit-text" rows="3">${escHtml(step.text || '')}</textarea>
        </div>
        <div><label>Delay (ms per char)</label><input id="edit-delay" type="number" value="${step.delay || 30}" /></div>
      `;
      break;
    case 'send':
      html = `
        <div><label>Text (use {{prompt}} for dynamic prompt)</label>
          <textarea id="edit-text" rows="3">${escHtml(step.text || '')}</textarea>
        </div>
        <div><label>Delay (ms per char)</label><input id="edit-delay" type="number" value="${step.delay || 30}" /></div>
        <div><label><input id="edit-monitorDeepSeek" type="checkbox" ${step.monitorDeepSeek ? 'checked' : ''} /> Monitor DeepSeek response after send</label></div>
        <div><label><input id="edit-monitorQwen" type="checkbox" ${step.monitorQwen ? 'checked' : ''} /> Monitor Qwen response after send</label></div>
        <div style="font-size:11px;color:#888;margin-top:4px">💡 This will type the text (if any) then press Enter.</div>
      `;
      break;
    case 'keypress':
      html = `<div><label>Key</label><input id="edit-key" type="text" value="${escAttr(step.key || 'Enter')}" /></div>`;
      break;
    case 'wait':
      html = `<div><label>Milliseconds</label><input id="edit-ms" type="number" value="${step.ms || 1000}" /></div>`;
      break;
    case 'waitSelector':
    case 'waitSelectorGone':
      html = `
        <div><label>CSS Selector</label><input id="edit-selector" type="text" value="${escAttr(step.selector || '')}" /></div>
        <div><label>Timeout (ms)</label><input id="edit-timeout" type="number" value="${step.timeout || 30000}" /></div>
        ${action === 'waitSelector' ? `<div><label><input id="edit-optional" type="checkbox" ${step.optional ? 'checked' : ''} /> Optional</label></div>` : ''}
      `;
      break;
    case 'copy':
      html = `
        <div><label>Click selector (optional)</label><input id="edit-selector" type="text" value="${escAttr(step.selector || '')}" /></div>
        <div><label>Result selector</label><input id="edit-targetSelector" type="text" value="${escAttr(step.targetSelector || '')}" /></div>
        <div class="edit-row">
          <div><label>X</label><input id="edit-x" type="number" value="${step.x || 0}" /></div>
          <div><label>Y</label><input id="edit-y" type="number" value="${step.y || 0}" /></div>
        </div>
        <div class="edit-row">
          <div><label>Wait after click (ms)</label><input id="edit-waitMs" type="number" value="${step.waitMs || 600}" /></div>
          <div><label>Polling</label><input id="edit-polling" type="checkbox" ${step.polling ? 'checked' : ''} /></div>
        </div>
      `;
      break;
    case 'navigate':
      html = `<div><label>URL</label><input id="edit-url" type="text" value="${escAttr(step.url || '')}" /></div>`;
      break;
    case 'evaluate':
      html = `<div><label>JavaScript</label><textarea id="edit-script" rows="4" style="font-family:monospace">${escHtml(step.script || '')}</textarea></div>`;
      break;
  }
  fields.innerHTML = html;
}

function saveStepEdit() {
  if (selectedStepIdx === null) return;
  const action = document.getElementById('editAction').value;
  const label = document.getElementById('editLabel').value;
  const step = { ...builderSteps[selectedStepIdx], action, label };
  const g = id => { const el = document.getElementById(id); return el ? el.value : undefined; };
  const gn = id => { const v = g(id); return v !== undefined ? Number(v) : undefined; };
  const gb = id => { const el = document.getElementById(id); return el ? el.checked : false; };
  switch (action) {
    case 'click':
      step.x = gn('edit-x'); step.y = gn('edit-y'); break;
    case 'scroll':
      step.x = gn('edit-x'); step.y = gn('edit-y');
      step.deltaX = gn('edit-deltaX'); step.deltaY = gn('edit-deltaY'); break;
    case 'type':
      step.text = g('edit-text'); step.delay = gn('edit-delay'); break;
    case 'send':
      step.text = g('edit-text'); step.delay = gn('edit-delay');
      step.monitorDeepSeek = gb('edit-monitorDeepSeek');
      step.monitorQwen = gb('edit-monitorQwen');
      break;
    case 'keypress':
      step.key = g('edit-key'); break;
    case 'wait':
      step.ms = gn('edit-ms'); break;
    case 'waitSelector':
      step.selector = g('edit-selector'); step.timeout = gn('edit-timeout'); step.optional = gb('edit-optional'); break;
    case 'waitSelectorGone':
      step.selector = g('edit-selector'); step.timeout = gn('edit-timeout'); break;
    case 'copy':
      step.selector = g('edit-selector');
      step.targetSelector = g('edit-targetSelector');
      step.x = gn('edit-x');
      step.y = gn('edit-y');
      step.waitMs = gn('edit-waitMs');
      step.polling = gb('edit-polling');
      break;
    case 'read':
      step.selector = g('edit-selector');
      step.x = gn('edit-x'); step.y = gn('edit-y');
      break;
    case 'navigate':
      step.url = g('edit-url'); break;
    case 'evaluate':
      step.script = g('edit-script'); break;
  }
  builderSteps[selectedStepIdx] = step;
  renderStepsList();
  renderBuilderMarkers();
  addLog(`Step ${selectedStepIdx + 1} updated`, 'info');
}

// ── LOGS ──────────────────────────────────────────────────
function addLog(message, level = 'info') {
  const box = document.getElementById('logBox');
  const entry = document.createElement('div');
  entry.className = `log-entry ${level}`;
  const time = new Date().toLocaleTimeString('en', { hour12: false });
  entry.innerHTML = `<span class="log-time">${time}</span>${escHtml(message)}`;
  if (box) {
    box.appendChild(entry);
    if (document.getElementById('autoScrollLog')?.checked) box.scrollTop = box.scrollHeight;
    while (box.children.length > 500) box.removeChild(box.firstChild);
  }
  const fbox = document.getElementById('floatingLogBox');
  if (fbox) {
    const fentry = entry.cloneNode(true);
    fbox.appendChild(fentry);
    fbox.scrollTop = fbox.scrollHeight;
    while (fbox.children.length > 500) fbox.removeChild(fbox.firstChild);
  }
}

function clearLogs() {
  document.getElementById('logBox').innerHTML = '';
}

// ── UTILS ─────────────────────────────────────────────────
function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(s) {
  return String(s || '').replace(/"/g, '&quot;');
}

window.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    fetch('/reset', { method: 'POST' })
      .then(() => {
        setRunning(false);
        addLog('🔄 State reset via Ctrl+K', 'warn');
      })
      .catch(err => addLog('Reset failed: ' + err.message, 'error'));
  }
});

// Expose handlers to the global `window` so inline `onclick` attributes work
try {
  Object.assign(window, {
    navigate,
    sendManualKey,
    refreshScreenshot,
    toggleLive,
    runAutomation,
    stopAutomation,
    copyResponse,
    loadSelectedBuilderProfile,
    saveBuilderProfile,
    saveAsEndpoint,
    loadBuilderProfile,
    deleteBuilderProfile,
    addManualStep
  });
} catch (e) {
  // If any of these functions are not defined yet, ignore — they'll be available after load
}