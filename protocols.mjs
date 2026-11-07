import { TtsProviderError } from './host-api.mjs'
import { aliyunAudio, tencentSynthesize } from './cloud-providers.mjs'
import { synthesizeXiaomi, streamXiaomi, synthesizeBreeze, streamBreeze, synthesizeDoubao, streamDoubao, DOUBAO_TTS_ENDPOINT } from './native-providers.mjs'
import { synthesizeCustom, streamCustom } from './custom-provider.mjs'

const MAX_AUDIO = 32 * 1024 * 1024
const fail = (code, status = 502) => { throw new TtsProviderError(code, undefined, status) }
export const PROTOCOLS = ['senseaudio', 'openai', 'minimax', 'siliconflow', 'elevenlabs', 'fish', 'aliyun', 'tencent', 'xiaomi', 'doubao', 'breeze', 'custom']
const BINARY_PROTOCOLS = new Set(['openai', 'siliconflow', 'elevenlabs', 'fish'])
const FISH_MODELS = ['s2.1-pro', 's2.1-pro-free', 's2-pro', 's1']
const XIAOMI_MODELS = ['mimo-v2.5-tts']
const XIAOMI_VOICES = ['冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean']
const DOUBAO_MODELS = ['seed-tts-2.0', 'seed-icl-2.0']
const DOUBAO_VOICES = [
  ['Vivi 2.0', 'zh_female_vv_uranus_bigtts'], ['知性灿灿 2.0', 'zh_female_cancan_uranus_bigtts'], ['撒娇学妹 2.0', 'zh_female_sajiaoxuemei_uranus_bigtts'],
  ['爽快思思 2.0', 'zh_female_shuangkuaisisi_uranus_bigtts'], ['少年梓辛 2.0', 'zh_male_shaonianzixin_uranus_bigtts'], ['猴哥 2.0', 'zh_male_sunwukong_uranus_bigtts'],
  ['黑猫侦探社咪仔 2.0', 'zh_female_mizai_uranus_bigtts'], ['儒雅逸辰 2.0', 'zh_male_ruyayichen_uranus_bigtts'], ['TVB女声 2.0', 'zh_female_tvbnv_uranus_bigtts'],
  ['四郎 2.0', 'zh_male_silang_uranus_bigtts'], ['熊二 2.0', 'zh_male_xionger_uranus_bigtts'], ['樱桃丸子 2.0', 'zh_female_yingtaowanzi_uranus_bigtts'],
  ['高冷御姐 2.0', 'zh_female_gaolengyujie_uranus_bigtts'], ['傲娇霸总 2.0', 'zh_male_aojiaobazong_uranus_bigtts'], ['悬疑解说 2.0', 'zh_male_xuanyijieshuo_uranus_bigtts'],
  ['小何 2.0', 'zh_female_xiaohe_uranus_bigtts'], ['云舟 2.0', 'zh_male_m191_uranus_bigtts'], ['小天 2.0', 'zh_male_taocheng_uranus_bigtts'],
  ['清澈梓梓 2.0', 'zh_female_qingchezizi_uranus_bigtts'], ['女雷神 2.0', 'zh_female_nvleishen_uranus_bigtts'], ['直率英子 2.0', 'zh_female_zhishuaiyingzi_uranus_bigtts'],
  ['谄媚女声 2.0', 'zh_female_chanmeinv_uranus_bigtts'], ['玲玲姐姐 2.0', 'zh_female_lingling_uranus_bigtts'], ['娇喘女声 2.0', 'zh_female_jiaochuannv_uranus_bigtts'],
  ['鲁班七号 2.0', 'zh_male_lubanqihao_uranus_bigtts'], ['春日部姐姐 2.0', 'zh_female_chunribu_uranus_bigtts'], ['温柔妈妈 2.0', 'zh_female_wenroumama_uranus_bigtts'],
  ['霸气青叔 2.0', 'zh_male_baqiqingshu_uranus_bigtts'], ['深夜播客 2.0', 'zh_male_shenyeboke_uranus_bigtts'], ['儿童绘本 2.0', 'zh_female_xiaoxue_uranus_bigtts'],
]
const BREEZE_MODEL = 'breeze-tts-2'
const BREEZE_VOICES = [
  ['voc_rh6e8hdbraz6', '哈基米娘'], ['voc_b86bfwct4cjn', '香农小姐'], ['voc_8yud7hz7c9q2', '大肥鱼（迷糊版）'], ['voc_u3nxkd5578wc', '大肥鱼（机灵版）'],
  ['voc_reys5un5t4ed', '深思先生'], ['voc_pczdutjax3bc', '实录观察者'], ['voc_ytteeuvt48pm', '岁月回声'], ['voc_mmbkawdhpk29', '晨光记录员'],
  ['voc_dzumjsqzf948', '素言叙事'], ['voc_3n4rhszjst3f', '青衿师语'], ['voc_zbggdxky3yu3', '深夜观察者'], ['voc_xb3zjqcmwp44', '晨曦讲解员'],
  ['voc_ynfyjw6yrv7p', '雅致述评人'], ['voc_vhv3b2252en7', '星海引路人'], ['voc_tzneby749yja', '灵动汐语'], ['voc_nmea5hnwvwcu', '幽兰语者'],
  ['voc_t2kpg5h4ebah', '热点快评员'], ['voc_rye44d226x46', '雅韵谈锋'], ['voc_kvzxd25fpshp', '晨露花语'], ['voc_chsmgh7pkufq', '元气茶香'],
  ['voc_7jsxftc2rm3n', '墨香少女'], ['voc_csdwmam68z4k', '疾风信使'], ['voc_shetwnrd3q3q', '静谧流年'], ['voc_2z7zu82z2eu3', '林间漫语者'],
  ['voc_wuwu3ckdfe4q', '云端播报员'], ['voc_yu7t5b4tx7c7', '深夜树洞'], ['voc_9zyu28uzmjsk', '八方馆掌柜'], ['voc_2b358584ukkb', '晨曦热血少年'],
  ['voc_ge466ug83952', '智械管家'], ['voc_f3zbgr88pz5m', '月夜低语者'],
]
const emotions = ['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm']
const interjections = ['laughs', 'chuckle', 'coughs', 'clear-throat', 'groans', 'breath', 'pant', 'inhale', 'exhale', 'gasps', 'sniffs', 'sighs', 'snorts', 'burps', 'lip-smacking', 'humming', 'hissing', 'emm', 'sneezes']

export function modelFeatures(protocol, model, profile) {
  if (protocol === 'custom') {
    const custom = profile?.custom
    return { streaming: custom?.audioFormat === 'pcm' && custom?.sampleRate === 24000 && model.streaming !== false,
      speechInstruction: model.speechInstruction === true }
  }
  const instruction = protocol === 'openai' ? /^gpt-4o-mini-tts(?:-|$)/u.test(model.id)
    : protocol === 'aliyun' ? /^qwen-audio-3\.[01]-tts-(?:flash|plus)$/u.test(model.id)
      : protocol === 'siliconflow' ? /CosyVoice2/iu.test(model.id)
        : protocol === 'minimax' ? /^speech-(?:2\.[68]|0[12])-/u.test(model.id)
          : protocol === 'xiaomi' ? true
            : protocol === 'breeze' ? true
              : protocol === 'doubao' ? model.id === 'seed-tts-2.0' : false
  return {
    streaming: protocol !== 'tencent' && model.streaming !== false,
    speechInstruction: protocol !== 'tencent' && (model.speechInstruction ?? instruction),
    ...(protocol === 'minimax' && instruction ? { instructions: [...emotions, ...(/^speech-2\.6-/u.test(model.id) ? ['fluent', 'whisper'] : [])].map(id => ({ id, name: id })) } : {}),
    ...(protocol === 'senseaudio' ? { audioTags: [{ value: '<break time=500>', name: '停顿 500 ms / Pause 500 ms' }] }
      : protocol === 'minimax' && /^speech-2\.8-/u.test(model.id) ? { audioTags: interjections.map(id => ({ value: `(${id})`, name: id })) } : {}),
  }
}

export function preset(protocol = 'senseaudio') {
  if (!PROTOCOLS.includes(protocol)) return fail('adapter-config-invalid', 400)
  if (protocol === 'aliyun') {
    const flash = 'qwen-audio-3.0-tts-flash', plus = 'qwen-audio-3.0-tts-plus'
    const flash31 = 'qwen-audio-3.1-tts-flash', plus31 = 'qwen-audio-3.1-tts-plus'
    return { protocol, name: 'Alibaba Cloud Bailian（阿里云百炼）', baseURL: 'https://YOUR_WORKSPACE_ID.cn-beijing.maas.aliyuncs.com', apiKey: '', streaming: true, maxTextLength: 2000,
      models: [flash, plus, flash31, plus31].map(id => ({ id, name: id, speechInstruction: true })),
      voices: [
        { id: 'longanhuan_v3.6', name: '龙安欢', modelIds: [flash] },
        { id: 'longanfengyue', name: '龙安风悦', modelIds: [flash] },
        { id: 'longanlingxin', name: '龙安灵心', modelIds: [plus] },
        ...[['longanhuan_v3.1', '龙安欢 v3.1'], ['longanlingxin_v3.1', '龙安灵心 v3.1'], ['longanfengyue_v3.1', '龙安风悦 v3.1'], ['xunanchuan_v3.1', '许南川']]
          .map(([id, name]) => ({ id, name, modelIds: [flash31, plus31] })),
      ], selection: { model: flash, voice: 'longanhuan_v3.6', speechInstruction: '' } }
  }
  if (protocol === 'tencent') return {
    protocol, name: 'Tencent Cloud（腾讯云）', baseURL: 'https://tts.tencentcloudapi.com', apiKey: '', secretId: '', streaming: false, maxTextLength: 150,
    models: [{ id: 'TextToVoice', name: '基础语音合成 / TextToVoice', streaming: false, speechInstruction: false }],
    voices: [['101001', '智瑜'], ['101004', '智云'], ['501000', '智斌'], ['501001', '智兰']].map(([id, name]) => ({ id, name })),
    selection: { model: 'TextToVoice', voice: '101001', speechInstruction: '' },
  }
  if (protocol === 'siliconflow') {
    const model = 'FunAudioLLM/CosyVoice2-0.5B'
    return { protocol, name: 'SiliconFlow（硅基流动）', baseURL: 'https://api.siliconflow.cn/v1', apiKey: '', streaming: true, maxTextLength: 4096,
      models: [{ id: model, name: 'CosyVoice2 0.5B', speechInstruction: true }],
      voices: ['alex', 'benjamin', 'charles', 'david', 'anna', 'bella', 'claire', 'diana'].map(name => ({ id: `${model}:${name}`, name, modelIds: [model] })),
      selection: { model, voice: `${model}:alex`, speechInstruction: '' } }
  }
  if (protocol === 'elevenlabs') return {
    protocol, name: 'ElevenLabs', baseURL: 'https://api.elevenlabs.io/v1', apiKey: '', streaming: true, maxTextLength: 2000,
    models: [{ id: 'eleven_multilingual_v2', name: 'Multilingual v2' }, { id: 'eleven_flash_v2_5', name: 'Flash v2.5' }],
    voices: [{ id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George' }],
    selection: { model: 'eleven_multilingual_v2', voice: 'JBFqnCBsd6RMkjVDRZzb', speechInstruction: '' },
  }
  if (protocol === 'fish') return {
    protocol, name: 'Fish Audio', baseURL: 'https://api.fish.audio', apiKey: '', streaming: true, maxTextLength: 4096,
    models: FISH_MODELS.map(id => ({ id, name: id })), voices: [],
    selection: { model: FISH_MODELS[0], voice: '', speechInstruction: '' },
  }
  if (protocol === 'xiaomi') return {
    protocol, name: 'Xiaomi MiMo TTS（小米）', baseURL: 'https://api.xiaomimimo.com/v1', apiKey: '', streaming: true, maxTextLength: 10000,
    models: XIAOMI_MODELS.map(id => ({ id, name: 'MiMo v2.5 TTS', streaming: true, speechInstruction: true })),
    voices: XIAOMI_VOICES.map(id => ({ id, name: id })),
    selection: { model: 'mimo-v2.5-tts', voice: '冰糖', speechInstruction: '' },
  }
  if (protocol === 'doubao') return {
    protocol, name: '豆包 Seed TTS（火山引擎）', baseURL: DOUBAO_TTS_ENDPOINT, apiKey: '', streaming: true, maxTextLength: 10000,
    models: DOUBAO_MODELS.map(id => ({ id, name: id === 'seed-icl-2.0' ? 'Seed ICL 2.0（复刻音色）' : 'Seed TTS 2.0', streaming: true, speechInstruction: id === 'seed-tts-2.0' })),
    voices: DOUBAO_VOICES.map(([name, id]) => ({ id, name })),
    selection: { model: 'seed-tts-2.0', voice: 'zh_female_vv_uranus_bigtts', speechInstruction: '' },
  }
  if (protocol === 'breeze') return {
    protocol, name: 'Breeze Blue TTS', baseURL: 'https://api.breeze.blue/v1', apiKey: '', streaming: true, maxTextLength: 1000,
    models: [{ id: BREEZE_MODEL, name: 'Breeze TTS 2', streaming: true, speechInstruction: true }],
    voices: BREEZE_VOICES.map(([id, name]) => ({ id, name })),
    selection: { model: BREEZE_MODEL, voice: 'voc_rh6e8hdbraz6', speechInstruction: '' },
  }
  if (protocol === 'custom') return {
    protocol, name: '自定义本地模型（Custom local model）', baseURL: 'http://127.0.0.1:8880/v1', apiKey: '', streaming: false, maxTextLength: 4096,
    models: [{ id: 'tts-1', name: '默认模型 / Default model', speechInstruction: true }],
    voices: [{ id: 'default', name: '默认音色 / Default voice' }],
    selection: { model: 'tts-1', voice: 'default', speechInstruction: '' },
    custom: {
      method: 'POST', path: 'audio/speech', bodyType: 'json',
      headers: [{ name: 'Authorization', value: 'Bearer {{apiKey}}' }],
      body: { model: '{{model}}', input: '{{text}}', voice: '{{voice}}', response_format: '{{format}}', instructions: '{{instruction}}' },
      response: 'binary', audioPath: 'data.audio', audioFormat: 'wav', sampleRate: 24000,
    },
  }
  const models = protocol === 'senseaudio' ? ['sensenova-tts-2.0', 'senseaudio-tts-1.5-260319']
    : protocol === 'minimax' ? ['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo', 'speech-02-hd', 'speech-02-turbo'] : ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd']
  const voices = protocol === 'openai' ? ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse', 'marin', 'cedar']
    : protocol === 'senseaudio' ? ['female_0033_b', 'male_0004_a'] : ['English_expressive_narrator']
  return {
    protocol, name: protocol === 'senseaudio' ? 'SenseAudio（商汤）' : protocol === 'openai' ? 'OpenAI compatible（OpenAI 兼容）' : 'MiniMax（稀宇科技）',
    baseURL: protocol === 'senseaudio' ? 'https://api.senseaudio.cn' : protocol === 'minimax' ? 'https://api.minimax.io' : 'https://api.openai.com/v1',
    apiKey: '', streaming: true, maxTextLength: protocol === 'openai' ? 4096 : 9999,
    models: models.map(id => ({ id, name: id })), voices: voices.map(id => ({ id, name: id })),
    selection: { model: models[0], voice: voices[0], speechInstruction: '' },
  }
}

export function endpoint(base, resource, version = 'v1') {
  let url
  try { url = new URL(base) } catch { return fail('adapter-url-invalid', 400) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return fail('adapter-url-invalid', 400)
  const prefix = url.pathname.replace(/\/+$/u, '').replace(/\/v[12]$/u, '')
  url.pathname = `${prefix}${version ? `/${version}` : ''}/`
  return new URL(resource, url).href
}

async function request(profile, resource, body, signal, transport = fetch, { version = 'v1', headers = {} } = {}) {
  signal.throwIfAborted()
  const response = await transport(endpoint(profile.baseURL, resource, version), {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal,
    headers: { ...(profile.protocol === 'elevenlabs' ? { 'xi-api-key': profile.apiKey } : { authorization: `Bearer ${profile.apiKey}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) {
    await response.body?.cancel()
    fail(response.status === 401 || response.status === 403 ? 'api-key-rejected' : response.status === 402 ? 'external-quota-exceeded' : response.status === 429 ? 'rate-limited' : 'external-upstream-failed', response.status === 429 ? 429 : 502)
  }
  return response
}

async function boundedBody(response, signal, maximum = MAX_AUDIO) {
  const reader = response.body?.getReader()
  if (!reader) return fail('external-response-invalid')
  const parts = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > maximum) return fail('audio-too-large', 413)
      parts.push(chunk.value)
    }
    return Buffer.concat(parts)
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

function checkedJson(bytes) {
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { return fail('external-response-invalid') }
  const status = value?.base_resp?.status_code
  if (status !== undefined && status !== 0) {
    fail(status === 1002 ? 'rate-limited' : status === 1004 || status === 2049 ? 'api-key-rejected' : status === 1008 ? 'external-quota-exceeded' : 'external-upstream-failed')
  }
  if (!value || typeof value !== 'object') return fail('external-response-invalid')
  return value
}

function hexAudio(value) {
  if (typeof value !== 'string' || !value.length || value.length % 2 || !/^[a-f\d]+$/iu.test(value)) return fail('invalid-audio-format')
  if (value.length > MAX_AUDIO * 2) return fail('audio-too-large', 413)
  return Buffer.from(value, 'hex')
}

function checkAudioInfo(value, format) {
  const info = value.extra_info
  if (!info) return
  if ((info.audio_format && info.audio_format !== format) || (format === 'pcm' && ((info.audio_sample_rate && info.audio_sample_rate !== 24000)
    || (info.audio_channel && info.audio_channel !== 1)))) return fail('invalid-audio-format')
}

function checkPcm(bytes) {
  if (bytes.toString('ascii', 0, 4) === 'RIFF' || bytes.toString('ascii', 0, 3) === 'ID3') return fail('invalid-audio-format')
  return bytes
}

export function pcmWav(data, sampleRate = 24000) {
  if (!data.length || data.length % 2) return fail('invalid-audio-format')
  const header = Buffer.alloc(44)
  header.write('RIFF'); header.writeUInt32LE(data.length + 36, 4); header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

function payload(profile, text, format, streaming, selection) {
  if (profile.protocol === 'elevenlabs' || profile.protocol === 'fish') {
    if (selection.speechInstruction) return fail('external-option-unsupported', 400)
    return profile.protocol === 'elevenlabs' ? { text, model_id: selection.model, voice_settings: { speed: 1 } }
      : { text, reference_id: selection.voice, format, sample_rate: format === 'pcm' ? 24000 : 44100, ...(format === 'mp3' ? { mp3_bitrate: 128 } : {}) }
  }
  if (profile.protocol === 'siliconflow') return {
    model: selection.model, voice: selection.voice, input: selection.speechInstruction ? `${selection.speechInstruction}<|endofprompt|>${text}` : text,
    response_format: format, sample_rate: format === 'pcm' ? 24000 : 44100, stream: streaming,
  }
  if (profile.protocol === 'openai') return {
    model: selection.model, voice: selection.voice, input: text, response_format: format,
    ...(selection.speechInstruction ? { instructions: selection.speechInstruction } : {}),
  }
  return {
    model: selection.model, text, stream: streaming,
    ...(profile.protocol === 'minimax' ? { output_format: 'hex', language_boost: 'auto' } : {}),
    voice_setting: { voice_id: selection.voice, speed: 1, vol: 1, pitch: 0,
      ...(selection.speechInstruction ? { emotion: selection.speechInstruction } : {}) },
    audio_setting: { format, sample_rate: 24000, channel: 1, ...(format === 'mp3' ? { bitrate: 128000 } : {}) },
    ...(streaming ? { stream_options: { exclude_aggregated_audio: true } } : {}),
  }
}

function speechResource(profile, selection, format, streaming) {
  if (profile.protocol === 'elevenlabs') {
    if (!/^[a-zA-Z0-9_-]{1,200}$/u.test(selection.voice)) return fail('external-selection-invalid', 400)
    return `text-to-speech/${selection.voice}${streaming ? '/stream' : ''}?output_format=${format === 'pcm' ? 'pcm_24000' : 'mp3_44100_128'}`
  }
  if (profile.protocol === 'fish') return 'tts'
  return BINARY_PROTOCOLS.has(profile.protocol) ? 'audio/speech' : 't2a_v2'
}

function speechHeaders(profile, selection) { return profile.protocol === 'fish' ? { model: selection.model } : {} }

export async function synthesize(profile, { text, format, signal, ...overrides }, transport = fetch) {
  const selection = { ...profile.selection, ...overrides }
  if (profile.protocol === 'custom') return synthesizeCustom(profile, { text, format, signal, ...overrides }, transport)
  if (profile.protocol === 'tencent') return tencentSynthesize(profile, { text, format, signal }, selection, transport)
  if (profile.protocol === 'aliyun') {
    if (!['wav', 'mp3'].includes(format)) return fail('audio-format-unsupported', 400)
    const parts = []
    for await (const chunk of aliyunAudio(profile, { text, signal }, selection, format === 'wav' ? 'pcm' : 'mp3', transport)) parts.push(chunk)
    signal.throwIfAborted()
    const data = Buffer.concat(parts)
    return { data: format === 'wav' ? pcmWav(data) : data, format }
  }
  if (profile.protocol === 'xiaomi') {
    if (!['wav', 'mp3'].includes(format)) return fail('audio-format-unsupported', 400)
    return synthesizeXiaomi(profile, text, format, selection, signal, transport)
  }
  if (profile.protocol === 'breeze') {
    if (!['wav', 'mp3'].includes(format)) return fail('audio-format-unsupported', 400)
    return synthesizeBreeze(profile, text, format, selection, signal, transport)
  }
  if (profile.protocol === 'doubao') {
    if (!['wav', 'mp3'].includes(format)) return fail('audio-format-unsupported', 400)
    return synthesizeDoubao(profile, text, format, selection, signal)
  }
  // PCM avoids upstream WAV variants and guarantees the host's required PCM WAV format.
  const upstream = format === 'wav' ? 'pcm' : 'mp3'
  const binary = BINARY_PROTOCOLS.has(profile.protocol)
  const response = await request(profile, speechResource(profile, selection, upstream, false), payload(profile, text, upstream, false, selection), signal, transport, { headers: speechHeaders(profile, selection) })
  const bytes = await boundedBody(response, signal, binary ? MAX_AUDIO : MAX_AUDIO * 2 + 65536)
  const parsed = binary ? null : checkedJson(bytes)
  if (parsed) checkAudioInfo(parsed, upstream)
  if (binary && response.headers.get('content-type')?.includes('json')) return fail('external-response-invalid')
  const data = binary ? bytes : hexAudio(parsed.data?.audio)
  if (binary && upstream === 'pcm' && /audio\/(?:mpeg|mp3|wav|wave|ogg|flac)/iu.test(response.headers.get('content-type') ?? '')) return fail('invalid-audio-format')
  signal.throwIfAborted()
  return { data: format === 'wav' ? pcmWav(checkPcm(data)) : data, format }
}

/** Parses complete SSE records across arbitrary byte boundaries, with bounded buffering. */
export async function* streamPcm(profile, { text, signal, ...overrides }, transport = fetch) {
  const selection = { ...profile.selection, ...overrides }
  if (profile.protocol === 'custom') { yield* streamCustom(profile, { text, signal, ...overrides }, transport); return }
  if (profile.protocol === 'tencent') return fail('external-streaming-unsupported', 400)
  if (profile.protocol === 'aliyun') { yield* aliyunAudio(profile, { text, signal }, selection, 'pcm', transport); return }
  if (profile.protocol === 'xiaomi') { yield* streamXiaomi(profile, text, selection, signal, transport); return }
  if (profile.protocol === 'breeze') { yield* streamBreeze(profile, text, selection, signal, transport); return }
  if (profile.protocol === 'doubao') { yield* streamDoubao(profile, text, selection, signal); return }
  const binary = BINARY_PROTOCOLS.has(profile.protocol)
  const response = await request(profile, speechResource(profile, selection, 'pcm', true), payload(profile, text, 'pcm', true, selection), signal, transport, { headers: speechHeaders(profile, selection) })
  const reader = response.body?.getReader()
  if (!reader) return fail('external-response-invalid')
  const decoder = new TextDecoder()
  let pending = '', fragments = [], fragmentLength = 0, size = 0, done = false, prefix = Buffer.alloc(0), checked = false
  try {
    if (binary && response.headers.get('content-type')?.includes('json')) return fail('external-response-invalid')
    if (binary && /audio\/(?:mpeg|mp3|wav|wave|ogg|flac)/iu.test(response.headers.get('content-type') ?? '')) return fail('invalid-audio-format')
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (binary) {
        if (chunk.done) break
        size += chunk.value.length
        if (size > MAX_AUDIO) return fail('audio-too-large', 413)
        if (!checked) {
          prefix = Buffer.concat([prefix, chunk.value])
          if (prefix.length < 4) continue
          checked = true
          const first = prefix
          prefix = Buffer.alloc(0)
          yield checkPcm(first)
        } else yield chunk.value
        continue
      }
      pending += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true })
      let boundary
      while ((boundary = /\r?\n\r?\n/u.exec(pending)) !== null) {
        signal.throwIfAborted()
        if (fragmentLength + boundary.index > 2 * 1024 * 1024) return fail('stream-buffer-limit', 413)
        const record = fragments.join('') + pending.slice(0, boundary.index)
        fragments = []; fragmentLength = 0
        pending = pending.slice(boundary.index + boundary[0].length)
        const data = record.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!data || data === '[DONE]') continue
        if (done) return fail('external-response-invalid')
        const event = checkedJson(Buffer.from(data))
        checkAudioInfo(event, 'pcm')
        if (event.data?.audio) {
          const bytes = hexAudio(event.data.audio)
          size += bytes.length
          if (size > MAX_AUDIO) return fail('audio-too-large', 413)
          yield bytes
        }
        if (event.data?.status === 2) done = true
      }
      if (pending.length > 3) {
        fragments.push(pending.slice(0, -3))
        fragmentLength += pending.length - 3
        pending = pending.slice(-3)
      }
      if (fragmentLength + pending.length > 2 * 1024 * 1024 + 3) return fail('stream-buffer-limit', 413)
      if (chunk.done) break
    }
    signal.throwIfAborted()
    if (binary && !checked && prefix.length) yield checkPcm(prefix)
    if (!size || size % 2 || (!binary && (!done || (fragments.join('') + pending).trim()))) return fail('external-stream-incomplete')
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

async function catalogJson(profile, resource, signal, transport, version = 'v1') {
  return checkedJson(await boundedBody(await request(profile, resource, undefined, signal, transport, { version }), signal, 2 * 1024 * 1024))
}

function catalogRows(rows, idKey, nameKey) {
  return rows.filter(row => typeof row?.[idKey] === 'string' && row[idKey].trim() && row[idKey].length <= 200)
    .map(row => ({ id: row[idKey].trim(), name: (typeof row[nameKey] === 'string' && row[nameKey].trim() ? row[nameKey].trim() : row[idKey]).slice(0, 200) }))
}

/** Bound account catalogs and follow only locally constructed pagination URLs. */
async function accountVoices(profile, signal, transport) {
  const voices = new Map(), tokens = new Set()
  let token = ''
  for (let page = 1; page <= 40; page++) {
    signal.throwIfAborted()
    const eleven = profile.protocol === 'elevenlabs'
    const query = eleven ? new URLSearchParams({ page_size: '100', ...(token ? { next_page_token: token } : {}) })
      : new URLSearchParams({ page_size: '100', page_number: String(page), self: 'true' })
    const result = await catalogJson(profile, `${eleven ? 'voices' : 'model'}?${query}`, signal, transport, eleven ? 'v2' : '')
    const rows = eleven ? result.voices : result.items
    if (!Array.isArray(rows)) return fail('external-response-invalid')
    const previousSize = voices.size
    for (const voice of catalogRows(rows, eleven ? 'voice_id' : '_id', eleven ? 'name' : 'title')) voices.set(voice.id, voice)
    if (voices.size > 2000) return fail('external-catalog-limit', 413)
    const more = result.has_more ?? (typeof result.total === 'number' ? page * 100 < result.total : rows.length >= 100)
    if (!more) return [...voices.values()]
    if (!rows.length || (page > 1 && voices.size === previousSize)) return fail('external-response-invalid')
    if (eleven) {
      token = result.next_page_token
      if (typeof token !== 'string' || !token || token.length > 2000 || tokens.has(token)) return fail('external-response-invalid')
      tokens.add(token)
    }
  }
  return fail('external-catalog-limit', 413)
}

function discoveryResult(results, kinds) {
  return { ...Object.fromEntries(results.flatMap((result, index) => result.status === 'fulfilled' ? [[kinds[index], result.value]] : [])),
    connected: results.some(result => result.status === 'fulfilled'),
    errors: results.flatMap((result, index) => result.status === 'rejected' ? [{ kind: kinds[index], code: result.reason instanceof TtsProviderError ? result.reason.code : 'external-upstream-failed' }] : []),
  }
}

export async function discover(profile, transport = fetch, signal = AbortSignal.timeout(20000)) {
  if (profile.protocol === 'aliyun' || profile.protocol === 'tencent' || profile.protocol === 'custom') {
    signal.throwIfAborted()
    // These adapters have no implemented read-only account catalog API. Never
    // report static defaults as an authenticated connection or bill for a probe.
    return { connected: false, errors: [{ kind: 'models', code: 'external-catalog-unavailable' }, { kind: 'voices', code: 'external-catalog-unavailable' }] }
  }
  if (profile.protocol === 'xiaomi' || profile.protocol === 'doubao' || profile.protocol === 'breeze') {
    signal.throwIfAborted()
    // Built-in provider catalogs are fixed presets, not account queries.
    const p = preset(profile.protocol)
    return { models: p.models.map(({ id, name }) => ({ id, name })), voices: p.voices.map(({ id, name }) => ({ id, name })), connected: true, errors: [] }
  }
  if (profile.protocol === 'elevenlabs') {
    const results = await Promise.allSettled([
      catalogJson(profile, 'models', signal, transport).then(rows => {
        if (!Array.isArray(rows)) return fail('external-response-invalid')
        return catalogRows(rows.filter(row => row.can_do_text_to_speech === true), 'model_id', 'name')
      }), accountVoices(profile, signal, transport),
    ])
    return discoveryResult(results, ['models', 'voices'])
  }
  if (profile.protocol === 'fish') {
    const result = discoveryResult(await Promise.allSettled([accountVoices(profile, signal, transport)]), ['voices'])
    // Fish's /model lists voice references, not the model IDs required by its TTS header.
    return { ...result, models: preset('fish').models }
  }
  if (profile.protocol === 'siliconflow') {
    const results = await Promise.allSettled([catalogJson(profile, 'models', signal, transport).then(value => {
      if (!Array.isArray(value.data)) return fail('external-response-invalid')
      return catalogRows(value.data.filter(row => typeof row?.id === 'string' && /tts|speech-|cosyvoice|moss-ttsd/iu.test(row.id)), 'id', 'name')
    })])
    return discoveryResult(results, ['models'])
  }
  const jobs = [request(profile, `models${profile.protocol === 'senseaudio' ? '?mode=tts' : ''}`, undefined, signal, transport)
    .then(response => boundedBody(response, signal, 2 * 1024 * 1024)).then(checkedJson).then(value => {
      if (!Array.isArray(value.data)) return fail('external-response-invalid')
      return value.data.filter(item => typeof item.id === 'string' && (profile.protocol === 'senseaudio' ? item.mode === 'tts' : /tts|speech-/iu.test(item.id)))
        .map(item => ({ id: item.id, name: item.display_name || item.id }))
    })]
  if (profile.protocol !== 'openai') jobs.push(request(profile, 'get_voice', { voice_type: 'all' }, signal, transport)
    .then(response => boundedBody(response, signal, 2 * 1024 * 1024)).then(checkedJson).then(value => {
      if (!['system_voice', 'voice_cloning', 'voice_generation'].some(key => Array.isArray(value[key]))) return fail('external-response-invalid')
      return ['system_voice', 'voice_cloning', 'voice_generation'].flatMap(key => value[key] ?? []).filter(item => typeof item.voice_id === 'string')
        .map(item => ({ id: item.voice_id, name: item.voice_name || item.voice_id }))
    }))
  const results = await Promise.allSettled(jobs)
  return discoveryResult(results, ['models', 'voices'])
}
