'use strict';

/** Tests for the progress-time parser in ffmpeg-runner (pure function). */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const runner = require('../src/ffmpeg-runner');
const { parseProgressTimeSeconds, assertLocalFile, buildWaveform, parseSilenceIntervals, parseSceneCutTimes, findBeatMarkers, buildProxyArgs, buildImageProxyArgs } = runner;

let passed = 0;
const pending = [];
function ok(name, fn) {
  const result = fn();
  if (result && typeof result.then === 'function') {
    pending.push(result.then(() => { passed++; console.log('  ✓', name); }));
  } else {
    passed++;
    console.log('  ✓', name);
  }
}

console.log('ffmpeg-runner.parseProgressTimeSeconds:');

ok('reads out_time_us (microseconds)', () => {
  assert.strictEqual(parseProgressTimeSeconds('frame=10\nout_time_us=2500000\n'), 2.5);
});

ok('reads out_time_ms (also microseconds on most builds)', () => {
  assert.strictEqual(parseProgressTimeSeconds('out_time_ms=1000000'), 1);
});

ok('reads HH:MM:SS out_time', () => {
  assert.strictEqual(parseProgressTimeSeconds('out_time=00:01:02.500'), 62.5);
});

ok('returns null when no time present', () => {
  assert.strictEqual(parseProgressTimeSeconds('frame=1\nfps=30\n'), null);
});

ok('assertLocalFile accepts a file and rejects missing/non-file paths', () => {
  const p = path.join(os.tmpdir(), 'miniclip-path-test.txt');
  fs.writeFileSync(p, 'x');
  assert.strictEqual(assertLocalFile(p), path.resolve(p));
  assert.throws(() => assertLocalFile(path.join(os.tmpdir(), 'does-not-exist-xyz')));
  assert.throws(() => assertLocalFile(os.tmpdir()));
  fs.rmSync(p, { force: true });
});

ok('buildWaveform reduces samples to bounded visual peaks', () => {
  const samples = new Float32Array([0, -0.25, 0.5, -1, 0.1, 0, 0.04, -0.09]);
  const peaks = buildWaveform(samples, 4);
  assert.strictEqual(peaks.length, 16, 'minimum UI resolution');
  assert.ok(peaks.every((peak) => peak >= 0 && peak <= 1));
  assert.ok(peaks.some((peak) => peak === 1));
  assert.deepStrictEqual(buildWaveform(new Float32Array(0), 16), Array(16).fill(0));
});

ok('parses FFmpeg silencedetect logs and finds sparse beat candidates', () => {
  const silences = parseSilenceIntervals('[silencedetect] silence_start: 1.2\n[silencedetect] silence_end: 2.0 | silence_duration: 0.8\n');
  assert.deepStrictEqual(silences, [{ start: 1.2, end: 2 }]);
  const samples = new Float32Array([0, 0.01, 0.3, 0.01, 0, 0, 0.25, 0, 0, 0]);
  assert.deepStrictEqual(findBeatMarkers(samples, 10, { threshold: 0.05, minGap: 0.2 }), [0.2, 0.6]);
});

ok('parses bounded FFmpeg scene cut timestamps', () => {
  const log = '[Parsed_showinfo] n:0 pts:100 pts_time:1.000\n[Parsed_showinfo] n:1 pts:250 pts_time:2.500\n[Parsed_showinfo] n:2 pts:251 pts_time:2.510\n';
  assert.deepStrictEqual(parseSceneCutTimes(log, 0.5, 3), [1, 2.5]);
  assert.deepStrictEqual(parseSceneCutTimes(log, 1.1, 2.4), []);
});

ok('buildProxyArgs creates a low-resolution editing-only MP4', () => {
  const args = buildProxyArgs('/tmp/source.mov', '/tmp/proxy.mp4');
  assert.ok(args.includes('scale=960:-2:force_original_aspect_ratio=decrease,fps=30'));
  assert.ok(args.includes('veryfast'));
  assert.ok(args.includes('30'));
  assert.strictEqual(args[args.length - 1], '/tmp/proxy.mp4');
});

ok('buildImageProxyArgs loops a still image into a silent editing proxy', () => {
  const args = buildImageProxyArgs('/tmp/still.png', '/tmp/still-proxy.mp4', 4);
  assert.ok(args.includes('-loop'));
  assert.ok(args.includes('-an'));
  assert.ok(args.includes('4'));
});

ok('createFreezeFrame generates a silent playable clip from one source frame', async () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclip-freeze-'));
  try {
    const source = path.join(dir, 'source.mp4');
    const output = path.join(dir, 'freeze.mp4');
    const { ffmpeg } = runner.resolveBinaries();
    execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x90:rate=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source], { stdio: 'ignore' });
    await runner.createFreezeFrame(source, 0.4, output, 0.6);
    const meta = await runner.probe(output);
    assert.ok(meta.hasVideo);
    assert.strictEqual(meta.hasAudio, false);
    assert.ok(meta.duration > 0.4 && meta.duration < 0.9);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

Promise.all(pending).then(() => {
  console.log('\n' + passed + ' passed');
}).catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
