'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n.js'), 'utf8');
const listeners = new Map();
const languageSelect = {
  value: 'zh-CN',
  addEventListener(type, listener) { listeners.set(type, listener); },
};
const document = {
  body: {},
  documentElement: { lang: 'zh-CN' },
  getElementById(id) { return id === 'languageSelect' ? languageSelect : null; },
  createTreeWalker() { return { nextNode() { return null; } }; },
  addEventListener() {},
  dispatchEvent() {},
};
const context = {
  document,
  NodeFilter: { SHOW_TEXT: 4 },
  Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
  MutationObserver: class { observe() {} },
  CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
  Promise,
  window: { miniclip: { getLanguage: async () => ({ language: 'zh-CN' }), setLanguage: async () => ({ language: 'en' }) } },
};
context.globalThis = context;
vm.runInNewContext(source, context, { filename: 'i18n.js' });

assert.strictEqual(context.window.MiniClipI18n.language, 'zh-CN');
assert.strictEqual(context.window.MiniClipI18n.t('打开工程'), '打开工程');
context.window.MiniClipI18n.applyLanguage('en', false);
assert.strictEqual(context.window.MiniClipI18n.t('打开工程'), 'Open Project');
assert.strictEqual(context.window.MiniClipI18n.t('导入一段视频开始'), 'Import a video to get started');
assert.strictEqual(context.window.MiniClipI18n.dynamic('视频层 2'), 'Video Layer 2');
assert.strictEqual(document.documentElement.lang, 'en');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const interfaceStrings = [];
for (const match of html.matchAll(/>([^<>]+)</g)) {
  const value = match[1].replace(/\s+/g, ' ').trim();
  if (/[\u4e00-\u9fff]/.test(value)) interfaceStrings.push(value);
}
for (const match of html.matchAll(/(?:title|placeholder|aria-label|data-lane-label)="([^"]+)"/g)) {
  if (/[\u4e00-\u9fff]/.test(match[1])) interfaceStrings.push(match[1]);
}
for (const value of new Set(interfaceStrings)) {
  assert.ok(!/[\u4e00-\u9fff]/.test(context.window.MiniClipI18n.t(value)), `Missing English translation: ${value}`);
}
console.log('i18n: default Chinese and English translation verified');
