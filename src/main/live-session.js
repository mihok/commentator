'use strict';

const { buildLiveInstructions } = require('./prompts');

/**
 * Exchanges the renderer's WebRTC SDP offer for a GPT-Live session.
 * Runs in the main process so the API key never reaches the renderer.
 *
 * POST /v1/live/sessions
 *   { session: { model, instructions, audio: { output: { voice } }, delegation, input }, transport: { type: 'webrtc', sdp } }
 * -> { session: { id }, transport: { type: 'webrtc', sdp } }
 */
async function createLiveSession({ client, config, persona, offerSdp, history = [] }) {
  const session = {
    model: config.liveModel,
    instructions: buildLiveInstructions({ persona, spice: config.spice, userName: config.userName }),
    audio: { output: { voice: config.voice } },
    // Client delegation: when the user asks about the screen, GPT-Live emits
    // session.delegation.created and the director answers with the spotter.
    delegation: { type: 'client', acknowledgement_delay_ms: 300 },
    // The frontend only needs to send our cue/context/mute events and receive
    // transcripts, delegations, lifecycle and errors.
    client: {
      data_channel: {
        allowed_client_events: [
          'session.commentary.append',
          'session.thinking.append',
          'session.instructions.append',
          'session.input_audio.mute',
          'session.input_audio.unmute',
          'session.close',
        ],
        allowed_server_events: 'all',
      },
    },
  };
  if (history.length) session.input = history;

  const res = await client.live.create({ session, transport: { type: 'webrtc', sdp: offerSdp } });
  return { sessionId: res.session.id, answerSdp: res.transport.sdp };
}

module.exports = { createLiveSession };
