'use strict';

const path = require('node:path');
const { app, BrowserWindow, ipcMain, globalShortcut, screen, session, systemPreferences } = require('electron');
const OpenAI = require('openai');

const { loadConfig, loadDotEnv } = require('./config');
const { getPersona } = require('../shared/personas');
const { toInitialHistory } = require('../shared/transcript-log');
const { Spotter } = require('./spotter');
const { Director } = require('./director');
const { createScreenCapture } = require('./screen');
const { createLiveSession } = require('./live-session');

const ROOT = path.join(__dirname, '..', '..');
const WINDOW = { width: 380, height: 230, margin: 16 };

const HOTKEYS = {
  'CommandOrControl+Alt+M': 'toggle-mic',
  'CommandOrControl+Alt+P': 'toggle-pause',
  'CommandOrControl+Alt+H': 'toggle-visible',
  'CommandOrControl+Alt+Q': 'quit',
};

// The commentator has to be able to talk before anyone clicks anything.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let config = null;
let configError = null;
let director = null;
let sessionCount = 0;
const ui = { micOn: true, connection: 'idle', airSeconds: 0, error: null };

const live = {
  ready: false,
  isReady() {
    return this.ready && !!win && !win.isDestroyed();
  },
  send(event) {
    if (win && !win.isDestroyed()) win.webContents.send('live:send', event);
  },
  sendCommentary(content, delegationId = null) {
    this.send({ type: 'session.commentary.append', content, delegation_id: delegationId, event_id: eventId() });
  },
  sendThinking(content) {
    this.send({ type: 'session.thinking.append', content, delegation_id: null, event_id: eventId() });
  },
};

function eventId() {
  return `evt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ---- window -------------------------------------------------------------

function cornerPosition(corner) {
  const { workArea } = screen.getPrimaryDisplay();
  const { width, height, margin } = WINDOW;
  const left = workArea.x + margin;
  const right = workArea.x + workArea.width - width - margin;
  const top = workArea.y + margin;
  const bottom = workArea.y + workArea.height - height - margin;
  return {
    'top-left': { x: left, y: top },
    'top-right': { x: right, y: top },
    'bottom-left': { x: left, y: bottom },
    'bottom-right': { x: right, y: bottom },
  }[corner];
}

function createWindow() {
  const pos = cornerPosition(config?.corner || 'bottom-right');
  win = new BrowserWindow({
    ...pos,
    width: WINDOW.width,
    height: WINDOW.height,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Keep the overlay out of its own screenshots (macOS / Windows).
  win.setContentProtection(true);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.showInactive());
  win.on('closed', () => {
    win = null;
    live.ready = false;
  });
}

// ---- status ---------------------------------------------------------------

function pushStatus() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('ui:status', { ...(director ? director.status() : {}), ...ui });
}

function setError(message) {
  ui.error = message;
  pushStatus();
}

// ---- commands ---------------------------------------------------------------

function runCommand(cmd) {
  switch (cmd) {
    case 'toggle-mic':
      ui.micOn = !ui.micOn;
      if (win) win.webContents.send('live:mic', ui.micOn);
      pushStatus();
      break;
    case 'toggle-pause':
      if (director) director.setPaused(!director.paused);
      break;
    case 'toggle-visible':
      if (!win) break;
      if (win.isVisible()) win.hide();
      else win.showInactive();
      break;
    case 'quit':
      live.send({ type: 'session.close', event_id: eventId() });
      setTimeout(() => app.quit(), 400);
      break;
    default:
      break;
  }
}

// ---- GPT-Live event routing ------------------------------------------------

function onLiveEvent(event) {
  if (!event || typeof event.type !== 'string' || !director) return;
  switch (event.type) {
    case 'session.started':
      live.ready = true;
      ui.connection = 'live';
      ui.error = null;
      director.onSessionStarted({ resumed: sessionCount > 1, userName: config.userName });
      director.start();
      break;
    case 'session.input_transcript.delta':
      director.onUserTranscript(event.delta);
      break;
    case 'session.output_transcript.delta':
      director.onAssistantTranscript(event.delta);
      break;
    case 'session.delegation.created':
      if (event.delegation?.target === 'client') director.onDelegation(event.delegation.id);
      break;
    case 'session.usage.updated':
      ui.airSeconds = event.usage?.seconds ?? ui.airSeconds;
      break;
    case 'session.closed':
      live.ready = false;
      ui.connection = 'closed';
      ui.airSeconds = event.usage?.seconds ?? ui.airSeconds;
      console.log(`[live] session closed: ${event.reason}`);
      break;
    case 'error':
      console.error('[live] error:', event.error?.code, event.error?.message);
      setError(event.error?.message || 'GPT-Live error');
      break;
    case 'info':
      console.log('[live] info:', event.code, event.message);
      break;
    default:
      return;
  }
  pushStatus();
}

// ---- boot -------------------------------------------------------------------

function setupPermissions() {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');
  if (process.platform === 'darwin') {
    systemPreferences.askForMediaAccess('microphone').catch(() => {});
    const screenStatus = systemPreferences.getMediaAccessStatus('screen');
    if (screenStatus !== 'granted') {
      console.warn(`[commentator] Screen Recording permission is "${screenStatus}". Grant it in System Settings.`);
    }
  }
}

function setupDirector() {
  const client = new OpenAI({ apiKey: config.apiKey });
  const persona = getPersona(config.persona);
  const spotter = new Spotter({
    client,
    model: config.visionModel,
    persona,
    spice: config.spice,
    userName: config.userName,
    reasoning: config.visionReasoning,
    imageDetail: config.imageDetail,
  });
  const capture = createScreenCapture({
    display: config.display,
    width: config.captureWidth,
    overlayBounds: () => (win && !win.isDestroyed() && win.isVisible() ? win.getBounds() : null),
  });
  director = new Director({ capture, spotter, live, options: config.director });
  director.on('status', pushStatus);
  director.on('error', ({ where, message }) => setError(`${where}: ${message}`));

  ipcMain.handle('live:create', async (_e, offerSdp) => {
    sessionCount += 1;
    ui.connection = 'connecting';
    pushStatus();
    const history = sessionCount > 1 ? toInitialHistory(director.userLog, director.assistantLog) : [];
    try {
      const { sessionId, answerSdp } = await createLiveSession({ client, config, persona, offerSdp, history });
      console.log(`[live] session ${sessionId} created (${config.liveModel}, voice ${config.voice})`);
      return answerSdp;
    } catch (err) {
      ui.connection = 'error';
      setError(`Could not start GPT-Live: ${err.message}`);
      throw err;
    }
  });
}

app.whenReady().then(() => {
  loadDotEnv(ROOT);
  try {
    config = loadConfig();
    if (!config.apiKey) configError = 'OPENAI_API_KEY is not set. Copy .env.example to .env and add your key.';
  } catch (err) {
    configError = err.message;
  }

  setupPermissions();
  createWindow();

  ipcMain.handle('app:init', () => {
    const persona = getPersona(config?.persona);
    return {
      persona: { name: persona.name, tagline: persona.tagline },
      voice: config?.voice,
      spice: config?.spice,
      micOnAtStart: config?.micOnAtStart ?? true,
      hotkeys: HOTKEYS,
      error: configError,
    };
  });
  ipcMain.on('live:event', (_e, event) => onLiveEvent(event));
  ipcMain.on('ui:command', (_e, cmd) => runCommand(cmd));
  ipcMain.on('ui:error', (_e, message) => setError(message));
  ipcMain.on('ui:connection', (_e, state) => {
    ui.connection = state;
    if (state !== 'live') live.ready = false;
    pushStatus();
  });

  if (configError) {
    ui.error = configError;
    return;
  }
  ui.micOn = config.micOnAtStart;
  setupDirector();

  for (const [accelerator, cmd] of Object.entries(HOTKEYS)) {
    if (!globalShortcut.register(accelerator, () => runCommand(cmd))) {
      console.warn(`[commentator] Could not register hotkey ${accelerator}`);
    }
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (director) director.stop();
});

app.on('window-all-closed', () => app.quit());
