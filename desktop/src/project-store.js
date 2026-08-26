'use strict';

/** Filesystem wrapper around the pure MiniClip project format. */

const fs = require('fs');
const path = require('path');
const project = require('./project-file');

function assertProjectPath(filePath) {
  if (typeof filePath !== 'string' || filePath.includes('\0')) throw new Error('工程路径无效');
  const resolved = path.resolve(filePath);
  if (path.extname(resolved).toLowerCase() !== '.miniclip') {
    throw new Error('工程文件扩展名必须为 .miniclip');
  }
  return resolved;
}

function writeProject(filePath, state) {
  const resolved = assertProjectPath(filePath);
  fs.writeFileSync(resolved, project.serializeProject(state), 'utf8');
  return resolved;
}

function readProject(filePath) {
  const resolved = assertProjectPath(filePath);
  let stat;
  try { stat = fs.statSync(resolved); } catch { throw new Error('工程文件不存在：' + resolved); }
  if (!stat.isFile()) throw new Error('工程路径不是普通文件：' + resolved);
  if (stat.size > project.MAX_BYTES) throw new Error('工程文件超过 20 MB 限制');
  const parsed = project.parseProject(fs.readFileSync(resolved, 'utf8'));
  const base = path.dirname(resolved);
  const resolvePath = (p) => p && !path.isAbsolute(p) ? path.resolve(base, p) : p;
  parsed.state.clips.forEach((clip) => { clip.path = resolvePath(clip.path); if (clip.color) clip.color.lutPath = resolvePath(clip.color.lutPath); });
  parsed.state.overlays.forEach((overlay) => { overlay.path = resolvePath(overlay.path); });
  parsed.state.brolls.forEach((broll) => { broll.path = resolvePath(broll.path); });
  parsed.state.audioTracks.forEach((track) => { track.path = resolvePath(track.path); });
  if (parsed.state.bgm) parsed.state.bgm.path = resolvePath(parsed.state.bgm.path);
  return Object.assign({ path: resolved }, parsed);
}

function collectMediaPaths(state) {
  const paths = [];
  for (const clip of state.clips || []) { if (clip.path) paths.push(clip.path); if (clip.color && clip.color.lutPath) paths.push(clip.color.lutPath); }
  for (const overlay of state.overlays || []) if (overlay.path) paths.push(overlay.path);
  for (const broll of state.brolls || []) if (broll.path) paths.push(broll.path);
  for (const track of state.audioTracks || []) if (track.path) paths.push(track.path);
  if (state.bgm && state.bgm.path) paths.push(state.bgm.path);
  return [...new Set(paths.map((p) => path.resolve(p)))];
}

function packageProject(destinationDir, state, projectName = 'MiniClip-Project') {
  const destination = path.resolve(destinationDir);
  let name = String(projectName || 'MiniClip-Project').trim() || 'MiniClip-Project';
  let root = path.join(destination, name);
  let suffix = 2;
  // Packaging is a delivery/backup operation. Never silently merge with or
  // overwrite an existing package selected by the user.
  while (fs.existsSync(root)) {
    name = `${String(projectName || 'MiniClip-Project').trim() || 'MiniClip-Project'}-${suffix++}`;
    root = path.join(destination, name);
  }
  const mediaDir = path.join(root, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const map = new Map();
  const used = new Set();
  const normalized = project.normaliseProjectState(state);
  for (const source of collectMediaPaths(normalized)) {
    const ext = path.extname(source);
    const base = path.basename(source, ext);
    let name = path.basename(source);
    let n = 2;
    while (used.has(name.toLowerCase())) name = `${base}-${n++}${ext}`;
    used.add(name.toLowerCase());
    const target = path.join(mediaDir, name);
    fs.copyFileSync(source, target);
    map.set(source, path.join('media', name));
  }
  const packed = JSON.parse(JSON.stringify(normalized));
  const rel = (p) => p && (map.get(path.resolve(p)) || p);
  packed.clips.forEach((clip) => { clip.path = rel(clip.path); if (clip.color && clip.color.lutPath) clip.color.lutPath = rel(clip.color.lutPath); });
  packed.overlays.forEach((overlay) => { overlay.path = rel(overlay.path); });
  packed.brolls.forEach((broll) => { broll.path = rel(broll.path); });
  packed.audioTracks.forEach((track) => { track.path = rel(track.path); });
  if (packed.bgm) packed.bgm.path = rel(packed.bgm.path);
  const projectPath = path.join(root, `${name}.miniclip`);
  fs.writeFileSync(projectPath, project.serializeProject(packed), 'utf8');
  return { root, projectPath, mediaCount: map.size };
}

function writeRecovery(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, project.serializeProject(state), 'utf8');
}

function readRecovery(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return project.parseProject(fs.readFileSync(filePath, 'utf8'));
  } catch {
    // A recovery file must never prevent the editor from starting.
    return null;
  }
}

module.exports = { assertProjectPath, writeProject, readProject, writeRecovery, readRecovery, collectMediaPaths, packageProject };
