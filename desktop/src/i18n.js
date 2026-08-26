'use strict';

/**
 * Lightweight renderer localisation. Chinese source text stays in index.html
 * so a fresh install always opens in Chinese. This module remembers that
 * source text and swaps it in-place when the user selects English.
 */
(function createMiniClipI18n() {
  const DEFAULT_LANGUAGE = 'zh-CN';
  let language = DEFAULT_LANGUAGE;
  const sourceText = new WeakMap();
  const sourceAttributes = new WeakMap();

  const en = {
    '语言': 'Language', '中文': 'Chinese',
    '打开工程': 'Open Project', '保存工程': 'Save Project', '打包工程': 'Package Project',
    '重新链接素材': 'Relink Media', '↶ 撤销': '↶ Undo', '↷ 重做': '↷ Redo',
    '＋ 导入媒体': '+ Import Media', '插入': 'Insert', '覆盖': 'Overwrite',
    '波纹删除': 'Ripple Delete', '分离音频': 'Detach Audio',
    '草稿质量': 'Draft quality', '标准质量': 'Standard quality', '高质量': 'High quality', '⤴ 导出': '⤴ Export',
    '导入视频或图片后在此预览': 'Import a video or image to preview it here',
    '▶ 播放': '▶ Play', '⏸ 暂停': '⏸ Pause', '▣ 成片预览': '▣ Final Preview',
    '▣ 重新渲染预览': '▣ Re-render Preview', '↩ 普通预览': '↩ Standard Preview',
    '导入一段视频开始': 'Import a video to get started', '取消': 'Cancel', '在文件夹中显示': 'Show in Folder',
    '片段': 'Clip', '视频': 'Video', '视频层': 'Video Layer', '画布': 'Canvas', '文字': 'Text', '叠加': 'Overlay', '音频': 'Audio',
    '在下方时间线点选一个片段进行编辑': 'Select a clip in the timeline below to edit it',
    '✂ 在当前播放位置分割': '✂ Split at Playhead', '⧉ 复制并插入': '⧉ Duplicate & Insert', '定格': 'Freeze', '▣ 插入定格帧': '▣ Insert Freeze Frame',
    '🔊 静音片段': '🔊 Mute Clip', '🔇 解除静音': '🔇 Unmute Clip',
    '◫ 复制画面属性': '◫ Copy Appearance', '▣ 粘贴画面属性': '▣ Paste Appearance',
    '分割快捷键 Ctrl/⌘+B；属性复制/粘贴快捷键 Ctrl/⌘+Shift+C / Ctrl/⌘+Shift+V。播放头需位于所选片段的保留范围内。': 'Split: Ctrl/⌘+B. Copy/Paste Appearance: Ctrl/⌘+Shift+C / Ctrl/⌘+Shift+V. The playhead must be inside the selected clip.',
    '✂ 删除当前片段静音': '✂ Remove Silence', '♩ 检测节拍': '♩ Detect Beats', '▦ 镜头分割': '▦ Detect Scenes',
    '◀ 帧': '◀ Frame', '帧 ▶': 'Frame ▶',
    '静音删除会按检测区间拆分当前片段并自动波纹前移后续字幕、图层和音频。镜头分割会按明显画面切换拆开片段，不改变成片总时长。节拍仅用于时间线磁吸辅助。': 'Remove Silence splits the selected clip at detected ranges and ripples later captions, layers, and audio forward. Detect Scenes splits at visible cuts without changing total duration. Beats are used only for timeline snapping.',
    '裁剪': 'Trim', '起点': 'Start', '止点': 'End', '保留 0.0s': 'Keep 0.0s',
    '图片时长': 'Image Duration', '图片会以静态画面循环为主轨片段；修改时长后会重建编辑代理。': 'Images become still main-track clips. Changing the duration rebuilds the editing proxy.',
    '速度': 'Speed', '片段原声': 'Clip Audio', '音量': 'Volume', '淡入': 'Fade In', '淡出': 'Fade Out',
    '变速曲线预设': 'Speed Curve Preset', '加速强调（1× → 2× → 1×）': 'Acceleration Emphasis (1× → 2× → 1×)', '慢动作强调（1× → 0.5× → 1×）': 'Slow-motion Emphasis (1× → 0.5× → 1×)', '快慢快（2× → 0.5× → 2×）': 'Fast–Slow–Fast (2× → 0.5× → 2×)', '应用曲线': 'Apply Curve',
    '应用后会将当前片段均分为 3 段，以普通片段保存，便于继续逐段编辑或撤销。片段内的字幕、图层和独立音频会随新的变速时间重新定位。': 'Applying a preset splits the selected clip into three ordinary clips, so you can keep editing each segment or undo. Captions, layers, and independent audio inside the clip are retimed to the new speed.',
    '倒放': 'Reverse', '运动': 'Motion', '无': 'None', '放大 (Ken Burns)': 'Zoom In (Ken Burns)', '缩小': 'Zoom Out',
    '片段动画': 'Clip Animation', '入场': 'In', '出场': 'Out', '淡入': 'Fade In', '淡出': 'Fade Out',
    '左滑入': 'Slide In Left', '右滑入': 'Slide In Right', '上滑入': 'Slide In Up', '下滑入': 'Slide In Down',
    '左滑出': 'Slide Out Left', '右滑出': 'Slide Out Right', '上滑出': 'Slide Out Up', '下滑出': 'Slide Out Down',
    '动画不改变片段时长。导出时会自动限制到片段有效时长的一半，避免入场和出场重叠。': 'Animations do not change clip duration. Export limits each one to half of the effective clip duration so the entry and exit do not overlap.',
    '防抖': 'Stabilize', '关闭': 'Off', '标准': 'Standard', '强力': 'Strong',
    '防抖、倒放、转场和运动动画只在成片预览或导出时完整渲染；强力防抖会增加渲染时间。': 'Stabilization, reverse, transitions, and motion are fully rendered only in Final Preview or export. Strong stabilization takes longer.',
    '填充方式': 'Fill Mode', '跟随画布': 'Follow Canvas', '黑边': 'Letterbox', '模糊背景': 'Blurred Background',
    '画面变换': 'Transform', '水平镜像': 'Flip Horizontal', '垂直镜像': 'Flip Vertical', '旋转': 'Rotation',
    '左裁剪': 'Crop Left', '右裁剪': 'Crop Right', '上裁剪': 'Crop Top', '下裁剪': 'Crop Bottom', '不透明度': 'Opacity', '缩放': 'Scale', '横移': 'X Offset', '纵移': 'Y Offset',
    '变换关键帧时间': 'Transform Keyframe Time', '＋ 记录当前变换': '+ Record Current Transform',
    '关键帧以当前片段的成片时间计时，可动画缩放、横移、纵移和不透明度；曲线在相邻关键帧之间生效。': 'Keyframes use the current clip’s output time and animate scale, X/Y offset, and opacity. Curves apply between adjacent keyframes.',
    '调色': 'Color', '亮度': 'Brightness', '对比度': 'Contrast', '饱和度': 'Saturation', '色温': 'Temperature', '色相': 'Hue',
    '曲线': 'Curve', '提亮中间调': 'Lift Midtones', 'S 对比曲线': 'S Contrast Curve', '导入 LUT': 'Import LUT', '清除 LUT': 'Clear LUT',
    '原始': 'Original', '暖色': 'Warm', '冷色': 'Cool', '鲜艳': 'Vivid', '黑白': 'B&W',
    '片段特效': 'Clip Effects', '黑白电影': 'Monochrome Film', '复古胶片': 'Vintage Film', '柔光': 'Soft Glow', '锐化': 'Sharpen',
    '暗角': 'Vignette', '颗粒': 'Grain', '暗角和颗粒可叠加到任意调色或片段特效上；普通预览仅作近似显示，以成片预览或导出为准。': 'Vignette and grain can be combined with any color grade or clip effect. Standard preview is approximate; use Final Preview or export to confirm.',
    '与下一段的转场': 'Transition to Next Clip', '时长': 'Duration',
    '视频层（B-roll）': 'Video Layer (B-roll)', '＋ 添加视频层': '+ Add Video Layer', '＋ 新建视频轨': '+ New Video Track',
    '↑ 轨道': '↑ Track', '↓ 轨道': '↓ Track', '👁 轨道': '👁 Track', '🔓 轨道': '🔓 Track', '◉ 轨道': '◉ Track', '🔒 轨道': '🔒 Track',
    '删除空轨': 'Delete Empty Track', '↑ 上移视频层': '↑ Raise Video Layer', '↓ 下移视频层': '↓ Lower Video Layer',
    '开始': 'Start', '结束': 'End', '所在视频轨': 'Video Track', '源起点': 'Source Start', '循环至结束': 'Loop to End',
    '不透明度': 'Opacity', '淡入淡出': 'Fade In / Out',
    '视频层默认铺满画布并静音；它位于主视频上方、文字和贴纸下方。': 'Video layers fill the canvas and are muted by default. They sit above the main video and below text and stickers.',
    '删除此视频层': 'Delete This Video Layer',
    '输出画布': 'Output Canvas', '画幅比例': 'Aspect Ratio', '16:9 横屏': '16:9 Landscape', '9:16 竖屏': '9:16 Portrait', '1:1 方形': '1:1 Square',
    '默认填充方式': 'Default Fill Mode', '黑边（letterbox）': 'Letterbox', '画布背景色': 'Canvas Background', '用于黑边填充及旋转后露出的画布区域。': 'Used for letterboxing and areas revealed by rotation.',
    '导出分辨率': 'Export Resolution', '帧率': 'Frame Rate',
    '文字 / 字幕': 'Text / Captions', '＋ 添加文字': '+ Add Text', '🎤 自动字幕': '🎤 Auto Captions', '🎤 识别全部': '🎤 Transcribe All', '导入 SRT': 'Import SRT', '导出 SRT': 'Export SRT',
    '字幕批量样式': 'Caption Batch Style', '默认白字': 'Default White', '白字黄高亮': 'White with Yellow Highlight', '居中大字': 'Large Centered', '应用到字幕': 'Apply to Captions', '全部替换': 'Replace All',
    '位置': 'Position', '底部': 'Bottom', '顶部': 'Top', '居中': 'Center', '左下': 'Bottom Left', '右下': 'Bottom Right', '左上': 'Top Left', '右上': 'Top Right',
    '字号': 'Font Size', '自由位置': 'Free Position', '恢复预设位置': 'Reset to Preset', '水平': 'Horizontal', '垂直': 'Vertical',
    '字体': 'Font', '无衬线': 'Sans Serif', '衬线': 'Serif', '等宽': 'Monospace', '粗体': 'Bold', '斜体': 'Italic',
    '颜色': 'Color', '描边': 'Outline', '描边粗细': 'Outline Width', '阴影': 'Shadow', '字距': 'Letter Spacing', '透明度': 'Opacity',
    '逐字高亮': 'Karaoke Highlight', '高亮色': 'Highlight Color',
    '逐字高亮按当前字幕条目的时长均分字符节奏，适合节奏化字幕；不是语音模型逐词时间戳。': 'Karaoke Highlight divides the current caption duration evenly between characters. It is useful for rhythmic captions, not word timestamps from speech recognition.',
    '✂ 在播放头拆分': '✂ Split at Playhead', '合并下一条': 'Merge Next', '删除此条': 'Delete This Item',
    '叠加素材（画中画 / 贴纸）': 'Overlay Media (PiP / Sticker)', '＋ 添加图片/视频': '+ Add Image / Video',
    '↑ 上移图层': '↑ Raise Layer', '↓ 下移图层': '↓ Lower Layer', '大小': 'Size', '画面处理': 'Image Processing', '蒙版': 'Mask',
    '椭圆': 'Ellipse', '圆角矩形': 'Rounded Rectangle', '反转': 'Invert', '左裁': 'Crop Left', '右裁': 'Crop Right', '上裁': 'Crop Top', '下裁': 'Crop Bottom', '羽化': 'Feather',
    '混合模式': 'Blend Mode', '正常': 'Normal', '滤色': 'Screen', '正片叠底': 'Multiply', '线性减淡': 'Linear Dodge',
    '色键抠像': 'Chroma Key', '相似度': 'Similarity', '线性移动到': 'Move Linearly To',
    '关键帧动画': 'Keyframe Animation', '时间': 'Time', '＋ 记录当前属性': '+ Record Current Properties', '线性': 'Linear', '缓入': 'Ease In', '缓出': 'Ease Out', '缓入缓出': 'Ease In Out', '自定义贝塞尔': 'Custom Bézier',
    '删除此关键帧': 'Delete This Keyframe', '关键帧可控制位置、大小和不透明度；曲线定义到下一关键帧的插值。导出与预览共用同一计算规则。': 'Keyframes control position, size, and opacity. The curve defines interpolation to the next keyframe and is shared by preview and export.',
    '删除此素材': 'Delete This Media', '♪ 添加背景音乐': '♪ Add Background Music', '♪ 更换背景音乐': '♪ Change Background Music', '移除': 'Remove',
    '原声音量': 'Original Audio Volume', '音乐音量': 'Music Volume', '人声时自动压低背景音乐': 'Duck Music During Speech', '闪避强度': 'Ducking Amount', '音乐源起点': 'Music Source Start', '导出时统一响度（目标 -14 LUFS）': 'Normalize Loudness on Export (target −14 LUFS)',
    '背景音乐会自动循环铺满整条时间线。自动闪避根据主视频原声检测人声/前景声音；响度归一只在最终导出时生效。': 'Background music loops to fill the timeline. Ducking follows speech/foreground sound in the main video; normalization applies only on final export.',
    '独立音频轨': 'Independent Audio Tracks', '＋ 添加音频片段': '+ Add Audio Clip', '● 录制旁白': '● Record Voice-over', '■ 停止': '■ Stop',
    '录音会从当前播放头位置插入时间线。首次使用会请求系统麦克风权限。': 'Recordings are inserted at the current playhead. The first use requests microphone permission.',
    '✂ 在播放头处分割音频': '✂ Split Audio at Playhead', '局部静音': 'Local Mute', '🔇 静音播放头附近 1 秒': '🔇 Mute 1 s Around Playhead',
    '静音区间随音频片段移动，不会改变片段时长。': 'Mute ranges move with the audio clip and do not change its duration.',
    '人声处理': 'Voice Processing', '基础降噪': 'Basic Noise Reduction', '人声增强（动态响度）': 'Voice Enhancement (dynamic loudness)', '音高': 'Pitch', '半音': 'semitones', '删除此音频片段': 'Delete This Audio Clip',
    '时间线': 'Timeline', '还没有片段，点右上角「导入视频」': 'No clips yet. Click “Import Media” in the top-right corner.',
    '界面语言': 'Interface language', '撤销 (Ctrl/⌘+Z)': 'Undo (Ctrl/⌘+Z)', '重做 (Ctrl/⌘+Shift+Z)': 'Redo (Ctrl/⌘+Shift+Z)', '在播放头插入视频': 'Insert video at playhead', '用视频覆盖选中片段': 'Overwrite selected clip with video', '波纹删除选中主视频片段': 'Ripple-delete selected main video clip', '将选中片段原声分离到音频轨': 'Detach selected clip audio to an audio track',
    '导出预设': 'Export preset', '渲染含全部效果的预览': 'Render a preview with all effects', '查找字幕…': 'Find captions…', '替换为…': 'Replace with…', '输入文字…': 'Enter text…', '双语副文本（可选）…': 'Secondary bilingual text (optional)…',
    '缩小时间线': 'Zoom out timeline', '放大时间线': 'Zoom in timeline', '锁定主视频轨': 'Lock main video track', '解锁主视频轨': 'Unlock main video track',
    '隐藏视频层轨': 'Hide video-layer track', '锁定视频层轨': 'Lock video-layer track', '隐藏叠加轨': 'Hide overlay track', '锁定叠加轨': 'Lock overlay track', '隐藏文字轨': 'Hide text track', '锁定文字轨': 'Lock text track', '静音独立音频轨': 'Mute independent audio tracks', '锁定音频轨': 'Lock audio track',
  };

  const dynamic = [
    [/^已撤销$/, 'Undone'], [/^已重做$/, 'Redone'], [/^当前轨道已锁定$/, 'The current track is locked'],
    [/^请先导入视频$/, 'Import video first'], [/^请先选择一个片段$/, 'Select a clip first'],
    [/^选中片段没有可静音的原声$/, 'The selected clip has no original audio to mute'],
    [/^已静音当前片段原声$/, 'Muted the current clip’s original audio'],
    [/^已恢复当前片段原声$/, 'Restored the current clip’s original audio'],
    [/^已在播放头插入 (.*) 秒定格帧$/, 'Inserted a $1 s freeze frame at the playhead'],
    [/^已复制当前片段并插入其后$/, 'Duplicated the current clip and inserted it after the original'],
    [/^已复制当前片段的画面属性$/, 'Copied the current clip appearance'],
    [/^还没有可粘贴的画面属性$/, 'No clip appearance is available to paste'],
    [/^已粘贴画面属性；素材、裁剪、速度、音频和转场保持不变$/, 'Pasted appearance; media, trim, speed, audio, and transition are unchanged'],
    [/^当前片段太短，无法应用变速曲线$/, 'The selected clip is too short for a speed curve'],
    [/^已应用变速曲线：(.*)$/, 'Applied speed curve: $1'],
    [/^正在导出…$/, 'Exporting…'], [/^已取消导出$/, 'Export cancelled'], [/^正在渲染成片预览…$/, 'Rendering final preview…'],
    [/^已返回普通代理预览$/, 'Returned to standard proxy preview'],
    [/^已恢复上次未保存的编辑内容$/, 'Restored unsaved edits from the previous session'],
    [/^还没有局部静音区间。$/, 'No local mute ranges yet.'],
    [/^还没有变换关键帧。调整构图后，在所需时刻记录。$/, 'No transform keyframes yet. Adjust composition, then record it at the desired time.'],
    [/^还没有关键帧。先调整属性，再在所需时刻记录。$/, 'No keyframes yet. Adjust properties, then record them at the desired time.'],
    [/^保存工程失败：(.*)$/, 'Failed to save project: $1'], [/^打开工程失败：(.*)$/, 'Failed to open project: $1'],
    [/^导出失败：(.*)$/, 'Export failed: $1'], [/^导出出错：(.*)$/, 'Export error: $1'], [/^导出完成 ✅ (.*)$/, 'Export complete ✅ $1'],
    [/^导入失败：(.*)$/, 'Import failed: $1'], [/^导入 LUT 失败：(.*)$/, 'Failed to import LUT: $1'],
    [/^自动字幕出错：(.*)$/, 'Auto captions failed: $1'], [/^成片预览失败：(.*)$/, 'Final preview failed: $1'], [/^成片预览出错：(.*)$/, 'Final preview error: $1'],
    [/^已添加 (\d+) 段视频$/, 'Added $1 video clip(s)'], [/^已添加背景音乐：(.*)$/, 'Added background music: $1'],
    [/^已添加独立音频：(.*)$/, 'Added independent audio: $1'], [/^已添加叠加素材：(.*)$/, 'Added overlay media: $1'], [/^已添加视频层：(.*)$/, 'Added video layer: $1'],
    [/^已生成 (\d+) 条字幕（模型 (.*)）$/, 'Generated $1 captions (model $2)'],
    [/^识别中… (\d+)%$/, 'Transcribing… $1%'], [/^正在录制旁白…$/, 'Recording voice-over…'],
    [/^就绪（ffmpeg (.*)）。导入视频开始。$/, 'Ready (ffmpeg $1). Import a video to begin.'],
  ];

  const fragments = {
    '视频层 ': 'Video Layer ', '片段': 'Clip', '图片': 'Image', '倒放': 'Reverse', '运动': 'Motion', '防抖': 'Stabilize', '特效': 'Effect', '调色': 'Color', '转场→': 'Transition →',
    '原声': 'Original Audio', '文字': 'Text', '叠加': 'Overlay', '视频层': 'Video Layer', '关键帧': 'Keyframe',
  };

  function lookup(value) {
    const text = String(value == null ? '' : value);
    if (language !== 'en') return text;
    if (Object.prototype.hasOwnProperty.call(en, text)) return en[text];
    for (const [pattern, replacement] of dynamic) {
      if (pattern.test(text)) return text.replace(pattern, replacement);
    }
    return translateFragments(text);
  }

  function translateDynamic(value) {
    const text = String(value == null ? '' : value);
    if (language !== 'en') return text;
    const direct = lookup(text);
    if (direct !== text) return direct;
    return translateFragments(text);
  }

  function translateFragments(text) {
    if (language !== 'en') return text;
    return text
      .replace(/视频层\s+(\d+)/g, 'Video Layer $1')
      .replace(/片段|图片|倒放|运动|防抖|特效|调色|转场→|原声|文字|叠加|关键帧/g, (part) => fragments[part] || part);
  }

  function replaceTextNode(node) {
    if (!node || !node.parentElement) return;
    const source = sourceText.has(node) ? sourceText.get(node) : node.data;
    if (!sourceText.has(node)) sourceText.set(node, source);
    const leading = (source.match(/^\s*/) || [''])[0];
    const trailing = (source.match(/\s*$/) || [''])[0];
    const content = source.slice(leading.length, source.length - trailing.length);
    const translated = leading + lookup(content) + trailing;
    if (node.data !== translated) node.data = translated;
  }

  function replaceAttribute(element, name) {
    if (!element.hasAttribute(name)) return;
    let values = sourceAttributes.get(element);
    if (!values) { values = new Map(); sourceAttributes.set(element, values); }
    const source = values.has(name) ? values.get(name) : element.getAttribute(name);
    if (!values.has(name)) values.set(name, source);
    const translated = lookup(source);
    if (element.getAttribute(name) !== translated) element.setAttribute(name, translated);
  }

  function applyTo(root) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    nodes.forEach(replaceTextNode);
    const elements = root.nodeType === Node.ELEMENT_NODE ? [root].concat(Array.from(root.querySelectorAll ? root.querySelectorAll('*') : [])) : [];
    elements.forEach((element) => ['title', 'placeholder', 'aria-label', 'data-lane-label'].forEach((attribute) => replaceAttribute(element, attribute)));
  }

  function applyLanguage(next, notify) {
    language = next === 'en' ? 'en' : DEFAULT_LANGUAGE;
    document.documentElement.lang = language;
    const selector = document.getElementById('languageSelect');
    if (selector) selector.value = language;
    applyTo(document.body);
    if (notify) document.dispatchEvent(new CustomEvent('miniclip-languagechange', { detail: { language } }));
    return language;
  }

  function observeChanges() {
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'characterData') replaceTextNode(record.target);
        else record.addedNodes.forEach((node) => {
          if (node.nodeType === Node.TEXT_NODE) replaceTextNode(node);
          else if (node.nodeType === Node.ELEMENT_NODE) applyTo(node);
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  window.MiniClipI18n = {
    get language() { return language; },
    t: lookup,
    dynamic: translateDynamic,
    applyLanguage,
  };

  const selector = document.getElementById('languageSelect');
  if (selector) {
    selector.value = DEFAULT_LANGUAGE;
    selector.addEventListener('change', async () => {
      const selected = selector.value === 'en' ? 'en' : DEFAULT_LANGUAGE;
      applyLanguage(selected, true);
      try { await window.miniclip.setLanguage(selected); } catch {}
    });
  }
  observeChanges();
  applyLanguage(DEFAULT_LANGUAGE, false);
  Promise.resolve(window.miniclip && window.miniclip.getLanguage ? window.miniclip.getLanguage() : null)
    .then((saved) => { if (saved && saved.language) applyLanguage(saved.language, true); })
    .catch(() => {});
})();
