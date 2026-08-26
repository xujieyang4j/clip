'use strict';

/** Unit tests for the pure ASS subtitle builder. */

const assert = require('assert');
const a = require('../src/ass-builder');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log('  \u2713', name);
}

console.log('ass-builder:');

ok('assColor converts #RRGGBB to &HAABBGGRR (opaque)', () => {
  assert.strictEqual(a.assColor('#FFFFFF'), '&H00FFFFFF');
  assert.strictEqual(a.assColor('#FF0000'), '&H000000FF'); // red -> BGR
  assert.strictEqual(a.assColor('#00FF00'), '&H0000FF00');
  assert.strictEqual(a.assColor('#0000FF'), '&H00FF0000');
});

ok('assColor applies alpha (1=opaque -> 00, 0=transparent -> FF)', () => {
  assert.strictEqual(a.assColor('#FFFFFF', 1), '&H00FFFFFF');
  assert.strictEqual(a.assColor('#FFFFFF', 0), '&HFFFFFFFF');
});

ok('assTime formats H:MM:SS.cc', () => {
  assert.strictEqual(a.assTime(0), '0:00:00.00');
  assert.strictEqual(a.assTime(62.5), '0:01:02.50');
  assert.strictEqual(a.assTime(3661.23), '1:01:01.23');
});

ok('escapeText turns newlines into \\N and strips braces', () => {
  assert.strictEqual(a.escapeText('a\nb'), 'a\\Nb');
  assert.strictEqual(a.escapeText('x{y}z'), 'xyz');
});

ok('buildAss emits header with play res and a style line', () => {
  const s = a.buildAss({ width: 1920, height: 1080, items: [] });
  assert.ok(s.includes('PlayResX: 1920'));
  assert.ok(s.includes('PlayResY: 1080'));
  assert.ok(s.includes('[V4+ Styles]'));
  assert.ok(s.includes('Style: Default,'));
  assert.ok(s.includes('[Events]'));
});

ok('buildAss emits a Dialogue per item with times', () => {
  const s = a.buildAss({
    items: [
      { text: '你好', start: 0, end: 2, position: 'bottom' },
      { text: 'world', start: 2, end: 4, position: 'top' },
    ],
  });
  const lines = s.split('\n').filter((l) => l.startsWith('Dialogue:'));
  assert.strictEqual(lines.length, 2);
  assert.ok(lines[0].includes('0:00:00.00'));
  assert.ok(lines[0].includes('你好'));
  assert.ok(lines[0].includes('\\an2')); // bottom-center
  assert.ok(lines[1].includes('\\an8')); // top-center
  // Event row conforms to the declared 10-column format (includes empty Name).
  assert.ok(lines[0].includes(',Default,,0,0,0,,'));
});

ok('buildAss preserves bilingual caption line breaks', () => {
  const s = a.buildAss({ items: [{ text: '你好\nHello', start: 0, end: 2 }] });
  assert.ok(s.includes(String.raw`你好\NHello`));
});

ok('buildAss encodes fade and move override tags', () => {
  const s = a.buildAss({
    items: [{ text: 'hi', start: 0, end: 3, fade: 0.5, move: { fromX: 0, fromY: 0, toX: 100, toY: 200 } }],
  });
  assert.ok(s.includes('\\fad(500,500)'));
  assert.ok(s.includes('\\move(0,0,100,200)'));
});

ok('buildAss maps free text percentages to ASS coordinates', () => {
  const s = a.buildAss({ width: 1000, height: 500, items: [{ text: 'x', start: 0, end: 1, xPercent: 25, yPercent: 80 }] });
  assert.ok(s.includes('\\pos(250,400)'));
});

ok('buildAss per-item font size and colour overrides', () => {
  const s = a.buildAss({
    items: [{ text: 'x', start: 0, end: 1, fontSize: 72, primaryColor: '#FF0000' }],
  });
  assert.ok(s.includes('\\fs72'));
  assert.ok(s.includes('\\c&H000000FF'));
});

ok('buildAss supports per-item font family, bold and italic styles', () => {
  const s = a.buildAss({
    items: [{ text: 'x', start: 0, end: 1, fontFamily: 'serif', bold: true, italic: true }],
  });
  assert.ok(s.includes('\\fnserif'));
  assert.ok(s.includes('\\b1'));
  assert.ok(s.includes('\\i1'));
});

ok('buildAss supports per-item outline shadow and letter spacing', () => {
  const s = a.buildAss({ items: [{ text: 'x', start: 0, end: 1, outline: 4, shadow: 2, spacing: 1.5 }] });
  assert.ok(s.includes('\\bord4'));
  assert.ok(s.includes('\\shad2'));
  assert.ok(s.includes('\\fsp1.5'));
});

ok('buildAss emits valid ASS alpha override syntax', () => {
  const s = a.buildAss({ items: [{ text: 'x', start: 0, end: 1, alpha: 0.5 }] });
  assert.ok(s.includes('\\alpha&H80&') || s.includes('\\alpha&H7F&'));
});

ok('buildAss applies per-item text opacity', () => {
  const s = a.buildAss({ items: [{ text: 'x', start: 0, end: 1, alpha: 0.4 }] });
  assert.ok(s.includes('\\alpha&H99&') || s.includes('\\alpha&H98&'));
});

ok('karaoke distributes duration across Unicode characters and overrides colours', () => {
  assert.strictEqual(a.escapeKaraokeText('你好', 20), String.raw`{\kf10}你{\kf10}好`);
  const s = a.buildAss({ items: [{ text: '你好', start: 0, end: 1, karaoke: true, primaryColor: '#ffffff', karaokeHighlightColor: '#ffd54a' }] });
  assert.ok(s.includes(String.raw`\kf50}你{\kf50}好`));
  assert.ok(s.includes(String.raw`\c&H004AD5FF`));
  assert.ok(s.includes(String.raw`\2c&H00FFFFFF`));
});

ok('karaoke uses real token timings when supplied', () => {
  const s = a.buildAss({
    items: [{
      text: 'hello world', start: 10, end: 12, karaoke: true, primaryColor: '#ffffff', karaokeHighlightColor: '#ffd54a',
      words: [{ text: 'hello', start: 10.2, end: 10.8 }, { text: ' world', start: 10.9, end: 11.5 }],
    }],
  });
  assert.ok(s.includes(String.raw`\t(200,800,\c&H004AD5FF)`));
  assert.ok(s.includes(String.raw`\t(900,1500,\c&H004AD5FF)`));
  assert.ok(!s.includes(String.raw`kf`), 'real timings replace uniform karaoke fallback');
});

console.log(`\n${passed} passed`);
