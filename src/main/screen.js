'use strict';

const { desktopCapturer, screen } = require('electron');
const { FP_WIDTH, FP_HEIGHT, toFingerprint, relativeRect } = require('../shared/frame-diff');

/**
 * Grabs a screenshot of the display the engineer is working on.
 *
 * @param {object} opts
 * @param {'cursor'|'primary'} opts.display which display to watch
 * @param {number} opts.width capture width in pixels (height follows aspect)
 * @param {() => Electron.Rectangle|null} opts.overlayBounds our own window,
 *   masked out of change detection so captions updating don't count as "the
 *   screen changed" (on macOS/Windows it is also hidden via content protection)
 */
function createScreenCapture({ display = 'cursor', width = 1440, overlayBounds = () => null }) {
  return async function capture() {
    const target =
      display === 'primary' ? screen.getPrimaryDisplay() : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { bounds } = target;
    const height = Math.round((width * bounds.height) / bounds.width);

    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
    if (!sources.length) throw new Error('No screens available to capture (is screen recording permission granted?)');
    const source = sources.find((s) => s.display_id === String(target.id)) || sources[0];
    const image = source.thumbnail;
    if (image.isEmpty()) {
      throw new Error('Screen capture came back empty. On macOS, grant Screen Recording permission and restart.');
    }

    const masks = [];
    const overlay = overlayBounds();
    if (overlay && intersects(overlay, bounds)) masks.push(relativeRect(overlay, bounds));

    const small = image.resize({ width: FP_WIDTH, height: FP_HEIGHT, quality: 'good' });
    const fingerprint = toFingerprint(small.toBitmap(), FP_WIDTH, FP_HEIGHT, masks);

    return {
      fingerprint,
      displayId: target.id,
      toDataUrl: () => `data:image/jpeg;base64,${image.toJPEG(72).toString('base64')}`,
    };
  };
}

function intersects(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

module.exports = { createScreenCapture };
