# 供应商适配器

`dsh-speech-provider-adapter` 为 DSH Web 的[音色工坊](https://github.com/ppy-web/dsh-plugin-xiaomi-mimo-tts)接入第三方语音合成服务。

## 安装

需要 Node.js 24.9+ 和 DSH Web：

```powershell
dsh plugin --profile web add dsh-xiaomi-tts@latest
dsh plugin --profile web add dsh-speech-provider-adapter@latest
```

在插件管理中启用适配器，添加供应商、填写密钥并启用接管。详细配置和支持的供应商见 [使用说明](usage.md)。预设基于公开文档，实际可用性以供应商服务和账号权限为准。

![供应商适配器设置页](docs/images/settings.png)

## 反馈与许可

欢迎提交 [Issue](https://github.com/ppy-web/dsh-speech-provider-adapter/issues) 或 [Pull Request](https://github.com/ppy-web/dsh-speech-provider-adapter/pulls)。请勿提交密钥。项目采用 [MIT 许可证](LICENSE)。
