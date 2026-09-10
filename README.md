# MiniClip / Clip 视频编辑器

仓库包含两套面向不同终端的实现：

| 目录 | 技术栈 | 平台 | 定位 |
|---|---|---|---|
| `desktop/` | Electron + FFmpeg + whisper.cpp | Windows / macOS / Linux | 功能完整的桌面主线，详见 [`desktop/README.md`](desktop/README.md) |
| `Sources/` | SwiftUI + AVFoundation | iPhone / iPad | 原生 iOS App，针对触控和移动端媒体工作流设计 |

两端共享“素材库 + 非破坏性时间线 + 预览 + 导出”的产品语义，但渲染内核不同：桌面端使用 FFmpeg，iOS 端使用系统 AVFoundation 硬件编解码。

## iOS App 当前能力

- 草稿首页支持多个独立项目，新建、重命名、复制、删除和继续编辑；每个草稿拥有独立素材目录、封面、时长和更新时间。
- 旧版单一 `Autosave.json` 会在首次启动时安全迁移为 v2 草稿，旧时间线和素材继续可用。
- 从系统相册或“文件”App 批量导入视频和图片，并从“文件”导入音频。
- 导入媒体复制到 App 沙盒，避免选择器临时 URL 过期后无法继续编辑。
- 项目素材库支持同一素材反复加入时间线，并显示使用次数。
- 图片保存原图并自动生成本地 H.264 编辑代理，可加入主轨或作为画中画。
- 时间线片段选择、裁剪、拖动排序、左右移动、分割、复制和删除。
- 选中片段支持 0.25×–4× 变速和原声静音，预览与最终导出一致。
- 播放/暂停、播放头拖动和时间码显示。
- 每个片段边界可独立设置无转场、叠化、左推或右推及 0.1–2 秒时长；画面、原声、时间线、草稿恢复与导出使用同一重叠区间。
- 画中画支持起止时间、位置、大小、旋转和透明度；编辑时即时预览，播放和导出走 AVFoundation 合成。
- 独立音频轨支持时间位置、时长、音量、静音以及淡入淡出，并可将视频原声分离到独立轨。
- 支持直接录制旁白，录音结束后自动复制进草稿素材目录并加入当前播放头。
- 多轨时间线同时显示主轨、画中画和音频条目，可直接选中对应轨道继续编辑。
- 主轨片段支持原始、暖色、冷色、鲜艳、黑白预设，亮度、对比度、饱和度、色温精调，以及标准 3D `.cube` LUT 导入和强度调节；效果会生成本地代理供预览和导出共用。
- 主轨支持蒙太奇、子弹时间和英雄时刻速度曲线，也可在播放头添加控制点并拖动自定义曲线；曲线会改变真实时间线长度、分割映射、字幕识别时间和最终导出。
- 视频片段可生成按分辨率和 PCM 内存预算分块处理的音画倒放代理；原声按完整声道帧反向并编码为 AAC，预览与导出共用同一代理。
- 画中画支持在播放头添加位置、大小、旋转和透明度关键帧，可选线性、缓入、缓出、缓入缓出或可直接拖拽手柄的三次贝塞尔曲线。
- 主轨片段支持缩放、横移、纵移、旋转和透明度关键帧，并提供同一套贝塞尔手柄与滑块精调；裁剪、变速或分割后仍保持动画时间与边界连续。
- 片段特效支持黑白电影、复古、柔光、锐化，以及可叠加的暗角和颗粒；与调色/LUT 共用预览和导出代理。
- 支持 9:16、16:9、1:1 画布，横竖素材会等比缩放并居中，预览与导出一致。
- 支持在播放头添加字幕，编辑文字与起止时间，并应用经典白字、黄色强调和居中大字样式。
- 支持标准 SRT 导入/导出；字幕会随草稿保存，并在预览和最终视频中显示。
- 支持使用 Apple Speech 对选中视频片段生成可编辑字幕；长片段按约 55 秒分块识别且可中途取消，支持的设备优先使用系统端侧识别，时间会映射到裁剪和速度曲线后的成片位置。
- 背景音乐循环、原声与音乐音量控制。
- 撤销/重做；连续滑块拖动合并为一次撤销。
- 自动保存并恢复素材库、时间线、裁剪、转场、配乐、画中画、音频轨和导出设置。
- 导出支持 720p、1080p、2K、4K，24/25/30/50/60 fps，以及草稿、标准和高质量三档。
- 导出前显示预计文件大小并检查可用存储空间；完成后可分享或直接保存到系统相册。
- 中文默认，可切换英文。

当前 iOS 版本已经完成基础调色、3D LUT、片段特效、自定义速度曲线、带三次贝塞尔缓动的主轨/画中画关键帧、音画倒放和系统语音字幕闭环，但尚未追平桌面版的复杂组合特效、多层视频自由分组和 Whisper 离线模型。这些是后续原生迁移重点。

### 第三阶段及第四阶段首批完成范围

| 能力 | 编辑与保存 | 预览 | 导出 | 当前边界 |
|---|---|---|---|---|
| 调色 | 预设、四项精调、3D `.cube` LUT 与强度，参数及代理路径随草稿保存 | Core Image 效果代理 | 与预览共用同一代理 | 暂无局部调色 |
| 速度曲线 | 三种预设及控制点增删拖动，分割后保持曲线连续 | 分段时间缩放 | 同一 AVFoundation 分段模型 | 暂无贝塞尔速度手柄 |
| 画中画关键帧 | 位置、大小、旋转、透明度，五种曲线及可拖拽三次贝塞尔手柄/滑块精调 | 播放头按同一曲线实时插值 | 曲线采样后的 transform/opacity ramp | 需真机验证密集关键帧触控与导出 |
| 主轨关键帧 | 缩放、位置、旋转、透明度，五种曲线及可拖拽三次贝塞尔手柄，分割后保留曲线 | 播放头按同一曲线实时插值 | 曲线采样后的 transform/opacity ramp | 需真机验证密集关键帧触控与导出 |
| 片段特效 | 黑白、复古、柔光、锐化、暗角、颗粒 | Core Image 效果代理 | 与预览共用同一代理 | 暂无特效关键帧 |
| 逐边界转场 | 每个出边界独立选择叠化/左右推和时长，旧全局叠化自动迁移 | AVFoundation A/B 轨及音频淡化 | 与预览共用同一指令计划 | 暂无自定义转场曲线 |
| 倒放 | 音画代理路径、音频能力与静音状态随草稿保存，旧静音代理自动重建 | 视频帧及多声道 PCM 分块反向 | 使用同一 H.264/AAC 代理 | 需真机验证长素材音画同步 |
| 自动字幕 | Apple Speech 结果进入可编辑字幕轨 | 字幕层实时显示 | 烧录到成片并支持 SRT | 依赖系统语言和设备支持 |

## 架构

- [`EditorModel.swift`](Sources/EditorModel.swift)：编辑状态、素材持久化、播放控制、AVFoundation 合成和导出。
- [`ProjectLibraryView.swift`](Sources/ProjectLibraryView.swift)：多草稿首页及新建、重命名、复制和删除。
- [`ContentView.swift`](Sources/ContentView.swift)：适配 iPhone 小屏的预览、工具面板和编辑器入口。
- [`ExportSettingsView.swift`](Sources/ExportSettingsView.swift)：分辨率、帧率、质量和导出空间预估。
- [`SubtitlePanel.swift`](Sources/SubtitlePanel.swift)：字幕添加、编辑、样式及 SRT 导入导出。
- [`SubtitleSRT.swift`](Sources/SubtitleSRT.swift)：不依赖 Apple UI 框架的 SRT 编解码。
- [`OverlayPanel.swift`](Sources/OverlayPanel.swift)：画中画轨的时间和几何参数编辑。
- [`ColorPanel.swift`](Sources/ColorPanel.swift)：片段调色预设和手动参数。
- [`ClipTransformPanel.swift`](Sources/ClipTransformPanel.swift)：主轨画面变换和关键帧编辑。
- [`KeyframeCurveEditor.swift`](Sources/KeyframeCurveEditor.swift)：主轨与画中画共用的关键帧预设、自定义三次贝塞尔控制点和曲线预览。
- [`ColorEffectRenderer.swift`](Sources/ColorEffectRenderer.swift)：使用 Core Image 生成调色、LUT 与片段特效代理。
- [`CubeLUT.swift`](Sources/CubeLUT.swift)：标准 3D `.cube` LUT 的解析与校验。
- [`SpeedCurvePanel.swift`](Sources/SpeedCurvePanel.swift)：速度曲线预设与自定义控制点编辑。
- [`ReverseMediaGenerator.swift`](Sources/ReverseMediaGenerator.swift)：按内存预算分块生成 H.264/AAC 音画倒放代理。
- [`SpeechCaptionRecognizer.swift`](Sources/SpeechCaptionRecognizer.swift)：通过 Apple Speech 将选中视频原声转成字幕。
- [`AudioTrackPanel.swift`](Sources/AudioTrackPanel.swift)：独立音频、原声分离和旁白录制。
- [`TimelineView.swift`](Sources/TimelineView.swift)：主轨、画中画、音频多轨概览，以及主轨裁剪和排序。
- [`MediaLibraryView.swift`](Sources/MediaLibraryView.swift)：视频、图片和音频的可复用项目素材库。
- [`ImportedVideo.swift`](Sources/ImportedVideo.swift)：PhotosPicker 的视频/图片文件流式传输，避免大媒体整体读入内存。
- [`StillImageVideoGenerator.swift`](Sources/StillImageVideoGenerator.swift)：为静态图片生成本地编辑代理。
- [`ProjectDocument.swift`](Sources/ProjectDocument.swift)：可迁移的 v2 JSON 工程格式和草稿生命周期。
- [`project.yml`](project.yml)：由 XcodeGen 生成 iOS App 与单元测试工程。
- [`Resources/Assets.xcassets`](Resources/Assets.xcassets)：iOS App 图标资源。

## 在 Mac 上生成并运行

需要 macOS、Xcode 和 XcodeGen：

```bash
brew install xcodegen
cd clip
xcodegen generate
open MiniClip.xcodeproj
```

然后在 Xcode 中：

1. 选择 `MiniClip` target 的 `Signing & Capabilities`，将 Team 改为自己的 Apple ID 团队。
2. 选择 iPhone 模拟器或已连接的 iPhone。视频导入、导出和相册保存建议最终在真机验证。
3. 点击 Run。
4. 可用 `Product > Test` 执行项目文档测试。

`project.yml` 已配置 iOS 16 最低版本、相册读取说明、相册写入说明、启动屏和屏幕方向。修改或增加 Swift 文件后重新运行 `xcodegen generate`。
旁白需要麦克风权限，自动字幕需要系统语音识别权限，权限文案已一并配置。

在装有 Swift 5.10+ 的环境可先运行不依赖 Apple SDK 的检查：

```bash
./scripts/check-ios.sh
```

它会解析全部 Swift 源码，并执行工程文档/草稿管理、SRT 编解码、3D LUT、倒放 PCM 声道帧、转场、正放/倒放分割、速度曲线与字幕时间映射测试。
仓库的 `iOS Build` GitHub Actions 工作流还会在 macOS runner 上生成 Xcode 工程，并使用可用的 iPhone Simulator 执行真正的 `xcodebuild test`。

## 验证边界

Linux 环境可以执行 Swift 语法解析和纯 Foundation 工程文档测试，但不能链接 Apple 的 SwiftUI、PhotosUI、AVFoundation，也不能运行 iOS 模拟器。因此最终发布前必须在 Mac/Xcode 上完成：

- iPhone 真机相册导入与保存；
- 前后台切换、强制退出后的工程恢复；
- 横竖屏和不同尺寸 iPhone/iPad 的界面检查；
- 长视频、多素材、低存储空间和导出中断测试；
- 静态图片代理生成、画中画旋转/透明度与多音轨混音导出；
- 麦克风拒绝、来电/切后台中断以及旁白文件恢复；
- Apple Speech 可用性、端侧识别支持情况、长片段识别和权限拒绝；
- 长视频音画倒放的内存峰值、声道顺序、方向信息、音画同步和调色后再次倒放；
- 不同厂商 `.cube` LUT 的色彩一致性、HDR/P3 素材以及 64 级 LUT 的内存峰值；
- 自定义速度曲线的触控拖动、长素材音画同步，以及无转场/叠化/左右推混排边界；
- 主轨和画中画自定义贝塞尔关键帧的密集触控编辑、分割连续性与最终导出一致性；
- Release Archive、签名与 TestFlight 安装。
