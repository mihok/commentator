import { LiveConnection } from './live.js';

const $ = (id) => document.getElementById(id);
const els = {
  card: $('card'),
  name: $('persona-name'),
  state: $('state'),
  airtime: $('airtime'),
  hypeFill: $('hype-fill'),
  hypeValue: $('hype-value'),
  caption: $('caption'),
  you: $('you'),
  ticker: $('ticker-text'),
  chips: $('chips'),
  error: $('error'),
  mic: $('btn-mic'),
  cams: $('btn-cams'),
  hide: $('btn-hide'),
  quit: $('btn-quit'),
  audio: $('remote-audio'),
  eq: $('eq'),
};

const CAPTION_GAP_MS = 1500;
const CAPTION_LINGER_MS = 9000;

let conn = null;
let micOn = true;
let reconnectDelay = 1000;
let reconnectTimer = null;

// ---- captions -------------------------------------------------------------

function captioner(el, prefix = '') {
  let text = '';
  let lastAt = 0;
  let fadeTimer = null;
  return (delta) => {
    const now = performance.now();
    if (now - lastAt > CAPTION_GAP_MS) text = '';
    text += delta;
    lastAt = now;
    // Keep the tail of long lines readable in a small box.
    const shown = text.length > 220 ? '…' + text.slice(-220) : text;
    el.textContent = prefix + shown.trimStart();
    el.classList.add('visible');
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => el.classList.remove('visible'), CAPTION_LINGER_MS);
  };
}
const onCommentatorText = captioner(els.caption);
const onUserText = captioner(els.you, 'You: ');

// ---- speaking meter -----------------------------------------------------------

function watchLevels(stream) {
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  const bars = [...els.eq.children];
  const frame = () => {
    analyser.getByteFrequencyData(data);
    const step = Math.floor(data.length / (bars.length * 2));
    let total = 0;
    bars.forEach((bar, i) => {
      const v = data[i * step + 2] / 255;
      total += v;
      bar.style.transform = `scaleY(${0.15 + v * 0.85})`;
    });
    els.card.classList.toggle('speaking', total / bars.length > 0.12);
    requestAnimationFrame(frame);
  };
  frame();
}

// ---- status -------------------------------------------------------------------

function setState(label, cls) {
  els.state.textContent = label;
  els.state.className = `state ${cls}`;
}

function renderStatus(s) {
  const hype = Math.max(0, Math.min(10, s.hype ?? 0));
  els.hypeFill.style.width = `${hype * 10}%`;
  els.hypeFill.dataset.level = hype >= 8 ? 'high' : hype >= 5 ? 'mid' : 'low';
  els.hypeValue.textContent = hype;

  if (s.activity) els.ticker.textContent = `NOW PLAYING  ·  ${s.activity}`;

  const chips = [];
  if (s.paused) chips.push('CAMS OFF');
  if (s.quiet) chips.push('QUIET');
  if (!s.micOn) chips.push('MIC OFF');
  els.chips.replaceChildren(
    ...chips.map((c) => {
      const span = document.createElement('span');
      span.className = 'chip';
      span.textContent = c;
      return span;
    }),
  );

  micOn = s.micOn;
  els.mic.classList.toggle('off', !s.micOn);
  els.mic.title = s.micOn ? 'Mute your mic (Ctrl/Cmd+Alt+M)' : 'Unmute your mic (Ctrl/Cmd+Alt+M)';
  els.cams.classList.toggle('off', !!s.paused);
  els.cams.title = s.paused ? 'Turn booth cameras back on (Ctrl/Cmd+Alt+P)' : 'Pause screen watching (Ctrl/Cmd+Alt+P)';

  const secs = Math.floor(s.airSeconds || 0);
  els.airtime.textContent = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;

  if (s.connection === 'live') setState(s.paused ? 'CAMS OFF' : 'ON AIR', 'live');
  else if (s.connection === 'connecting') setState('WARMING UP', 'pending');
  else if (s.connection === 'reconnecting') setState('TECHNICAL DIFFICULTIES', 'pending');
  else setState('OFF AIR', 'off');

  els.error.textContent = s.error || '';
  els.error.classList.toggle('visible', !!s.error);
}

// ---- connection -------------------------------------------------------------------

async function connect() {
  clearTimeout(reconnectTimer);
  conn = new LiveConnection({ exchangeSdp: window.booth.createSession, audioElement: els.audio });

  conn.addEventListener('remote-stream', (e) => watchLevels(e.detail), { once: true });
  conn.addEventListener('server-event', (e) => {
    const event = e.detail;
    if (event.type === 'session.output_transcript.delta') onCommentatorText(event.delta);
    else if (event.type === 'session.input_transcript.delta') onUserText(event.delta);
    window.booth.forwardEvent(event);
    if (event.type === 'session.started') {
      reconnectDelay = 1000;
      if (conn?.micError) {
        window.booth.reportError(
          `No microphone (${conn.micError.name}): commentary only, no banter. Check mic permissions and restart.`,
        );
      }
    }
  });
  conn.addEventListener('closed', (e) => {
    const { reason } = e.detail;
    conn?.close();
    conn = null;
    if (reason === 'close_requested') {
      window.booth.setConnection('closed');
      return;
    }
    // Sessions have a maximum duration ("expired") and networks drop. Come back.
    window.booth.setConnection('reconnecting');
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  });

  try {
    await conn.connect({ micOn });
  } catch (err) {
    console.error('connect failed', err);
    const message = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    window.booth.reportError(message.startsWith('Could not start') ? message : `Could not reach GPT-Live: ${message}`);
    conn?.close();
    conn = null;
    window.booth.setConnection('reconnecting');
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  }
}

// ---- boot -----------------------------------------------------------------------

async function main() {
  const init = await window.booth.init();
  els.name.textContent = init.persona.name;
  els.name.title = init.persona.tagline;
  micOn = init.micOnAtStart;

  els.mic.addEventListener('click', () => window.booth.command('toggle-mic'));
  els.cams.addEventListener('click', () => window.booth.command('toggle-pause'));
  els.hide.addEventListener('click', () => window.booth.command('toggle-visible'));
  els.quit.addEventListener('click', () => window.booth.command('quit'));

  window.booth.onStatus(renderStatus);
  window.booth.onSend((event) => conn?.send(event));
  window.booth.onMic((on) => {
    micOn = on;
    conn?.setMic(on);
  });

  renderStatus({ micOn, connection: 'idle', error: init.error });
  if (init.error) return;
  connect();
}

main();
