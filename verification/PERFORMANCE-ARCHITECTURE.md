# 本地文件工具：性能与技术栈评估

> 历史开发记录：以下范围、参数与验证结论对应文中所述阶段，不代表 V0.1.0 本次已复验；发布版差异见 [验证记录说明](README.md)。

日期：2026-09-09。此文是源码、GLB 资源统计与官方架构文档分析，不是跨框架性能跑分。未测得当前设备的 GPU 帧时、整进程内存或文件索引吞吐；系统硬件信息查询在当前权限下未能取得。未修改产品代码或已确认的视觉规范。

## 当前实现的可核实成本

- `src/archive-loop.ts` 固定 9 × 32 = 288 个阵列位置，已经具备可见窗口复用机制。文件总数不必决定 GPU 中的模型数量。
- `src/scene.ts` 从 GLB 选择五个材质组建立 InstancedMesh；没有为阵列复制全部模型。五组分别为 Frosted_Polymer、Ivory_Edges、Optical_Diffuser、Champagne_Index、Titanium_Fasteners。
- 直接读取 `public/assets/archive-cassette.glb` 的 accessor 索引数量，五组每份分别为 188、6248、188、1468、896 个三角形，共 8988。288 个位置在一次遍历全部阵列几何的 pass 中提交约 2,588,544 个三角形。这不是每帧最终总量，也不是最终可见像素量；阴影和透射等 pass 绘制的对象集合不同，隐藏实例通过缩放为零处理，仍占实例提交。
- Ivory_Edges 占阵列几何三角形约 69.5%，是背景模型 LOD 原型最值得检查的部位。原始 GLB 全部 11 个 primitive 共 39544 个三角形，不能直接乘以 288 作为实际阵列负载。
- 五组实例矩阵每帧均标记更新：5 × 288 × 16 × 4 = 92160 字节，约 90 KiB/帧，60 FPS 约 5.27 MiB/s。仅从传输量看并不大；这不等于 CPU 计算耗时已测定。
- `src/scene.ts` 开启物理透射、2048² 阴影、SSAO 和景深。当前 Three.js 的 SSAOPass 额外渲染法线并做屏幕空间处理，BokehPass 另绘深度；透射也有背景捕获与纹理处理。实例化减少提交调用，不能免除几何处理和多 pass 的像素成本。
- 所有阵列 InstancedMesh 设置 `frustumCulled = false`，没有逐实例视锥剔除。外围与雾中的卡片仍可能提交，是否减少窗口或增加分块剔除需检查镜头边界。
- `src/main.ts` 持续 requestAnimationFrame，主场景在独立查看器打开时暂停绘制。档案预览有持续呼吸动画；减少动态效果只改变动效状态，不会停止主渲染循环。启动阶段三维画布透明时也没有在主循环按其可见性跳过场景更新。
- 高画质使用 `min(devicePixelRatio, 1.5)`，再结合固定 1920×1080 舞台的窗口缩放。相同 CSS 视口从有效像素比例 1 提到 1.5，渲染面积增加到 2.25 倍；不能据此声称 FPS 必然变为 1/2.25。低画质同时关闭 AO 和景深，不能用该开关单独归因某一种效果。

结论：GPU 几何、多 pass 与长期持续绘制是优先验证的瓶颈假设。当前没有证据表明 TypeScript 执行速度是主要瓶颈，也没有证据证明更换宿主能自动提升特定倍数的 FPS。

## 文件数据层

文件名、路径、大小和时间戳索引，与三维效果分开测量。缩略图、全文提取、视频解码也应独立排队，不能在初次扫描时读取所有内容。

建议查询层返回有界分页结果，附稳定标识与查询代次；快速输入取消或丢弃旧查询。界面只维护当前结果页和附近卡片，不把百万条记录反复序列化传给前端。收藏与目录绑定等元数据可以用 SQLite；文件名包含匹配的索引策略需要单独设计，普通 B-tree 不能自动加速任意子串查询。

绑定少量目录可用后台枚举、持久缓存与目录变更监听。监听事件需要合并，丢失或溢出后重扫对应范围。全盘搜索优先接入 Everything SDK，避免第一版自行实现完整 NTFS 索引器。SDK 需要 Everything 客户端后台运行；性能统计应把它的索引时间和内存计入总成本。

## 技术栈取舍

| 方案 | 对本项目的判断 | 主要成本或限制 |
| --- | --- | --- |
| Electron + Three.js | 复用现有代码最直接，适合快速产品化 | 携带 Chromium/Node 运行时；不能解决既有 GPU 渲染成本 |
| Tauri 2 + Rust + Three.js | 推荐作为保留当前效果的第一条验证路线；Rust 承担索引和系统操作 | Windows 前端仍是 WebView2。减少自带浏览器的发行负担，不代表运行内存或 FPS 必然优于 Electron |
| C++ + Qt Quick/QML + Qt Quick 3D | 推荐作为非 Web 的工具型应用候选，具备集成的二维控件与三维场景 | UI 和渲染层需迁移；灯光、透射、色彩映射和后处理需重新校准。Qt Quick 3D 官方许可为 GPLv3 或商业许可，选型时需与发行方式匹配 |
| Godot 4 + C#，必要处接原生模块 | 偏三维交互体验的原生候选，场景和动画工作流适合档案阵列 | 工具所需的系统集成、文件预览与列表行为要自行完善；游戏引擎运行成本仍存在，不保证更省电 |
| Windows 原生 UI + Direct3D，或 Rust + wgpu | 对渲染管线、内存和调度控制最多，适合将底层优化作为长期核心投入 | 需要自行搭建较多材质、后处理、文本与输入系统；开发和视觉验证成本最高，并无本项目跑分证明其收益 |

Tauri 是桌面宿主方案，wgpu 是图形 API，二者不处于同一抽象层。wgpu 在原生运行时可以使用 D3D12、Vulkan、Metal，不要求网页或浏览器。WinUI 的 SwapChainPanel 可承载 DirectX，但不直接提供现成的 Three.js 材质与场景移植。

## 验证顺序与验收口径

1. 在相同机器、相同物理输出分辨率、相同画质和电源模式下记录现有生产构建。分别测试启动、闲置、连续换档、详情和独立查看器。记录帧间隔 P50/P95/P99、长帧、CPU、GPU、进程树内存与显存。帧率上限和垂直同步应保持一致。
2. 分别关闭 AO、景深、阴影和透射，分别调低渲染分辨率、引入背景 LOD，定位单项收益；不要以同时关闭多个效果的差值归因某一项。静止、隐藏和最小化状态单独检查绘制调度。
3. 在独立原型中测试背景边框简化，保留当前特写模型；对抽取和归位的材质、几何连续性做对照。涉及美术模型的生成仍遵循项目 Blender MCP 要求。原型不能直接替换用户确认的外观。
4. 用 1万、10万、100万条元数据测查询和分页，以真实目录测磁盘枚举与监听；合成数据不能代替真实磁盘吞吐。分别报告冷启动、热缓存以及缩略图队列负载。
5. 只有在同一资产、相机、输出尺寸、可比材质效果下，才用 Tauri 或原生候选原型进行对比。新引擎默认场景的高帧率不能证明当前画面迁移后更快。

可用的初步目标：60 Hz 下帧预算 16.7 ms；索引就绪后首批结果端到端延迟 P95 小于 100 ms；隐藏和最小化时停止三维绘制。以上是候选验收目标，不是现有成绩，也不保证适用所有硬件。

推荐决策：保留成果并尽快得到本地工具，先验证 Tauri + Rust + Three.js；明确选择完全非 Web 且以桌面工具功能为主，评估 Qt Quick 3D 的同场景原型；若主要价值是三维交互且不选 Qt 的许可路线，评估 Godot。不要仅根据框架名称进行全量重写。

## 官方资料

- [Everything SDK](https://www.voidtools.com/support/everything/sdk/)
- [Tauri 架构](https://v2.tauri.app/concept/architecture/)、[WebView 版本](https://tauri.app/reference/webview-versions/)
- [Electron 性能分析指导](https://www.electronjs.org/docs/latest/tutorial/performance)
- [Qt Quick 3D 功能与许可](https://doc.qt.io/qt-6/qtquick3d-index.html)、[后处理性能成本](https://doc.qt.io/qt-6/qml-qtquick3d-effect.html)
- [Godot MultiMesh](https://docs.godotengine.org/en/stable/tutorials/performance/using_multimesh.html)
- [wgpu 原生后端](https://docs.rs/wgpu/latest/wgpu/)
- [WinUI SwapChainPanel](https://learn.microsoft.com/en-us/windows/windows-app-sdk/api/winrt/microsoft.ui.xaml.controls.swapchainpanel?view=windows-app-sdk-1.8)
- [Windows 目录变化监听](https://learn.microsoft.com/zh-cn/windows/win32/api/winbase/nf-winbase-readdirectorychangesw)
