#!/usr/bin/env node
'use strict';

/**
 * Run the booth spotter against a screenshot without launching the overlay.
 * Handy for tuning prompts and checking cost/latency.
 *
 *   npm run spot -- path/to/screenshot.png
 *   npm run spot -- path/to/screenshot.png --ask "what do you think of this function?"
 */
const fs = require('node:fs');
const path = require('node:path');
const OpenAI = require('openai');
const { loadConfig, loadDotEnv } = require('../src/main/config');
const { getPersona } = require('../src/shared/personas');
const { Spotter } = require('../src/main/spotter');
const { formatCue, formatContext } = require('../src/main/prompts');

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const askIdx = args.indexOf('--ask');
  const question = askIdx >= 0 ? args[askIdx + 1] : null;
  if (!file) {
    console.error('usage: npm run spot -- <screenshot.(png|jpg)> [--ask "question"]');
    process.exit(2);
  }

  loadDotEnv(path.join(__dirname, '..'));
  const config = loadConfig();
  if (!config.apiKey) throw new Error('OPENAI_API_KEY is not set');

  const ext = path.extname(file).toLowerCase() === '.png' ? 'png' : 'jpeg';
  const imageDataUrl = `data:image/${ext};base64,${fs.readFileSync(file).toString('base64')}`;
  const spotter = new Spotter({
    client: new OpenAI({ apiKey: config.apiKey }),
    model: config.visionModel,
    persona: getPersona(config.persona),
    spice: config.spice,
    userName: config.userName,
    reasoning: config.visionReasoning,
    imageDetail: config.imageDetail,
  });

  const started = Date.now();
  if (question) {
    const answer = await spotter.answer({ imageDataUrl, question });
    console.log(JSON.stringify(answer, null, 2));
  } else {
    const notes = await spotter.analyze({ imageDataUrl });
    console.log(JSON.stringify(notes, null, 2));
    console.log('\nwould send as cue:     ', formatCue(notes));
    console.log('would send as context: ', formatContext(notes));
  }
  console.log(`\n${config.visionModel} took ${Date.now() - started} ms`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
