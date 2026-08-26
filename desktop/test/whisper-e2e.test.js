'use strict';

/**
 * Real local Whisper smoke test. Requires smart-whisper plus a model in
 * assets/models (run `npm run fetch:whisper-model -- tiny` first). It generates
 * a short tone when no external fixture is supplied; the text may be nonsense,
 * but the purpose is to verify native addon + model + PCM + timestamp plumbing.
 *
 * To test real speech, set MINICLIP_WHISPER_AUDIO=/absolute/path/to/speech.wav.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const whisper = require('../src/whisper-runner');
const { resolveBinaries } = require('../src/ffmpeg-runner');

(async function main() {
  const st = whisper.status();
  if (!st.engineInstalled || !st.modelPath) {
    console.error('SKIP: smart-whisper/model missing. Run npm run fetch:whisper-model -- tiny');
    process.exit(0);
  }
  let input = process.env.MINICLIP_WHISPER_AUDIO;
  if (!input) {
    input = path.join(os.tmpdir(), 'miniclip-whisper-tone.wav');
    const { ffmpeg } = resolveBinaries();
    execFileSync(ffmpeg, [
      '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-ar', '16000', '-ac', '1', input,
    ], { stdio: 'ignore' });
  }
  const res = await whisper.transcribe({ input, language: 'auto', autoDownload: false });
  assert.ok(Array.isArray(res.segments));
  assert.ok(Array.isArray(res.overlays));
  for (const s of res.segments) {
    assert.ok(Number.isFinite(s.from) && Number.isFinite(s.to) && s.to >= s.from);
  }
  console.log(`REAL WHISPER OK: ${res.model}, ${res.segments.length} segment(s)`);
  if (res.segments[0]) console.log(JSON.stringify(res.segments[0]));
})().catch((e) => {
  console.error('WHISPER E2E FAILED:', e);
  process.exit(1);
});
