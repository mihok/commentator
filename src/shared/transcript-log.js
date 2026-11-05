'use strict';

/**
 * GPT-Live streams transcript fragments with no "turn done" event. This groups
 * fragments into utterances by silence gap, so we can hand recent banter to the
 * spotter and reseed a new session's history.
 */
class TranscriptLog {
  constructor({ gapMs = 1500, maxEntries = 40 } = {}) {
    this.gapMs = gapMs;
    this.maxEntries = maxEntries;
    this.entries = [];
  }

  add(delta, now = Date.now()) {
    if (!delta) return null;
    const last = this.entries[this.entries.length - 1];
    if (last && now - last.endedAt <= this.gapMs) {
      last.text += delta;
      last.endedAt = now;
      return last;
    }
    const entry = { text: delta, startedAt: now, endedAt: now };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.shift();
    return entry;
  }

  /** Utterances that ended within the last `windowMs`. */
  since(windowMs, now = Date.now()) {
    return this.entries.filter((e) => now - e.endedAt <= windowMs);
  }

  last(n) {
    return this.entries.slice(-n);
  }

  lastAt() {
    const last = this.entries[this.entries.length - 1];
    return last ? last.endedAt : 0;
  }

  /** Recent text joined into one string, trimmed to `maxChars` from the end. */
  recentText(windowMs, now = Date.now(), maxChars = 800) {
    const text = this.since(windowMs, now)
      .map((e) => e.text.trim())
      .filter(Boolean)
      .join(' / ');
    return text.length > maxChars ? '…' + text.slice(-maxChars) : text;
  }
}

/**
 * Merge two speaker logs into chronological history suitable for seeding a new
 * GPT-Live session (`session.input`, text only, one part per message).
 */
function toInitialHistory(userLog, assistantLog, maxItems = 16) {
  const items = [
    ...userLog.entries.map((e) => ({ role: 'user', text: e.text, at: e.startedAt })),
    ...assistantLog.entries.map((e) => ({ role: 'assistant', text: e.text, at: e.startedAt })),
  ]
    .filter((m) => m.text.trim())
    .sort((a, b) => a.at - b.at)
    .slice(-maxItems);
  return items.map((m) => ({
    type: 'message',
    role: m.role,
    content: [{ text: m.text.trim().slice(0, 1000) }],
  }));
}

module.exports = { TranscriptLog, toInitialHistory };
