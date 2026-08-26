# MiniClip — 最小视频剪辑原型

一个能跑通 **导入 → 时间线裁剪/拼接/排序 → 实时预览 → 导出 mp4** 的最小原型。

本仓库现在有**两套实现**,功能一致,针对不同平台:

| 目录 | 技术栈 | 跑在哪 | 说明 |
|---|---|---|---|
| **`desktop/`** | Electron + FFmpeg + whisper.cpp | **Windows / macOS / Linux** | 主线桌面编辑器：裁剪、变速/倒放、调色、转场、可编辑字幕和本地自动语音识别、画中画与关键帧曲线动画。见 [`desktop/README.md`](desktop/README.md) 和 [图文使用说明](desktop/使用说明.md) |
| **`Sources/`** | Swift + AVFoundation | **iOS / macOS** | iPhone 原生;需要 Mac + Xcode。见下文 |

> 想在桌面(尤其 Windows/Linux)用,走 `desktop/`。要 iPhone 原生 App,走 `Sources/`(Swift)。
> 桌面版目前功能更完整；Swift 版保留为 iPhone 原生原型，两者不是同一套源码。

---

# Swift / iOS 版(`Sources/`)

同一套代码可编译到 **macOS 和 iOS**。

---

## 技术栈说明:为什么是 Swift + Xcode

这个 App 目标是**在 iPhone 上原生运行**(顺带也能在 Mac 上跑)。iPhone 原生 App 只能用苹果工具链:**Swift + Xcode**,视频处理用苹果自带的 **AVFoundation**。
Electron / 网页那类跨平台方案上不了 iPhone(App Store 禁止自带浏览器引擎),所以这里绑定 Swift 是刻意的选择,不是随意为之。

## 你会用到的 4 个源文件(在 `Sources/` 里)

| 文件 | 作用 |
|---|---|
| `MiniClipApp.swift` | App 入口 |
| `EditorModel.swift` | 核心逻辑:导入、AVFoundation 合成、导出(最重要的一块) |
| `ContentView.swift` | 主界面:预览播放器 + 顶部按钮 + 状态栏 |
| `TimelineView.swift` | 时间线:片段卡片、裁剪滑块、排序/删除 |

> ⚠️ 这些 `.swift` 文件**不能直接双击运行**。Xcode 需要一个「工程(project)」来管理它们。
> 本仓库用 **XcodeGen** 自动生成工程,你不用再手动新建工程、拖文件、点权限——下面第 1-2 步就是这个。

---

## 前提

- 一台 **Mac**(编译 iPhone App 必须要 Mac)。
- 安装了 **Xcode**(App Store 免费下载)。

## 第 1 步:生成 Xcode 工程(一条命令)

本仓库已带好 `project.yml`(工程描述)和 macOS 权限文件,用 [XcodeGen](https://github.com/yonaskolb/XcodeGen) 一键生成工程:

```bash
brew install xcodegen   # 只需装一次
cd MiniClip
xcodegen generate       # 生成 MiniClip.xcodeproj
open MiniClip.xcodeproj  # 用 Xcode 打开
```

`project.yml` 里已经配好了:双平台(iOS + macOS)、最低系统版本、iOS 相册权限文案、macOS 沙盒「用户选择文件读写」权限。**不用再手动点任何权限设置。**

> 以后增删 `Sources/` 里的源文件,或改了 `project.yml`,重新跑一次 `xcodegen generate` 即可。
> 生成出来的 `MiniClip.xcodeproj` 已在 `.gitignore` 里,不入库。

## 第 2 步:选签名(装真机才需要)

只在 Mac 上跑的话可跳过。要装到 iPhone:
- Xcode 里选中项目 → `TARGETS > MiniClip` → **Signing & Capabilities**
- **Team** 选你的 Apple ID(没有就点 Add an Account 登录,免费账号也行)。

## 第 3 步:运行

- 顶部选目标:选 **My Mac** 先在 Mac 上跑(最快,不用连手机)。
- 点左上角 ▶️ 运行。
- 出现界面后:点 **导入视频** 选一个 mp4/mov → 时间线出现卡片 → 拖滑块裁剪、**拖动卡片**排序(或用箭头)→ 上方预览播放 → 点 **导出**。
- 想配乐:点 **添加背景音乐** 选一个 mp3/m4a/wav,音乐会自动循环铺满整条时间线;用「原声 / 音乐」两个滑块调音量比例。
- 想要转场:有 2 段以上时,拖「转场」滑块(0–2 秒),相邻片段间会做交叉溶解(画面+声音同时淡入淡出)。

想装到 iPhone:顶部目标改成你的手机(需插线 + Apple ID 登录 Xcode),再点 ▶️。

---

## 现在能干什么

- ✅ 导入多段视频(可多选)
- ✅ 每段独立裁剪(起点/止点滑块)
- ✅ 调整片段顺序(**拖动卡片** 或箭头)、删除片段
- ✅ 拼接后实时预览播放
- ✅ 导入一段背景音乐(自动循环铺满整条时间线,可调原声/音乐音量)
- ✅ 相邻片段交叉溶解转场(0–2 秒可调,画面与声音同步淡变)
- ✅ 撤销/重做(裁剪、排序、删除、加/删音乐、调音量、转场都能回退)
- ✅ 导出为单个 mp4,并可通过系统「分享」保存/发送

## 故意没做的(下一步再加)

- 滤镜、特效(需要 Core Image / Metal)
- 字幕、贴纸
- 精确到帧的时间线拖拽、吸附
- 更多转场样式(目前只有交叉溶解)

---

## 常见问题

- **`xcodegen: command not found`**:先 `brew install xcodegen`;没有 brew 就去 [XcodeGen 仓库](https://github.com/yonaskolb/XcodeGen) 按说明装。
- **导入后黑屏没画面**:多半是选的文件不是标准视频编码(权限已由 `project.yml` 自动配好)。先试一个普通手机拍的 mp4。
- **macOS 报文件读取失败**:确认用的是 `xcodegen generate` 生成的工程——沙盒「用户选择文件读写」权限写在 `Sources/MiniClip-macOS.entitlements` 里,已由 `project.yml` 自动挂上。
- **导出很慢**:`AVAssetExportPresetHighestQuality` 会重新编码;正常现象,状态栏有进度。
