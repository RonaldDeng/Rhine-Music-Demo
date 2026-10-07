# V0.4.0 本地验收记录

## 2026-10-07 · 缩略图与搜索动效

历史版本对比、实现、数值轨迹与浏览器结果见[动效复核](MOTION-REVIEW-2026-10-07.md)。本轮使用隔离14位歌手、278张专辑和静音样本，验证标准视图／详情中的搜索、两步歌手入口、顶部位置、暖昼/深夜、窄屏/超宽屏、真实列、减少动态和快速反向。`check:interaction`、`check:overview`、camera、scene、renderer-startup与生产构建通过；不涉及个人曲库和在线资料，不代表长期性能或音质验收。

## 2026-10-07 · DSF / DFF 播放

本轮新增本机 DSD → PCM 播放，目标输出为 24 位 / 176.4 kHz，保留声道数，经既有浏览器与 CoreAudio 共享输出播放。仅写播放缓存；曲库保留 DSD 来源信息，原始歌曲与标签只读。播放、暂停和切歌沿用现有操作。

验证使用隔离目录与自生信号，覆盖 DSF LSB / MSB、DFF MSB，以及 DSD64 / 128 / 256；检查解码后的 24 位 / 176.4 kHz、双声道信号、有效时长、不同容器与位序的 PCM 一致性、缓存复用、源文件不变、伪扩展名、截断文件以及 HTTP 路径。

| 检查 | 本轮结果 |
| --- | --- |
| `node --test scripts/check-music-audio.mjs scripts/check-dsd-fixtures.mjs` | 40 项，39 通过、1 跳过；未提供可选的官方 APE 样本，跳过不等于 APE 本轮通过 |
| `check-music-player.mjs` | 22 / 22 通过，包括 DSF / DFF 的新旧索引、准备取消、暂停恢复、缺失 FFmpeg 和 CoreAudio 控制器路径 |
| `check-music-library.mjs` | 9 / 9 通过，包括旧索引恢复后即可请求 DSD 本机解码 |
| TypeScript 与 `npm run build` | 通过；Vite 保留既有主包体积提示 |

播放器控制器检查使用受控 Audio / fetch 替身；另完成以下真实浏览器与设备联调：

- 用户指定的 DSF 实曲为 DSD64、双声道、2,822,400 Hz / 1 位；准备结果为 24 位 / 176,400 Hz、双声道，时长 203.499683 秒。浏览器通过界面播放时钟推进至 15.34 秒，暂停于 25.21 秒，恢复后推进至 25.48 秒。
- 通过界面切换到 **MiniFuse 2**，CoreAudio 音量固定为 **0**；播放时钟推进至 67.26 秒，暂停于 75.81 秒，恢复后推进至 75.99 秒，最后手动停止。
- 8 秒 DFF / DSD128 双声道合成样本在真实浏览器播放，时钟从约 0.19 秒推进到 8 秒并自然结束。
- 实曲前后 SHA-256 一致。索引替身与 PCM 缓存均在独立临时目录，未改个人索引，未查询线上资料；测试结束停止临时服务。1280×720 暖昼页面控制台没有 error，仅有既存的 Three.js 阴影弃用 warning。

这些结果验证了 DSF / DFF → 本机 PCM → 浏览器，以及 DSF 实曲经所选 CoreAudio 设备的静音播放、暂停与恢复路径；不代表听感、bit-perfect 或全部设备兼容性验收。

本轮不包括 Native DSD / DoP、DST 压缩 DFF 与多声道实样、私人完整曲库长期播放或外接 DAC 音质试听。24 位 / 176.4 kHz 描述 PCM 缓存，不代表共享输出的设备采样率或 bit-perfect。

## 2026-10-03 · 真实缩略图中心对齐

- 真实列在总览中按整列中心对齐：奇数取中间专辑，偶数取中间两张之间。列名、封面与盒体使用相同偏移，返回近景恢复当前选择。
- 本轮 `npm run build`、`check-music-camera.mjs`、`check-music-presentation.mjs`（25 项）、`check-music-scene.mjs` 通过；构建保留原有的大包体提示。
- `npm run check:overview` 通过：直接执行生产投影、列偏移和可见池方法，覆盖 1 / 2 / 3 / 4 / 49 / 100 张、5 个浏览行位置和5 个过渡进度，验证中心对称、整数专辑身份、不重复、长列连续窗口、近景恢复及填充模式保持原位。
- 实际浏览器使用独立端口 5413 和 `?demo=1&lab=0`，只读内置演示封面。1280×720 暖昼检查 2+1 张列；点选《夜间航线》后返回对应近景，点击“器乐”列名正常定位。深夜按歌手检查 3 张列；390×844 竖屏总览无横向溢出（页面宽与滚动宽均为 390）。减少动态下进入总览、返回近景并打开详情通过。临时视口覆盖已清除。
- 截图：[偶数列与单张列](media/v0.4.0/overview-centered-even-day.png)、[奇数列深夜](media/v0.4.0/overview-centered-odd-night.png)、[竖屏深夜](media/v0.4.0/overview-centered-portrait-night.png)。下方首轮截图保留当时的排列效果。
- 本轮未使用个人曲库，未测试音频；大规模长列由自动化回归覆盖，不冒充真实完整曲库的浏览器验证。

## 首轮与其他验证记录

后续冷启动优化、额外回归和浏览器帧时间见 [STARTUP-V0.4.0.md](STARTUP-V0.4.0.md)。下方首轮记录保留当时的测试范围。

日期：2026-10-02；工作目录为独立的 V0.4.0。没有 GitHub 推送、提交、标签或发布，未覆盖 V0.3.1。继承旧版未提交修改；曲库测试使用 `/tmp` 隔离目录。个人歌曲与封面未用于测试或截图。

## 构建与自动化

生产构建 `npm run build` 通过：TypeScript、Vite 和离线资源生成完成。Vite 仍提示继承的 Three.js 主块超过 500 kB（约 1.13 MB，gzip 376 kB）；不是编译失败，也未将此轮标为首屏体积优化。

最终集合：

```sh
RHINE_TEST_APE=/tmp/rhine-v040-audio-fixtures/luckynight.ape npm run check:v040
```

退出码 **0**。本次提供完整官方 APE 样本，音频套件没有跳过。完整输出保存为 [verification-v040.txt](verification-v040.txt)。新增演示启动器另通过 `bash -n`；真实 Finder 双击不属于本轮自动化断言。

| 范围 | 结果与实质覆盖 |
| --- | --- |
| 曲库、介绍、场景 | 16 项 Node 检查通过，场景循环/归组和比例检查通过 |
| 原生音频与解码 | 18 项通过，真实 WAV / FLAC / ALAC / AIFF / WavPack / MP3 / Opus / AAC / float32 / APE，真实 Swift 编译与 CoreAudio 0 音量播放 |
| 播放器 | 6 项通过，暂停恢复、跨后端位置、BGM 独立、快速取消及曲终处理 |
| 模型与封面 | 三批/1000三角/尺寸、壳内嵌入、材质、UV、比例、图集边界、异步竞争与快照检查通过 |
| 总览与真实列 | 9×48 实例池唯一性、不同张数、长短列生产投影方法、视口裁剪、空库/未加载与收敛检查通过 |
| 相机、光带、动效 | 相机与排光回归、11.6 s 片头状态机、25 项 presentation、3 项 UI 动效、0.25/1/3×、20/30/60/120 fps 通过 |
| 布局、内容、制作信息 | viewport 与内容 18 项、制作信息 30 项通过 |
| 启动器 | 13 项通过，包括目录含空格、同项目识别、占用端口、并发启动、构建失败与来源限制 |

脚本中使用的受控 Canvas、Audio、DOM/WAAPI harness 只证明对应逻辑，不冒充实际浏览器、硬件或 GPU 测量；本轮真实检查列在下方。

## 实际浏览器检查

使用 Codex Browser 技能连接本地生产构建；前端演示运行在 5401，隔离音频服务在 5402。使用当前版本构建重新载入，未把旧 dist 当作新结果。

- **1280×720 暖昼/深夜**：对照填充与真实列。按流派真实场景只有“氛围音乐 2 张、器乐 1 张”；选择器乐标签、返回近景、打开横向封面详情、深夜切换均通过。
- **按歌手重新排列**：演示三张同歌手的封面归于唯一一列，标签显示“RHINE · 演示封面 / 3 张专辑”。刷新后真实列偏好保留。
- **总览点选**：实际鼠标点击盒体选到《夜间航线》，退出总览并回到近景；标签可定位另一列，返回按钮恢复正文与原导航。
- **390×844 竖屏**：近景、详情、夜间竖幅封面及总览；实际 `documentElement.scrollWidth === clientWidth === 390`。列名按避让显示，导航与返回可用。
- **2560×1080 超宽屏**：真实歌手列及名称正常；实际视口和页面宽度为 2560，无横向溢出。尺寸测试完成后已清除临时视口覆盖。
- **完整开场**：主应用设置重播后进入真实 `array` 阶段（已观察实时三维截图），完成时 overlay hidden、musicBoot=done，恢复待选；未自动打开专辑。另实测点击“跳过开场”与开启减少动态后重播，均回到可操作近景。
- **标语**：固定节点检查页另验证暖昼横屏和深夜竖屏完整文字“回到按专辑听歌的慢私心”；截图有检查控制条，未冒充主场景画面。

## 浏览器与 CoreAudio 联调

所有歌曲音量设为 **0**，关闭界面音效和氛围 BGM。源为 FFmpeg 官方公开 APE 样本和现场生成的音频，不读取私人音乐目录。

1. 音频设置显示本机解码与 CoreAudio 已就绪，列出系统默认及实际五个输出端点。
2. 在实际浏览器点击播放 APE；服务准备 PCM 后播放状态为 playing、时长 **60.48 s**，真实浏览器时钟推进至 **20.12 s**。暂停记录位置 **20.423916 s**。
3. 通过设置切换到 CoreAudio，暂停位置保持 **20.423916 s**；选择 **MacBook Pro Speakers** 后点击播放。服务真实状态为 `playing:true`、`deviceId:86`、`volume:0`，时钟从约 **20.93 s** 继续。
4. 原生播放至约 **40.44 s** 暂停，再切回浏览器，暂停位置保持 **40.44377994557823 s**。点击播放，真实浏览器继续推进至 **58.72 s**；最后点击停止，确认原生端停止并清空曲目。

这些结果证明 APE → 本机 PCM → 真实浏览器，以及所选 CoreAudio 设备的功能路径与暂停切换；不是音质试听、全部设备认证或 bit-perfect 检测。

## 截图索引

| 文件 | 内容 |
| --- | --- |
| [overview-realistic-day.png](media/v0.4.0/overview-realistic-day.png) | 1280×720，真实 2+1 专辑列与标签 |
| [overview-filled-day.png](media/v0.4.0/overview-filled-day.png) | 1280×720，保留填充画面的对照 |
| [overview-artist-ultrawide-day.png](media/v0.4.0/overview-artist-ultrawide-day.png) | 2560×1080，同歌手三张专辑只出现一次 |
| [overview-artist-portrait-day.png](media/v0.4.0/overview-artist-portrait-day.png) | 390×844，真实列窄屏总览 |
| [case-detail-landscape-day.png](media/v0.4.0/case-detail-landscape-day.png) | 暖昼横幅封面、薄盖和高磨砂侧脊 |
| [case-detail-landscape-night.png](media/v0.4.0/case-detail-landscape-night.png) | 深夜同封面详情 |
| [case-detail-portrait-night.png](media/v0.4.0/case-detail-portrait-night.png) | 深夜竖屏、竖幅封面完整比例 |
| [opening-slogan-day.png](media/v0.4.0/opening-slogan-day.png) | 标语检查页暖昼节点 |
| [opening-slogan-night-393.png](media/v0.4.0/opening-slogan-night-393.png) | 标语检查页 393×852 深夜节点 |

## 仍需使用者体验的边界

未进行个人完整曲库长期播放、USB / 蓝牙物理热插拔、全部设备试听、严格帧时间或能耗基准，也未测试不同 macOS 版本。UI 显示 60 FPS 不是性能基准。CoreAudio 为共享模式，首次完整 PCM 准备可能等待；首轮未实现的 DSF / DFF 播放已在 2026-10-07 追加，验证范围见本页顶部。Native DSD / DoP、独占 DAC、gapless 和自动设备采样率不在本版承诺内。

原视频质量感受仍需最终体验判断；已完成依据分析、真实截图、流程检查与相关自动化，未宣称逐帧或精确物理复刻。模型可复现源是新增 Three.js 生成脚本；旧 Blender 文件仅保留历史版本。
