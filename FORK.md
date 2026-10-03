# Kotomimi（ことみみ）

Kotomimi 是 Sokuji 的一个分支：在实时翻译之外，加上了自建模型的自由搭配和学语言用的辅助功能。名字取自"言葉"（话语）和"耳"（耳朵）。

基于上游 [kizuna-ai-lab/sokuji](https://github.com/kizuna-ai-lab/sokuji) v0.42.2（`6cbdf9e`）。上游的说明见 [README.md](README.md)，这份文件只讲本分支多出来的东西。

本分支的工作在 `localai` 分支上，`main` 保持与上游一致。

Kotomimi 是独立的应用：有自己的名字、安装目录和设置目录，可以和官方 Sokuji 同时安装、同时运行。第一次启动时会把已有的 Sokuji 设置和登录状态复制过来；下载过的模型不复制，需要时重新下载。

## 这个分支加了什么

| 功能 | 说明 | 主要代码 |
|---|---|---|
| LocalAI Realtime 提供商 | 桌面版直接用 GA Realtime 协议连局域网里的 LocalAI，不需要中间代理 | `src/providers/openai/localai.ts` |
| 环节自由搭配 | 识别、翻译、语法反馈三个环节各自指定服务器和模型 | `src/providers/openai/pipeline.ts`、`textModel.ts` |
| 语法反馈 | 自己说对方语言时，不翻译，而是检查语法：没问题回 ✓，有问题给出改正句和原因。提示词按语言自动选择，也可以自己写 | 同上，`coachPrompt.ts` |
| 打字查词 | 会话中按 Ctrl+K，输入母语，得到对方语言的译文 | `src/components/MainPanel/panel/TypedText.tsx` |
| 假名注音 | 日语汉字上方显示平假名 | `src/lib/annotate/`、`src/components/Annotated/` |
| 罗马音 | 日语、韩语、俄语文本下方显示拉丁字母注音 | 同上 |

注音在本机用词典和规则算出来，不调用任何模型，也不联网。

## 环节怎么搭配

一条翻译链路有三个环节，每个环节可以放在不同的机器上：

```
麦克风 / 系统声音
      │
      ▼
 ① 识别（Realtime 服务器：断句 + 语音转文字）
      │  原文
      ▼
 ② 翻译  ── 或 ──  ③ 语法反馈
      │
      ▼
   字幕（按语言加注音）
```

- **① 识别**：必须是一台支持 GA Realtime 协议的服务器。在"服务器地址"里填它。识别用哪个模型在"用户转录模型"里选，默认用服务器管线自带的。

每个下拉菜单只列出能做这件事的模型：会话模型只列管线，识别只列识别模型，翻译和语法只列文本模型。分类来自 LocalAI 的 `/v1/models/capabilities`。服务器没有这个接口时不做过滤，所有模型都会列出。文本模型填了别的服务地址时，列的是那台服务器自己的模型。
- **② 翻译**有两种做法，在"翻译"一栏里选：
  - **服务器自带的管线**：识别和翻译都在 Realtime 会话里完成，一台机器全包。
  - **文本模型**：服务器只做识别，翻译交给任何支持 OpenAI 聊天接口（`/v1/chat/completions`）的服务。地址留空表示同一台服务器，也可以填别的机器、本机的 Ollama / LM Studio，或云端 API。
- **③ 语法反馈**：勾选"我自己说对方的语言"后，"我"这一路的语音不再翻译，而是交给一个文本模型检查。它可以有自己的地址和模型，留空则复用翻译用的文本模型。"对方"那一路不受影响，照常翻译。

**语法反馈的提示词**按两种语言自动生成：

- 你的母语决定提示词本身用什么语言写。目前有中文和英文两套，其他母语用英文那套，但仍会要求模型用你的母语解释。
- 你在练的语言决定检查重点和例句。日语、韩语、英语、俄语、法语、德语、西班牙语有各自的检查重点；日语、英语、韩语带例句。
- 例句作为对话的前几轮发给模型，而不是写在提示词正文里。小模型看到正文里的例句会接着往下编。
- 想自己写就填"语法反馈提示词"。里面的 `{{SPOKEN}}` 和 `{{NATIVE}}` 会被替换成两种语言的名字。自己写的提示词不附带例句。

用真实模型比较提示词和模型的效果：

```bash
COACH_LIVE_BASE=http://<host>:8080/v1 COACH_LIVE_MODELS=qwen3-4b npx vitest run --silent=false --reporter=verbose src/providers/openai/coachPrompt.live.test.ts
```

它会打印每句话的判断是否正确、解释是不是用母语写的、每句耗时。

日志面板里每次调用文本模型都会记一行 `text.done`，带 `firstMs`（首字耗时）和 `totalMs`（总耗时），可以用来对比不同搭配的速度。

几种搭配示例（地址仅为示意）：

| 目标 | 服务器地址 | 翻译 | 语法反馈 |
|---|---|---|---|
| 全部交给 Mac | `mac:8080` | 服务器管线 | 关 |
| Mac 识别，Mac 上换一个翻译模型 | `mac:8080` | 文本模型，地址留空，模型 `hy-mt2-1.8b` | 关 |
| Mac 识别，本机翻译 | `mac:8080` | 文本模型，`http://localhost:11434/v1` | 关 |
| Mac 识别和翻译，云端查语法 | `mac:8080` | 服务器管线（并填一个文本模型供打字查词） | 开，`https://api.openai.com/v1` + 密钥 |

限制：

- 识别环节目前只支持 Realtime 协议的服务器。普通的 `/v1/audio/transcriptions` 接口还不能作为识别来源。
- 只输出文本，不合成语音。
- 文本模型由应用的渲染进程直接请求，所以对方服务必须允许跨域（CORS）。LocalAI 和 Ollama 默认允许；LM Studio 需要在服务器设置里打开 CORS。
- 语法反馈的质量取决于模型。实测 4B 级别的本地模型能发现时态错误，但解释经常不按要求用母语写，建议用更强的模型。

## 给服务器一侧（Mac）的约定

客户端对 Realtime 服务器的依赖只有下面这些。服务器一侧改动时，保证这些不变，客户端就不需要跟着改。

**握手**

- `ws://<host>:<port>/v1/realtime?model=<模型名>`，不带任何子协议，不带密钥。
- 服务器先发 `session.created`，客户端回 `session.update`，服务器回 `session.updated` 后会话才算开始。30 秒内没等到就判失败。

**会话类型**

- 翻译走服务器管线时：`session.type = "realtime"`，`output_modalities = ["text"]`，带 `instructions`、`audio.input.turn_detection`、`audio.input.transcription`、`audio.input.noise_reduction = null`、`tool_choice = "none"`、`tools = []`、`max_output_tokens`。
- 翻译走文本模型或开了语法反馈时：`session.type = "transcription"`，只带 `audio.input.{turn_detection, transcription, noise_reduction}`。**这种会话里服务器不能自己生成回答。**
- `audio.input.transcription` 里客户端总是带 `language`（两位语言码），`model` 只在用户另选了识别模型时才带。
- 手动模式（按住说话）下 `turn_detection = null`，客户端松开时发 `input_audio_buffer.commit`，之后**不发** `response.create`：服务器要在转写完成后自己回答（管线会话），或只给转写（转写会话）。

**客户端读取的事件**

| 事件 | 用途 |
|---|---|
| `input_audio_buffer.committed` | 一段语音结束，开一条原文 |
| `conversation.item.input_audio_transcription.delta` / `.completed` | 原文内容 |
| `response.created`、`response.output_item.added` | 一次回答开始 |
| `response.output_text.delta` / `.done` | 译文内容 |
| `response.output_item.done`、`response.done` | 回答结束。**`response.done` 必须发**，否则这一路会一直显示忙碌 |
| `error` | 记入日志；会话不中断 |

音频上行是 `input_audio_buffer.append`，24 kHz 单声道 PCM16，base64。

**文本模型接口**

- `POST <base>/chat/completions`，`{model, stream: true, messages: [system, user]}`，按 SSE 流式返回；不流式也能读。
- `GET <base>/models` 用于校验和列出模型。
- `GET <base>/models/capabilities`（可选，LocalAI 自带）用于给模型分类：`capabilities` 含 `transcript` 的是识别模型，含 `chat` 或 `completion` 的是文本模型，为空的是管线，其他的（`vad`、`tts`）不出现在任何下拉里。
- 回答里的 `<think>…</think>` 会被客户端去掉。

**实测到的 LocalAI 行为（2026-10-02）**

这些是客户端已经绕开的地方。如果服务器一侧修掉了，可以提 issue，客户端可以去掉对应的处理。

- 握手不回子协议，所以客户端不带子协议。
- `turn_detection.create_response = false` 被忽略，所以"只识别"用的是转写会话。
- 带外的 `response.create`（`conversation: "none"`）会被当成真实对话回答，所以客户端不发它。
- 手动提交后立刻收到 `response.create` 会取消正在进行的转写。
- 手动模式下，转写事件用的 `item_id` 和 `input_audio_buffer.committed` 的不一样。
- 请求语音输出时会报错，并且不发 `response.done`。
- `apple-speech-transcriber` 不给 `language` 会报错，所以源语言不能选"自动检测"。
- **换识别模型只在管线会话里有效（2026-10-03）。** `session.type = "realtime"` 时，`audio.input.transcription.model` 填 `whisper-large-turbo`、`sensevoice-small-mlx` 都能正常识别，首次使用要加载 12 到 20 秒。`session.type = "transcription"` 时，除默认的 `apple-speech-transcriber` 外都被拒绝：`Failed to update session: model is not a valid pipeline model`。所以"服务器只识别、翻译交给文本模型"的搭配目前换不了识别模型：客户端在这种会话里不发识别模型名，界面上也把下拉禁用并说明原因。这一条需要服务器一侧解决，解决后客户端去掉这个限制即可（`localai.ts` 的 `transcriptionFor`）。
- `parakeet-cpp-nemotron-3.5-asr-streaming-0.6b` 的转写结果带 `<en-US>` 这样的语言标记，会进入原文，也会干扰管线里的翻译。

## 两台机器之间怎么协作

- 服务器一侧的改动、发现的问题、对客户端的要求：在本仓库开 issue，或直接改这份文件的"给服务器一侧的约定"一节并提 PR。
- 客户端一侧每次改动都会更新这份文件，所以看这份文件的提交记录就能知道约定有没有变。
- 两边都可以用下面的实机测试来确认对方的改动没有破坏约定。

## 实机测试

不设环境变量时这些测试会跳过，普通测试不会连任何服务器。

```bash
LOCALAI_LIVE=<host>:8080 \
LOCALAI_LIVE_WAV=speech.wav \
LOCALAI_LIVE_TEXT_MODEL=hy-mt2-1.8b \
LOCALAI_LIVE_JA_WAV=speech-ja.wav \
LOCALAI_LIVE_COACH_MODEL=qwen3-4b \
npx vitest run src/providers/openai/localai.live.test.ts
```

WAV 要求 24 kHz、单声道、PCM16，几秒钟的语音即可。各变量的含义写在测试文件开头。

## 构建

```bash
npm ci
npm run build
npm run build:audio-host   # Windows 需要 VS Build Tools 的 C++ 组件
npx electron-forge make --arch=x64
```

- Windows 上仓库路径不能太深，否则安装包工具会因为路径超过 260 字符失败。放在类似 `C:\src\sokuji` 的短路径下。也不要直接放在盘符根目录（例如用 `subst` 映射出来的 `S:\`），那样打包时会漏掉文件。
- `npm ci` 如果加了 `--ignore-scripts`，需要手动补三步：`node node_modules/electron/install.js`、`bash scripts/copy-ort-wasm.sh`、在 `node_modules/electron-winstaller` 里运行 `node script/select-7z-arch.js`。
- 安装包没有代码签名。

## 名字和图标

- 名字集中在几处：`forge.config.js`（安装目录、可执行文件名、应用 ID）、`package.json` 的 `productName`、`electron/main.js` 的 `app.setName`（设置目录）。
- 界面文字不改语言包。上游的语言包里写的是 Sokuji，由 `src/lib/brand.ts` 在显示时替换成 Kotomimi。虚拟音频设备的名字保持 Sokuji 不变，因为设备确实还叫那个名字。
- 图标由一张图生成全套：

```bash
node scripts/fork-make-icons.cjs assets/logo-source.png --keep-background
```

  原图已经是透明背景时加 `--keep-background`。原图是白底时不加，脚本会从四边把背景去掉。
- "关于"里保留了对 Sokuji 和 Kizuna AI Lab 的署名。

## 版本号和更新

- 版本号是"上游版本 + 两位分支序号"：上游 0.42.2 的第 1 个分支构建是 `0.42.201`，现在是 `0.42.202`。每次要让别人覆盖安装的构建都要加一，否则安装程序会认为已经装过。五处版本号要一起改：`package.json`、`extension/package.json`、`extension/manifest.json` 和两个 lockfile。
- 更新源指向本仓库的 Releases，不再指向上游，所以不会被提示换回官方版。
- 启动时不自动检查更新，因为本仓库还没有发布过 Release，检查会报错。"帮助"里的"检查更新"仍然可用。
- 上游的发布流程（`.github/workflows/build.yml`）在分支仓库里跑不通：Windows 签名那一步只在上游仓库执行，而发布步骤依赖它。要用 GitHub Actions 给本仓库出安装包，需要先改这个流程。

## 跟进上游

本分支对上游文件的改动很少，绝大部分是新增文件。上游发新版后：

```bash
git fetch upstream
git rebase upstream/main          # 在 localai 分支上
node scripts/fork-localai-locales.cjs   # 语言包冲突时：先取上游版本，再跑这一行
npx vitest run src/providers src/lib/annotate src/components/Annotated
```

改动过的上游文件：

| 文件 | 改了什么 |
|---|---|
| `src/providers/openai/{adapter,config,wire,settings}.ts` | 给适配器加了几个开关：自定义地址、无密钥时不带子协议、关闭锚点、手动提交不催答、转写会话 |
| `src/providers/registry.ts` | 注册新提供商 |
| `src/lib/session/storedSettings.ts` | 新提供商的存储键 |
| `src/components/Conversation/ConversationList.tsx`、`src/components/Subtitle/SubtitleBands.tsx` | 文本渲染处接入注音 |
| `src/components/Display/DisplaySettingsPopover.tsx` | 显示设置里加两个注音开关 |
| `src/components/MainPanel/panel/TypedText.tsx` | Ctrl+K 聚焦输入框 |
| `src/components/TitleBar/TitleBar.tsx`、`src/components/Subtitle/SubtitleBar.tsx`、`index.html`、`shared/index.html` | 显示的名字和标题栏图标 |
| `src/locales/index.ts` | 注册名字替换 |
| `electron/main.js` | 应用名、设置迁移、"关于"、启动时不查更新 |
| `electron/update-manager.js`、`electron/update-payload.js` | 更新源和安装包文件名 |
| `forge.config.js` | 应用身份 |
| `assets/icon.*`、`public/favicon.ico`、`public/logo*.png` | 图标 |
| `src/routes/Home.tsx` | 启动时读取注音开关 |
| `src/providers/registry.test.ts`、`src/providers/palabraai/provider.test.ts` | 跟着提供商列表更新的断言 |
| `src/locales/*/translation.json` | 由脚本生成的文字 |
| `package.json` | 三个依赖：`@sglkc/kuromoji`、`wanakana`、`es-hangul` |

## 许可

与上游相同，AGPL-3.0。日语词典来自 kuromoji 附带的 IPADIC，许可见 `node_modules/@sglkc/kuromoji/NOTICE.md`。
