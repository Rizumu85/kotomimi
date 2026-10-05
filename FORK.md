# Kotomimi（ことみみ）

Kotomimi 是 Sokuji 的一个分支：在实时翻译之外，加上了自建模型的自由搭配和学语言用的辅助功能。名字取自"言葉"（话语）和"耳"（耳朵）。

基于上游 [kizuna-ai-lab/sokuji](https://github.com/kizuna-ai-lab/sokuji) v0.42.3（`d2f8001`）。上游的说明见 [README.md](README.md)，这份文件只讲本分支多出来的东西。

仓库：<https://github.com/Rizumu85/kotomimi>。本分支的工作在 `localai` 分支上，`main` 保持与上游一致。

Kotomimi 是独立的应用：有自己的名字、安装目录和设置目录，可以和官方 Sokuji 同时安装、同时运行。第一次启动时会把已有的 Sokuji 设置和登录状态复制过来；下载过的模型不复制，需要时重新下载。

## 这个分支加了什么

| 功能 | 说明 | 主要代码 |
|---|---|---|
| Kotomimi 自由搭配（提供商） | 识别、翻译、语法反馈三个环节，各自选在哪里运行：局域网里的另一台设备、任意 API 模型、或这台电脑。排在提供商列表第一个，带"推荐" | `src/providers/openai/localai.ts`、`pipeline.ts`、`LocalAIAssist.tsx` |
| 这台电脑的内置模型 | 识别、翻译和语法反馈都可以用应用自己下载的模型，全部在本机完成，不需要服务器 | `localaiDevice.ts`、`LocalAIEngine.tsx` |
| 共享给其他设备 | 把这台电脑的模型共享给局域网里的另一台 Kotomimi；这台电脑上装了 LocalAI 时，它的模型也从同一个开关、同一个地址共享出去 | `electron/lan-server.js`、`electron/lan-upstream.js`、`src/lib/lan/` |
| 自动找到另一台设备 | 选「用另一台设备」时，应用自己搜索局域网，把找到的 Kotomimi 和模型服务器列出来，点一下就连上，不用知道地址 | `electron/lan-discover.js`、`src/components/LanSharing/ServerFinder.tsx` |
| 这台电脑上的 LocalAI | 电脑上装了 LocalAI 时，由应用启动和停止它，显示状态和模型 | `electron/local-server.js`、`src/components/LanSharing/LocalServerCard.tsx` |
| 自定义模型 | 从 Hugging Face 添加模型库里没有的 Whisper 模型 | `src/lib/local-inference/customModels.ts` |
| 语法反馈 | 自己说对方语言时，不翻译，而是检查语法：没问题回 ✓，有问题给出改正句和原因。提示词按语言自动选择，也可以自己写 | `coachPrompt.ts` |
| 打字查词 | 会话中按 Ctrl+K，输入母语，得到对方语言的译文 | `src/components/MainPanel/panel/TypedText.tsx` |
| 假名注音、罗马音、原文斜体 | 日语汉字上方显示平假名；日语、韩语、俄语下方显示拉丁字母注音；原文要不要用斜体（默认斜体，和上游一样；汉字和假名的斜体是浏览器硬倾斜出来的，可以关掉）。三个开关都在显示设置弹窗底部 | `src/lib/annotate/`、`src/components/Annotated/` |
| 字体 | 界面、拉丁字母、罗马音、各语言的正文和注音，分别选字体 | `src/lib/fonts/`、`src/components/Fonts/` |
| 设置向导和引导 | 向导只有四步：界面语言、用途、语言、完成。上游的"选服务提供商"和本分支加过的"由哪台设备来运行"两步不再显示（`setupDraft.ts` 的 `KOTOMIMI_HIDDEN_STEPS`）：新用户还没见过这些东西就要做选择，选错会走进另一个产品（要注册账号，或者换了一套引擎），而这两项在设置里随时能改。经过这两步时直接替用户答好：用 Kotomimi 自己的提供商，三个环节都放在这台电脑。重新运行向导时，已保存的提供商和各环节的去处保持不变。两步的组件和它们的测试还留在代码里（测试用 `setHiddenSetupSteps([])` 把它们显示回来）。引导会介绍上面这些功能 | `src/components/SetupWizard/steps/StepKotomimi.tsx`、`src/components/Tour/steps.ts` |

注音在本机用词典和规则算出来，不调用任何模型，也不联网。

## 环节怎么搭配

一条翻译链路有三个环节，每个环节都可以放在三个地方之一，互不牵连：

```
麦克风 / 系统声音
      │
      ▼
 ① 语音识别（断句 + 语音转文字）：另一台设备 │ API 模型 │ 这台电脑
      │  原文
      ▼
 ② 翻译：另一台设备 │ API 模型 │ 这台电脑     ── 或 ──     ③ 语法反馈：另一台设备 │ API 模型 │ 这台电脑
      │
      ▼
   字幕（按语言加注音、按语言选字体）
```

提供商下面，每个环节一张卡片（`LocalAIAssist.tsx`）。卡片里先是三个位置的切换，紧接着就是这个位置需要的东西：模型，API 的地址和密钥，或这台电脑的模型库。一个环节的所有设置都在它自己的卡片里，简单布局和高级布局画的是同一组卡片。卡片下面有一行字说明现在能不能开始，旁边可以手动重新检查。

卡片上方是"另一台设备"：应用搜索局域网（见下文"怎么找到另一台设备"），点一下就填好地址；也可以手填地址和访问密钥。它对三个环节是同一台设备，所以只问一次。没有任何环节放在另一台设备上时，这一块只留一句说明和搜索按钮。

- **① 语音识别**
  - **另一台设备**：一台支持 GA Realtime 协议的服务器（另一台开启了共享的 Kotomimi，或 LocalAI）。模型默认由那台设备决定，也可以从它列出的识别模型里选。"高级"里有实时管线的名字，一般不用改：留空时自动用那台设备的管线，只有它是 LocalAI 并且配了不止一条管线时才需要选。那台设备是 Kotomimi 时，它的识别模型不检测语言，源语言不能是「自动检测」；它没有能识别某一路语言的模型时，开始之前检查就会指出来。直接连 LocalAI 时，翻译或语法反馈另选了模型，识别模型就只能用它默认的（LocalAI 的限制），下拉菜单会变灰；卡片上有一个按钮"改连那台设备的 Kotomimi"，在局域网里找同一台设备上开着共享的 Kotomimi 并把地址换过去，之后就能选。地址连不上时（比如那台设备的 Kotomimi 已经把 LocalAI 收回本机），"另一台设备"区域里也给同一个按钮。
  - **API 模型**：任何提供 OpenAI 转写接口（`POST /v1/audio/transcriptions`）的服务，比如 OpenAI、Groq、LocalAI（`apiAsr.ts`）。断句仍在这台电脑上做，用的是和"这台电脑"同一套 VAD 设置；每句话说完后作为一个 WAV 文件上传，文字在句子结束时才出现，没有逐字更新。源语言可以选"自动检测"。
  - **这台电脑**：用应用下载的识别模型，断句也在本机做。每个要听的语言一行，选用哪个已下载的模型；旁边的"模型库"就在卡片里展开，缺模型时自动展开。断句灵敏度在"VAD 设置"里调。这时不能选"自动检测"作为源语言，因为本机的识别模型不检测语言。本机的识别模型要等一句话结束才出字，两个人不停地说时，一句话只会在"最大语音时长"到了才结束，所以这个值默认是 15 秒（`LOCALAI_MAX_SPEECH_SECONDS`，上游的本机推理是 30 秒）：2026-10-04 用一段真实的双人快速对话实测，30 秒时第一行字要等 30–37 秒，15 秒时约每 15 秒出一行，10 秒时约每 10 秒一行但更容易切在词中间。用户自己调过的值不受影响。「自动」选哪个识别模型，日语按实测来排（`selection/measuredRank.ts`）：Qwen3-ASR 1.7B、Whisper Large V3 Turbo、Voxtral Mini 4B Realtime 依次优先，Granite Speech 4.1 和 SenseVoice int8 排到最后（日语实测不可用，但仍可手选，也仍是没有别的模型时的兜底）。上游目录对所有语言用同一个顺序，日语会先选 Cohere Transcribe，而它在真实对话里漏掉约四分之一的内容。其他语言没测过，顺序不变。
- **② 翻译**
  - **另一台设备**：模型留空时由那台设备决定。识别也在那台设备上时，就是它的管线在同一个 Realtime 会话里完成；对方是 Kotomimi 时，由它按语言对挑最合适的翻译模型；识别不在那台设备上（这台电脑或 API 在听）时，用它列出的第一个能翻译的模型。也可以指定它的某个文本模型或翻译模型，这时那台设备只做转写，译文通过聊天接口另外请求。
  - **API 模型**：任何支持 OpenAI 聊天接口（`/v1/chat/completions`）的服务：云端 API，或这台电脑上的 Ollama / LM Studio。
  - **这台电脑**：用应用下载的翻译模型，每个方向一行。没下载任何翻译模型时会用在线的 Bing 翻译，装好就能用。翻译模型要知道源语言，所以源语言是「自动检测」时检查不通过，会请用户选好语言。
- **③ 语法反馈**：打开"我自己说对方的语言"后，"我"这一路的语音不再翻译，而是交给一个文本模型检查。"对方"那一路不受影响，照常翻译；打字输入的内容仍然由翻译环节翻译。
  - **另一台设备**：它的某个文本模型，留空用它列出的第一个。另一台 Kotomimi 共享的翻译模型不是聊天模型，做不了语法反馈，卡片会直接说明。
  - **API 模型**：自己的地址、模型和密钥。

"API 模型"的三个卡片都先选**服务**（`apiServices.ts`）：OpenAI、Google Gemini、豆包（火山方舟）、DeepSeek、Groq、硅基流动、OpenRouter、这台电脑的 Ollama，或"自定义地址"。语音识别只列出有转写接口的那几个（OpenAI、Groq、硅基流动）。

- 选了服务，地址和"要不要密钥"就定了，这两项不再显示；"自定义地址"就是原来的三个输入框。
- 用的是哪个服务不单独保存，而是从地址读回来（`serviceOf`），所以以前手填过 `https://api.openai.com/v1` 的设置，现在也显示为 OpenAI。
- 模型名不写死在代码里（模型名几个月就过时）。密钥填好、检查通过后，服务会列出它的模型，模型栏空着时自动填一个合适的（`preferredModel`）：文本环节取小而快的那一类里最新的（比如 `gpt-*-mini`、`gemini-*-flash`），语音识别取转写模型。列表里没有合适的（比如豆包要填自己的接入点 ID）就留给用户填。正在输入时不会替用户填。
- 密钥能省则省：另一个环节已经在用同一个服务，就直接用它的密钥；OpenAI 和 Gemini 还会读内置提供商里保存过的密钥（`apiServiceKey.ts`，只读），并在密钥栏下面说明来源。换服务时会清掉原来的密钥，不会把一个服务的密钥发给另一个服务。
- Google 对无效密钥回的是 400 而不是 401，检查时按"密钥被拒绝"处理。
  - **这台电脑**：模型库里的小型对话模型（Qwen 系列，需要 WebGPU），留空用已下载的里最大的那个。它们也是翻译模型，所以翻译和语法反馈选同一个时只加载一次。这类模型只有几百 MB 到 1 GB 多，反馈不如大模型准确，例句也不随提示词发送（本机引擎只接收提示词和一句话）。

每个下拉菜单只列出能做这件事的模型：识别只列识别模型，翻译列文本模型和翻译模型，语法只列文本模型。分类来自那台设备的 `/v1/models/capabilities`。没有这个接口的服务器不做过滤，留空的模型也不会替你猜一个，需要自己选。

高级布局里提供商这一块只画在"提供商"页（引导和各处跳转本来就指向那里），"常规"页不再出现提供商。上游原来两页各画一遍，容易让人问以哪边为准。简单布局只有一页，照旧画在那里。标题栏的"登录"是 Kizuna AI 的账号，只在选了 Kizuna AI 提供商（或已经登录）时显示。

旧版本的设置会自动读成新的样子（`localai.ts` 的 `migratePlaces`）：以前"文本模型、地址留空"就是现在的"另一台设备 + 指定模型"；以前识别在这台电脑时翻译自动落到这台电脑，现在照样读成"这台电脑"；以前语法反馈留空复用翻译的文本模型，现在读成那个模型本身。第一次在卡片里改任何东西时，这些读出来的值会一起存下来。

几种搭配示例（地址仅为示意）：

| 目标 | 识别 | 翻译 | 语法反馈 |
|---|---|---|---|
| 全部交给 Mac | 另一台设备 `mac:8790` | 另一台设备，模型留空 | 关 |
| Mac 识别，Mac 上换一个翻译模型 | 另一台设备 | 另一台设备，模型 `hy-mt2-1.8b` | 关 |
| Mac 识别，本机翻译 | 另一台设备 | 这台电脑 | 关 |
| 本机识别，Mac 翻译 | 这台电脑 | 另一台设备，模型 `hy-mt2-1.8b` | 关 |
| 全部在这台电脑 | 这台电脑 | 这台电脑 | 关 |
| 另一台 Kotomimi 全包 | 另一台设备 `192.168.1.20:8790` | 另一台设备，模型留空 | 关 |
| Mac 识别和翻译，云端查语法 | 另一台设备 | 另一台设备 | 开，API 模型 `https://api.openai.com/v1` + 密钥 |
| 完全离线，还要语法反馈 | 这台电脑 | 这台电脑 | 开，这台电脑（下载一个 Qwen 模型） |

**语法反馈的提示词**按两种语言自动生成：

- 你的母语决定提示词本身用什么语言写。目前有中文和英文两套，其他母语用英文那套，但仍会要求模型用你的母语解释。
- 你在练的语言决定检查重点和例句。日语、韩语、英语、俄语、法语、德语、西班牙语有各自的检查重点；日语、英语、韩语带例句。
- 例句作为对话的前几轮发给模型，而不是写在提示词正文里。小模型看到正文里的例句会接着往下编。
- 想自己写就填"语法反馈提示词"。里面的 `{{SPOKEN}}` 和 `{{NATIVE}}` 会被替换成两种语言的名字。自己写的提示词不附带例句。

日志面板里每次调用文本模型或本机翻译模型都会记一行 `text.done`，带 `firstMs`（首字耗时）和 `totalMs`（总耗时），可以用来对比不同搭配的速度。

限制：

- 只输出文本，不合成语音。
- 文本模型由应用的渲染进程直接请求，所以对方服务必须允许跨域（CORS）。LocalAI 和 Ollama 默认允许；LM Studio 需要在服务器设置里打开 CORS。
- 语法反馈的质量取决于模型。实测 4B 级别的本地模型能发现时态错误，但解释经常不按要求用母语写，建议用更强的模型。这台电脑上的小型对话模型更弱，适合完全离线时凑合用。
- **内置的 SenseVoice 识别日语会丢假名**（实测 2026-10-03："今日は天気がいいので、公園に行きましょう" 被识别成 "日天気公演行"）。识别日语请用 Whisper 系列或下面的自定义模型。中文没有这个问题。

## 自定义模型

"语音识别"选"这台电脑"时，下面有"添加 Hugging Face 上的 Whisper 模型"。填仓库名（例如 `onnx-community/kotoba-whisper-v2.2-ONNX`，一个专门为日语微调的 Whisper），选它识别的语言，添加后它会出现在模型库里，像内置模型一样下载、选择和共享。

- 仓库要是 Transformers.js 用的 ONNX 格式：有 `config.json`、`tokenizer.json` 等配置文件，以及 `onnx/encoder_model*.onnx` 和 `onnx/decoder_model_merged*.onnx`。`onnx-community/…` 和 `Xenova/…` 的 Whisper 仓库大多符合。
- 量化版本按 q4、8 位、全精度的顺序取第一个有的。
- 需要显卡（WebGPU）。
- 实测 `onnx-community/kotoba-whisper-v2.2-ONNX`（698 MB）识别上面那句日语完全正确。
- 翻译和语法想用别的模型，走"API 模型"更合适：用 Ollama 或 LM Studio 加载任意模型，把地址填进去。

## 两个方向：用另一台设备，和共享给其他设备

界面上这是两件相反的事，名字也按方向起：

- **用另一台设备**：这台电脑不出力，环节交给局域网里的另一台。在提供商下面那个环节的卡片里选「另一台设备」。
- **共享给其他设备**：这台电脑出力，别的设备来用它下载好的模型。在"提供商"页最下面打开「共享这台电脑的模型」。

一台开共享，另一台选「用另一台设备」，两边就接上了。

### 自动找到另一台设备

选了「用另一台设备」而还没有地址时（设置向导里总是），应用会搜索局域网（`electron/lan-discover.js`），把找到的设备列出来，点一下就填好地址并立即连接。地址框还在，留给搜索够不到的情况。

- 搜索的做法：向本机所在网段的每个地址，在 8790（Kotomimi 共享的默认端口）和 8080（LocalAI 的默认端口）上发一次 `GET /v1/models`，像模型列表的回答就算找到。只发这一个请求；网段大于 256 个地址时只搜本机地址所在的那 256 个；VPN 和隧道的网段不搜。整个过程大约两秒。
- 开共享的 Kotomimi 在每个回答里带一个 `X-Kotomimi-Name` 头，值是那台电脑的名字（URL 编码），列表里就显示这个名字。它把同一台电脑上 LocalAI 的模型也一起共享时，模型列表的回答还带 `X-Kotomimi-Includes: model-server`，搜索结果里那台电脑就只列一行（它的 Kotomimi），不再单独列出它的 LocalAI。要密钥的设备回 401，仍然会被列出来，标为"需要访问密钥"，选中后密钥框自动出现。
- 别的服务器没有名字时，能认出是 LocalAI（它的 `GET /version` 会回版本号）就显示 LocalAI，否则显示地址。
- 本机上和应用并排运行的服务器（比如同一台 Mac 上的 LocalAI）也会被找到，地址是 `127.0.0.1`。本机自己的共享不会列出来。
- 改过端口的设备搜不到，要手动填地址。

### 共享这台电脑的模型

打开后，这台电脑会在局域网上提供它已下载的识别和翻译模型，另一台设备自己不需要下载任何东西。卡片上会写明这台电脑在对方列表里叫什么名字，以及搜不到时手动填的地址。

- 默认端口 8790。可以设访问密钥；对方在"另一台设备需要访问密钥"里填同一个。
- 应用开着的时候才能共享。开关的状态会记住，下次启动自动恢复。
- Windows 上，每次开始共享都会读一次防火墙（`electron/lan-firewall.js`）：这台电脑所在的网络里只要有一个挡住这个端口，设置里就显示出来，并给一个「允许」按钮。点了以后由 Windows 向用户确认，然后为这个端口加一条规则：专用网络和域网络对任何地址开放；Windows 把当前网络当作「公用网络」时（新连的家用 Wi‑Fi 默认就是），再加一条只对同一网络里的设备开放的规则。读规则不需要权限，也不改任何东西。
- 其他系统不处理：macOS 会自己询问，要允许。
- 共享的是应用自己下载的模型（包括自定义模型），要共享哪个，就在共享区域的模型库里下载哪个；以及这台电脑上 LocalAI 的模型（见下面"LocalAI 的模型一起共享"）。
- 每个连接占用一个识别模型的内存。最多同时 6 个连接。
- **模型只在用的时候占内存**：
  - 没有设备来用时什么都不加载；连接关闭时，那个连接的识别模型立即释放。
  - 对方忘了结束会话：一台设备的所有连接 30 分钟都没有语音时，门会结束这些连接（先发一个 `session_idle` 错误，对方界面上显示"另一台设备结束了这次会话"），模型随之释放。按设备算而不是按连接算，所以"我"在说话时，一直安静的"对方"那一路不会被掐掉。
  - 应用自己的翻译模型 10 分钟没人请求就卸载，下次请求再加载（`translator.ts`）。
  - LocalAI 的模型由它自己的空闲看门狗卸载，也是 10 分钟（见下面"这台电脑上的 LocalAI"）。

### 哪边的设置算数

出力的那台电脑和使用的那台电脑各有一套设置，容易分不清以哪边为准。规则只有两条，共享卡片上也写着：

- **使用的那台设备决定**：语言、用哪个模型、断句的灵敏度。这些随每次请求发过来。
- **出力的这台电脑只决定**：有哪些模型可选（它下载了哪些、它的 LocalAI 里装了哪些），和访问密钥。它自己各环节选在哪里，只管它自己开会话时用，不影响共享。

出力的电脑在共享期间，标题栏会显示"共享中"，有设备在用时显示路数（`ServingBadge.tsx`）。

### 这台电脑上的 LocalAI

有些模型不归应用自己跑：Apple 的语音识别、MLX 模型、GGUF 翻译模型。它们由同一台电脑上的 LocalAI 运行。电脑上装了 LocalAI 时（`~/.localai/bin/local-ai`，或 Homebrew 装的），提供商设置里、共享区域上面会多一节"这台电脑上的 LocalAI"（`electron/local-server.js`、`LocalServerCard.tsx`）。这一节只有一行状态（运行中、几个模型）加启动 / 停止按钮、"打开 Kotomimi 时自动启动"的开关、打开 LocalAI 页面的链接；它是什么、怎么用，收在标题旁的问号里；"别的设备没指定模型时用哪个"折叠着。它不再列出自己的模型：模型在环节卡片里选，共享出去的在共享区域里看。

- **启动和停止**由应用来做，可以设成随应用启动。应用退出时，它启动的 LocalAI 一起停。输出记在应用日志目录的 `localai.log`。
- 启动参数取自 `~/.localai` 下存在的目录（models、backends、data 等）和 `launcher.json` 里的端口（默认 8080）。监听地址固定是 `127.0.0.1`，不用 `launcher.json` 里的主机：LocalAI 不要密钥，开在局域网上等于把模型交给网里任何人，还多出一个和应用共享并列的地址。别的设备只通过应用的共享（一个端口、一把密钥）用到它的模型。每个参数只在这个版本的 LocalAI 自己的帮助里出现时才给，避免旧版本因为不认识的参数起不来。Apple 芯片上会带 `LOCALAI_FORCE_META_BACKEND_CAPABILITY=metal`。
- **空闲的模型自动卸载**：应用启动 LocalAI 时会打开它自带的空闲看门狗（`--enable-watchdog-idle --watchdog-idle-timeout=10m`，同样只在这个版本认识时才给）。一个模型 10 分钟没有请求点到它，就从内存里卸载，下次用到再加载。不开的话，LocalAI 会把每个用过的模型一直留在内存里。
- **别的程序启动的 LocalAI 不碰**：端口上已经有回应时，卡片显示"运行中 · 由其他程序启动"，没有停止按钮。想让应用来管，先退出那个程序。
- **对方没指定模型时用哪个**：LocalAI 的 Realtime 管线把一个识别模型和一个文本模型串在一起。卡片上列出每条管线现在用的这两个，各是一个下拉菜单，选项是这台 LocalAI 里能做这件事的模型。改动通过 LocalAI 自己的接口写回（`PATCH /api/models/config-json/<管线名>`，整段 `pipeline` 一起发），被换下的模型会从内存里卸载，下一次会话生效。应用不认识任何具体的模型：菜单里的名字是从模型 id 生成的（`modelLabel.ts`），所以换一台装了别的模型的 LocalAI 也一样能用。
- 安装和删除模型仍然在 LocalAI 自己的网页里做，卡片上有链接。
- 没装 LocalAI 的电脑看不到这张卡片。

#### 这台电脑自己用它：就在"这台电脑"下面选

整页设置按一个概念组织：**这台电脑的模型 = 应用下载的 + 这台电脑的 LocalAI 里装的**。各环节从里面选，共享就是把同一批借给别的设备。所以这台电脑自己要用 LocalAI 的模型时，不用绕到"另一台设备"：

- 每个环节选"这台电脑"时，模型下拉的最后多一项"LocalAI（这台电脑上的）"。只有这台电脑装了 LocalAI 才有这一项。
- 选了它，这个下拉变成两项（"Kotomimi 下载的模型" / "LocalAI"），正下方多一个下拉，列出 LocalAI 里能做这个环节的模型。语音识别可以留给 LocalAI 的管线决定；翻译和语法反馈必须选一个。
- LocalAI 没在运行时，卡片里提示并给一个"启动 LocalAI"按钮。
- 设置里是每个环节一个字段（`asrHere` / `translateHere` / `coachHere`，值为 `app` 或 `localai`）加选中的模型（`…HereModel`），以及当时的地址和管线名（`hereAddress`、`herePipeline`）。
- **翻译和语法反馈**交给 LocalAI 时，后面的代码把它读成"一个地址上的文本模型、不要密钥"（`localai.ts` 的 `settled`），检查、构建、运行都走 API 模型那条路。
- **语音识别**交给 LocalAI 时，走的是它的 Realtime 套接字（`ws://127.0.0.1:<端口>/v1/realtime`），不是上传接口：实测（2026-10-04）LocalAI 的 `/v1/audio/transcriptions` 只有 Whisper 和 Parakeet 能用，Apple Speech、SenseVoice、Qwen3 都回 `Unimplemented`。转写会话里不能点名识别模型，所以会话开始前先把选中的识别模型写进管线（`PipelineConfig.prepare`，经 `local-server:set-pipeline`），再开套接字（`PipelineConfig.socket`，不带密钥）。断句由 LocalAI 做，"VAD 设置"显示的是 Realtime 那一套。
- 别的环节照样可以放在别处：比如识别用这台电脑的 LocalAI，翻译用另一台设备。文本环节仍然向凭据里的那个地址请求。

"另一台设备"里搜到的"这台电脑上的 LocalAI"（地址 `127.0.0.1`）仍然可以用，效果和以前一样。

#### LocalAI 的模型一起共享

对别的设备来说，一台电脑就是一台电脑：一个开关、一个地址、一个访问密钥。所以共享打开、这台电脑的 LocalAI 又在运行时，共享的门（8790）会把属于 LocalAI 的请求经回环地址转给它（`electron/lan-upstream.js`）：

- **模型列表**：LocalAI 的识别模型和文本模型接在应用自己的模型后面（`owned_by: "localai"`，能力分别是 `transcript` 和 `chat`）。它的管线不列出来，对外只有 `kotomimi` 这一个管线名。
- **聊天请求**：模型名是 LocalAI 的文本模型时，原样转给它（去掉只有 Kotomimi 才读的 `source_language` / `target_language`），回答按原样流式传回。
- **Realtime 套接字**：会话照旧先由应用宣布；对方的第一条 `session.update` 里指定的识别模型如果是 LocalAI 的，这条连接从此接到 LocalAI 自己的会话上。LocalAI 的转写会话不接受指定识别模型，所以先把它写进管线（就是卡片上那个下拉菜单做的事，被换下的模型从内存卸载），再开会话，发过去的 `session.update` 里不带模型名。
- **加载哪个由对方决定**：LocalAI 只在请求点到名时才加载模型，列出来不等于加载。对方在自己的环节卡片里选了哪个，这边才加载哪个；换识别模型时，换下来的那个如果没有别的会话在用，立即卸载；其余用过的模型空闲 10 分钟后卸载（见上）。
- **对方把模型留给这台电脑决定时**：LocalAI 在运行就用它的管线（卡片上"对方没指定模型时用哪个"的那两个）；没有 LocalAI 时才用应用自己下载的模型里最合适的。
- 管线是全局的：两台设备同时指定不同的识别模型时，后来的那个会把管线改掉，但要等先来的会话在 LocalAI 那边配置好（LocalAI 回了 `session.updated`，最多等 30 秒）才改，所以先来的会话用上的是它自己选的模型。被换下的模型只在没有会话还在用它时才立即卸载：会话配置好以后一直用它当时的识别模型，管线再改也不变（2026-10-04 在 Mac 上实测：A 用 Whisper 开着，管线改成 SenseVoice 后 A 仍是 Whisper，新开的 B 是 SenseVoice，两个同时在内存里；这时强行卸载 Whisper，A 不报错，只是下一句多等几秒把它重新加载）。所以共享的门记着每个开着的会话用的是哪个识别模型（`lan-upstream.js` 的 `using`），改管线时把它们交给 `setPipeline` 的 `keep`，不卸载；没人用了以后由 LocalAI 自己的空闲看门狗卸载。代价是两台设备同时用不同识别模型时，两个模型都在内存里。一台设备的两路（我 / 对方）用的是同一个，不受影响，也不用互相等。
- **LocalAI 中途停了**：接到 LocalAI 的会话里，LocalAI 关掉连接（停止、崩溃）时，对方先收到一个 `upstream_failed` 错误说明原因，再收到关闭；LocalAI 给了关闭码就原样带过去，连接是断掉的就用 1011。对方自己关闭时，它的关闭码也带给 LocalAI。聊天请求的回答流到一半断掉时，对方的连接跟着断开，不会补上结尾、当成完整的回答。

### 协议上的差别

对另一台设备来说，这就是一台说同一套协议的服务器，所以下一节的约定对它同样适用。它和 LocalAI 有三处不同，客户端从模型列表里的 `owned_by: "kotomimi"` 认出它并自动处理：

- **Realtime 套接字里只做识别，不生成回答。** 客户端把翻译留给这台设备决定时，会改用聊天接口向管线名 `kotomimi` 要翻译，由共享的那台电脑按语言对自己挑最合适的翻译模型。
- **翻译模型不是聊天模型**，在 `capabilities` 里标为 `translate`。请求聊天接口时客户端会多带两个字段 `source_language` 和 `target_language`；系统提示词不被采用，每个翻译模型用自己的提示词。
- **转写会话里可以指定任何一个识别模型**，不像 LocalAI 只接受默认的那个。

握手带密钥时用 GA 的方式：子协议 `realtime` 加 `openai-insecure-api-key.<密钥>`，服务器回 `realtime`。HTTP 请求用 `Authorization: Bearer <密钥>`。

## 字体

"设置 → 字体"里从这台电脑已安装的字体中选：

- **界面**：菜单、设置和按钮。
- **拉丁字母和数字**：对话文字里的英文字母和数字。
- **罗马音**：日语、韩语、俄语下面那一行读音。不选时跟拉丁字母用同一种。
- **各语言的文字**：对话和字幕文字按语言各选一种正文字体；日语还可以另选假名注音的字体。当前语言对的两种语言总是列出，其他语言可以自己添加。

每种语言下面有一行示例，按对话里实际的样子画出来。选择器里每个字体用它自己的样子显示；选非拉丁文字的字体时，能显示这种文字的字体排在前面。

字体只在它有对应字形时生效，缺的字仍由应用默认字体显示。对话文字现在带语言标记，所以即使不选字体，日语里的汉字也会用日文字形而不是中文字形显示。

### 实现上的两点

- **界面字体**同时设在页面和应用根节点（`.App`）上。应用根节点自己指定了字体栈，只设在页面上到不了菜单和按钮。
- **拉丁字体只管拉丁字母**。很多为了拉丁字母而选的字体（比如 MiSans）自己也带中文和日文字形，直接排在字体栈最前面会把整行都接管，各语言的字体就永远轮不到。所以它是通过一条带 `unicode-range` 的 `@font-face`（家族名 `kt-latin`）引入的，只覆盖基本拉丁、拉丁扩展、IPA 和组合符号。`local()` 按字体的全名或 PostScript 名找字形，这两个名字在选字体时从系统字体列表里记下来（`latinFaces`），和设置一起保存。

## 给服务器一侧（Mac）的约定

客户端对 Realtime 服务器的依赖只有下面这些。服务器一侧改动时，保证这些不变，客户端就不需要跟着改。

**握手**

- `ws://<host>:<port>/v1/realtime?model=<模型名>`。没有密钥时不带任何子协议。
- 服务器先发 `session.created`，客户端回 `session.update`，服务器回 `session.updated` 后会话才算开始。30 秒内没等到就判失败。

**会话类型**

- 翻译留给另一台设备的管线时（识别也在它上面，翻译没指定模型）：`session.type = "realtime"`，`output_modalities = ["text"]`，带 `instructions`、`audio.input.turn_detection`、`audio.input.transcription`、`audio.input.noise_reduction = null`、`tool_choice = "none"`、`tools = []`、`max_output_tokens`。
- 翻译指定了模型、走 API、走这台电脑，或开了语法反馈时：`session.type = "transcription"`，只带 `audio.input.{turn_detection, transcription, noise_reduction}`。**这种会话里服务器不能自己生成回答。**
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
- `GET <base>/models/capabilities`（可选，LocalAI 自带）用于给模型分类：`capabilities` 含 `transcript` 的是识别模型，含 `chat` 或 `completion` 的是文本模型，含 `translate` 的是翻译模型，为空的是管线，其他的（`vad`、`tts`）不出现在任何下拉里。
- 回答里的 `<think>…</think>` 会被客户端去掉。

**实测到的 LocalAI 行为（2026-10-02）**

这些是客户端已经绕开的地方。如果服务器一侧修掉了，可以提 issue，客户端可以去掉对应的处理。

- 握手不回子协议，所以客户端不带子协议。
- **页面直接发来的 POST 不带 Authorization 头会被拒绝（2026-10-04）。** LocalAI 默认开着 CSRF 检查：浏览器环境发来的跨站 POST（聊天、上传转写）没有 Authorization 头时，回 `400 missing csrf token in request header`；带任意 Bearer 就放行（它没设密钥时什么 token 都收）。所以文本模型请求和转写上传在没有密钥时带一个占位的 `Bearer no-key`（`textModel.ts` 的 `NO_KEY`），和 OpenAI 的客户端总带一个 key 是同一个做法。经共享端口转发的请求由主进程发出，不受这条影响。
- `turn_detection.create_response = false` 被忽略，所以"只识别"用的是转写会话。
- 带外的 `response.create`（`conversation: "none"`）会被当成真实对话回答，所以客户端不发它。
- 手动提交后立刻收到 `response.create` 会取消正在进行的转写。
- 手动模式下，转写事件用的 `item_id` 和 `input_audio_buffer.committed` 的不一样。
- 请求语音输出时会报错，并且不发 `response.done`。
- `apple-speech-transcriber` 不给 `language` 会报错，所以源语言不能选"自动检测"。
- **换识别模型只在管线会话里有效（2026-10-03）。** `session.type = "realtime"` 时，`audio.input.transcription.model` 填 `whisper-large-turbo`、`sensevoice-small-mlx` 都能正常识别，首次使用要加载 12 到 20 秒。`session.type = "transcription"` 时，除默认的 `apple-speech-transcriber` 外都被拒绝：`Failed to update session: model is not a valid pipeline model`。所以"服务器只识别、翻译交给别处"的搭配目前换不了识别模型：客户端在这种会话里不发识别模型名，界面上也把下拉禁用并说明原因。这一条需要服务器一侧解决，解决后客户端去掉这个限制即可（`localai.ts` 的 `transcriptionFor`）。
- `parakeet-cpp-nemotron-3.5-asr-streaming-0.6b` 的转写结果带 `<en-US>` 这样的语言标记，会进入原文，也会干扰管线里的翻译。

## 两台机器之间怎么协作

- 服务器一侧的改动、发现的问题、对客户端的要求：在本仓库开 issue，或直接改这份文件的"给服务器一侧的约定"一节并提 PR。
- 客户端一侧每次改动都会更新这份文件，所以看这份文件的提交记录就能知道约定有没有变。
- 两边都可以用下面的实机测试来确认对方的改动没有破坏约定。

## 实机测试

共享的整条链路（共享端口、它到 LocalAI 的那一半、管线改写）在一台机器上有端到端测试 `electron/lan-door.e2e.test.js`：一个假的 LocalAI 只听回环地址，不需要环境变量，随 fork 的测试一起跑。真的 LocalAI 何时读管线、模型真的加载和卸载，仍然只有下面的实机测试能确认。

不设环境变量时这些测试会跳过，普通测试不会连任何服务器。WAV 要求 24 kHz、单声道、PCM16，几秒钟的语音即可。各变量的含义写在测试文件开头。

对 LocalAI：

```bash
LOCALAI_LIVE=<host>:8080 \
LOCALAI_LIVE_WAV=speech.wav \
LOCALAI_LIVE_TEXT_MODEL=hy-mt2-1.8b \
LOCALAI_LIVE_JA_WAV=speech-ja.wav \
LOCALAI_LIVE_COACH_MODEL=qwen3-4b \
npx vitest run src/providers/openai/localai.live.test.ts
```

对另一台开了共享的 Kotomimi：

```bash
KOTOMIMI_LIVE=<host>:8790 \
KOTOMIMI_LIVE_WAV=speech-ja.wav KOTOMIMI_LIVE_SOURCE=ja KOTOMIMI_LIVE_TARGET=zh-CN \
npx vitest run src/providers/openai/kotomimi.live.test.ts --disable-console-intercept
```

比较语法反馈的提示词和模型：

```bash
COACH_LIVE_BASE=http://<host>:8080/v1 COACH_LIVE_MODELS=qwen3-4b npx vitest run --silent=false --reporter=verbose src/providers/openai/coachPrompt.live.test.ts
```

测试用的日语语音要是真的日语。用中文语音合成去读日文，只会读出汉字，测出来的"识别错误"其实是音频的问题。macOS 上可以这样生成：

```bash
say -v Kyoko "今日は天気がいいので、公園に行きましょう。" -o ja.aiff && afconvert -f WAVE -d LEI16@24000 -c 1 ja.aiff ja.wav
```

## 构建

```bash
npm ci
npm run build
npm run build:audio-host   # Windows 需要 VS Build Tools 的 C++ 组件
npx electron-forge make --arch=x64
```

- Windows 上仓库路径不能太深，否则安装包工具会因为路径超过 260 字符失败。放在类似 `C:\src\kotomimi` 的短路径下。也不要直接放在盘符根目录（例如用 `subst` 映射出来的 `S:\`），那样打包时会漏掉文件。
- `npm ci` 如果加了 `--ignore-scripts`，需要手动补三步：`node node_modules/electron/install.js`、`bash scripts/copy-ort-wasm.sh`、在 `node_modules/electron-winstaller` 里运行 `node script/select-7z-arch.js`。
- 安装包没有代码签名。

开发时不打包也能跑。未打包的 Electron 认三个环境变量（打包后的应用不认）：

| 变量 | 作用 |
|---|---|
| `KOTOMIMI_PROFILE=<目录>` | 用单独的设置目录，不碰已安装应用的设置，也不和它抢单实例锁 |
| `KOTOMIMI_DEBUG_PORT=9333` | 打开 DevTools 协议端口，供脚本驱动界面 |
| `KOTOMIMI_LOAD_BUILD=1` | 加载 `npm run build` 的产物，而不是开发服务器。开发服务器在某些盘上会不停重启，这时用这个 |

## 名字和图标

- 名字集中在几处：`forge.config.js`（安装目录、可执行文件名、应用 ID）、`package.json` 的 `productName`、`electron/main.js` 的 `app.setName`（设置目录）。
- 界面文字不改语言包。上游的语言包里写的是 Sokuji，由 `src/lib/brand.ts` 在显示时替换成 Kotomimi。虚拟音频设备的名字保持 Sokuji 不变，因为设备确实还叫那个名字。
- 本分支自己的文字写在 `scripts/fork-localai-locales.cjs` 和 `scripts/fork-locale-groups.cjs` 里，每条是 [英文, 简体, 繁体]，由脚本写进全部 30 个语言包。
- 图标由一张图生成全套：

```bash
node scripts/fork-make-icons.cjs assets/logo-source.svg
```

  原图是矢量图（.svg）时直接用。原图是白底的 PNG 时，脚本会从四边把背景去掉；已经透明的 PNG 加 `--keep-background`。
- "关于"里保留了对 Sokuji 和 Kizuna AI Lab 的署名。"帮助"里的反馈链接指向本仓库的 issues，不再指向上游的支持邮箱和讨论区。

## 版本号和发布

- 版本号是"上游版本 + 两位分支序号"：上游 0.42.2 的第 1 个分支构建是 `0.42.201`。每次要让别人覆盖安装的构建都要加一，否则安装程序会认为已经装过。五处版本号要一起改：`package.json`、`extension/package.json`、`extension/manifest.json` 和两个 lockfile。
- 更新源指向本仓库的 Releases，不再指向上游，所以不会被提示换回官方版。启动时不自动检查更新，"帮助"里的"检查更新"可用。
- 发布用本分支自己的流程 `.github/workflows/kotomimi-release.yml`：

```bash
git tag -a v0.42.230 -m "Kotomimi 0.42.230" && git push origin v0.42.230
```

  它会跑本分支的测试，构建 Windows 安装包，尽量构建 macOS（Apple 芯片）版本，然后生成一个**草稿** Release。到 GitHub 的 Releases 页面检查后点发布。只有发布了的 Release 才会被"检查更新"看到。
- 标签必须是 `v<版本号>`，并且和 `package.json` 里的版本一致，否则流程会拒绝。
- 上游的三个流程（`build.yml` 等）在本仓库的 Actions 设置里停用了：它们也监听 `v*` 标签，但签名步骤只在上游仓库执行，在这里只会白跑。
- macOS 版本没有 Apple 开发者证书，没有公证：第一次要右键点"打开"。

### macOS 的签名

macOS 把钥匙串和麦克风的许可记在应用的签名上，Squirrel.Mac 也只接受和当前应用签名一致的更新。没有固定签名时，构建脚本只做临时（ad-hoc）签名，每次构建的签名都不同：每更新一次，macOS 都当成新应用，钥匙串和麦克风要重新确认，而且在确认之前窗口打不开；应用也不能自己更新。

解决办法是一张**自己签发的代码签名证书**，放在仓库的两个密钥里（上游的做法，原理见 `docs/build/macos-auto-update.md`）：

| 密钥 | 内容 |
|---|---|
| `MACOS_CSC_LINK` | 证书和私钥导出的 `.p12`，base64 编码 |
| `MACOS_CSC_KEY_PASSWORD` | 这个 `.p12` 的密码 |

证书的名字必须是 `Kotomimi Code Signing`（`package.json` 的 `build.mac.identity`）。生成证书并存进密钥由一个脚本完成（`scripts/kotomimi-mac-signing-cert.sh`）。把它复制到一个单独的文件夹里再运行，证书、私钥和密码会留在那个文件夹里：

```bash
mkdir -p ~/kotomimi-signing && cp scripts/kotomimi-mac-signing-cert.sh ~/kotomimi-signing/make-cert.sh
bash ~/kotomimi-signing/make-cert.sh
```

在 Windows 的 PowerShell 里没有 `openssl` 和 `base64`，要让 Git Bash 来跑：

```powershell
& "C:\Program Files\Gitinash.exe" "$HOME\kotomimi-signing\make-cert.sh"
```

再运行一次不会换证书，只会把现有的那张重新存进密钥。

有了这两个密钥，发布流程会：把证书加入信任（否则 electron-builder 找不到它，会悄悄跳过签名）、用它签名、检查签名确实钉在证书上，并把 `.zip`、`.blockmap` 和 `latest-mac.yml` 一起放进 Release，Mac 上的"检查更新"就能原地更新。没有密钥时流程照旧做临时签名，也不发布更新器要的那几个文件。

- 这张证书要**一直用同一张**。换证书等于换签名：已安装的应用更新不了，许可也要重新确认一次。把 `~/kotomimi-signing` 备份好，不要提交进仓库。
- 第一次从临时签名换到固定签名的那个版本，还要手动装一次、确认一次；之后就不用了。
- 这不是公证，对"无法验证开发者"的提示没有帮助。

## 跟进上游

本分支对上游文件的改动很少，绝大部分是新增文件。上游发新版后：

```bash
git fetch upstream
git checkout -b sync/upstream-<日期> localai
git merge upstream/main                 # merge，不 rebase：localai 的历史不改写
node scripts/fork-localai-locales.cjs   # 语言包冲突时：先取上游版本，再跑这一行
```

测试跑 `.github/workflows/kotomimi-release.yml` 里"Run the fork's tests"那一步的完整命令（清单以那里为准），再跑 `npx tsc --noEmit -p .`。然后开 PR 到 `localai`。

改动过的上游文件：

| 文件 | 改了什么 |
|---|---|
| `src/providers/openai/{adapter,config,wire,settings}.ts` | 给适配器加了几个开关：自定义地址、无密钥时不带子协议、关闭锚点、手动提交不催答、转写会话 |
| `src/providers/registry.ts`、`src/lib/session/storedSettings.ts` | 注册新提供商（排在第一个）和它的存储键 |
| `src/lib/provider/types.ts`、`src/components/providers/{ProviderPicker,CredentialForm}.tsx` | 提供商可以自己画凭据区（`credentials.Assist`、`drawnByAssist`）；"推荐"标在声明了 `recommended` 的提供商上，不再是第一个托管提供商 |
| `src/components/Settings/ProviderArea.tsx` | 高级布局的"常规"页不再画提供商 |
| `src/components/TitleBar/AccountButton.tsx` | "登录"只在选了托管提供商或已登录时显示 |
| `src/components/SetupWizard/applySetup.ts` | Kotomimi 那一步的选择同时写入翻译和语法反馈的位置 |
| `src/app/readiness.ts`、`src/stores/providerStore.ts` | 网络类提供商也能在模型下载完成后重新检查就绪状态 |
| `src/lib/local-inference/modelManifest.ts` | 启动时把自定义模型并入模型库 |
| `src/lib/local-inference/engine/AsrEngine.ts`、`public/workers/sherpa-onnx-asr.worker.js` | 把语言传给 SenseVoice |
| `src/components/Conversation/ConversationList.tsx`、`src/components/Subtitle/SubtitleBands.tsx` | 文本渲染处接入注音，并给文字加语言标记 |
| `src/components/Display/DisplaySettingsPopover.tsx` | 显示设置里加两个注音开关 |
| `src/components/MainPanel/panel/TypedText.tsx`、`PanelToolbar.tsx` | Ctrl+K 聚焦输入框；引导用的锚点 |
| `src/components/Settings/SimpleSettings/SimpleSettings.tsx`、`AdvancedSettings/AdvancedSettings.tsx` | 加入"字体"一节 |
| `src/components/Settings/sections/HelpSection.tsx` | 反馈链接换成本仓库的 issues |
| `src/components/SetupWizard/steps/{StepProviderPath,StepCredentials,StepFinish}.tsx`、`SetupWizard.tsx` | Kotomimi 的卡片（带"推荐"，托管那张不再带）和它自己的一步 |
| `src/components/Tour/{steps,tourContext,useStartBasicsTour}.ts` | Kotomimi 提供商的引导步骤 |
| `src/components/TitleBar/TitleBar.tsx`、`src/components/Subtitle/SubtitleBar.tsx`、`index.html`、`shared/index.html` | 显示的名字和标题栏图标 |
| `src/locales/index.ts` | 注册名字替换 |
| `src/routes/Home.tsx`、`src/App.scss` | 启动时读取注音开关、字体和共享状态；Windows 上由页面自己给窗口加圆角（`src/lib/windowShape.ts`：窗口无边框又透明，系统不给圆角；最大化和全屏时恢复直角） |
| `electron/main.js` | 应用名、设置迁移、"关于"、启动时不查更新、共享用的 IPC、开发用的环境变量；Windows 上接入 `electron/window-maximize.js`（显示缩放不是整数倍时，Electron 认不出透明窗口已最大化，最大化后还原不了；这里记住最大化前的位置，自己还原；最大化和还原没有系统动画，由页面自己播放窗口大小变化的动画，`window:shift` / `window:shift-place` / `window:shift-ready`） |
| `electron/ipc-channels.js`、`electron/preload.js`、`vite.config.ts` | 共享用的通道和构建入口 |
| `electron/main.js`（启动时的虚拟声卡一段）、`electron/vb-cable-installer.js`、`src/components/AudioSystemBanner/AudioSystemBanner.tsx`、`src/components/MainPanel/MainPanel.tsx`、`src/stores/audioSystemStore.ts` | Windows 上启动时不再弹窗要求下载安装 VB-CABLE（上游在窗口出现之前弹英文对话框，点"Install Now"后静默下载、没有进度也没有超时，看起来像没反应）：启动时只检测；没装时横幅说明"没有安装 VB-CABLE……只看字幕不需要它"，并给"安装 VB-CABLE"按钮（原因码 `vbcable-missing`，不再落到说 PulseAudio 的那句）；当前提供商从不出声时（Kotomimi 自由搭配）横幅不显示；下载加了两分钟超时 |
| `electron/update-manager.js`、`electron/update-payload.js` | 更新源和安装包文件名 |
| `forge.config.js` | 应用身份 |
| `assets/icon.*`、`public/favicon.ico`、`public/logo*.png` | 图标 |
| 几个测试文件（`registry.test.ts`、`palabraai/provider.test.ts`、`gemini/provider.test.ts`、`localInference/provider.test.ts`、`ProviderPicker.test.tsx`、`AccountButton.test.tsx`、`LanguagePairSection.test.tsx`、`SimpleSettings.order.test.tsx`、`HelpSection.test.tsx`） | 跟着上面的改动更新的断言 |
| `src/locales/*/translation.json` | 由脚本生成的文字 |
| `package.json`、`package-lock.json` | 三个新依赖：`@sglkc/kuromoji`、`wanakana`、`es-hangul`；`ws` 从开发依赖移到运行依赖（共享的服务端要用）。另外是本分支的版本号（见"版本号和发布"），`productName` 和 `build` 里的应用 ID、可执行文件名、macOS 签名证书名、更新源 |
| `extension/package.json`、`extension/package-lock.json`、`extension/manifest.json` | 只有版本号，和根目录的一起改（见"版本号和发布"）。上游每次发版都会在这里冲突：保留本分支的版本号 |

## 许可

与上游相同，AGPL-3.0。日语词典来自 kuromoji 附带的 IPADIC，许可见 `node_modules/@sglkc/kuromoji/NOTICE.md`。
