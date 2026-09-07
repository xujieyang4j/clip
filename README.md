# MiniClip / Clip 视频编辑器

仓库包含两套面向不同终端的实现：

| 目录 | 技术栈 | 平台 | 定位 |
|---|---|---|---|
| `desktop/` | Electron + FFmpeg + whisper.cpp | Windows / macOS / Linux | 功能完整的桌面主线，详见 [`desktop/README.md`](desktop/README.md) |
| `Sources/` | SwiftUI + AVFoundation | iPhone / iPad | 原生 iOS App，针对触控和移动端媒体工作流设计 |

两端共享“素材库 + 非破坏性时间线 + 预览 + 导出”的产品语义，但渲染内核不同：桌面端使用 FFmpeg，iOS 端使用系统 AVFoundation 硬件编解码。

## iOS App 当前能力

- 从系统相册或“文件”App 批量导入视频。
- 导入媒体复制到 App 沙盒，避免选择器临时 URL 过期后无法继续编辑。
- 项目素材库支持同一素材反复加入时间线，并显示使用次数。
- 时间线片段选择、裁剪、拖动排序、左右移动、分割、复制和删除。
- 选中片段支持 0.25×–4× 变速和原声静音，预览与最终导出一致。
- 播放/暂停、播放头拖动和时间码显示。
- 多片段拼接及 0–2 秒画面/声音交叉叠化。
- 支持 9:16、16:9、1:1 画布，横竖素材会等比缩放并居中，预览与导出一致。
- 背景音乐循环、原声与音乐音量控制。
- 撤销/重做；连续滑块拖动合并为一次撤销。
- 自动保存并恢复素材库、时间线、裁剪、转场和配乐状态。
- 可从顶部菜单新建空白项目，操作前会二次确认。
- AVFoundation 导出 MP4，导出后可分享或直接保存到系统相册。
- 中文默认，可切换英文。

当前 iOS 版本尚未追平桌面版的字幕、画中画、多视频/音频轨、调色、关键帧、倒放及本地语音识别。这些是后续原生迁移重点。

## 架构

- [`EditorModel.swift`](Sources/EditorModel.swift)：编辑状态、素材持久化、播放控制、AVFoundation 合成和导出。
- [`ContentView.swift`](Sources/ContentView.swift)：适配 iPhone 小屏的预览、工具面板和导出入口。
- [`TimelineView.swift`](Sources/TimelineView.swift)：片段时间线、裁剪、选择和排序。
- [`MediaLibraryView.swift`](Sources/MediaLibraryView.swift)：可复用项目素材库。
- [`ImportedVideo.swift`](Sources/ImportedVideo.swift)：PhotosPicker 的文件流式传输，避免大视频整体读入内存。
- [`ProjectDocument.swift`](Sources/ProjectDocument.swift)：轻量 JSON 自动保存格式。
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

在装有 Swift 5.10+ 的环境可先运行不依赖 Apple SDK 的检查：

```bash
./scripts/check-ios.sh
```

它会解析全部 Swift 源码，并执行工程文档往返及转场/分割时间线数学测试。
仓库的 `iOS Build` GitHub Actions 工作流还会在 macOS runner 上生成 Xcode 工程，并使用可用的 iPhone Simulator 执行真正的 `xcodebuild test`。

## 验证边界

Linux 环境可以执行 Swift 语法解析和纯 Foundation 工程文档测试，但不能链接 Apple 的 SwiftUI、PhotosUI、AVFoundation，也不能运行 iOS 模拟器。因此最终发布前必须在 Mac/Xcode 上完成：

- iPhone 真机相册导入与保存；
- 前后台切换、强制退出后的工程恢复；
- 横竖屏和不同尺寸 iPhone/iPad 的界面检查；
- 长视频、多素材、低存储空间和导出中断测试；
- Release Archive、签名与 TestFlight 安装。
