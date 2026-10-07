# V0.4.0 音频路线、实现与验证

> V0.4.1 更新：本页保留 V0.4.0 的实现与验证历史。V0.4.1 已增加真正的预排无缝接续，当前行为以 [歌曲衔接说明](SONG-TRANSITIONS-V0.4.1.md) 和 [发行检查](RELEASE-V0.4.1.md) 为准。下述 DSD 的 24 位 / 176.4 kHz 适用于普通解码；CoreAudio 无缝预备的下一首另行归一为当前引擎采样率的 Float32 PCM。4 GiB 是当前磁盘缓存回收目标，正在使用和受保护的文件可能暂时超过目标。

日期：2026-10-02。仅本地开发，没有上传 GitHub，没有复制或改写用户曲库。

## 2026-10-07：DSF / DFF 播放

DSF / DFF 通过本机 FFmpeg 解码为 **24 位 / 176.4 kHz PCM WAV**，保留源声道数，再使用既有浏览器或 CoreAudio 共享输出。转换只生成播放缓存，原始文件与标签始终只读。无需具备 DSD 解码能力的 DAC；本版不输出 Native DSD 或 DoP。

后端按实际 DSD / DST codec 选择转换路线，改扩展名不改变解码方式。使用 FFmpeg 内置 `swr` 重采样器，无需额外 libsoxr；不增加进度拖动界面，播放、暂停、切歌及音量沿用原有操作。首次播放仍需完整准备，后续复用缓存。

曲库保留源格式与 DSD 采样率。准备接口额外返回 `conversion: "dsd-to-pcm"`、一位采样时钟 `sourceSampleRate` 与 `sourceBitsPerSample: 1`；`sampleRate`、`bitsPerSample` 和 `duration` 描述实际 PCM 缓存。DSF 容器的 probe 时长可能含尾块填充，因此播放时长以解码后的实际 PCM 帧为准。176.4 kHz 是缓存采样率，不保证浏览器或 CoreAudio 共享输出设备以该采样率工作。

新增完全自生的双声道 DSD64 / 128 / 256 样本（DSF LSB、DSF MSB、DFF MSB）。样本先用 ffprobe 与 stream copy 核对原始位流，再用于播放解码、声道、缓存及源文件不变检查。最终执行结果见 [本轮验收](REVIEW-V0.4.0.md)；未经过样本验证的 DST 压缩 DFF 不列为已实测范围。

## 选择的路线

用户已确认：增加 macOS 原生 CoreAudio 输出、允许选择输出设备，同时保留浏览器播放。本轮采用本机 FFmpeg 的 libavformat / libavcodec 解码器，统一解码为本地 PCM WAV；歌曲可以交给浏览器，或交给 Swift AVAudioEngine / AVAudioPlayerNode，经 CoreAudio 输出到所选设备。没有把 WASAPI/ASIO 的 Windows 路线套用到 Mac。

| 方案 | 本轮判断 |
| --- | --- |
| 仅浏览器原生 Audio 解码 | 保留为无 FFmpeg 时的兼容回退；APE、AIFF、ALAC 等浏览器兼容性不能覆盖最初目标 |
| 浏览器 WASM 分别引入 FLAC / APE 解码器 | 需要额外维护格式、内存、大文件 seek、AudioWorklet 和设备输出，无法直接解决 macOS 原生输出 |
| FFmpeg + macOS 原生输出 | 本轮选择：统一容器识别和开源解码；本机桥接复用原有 Node 服务，前端保持同一个播放控制器 |
| 直接控制外部播放器 | 既有 foobar2000 接口保留，但不作为本轮独立输出前提 |

FFmpeg 没有作为二进制塞入项目。运行时查找 `FFMPEG_PATH` / `FFPROBE_PATH` 或 Homebrew / 系统 PATH，调用本机已经安装的程序。FFmpeg 和 ffprobe 必须同时存在。macOS 输出还需 Apple Command Line Tools 中的 `swiftc`，首次使用在数据目录编译小型 Swift helper；失败时设置明确显示原因，不报告虚假的原生能力。安装依赖属于用户机器配置，本次未自动安装任何依赖。

设置中可以选择「浏览器」或「CoreAudio」，并选择当前实际枚举到的输出设备。切换后端保留曲目和播放位置，包括暂停后的恢复。CoreAudio 是共享模式，系统可混音与重采样；不包含独占 / hog mode、DoP / Native DSD、自动更改设备采样率或 bit-perfect 保证。氛围 BGM 继续使用浏览器独立控制，不改成原生歌曲队列的一部分。

## PCM、缓存与播放语义

- 索引支持 APE、WavPack、WMA、WAV、FLAC、ALAC / M4A、AIFF、MP3、AAC、OGG、OPUS、DSF / DFF；DSF / DFF 的浏览器播放须先经本机 PCM 准备，不依赖浏览器直接解码 DSD。
- 实际格式由 FFmpeg 检测，不能仅凭扩展名声称解码成功。PCM 来源按实际位数保留为 16 / 24 / 32 位，浮点解码用 float32 PCM，并保留其采样率；DSD 来源固定为 24 位 / 176.4 kHz。两条路线均保留声道数，AVAudioEngine 内部和硬件转换不等于无损直通。
- 首次播放先完整解码，完成后才开始播放。优点是 seek、暂停、恢复和 HTTP Range 有确定文件长度；代价是大文件首次播放有准备时间。本轮不宣称流式边解码边播放或无缝 gapless。
- 数据目录的 `audio-cache-v040/` 保存 PCM WAV 与技术信息，键含源路径、大小、修改时间、缓存版本；源文件保持只读。单文件 PCM 上限 2 GiB，完成的 WAV 缓存按最近使用上限 4 GiB，至多两个并发解码，临时输出另计，最多约 4 GiB。超过单文件限制明确报错。32 位 WAV、超长或特别声道布局的浏览器支持受宿主浏览器影响。
- `native-v040/` 保存按 Swift 源码及 CPU 架构摘要命名的本地 helper，不提交本机二进制。服务关闭、前端停止或后端切换负责释放音频；关闭本地服务即终止原生输出进程。
- 曲目自然结束自动下一首；播放中 seek 到精确末尾也触发结束；暂停状态 seek 到末尾仍保持暂停。再次点击正在播放的同一首歌保留位置。切歌先淡出再启动下一首，不叠播；当前歌曲结束到下一首开始仍有准备 / 轮询间隔。
- 解码中取消会终止子进程；共享同一个解码任务的另一个等待者不会被一起取消。解码中调整音量或设备，以最后的值开始播放，不能在完成时意外恢复已经静音的音量。
- 原生默认输出跟随检测到的默认设备变化；指定设备丢失、引擎停转或 helper 状态丢失会报告错误。真实物理热插拔尚未覆盖，不能把错误状态代码检查当成硬件热插拔认证。

## 边界与进程隔离

服务继续只监听 `127.0.0.1`，继承 Host / Origin 检查。所有修改请求需要 JSON。外部请求只能提交索引 track ID，不能传入任意文件路径或任意子进程参数。所有子进程使用参数数组和 `shell:false`。

解码前重新核对真实路径位于配置根目录，拒绝音频符号链接逃逸。FFprobe 与 FFmpeg 同时限制可用音频 demuxer，排除 concat / HLS / playlist，防止把伪装为 `.ape` 的文本清单用来读根目录外第二个文件；网络输入协议也关闭。取消、处理超时、非法音频不会留下可供正常播放的半截缓存。缓存版本已经更新，旧 PCM 缓存将重新准备，以匹配当前采样率与技术字段。

接口：

- `GET /api/audio/capabilities`：FFmpeg / ffprobe 与 Swift 原生能力、实际设备列表、失败原因。
- `POST /api/audio/prepare/:trackId`：准备 PCM，返回 URL 和技术字段，不返回本机源 / 缓存路径。
- `GET /api/decoded-audio/:trackId`：只读 PCM，支持单段 Range / HEAD。
- `GET /api/output/state`、`POST /api/output/command`：原生状态与白名单控制。
- 前端 `MusicPlayer.refreshOutputs / setBackend / setOutputDevice`；播放 / 暂停 / 上下首 / seek / 音量继续共用原有调用。

## 2026-10-02 首轮检查记录（历史）

以下格式与检查数量属于首轮验证，不含 2026-10-07 新增的 DSF / DFF 播放。新增范围见本页顶部与本轮验收记录。

隔离自动化脚本：`scripts/check-music-audio.mjs` 和 `scripts/check-music-player.mjs`。测试创建独立临时目录，生成短正弦音频，CoreAudio 真实输出测试音量固定为 0，没有把测试声音播到扬声器，也没有用个人曲库做批量测试。

最终本机记录：FFmpeg 8.0.1（Homebrew，GPL / version3 构建）、Apple Swift 6.4、arm64、macOS 27.0.1。最终带完整 APE 样本执行 `check-music-audio.mjs` **18 / 18 通过，0 skipped**；`check-music-player.mjs` **6 / 6 通过**；既有 `check-music-library.mjs` **8 / 8 通过**；TypeScript 静态检查通过。浏览器 UI 联调结果由总体测试日志补充。

已运行：

1. 真正生成并解码 24-bit / 48 kHz WAV、FLAC、ALAC、AIFF、WavPack、MP3、Opus、AAC 和 float32 WAV。无损样本把源文件与缓存解回统一 PCM，SHA-256 完全一致；每个源文件前后 SHA-256 保持一致。WavPack 编码器实际生成 32 位，按真实 32 位验证。
2. APE 使用 [FFmpeg 官方公开回归样本目录](https://samples.ffmpeg.org/A-codecs/lossless/) 的 `luckynight.ape`，完整文件 MD5 与官方 `md5sum` 的 `ab078cadd6367ab132124cbc0ecb8005` 一致，真实解码得到约 60 秒、44.1 kHz、16-bit、双声道 PCM。样本只下载到 `/tmp` 供本机回归，不纳入项目或发布文件；来源解释见其 [readme](https://samples.ffmpeg.org/A-codecs/lossless/readme)。首次网络下载不完整曾被 MD5 检查拒绝，续传完整后通过。
3. 原生 helper 真编译、真启动，枚举本机五个可用输出端点；测试选中内置扬声器（0 音量），验证实际播放时钟推进、暂停时钟不动、seek、恢复、自然结束、精确末尾、连续取消和无效设备。没有实际试听音质，USB / 蓝牙设备兼容性、热插拔和长期稳定性仍需设备实测。
4. 浏览器播放器控制器回归：BGM 与歌曲独立，快速取消不会后发开始，暂停37秒跨到原生恢复位置、原生暂停22秒跨回浏览器恢复位置，曲终续播。这里的自动化使用受控 Audio mock；浏览器真解码、按钮联调由本轮总体界面记录另行记录。
5. 非法 Range、Origin、Host、缺失 track ID、外部文件路径请求、损坏 APE、扩展名伪装、符号链接与 concat 二级路径逃逸均有检查。缓存 fresh-entry 超额用 sparse 文件验证，不占用实际数 GiB 测试磁盘数据。
6. 缺 ffprobe 不再宣称解码可用；在准备期间换设备 / 静音、重复点击当前播放曲目均有控制器回归。

复跑：

```sh
node --test scripts/check-music-audio.mjs
node --experimental-strip-types --test scripts/check-music-player.mjs
# 可选：传入本机已下载且完整的官方样本，测试不自行联网下载
RHINE_TEST_APE=/tmp/rhine-v040-audio-fixtures/luckynight.ape node --test scripts/check-music-audio.mjs
```

未提供 `RHINE_TEST_APE` 时 APE 回归会明确标记 skipped，不能把这次跳过描述为 APE 通过。

## 主要官方依据

2026-10-03 后续调整：默认浏览器播放不在图形初始化时编译原生 helper；打开音频设置时探测设备，已保存的 CoreAudio 输出在图形预热后恢复。APE 播放仍直接准备 PCM，不依赖提前探测。页面隐藏继续播放；真正卸载或重新载入的原生 stop 使用 keepalive，降低导航取消请求的概率，但不保证网络故障或浏览器崩溃时送达。新增这两条路径后播放器回归为 8 项通过。

- [FFmpeg 解码器](https://ffmpeg.org/ffmpeg-codecs.html)：统一使用本机构建实际启用的 decoder，能力不凭扩展名推定。
- [FFmpeg 命令行与协议](https://ffmpeg.org/ffmpeg.html)、[格式 / WAV](https://ffmpeg.org/ffmpeg-formats.html)：输入限制、PCM 输出与 WAV / RF64 限制。
- [FFmpeg 通用格式支持](https://ffmpeg.org/general.html)：APE / FLAC / WAV / ALAC 等路线依据。
- [Apple AVAudioEngine](https://developer.apple.com/documentation/avfaudio/avaudioengine)、[AVAudioPlayerNode](https://developer.apple.com/documentation/avfaudio/avaudioplayernode)、[输出设备属性](https://developer.apple.com/documentation/audiotoolbox/kaudiooutputunitproperty_currentdevice)：音频图、片段调度与 macOS 输出设备选择。
- [FFmpeg 许可说明](https://ffmpeg.org/legal.html)：本轮使用独立的本机安装程序；若未来分发其二进制，需要按实际构建及随附组件重新整理许可材料。
