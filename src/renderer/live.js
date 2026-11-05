/**
 * GPT-Live over WebRTC.
 *
 * Audio goes both ways on the media track (that is the STT + TTS layer: your
 * mic in, the commentator's voice out). Everything else (transcripts,
 * delegations, our cues) travels as JSON on the "oai-events" data channel.
 * The SDP exchange happens in the main process, which holds the API key.
 */
export class LiveConnection extends EventTarget {
  constructor({ exchangeSdp, audioElement }) {
    super();
    this.exchangeSdp = exchangeSdp;
    this.audioElement = audioElement;
    this.pc = null;
    this.dc = null;
    this.mic = null;
    this.micError = null;
    this.started = false;
    this.closedEmitted = false;
  }

  async connect({ micOn = true } = {}) {
    // No usable mic is not fatal: the commentator can still call the game,
    // you just cannot talk back.
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.micError = null;
    } catch (err) {
      this.mic = null;
      this.micError = err;
    }

    const pc = new RTCPeerConnection();
    this.pc = pc;
    const track = this.mic?.getAudioTracks()[0];
    if (track) {
      track.enabled = micOn;
      pc.addTrack(track, this.mic);
    } else {
      pc.addTransceiver('audio', { direction: 'recvonly' });
    }
    pc.ontrack = (e) => {
      this.audioElement.srcObject = e.streams[0];
      this.audioElement.play().catch(() => {});
      this.dispatchEvent(new CustomEvent('remote-stream', { detail: e.streams[0] }));
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.#closed('connection_lost');
    };

    // The data channel must exist before the offer is created.
    const dc = pc.createDataChannel('oai-events');
    this.dc = dc;
    dc.onmessage = (msg) => {
      let event;
      try {
        event = JSON.parse(msg.data);
      } catch {
        return;
      }
      if (event.type === 'session.started') {
        this.started = true;
        if (!micOn || !track) this.send({ type: 'session.input_audio.mute' });
      }
      this.dispatchEvent(new CustomEvent('server-event', { detail: event }));
      if (event.type === 'session.closed') this.#closed(event.reason);
    };
    dc.onclose = () => this.#closed('connection_lost');

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const answerSdp = await this.exchangeSdp(pc.localDescription.sdp);
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  }

  /** Send a client event. Commands are only accepted after session.started. */
  send(event) {
    if (!this.dc || this.dc.readyState !== 'open' || !this.started) return false;
    this.dc.send(JSON.stringify(event));
    return true;
  }

  setMic(on) {
    const track = this.mic?.getAudioTracks()[0];
    // Disable the track locally (nothing leaves the machine) and tell the model.
    if (track) track.enabled = on;
    this.send({ type: on ? 'session.input_audio.unmute' : 'session.input_audio.mute' });
  }

  close() {
    this.closedEmitted = true; // a local close is not a drop; do not reconnect
    try {
      this.dc?.close();
      this.pc?.close();
    } catch {
      /* already closed */
    }
    this.mic?.getTracks().forEach((t) => t.stop());
  }

  #closed(reason) {
    if (this.closedEmitted) return;
    this.closedEmitted = true;
    this.started = false;
    this.dispatchEvent(new CustomEvent('closed', { detail: { reason } }));
  }
}
