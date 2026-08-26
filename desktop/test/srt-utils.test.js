'use strict';

const assert = require('assert');
const srt = require('../src/srt-utils');

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log('  ✓', name); }

console.log('srt-utils:');

ok('parses timestamps with comma or dot milliseconds', () => {
  assert.strictEqual(srt.parseTimestamp('01:02:03,450'), 3723.45);
  assert.strictEqual(srt.parseTimestamp('00:00:01.5'), 1.5);
  assert.strictEqual(srt.parseTimestamp('99:61:00,000'), null);
});

ok('formats SRT timestamps with millisecond precision', () => {
  assert.strictEqual(srt.formatTimestamp(62.5), '00:01:02,500');
  assert.strictEqual(srt.formatTimestamp(0.001), '00:00:00,001');
});

ok('parses ordered multiline subtitle entries and ignores invalid blocks', () => {
  const items = srt.parseSrt('﻿2\n00:00:02,000 --> 00:00:03,500\n第二行\n续行\n\n1\n00:00:00.200 --> 00:00:01.000\n第一行\n\nbad');
  assert.deepStrictEqual(items, [
    { text: '第一行', start: 0.2, end: 1 },
    { text: '第二行\n续行', start: 2, end: 3.5 },
  ]);
});

ok('serializes valid entries in chronological standard SRT form', () => {
  const text = srt.serializeSrt([
    { text: '晚', start: 2, end: 3 },
    { text: '早', start: 0, end: 1.25 },
    { text: '', start: 4, end: 5 },
  ]);
  assert.strictEqual(text, '1\n00:00:00,000 --> 00:00:01,250\n早\n\n2\n00:00:02,000 --> 00:00:03,000\n晚\n');
});

ok('keeps bilingual subtitle lines on SRT round trip', () => {
  const source = '1\n00:00:00,000 --> 00:00:01,000\n你好\nHello\n';
  const items = srt.parseSrt(source);
  assert.strictEqual(items[0].text, '你好\nHello');
  assert.ok(srt.serializeSrt(items).includes('你好\nHello'));
});

console.log('\n' + passed + ' passed');
