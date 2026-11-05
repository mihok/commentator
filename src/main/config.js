'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PERSONAS, DEFAULT_PERSONA } = require('../shared/personas');
const { DEFAULTS } = require('./director');

function loadDotEnv(dir) {
  const file = path.join(dir, '.env');
  if (fs.existsSync(file) && typeof process.loadEnvFile === 'function') process.loadEnvFile(file);
}

function num(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

function oneOf(env, name, allowed, fallback) {
  const raw = (env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (!allowed.includes(raw)) throw new Error(`${name} must be one of ${allowed.join(', ')}; got "${raw}"`);
  return raw;
}

function loadConfig(env = process.env) {
  const persona = oneOf(env, 'COMMENTATOR_PERSONA', Object.keys(PERSONAS), DEFAULT_PERSONA);
  const spice = Math.max(1, Math.min(3, Math.round(num(env, 'COMMENTATOR_SPICE', 2))));
  const reasoning = env.COMMENTATOR_VISION_REASONING;

  return {
    apiKey: env.OPENAI_API_KEY || '',
    liveModel: env.COMMENTATOR_LIVE_MODEL || 'gpt-live-1',
    visionModel: env.COMMENTATOR_VISION_MODEL || 'gpt-5.4-mini',
    visionReasoning: reasoning === undefined ? 'low' : reasoning.trim() || null,
    imageDetail: oneOf(env, 'COMMENTATOR_IMAGE_DETAIL', ['low', 'high', 'auto'], 'auto'),
    persona,
    voice: env.COMMENTATOR_VOICE || PERSONAS[persona].voice,
    spice,
    userName: (env.COMMENTATOR_USER_NAME || '').trim() || null,
    display: oneOf(env, 'COMMENTATOR_DISPLAY', ['cursor', 'primary'], 'cursor'),
    corner: oneOf(env, 'COMMENTATOR_CORNER', ['top-left', 'top-right', 'bottom-left', 'bottom-right'], 'bottom-right'),
    micOnAtStart: oneOf(env, 'COMMENTATOR_MIC', ['on', 'off'], 'on') === 'on',
    captureWidth: num(env, 'COMMENTATOR_CAPTURE_WIDTH', 1440),
    director: {
      captureIntervalMs: num(env, 'COMMENTATOR_CAPTURE_INTERVAL_MS', DEFAULTS.captureIntervalMs),
      minAnalysisGapMs: num(env, 'COMMENTATOR_MIN_ANALYSIS_GAP_MS', DEFAULTS.minAnalysisGapMs),
      minGapMs: num(env, 'COMMENTATOR_MIN_GAP_MS', DEFAULTS.minGapMs),
      banterQuietMs: num(env, 'COMMENTATOR_BANTER_QUIET_MS', DEFAULTS.banterQuietMs),
      idleRoastMs: num(env, 'COMMENTATOR_IDLE_ROAST_MS', DEFAULTS.idleRoastMs),
      changeThreshold: num(env, 'COMMENTATOR_CHANGE_THRESHOLD', DEFAULTS.changeThreshold),
      interestThreshold: num(env, 'COMMENTATOR_INTEREST_THRESHOLD', DEFAULTS.interestThreshold),
      quietMs: num(env, 'COMMENTATOR_QUIET_MS', DEFAULTS.quietMs),
    },
  };
}

module.exports = { loadConfig, loadDotEnv };
