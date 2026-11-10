# 自定义语音供应商适配器 / Speech provider adapter

这是独立的 DSH Web 插件 `dsh-speech-provider-adapter`，配合音色工坊（`dsh-xiaomi-tts`）使用，实际调用配置的上游生成语音。首次运行无供应商配置，接管默认关闭。

## 分工与入口

供应商适配器在 DSH 内部的设置区管理多套供应商：名称、协议、Base URL、API Key、模型和音色目录、当前启用的一套配置及接管开关。音色工坊 顶部卡片显示当前供应商，并复用现有模型、音色、语音指令和声音标签控件；音色工坊 中选择后点击“保存”，选择写入 供应商适配器。试听支持尚未保存的模型、音色选择，普通朗读使用已保存选择。

音色工坊 保留播放、暂停、历史、下载、朗读范围、音量、播放语速、本地回退和已启用的渠道联动。语速只在播放端应用，供应商适配器 不叠加服务器语速。禁用 供应商适配器 接管或卸载 供应商适配器 后，恢复 音色工坊 原来的内置供应商配置。

音色工坊 开启「播报台 → 更多 → 宿主适配 → 接收外部供应商」（默认开启）时，点击顶部供应商卡片可循环切换本适配器保存的供应商，立即持久化当前选择并停止旧任务；只有一套配置时不切换。关闭接收并保存后使用内置供应商，重新开启后恢复接管，无需重新注册适配器。密钥、地址和供应商列表仍在本适配器管理。

管理入口：DSH 插件管理 → 供应商适配器 → 配置，表单直接显示在宿主内部。接管后，音色工坊密钥区域的“管理供应商”也通过 DSH 内部导航打开该配置区，不新建标签页。表单提供中文、English 和系统深浅主题；`/plugins/speech-provider-adapter` 保留为可选直达地址。

每个供应商标题旁提供“去获取 API Key”外链，指向对应平台的官方密钥创建或管理入口；腾讯云显示“去获取云 API 密钥”，用于获取 SecretId / SecretKey。链接在新标签页打开，桌面端由系统浏览器打开。Fish Audio 入口为开发者入门页，登录后可在其中获取 API Key。OpenAI 兼容协议的入口指向 OpenAI 官方平台；使用其他兼容服务时，请前往该服务自己的平台获取密钥。百炼入口默认北京地域，其他地域请在控制台切换。

页面使用“连接设置”“模型与音色”“目录管理”和“高级设置”四个标签，切换标签保留未保存的配置。连接设置底部提供测试连接，模型与音色支持按名称或 ID 搜索选择及刷新目录，密钥框可临时显示或隐藏当前输入。顶部保存栏在滚动时保留，侧栏接管区单独显示实际使用的供应商；接管开关、设为当前供应商以及表单编辑均需保存才生效。

宽设置区左侧列出供应商并支持搜索，窄设置区改用下拉选择，正在编辑的配置与实际生效的供应商分别标识。目录管理可在模型、音色之间切换，按名称或 ID 搜索，长列表通过“显示更多”继续加载；模型能力和音色适用模型按需展开。流式、单次文本上限及删除配置位于“高级设置”，目录筛选不会修改保存的条目。

界面仅参考 shadcn/ui 的组件风格，仍使用原生 HTML、CSS 和 JavaScript。未引入 shadcn、Tailwind 或页面框架依赖，也不需要额外的前端构建。

## 本地安装

使用 npm 包时，在同一宿主实例安装两个插件：

```powershell
dsh plugin --profile web add dsh-xiaomi-tts@latest
dsh plugin --profile web add dsh-speech-provider-adapter@latest
```

以下为源码开发的本地链接方式。

先在 音色工坊 仓库根目录构建，使用 Node.js 24.9+、pnpm：

```powershell
pnpm build
dsh plugin --profile web add "link:E:/personal/Dsh/dsh-plugin-xiaomi-mimo-tts"
dsh plugin --profile web add "link:E:/personal/Dsh/dsh-speech-provider-adapter"
```

将路径替换为实际路径；适配器没有额外构建步骤。用于本地源码开发时，在适配器目录执行 `pnpm install`，开发依赖会链接相邻的 `../dsh-plugin-xiaomi-mimo-tts`；其他目录结构请调整该开发依赖链接。供应商适配器 的 `cordis.patch.yml` 声明了宿主组件；在插件管理中启用该组件，重启或按宿主提示重新加载。音色工坊 和 供应商适配器 必须在同一个宿主实例。若手动维护 profile，组件为：

```yaml
- id: speech-provider-adapter
  name: dsh-speech-provider-adapter
  config: {}
```

从本地链接切换回 npm 包时，Windows 用户可双击仓库中的 `clear-local-links.cmd`，或运行 `node scripts/clear-local-links.mjs`。脚本清理 `web` profile 中供应商适配器的安装记录、本地覆盖和残留目录，备份修改过的配置，保留音色工坊、源码和供应商配置。完成后按脚本提示重新安装适配器；如设置了 `DSH_HOME`，脚本使用该目录。

供应商适配器 依赖 `speechSynthesis`、`webServer`、`settings` 服务。仅通过公开入口 `dsh-xiaomi-tts/host-api` 使用类型契约和错误类，不读取音色工坊的内部实现或构建目录。旧 npm 版 音色工坊 若没有本次目录与选择接口，需先安装当前构建。

## 服务商预设

“新增”中包含 SenseAudio（商汤）、OpenAI compatible（OpenAI 兼容）、MiniMax（稀宇科技）、SiliconFlow（硅基流动）、ElevenLabs、Fish Audio、Alibaba Cloud Bailian（阿里云百炼）和 Tencent Cloud（腾讯云）。预设只建立草稿，不会开启接管、写入密钥或调用付费合成。以下新增预设按官方接口文档整理于 2026-11-06，未使用真实账号实测；模型、音色与账号权限以供应商当前服务为准。中文备注用于协议选项和新建预设名称，已有配置名称保持用户保存的值。

| 服务商 | 协议与默认配置 | 使用差异与官方参考 |
| --- | --- | --- |
| SiliconFlow（硅基流动） | OpenAI 风格的专用适配；CosyVoice2 0.5B，8 个系统音色 | 音色 ID 带模型前缀并限定适用模型；PCM 显式请求 24000 Hz，HTTP 流式发送 stream；CosyVoice2 指令拼入 input 的 endofprompt 前缀。[合成接口](https://docs.siliconflow.cn/docs/api/audio-speech-post)、[音色与格式](https://docs.siliconflow.cn/docs/userguide/capabilities/text-to-speech) |
| ElevenLabs | 原生协议；Multilingual v2 / Flash v2.5，George 示例音色 | 使用 xi-api-key；合成及 HTTP 流式指定 pcm_24000 或 MP3；模型与账号音色分别查询，音色读取跟随 v2 分页。[合成](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)、[流式](https://elevenlabs.io/docs/api-reference/text-to-speech/stream)、[音色目录](https://elevenlabs.io/docs/api-reference/voices/search) |
| Fish Audio | 原生协议；S2.1 Pro、S2.1 Pro Free、S2 Pro、S1，音色初始为空 | 合成模型放在 model 请求头，音色对应 reference_id。刷新读取自己工作区的音色；公共音色或其他可用参考 ID 可手动加入。不会将声音模型目录误当合成模型，也不填写虚构 ID。[合成](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech)、[音色目录](https://docs.fish.audio/api-reference/endpoint/model/list-models) |
| Alibaba Cloud Bailian（阿里云百炼） | 原生 Qwen-Audio-TTS HTTP；Qwen-Audio 3.0 / 3.1 Flash / Plus，按模型绑定示例音色 | Bearer API Key；业务空间域名，SSE Base64 音频；24 kHz PCM 封装 WAV 或拼接 MP3，支持流式和 input.instruction。预设或手动目录，不伪造连接成功。[合成接口](https://help.aliyun.com/zh/model-studio/qwen-audio-tts-http-api)、[音色列表](https://help.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list) |
| Tencent Cloud（腾讯云） | 原生 TextToVoice API 3.0；固定基础合成接口，智瑜、智云、智斌、智兰示例音色 | SecretId / SecretKey，TC3-HMAC-SHA256；直接返回上游 16 kHz WAV / MP3。当前仅完整音频，无独立语音指令，保守限制每段 150 字。预设或手动目录。[合成接口](https://cloud.tencent.com/document/api/1073/37995)、[签名方法](https://cloud.tencent.com/document/api/213/30654)、[音色列表](https://cloud.tencent.com/document/product/1073/92668) |

### 阿里云百炼

新增百炼预设后，将 Base URL 的 `YOUR_WORKSPACE_ID` 替换为账号对应业务空间 ID，例如 `https://<业务空间ID>.cn-beijing.maas.aliyuncs.com`；新加坡使用 `https://<业务空间ID>.ap-southeast-1.maas.aliyuncs.com`。API Key 与业务空间必须属于同地域。不填写 `/compatible-mode/v1`，也不附加完整合成路径；已带 `/api/v1` 的地址可被规范化。

模型和音色不可跨版本混用。预设给出模型限定关系，例如 3.0 Flash 的 `longanhuan_v3.6` 与 3.1 的 `longanhuan_v3.1`；切换模型会选择其适用音色。当前适配的是 Qwen-Audio-TTS HTTP 协议，不将旧 Qwen-TTS、CosyVoice WebSocket 或百炼聊天兼容接口当作同一协议。新增其他模型前请确认实际接口契约。

无论即时流式还是完整音频播放，上游均请求 SSE 音频块；完整音频模式收齐后才交给音色工坊播放。最终事件中的音频 URL 不下载，避免重复音频。独立语音指令写入 `input.instruction`，服务端语速固定为 1。

### 腾讯云

新增腾讯云预设，Base URL 默认 `https://tts.tencentcloudapi.com`。在各自输入框填写 SecretId、SecretKey；两项均隐藏保存，留空保留已有值，可分别清除。无需 AppId 或地域参数。请使用具备语音合成权限的云 API 凭据，只有 API Key 的 OpenAI 兼容凭据不能用于此协议。

模型选择中的 `TextToVoice` 表示基础合成 API（`ModelType: 1`），不是可任意替换的模型 ID；不同合成引擎通过数值型 VoiceType 音色 ID 选择。可以手动补充该接口支持的普通/大模型音色；当前不支持需要额外 FastVoiceType 的一句话声音复刻音色 `200000000`。语速和音量使用上游默认值，播放端继续控制。

当前使用完整音频路径，保持腾讯云实际返回的 16 kHz WAV，不将其标成 24 kHz PCM 流。单次文本上限按保守的 150 字限制上报音色工坊，长回复由音色工坊分段；英文也沿用此限制。流式和独立语音指令能力固定关闭，手动开启目录标记也不会改变。

两家当前未接入只读目录查询，页面禁用“测试连接”和“刷新目录”，并保留目录手动编辑。接口也返回 `external-catalog-unavailable`，不会把静态预设视为鉴权成功；通过保存后试听验证实际权限和合成，试听会调用上游。预设并不代表账号一定拥有相应模型/音色权限。

硅基流动的音色目录以预设和手动补充为主，模型刷新筛选 TTS 条目；新增模型时请同步添加该模型实际支持的音色 ID。ElevenLabs 和 Fish Audio 首版不把独立的自由文本语音指令参数传给上游，显式传入会拒绝，避免静默忽略。SenseAudio、OpenAI 兼容和 MiniMax 的配置保持原样。

Fish Audio 新建配置需要先填写密钥，再刷新工作区音色或手动添加参考音色 ID。没有目录时可保存配置，但不会就绪；刷新只为原本为空的模型、音色选择补默认值，已有选择保持不变。若工作区音色为空，查询成功仍不表示已具备可合成的音色。

ElevenLabs 音色与 Fish Audio 工作区音色按分页读取，去重后最多 2000 项；目录过大、分页异常或权限不足时返回稳定错误，已有目录不会被覆盖。Fish Audio 的合成模型列表来自文档预设，测试连接必须有真实目录请求成功，静态预设不作为连接成功依据。

## 配置与协议

提供的 SenseAudio 接口参考位于 [doc/sense.md](doc/sense.md)。

1. 新增配置，填写名称，选择协议，并设置相应地址、密钥、模型和音色。切换协议只更改请求格式，不会清空已有地址或目录。
2. “测试连接”查询目录，不执行合成。“刷新模型与音色”按 ID 合并返回结果，保留原目录和选择；在目录编辑区添加、重命名或移除条目。空白/重复 ID、无效选择在保存时拒绝。
3. OpenAI 兼容服务没有统一的公共系统音色目录，适配器提供可编辑的常用音色初始列表；按目标服务实际支持的 ID 配置。MiniMax 模型目录无法查询时保留预设或手动模型，音色查询可独立成功。目录测试成功不保证所有模型均有合成权限。
4. “设为当前供应商”选择 供应商适配器 当前配置，打开接管开关，点击“保存更改”。供应商切换和接管开关也遵循保存机制。
5. 音色工坊 中模型、音色、指令切换先形成草稿，点击现有保存按钮写入 供应商适配器。外部配置发生变化后保存旧草稿会被拒绝，放弃草稿后读取最新选择。音色工坊 的内置配置不参与 供应商适配器 保存。

| 协议 | 地址示例 | 合成 | 目录 | 指令与标签 |
| --- | --- | --- | --- | --- |
| SenseAudio（商汤） | `https://api.senseaudio.cn` | `/v1/t2a_v2` JSON hex、SSE hex PCM | `/v1/models?mode=tts`、`/v1/get_voice` | 声明停顿 `<break time=500>`；不发送未声明的情绪参数 |
| OpenAI compatible | `https://api.openai.com/v1` | `/v1/audio/speech` 二进制音频 / PCM 流 | `/v1/models` 中名称含 tts / speech- 的模型；音色手动目录 | 已知支持的模型启用 `instructions`；兼容服务可在模型目录中设置该能力 |
| MiniMax（稀宇科技） | `https://api.minimax.io` 或目标服务地址 | `/v1/t2a_v2` JSON hex、SSE hex PCM | `/v1/get_voice`；模型预设或手动，兼容服务支持时也可获取 | 情绪枚举映射 `voice_setting.emotion`，2.8 声音标签按官方列表提供 |

Base URL 支持服务根地址、已有 `/v1` 和反向代理前缀，不接受 URL 用户名、密码、查询参数或片段。协议切换不代表不同平台的模型 ID、音色或凭据可以互用。HTTP 传输支持本地兼容服务；公网服务通常使用 HTTPS。当前不支持 WebSocket、任意 JSON 模板、声音克隆创建、文生音色创建、自定义请求头或 URL 音频下载。

除腾讯云返回原生 16 kHz WAV 外，完整 WAV 请求 24 kHz、单声道 PCM16 后封装；MP3 使用上游音频。HTTP 流式请求固定 24 kHz 单声道 PCM16，SSE 处理跨网络分片的事件，排除末尾聚合音频以避免重复播放。能力可按供应商及模型关闭，关闭后 音色工坊 使用完整音频路径。上游返回不匹配的格式或采样元数据时拒绝，不把压缩音频伪装成 PCM。

手动目录中的模型可设置是否支持流式、语音指令；音色可限定适用模型。MiniMax 情绪受已知模型支持范围约束。只有实际支持时才开启能力，开启选项不会让上游凭空支持该功能。

## 保存、隔离与错误

供应商适配器 默认将 JSON 配置保存至当前 profile 的 `speech-provider-adapter/providers.json`，路径依据 `settings.documentPath`。可通过组件的普通 `storagePath` 配置指定其他文件；一份文件只交给一个 供应商适配器 实例使用。写入采用串行、修订检查和临时文件替换，浏览器只接收 `keyConfigured` 和适用时的 `secretIdConfigured`，不返回已保存的 API Key、SecretId 或 SecretKey。腾讯云 SecretKey 复用存储字段 `apiKey`，SecretId 使用 `secretId`；其他协议存储结构兼容。输入留空保留原值，显式清除才删除。备份此配置时按包含凭据的文件管理。

所有管理端点仅供同源页面使用，写操作要求 JSON，保存和目录查询还要求当前 revision。浏览器请求校验 Origin；桌面壳已校验应用来源并移除来源头的转发请求，使用管理页发送的专用请求头兼容。跨站、空来源及未标记的无来源写请求仍被拒绝；沿用宿主访问控制，部署到公网时保护整个宿主。只读 profile 拒绝保存。客户端原始异常、上游正文和密钥不会进入错误响应；上游请求不自动重试，取消和插件卸载会终止读取。刷新失败保留已有目录；不会偷偷换回内置云端供应商。

若另一个插件正在接管，先在该插件关闭接管。未配置密钥等情况下允许显示外部未就绪状态。目录错误、鉴权失败、限流、超时、配置冲突使用稳定错误码提示。

## 验证与扩展

在本插件目录运行 `pnpm test`，行为测试覆盖原有及新增协议、PCM/WAV、取消、目录、密钥保留、版本冲突、同源限制、接管注册和选择保存；音色工坊的通用注册与选择路由测试留在音色工坊仓库。真实账号的权限、音质和费用需使用你的服务配置自行验证；不要将密钥写入仓库。

协议调度位于 `protocols.mjs`，百炼 SSE 和腾讯云签名/合成实现位于 `cloud-providers.mjs`，持久化和目录校验位于 `store.mjs`，宿主注册与管理路由位于 `index.mjs`，管理页在 `ui/`。替换或扩展上游时保留请求取消、音频格式、大小上限及稳定错误约定。主插件接口详见音色工坊仓库的 `open-api.md`；本地相邻目录为 `../dsh-plugin-xiaomi-mimo-tts/open-api.md`。

## English

This independent DSH Web plugin manages SenseAudio, OpenAI-compatible Speech, MiniMax, SiliconFlow, ElevenLabs, Fish Audio, Alibaba Cloud Bailian and Tencent Cloud profiles. Presets are documentation-based examples, not verified provider accounts. Fish Audio starts without a voice ID: refresh workspace voices or add a reference ID manually. Bailian uses a workspace-specific regional endpoint and API Key, with Qwen-Audio-TTS HTTP SSE; Tencent uses SecretId / SecretKey and TC3 signing for TextToVoice, with complete 16 kHz audio only and a conservative 150-character limit. Their catalogs are preset/manual and connection tests/refresh are disabled. Open its configuration in the DSH plugin manager, configure a profile, choose it as active, enable takeover, and save. The page supports English. 音色工坊 reuses its existing model/voice/instruction controls; selections remain drafts until Save and are persisted by 供应商适配器. Disable takeover to restore 音色工坊's built-in configuration.

Settings use four tabs: Connection, Model and voice, Manage catalogs, and Advanced settings. Model and voice pickers support name/ID search; changing tabs retains drafts. The save bar remains available while scrolling, and the actual takeover state is shown separately from unsaved changes. Narrow settings surfaces use a provider dropdown. Catalogs support separate model/voice views, name or ID search, and Show more for long lists; capabilities and model scope expand on demand. Streaming, text limits and deletion are under Advanced settings.

Build 音色工坊 first, then install both local paths with `dsh plugin --profile web add "link:<absolute-path>"`. The adapter ships its own bundle patch and requires the updated 音色工坊, Web server and Settings services. No separate build is required for 供应商适配器. The settings form stays inside DSH; 音色工坊 opens it through the host plugin navigation. Credentials remain in a profile-local JSON file; browsers receive only key-presence metadata. Connection tests query catalogs without generating speech. Full audio and HTTP PCM streaming are supported; WebSocket and arbitrary request templates are outside this plugin.

Official protocol references: [SenseAudio synthesis](https://docs.senseaudio.cn/api-reference/endpoint/tts/synthesize.md), [SenseAudio models](https://docs.senseaudio.cn/api-reference/endpoint/models/list.md), [SenseAudio voices](https://docs.senseaudio.cn/api-reference/endpoint/voice/list.md), [MiniMax synthesis](https://platform.minimax.io/docs/api-reference/speech-t2a-http), [MiniMax voices](https://platform.minimax.io/docs/api-reference/voice-management-get), [OpenAI Speech](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create).
