'use strict';

const {
  SPOTTER_SCHEMA,
  ANSWER_SCHEMA,
  buildSpotterInstructions,
  buildAnswerInstructions,
} = require('./prompts');

/**
 * The booth's eyes. GPT-Live cannot take image input, so a vision-capable
 * Responses model looks at screenshots and returns structured notes that the
 * director forwards to GPT-Live as commentary or silent context.
 *
 * Has no Electron dependency so it can be driven from scripts/spot.js.
 */
class Spotter {
  constructor({ client, model, persona, spice, userName, reasoning = 'low', imageDetail = 'auto' }) {
    this.client = client;
    this.model = model;
    this.reasoning = reasoning;
    this.imageDetail = imageDetail;
    this.spotterInstructions = buildSpotterInstructions({ persona, spice, userName });
    this.answerInstructions = buildAnswerInstructions({ persona, spice, userName });
  }

  /**
   * @returns {Promise<{activity:string, change:string, category:string, interest:number, sensitive:boolean, cue:string}>}
   */
  async analyze({ imageDataUrl, previousSummary, recentCommentary, recentUserSpeech, idleMs, signal }) {
    const context = [
      `Previous summary: ${previousSummary || '(none, the broadcast just started)'}`,
      `Commentator's recent lines: ${recentCommentary || '(none yet)'}`,
      `What the engineer recently said: ${recentUserSpeech || '(nothing)'}`,
      idleMs
        ? `The screen has barely changed for ${Math.round(idleMs / 1000)} seconds. A long stare at the same screen is commentary-worthy in itself (a staring contest with a bug, deep thought, a snack break).`
        : null,
    ]
      .filter(Boolean)
      .join('\n');

    const notes = await this.#ask({
      instructions: this.spotterInstructions,
      text: context,
      imageDataUrl,
      name: 'booth_notes',
      schema: SPOTTER_SCHEMA,
      signal,
    });
    notes.interest = Math.max(0, Math.min(10, Math.round(Number(notes.interest) || 0)));
    return notes;
  }

  /** Answer a question the engineer asked the commentator live on air. */
  async answer({ imageDataUrl, question, previousSummary, signal }) {
    const text = [
      `What the engineer just said to the commentator: ${question || '(could not make it out; answer about what is on screen)'}`,
      `Your previous summary of the screen: ${previousSummary || '(none)'}`,
    ].join('\n');
    return this.#ask({
      instructions: this.answerInstructions,
      text,
      imageDataUrl,
      name: 'booth_answer',
      schema: ANSWER_SCHEMA,
      signal,
    });
  }

  async #ask({ instructions, text, imageDataUrl, name, schema, signal }) {
    const content = [{ type: 'input_text', text }];
    if (imageDataUrl) content.push({ type: 'input_image', image_url: imageDataUrl, detail: this.imageDetail });

    const response = await this.client.responses.create(
      {
        model: this.model,
        instructions,
        input: [{ role: 'user', content }],
        text: { format: { type: 'json_schema', name, schema, strict: true } },
        ...(this.reasoning ? { reasoning: { effort: this.reasoning } } : {}),
        max_output_tokens: 2000,
        store: false,
      },
      { signal },
    );
    const raw = response.output_text;
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`Spotter returned non-JSON output: ${String(raw).slice(0, 200)}`);
    }
  }
}

module.exports = { Spotter };
