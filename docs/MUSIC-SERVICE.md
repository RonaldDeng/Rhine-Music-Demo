# 本地音乐服务

`node scripts/music-server.mjs` 同时提供 `dist/` 界面和本地音乐 API。默认仅监听 `127.0.0.1:5173`；端口可通过 `--port 5174` 或 `PORT` 指定。修改前端后重新构建并刷新。服务保持运行期间可编辑本地流派规则，下一次读取曲库就会生效。

```sh
npm install
npm run build
node scripts/music-server.mjs
```

## 数据与文件权限

默认索引目录是仓库旁边的 `music-data/`，可通过 `MUSIC_DATA_DIR` 覆盖。首次运行默认无音乐目录，请在界面填写并保存自己的音乐文件夹。`MUSIC_ROOTS` 也能提供首次根目录，多个目录按系统路径分隔符分隔（Mac 为冒号、Windows 为分号）；已有 `config.json` 优先，更新程序不会更换已保存的音乐目录。

- `config.json`：根目录、是否在扫描后补充在线资料、可选的本机 Beefweb 地址。
- `library-index.json`：自动扫描缓存。记录真实文件的引用、尺寸/修改时间、元数据、封面与在线来源，不复制歌曲。
- `genre-rules.json`：展示分类、别名和 `albumOverrides` 人工覆盖。扫描不修改这个文件。通过 API 更新时保留一份 `.backup`。
- `artwork/`：从歌曲内嵌图片提取的原始封面缓存，不裁切或拉伸。文件夹封面直接读取原文件。

每个含音频文件的文件夹为一个专辑；扫描递归进入子文件夹，跳过符号链接和隐藏子目录。多张 CD 若在同一文件夹中，优先按 disc 标签、再按 `1-01` 这样的文件名前缀排序。不同子文件夹暂分别视为专辑。路径决定稳定 ID，移动文件夹会建立新 ID；当前版本尚未自动识别迁移。

启动时先能读取缓存，随后后台扫描。未改动的音频不再解析标签。可读根目录内删除的专辑会移出当前列表；根目录断开或扫描访问失败保留原索引并标记离线。人工分类保留。文件夹 `cover`、`folder`、`front` 命名的 JPG/PNG/WebP 优先，其次其他图片，最后使用第一份可用内嵌封面。

API 只能通过已索引的 ID 读取歌曲和封面，不能传入任意文件路径；文件读取再次检查实际位置仍在配置的根目录内。服务只绑定回环地址，并拒绝跨站 Origin、陌生 Host 和非 JSON 写入。勿在公网反向代理本服务。

## API

共享 JSON 类型见 `src/music-types.ts`。

| 方法与路径 | 功能 |
| --- | --- |
| `GET /api/library` | 当前真实库、归并后的流派、根目录和扫描/补全状态；不虚构演示音乐 |
| `POST /api/library/scan` | `{ "roots": ["/absolute/path"] }` 可选；保存目录并扫描，返回 202，轮询 GET 读取完成结果；并发请求合并 |
| `GET /api/audio/:trackId` | 原始音频，支持单一 HTTP Range 与 HEAD，用于跳转播放 |
| `GET /api/artwork/:albumId` | 原比例封面图片；URL `v` 参数随封面变化更新 |
| `GET/POST /api/genre-rules` | 获取或保存完整 `{version:1,genres:[{id,name,aliases:[]}],albumOverrides:{}}` |
| `GET/POST /api/config` | 配置 `roots`、`onlineEnabled`、`musicBrainzContact`、`foobarBaseUrl`；响应还给出 `musicBrainzConfigured` |
| `POST /api/library/enrich` | 明确请求 MusicBrainz 补全；可选 `{ "albumIds": ["album-..."] }`；返回 202 |
| `POST /api/library/introductions` | 独立查询/更新百科专辑介绍，无需 MusicBrainz 配置；`{ "albumIds": ["album-..."], "force": true }` 均可省略；返回 202 |
| `GET /api/foobar/status` | 是否保存过本机桥接地址；不是实际连接成功证明 |
| `GET/POST /api/foobar/*` | 原样代理到本机 Beefweb `/api/*`，例如 `GET /api/foobar/player` |

默认规则可将 `Mandopop`、`国语流行音乐`、`华语流行音乐` 归入“华语流行”。人工 `albumOverrides` 优先，其次对原始流派应用别名。未归并的来源分类保留原名；无信息归入“未分类”。原始标签完整保留，不反写音乐文件。

## 音频能力

本地读取 FLAC、WAV、M4A、DSF、DFF 等元数据。M4A 是容器，界面应同时展示 codec，不能把所有 M4A 标为无损 ALAC。`lossless` 反映解析器辨认出的无损/有损编码。位深、采样率、码率按解析结果显示，缺失时显示未知；AAC 的位深是解码输出位深，不代表原始无损精度。`localNote` 单独保存本地 comment；它绝不映射到专辑介绍 `description`。

DSF/DFF 在索引中明确 `browserPlayable: false`；浏览器不具备本版本的 DSD 解码/直出路径。其他标为可尝试播放的格式仍取决于实际浏览器支持，尤其 ALAC。当前 Beefweb 是可选本机桥接入口，未包含 Windows 上的 foobar 安装、播放队列导入或 DAC/DSD 输出验证。

氛围配乐与歌曲分别使用独立音量。`MusicPlayer` 构造参数 `bgmVolume` 默认为 `0.18`，`setBgmVolume(0…1)` 和 `setBgmEnabled` 控制配乐，`setVolume` 仅控制歌曲。播放歌曲前配乐约 220ms 淡出至静音；停止歌曲回到浏览时按配乐自身音量约 650ms 淡入。暂停歌曲保持安静，歌曲连续播放之间不插入配乐。BGM 文件 `/audio/atmosphere.ogg` 由本地服务以 `audio/ogg` 提供。

## 可选 MusicBrainz

在线查询只上传专辑文字信息/已有 MBID，不上传音频。默认关闭自动补全。开启前需在界面通过 `POST /api/config {"musicBrainzContact":"自己的邮箱或项目网址"}` 设置自己的维护者联系信息，也可使用环境变量：

```sh
MUSICBRAINZ_CONTACT='your-project-contact' node scripts/music-server.mjs
```

通过显式补全按钮查询一次；或保存 `onlineEnabled:true`，以后扫描完成后自动查询未查过的专辑。已有 Release MBID 精确查找，否则比较标题、艺术家、年份和曲目数，并要求唯一的高匹配结果。不确定时保留本地资料，绝不猜制作人。所有外网请求间隔至少 1.1 秒。断网、限流和缺配置只影响补全，不阻止本地曲库显示与播放。

通过 MusicBrainz 补全时，专辑介绍只在高置信匹配后，跟随 release-group 关联的 Wikidata/Wikipedia 链接获取百科导言。优先中文，其次英文；该流程不进行仅按标题的百科搜索，不把 MusicBrainz 编辑注释当介绍。`descriptionSource` 保存来源名称、链接、更新时间与许可说明。没有关联、存在消歧义或网络失败时保留空介绍并提供状态；原有缓存不被无结果覆盖。设置页的独立介绍更新流程见下文。

制作人来源和角色保留，录音级制作人附参与曲目。流派来自 release/release-group 的 `genres`，不把任意 `tags` 当成流派。制作关系属于 CC0 核心数据；流派关联属于 MusicBrainz CC BY-NC-SA 3.0 补充数据。当前项目仅本地个人使用，未来公开分发缓存需重新审查许可。

参考：[MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API)、[速率与 User-Agent](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting)、[数据库许可](https://musicbrainz.org/doc/MusicBrainz_Database)、[Wikidata 访问](https://www.wikidata.org/wiki/Help:Data_access)、[百科导言 API](https://www.mediawiki.org/wiki/Extension:TextExtracts)、[music-metadata](https://github.com/Borewit/music-metadata)。

## 一键查询/更新专辑介绍

独立的 `scripts/album-introductions.mjs` 使用 Wikipedia 与 Wikidata 公开读取 API，不依赖 MusicBrainz contact 表单或 API Key；如果用户已填写真实联系方式，沿用该信息标识客户端，否则使用明确的本应用 User-Agent。查询只发送专辑名/歌手及公开百科实体 ID，年份在本地比对；不发送文件路径、音频、曲目清单或本地 comment。

先按专辑标题及括号内中英文别名查找正式百科条目，并应用 OpenCC 繁简归一化和引号/标点归一化。缺失时通过 Wikipedia 搜索 API 发现候选，搜索片段不作为介绍。候选必须是专辑作品，名称、歌手及发行年份相符；优先核对 Wikidata 的 performer/publication date，结构资料缺失时仅接受正式百科首段中可核对的对应信息。已有结构字段冲突（例如本地为再版年份）时保留候选待核实。同名的歌曲、歌手页面、消歧义页面或多个相符候选不会自动采用。

`description` 来自正式页面的纯文本导言，`descriptionSource` 保留出处、链接、查询时间和来源许可。它是有出处的百科摘要，不宣称所有维基条目均已被权威核实。缺少来源、空导言和不确定匹配保持未匹配状态；网络超时、API 错误与限流明确标记失败，不能等同“没有资料”。原有介绍不会被失败或空结果覆盖。

`GET /api/library` 的 `introductions` 返回 `running/completed/total/updated/notFound/failed/currentAlbum/error`。其中 `notFound` 包含无法确认和无可用介绍的专辑。每张专辑的 `introduction.status` 区分 `matched/not-found/uncertain/error`，可显示具体原因。请求串行，间隔至少 1.1 秒，每次最多等待 8 秒；连续 3 张均遇到来源访问错误时停止剩余任务，保留剩余数量供重试。

默认复用已有介绍与最近 7 天的未匹配结果；`force:true` 强制重新查询，但依旧保留可用旧文本直到获取新的可靠结果。失败可重试，批量请求自动合并，进度与界面/三维动画解耦。介绍与匹配状态缓存在 `library-index.json`，重启与扫描保留。

当前环境验证状态（2026-09-09）：用户已明确允许向中文、英文维基百科及 Wikidata 发送专辑名、歌手并缓存介绍。随后执行的真实批次出现 API 连接超时，未取得新介绍；未把网络失败标成没有资料。用户之后要求暂不处理信息更新，联网排查和后续查询已暂停。功能测试通过不代表真实资料已更新；本地浏览与播放不依赖查询成功。

## 验证

`node --test scripts/check-music-library.mjs` 使用临时合成 WAV 和元数据 fixture，验证实际 WAV 解析、字节范围、增删与断盘保留、缓存、封面优先、人工覆盖、并发扫描和含糊匹配。测试不会读取或改写用户歌曲。

`node --experimental-strip-types --test scripts/check-music-player.mjs` 使用受控 Audio 和可推进时钟，验证两路独立音量、过渡静音门、快速开关与音量变化、恢复和迟到播放 Promise 的取消。测试不播放真实声音、不启动服务。

`node --test scripts/check-album-introductions.mjs` 仅使用人工 fixture 与网络替身，验证繁简/双语标题、错误身份/年份/作品类型的拒绝、来源归属、搜索片段隔离、全来源失败、空导言、并发与缓存、三次失败暂停和扫描期间保留介绍。`check-music-library` 另验证实际 HTTP 更新路由及无 MusicBrainz 配置也可调用，响应内容仍来自替身，不联网查询用户专辑。
