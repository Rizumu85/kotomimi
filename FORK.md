# Kotomimi（ことみみ）

Kotomimi 是 Sokuji 的一个分支：在实时翻译之外，加上了自建模型的自由搭配和学语言用的辅助功能。名字取自"言葉"（话语）和"耳"（耳朵）。

基于上游 [kizuna-ai-lab/sokuji](https://github.com/kizuna-ai-lab/sokuji) v0.42.3（`d2f8001`）。上游的说明见 [README.md](README.md)，这份文件只讲本分支多出来的东西。

仓库：<https://github.com/Rizumu85/kotomimi>。Kotomimi 的工作在 `main` 分支上（默认分支）；`upstream` 分支是上游 Sokuji 的一份镜像。2026-10-06 之前它们分别叫 `localai` 和 `main`：`localai` 是这个 fork 只加了一个 LocalAI 提供商时起的名字，后来所有功能都长在它上面，名字就不对了。GitHub 会把旧名字转到新名字上。

The embedded LocalAI runner and its management modules have been removed. Legacy local runner values normalize to native; remote API and external LocalAI services remain supported.

Kotomimi 是独立的应用：有自己的名字、安装目录和设置目录，可以和官方 Sokuji 同时安装、同时运行。第一次启动时会把已有的 Sokuji 设置和登录状态复制过来；下载过的模型不复制，需要时重新下载。

## 这个分支加了什么

| 功能 | 说明 | 主要代码 |
|---|---|---|
| Kotomimi 自由搭配（提供商） | 识别、翻译、语法反馈三个环节，各自选在哪里运行：局域网里的另一台设备、任意 API 模型、或这台电脑。排在提供商列表第一个，带"推荐" | `src/providers/openai/localai.ts`、`pipeline.ts`、`LocalAIAssist.tsx` |
| 这台电脑的内置模型 | 识别、翻译和语法反馈都可以用应用自己下载的模型，全部在本机完成，不需要服务器 | `localaiDevice.ts`、`LocalAIEngine.tsx` |
| Native model sharing | Share installed native recognizers, translators, and feedback models with another LAN device. | `electron/lan-server.js`, `src/lib/lan/` |
| 自动找到另一台设备 | 选「用另一台设备」时，应用自己搜索局域网，把找到的 Kotomimi 和模型服务器列出来，点一下就连上，不用知道地址 | `electron/lan-discover.js`、`src/components/LanSharing/ServerFinder.tsx` |
| 原生识别引擎 | 应用自己下载一个运行库（audio.cpp）和模型，在本机用显卡边听边出字；不用装任何别的东西。五个模型：Qwen3-ASR 1.7B（Windows 和 Apple 芯片的 Mac，实测更准、出字更快，30 种语言，显卡忙不过来时也不会越落越远）、Confucius4 R2T2（只在 Windows）、SenseVoice-Small（Windows 和 Apple 芯片的 Mac，最轻最快，约占 0.4 GB 显存，只听中、粤、英、日、韩）、Qwen3-ASR 0.6B（小模型，约占 2 GB 显存，给同一台电脑还要跑游戏的人）和 Nemotron 3.5 ASR 0.6B（约占 1 GB，最后的选择） | `electron/native-engine.js`、`src/providers/openai/nativeAsr.ts`、`localaiNative.ts`、`NativeEngineCard.tsx` |
| Mac 自带的语音识别 | Mac 上（macOS 26 及以上）排第一的原生识别引擎是系统自己的语音识别：应用带一个小程序去调用它，边听边出字，不需要 LocalAI。系统不支持的语言（比如俄语）由上一行的 Qwen3-ASR 来听，两个引擎对页面来说是一个 | `native/apple-speech/SpeechHelper.swift`、`electron/apple-speech.js`、`electron/native-engines.js` |
| 原生翻译引擎 | 同样的做法用在翻译上：应用自己下载 llama.cpp 的服务器和翻译模型的 GGUF 文件（Index-Translate 2B、Hunyuan MT 2、Hunyuan MT 1.5），在本机运行。Windows 和 Apple 芯片的 Mac 都提供 | `electron/native-engine.js`（`LLAMA`、`TRANSLATORS`）、`src/providers/openai/nativeTranslators.ts` |
| 原生语法反馈引擎 | 语法反馈也可以由应用自己下载的 llama.cpp 来跑：一个小的对话模型（Gemma 4 E2B），几乎即时给出反馈，不需要 API | `electron/native-engine.js`（`COACHES`）、`src/providers/openai/nativeCoaches.ts` |
| 自动识别对方说的语言 | 一个开关：对方说哪种语言都识别并翻成你的语言，不用手动切换；你自己说的仍按选好的语言翻译。需要 Qwen3-ASR（原生引擎）或 API 来识别 | `localaiDevice.ts`（`detectsOther`、`heardBy`）、`src/lib/language/script.ts` |
| 模型说明和实测排序 | 模型库里每个实测过的识别模型，名字旁有一个说明气泡：实测错字率、出字快慢、适合什么情况；日语的排序和"推荐"标记按实测来 | `src/lib/local-inference/selection/measuredRank.ts` |
| 自定义模型 | 从 Hugging Face 添加模型库里没有的 Whisper 模型 | `src/lib/local-inference/customModels.ts` |
| 语法反馈 | 自己说对方语言时，不翻译，而是检查语法：没问题回 ✓，有问题给出改正句和原因。提示词按语言自动选择，也可以自己写 | `coachPrompt.ts` |
| 打字查词 | 会话中按 Ctrl+K，输入母语，得到对方语言的译文 | `src/components/MainPanel/panel/TypedText.tsx` |
| 麦克风激活阈值 | 像 VRChat 那样：比设定音量小的声音当作静音，扬声器里对方的声音进不了识别和语法反馈。设置里的麦克风下面有滑块和实时音量条，没开会话时可以按麦克风图标测试 | `src/lib/audio/capture/micGate.ts`、`src/components/Settings/sections/MicGateControl.tsx` |
| 假名注音、罗马音、拼音、原文斜体 | 日语汉字上方显示平假名；日语、韩语、俄语、乌克兰语下方显示拉丁字母注音（乌克兰语按乌克兰 2010 年的国家标准，不套俄语的表；韩语按实际读音一个音节一段，用连字符分开；打开后可以按语言单独关掉）；中文每个字上方显示带声调的拼音（默认关，粤语不加）；原文要不要用斜体（默认斜体，和上游一样；汉字和假名的斜体是浏览器硬倾斜出来的，可以关掉）。四个开关都在显示设置弹窗底部。拼音和乌克兰语转写、注音两侧留空居中，是 2026-10-17 照上游 #632/#638 补的（拼音用同一个 `pinyin-pro` 3.29.5） | `src/lib/annotate/`、`src/components/Annotated/` |
| 注音读音修正 | 词典在口语里常读错的词（行った、今、方、何、数词加量词……）按上下文改成说话时的读音；日期里「月」后面的 1日 读ついたち，数字写的月份连数字一起标（4月 しがつ、7月 しちがつ、9月 くがつ）。一句还在识别时，最后一个词先不标读音，说完再标，读音不会跳（这两点参考上游 2026-10-15 的注音，2026-10-28） | `src/lib/annotate/japaneseReadings.ts`、`annotate.ts` 的 `holdLastReading` |
| 字体 | 界面、拉丁字母、罗马音、各语言的正文和注音，分别选字体 | `src/lib/fonts/`、`src/components/Fonts/` |
| 语言置顶 | 语言下拉换成应用自己的列表：每个语言右边有置顶按钮，置顶的排最前；还可以输入几个字筛选 | `src/components/providers/LanguageMenu.tsx`、`src/stores/languagePinStore.ts` |
| 开机时在后台启动 | 一个开关，默认关。打开后登录 Windows 时不弹窗口地启动，并把原生引擎预先加载一遍（之后放掉显存）。只在安装版的 Windows 上显示 | `electron/autostart.js`、`src/components/Autostart/AutostartSection.tsx` |
| 设置向导和引导 | 向导只有四步：界面语言、用途、语言、完成。上游的"选服务提供商"和本分支加过的"由哪台设备来运行"两步不再显示（`setupDraft.ts` 的 `KOTOMIMI_HIDDEN_STEPS`）：新用户还没见过这些东西就要做选择，选错会走进另一个产品（要注册账号，或者换了一套引擎），而这两项在设置里随时能改。经过这两步时直接替用户答好：用 Kotomimi 自己的提供商，三个环节都放在这台电脑。重新运行向导时，已保存的提供商和各环节的去处保持不变。两步的组件和它们的测试还留在代码里（测试用 `setHiddenSetupSteps([])` 把它们显示回来）。引导会介绍上面这些功能 | `src/components/SetupWizard/steps/StepKotomimi.tsx`、`src/components/Tour/steps.ts` |

注音在本机用词典和规则算出来，不调用任何模型，也不联网。

## Stage configuration

Kotomimi has three independent stages: speech recognition, translation, and optional grammar feedback. Each stage can use **This computer**, **API model**, or **Another device**. Settings use one categorized layout: General, Audio, and Provider. Stage cards (`LocalAIAssist.tsx`) live in Provider.

General places VRChat controls before font settings. Audio starts with Speech mode (Auto, Push-to-Talk, and Push-to-Translate), followed by audio devices. In Auto, Speech detection starts collapsed beneath the mode buttons and expands its provider-specific tuning in place. Manual modes hide this disclosure; returning to Auto collapses it again. Provider contains no duplicate tuning block. Active sessions allow inspection but keep parameters locked.

For Kotomimi (`localai`), Audio hides the echo-cancellation picker and Original Audio Passthrough until translated speech output is supported. This only hides controls: saved preferences and audio processing remain intact. Speaker monitoring is last, after Other's audio. To restore the two controls after implementing and validating voice output, update `showVoiceOutputControls` in `AdvancedSettings.tsx`; the existing components, settings, and handlers are retained.

General also hides the entire Text Only / Keep audio for replay section for Kotomimi. Restore it by updating the Kotomimi visibility guard in `OutputToggles` (`SpeechSection.tsx`) when translated speech output is supported. Existing preferences and other providers' controls are preserved.

| Stage | This computer | API model | Another device |
| --- | --- | --- | --- |
| Speech recognition | Downloaded native recognizer or installed Apple Speech language assets | An OpenAI-compatible transcription endpoint | A sharing Kotomimi, compatible phone node, or external LocalAI Realtime server |
| Translation | Downloaded native translation model | An OpenAI-compatible chat endpoint | A compatible shared translation/text model |
| Grammar feedback | Downloaded native feedback model | An OpenAI-compatible chat endpoint | A shared feedback/chat model |

The embedded LocalAI runner and browser/WASM/WebGPU model runner have been removed from Kotomimi. Old local runner settings normalize to native. External LocalAI services remain usable through the remote/API choices; Kotomimi does not install, start, stop, or proxy an external LocalAI process.

### Choosing and downloading models

- Recognition has a row for each required language; translation has a row for each required direction. An explicit model choice is preserved, including a recognizer that needs best-effort language identification.
- Open **Model library** in a stage to download native models. A download started there selects the model for the original stage/row when it finishes, even if the library closes or another row is opened. Downloads from the sharing library do not change local session selections.
- Readiness checks whether required native models are available. It does not start an engine. Starting a session prepares the engines that session needs.
- A missing selected native translator prevents the session from starting. There is no automatic Bing fallback or substitution with a different installed translator.
- Models advertising translation directions are checked for every required direction, including reverse translation when speaking both languages. During a remote session the UI can show the model actually serving the request.

### API and remote services

The API service selector supplies known endpoint defaults; custom endpoints remain available. Choose a model from the service's list or enter its name. Recognition uses `/v1/audio/transcriptions`; translation and feedback use `/v1/chat/completions`. Text requests originate in the renderer, so the service must permit CORS.

Remote recognition uses the Realtime protocol. A sharing Kotomimi supports selecting a recognizer in the transcription session; an external LocalAI server may restrict that session to its pipeline's default recognizer. A phone can provide the stages it advertises. Recognition, translation, and feedback may run on different devices.

### Translation and private feedback

**I speak the other language too** translates either of your two languages into the other. **Grammar feedback** can be enabled at the same time: a practice sentence then receives both a translation and a separate private correction/explanation. A sentence in your own language and typed input are translated without feedback. With feedback alone, practice speech receives feedback; it does not acquire a second translation merely because feedback is enabled.

Translation and feedback stay attached to the same utterance as separate results. Feedback never replaces its translation or goes to the VRChat chatbox. See [Apple Speech over LAN](docs/apple-speech-lan.md) for the two-source behavior and device checks.

Feedback prompts use the native and practiced languages. A custom prompt can use `{{SPOKEN}}` and `{{NATIVE}}`; the built-in prompts can include examples. Model quality and memory use depend on the chosen model. Kotomimi's pipeline produces text rather than synthesized speech; upstream speech providers remain separate.

## 麦克风激活阈值（2026-10-07）

用户的话："有没有办法和 VRC 那样有这种激活阈值，导致语法反馈会收到扬声器的声音（目前好像有个算法但是那个不太行）。"上一节末尾那个比对两路文字的办法只在"两者"模式下有东西可比，而且要等对方那一路的字出来；用户只听"我"一路、或对方那一路晚了，它就帮不上。扬声器漏进麦克风的声音和用户自己的声音有一个在哪种模式下都成立的区别：响度——嘴贴着麦克风，总比桌子对面的扬声器响。所以照 VRChat 的做法加了一道按音量的门（`src/lib/audio/capture/micGate.ts`，接在 `mic.ts` 里录音器和各个听众之间）：

- **比阈值小的声音当作静音送出，而不是不送**。本机的 VAD 是按收到的帧数静音的（`native-vad.worker.ts` 的 `redemptionMs`），声音不来它就永远不结束这一句；回声监视、音量条、直通也都靠这条流走表。所以门关着时送的是同样长度的零。
- **先看一眼再决定**（`GATE_LOOKAHEAD_MS`，170 毫秒）：每一块声音要等后面 170 毫秒到了才决定送不送，这样一个词轻声的开头（气音、轻辅音）在后面证明够响之后整个送出。代价是麦克风这一路整体晚 170 毫秒；别的都不受影响。录音器一块是 85 毫秒（48 kHz 的 4096 个采样），所以实际是等两块。
- **开了之后多留一会儿**（`GATE_HOLD_MS`，400 毫秒）：最后一块够响的声音之后再开 400 毫秒，词与词之间的低谷、句尾的轻辅音不被切掉。留得更久，用户停下之后对方的声音会多漏进来一截；更短，用户自己的话会被切碎。两个数都是估的，没有在真机上调过。
- **开关处渐变 4 毫秒**，直通和录音里听不到咔哒声。
- **刻度**：条和滑块用的都是同一个 0–100：这一块声音的 RMS 换成 dBFS，−60 dB 是 0，满幅是 100（`levelOf`）。用线性幅度的话正常说话在 10 以下、漏音在 1 左右，滑块没法用；按 dB 分，正常说话大约在 55–70，扬声器漏音大约在 20–35，中间好放标记。
- **设置里的样子**（`MicGateControl.tsx`，在麦克风一节的降噪下面）：标题、当前值（0 显示"关"），下面是滑块，滑块的轨道就是实时音量条——灰色是没过标记，绿色是过了（门会开）。会话进行中，音量条显示的是会话正在用的那个麦克风（经过降噪之后、进门之前的音量，和门用来判断的是同一个数，`micLevel.ts`）；没开会话时，条旁边有一个麦克风按钮，按下去应用自己打开麦克风来测（走的也是 `openMic`，所以降噪也一样），再按一下、过两分钟、或者会话开始时自动停。不自动一直开着的原因是 `devices.ts` 里记着的：有的驱动不允许同一个设备打开两次，测试开着时会话就起不来，所以测试一定要在会话之前让开。会话进行中只要模式包含"我"，滑块仍然可以拖（设备列表这时是锁着的，门不锁）。
- **默认关**（0），行为和以前完全一样；设置存在 `audio.micGateThreshold`。
- 原来比对文字的办法还在，两个一起用。

没做的：没有真机实测这两个时间常数；没有按音量自动建议一个阈值；门关着时音量条上没有另外画"门关了"的标记（看灰绿就知道）。

## API 模型栏的模型列表

"API 模型"的模型栏原来只能手打（旁边有浏览器自带的输入提示，但已经填了名字时什么都不显示，等于没有）。现在栏的右边有一个按钮：点一下，向这个服务要它自己的模型列表（`GET {地址}/models`，密钥放在请求头里；`apiModelList.ts`），在栏的下面展开，点一个就填进去。

- 最适合这一步的模型排第一并带一个星标（`preferredModel`，和不填时自动选的是同一个）；其余按服务给的顺序。
- 模型多于 8 个时（OpenRouter 有四百多个），列表上方有一个搜索框，展开时光标已经在里面。搜索是模糊的（`searchModels`）：可以打几个词、顺序随意，漏掉连字符或一两个字母也能找到，词开头匹配的排前面；回车选第一个。模型栏本身不参与筛选，栏里打什么就用什么。
- 搜索框不干涉输入法：用中文输入法打拉丁字母时，没上屏的拼音就已经在筛选（输入法在音节之间加的撇号不算字母）；输入法自己要用的按键（比如把字母上屏的回车）不会被当成"选第一个"。
- 列表拿不到时说明原因（没填地址、没填密钥、密钥被拒绝、连不上、这个服务不提供列表），并且仍然可以手打。上一次"检查"列出过的模型在等待时先显示。
- 语音识别、翻译、语法反馈三处的 API 都是同一个组件（`ApiModelPicker.tsx`）。

## 开机时在后台启动

设置里"启动"一节的开关，默认关，只在安装版的 Windows 上出现（`electron/autostart.js`）。打开后，Windows 的开机启动项里会有 Kotomimi（指向安装目录上一层的启动器，这样更新后仍然有效），带一个 `--hidden` 参数：

- 这样启动时不显示窗口。之后从开始菜单或桌面再点 Kotomimi，或者点右下角通知区域里的图标，显示的就是已经在后台的那个窗口（应用本来就是单实例）。关掉窗口和平时一样是退出。
- **通知区域的图标**（`electron/tray.js`，Windows 和 Linux；Mac 有 Dock）：应用运行期间一直在。左键点一下显示窗口，右键菜单有"显示 Kotomimi"和"退出"——后台待命时不用先把窗口点出来就能退出。它只是个入口：关窗口仍然是退出，图标不会让应用留在后台。菜单用系统语言（主进程不知道界面选的语言）。图标文件在打包后的 `resources/assets/` 下，开发时在仓库的 `assets/` 下，两处都找。
- 刚开机时各种程序都在抢磁盘和显卡，所以后台启动后**等一分钟**才开始加载引擎；这期间如果用户打开了窗口，就立刻开始。加载和预热时引擎进程的优先级是调低的。
- 引擎平时只在会话中才加载。后台启动是唯一提前加载的地方：把设置里选的引擎**加载一遍、一分钟后放掉**（`primeNativeOnce`），为的是把开机后第一次那半分钟提前做掉——模型文件读进系统缓存之后，真正开始会话时只要几秒。
- macOS 要求应用经过公证才能可靠地注册登录项，这个分支的 Mac 版没有公证，所以暂不提供。

## Retained upstream Bing translation

Bing translation remains in the upstream LocalInference implementation, including its `cn.bing.com` redirect handling. Kotomimi's native stages and LAN sharing do not use it as a fallback. LocalInference is hidden on desktop and remains available on web and extension. Edge speech services are retained separately.

## 假名注音的读音修正

假名注音和罗马音不是从声音来的：识别出文字以后，在本机用分词词典（kuromoji + IPADIC，2007 年的词典）查每个词的读音，只用 CPU。2026-10-06 查了一遍它还有没有改进的余地。

- **速度不是问题**：一行字约 0.2 毫秒（172 行、8900 字共 42 毫秒），词典加载约 0.25 秒。
- **换词典不值得**。试了目前还在更新的 Sudachi（`sudachi-wasm333`，词典 123 MB，现在的是 17 MB）。在应用实际显示过的日语 VRChat 闲聊上（四份语料，共约 660 行、3300 个带汉字的词），两个词典错得一样多，只是错的地方不同：IPADIC 把「行った」读成おこなった、「今配信」读成こん；Sudachi 把「私」一律读成わたくし、「気に入って」读成きにはいって、「鏡」读成きょう、「何が」读成なんが。另一个常见选择 UniDic 在浏览器里能用的版本（lindera 带的 2.1.2）没有"按写法的假名读音"这一栏，只有带长音符的发音，不能直接当注音。
- **做法：词典不动，把它在口语里常错的词按上下文再读一遍**（`src/lib/annotate/japaneseReadings.ts`，`correctReadings`）。两类：
  - **数词和量词连读**：词典把数词和量词分开读，音变就丢了。一回 → いっかい，十個 → じゅっこ，六本 → ろっぽん，三百 → さんびゃく，何杯 → なんばい，一人 → ひとり，一通り → ひととおり。
  - **多音词**：行った（いった／おこなった）、今（いま／こん）、方（かた／ほう）、何（なに／なん）、金（かね／きん）、後（あと）、月（がつ／つき）、この辺（へん）、そういう風（ふう），以及被词典当成复合词词尾的单独名词（薬、水、声、足、上、下……）。每条规则都写明"旁边得是什么"才生效，认不出的情况保持词典原来的读音。
- **怎么验的**：规则是照第一份语料写的，然后每加一批规则，就从原始录像里另切二十多分钟没用过的内容、用识别模型转成文字来检验。第一次检验就抓到一处改错的（一通り被改成いっとおり，应为ひととおり），于是加了"和语量词用ひと、ふた"的规则；之后两份全新语料上，规则一共改了 46 处读音，45 处对，1 处两种读法都说得通，没有改错的；同时用 Sudachi 的读音去对照，找出规则还没覆盖的错误，再补进去。最后一份新语料上，词典原本能查出的错误约占带汉字词的 4%，当时的规则修掉了其中约七成；补完之后剩下的没有再用新语料量过。两个词典都读错的地方这种方法查不出来。
- **代价**：每行多 3–4 微秒，不增加体积。测试（`japaneseReadings.test.ts`）用真实词典跑，因为规则认的就是词典怎么切、怎么读。
- 实验用的脚本和语料在 `%TEMP%\ktfuri`（`bench.mjs` 比速度、`diff.mjs` 列两个词典读得不一样的地方、`fixed.mjs` 列规则改了什么）。

### 审查之后（2026-10-06）

请一个独立会话把这些规则对着真实词典审了一遍（约 980 行探测句；报告在分支 `claude/intelligent-bohr-4ha0y4` 的 `REVIEW-japanese-readings.md`，用例收在 `japaneseReadings.review.test.ts`）。结论是规则写得太宽和漏掉的都有，照它改了：

- **改错的 42 处收窄了**。最常见的几类：「食べる方だ」「頑張った方だ」是ほう（只有前面是てる／くださった这类才是指人的かた）；「アニメ声」「囁き声」是ごえ；「世界観です」是かん；句尾的「それで十分」是じゅうぶん（前面是钟点或あと时仍是じゅっぷん）；「金と銀」「金に塗る」是きん；「化粧水が」是すい；片假名单位不变音（一ヘルツ不是いっぺるつ）；「三年一組」是いちくみ。
- **漏掉的常见读法补上了**：他（ほか）、日期（二日 ふつか … 十日 とおか、十四日、二十日 はつか、二十四日）、二十歳（はたち）、この間（あいだ）、お腹空いた（すいた）、入ろう（はいろう）、被る（かぶる，只有「損害を被る」这类是こうむる）、何曜日／何月、表示分钟的十分（十分後）、金ない、という風に／変な風に、店開いてる（あいてる）、絵を描く（かく）、明後日、入り口、いつも通り、先生方、一手間／一仕事 等。
- **阿拉伯数字后面的量词**（识别模型常这样写）：3本 → ぼん、6本 → ぽん、10分 → ぷん。数字本身没有读音可改，只改量词；但读法猜不出来的几种——1人、2人、日期、20歳——数字上也标读音（10日 标成 とお·か），罗马音跟着是 tooka、hitori。
- **罗马音的一个错**：「六百円」以前出来是 ro pyakuen，促音在两个数词之间丢了，现在是 roppyakuen。
- **审查建议里没照做的**：
  - 「何時」一律读なんじ：应用实际听到的内容里就有「何時だかね」（いつだか），识别模型确实会把いつ写成何時，所以不加这条。
  - 「声」的条件改成了名单：审查建议"前面是名词就保留ごえ"，但在真实语料里这会把「ムーイ声切った」「という声真似」改错（3 处全错）。现在是：动词连用形后（囁き声）和一份"说的是哪种声音"的名单后（アニメ、萌え、ロリ……）是ごえ，其余是こえ。
  - 「開いた」只对会自己开的东西（店、ドア、窓、目、口……）读あいた：「花が開いた」「差が開いた」仍是ひらいた。
  - 两种读法都有人说、或者只有意思能分辨的（三桁、他人事、角、表、一足），不动，在测试里标了原因。
- **在真实语料上的变化**（四份、661 行）：新规则只改了 5 处读音——3 处「8月10日」（とおか）、1 处「他の配信者」（ほか）、1 处「持ってない方ですよね」（かた → ほう，两种都说得通），没有改错的。

## VRChat 联动（2026-10-26）

用户的问题：能不能通过 VRChat 的接口知道谁在说话，省性能；世界里用播放器放视频时，别人说话的翻译会变慢。设计稿 `.dev/design/vrchat.html`、`.dev/design/vrchat-subtitle.html`。

- **调研结论**：VRChat 不告诉别的程序"谁在说话"。OSC 只给本人的静音和音量（`/avatar/parameters/MuteSelf`、`Voice`），Udon 也读不到别人说话（官方反馈区的请求还没做）。VRCT 等工具都是把扬声器的声音整个拿去识别，同样分不开视频和人声：两者在 VRChat 里已经混在一起。后来按声音方向把视频去掉了，见下面「按声音方向去掉视频声」。
- **从哪里知道**（`electron/vrchat.js`，只在 Windows）：VRChat 的运行记录 `AppData\LocalLow\VRChat\VRChat\output_log_*.txt`。它启动时写自己的接口端口（`Advertising Service VRChat-Client-… of type OSCQuery on 13945`、`… of type OSC on 9000`），放视频时写 `[Video Playback] Attempting to resolve URL '…'`，进别的世界写 `[Behaviour] Entering Room`。静音状态向那个 OSCQuery 端口问 `GET /avatar/parameters/MuteSelf`（本机 HTTP，每 0.25 秒一次，只在需要时问）；头顶文字用 UDP 发 `/chatbox/input` 到 OSC 端口。这样应用自己不监听任何端口，不用 mDNS：不会弹防火墙，也不和 VRCT 抢 9001。VRChat 不记录视频什么时候停。
- **静音**：设置「VRChat 静音时不识别我」（默认开）。VRChat 里静音时，麦克风送给"我"那一路的是同样长度的静音（`MicSettings.held`，`mic.ts`），一句话会像停顿一样结束；底栏的"我"划一道。不出声、只想把说的话翻译到头顶的人把它关掉。
- **头顶显示我的翻译**：关 / 译文 / 原文 + 译文（默认关）。"我"那一路的一句话和译文都定稿后发一次，打字的也发；两条之间至少 1.5 秒（VRChat 会丢太快的），超过 144 个字截断。「原文 + 译文」时原文和译文各占一行（2026-10-27 起；以前发送前把换行当空白合并掉了，两段挤在一起），设置里用四个聊天框小图来选（关 / 译文 / 原文在上 / 译文在上，`VRChatSection`；用户的设计，2026-10-27），下面是按所选样子画出的聊天框预览：用户最近一句翻译过的话（控制器记在 `vrchatStore.recent`，不含语法反馈），还没说过时用语言对的示例句。选「译文在上」（`chatboxTranslationFirst`）时译文在第一行；太长时较短的一行保留完整、另一行截短，两行都不会被整句截掉（`vrchat.ts` 的 `twoLines`）。开着语法反馈时（用户的要求，2026-10-26）：说的话本来就是对方的语言，发识别出来的原句，原句定稿就发，不等反馈；反馈只给自己看，不发；打的字照常翻译，发译文（打字的句子靠 `pipeline.ts` 给它的 `sokuji_typed_` origin 认出来）。模式是「对方」时"我"那一路不开，聊天框什么也不会发：这时不画预览，在它的位置写「现在只翻译对方，你说的话不会显示在头顶。」和一个「改成「两者」」按钮（会话进行中不能点，和主界面切模式一样；样子同测速的建议）。用户说过变淡的预览看不出是发不出去（2026-10-28）。说话人用对方的语言说的一句（识别结果标着那种语言）：「译文」时发原话，因为那就是对方读的；「原文 + 译文」时开着「我也说××语」发原话和翻回自己语言的译文两行，没开时只发原话（`finishedLine` 的 `theirs`，app 从语言对和 `languages.detection` 的 `both.on` 拿）。用户的朋友开着 OSC 却看不到头顶文字，就是这个原因（2026-10-28）。
- **世界里放视频时**：每次问我 / 只翻人声 / 人声和视频都翻 / 先不翻译（默认每次问我，`settings.vrchat.onVideo` 的 `ask`、`quick`、`both`、`pause`）。只在会话进行、开着"对方"那一路时起作用。2026-10-31 改成这四项：以前的「全都翻译」（`normal`）把人声和视频混在一起送识别，录音实测里人说的话全丢了，所以去掉；以前「优先听人说话」下面的「也翻译视频」开关合进 `both`。旧设置里的 `normal`、或 `quick` 加开关开着，读取时改成 `both`，开关只读这一次。
  - **只翻人声**：先把对方那一路的一段话切得更短（`AdapterSession.pace('quick')`，契约里可选的方法）。本机原生识别从 8 秒一翻、24 秒硬切改成 4 秒、8 秒（`nativeAsr.ts` 的 `QUICK_ROLL_*`），API 识别一段话超过 6 秒就先送一段（`apiAsr.ts`）。另一台设备的 Realtime 会话由对方切，没有这个方法，照常。同时开始听：视频的声音左右完全一样时，把它从对方那一路里去掉，切段恢复正常（见下一节）。
  - **人声和视频都翻**：和「只翻人声」一样去掉视频声，同时把视频那部分单独识别、翻译，显示成淡一些、小一些的「视频」行；字幕模式里是最上面一小行。不发到头顶，不做语法反馈，不放进局域网共享。只在 Kotomimi 自己的提供商（`localai`）下有：它的每句话都带 origin，视频的句子才能和人说的分开配对；别的提供商下设置和询问里都不显示这一项，存着 `both` 时按「只翻人声」做、也这样显示。一条询问的回答只管这个视频；视频放着时在设置里改这两项，当场跟着开关视频那一路。
  - **两项都分不开时**（视频声有方向，或 macOS）：只把句子切短，声音还混着，界面显示「已切短句子」。选项下面那句话写了这一点。
  - **先不翻译**：运行器给对方那一路送等长的静音（`Runner.setLegPace`，`run.ts`），视频和别人的话都不翻译。
  - **每次问我**：主窗口在对话下方出提示条；字幕模式放在字幕条里时间后面，询问期间字幕条一直显示。点击穿透打开时点不到，就不问，直接按「只翻人声」处理，字幕区左上角标一下；问了 12 秒没人回答（人在 VR 里，主窗口没人看）也这样（`ASK_WAIT_MS`，2026-10-28 补上，之前只写了没做）。
  - **结束**：进别的世界、会话结束，或点"结束"；去掉视频声之后，视频的声音停了也自动结束。
- **测试**：未打包运行时，`KOTOMIMI_VRCHAT_LOG_DIR` 让应用读一个别的文件夹当 VRChat 的记录；`.dev/tools/scratch/fake-vrchat.mjs` 起一个假的 VRChat（写记录、回答静音、打印收到的头顶文字）。2026-10-26 用它在测试窗口走通了：已连接、静音划线、视频询问、切短句子、换世界结束、字幕条询问、点击穿透下自动切短、打字发到头顶。之后接真的 VRChat 确认过：OSC 关着时 OSCQuery 端口也回答 `MuteSelf`。头顶文字还没在真的 VRChat 里试过。

### 按声音方向去掉视频声（2026-10-26）

用户问：VRChat 是 Unity 做的，每个人的声音有位置，能不能按左右声道分开人和视频。设计稿 `.dev/design/vrchat-video-remove.html`、`.dev/design/vrchat-video-lane.html`。

- **录音实测**（`.dev/tools/record-stereo.py` 录扬声器的两个声道，两段，录音只留在本机）：世界里的视频播放器不放在空间里，左右两个声道逐位相同；左减右后视频降 43–86 dB，侧面的人声几乎不变。用 Qwen3-ASR 1.7B 识别：原声只认出视频解说，人说的全丢了；左减右只认出人说的；分出来的"两边共有的部分"认出完整的视频解说，视频开始前只有人说话时它什么都认不出来。
- **正对面的人**：VRChat 把正前方的声音也做得几乎左右一样（左减右后低 40–55 dB，约 −75 dB，最低 −94 dB），所以判断"是不是视频"不能只看左右像不像，要看是否**逐位**相同。Windows 把声音写成 16 位时给两个声道各加一点噪声，视频的左减右在那里约 −99 dB；门槛定在 −97 dB（约一个最小量化单位）。正对面的人在去掉视频声期间会被一起削弱，所以只在放视频时这样做，视频停了就换回原声。
- **录两个声道**：对方那一路以前只取左声道。现在 AudioWorklet 收到两个声道时送它们的平均给识别，左右也一起带出来（`audio-recorder-worklet-processor.js` 的 `stereo`，`ParticipantRecorder.wantsStereo`）；只录某个程序时，Windows 的辅助程序 `sokuji-audio-host.exe` 加了 `--stereo`，输出交错的两个声道（`AppAudioRecorder` 拆开）。macOS 的辅助程序还是单声道，那边只能切短句子。
- **分离**（`src/lib/audio/capture/stereoSplit.ts`，全页一个 `participantSplit`，系统声音经过它）：平时送平均；去掉视频声时送左减右；需要时用 512 点、半帧重叠的频谱，每个频率按左右的差有多大保留平均值，得到"两边共有的部分"给视频那一路。每半秒算一次平均、差、共有部分的响度。
- **判断**（`createVideoJudge`）：放视频后，最近 30 秒里有 6 个半秒是"视频单独在响"（平均高于 −60 dB、差低于 −97 dB），并且这台电脑的声音出现过有方向的声音（排除单声道输出），就去掉视频声。之后 10 秒没有"视频单独在响"、共有部分也低于 −55 dB，或者 30 秒都没有"视频单独在响"，就算视频停了。
- **视频那一路**（`Run.openSide`）：在对方那一路上再开一个同样配置的会话，只喂共有部分，按短句切段；每开一次占一段自己的句子编号（第 n 次从 n×10 亿开始），origin 前面加 `kotomimi_video:n:`，放进对方那一路的对话里；它的语音不播放；它出错只关它自己，界面改回"已去掉视频声"；关掉时它还开着的句子一并结束。投影按 origin 给这些对话标 `lane: 'video'`（`project.ts`），界面据此画成视频行。要整段买流量的提供商（Kizuna AI）和两路一起开的提供商不开。
- **测试**：离线 `.dev/tools/scratch/split-offline.ts`（模拟 Windows 的噪声：`DITHER=1`）；两段录音里，视频开始后约 6 秒判定，正对面说话的那段没有误判。端到端：`.dev/tools/scratch/play-to-cable.py` 把录音放进 VB-Cable（扬声器不出声），测试窗口只录这个播放器，`video-e2e.mjs` 让假 VRChat 报"开始放视频"；视频开始约 1 秒后出现"已分开视频声"，对方那一路只剩玩家的话，视频解说进了视频行，字幕模式里在最上面一行。还没在真的 VRChat 里试；三路同时跑时显卡的负担也还没测。

## 字体

"设置 → 字体"里从这台电脑已安装的字体中选：

- **界面**：菜单、设置和按钮。
- **拉丁字母和数字**：对话文字里的英文字母和数字。
- **罗马音**：日语、韩语、俄语、乌克兰语下面那一行读音。不选时跟拉丁字母用同一种。
- **各语言的文字**：对话和字幕文字按语言各选一种正文字体；日语还可以另选假名注音的字体，中文可以另选拼音的字体（列表里带声调字母的字体排在前面）。当前语言对的两种语言总是列出，其他语言可以自己添加。

每种语言下面有一行示例，按对话里实际的样子画出来。选择器里每个字体用它自己的样子显示；选非拉丁文字的字体时，能显示这种文字的字体排在前面。

字体只在它有对应字形时生效，缺的字仍由应用默认字体显示。对话文字现在带语言标记，所以即使不选字体，日语里的汉字也会用日文字形而不是中文字形显示。

### 实现上的两点

- **界面字体**同时设在页面和应用根节点（`.App`）上。应用根节点自己指定了字体栈，只设在页面上到不了菜单和按钮。
- **拉丁字体只管拉丁字母**。很多为了拉丁字母而选的字体（比如 MiSans）自己也带中文和日文字形，直接排在字体栈最前面会把整行都接管，各语言的字体就永远轮不到。所以它是通过一条带 `unicode-range` 的 `@font-face`（家族名 `kt-latin`）引入的，只覆盖基本拉丁、拉丁扩展、IPA 和组合符号。`local()` 按字体的全名或 PostScript 名找字形，这两个名字在选字体时从系统字体列表里记下来（`latinFaces`），和设置一起保存。

## 许可

与上游相同，AGPL-3.0。日语词典来自 kuromoji 附带的 IPADIC，许可见 `node_modules/@sglkc/kuromoji/NOTICE.md`。
