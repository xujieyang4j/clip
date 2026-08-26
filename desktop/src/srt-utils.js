'use strict';

/**
 * Small SRT reader/writer shared by the Electron main process and Node tests.
 * It deliberately carries only text and timing: appearance remains editable in
 * MiniClip's normal text inspector after import.
 */

function parseTimestamp(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  const s = Number(match[3]);
  const ms = Number(match[4].padEnd(3, '0'));
  if (m >= 60 || s >= 60 || ms >= 1000) return null;
  return h * 3600 + m * 60 + s + ms / 1000;
}

function formatTimestamp(seconds) {
  let total = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  const h = Math.floor(total / 3600000); total -= h * 3600000;
  const m = Math.floor(total / 60000); total -= m * 60000;
  const s = Math.floor(total / 1000); total -= s * 1000;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' +
    String(s).padStart(2, '0') + ',' + String(total).padStart(3, '0');
}

function parseSrt(text) {
  const source = String(text == null ? '' : text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!source) return [];
  const items = [];
  for (const block of source.split(/\n{2,}/)) {
    const lines = block.split('\n');
    if (lines.length < 2) continue;
    let timingIndex = 0;
    if (!lines[0].includes('-->')) timingIndex = 1;
    const timing = lines[timingIndex] || '';
    const match = timing.match(/^\s*(.+?)\s*-->\s*(.+?)\s*$/);
    if (!match) continue;
    const start = parseTimestamp(match[1]);
    const end = parseTimestamp(match[2]);
    const content = lines.slice(timingIndex + 1).join('\n').trim();
    if (start == null || end == null || !(end > start) || !content) continue;
    items.push({ text: content, start, end });
  }
  return items.sort((a, b) => a.start - b.start);
}

function serializeSrt(items) {
  const valid = (Array.isArray(items) ? items : [])
    .map((item) => ({
      text: String(item && item.text != null ? item.text : '').replace(/\r\n?/g, '\n').trim(),
      start: Math.max(0, Number(item && item.start) || 0),
      end: Number(item && item.end),
    }))
    .filter((item) => item.text && Number.isFinite(item.end) && item.end > item.start)
    .sort((a, b) => a.start - b.start);
  return valid.map((item, index) =>
    String(index + 1) + '\n' + formatTimestamp(item.start) + ' --> ' + formatTimestamp(item.end) + '\n' + item.text
  ).join('\n\n') + (valid.length ? '\n' : '');
}

module.exports = { parseTimestamp, formatTimestamp, parseSrt, serializeSrt };
