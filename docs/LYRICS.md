# 歌词使用、来源与许可

适用于 Rhine Music V0.6.1。来源与许可证核对日期：2026-10-24。

## 使用方式

打开专辑详情中的“歌词”，查看当前歌曲的逐行同步歌词；左上“专辑资料”或 `Esc` 返回资料页。播放该曲时，点击有时间戳的歌词可跳转，手动滚动后可通过“回到当前歌词”恢复跟随。

优先读取音频旁的同名 `.lrc` / `.LRC`，再读取内嵌同步歌词。没有本地同步歌词时，按当前曲目自动查询在线来源；只有本地纯文本时继续寻找同步版本，查询失败则保留本地文本。本地 LRC 新建或修改后刷新页面即可读取，无需重新扫描音乐库。纯音乐、未找到和网络错误会分别提示。

“设置 → 画面与声音 → 歌词显示”可选择字体、18–48 px 字号和高亮位置（居中／歌名下方第一行）。这些选项只影响歌词正文，并在本机保存；默认字体为随包提供的 Noto Sans SC，使用 [SIL OFL 1.1](../public/fonts/NotoSansSC-OFL.txt)，[来源与转换说明](../public/fonts/NotoSansSC-NOTICE.txt)随包保留。

## 实际调用的在线来源

本机服务当前按“网易云音乐 → LRCLIB → AMLL TTML DataBase”的次序尝试，找到可用的同步歌词即返回。纯文本结果作为后备。AMLL 的兼容接口与 LRCLIB 是两个独立来源，结果不会混用其名称。

| 来源 | 本版调用及出处 | 许可标记与适用范围 |
| --- | --- | --- |
| 网易云音乐 | [服务主页](https://music.163.com/)；站点搜索路径 `/api/search/get/web`、歌词路径 `/api/song/lyric`；结果保留对应歌曲页链接 | 第三方在线服务；本项目未获得可将其歌词改授开源许可的依据。这些站点接口不标为官方开放开发者 API，不承诺稳定性。未引入第三方“网易云 API”代理软件。 |
| LRCLIB | [官方网站](https://lrclib.net/)、[API 文档](https://lrclib.net/docs)、[tranxuanthang/lrclib](https://github.com/tranxuanthang/lrclib)；调用 `https://lrclib.net/api/search`，结果保留 `/api/get/{id}` 链接 | 服务源码为 [MIT](https://github.com/tranxuanthang/lrclib/blob/main/LICENSE)，Copyright (c) 2024 tranxuanthang。这里标注的是远端软件的许可，不是歌词正文许可；本项目不捆绑该服务源码或数据库。 |
| AMLL TTML DataBase | [AMLL Dev](https://amll.dev/)、[HTTP API 文档](https://amll.dev/reference/http-api/overview)、[歌词数据库](https://github.com/amll-dev/amll-ttml-db)及其贡献者；调用 `https://api.amll.dev/v1/lrclib/search`，结果保留 `/v1/lrclib/get/{id}` 链接 | [API 服务](https://github.com/amll-dev/amll-ttml-api)为 MIT 或 Apache-2.0 双许可（[MIT](https://github.com/amll-dev/amll-ttml-api/blob/main/LICENSE-MIT)、[Apache-2.0](https://github.com/amll-dev/amll-ttml-api/blob/main/LICENSE-APACHE)），Copyright (c) 2026 amll-dev；[数据库仓库声明 CC0 1.0](https://github.com/amll-dev/amll-ttml-db/blob/main/LICENSE)。CC0 仅能覆盖声明者有权处置的权利，不能据此断言所有原作歌词已进入公有领域。 |

感谢上述服务的维护者与歌词整理贡献者。本版通过独立编写的 HTTP 适配器调用远端接口，没有捆绑 LRCLIB / AMLL 服务程序，也没有使用 AMLL 播放器、歌词组件或 TTML 解析库。AMLL 返回的兼容 LRC 由本项目的逐行解析器读取，本版不宣称支持逐词高亮。

代码的 MIT 许可、远端服务的代码许可和歌曲歌词的内容权利是不同范围。词作、翻译等权利仍由相应权利人持有；署名和链接不替代内容使用许可。仓库、截图与发行包不附带第三方歌词正文或歌词数据库，用户查询结果也不被重新授予本项目的 MIT 许可。更完整的项目资产说明见 [NOTICE.md](../NOTICE.md)。

## 流程参考与代码边界

多来源检索和本地优先流程曾参考 [chthollyphile / Folia Major](https://github.com/chthollyphile/folia-major/tree/1f6d0f468f5bc81b23a8b40ad7ca96ccd4b1ecbe)，该项目使用 [GNU AGPL v3](https://github.com/chthollyphile/folia-major/blob/1f6d0f468f5bc81b23a8b40ad7ca96ccd4b1ecbe/LICENSE)。本项目保留这一参考致谢，但未纳入其代码、组件、解密实现、资源或运行时依赖；没有名为“Folia 歌词 API”的调用。未来如复制或改编其受许可代码，须重新按其许可处理，不能只加致谢并继续视为本项目 MIT 代码。

## 隐私、资源与错误处理

- 在线查询发送用于匹配的曲名和歌手等文字；本版的搜索请求不上传音频、封面、文件路径或整个曲库。专辑名与录音时长在本机参与候选排序。
- 音频与侧车文件只读，真实路径必须处于已配置的音乐目录内；歌词不写回音频、标签或曲库索引。在线结果只在服务进程内缓存，最多 64 项，关闭服务即清空。
- 单次上游请求最多 4 秒，每来源最多 7.5 秒，整次查询最多 24 秒；最多四个在途请求。HTTP 429 使对应来源冷却一分钟，其余来源仍可尝试；不绕过登录、验证码、访问限制或限流。
- 切歌取消过期请求，共享查询只在最后一个等待方取消时终止；取消不写入“未找到”缓存。成功缓存 12 小时，无结果 1 分钟，临时失败 10 秒；重试可跳过普通缓存，仍遵守限流。
- 在线服务可能无结果、不可用或错误匹配。实际录音版本不同或本地标签不完整时，优先使用自己确认的同名 LRC；本版没有批量联网扫描、歌词上传、数据库下载或歌词导出功能。

## 本机接口与验证

`GET /api/lyrics/:trackId` 先读取本地，并在需要时自动联网。`POST /api/lyrics/:trackId` 使用 `Content-Type: application/json` 和 `{ "online": true }` 重试；两者都沿用本机服务的 Host、Origin 与目录边界检查。请求不能用 URL 参数替换曲库中的文件路径、元数据或来源地址。

结果的 `source.kind` 为 `sidecar`、`embedded` 或 `online`，`source.name` 记录实际来源，在线结果的 `source.url` 指向对应记录。接口保留来源信息，歌词阅读页沿用沉浸布局；通用来源与许可入口在“设置 → 关于”。所有歌词按文本渲染，不执行其 HTML。

`npm run check:lyrics` 使用原创合成样本和模拟上游响应验证解析、来源标记、目录只读边界、匹配与降级、缓存、取消、限流和时间线。自动化测试不证明所有在线歌曲命中率，也不替代真实录音版本核对。
