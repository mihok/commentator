'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toFingerprint, frameDifference, relativeRect } = require('../src/shared/frame-diff');
const { TranscriptLog, toInitialHistory } = require('../src/shared/transcript-log');
const { PERSONAS, getPersona } = require('../src/shared/personas');
const { buildLiveInstructions, formatCue, clip, CUE_TAG } = require('../src/main/prompts');

function bitmap(w, h, fill) {
  const b = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) b.set(fill(i % w, Math.floor(i / w)), i * 4);
  return b;
}

test('identical frames have zero difference', () => {
  const bmp = bitmap(8, 4, () => [10, 200, 30, 255]);
  const a = toFingerprint(bmp, 8, 4);
  assert.equal(frameDifference(a, toFingerprint(bmp, 8, 4)), 0);
});

test('difference is the fraction of changed pixels', () => {
  const dark = toFingerprint(bitmap(8, 4, () => [0, 0, 0, 255]), 8, 4);
  const halfLit = toFingerprint(
    bitmap(8, 4, (x) => (x < 4 ? [255, 255, 255, 255] : [0, 0, 0, 255])),
    8,
    4,
  );
  assert.equal(frameDifference(dark, halfLit), 0.5);
});

test('small luma shimmer is ignored', () => {
  const a = toFingerprint(bitmap(8, 4, () => [100, 100, 100, 255]), 8, 4);
  const b = toFingerprint(bitmap(8, 4, () => [105, 105, 105, 255]), 8, 4);
  assert.equal(frameDifference(a, b), 0);
});

test('masked regions (our own overlay) never count as change', () => {
  const masks = [{ x: 0.5, y: 0.5, width: 0.5, height: 0.5 }];
  const a = toFingerprint(bitmap(8, 4, () => [0, 0, 0, 255]), 8, 4, masks);
  const b = toFingerprint(
    bitmap(8, 4, (x, y) => (x >= 4 && y >= 2 ? [255, 255, 255, 255] : [0, 0, 0, 255])),
    8,
    4,
    masks,
  );
  assert.equal(frameDifference(a, b), 0);
});

test('mismatched or missing fingerprints count as fully changed', () => {
  assert.equal(frameDifference(null, new Uint8Array(4)), 1);
  assert.equal(frameDifference(new Uint8Array(4), new Uint8Array(8)), 1);
});

test('relativeRect maps window bounds onto a display', () => {
  const r = relativeRect({ x: 1500, y: 800, width: 400, height: 200 }, { x: 0, y: 0, width: 2000, height: 1000 });
  assert.deepEqual(r, { x: 0.75, y: 0.8, width: 0.2, height: 0.2 });
});

test('transcript log groups fragments into utterances by silence gap', () => {
  const log = new TranscriptLog({ gapMs: 1000 });
  log.add('Hello ', 0);
  log.add('there.', 500);
  log.add('New thought.', 3000);
  assert.equal(log.entries.length, 2);
  assert.equal(log.entries[0].text, 'Hello there.');
  assert.equal(log.recentText(10000, 3000), 'Hello there. / New thought.');
  assert.equal(log.recentText(1000, 3000), 'New thought.');
});

test('initial history interleaves speakers chronologically', () => {
  const user = new TranscriptLog();
  const asst = new TranscriptLog();
  asst.add('Welcome to the broadcast!', 0);
  user.add('Oh no, not you again.', 5000);
  asst.add('Oh yes.', 9000);
  const history = toInitialHistory(user, asst);
  assert.deepEqual(
    history.map((m) => [m.role, m.content[0].text]),
    [
      ['assistant', 'Welcome to the broadcast!'],
      ['user', 'Oh no, not you again.'],
      ['assistant', 'Oh yes.'],
    ],
  );
});

test('every persona has a voice, style and a complete live prompt', () => {
  for (const persona of Object.values(PERSONAS)) {
    assert.ok(persona.voice && persona.style && persona.name);
    const prompt = buildLiveInstructions({ persona, spice: 2, userName: 'Sam' });
    assert.match(prompt, new RegExp(persona.name.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&')));
    assert.match(prompt, /Sam/);
    assert.match(prompt, /delegate/);
  }
  assert.equal(getPersona('nope').id, 'biff');
});

test('cues are tagged and clipped under the append limit', () => {
  const cue = formatCue({ interest: 7, category: 'testing', cue: 'x'.repeat(5000), activity: 'Running jest' });
  assert.ok(cue.startsWith(CUE_TAG));
  assert.ok(cue.length <= 1200);
  assert.equal(clip('short'), 'short');
});
