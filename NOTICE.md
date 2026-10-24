# 版权、署名与资源来源

本说明区分代码授权、音乐适配的开发者署名和第三方素材的权利。公开源码不表示放弃版权，也不表示获得全部原作素材的再授权。

## 开发者与上游

| 范围 | 署名与来源 |
| --- | --- |
| 音乐播放器适配及后续修改 | **Copyright (c) 2026 RonaldDeng**。包括本地曲库与播放服务、音乐专辑模型适配、音乐界面、导航、相机交互、文字效果、响应式及版本维护中由本项目新增或修改的部分；不主张对未修改的上游代码或第三方素材享有原创权利。 |
| 原版 RhineLabUI | **Copyright (c) 2026 LBEILC**。[原仓库](https://github.com/LBEILC/RhineLabUI)，初始基于提交 [`5abab02367465d9189f4ae65bcb6f17fdb5938f7`](https://github.com/LBEILC/RhineLabUI/tree/5abab02367465d9189f4ae65bcb6f17fdb5938f7)。保留其三维档案界面、渲染与动效基础、建模脚本、资料说明和 Git 历史。 |

有权授权的程序代码、建模脚本和技术文档沿用 [MIT License](LICENSE)，保留以上两项署名。分发代码或其重要部分时须一并保留版权声明及完整许可证；适配者的署名不取代上游署名。MIT 允许使用、修改及商业分发，软件按原样提供；本说明不在 MIT 上另加用途限制。具体以许可证原文为准，参见 [MIT 许可说明](https://choosealicense.com/licenses/mit/)。

[README.original.md](README.original.md) 保留上游原说明，其中“本项目”“原创”等措辞归属于该上游文档的语境。RonaldDeng 不代表 LBEILC，音乐适配不表示上游作者参与、认可或为本衍生版本提供支持。

## 原作及非代码资产

视觉参考为《明日方舟》特别映像[「莱茵生命：访问」](https://www.bilibili.com/video/BV1rr4y1b7sz/)。相关作品、名称、标志、设定、视觉设计、原 PV 及其声音的权利归相应权利人所有。本项目是独立爱好者工程，与官方制作方无隶属、赞助或授权合作关系，不主张拥有原作版权或商标。

- `art/*.blend`、`public/assets/*.glb`、界面图标、截图、动图及原作相关演示文本**不因代码采用 MIT 而自动获得原作素材许可**。上游未另行将全部非代码资产声明为 MIT；建模脚本的 MIT 授权也不等于原作相关视觉元素可任意再分发。
- `public/audio/atmosphere.ogg`、`motif.ogg`、`pulse.ogg` 为继承自上游的程序编配，按其[音频说明](public/audio/README.md)随项目采用 LICENSE；不将其重新署名为音乐适配者原创。
- V0.5.0 已移除原 PV 的逐字输入采样及 PCM 数据、试听文件、提取脚本与本地研究材料；这些原作声音不随本版本分发，也不被声明为 MIT。原版入口改用本次音乐适配维护中新增的原创程序输入短音，随程序代码采用 LICENSE，不使用录音或模仿原 PV 采样。此前版本与旧 Git 历史未重写，历史素材的权利不因本次移除或来源标注而改变。
- [内置演示封面](public/demo-covers/README.md)是本项目早期音乐适配阶段生成的三张抽象图像，不冒充真实唱片或音乐库。
- V0.5.0 及 V0.6.1 [README 演示素材](docs/media/v0.5.0/README.md)使用隔离合成曲库，以及另行通过 OpenAI 图像生成工具制作的 18 张抽象封面。生成时仅使用从本地参考图归纳的颜色、明暗、饱和度和文字构图描述，未向生成工具上传商业封面；未使用其人物、标志、标题或原有构图。原始参考图、私人索引与生成过程文件不随仓库分发。截图不改变其中字体、模型与原作元素各自的权利；这些配图不作为商业唱片封面的授权声明。V0.6.1 使用相同封面与虚构数据重新截取正式界面；歌词截图为原创短句，不含第三方歌词。早期专辑介绍界面图仅保留为历史验证配图。
- 真实歌曲、商业专辑封面、私人曲库索引、缓存和在线介绍不随本仓库及发布包分发。

代码复用者可替换这些资产；使用或再分发涉及第三方权利的内容时，需另行遵守对应许可或取得必要授权。本文件不作“全部资源已获商业授权”的保证。

## 字体与直接依赖

| 组件 | 权利人与许可 | 随包文本 |
| --- | --- | --- |
| Noto Sans SC（歌词默认字体） | Adobe / Google Noto，SIL Open Font License 1.1；从官方变量 TTF 完整转换为本地 WOFF2，字形和覆盖不变，字体不改授 MIT | [来源与转换说明](public/fonts/NotoSansSC-NOTICE.txt)、[完整 OFL](public/fonts/NotoSansSC-OFL.txt) |
| MiSans | 小米／Beijing Xiaomi Mobile Software Co., Ltd.，按 MiSans 字体协议随应用原样嵌入；不是 MIT，不将字体作为独立商品或字体包发布 | [署名](public/fonts/NOTICE.txt)、[完整字体协议](public/fonts/MiSans-license.pdf) |
| Three.js | three.js authors，MIT | [three.txt](public/licenses/three.txt) |
| Rolling Number | Kit Langton，MIT | [rolling-number.txt](public/licenses/rolling-number.txt) |
| music-metadata | Borewit，MIT | [music-metadata.txt](public/licenses/music-metadata.txt) |
| OpenCC-JS | nk2028，MIT；所用 OpenCC 字典数据另受 Apache-2.0 约束 | [MIT](public/licenses/opencc-js.txt)、[第三方说明](public/licenses/opencc-js-third-party.md)、[Apache-2.0](public/licenses/apache-2.0.txt) |

这些文本保留依赖包原文。完整版本树见 `package-lock.json`；其他构建工具和间接依赖按安装包各自的 LICENSE / NOTICE 使用，不被本项目重新授权。

## V0.4.0 本机音频依赖

V0.4.0 音频解码通过独立子进程调用用户本机安装的 FFmpeg / ffprobe。FFmpeg 项目的主要许可为 LGPL-2.1-or-later；启用可选 GPL 组件的构建适用其相应 GPL 条款。本次开发机的 FFmpeg 8.0.1 构建启用了 `--enable-gpl --enable-version3`，不将这个构建描述为纯 LGPL。项目没有捆绑、上传或重新授权 FFmpeg 二进制；以后若打包分发，需按实际分发构建保留对应版权、许可证及源代码材料。来源：[FFmpeg 官方](https://ffmpeg.org/)、[官方许可说明](https://ffmpeg.org/legal.html)。

原生输出使用 macOS 自带 AVFoundation / AVFAudio、CoreAudio 与 AudioToolbox 框架，由 Apple 提供；这些系统框架不属于本项目 MIT 代码。`native/RhineAudio.swift` 是本项目新增桥接源码，随项目代码许可；在本机生成的 helper 二进制放在用户数据缓存，不随源码分发。

APE 回归仅在本机临时目录使用 [FFmpeg 官方音频样本](https://samples.ffmpeg.org/A-codecs/lossless/)中的 `luckynight.ape`；它是官方说明所述的一分钟 CD 节选测试样本，来源标注不代表授予音乐再分发许可。文件没有复制进项目，也不进入任何源码包。其他新增音频测试使用现场生成的短正弦波，不使用用户私人曲库。路线与验证详见 [AUDIO-V0.4.0.md](docs/AUDIO-V0.4.0.md)。

## 在线资料

Wikipedia 摘要、Wikidata 与 MusicBrainz 数据按其来源许可处理。客户端保存介绍时同时保存来源链接、取得时间和许可说明；此类用户自行查询的缓存不纳入项目 MIT 授权，也不进入发布包。MusicBrainz 将核心数据和补充数据分别授权，详见[官方数据许可](https://musicbrainz.org/doc/About/Data_License)；不能仅因为程序开源就统一将数据改授 MIT。

## 在线歌词与流程参考

V0.6.1 使用本地优先的逐曲歌词查询，实际远端来源为**网易云音乐、LRCLIB、AMLL TTML DataBase**。来源、调用路径、匹配及缓存行为见 [歌词使用与来源](docs/LYRICS.md)，接口结果保留实际来源名称与记录链接。向以上维护者、歌词整理者和贡献者致谢。

| 来源 | 开源许可或服务边界 |
| --- | --- |
| [网易云音乐](https://music.163.com/) | 第三方在线服务；站点接口不标为官方开放开发者 API，也不将歌曲歌词标为 MIT 或其他开源许可。本项目未捆绑第三方网易云 API 代理软件。 |
| [LRCLIB / tranxuanthang](https://github.com/tranxuanthang/lrclib) | 服务源码采用 [MIT](https://github.com/tranxuanthang/lrclib/blob/main/LICENSE)，Copyright (c) 2024 tranxuanthang；[API 文档](https://lrclib.net/docs)。远端服务源码的 MIT 许可不等同于其返回歌词正文的许可。 |
| [AMLL Dev / AMLL TTML API](https://github.com/amll-dev/amll-ttml-api) | 服务源码为 MIT 或 Apache-2.0 双许可，Copyright (c) 2026 amll-dev（[MIT](https://github.com/amll-dev/amll-ttml-api/blob/main/LICENSE-MIT)、[Apache-2.0](https://github.com/amll-dev/amll-ttml-api/blob/main/LICENSE-APACHE)）；[官方接口文档](https://amll.dev/reference/http-api/overview)。 |
| [AMLL TTML DataBase 及贡献者](https://github.com/amll-dev/amll-ttml-db) | 数据库仓库声明 [CC0 1.0](https://github.com/amll-dev/amll-ttml-db/blob/main/LICENSE)。该声明只涉及声明者有权处置的权利，不能替代词作、翻译等第三方原作权利的许可。 |
| [Folia Major / chthollyphile](https://github.com/chthollyphile/folia-major/tree/1f6d0f468f5bc81b23a8b40ad7ca96ccd4b1ecbe) | 本地优先与多来源匹配的流程参考，核对版本为 `1f6d0f4`，采用 [GNU AGPL v3](https://github.com/chthollyphile/folia-major/blob/1f6d0f468f5bc81b23a8b40ad7ca96ccd4b1ecbe/LICENSE)。本项目没有纳入其代码、组件、解密实现、资产或运行时依赖，不将其代码改授 MIT。 |

本项目独立实现 HTTP 适配与逐行 LRC 显示，不分发上述远端服务源码、歌词库、Folia 或 AMLL 播放组件。在线调用并不将对方软件或歌词纳入本项目 MIT 许可；歌词正文、翻译及原作权利由相应权利人保留。查询结果只存于本机服务进程内存，不随仓库、截图和发行包分发，不提供批量下载或重新授权。以上来源与许可在 2026-10-24 核对，服务条款及可用性以各提供方现行说明为准。

如发现署名遗漏或具体权利问题，请通过本仓库 [Issues](https://github.com/RonaldDeng/Rhine-Music-Demo/issues) 提供涉及文件、来源及说明，维护者可据此核对。
