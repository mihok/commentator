'use strict';

const { EventEmitter } = require('node:events');
const { frameDifference } = require('../shared/frame-diff');
const { TranscriptLog } = require('../shared/transcript-log');
const { CUE_TAG, CONTEXT_TAG, formatCue, formatContext, PRIVATE_CONTEXT, clip } = require('./prompts');

const QUIET_PATTERN =
  /\b(shut up|be quiet|quiet down|stop talking|zip it|give it a rest|pipe down|enough commentary|stop commentating|not now)\b/i;
const RESUME_PATTERN =
  /\b(you can talk( again)?|talk again|start commentating|back on air|resume commentary|i missed you)\b/i;

const DEFAULTS = {
  captureIntervalMs: 4000,
  minAnalysisGapMs: 8000,
  minGapMs: 20000,
  banterQuietMs: 12000,
  idleRoastMs: 120000,
  changeThreshold: 0.035,
  interestThreshold: 5,
  quietMs: 300000,
  assistantTalkGuardMs: 2500,
  delegationSettleMs: 700,
};

/**
 * Decides when the commentator speaks.
 *
 * Every tick it grabs a cheap local fingerprint of the screen. Only when the
 * screen changed enough (or has been frozen long enough to roast) does it pay
 * for a vision call. The spotter's notes are then either sent to GPT-Live as a
 * spoken cue or as silent context, depending on how interesting the moment is
 * and whether anyone is mid-sentence.
 *
 * Dependencies are injected so the policy can be unit tested without Electron.
 *
 * @param {object} deps
 * @param {() => Promise<{fingerprint: Uint8Array, toDataUrl: () => string}>} deps.capture
 * @param {import('./spotter').Spotter} deps.spotter
 * @param {{ sendCommentary(text: string, delegationId: string|null): void,
 *           sendThinking(text: string): void, isReady(): boolean }} deps.live
 */
class Director extends EventEmitter {
  constructor({ capture, spotter, live, options = {}, clock = Date.now, log = console }) {
    super();
    this.capture = capture;
    this.spotter = spotter;
    this.live = live;
    this.opts = { ...DEFAULTS, ...options };
    this.now = clock;
    this.log = log;

    this.userLog = new TranscriptLog();
    this.assistantLog = new TranscriptLog();

    this.timer = null;
    this.running = false;
    this.paused = false; // privacy pause: no capture at all
    this.quietUntil = 0; // user asked for silence
    this.busy = false;

    this.lastFrame = null; // fingerprint from the previous tick
    this.lastAnalyzedFrame = null; // fingerprint the spotter last looked at
    this.lastChangeAt = this.now();
    this.lastAnalysisAt = 0;
    this.lastCueAt = 0;
    this.lastIdleCallAt = this.now();
    this.previousSummary = '';
    this.previousContextSent = false;
    this.hype = 0;
  }

  // ---- lifecycle -------------------------------------------------------

  start() {
    if (this.running) return;
    this.running = true;
    const t = this.now();
    this.lastChangeAt = t;
    this.lastIdleCallAt = t;
    this.timer = setInterval(() => this.tick().catch((err) => this.#error('tick', err)), this.opts.captureIntervalMs);
    this.#status();
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Called when a GPT-Live session is ready. Opens the broadcast. */
  onSessionStarted({ resumed = false, userName } = {}) {
    const who = userName || 'our engineer';
    const opener = resumed
      ? `${CUE_TAG} (hype 3/10, other): We are back from a short break in the broadcast. Welcome the folks at home back in one line.`
      : `${CUE_TAG} (hype 6/10, other): The broadcast is going live. Introduce yourself in one breath, welcome the folks at home to today's coding session, and give ${who} a quick tease before play begins.`;
    this.live.sendCommentary(opener, null);
    this.lastCueAt = this.now();
  }

  setPaused(paused) {
    this.paused = paused;
    if (!paused) {
      // Do not treat the time away as a frozen screen.
      this.lastFrame = null;
      this.lastChangeAt = this.now();
      this.lastIdleCallAt = this.now();
    }
    if (this.live.isReady()) {
      this.live.sendThinking(
        paused
          ? `${CONTEXT_TAG} (do not speak): The booth cameras are switched off for privacy. You cannot see anything until they come back on. If asked, say so.`
          : `${CONTEXT_TAG} (do not speak): The booth cameras are back on.`,
      );
    }
    this.#status();
  }

  // ---- inputs from the GPT-Live session --------------------------------

  onUserTranscript(delta) {
    const t = this.now();
    const entry = this.userLog.add(delta, t);
    if (!entry) return;
    if (RESUME_PATTERN.test(entry.text) && this.quietUntil) {
      this.quietUntil = 0;
      this.#status();
    } else if (QUIET_PATTERN.test(entry.text) && this.quietUntil < t) {
      this.quietUntil = t + this.opts.quietMs;
      this.#status();
    }
    this.emit('transcript', { role: 'user', text: entry.text, startedAt: entry.startedAt });
  }

  onAssistantTranscript(delta) {
    const entry = this.assistantLog.add(delta, this.now());
    if (entry) this.emit('transcript', { role: 'assistant', text: entry.text, startedAt: entry.startedAt });
  }

  /**
   * GPT-Live decided it needs the booth (e.g. "what do you think of this
   * code?"). The delegation carries no task text, so we infer the question
   * from what the user just said.
   */
  async onDelegation(delegationId) {
    await sleep(this.opts.delegationSettleMs);
    const question = this.userLog.recentText(20000, this.now(), 600);

    if (this.paused) {
      this.live.sendCommentary(
        'The booth cameras are off for privacy right now, so you cannot see the screen. Say so in character and offer to take a look once they turn the cameras back on.',
        delegationId,
      );
      return;
    }

    try {
      const frame = await this.capture();
      const result = await this.spotter.answer({
        imageDataUrl: frame.toDataUrl(),
        question,
        previousSummary: this.previousSummary,
      });
      const content = result.sensitive
        ? `The screen shows something private, so do not describe it. ${result.answer}`
        : result.answer;
      this.live.sendCommentary(clip(content), delegationId);
      this.lastCueAt = this.now();
    } catch (err) {
      this.#error('delegation', err);
      this.live.sendCommentary(
        'The replay booth is having technical difficulties and could not get a look. Admit it in character, briefly.',
        delegationId,
      );
    }
  }

  // ---- the loop --------------------------------------------------------

  async tick() {
    if (!this.running || this.paused || this.busy || !this.live.isReady()) return;
    this.busy = true;
    try {
      await this.#tick();
    } finally {
      this.busy = false;
    }
  }

  async #tick() {
    const frame = await this.capture();
    const t = this.now();

    if (this.lastFrame && frameDifference(frame.fingerprint, this.lastFrame) >= this.opts.changeThreshold) {
      this.lastChangeAt = t;
    }
    this.lastFrame = frame.fingerprint;

    const sinceAnalyzed = this.lastAnalyzedFrame ? frameDifference(frame.fingerprint, this.lastAnalyzedFrame) : 1;
    const idleMs = t - this.lastChangeAt;
    const idleCall = idleMs >= this.opts.idleRoastMs && t - this.lastIdleCallAt >= this.opts.idleRoastMs;
    const changed = sinceAnalyzed >= this.opts.changeThreshold;
    const analysisAllowed = t - this.lastAnalysisAt >= this.opts.minAnalysisGapMs;

    if (!analysisAllowed || (!changed && !idleCall)) return;

    this.lastAnalysisAt = t;
    this.lastAnalyzedFrame = frame.fingerprint;
    if (idleCall) this.lastIdleCallAt = t;

    const notes = await this.spotter.analyze({
      imageDataUrl: frame.toDataUrl(),
      previousSummary: this.previousSummary,
      recentCommentary: this.assistantLog
        .last(5)
        .map((e) => e.text.trim())
        .join(' / '),
      recentUserSpeech: this.userLog.recentText(60000, t),
      idleMs: idleCall ? idleMs : 0,
    });

    // The vision call takes a few seconds; re-read the clock and session state.
    if (!this.running || this.paused || !this.live.isReady()) return;

    this.previousSummary = notes.sensitive ? 'Something private was on screen.' : notes.activity;
    this.hype = notes.sensitive ? 0 : notes.interest;
    this.emit('notes', notes);

    if (notes.sensitive) {
      this.live.sendThinking(PRIVATE_CONTEXT);
      this.#status();
      return;
    }

    const decision = this.decide(notes, { idleCall });
    if (decision === 'speak') {
      this.live.sendCommentary(formatCue(notes, { idleMs: idleCall ? idleMs : 0 }), null);
      this.lastCueAt = this.now();
    } else if (notes.change || !this.previousContextSent) {
      this.live.sendThinking(formatContext(notes));
      this.previousContextSent = true;
    }
    this.#status();
  }

  /**
   * The pacing policy. Returns 'speak' or 'hold'.
   * Exposed for tests.
   */
  decide(notes, { idleCall = false } = {}) {
    const t = this.now();
    if (t < this.quietUntil) return 'hold';
    if (t - this.userLog.lastAt() < this.opts.banterQuietMs) return 'hold'; // let banter breathe
    if (t - this.assistantLog.lastAt() < this.opts.assistantTalkGuardMs) return 'hold'; // mid-sentence
    const big = notes.interest >= 8;
    const gap = big ? this.opts.minGapMs / 2 : this.opts.minGapMs;
    if (t - this.lastCueAt < gap) return 'hold';
    if (idleCall) return 'speak';
    return notes.interest >= this.opts.interestThreshold ? 'speak' : 'hold';
  }

  status() {
    const t = this.now();
    return {
      paused: this.paused,
      quiet: t < this.quietUntil,
      quietUntil: this.quietUntil,
      hype: this.hype,
      activity: this.previousSummary,
    };
  }

  #status() {
    this.emit('status', this.status());
  }

  #error(where, err) {
    this.log.error(`[director:${where}]`, err?.message || err);
    this.emit('error', { where, message: err?.message || String(err) });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { Director, DEFAULTS, QUIET_PATTERN, RESUME_PATTERN };
