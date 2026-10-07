# 社区衍生版本与相关项目

官方主线：[RonaldDeng / Rhine-Music-Demo](https://github.com/RonaldDeng/Rhine-Music-Demo)。从 V0.4.1 起，主线继续围绕 macOS 本地专辑浏览与播放维护。

这里提供其他开发方向的入口，同时收录本项目的衍生版本和采用相近视觉方向或同一上游基础的相关项目；不把所有项目都视为本仓库的直接 Fork。**各版本独立开发、独立发布、独立提供支持；链接收录不代表主线已审查全部代码、完成安全审计或验证其兼容性。** 功能描述依据对应仓库的公开说明，实际支持范围请以作者文档为准。

| 项目 | 维护者 | 方向与来源（依据作者说明） | 参考入口 |
| --- | --- | --- | --- |
| [RhinE / Audio Archive](https://github.com/ericzhang12111-cell/RhinE) | [ericzhang12111-cell](https://github.com/ericzhang12111-cell) | Windows 上的 foobar2000 v2 主题：专辑架、同步歌词、信号可视化和外观配置；作者致谢 RhineLabUI 与本项目，未标注主线基准版本 | [仓库说明](https://github.com/ericzhang12111-cell/RhinE) |
| [Rhine Music · Windows](https://github.com/Bong712/Rhine-Music-Windows) | [Bong712](https://github.com/Bong712) | 本项目的 Windows 桌面移植，WebView2 窗口、同步 LRC 歌词、歌单与播放队列；未标注主线基准版本 | [仓库与发行说明](https://github.com/Bong712/Rhine-Music-Windows) |
| [rhine-music-windows](https://github.com/1494948/rhine-music-windows) | [1494948](https://github.com/1494948) | 基于本项目的第三方改造；这里链接的是 `rhine-music-local-mod` 分支的 Windows WebView2 包，包含歌词动效及专辑资料来源扩展，与该仓库另一条 Electron 路线区分 | [v0.3.0-local.4 指定版本](https://github.com/1494948/rhine-music-windows/releases/tag/v0.3.0-local.4) |
| [Rhine Lab Music](https://github.com/RelaxFish01/rhine-lab-music) | [RelaxFish01](https://github.com/RelaxFish01) | LX Music 播放后端与 RhineLabUI 三维视觉整合，提供歌词与音乐律动；属于共享视觉上游的相关项目 | [仓库与使用指南](https://github.com/RelaxFish01/rhine-lab-music) |
| [Rhine-Music-Demo-Win-](https://github.com/MT-gar/Rhine-Music-Demo-Win-) | [MT-gar](https://github.com/MT-gar) | 基于 V0.3.0 的 Windows 适配与启动/打包；独立在线专辑架，支持 Internet Archive 和 Subsonic 兼容服务 | [仓库说明](https://github.com/MT-gar/Rhine-Music-Demo-Win-) |

上表链接与公开说明核对日期：2026-10-07。此日期不代表代码测试日期或作者的维护承诺。指定版本链接用于复现作者当时的说明，不表示它始终是最新版；平台、下载和问题反馈请以对应仓库为准。

## 已有贡献如何保留

感谢 MT-gar 在 [PR #1](https://github.com/RonaldDeng/Rhine-Music-Demo/pull/1) 中提供 Windows 与在线专辑架相关工作。该 PR 于 2026-10-05 合并，原始提交、[合并记录](https://github.com/RonaldDeng/Rhine-Music-Demo/commit/087adc207f079170b55353ada89d727523c89abb)及作者署名保留在 Git 历史中。V0.4.1 主线发布的是后续 macOS 版本，不包含这两项社区功能；需要这些功能的用户可访问上表中的衍生仓库。

关闭 PR 入口不会抹除已有历史，也不会改变或删除其他作者的 Fork。

## 加入或更新目录

欢迎维护者通过 [登记 Issue](https://github.com/RonaldDeng/Rhine-Music-Demo/issues/new?template=community_fork.md) 提供版本信息，不必提交 PR。收录、更新及移除方式见 [贡献指南](../CONTRIBUTING.md)。
