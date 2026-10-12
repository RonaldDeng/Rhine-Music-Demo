# 音频路线、缓存与输出边界

本页保留当前音频实现的边界；无缝排程见 [歌曲衔接说明](SONG-TRANSITIONS-V0.4.1.md)，实际执行结果见 [当前候选检查](REVIEW-V0.5.0.md)。下述 DSD 的 24 位 / 176.4 kHz 适用于普通解码；CoreAudio 无缝预备的下一首另行归一为当前引擎采样率的 Float32 PCM。4 GiB 是当前磁盘缓存回收目标，正在使用和受保护的文件可能暂时超过目标。

日期：2026-10-02。仅本地开发，没有上传 GitHub，没有复制或改写用户曲库。

## DSF / DFF 播放

DSF / DFF 通过本机 FFmpeg 解码为 **24 位 / 176.4 kHz PCM WAV**，保留源声道数，再使用既有浏览器或 CoreAudio 共享输出。转换只生成播放缓存，原始文件与标签始终只读。无需具备 DSD 解码能力的 DAC；本版不输出 Native DSD 或 DoP。

后端按实际 DSD / DST codec 选择转换路线，改扩展名不改变解码方式。使用 FFmpeg 内置 `swr` 重采样器，无需额外 libsoxr；不增加进度拖动界面，播放、暂停、切歌及音量沿用原有操作。首次播放仍需完整准备，后续复用缓存。

曲库保留源格式与 DSD 采样率。准备接口额外返回 `conversion: "dsd-to-pcm"`、一位采样时钟 `sourceSampleRate` 与 `sourceBitsPerSample: 1`；`sampleRate`、`bitsPerSample` 和 `duration` 描述实际 PCM 缓存。DSF 容器的 probe 时长可能含尾块填充，因此播放时长以解码后的实际 PCM 帧为准。176.4 kHz 是缓存采样率，不保证浏览器或 CoreAudio 共享输出设备以该采样率工作。

新增完全自生的双声道 DSD64 / 128 / 256 样本（DSF LSB、DSF MSB、DFF MSB）。样本先用 ffprobe 与 stream copy 核对原始位流，再用于播放解码、声道、缓存及源文件不变检查。最终执行结果见 [当前候选检查](REVIEW-V0.5.0.md)；未经过样本验证的 DST 压缩 DFF 不列为已实测范围。

## 解码与输出

歌曲通过本机 FFmpeg 解码为本地 PCM WAV，再交给浏览器或 Swift AVAudioEngine / AVAudioPlayerNode，经 CoreAudio 输出到选择的设备。两个播放后端共用曲库与控制器。

FFmpeg 没有作为二进制塞入项目。运行时查找 `FFMPEG_PATH` / `FFPROBE_PATH` 或 Homebrew / 系统 PATH，调用本机已经安装的程序。FFmpeg 和 ffprobe 必须同时存在。macOS 输出还需 Apple Command Line Tools 中的 `swiftc`，首次使用在数据目录编译小型 Swift helper；失败时设置明确显示原因，不报告虚假的原生能力。安装依赖属于用户机器配置，项目不附带这些工具的二进制。

设置中可以选择「浏览器」或「CoreAudio」，并选择当前实际枚举到的输出设备。切换后端保留曲目和播放位置，包括暂停后的恢复。CoreAudio 是共享模式，系统可混音与重采样；不包含独占 / hog mode、DoP / Native DSD、自动更改设备采样率或 bit-perfect 保证。氛围 BGM 继续使用浏览器独立控制，不改成原生歌曲队列的一部分。

## PCM、缓存与播放语义

- 索引支持 APE、WavPack、WMA、WAV、FLAC、ALAC / M4A、AIFF、MP3、AAC、OGG、OPUS、DSF / DFF；DSF / DFF 的浏览器播放须先经本机 PCM 准备，不依赖浏览器直接解码 DSD。
- 实际格式由 FFmpeg 检测，不能仅凭扩展名声称解码成功。PCM 来源按实际位数保留为 16 / 24 / 32 位，浮点解码用 float32 PCM，并保留其采样率；DSD 来源固定为 24 位 / 176.4 kHz。两条路线均保留声道数，AVAudioEngine 内部和硬件转换不等于无损直通。
- 首次播放先完整解码，完成后才开始播放。优点是 seek、暂停、恢复和 HTTP Range 有确定文件长度；代价是大文件首次播放有准备时间。这一路径不是边解码边播放；预排无缝接续按独立的歌曲衔接实现处理。
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

## 检查与设备边界

`npm run check:audio` 使用临时合成样本检查解码、缓存、源文件只读、声道、播放生命周期、接续及接口隔离。CoreAudio 真实设备自动测试使用零音量，离线渲染检查不连接扬声器。`scripts/fixtures/dsd.mjs` 生成 DSD64 / 128 / 256 夹具，不包含商业录音。

真实 APE 回归需要用户显式提供 `RHINE_TEST_APE`。测试不会自行联网下载样本，缺少样本时明确跳过。USB／蓝牙设备、热插拔、长期稳定性和人工听感不能从受控检查推断；当前执行范围见 [V0.5.0 验证](REVIEW-V0.5.0.md)。

```sh
npm run check:audio
# 可选：用户自行准备可用于测试的本机 APE 文件
RHINE_TEST_APE="/绝对路径/样本.ape" npm run check:audio
```

## 主要官方依据

2026-10-03 后续调整：默认浏览器播放不在图形初始化时编译原生 helper；打开音频设置时探测设备，已保存的 CoreAudio 输出在图形预热后恢复。APE 播放仍直接准备 PCM，不依赖提前探测。页面隐藏继续播放；真正卸载或重新载入的原生 stop 使用 keepalive，降低导航取消请求的概率，但不保证网络故障或浏览器崩溃时送达。新增这两条路径后播放器回归为 8 项通过。

- [FFmpeg 解码器](https://ffmpeg.org/ffmpeg-codecs.html)：统一使用本机构建实际启用的 decoder，能力不凭扩展名推定。
- [FFmpeg 命令行与协议](https://ffmpeg.org/ffmpeg.html)、[格式 / WAV](https://ffmpeg.org/ffmpeg-formats.html)：输入限制、PCM 输出与 WAV / RF64 限制。
- [FFmpeg 通用格式支持](https://ffmpeg.org/general.html)：APE / FLAC / WAV / ALAC 等路线依据。
- [Apple AVAudioEngine](https://developer.apple.com/documentation/avfaudio/avaudioengine)、[AVAudioPlayerNode](https://developer.apple.com/documentation/avfaudio/avaudioplayernode)、[输出设备属性](https://developer.apple.com/documentation/audiotoolbox/kaudiooutputunitproperty_currentdevice)：音频图、片段调度与 macOS 输出设备选择。
- [FFmpeg 许可说明](https://ffmpeg.org/legal.html)：运行使用独立的本机安装程序；若未来分发其二进制，需要按实际构建及随附组件重新整理许可材料。
