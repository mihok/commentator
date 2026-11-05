'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Director } = require('../src/main/director');
const { CUE_TAG, CONTEXT_TAG } = require('../src/main/prompts');

const FP_A = new Uint8Array(100).fill(0);
const FP_B = new Uint8Array(100).fill(255);

function notes(overrides = {}) {
  return {
    activity: 'Editing auth.ts in VS Code',
    change: 'Opened auth.ts',
    category: 'coding',
    interest: 6,
    sensitive: false,
    cue: 'Opened auth.ts for the fourth time today; the file is winning.',
    ...overrides,
  };
}

/** A director wired to fakes, with a controllable clock. */
function setup({ frames = [FP_A], analyses = [notes()], options = {} } = {}) {
  let now = 1_000_000;
  const sent = [];
  let frameIdx = 0;
  let analysisIdx = 0;
  const spotterCalls = [];
  const director = new Director({
    clock: () => now,
    log: { error() {} },
    options: { delegationSettleMs: 0, ...options },
    capture: async () => ({
      fingerprint: frames[Math.min(frameIdx++, frames.length - 1)],
      toDataUrl: () => 'data:image/jpeg;base64,AAAA',
    }),
    spotter: {
      analyze: async (args) => {
        spotterCalls.push(args);
        return analyses[Math.min(analysisIdx++, analyses.length - 1)];
      },
      answer: async (args) => {
        spotterCalls.push(args);
        return { answer: 'That function does three things; it should do one.', sensitive: false };
      },
    },
    live: {
      isReady: () => true,
      sendCommentary: (content, delegationId) => sent.push({ kind: 'commentary', content, delegationId }),
      sendThinking: (content) => sent.push({ kind: 'thinking', content }),
    },
  });
  director.running = true; // drive ticks manually instead of via the interval
  return {
    director,
    sent,
    spotterCalls,
    advance: (ms) => {
      now += ms;
    },
    get now() {
      return now;
    },
  };
}

test('first frame is analyzed and an interesting moment is called on air', async () => {
  const t = setup();
  await t.director.tick();
  assert.equal(t.spotterCalls.length, 1);
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].kind, 'commentary');
  assert.equal(t.sent[0].delegationId, null);
  assert.ok(t.sent[0].content.startsWith(CUE_TAG));
});

test('dull moments become silent context, not speech', async () => {
  const t = setup({ analyses: [notes({ interest: 2 })] });
  await t.director.tick();
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].kind, 'thinking');
  assert.ok(t.sent[0].content.startsWith(CONTEXT_TAG));
});

test('an unchanged screen does not trigger another (paid) vision call', async () => {
  const t = setup({ frames: [FP_A, FP_A, FP_A] });
  await t.director.tick();
  t.advance(10_000);
  await t.director.tick();
  t.advance(10_000);
  await t.director.tick();
  assert.equal(t.spotterCalls.length, 1);
});

test('vision calls are rate limited even when the screen keeps changing', async () => {
  const t = setup({ frames: [FP_A, FP_B, FP_B], options: { minAnalysisGapMs: 8000 } });
  await t.director.tick();
  t.advance(4000);
  await t.director.tick(); // changed, but too soon
  assert.equal(t.spotterCalls.length, 1);
  t.advance(4000);
  await t.director.tick();
  assert.equal(t.spotterCalls.length, 2);
});

test('commentary respects the minimum gap between unprompted calls', async () => {
  const t = setup({ frames: [FP_A, FP_B], analyses: [notes(), notes({ interest: 6 })], options: { minGapMs: 20000 } });
  await t.director.tick();
  t.advance(9000);
  await t.director.tick();
  assert.deepEqual(
    t.sent.map((s) => s.kind),
    ['commentary', 'thinking'],
  );
});

test('big moments get through on half the gap', async () => {
  const t = setup({ frames: [FP_A, FP_B], analyses: [notes(), notes({ interest: 9 })], options: { minGapMs: 20000 } });
  await t.director.tick();
  t.advance(11000);
  await t.director.tick();
  assert.deepEqual(
    t.sent.map((s) => s.kind),
    ['commentary', 'commentary'],
  );
});

test('does not talk over the user: holds while they are bantering', async () => {
  const t = setup({ options: { banterQuietMs: 12000 } });
  t.director.onUserTranscript('Okay what is going on with this test');
  t.advance(3000);
  await t.director.tick();
  assert.equal(t.sent[0].kind, 'thinking');
});

test('"shut up" buys quiet time and "you can talk again" ends it', async () => {
  const t = setup({ frames: [FP_A, FP_B, FP_A], options: { quietMs: 300000, banterQuietMs: 0 } });
  t.director.onUserTranscript('Biff, please shut up for a bit.');
  assert.equal(t.director.status().quiet, true);
  t.advance(30000);
  await t.director.tick();
  assert.equal(t.sent[0].kind, 'thinking');

  t.advance(30000);
  t.director.onUserTranscript('Alright, you can talk again.');
  assert.equal(t.director.status().quiet, false);
  t.advance(30000);
  await t.director.tick();
  assert.equal(t.sent.at(-1).kind, 'commentary');
});

test('a frozen screen eventually gets roasted', async () => {
  const t = setup({ frames: [FP_A], analyses: [notes({ interest: 1 }), notes({ interest: 1, change: '' })], options: { idleRoastMs: 120000 } });
  await t.director.tick(); // first look: dull
  assert.equal(t.sent[0].kind, 'thinking');
  t.advance(125000);
  await t.director.tick();
  assert.equal(t.spotterCalls.length, 2);
  assert.ok(t.spotterCalls[1].idleMs >= 120000);
  assert.equal(t.sent.at(-1).kind, 'commentary');
  assert.match(t.sent.at(-1).content, /unchanged for 2 min/);
});

test('sensitive screens are never described on air', async () => {
  const t = setup({ analyses: [notes({ interest: 9, sensitive: true, cue: 'API key sk-123 visible' })] });
  await t.director.tick();
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].kind, 'thinking');
  assert.doesNotMatch(t.sent[0].content, /sk-123/);
  assert.equal(t.director.status().activity, 'Something private was on screen.');
});

test('privacy pause stops all capture', async () => {
  const t = setup();
  t.director.setPaused(true);
  await t.director.tick();
  assert.equal(t.spotterCalls.length, 0);
});

test('delegations are answered with the same delegation id and the user question', async () => {
  const t = setup();
  t.director.onUserTranscript('Hey, what do you think of this function?');
  await t.director.onDelegation('del_123');
  const reply = t.sent.at(-1);
  assert.equal(reply.kind, 'commentary');
  assert.equal(reply.delegationId, 'del_123');
  assert.match(reply.content, /three things/);
  assert.match(t.spotterCalls[0].question, /what do you think of this function/);
});

test('delegations while paused do not capture the screen', async () => {
  const t = setup();
  t.director.setPaused(true);
  await t.director.onDelegation('del_9');
  assert.equal(t.spotterCalls.length, 0);
  assert.equal(t.sent.at(-1).delegationId, 'del_9');
  assert.match(t.sent.at(-1).content, /cameras are off/);
});
