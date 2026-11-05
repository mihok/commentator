'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('booth', {
  init: () => ipcRenderer.invoke('app:init'),
  /** Main process exchanges the SDP offer with GPT-Live (it holds the API key). */
  createSession: (offerSdp) => ipcRenderer.invoke('live:create', offerSdp),
  forwardEvent: (event) => ipcRenderer.send('live:event', event),
  setConnection: (state) => ipcRenderer.send('ui:connection', state),
  command: (cmd) => ipcRenderer.send('ui:command', cmd),
  reportError: (message) => ipcRenderer.send('ui:error', String(message)),
  onSend: (handler) => subscribe('live:send', handler),
  onMic: (handler) => subscribe('live:mic', handler),
  onStatus: (handler) => subscribe('ui:status', handler),
});
