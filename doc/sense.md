> ## Documentation Index
> Fetch the complete documentation index at: https://docs.senseaudio.cn/llms.txt
> Use this file to discover all available pages before exploring further.

# 接口概览

> SenseAudio 开放平台全模态 API 接口速览

SenseAudio 开放平台提供覆盖**文本、语音、音频、图像、视频、音乐、智能体**七大方向的 RESTful API。所有接口采用统一的鉴权方式与错误语义，开发者可基于本页快速定位所需能力。

## 服务地址

所有接口均在以下地址提供服务：

```
https://api.senseaudio.cn
```

## 鉴权

所有接口均使用 **Bearer Token** 鉴权，请在请求头中携带您的 API Key：

```http theme={null}
Authorization: Bearer <Your_API_Key>
```

API Key 的创建与管理详见 [快速接入](https://docs.senseaudio.cn/guides/account/quick-access.md)，或直接前往 [SenseAudio API 平台 API 密钥](https://senseaudio.cn/api-platform/api-key)。

## 接口分组

> [card] [语音合成](https://docs.senseaudio.cn/api-reference/endpoint/tts/synthesize.md)
>
> 将文本合成为富有情感的 AI 语音，支持多情绪、多风格、多音字纠正、公式朗读。

> [card] [音频生成](https://docs.senseaudio.cn/api-reference/endpoint/audio/generate.md)
>
> 通过提示词、参考音色、参考音频和参考图片生成多角色对白、背景音乐与环境音效。

> [card] [语音识别](https://docs.senseaudio.cn/api-reference/endpoint/asr/transcriptions.md)
>
> 音频转写、流式实时识别、质检分析与历史记录查询。

> [card] [同声传译](https://docs.senseaudio.cn/api-reference/endpoint/simultaneous-interpretation/websocket.md)
>
> 实时接收 PCM 音频，流式返回识别原文、译文和可选的译文语音。

> [card] [人声分离](https://docs.senseaudio.cn/api-reference/endpoint/voice-isolation/sync.md)
>
> 上传音频并分离人声，支持同步返回结果或异步轮询任务状态。

> [card] [文本生成](https://docs.senseaudio.cn/api-reference/endpoint/llm/chat.md)
>
> 兼容 OpenAI / Anthropic 协议的多模态大模型接口，支持对话、消息与响应三种风格。

> [card] [图片生成](https://docs.senseaudio.cn/api-reference/endpoint/image/sync.md)
>
> 同步 / 异步图片生成与任务状态查询，覆盖常规尺寸与高分辨率输出。

> [card] [音乐生成](https://docs.senseaudio.cn/api-reference/endpoint/music/song-create-v2.md)
>
> 歌词生成、歌词改写与完整歌曲合成，支持风格控制、结构化歌词与纯音乐模式。

> [card] [音效生成](https://docs.senseaudio.cn/api-reference/endpoint/sfx/create.md)
>
> 根据文本描述同步生成 1-4 个音效变体，支持时长、变体数量和输出格式控制。

> [card] [视频生成](https://docs.senseaudio.cn/api-reference/endpoint/video/create.md)
>
> 视频生成服务面向短视频创作、营销素材制作、内容可视化和创意分镜生成等场景。

> [card] [实时智能体](https://docs.senseaudio.cn/api-reference/endpoint/realtime/invoke.md)
>
> 实时语音对话式智能体，支持会话邀请、状态查询与离会。

> [card] [自定义智能体](https://docs.senseaudio.cn/api-reference/endpoint/custom-agent/create.md)
>
> 创建、更新、查询与删除自定义智能体，可绑定 LLM 模型与系统音色。

## 全部接口一览

### 语音合成

| 接口 | 方法 | 路径 |
| - | - | - |
| [语音合成 HTTP](https://docs.senseaudio.cn/api-reference/endpoint/tts/synthesize.md) | POST | `/v1/t2a_v2` |
| [语音合成 HTTP 流式](https://docs.senseaudio.cn/api-reference/endpoint/tts/synthesize-stream.md) | POST | `/v1/t2a_v2` |
| [语音合成 WebSocket](https://docs.senseaudio.cn/api-reference/endpoint/tts/websocket.md) | WebSocket | `/ws/v1/t2a_v2` |

### 音频生成

| 接口 | 方法 | 路径 |
| - | - | - |
| [音频生成](https://docs.senseaudio.cn/api-reference/endpoint/audio/generate.md) | POST | `/v1/audio/generate` |

### 克隆音色

| 接口 | 方法 | 路径 |
| - | - | - |
| [查询可用音色](https://docs.senseaudio.cn/api-reference/endpoint/voice/list.md) | POST | `/v1/get_voice` |

## 通用约定

* **请求格式**：除文件上传外，均使用 `application/json` 作为请求体格式
* **响应格式**：所有响应均为 `application/json`，UTF-8 编码
* **幂等与重试**：对于耗时较长的生成类任务（图片异步、视频、音乐），创建接口会返回 `task_id`，请通过对应的状态查询接口轮询结果
* **错误码**：HTTP 状态码遵循标准语义；响应体中包含 `code` 与 `message` 字段描述错误详情

## 相关资源

> [card] [快速接入](https://docs.senseaudio.cn/guides/account/quick-access.md)
>
> 获取 API Key 并完成首个请求。

> [card] [模型列表](https://docs.senseaudio.cn/guides/account/model-list.md)
>
> 浏览全部可调用模型与能力概览。

> [card] [API 计费](https://docs.senseaudio.cn/guides/account/billing.md)
>
> 查看各项 API 的积分消耗规则。

> [card] [常见问题](https://docs.senseaudio.cn/guides/faq/overview.md)
>
> 接入过程中的常见问题解答。


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.