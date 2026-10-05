# 在线专辑架（Windows 适配版新增）

在本地音乐库之外，增加一座**独立的在线专辑架**和一份**独立的在线专辑列表**。在线专辑不会混进本地音乐库，也不会写入本地索引；本地音乐文件仍然只读。

## 怎么用

1. 点顶部导航的 **在线**（地球图标），打开「在线曲库」面板。
2. 在 **搜索在线曲库** 选择来源，输入关键词，点 **搜索**。Internet Archive 还可以限定合集（社区上传音频、网络厂牌、现场录音、78 转老唱片）。
3. 点结果右侧的 **加入**。专辑会出现在 **我的在线专辑** 列表里。
4. 点面板顶部的 **在线专辑架**（或某张专辑的 **在架上查看**），主界面切换到在线专辑架：同一个三维专辑架、同一套浏览和播放方式，数据却是独立的。点 **本地专辑架** 切回。
5. 正在播放的歌曲不会因为切换而中断。点顶部的当前歌名，会自动跳到这首歌所在的专辑架并定位。

在线专辑架为空时，主界面显示“在线专辑架还是空的”，并提供“搜索在线专辑”和“返回本地专辑架”两个入口。

## 来源

| 来源 | 说明 |
| --- | --- |
| **Internet Archive** | 内置。搜索 archive.org 的公开音频条目，每个条目在 MP3 / Ogg Vorbis / FLAC 中选浏览器能直接播放的一份（优先 MP3）。 |
| **自有音乐服务** | 内置的 Subsonic / OpenSubsonic 客户端，适用于你自己搭建的 Navidrome、Jellyfin（Subsonic 插件）、Airsonic 等。默认关闭，在面板底部填写地址、账号和密码后启用。浏览器无法直接播放的格式（如 WMA、APE）会请求服务端转成 MP3。 |

### 授权

- Internet Archive 上每个条目的授权不同。搜索结果和专辑详情会显示条目标注的授权（例如 CC BY-NC-ND 3.0）和条目页链接；**没有标注授权的条目会明确显示“未标注授权”**，使用前请自行到条目页确认。
- 受限借阅条目（`access-restricted-item`）不会加入，也不会播放。
- 本项目**不包含**也不会加入针对商业音乐平台的播放地址解析器。自有音乐服务只播放你自己服务里的内容。

## 联网与隐私

- 启动时**不会联网**。只有你点击搜索、加入，或播放在线专辑时才会访问所选来源。
- 音频和封面由本机服务（`127.0.0.1`）转发：`/api/online/audio/<id>`、`/api/online/artwork/<id>`。浏览器不会直接访问 archive.org 或你的服务，页面里也看不到远端地址和账号信息。
- 请求会带 `User-Agent: RhineMusicDemo/0.3`，只发送搜索词、条目标识和播放所需的 Range。
- 加入专辑只保存元数据快照（标题、艺术家、曲目列表、授权链接），**不会下载或缓存音频**。离线时已加入的专辑仍显示，但无法播放。

### 保存位置

在线专辑架和自有音乐服务设置保存在数据目录的 `online.json`（默认 `music-data-v3`，可用 `MUSIC_DATA_DIR` 修改），不在项目文件夹里，也不会被提交。

自有音乐服务的**密码以明文保存**在这个文件里（Windows 上文件权限位不起作用），建议为播放器单独建一个只读账号。界面和 API 永远不会把密码返回给浏览器，只显示“已保存”。认证使用 Subsonic 的盐值令牌（`t`/`s`），不会发送明文密码。

## 安全边界

- 服务仍只监听 `127.0.0.1`，保留 Host / Origin 检查；写入接口只接受 `application/json`。
- 每个来源有自己的主机白名单：Internet Archive 只允许 `archive.org` 及其子域（仅 https，不允许自带账号或其他端口）；自有音乐服务只允许你填写的那个地址。
- 重定向由服务端手动跟随，**每一跳**都重新检查白名单（Internet Archive 会把下载重定向到 `*.archive.org` 的存储节点）。
- 音频只接受 `audio/*` 或 `application/ogg`、`application/octet-stream`；封面只接受 JPEG / PNG / GIF / WebP（SVG 会被拒绝）。其他类型一律 502。
- 搜索词会去掉 Lucene 查询语法字符，合集名只接受字母、数字、下划线和连字符。
- 上限：每页 20 条、最多 500 张在线专辑、每张最多 300 首、元数据响应最大 12 MB，连接超时 15 秒。

## 接口

| 方法与路径 | 作用 |
| --- | --- |
| `GET /api/online/library` | 在线专辑架快照，格式与 `/api/library` 相同（`id` 以 `online-` 开头） |
| `GET /api/online/sources` | 来源列表和自有音乐服务的配置状态（不含密码） |
| `GET /api/online/search?source=&q=&page=&collection=` | 搜索 |
| `POST /api/online/albums` `{source, ref}` | 加入专辑（重复加入会刷新快照） |
| `POST /api/online/albums/remove` `{id}` | 移除专辑 |
| `POST /api/online/subsonic` `{baseUrl, username, password}` / `{clear: true}` | 保存或清除自有音乐服务设置；密码留空表示保持不变（仅限同一地址和账号） |
| `POST /api/online/subsonic/test` | 测试连接，不保存 |
| `GET /api/online/audio/<trackId>`、`GET /api/online/artwork/<albumId>` | 受限代理，支持 Range |

## 增加别的来源

来源是一个很小的对象，定义在 `scripts/online-sources.mjs` 顶部的契约里：`id`、`name`、`allow(url)`、`search()`、`album()`、`audioRequest()`、`coverRequest()`。实现这几个方法并在 `OnlineLibrary.sourceFor()` 里登记即可；代理、白名单、重定向检查、类型检查和持久化都由框架提供。

## 检查与已知限制

- `node --test scripts/check-online-sources.mjs`（已并入 `npm run check:music`）使用本机假服务器覆盖：搜索语法净化、格式选择、授权与受限条目、白名单、外域重定向和非音频响应被拒绝、Range 转发（206）、密码不外泄、`online.json` 损坏时按空库处理、跨站写入被拒。测试**不访问真实互联网**。
- 在线专辑架复用同一个三维专辑架场景，切换时整体重建数据。无头浏览器无法渲染三维专辑架，所以切换后的实际观感（尤其是只有几张专辑时的空位）需要在有显卡的真实 Windows 电脑上看一眼。
- Internet Archive 的搜索排序按下载量，结果质量取决于条目元数据；个别条目没有封面时显示 Archive 的默认图。
