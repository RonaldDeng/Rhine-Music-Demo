# Windows 适配说明（V0.3.0 补丁）

日期：2026-10-01。目标：同一份 V0.3.0 代码在 Windows 10 及更新版本上完整运行，界面、交互和数据格式与 macOS 版相同。完整改动清单见 [CHANGELOG](../CHANGELOG.md)。

## 两种使用方式

| 方式 | 适合谁 | 需要 |
| --- | --- | --- |
| **Windows 包** `Rhine-Music-Demo-v0.3.0-Windows.zip` | 只想听音乐 | 解压后双击 `Rhine Music.exe`。自带 Node.js 22 LTS 和已构建界面，不需要联网。 |
| **源码** | 开发、修改界面 | Node.js 22.12 或更新的 LTS。双击 `启动音乐播放器.bat`（首次会联网安装依赖并构建），或用 `npm ci`、`npm run build`、`npm run music`。 |

Windows 包解压后的顶层目录为 `V0.3.0/`，与 macOS 源码包一致，音乐数据仍默认放在其上一级的 `music-data-v3/`，可用 `MUSIC_DATA_DIR` 覆盖。升级方式也相同：先退出旧服务，把新包放在同一个父目录。

### 包内容

`Rhine Music.exe`、`启动音乐播放器.bat`、`使用说明-Windows.txt`、`runtime/node.exe`（Node.js 官方原版，构建时校验 SHA-256）、`dist/`（已构建界面，`.music-build.json` 标记为预编译）、`scripts/` 中的 5 个运行时脚本、`node_modules/`（仅生产依赖）、`LICENSE`、`NOTICE.md`。不含源码、模型源文件、个人数据和开发资料。

### `Rhine Music.exe`

用 .NET Framework 4 自带的 C# 编译器构建（Windows 10 及更新版本自带，不需要 Visual Studio 或 .NET SDK），源码在 [`windows/RhineMusic.cs`](../windows/RhineMusic.cs)。

- 预编译包：隐藏运行 Node，不显示控制台窗口；失败时弹出对话框并附日志末尾。
- 源码目录仍需安装依赖或构建时：改为显示控制台（经 `启动音乐播放器.bat`），能看到进度和错误。
- 依次查找 `runtime\node.exe`、`PATH`、`Program Files\nodejs`、`%LocalAppData%\Programs\nodejs` 和 nvm 链接；都没有时提示并可打开 Node.js 下载页。
- 没有代码签名证书，首次运行可能出现 SmartScreen 提示（“更多信息 → 仍要运行”）。

## 构建 Windows 包

在 Windows 上执行：

```powershell
npm run package:windows
```

脚本 [`scripts/package-windows.mjs`](../scripts/package-windows.mjs) 依次完成：`npm ci`、`npm run build`、整理运行文件、在暂存目录执行 `npm ci --omit=dev --ignore-scripts`、下载并校验 Node.js 22 LTS（缓存在 `.tools/`）、编译 exe、用系统 `tar.exe` 压缩。产物位于被 Git 忽略的 `release/`：压缩包、`.sha256` 和独立的 `Rhine Music.exe`。可用 `--node-version 22.x.y` 固定运行时版本，`--skip-build` 跳过构建。

打包后运行 `node scripts/check-windows-package.mjs` 做冒烟测试：模拟没有 Node.js 的电脑，把包解压到含中文、空格和括号的目录，用精简的 `PATH` 启动 exe，并检查扫描、Range 播放、封面、服务复用、UNC 路径和端口顺延。

## 路径规则

- 音乐文件夹必须是完整路径：`D:\音乐`、`D:/音乐`、`\\服务器\共享\音乐`。`\音乐`（相对当前盘）、`D:音乐` 和 `\\?\` 前缀路径会被拒绝。
- 资源管理器“复制为路径”的带引号路径可直接粘贴。
- Windows 路径不区分大小写：`D:\Music` 与 `d:\music\Live` 视为同一目录树，只保留上层目录。
- 扫描忽略 `$RECYCLE.BIN`、`System Volume Information`、`.` 开头的文件夹，以及 `._` 开头的 AppleDouble 文件；无权限读取的子文件夹被跳过，不中断扫描。
- 服务拒绝带 `:` 的静态路由（NTFS 备用数据流、盘符），并保留原有的反斜杠、`..`、Origin／Host 与只读限制。

## 启动可靠性

- **端口**：默认 5175，被占用时顺延到 5184。Windows 的 Hyper-V、WSL 和 Docker 会保留一段端口，这类端口探测为空闲、监听时却报 `EACCES`；服务启动失败且日志含 `listen EACCES` 或 `listen EADDRINUSE` 时，启动器自动换下一个端口重试，十个端口都不可用才报错。其他启动失败不会被重试。
- **启动锁**：`music-data-v3\launcher.lock` 记录启动器进程号，并由持有者定时刷新。持有者进程已不存在，或锁超过 30 秒没有刷新（进程号被复用、被结束、断电），后来的启动器会自动接管，不再要求手动删除文件；持有者仍在运行时仍然拒绝第二个启动器。接管通过 `launcher.lock.takeover` 目录互斥，并确认锁仍是刚才判定过期的那一个，两个启动器不会互相删除对方的新锁。

## 已执行的检查

环境：Windows 11（10.0.26200）、Node.js 24.16.0、npm 11.17.0，Windows 包内运行时为 Node.js 22.23.3。

- 改动前基线：`npm ci`、`npm run build`、`npm run check:music`、`npm run check:content` 均通过；`check-music-launcher.mjs` 中 macOS `.command` 用例在 Windows 失败（该文件不在原 `check:music` 内）。
- 改动后：`npm run build`（含 `tsc`）通过；`npm run check:music` 通过，其中平台与启动器检查 37 项（34 项通过，3 项为 macOS／POSIX 专属用例按平台跳过，没有失败）；`npm run check:content` 18 项通过。
- Windows 专属自动化用例：`.bat` 在含中文、空格、括号和 `$()` 的目录中切换工作目录、优先使用 `runtime\node.exe`、传递失败退出码、缺少 Node.js 时给出安装提示；预编译包检查；LF／CRLF 指纹一致；路径、npm 调用、重试、扫描忽略和路由拒绝。
- 源码目录实际启动：通过 `npm run build` 的 Windows 调用路径构建，随后启动服务；再次启动复用同一服务。
- Windows 包冒烟测试（`check-windows-package.mjs`）9 项全部通过：精简 `PATH` 下 exe 启动成功、后台服务无窗口、中文／空格／括号目录扫描、`._` 与回收站被忽略、音频 Range 返回 206、封面返回 200、前端页面可访问且危险路由返回 400、重复启动复用服务、UNC 路径（含引号）可保存扫描并播放、5175 被占用时顺延到 5176。
- 在 Edge 无头模式下确认空曲库欢迎页正常渲染（MiSans 字体、顶栏与主题开关）。

## 未覆盖范围

- 没有在真实 Windows 10 机器上运行，Windows 11 之外的系统版本依据 Node.js 22 与 .NET Framework 4 的官方支持范围推断。
- 带专辑的三维专辑架没有取得无头截图（软件渲染环境下 Edge 未输出图片）；三维渲染、动效帧率和真实 GPU 表现需要在有显卡的 Windows 桌面上手动确认。
- 播放验证使用合成的 WAV 示例库，不代表真实曲库、全部格式解码或蓝牙／声卡设备的兼容性。
- 仅提供 x64 包；Windows on ARM 可通过系统的 x64 模拟运行，未测试。
- exe 和包没有代码签名；`npm run package:windows` 的产物在不同机器上不保证逐字节一致（含构建时间戳）。
- `AGENTS.md` 中“V0.3.0 仅支持 macOS”的约束按要求保持原样，尚未同步更新。
