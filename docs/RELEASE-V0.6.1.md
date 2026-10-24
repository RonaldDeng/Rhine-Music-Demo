# Rhine Music V0.6.1｜版本更新

发布日期：2026-10-24。基于 V0.6.0b 整理的 macOS 本地源码发行版，比较基线为 V0.5.0。

- 全新的沉浸歌词视图：支持本地与在线歌词，随播放逐行高亮。
- 歌词字体、字号和高亮位置可独立设置，横屏专辑详情更清晰。
- 优化界面动画与页面衔接，清理开发调试入口，修复其他细节问题。

## 下载与启动

- [macOS 源码包](https://github.com/RonaldDeng/Rhine-Music-Demo/releases/download/v0.6.1/Rhine-Music-Demo-v0.6.1-macOS.zip)
- [SHA-256 校验](https://github.com/RonaldDeng/Rhine-Music-Demo/releases/download/v0.6.1/SHA256SUMS.txt)
- [GitHub Release](https://github.com/RonaldDeng/Rhine-Music-Demo/releases/tag/v0.6.1)

完整解压至 `V0.6.1/` 后双击 `启动音乐播放器.command`。需 Node.js ≥22.12.0；完整解码与无缝播放需本机 FFmpeg／ffprobe，Mac 原生输出另需 Apple Command Line Tools。这是源码包，不是 `.app`，首次运行需安装锁定依赖并构建，不附带歌曲。

升级时先停止旧版服务，把新文件夹放在旧版本同一父目录，继续使用旁边的 `music-data-v3`；保留旧目录。自定义数据目录可通过 `MUSIC_DATA_DIR` 指定。歌曲与标签只读，避免新旧服务同时写同一数据目录。

## 发布整理

移除布局实验页、个人参数导入导出、光效／动效调试面板、调试全局对象、预览歌词时钟和旧试验入口。保留已确认的布局和灯光默认值，以及普通动效速度、减少动态效果、歌词显示等用户设置。依赖 Vite 更新至 7.3.7；源码包不含依赖目录、构建结果、缓存、私人数据或开发研究材料。

歌词来源为网易云音乐、LRCLIB、AMLL TTML DataBase，使用时按当前曲目自动查询；来源代码许可与歌词版权分别标注。完整说明见 [歌词来源与许可](LYRICS.md) 和 [NOTICE](../NOTICE.md)。界面配图复用 V0.5.0 的抽象演示封面与虚构专辑数据；歌词配图使用原创短句及静音合成样本。

[README](../README.md) · [完整更新日志](../CHANGELOG.md) · [发布验证和已知边界](REVIEW-V0.6.1.md)
