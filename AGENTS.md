# 供应商适配器

This is an independent DSH Web plugin, `dsh-speech-provider-adapter`.

- `index.mjs` owns service registration and same-origin management routes.
- `protocols.mjs` dispatches SenseAudio, OpenAI-compatible Speech, MiniMax, SiliconFlow, ElevenLabs, Fish Audio, Alibaba Cloud Bailian, and Tencent Cloud adapters. `cloud-providers.mjs` handles Bailian SSE and Tencent TC3 signing. Keep each provider's auth, PCM sample rate, endpoint versions, and model/voice catalog meanings explicit.
- `custom-provider.mjs` implements the fully custom local-model protocol: bounded JSON request-body templates, custom headers, response audio extraction (binary / JSON base64 / JSON hex), and PCM/WAV/MP3 handling. Keep templates and headers validated (placeholder allowlist, 64 KB template, 32 MB audio) and never eval templates.
- `local-probe.mjs` scans loopback HTTP ports server-side for the custom protocol's “probe local ports” action. Keep it loopback-only, bounded, and status-based (an open port never implies valid credentials or a working recipe).
- `.github/workflows/release.yml` publishes on `v*` tags via npm Trusted Publishing (OIDC, no token). `tools/scripts/release-metadata.mjs` verifies the tag and derives the `next`/`latest` channel; `release-check.mjs` is the dependency-free (syntax/JSON) release gate. Run full `pnpm test` locally.
- `store.mjs` owns profile-local persistence, revisions, catalog validation, and key masking.
- `client.js` mounts `ui/` inside the host's `plugins.bundle.config` settings slot.
- `ui/api.js` is the shared JSON management transport: browser writes carry the same-origin `Origin`, while Desktop forwards validated requests without origin metadata, so writes also send `x-dsh-speech-adapter: 1` and the host accepts origin-less writes only with that header.
- `ui/components.js` owns native DOM tabs and searchable choice popovers. shadcn/ui is a design reference only; keep the page in plain HTML/CSS/JavaScript without shadcn, Tailwind, or framework dependencies and without a frontend build step.
- `locale/` contains Chinese and English UI strings; `usage.md` documents configuration and installation.
- `doc/sense.md` is the supplied protocol reference; `test/` contains adapter behavior tests.

Use Node.js 24.9+ and pnpm. No compile step is required. Run `pnpm test` for protocol, persistence, lifecycle, and management-route coverage. Do not run tests or browser verification when the user has reserved verification for themselves.

Use two-space indentation, single quotes, and omitted semicolons. Import only the public `dsh-xiaomi-tts/host-api` contract; do not import host plugin internals or fall back to checkout-relative source paths. The local development dependency links to the sibling 音色工坊 checkout; runtime installations must provide the updated `dsh-xiaomi-tts` peer.

Keep credentials in the profile-local store and out of logs, public state, error responses, and commits. Preserve AbortSignal propagation, bounded responses, revision checks, same-origin validation, and context-scoped cleanup. Keep browser UI strings in both locales. Tests must cover observable behavior, not source spelling or presentation details.
