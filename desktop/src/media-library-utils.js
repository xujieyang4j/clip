'use strict';

(function universalModule(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.MiniClipMediaLibrary = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function createMediaLibraryUtils() {
  const MAX_DURATION = 24 * 60 * 60;
  const MAX_DIMENSION = 100000;
  const KINDS = new Set(['video', 'image', 'audio']);

  function number(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function string(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
  }

  function nextAssetId(existing, fallback = 1) {
    let nextId = Math.max(1, Math.floor(number(fallback, 1, 1, Number.MAX_SAFE_INTEGER)));
    for (const asset of Array.isArray(existing) ? existing : []) {
      const assetId = Math.floor(number(asset && asset.id, 0, 0, Number.MAX_SAFE_INTEGER));
      if (assetId >= nextId) nextId = assetId + 1;
    }
    return nextId;
  }

  function basename(filePath) {
    const normalized = string(filePath).replace(/\\/g, '/').replace(/\/+$/, '');
    if (!normalized) return '';
    const index = normalized.lastIndexOf('/');
    return index >= 0 ? normalized.slice(index + 1) : normalized;
  }

  function assetKey(value) {
    const filePath = typeof value === 'string' ? value : value && value.path;
    const normalized = string(filePath).trim().replace(/\\/g, '/');
    return /^[a-z]:\//i.test(normalized) ? normalized.toLocaleLowerCase() : normalized;
  }

  function mediaKind(value, filePath) {
    const name = string(filePath).toLocaleLowerCase();
    if (/\.(mp3|m4a|aac|wav|flac|ogg|opus|wma)$/.test(name)) return 'audio';
    if (/\.(png|jpe?g|gif|webp|bmp|tiff?)$/.test(name)) return 'image';
    return KINDS.has(value) ? value : 'video';
  }

  function cleanAsset(value, fallbackId) {
    const asset = value && typeof value === 'object' ? value : {};
    const filePath = string(asset.path).trim();
    const id = Math.max(1, Math.floor(number(asset.id, fallbackId, 1, Number.MAX_SAFE_INTEGER)));
    return {
      id,
      path: filePath,
      name: string(asset.name, basename(filePath)),
      kind: mediaKind(asset.kind, filePath),
      duration: number(asset.duration, 0, 0, MAX_DURATION),
      hasAudio: !!asset.hasAudio,
      width: number(asset.width, 0, 0, MAX_DIMENSION),
      height: number(asset.height, 0, 0, MAX_DIMENSION),
    };
  }

  function addOrReuseAssets(existing, items, nextId) {
    const result = [];
    const byKey = new Map();
    let cursor = nextAssetId(existing, nextId);
    let added = 0;
    let reused = 0;
    for (const asset of Array.isArray(existing) ? existing : []) {
      const cleaned = cleanAsset(asset, cursor);
      if (cleaned.id >= cursor) cursor = cleaned.id + 1;
      const key = assetKey(cleaned);
      if (!key) continue;
      if (byKey.has(key)) continue;
      byKey.set(key, cleaned);
      result.push(cleaned);
    }
    for (const item of Array.isArray(items) ? items : []) {
      const cleaned = cleanAsset(item, cursor);
      const key = assetKey(cleaned);
      if (!key) continue;
      if (byKey.has(key)) {
        reused++;
        continue;
      }
      byKey.set(key, cleaned);
      result.push(cleaned);
      added++;
      cursor = cleaned.id + 1;
    }
    return { assets: result, added, reused, nextId: cursor };
  }

  function mergeAssets(existing, items, nextId) {
    return addOrReuseAssets(existing, items, nextId);
  }

  function visibleAssets(assets, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const query = string(opts.query).trim().toLocaleLowerCase();
    const kind = KINDS.has(opts.kind) ? opts.kind : 'all';
    const sort = ['added', 'name', 'duration', 'type'].includes(opts.sort) ? opts.sort : 'added';
    const result = (Array.isArray(assets) ? assets : []).filter((asset) => {
      if (!asset || (kind !== 'all' && asset.kind !== kind)) return false;
      if (!query) return true;
      return [asset.name, basename(asset.path)].some((value) => string(value).toLocaleLowerCase().includes(query));
    }).map((asset, index) => ({ asset, index }));
    const byName = (a, b) => string(a.asset.name, basename(a.asset.path)).localeCompare(string(b.asset.name, basename(b.asset.path)), undefined, { numeric: true, sensitivity: 'base' });
    if (sort === 'name') result.sort((a, b) => byName(a, b) || a.index - b.index);
    if (sort === 'duration') result.sort((a, b) => Number(b.asset.duration || 0) - Number(a.asset.duration || 0) || byName(a, b) || a.index - b.index);
    if (sort === 'type') result.sort((a, b) => string(a.asset.kind).localeCompare(string(b.asset.kind)) || byName(a, b) || a.index - b.index);
    return result.map((entry) => entry.asset);
  }

  return {
    assetKey,
    cleanAsset,
    addOrReuseAssets,
    mergeAssets,
    nextAssetId,
    visibleAssets,
  };
}));
