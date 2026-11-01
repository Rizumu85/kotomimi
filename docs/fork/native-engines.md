# Native engines

## Native speech recognition

Kotomimi downloads a native runtime and model, starts the engine locally, and streams audio to it for live transcripts. Users do not need to install LocalAI. Choose a model in **Speech recognition → This computer → Model library**. Apple Speech uses the macOS helper and installed system language assets.

- **运行库**：[audio.cpp](https://github.com/0xShug0/audio.cpp) v0.9.0 的官方发行包（Windows x64 是 Vulkan 版，约 60 MB；Apple 芯片的 Mac 是 Metal 版，约 29 MB）。**第一个接进来的模型**（下面各条讲的是它；现在排第一的 Qwen3-ASR 见本节末尾）：[Confucius4 R2T2](https://huggingface.co/netease-youdao/Confucius4-R2T2)（网易有道，Qwen3-ASR 的流式微调）的 q8 GGUF，约 2.4 GB。两者的地址、大小和 SHA-256 都写死在 `electron/native-engine.js` 里（模型地址带提交号，不是分支），下载完校验不对就丢弃。下载可以取消，再点会从断点续传。
- **放在哪**：`<用户数据>/native-engine/`（`engine-<版本>/` 和 `models/`）。在模型卡片上点删除只删模型。
- **启动**：主进程写一份只监听 127.0.0.1 的配置、起进程、等 `/health`，再送一秒很轻的噪声把它预热一遍，然后才算就绪。加载和预热期间进程优先级调低。开机后第一次启动慢（实测约半分钟，主要是把模型读进显卡），之后每次几秒。
- **什么时候占显存**（2026-10-06 起，三个原生引擎都一样）：**只在有人用的时候**。以前是就绪检查一看到选了原生引擎就把它启动，应用开着就一直占着（识别加翻译约 4 GB 多），对同一台电脑还要跑游戏的人是白占。现在：
  - 就绪检查只看模型下载了没有，不启动引擎，也不要求它在运行（`nativeGap`、`translatorGap`、`coachGap`）。
  - 点"开始会话"后的第一步（`prepareLocalAI`，会话的 `prepare` 钩子）把这次要用的引擎并排启动、等它们都就绪，再搭建会话——翻译和语法反馈的地址要等引擎起来才知道端口。这期间主界面中间显示"正在加载模型…"。哪个没起来，这次开始就以它自己的提示结束。
  - 会话的每一条腿开着时引擎都被占着（`holdNativeForRun`）；最后一条腿关掉**一分钟后**，没人用的引擎停掉，显存还回去（`restNative`）。留一分钟是为了停了马上再开不用重新加载。
  - 共享给别的设备时也一样：别的设备来用，引擎按需启动；它用着的那个引擎不会被停（`holdNative`），它用完一分钟后停。
  - 换了设置、不再用某个引擎时，就绪检查仍然会马上把它停掉；会话进行中不会。
  - 退出应用时引擎一起退出。
  - 2026-10-06 请一个独立会话审查了这套时序（报告在分支 `claude/zealous-edison-u675tq` 的 `REVIEW-engine-lifecycle.md`），照它补了几处：
    - **从"开始会话"到会话结束一直占着**。以前只在每条腿开着时占；加载模型的那几秒和两条腿之间的空当里，一分钟的歇息计时可能正好到点，把刚启动的引擎停掉。现在 `prepareLocalAI` 一开始就占住（`holdNativeForRun`），会话的中止信号来了才放。
    - **翻译和语法反馈的地址每次请求现问**（`TextStage.engine`、`engineBaseNow`）。引擎中途重启会换端口，以前会话里记的是搭建时的地址，重启后每一句都失败。问不到时用搭建时的地址。
    - **有人在用的引擎不换模型**。下载的识别引擎和翻译引擎一次只能跑一个模型：别的设备来要另一个模型、而这台电脑的会话正用着时，那台设备得不到这个引擎的模型（`nativeTaken`，`nativeShare.ts`）；反过来，别的设备正用着、这台电脑开始会话要另一个模型时，以"正在被使用"的提示结束（`native_busy`），不会把人家的识别掐断。没点名模型的设备，优先给这台电脑主人自己选的那个（`preferNative`），这样主人下次开始会话什么都不用换。
    - **启动被打断和启动失败分开说**（`native_interrupted`）：引擎是被别的启动或停止顶掉的，就说"被打断了，再试一次"，不再显示成"启动失败"。
    - 卡片上的"重试"启动的引擎没人占着，试完一分钟后同样会停（`restNative`）。
    - 开机后台启动时的预热有期限：过了没人用就按平常的规矩停。
    - 屏幕上还留着上一次会话的内容时，"正在加载模型…"显示在对话上方的一行里（以前只在空白页面中间显示，这种时候看不到）。
    - Mac 上主进程自己那套"十分钟没人用就停"关掉了（`joinEngines` 的 `idleMs: Infinity`）：它只看有没有开着的识别，看不到页面的占用，一方十分钟没说话就会把会话还在用的引擎停掉。停不停只由上面这一套决定。
    - 共享出去的翻译引擎，对方用完后是约十一分钟才停（对方设备的连接要先闲置十分钟才算用完，再加一分钟）。
- **声音怎么送**：页面的 fetch 不能在 HTTP/1.1 上边传边收，所以实时请求由主进程拿着（Node 的 `http`，`POST /v1/audio/transcriptions/live`），页面通过 IPC 送声音、收文字。送之前在页面里重采样到 16 kHz（`src/lib/native/resample.ts`：引擎自己也能降采样，但实测准确率低 0.8 个点）。
- **断句**：还是本机的 VAD，和别的本机模型用同一套设置。一段话（VAD 的一次"有人说话"）开一次识别：加上开头前 0.8 秒的声音，停顿够了就结束这次识别，最后的文字作为这一句的结果去翻译。VAD 因为"最大语音时长"强行切开时，说话人还没停：这时只把已经写出来的字作为一句交出去翻译，识别不断开，所以不会在接缝处丢词。一次识别最长约两分钟（引擎的限制），所以超过 45 秒后会在词与词之间的空隙结束并马上开下一次。
- **两条实测出来的规矩**（2026-10-05）：① 结束一次识别前要有约一秒静音，引擎才会把最后听到的内容写完；紧贴着人声结束会丢掉最后好几秒的字。停顿本身通常已经够长，不够时（设置里把停顿调得很短，或在说话中途结束）应用补上。② 模型偶尔会"憋字"：继续听，但十几二十秒不出字，然后一口气全写出来（7 段里 1 段，引擎自带的客户端里也一样）。这时结束识别并不能让它写出来，反而会丢掉它之后本来会写的内容，所以目前不做处理，只能等。
- **参数**：分块 160 ms、`unfixed_chunk_num` 0、`unfixed_token_num` 3。直连引擎、整段 60 秒不断开时，7 段的错字率：160/0/1 是 16.0%（文字落后 1.6 秒），160/0/3 是 14.5%（落后 2.1 秒），160/2/5 是 14.5%（落后 3.0 秒），320/0/1 是 16.0%。`unfixed_token_num` 设 0 会让模型卡死（33%）。
- **应用里的实测**：同样 7 段，经过应用的采集和 VAD、每句话一次识别：错字率约 18%，文字平均落后约 3 秒。对照：Qwen3-ASR 1.7B 18.7%、落后约 10 秒；Whisper Large V3 Turbo 20.8%、落后约 10 秒。也就是说准确率和它们同一档，但文字快得多，而且是边听边出。比直连的 14.5% 差的那几个点，一半来自采集和 VAD（VAD 没检测到的轻声说话谁都听不到），一半来自按句断开后模型少了上文。
- **为什么 M2 跑不动 R2T2、却跑得动同样大小的 Qwen3-ASR**（2026-10-06 核对）：不是内存放不下（M2 有 16 GB 统一内存，模型才 2.4 GB），是算力。两个模型在两台机器上的速度比是一致的：Qwen3-ASR 整段读，5070 Ti 约 46 倍实时、M2 约 8.7 倍；R2T2 每 160 毫秒走一步，5070 Ti 约 2–2.8 倍实时、M2 约 0.4 倍。也就是 M2 的显卡在这类运算上大约是 5070 Ti 的五分之一，而 R2T2 的流式做法本身比整段读贵约二十倍——Qwen3-ASR 有二十倍的余量可以亏，R2T2 没有。Metal 的日志里没有运算退回 CPU 的迹象，audio.cpp 那边也没有相关的问题单（只有一个 Q4 量化版，说快约两成，补不上这个差距）。更高端的 Mac（Max、Ultra）按显卡规模估算能到一倍多实时，没有机器验证；而且 Mac 上系统自带识别和 Qwen3-ASR 都比 R2T2 准、出字也更快，所以没有给 Mac 开放。
- **R2T2 只在 Windows 提供**：Apple M2 上（Metal 版）一分钟的话要处理两分多钟，跟不上说话，所以 Mac 上不显示它（`MODELS` 里的 `platforms`）；Mac 上的原生识别是系统自带的那个，见下一节。显卡较弱的 Windows 电脑也可能跟不上，这一点应用目前不会自己判断——这种电脑用下面的 Qwen3-ASR。
- **不指定语言不可靠**：R2T2 可以不给语言让它自己判断，但实测每段开头几个词经常认错语言（一段日语开头被写成英语，整段跟着跑偏），所以"这台电脑"识别时仍然要选好语言。常用的几种语言可以在语言菜单里置顶，切换快一些。
- **开发**：非打包运行时，`KOTOMIMI_NATIVE_DIR` 让它用别的目录（免得测试用的配置目录里再下一遍 2.4 GB），`KOTOMIMI_NATIVE_DUMP` 把每次识别实际送给引擎的声音存成 PCM 文件，用来和引擎自带的客户端对照。
- **以后加模型**：加一个模型是在 `electron/native-engine.js` 的 `MODELS` 里加一项（地址、大小、SHA-256、家族、参数），再在 `localaiNative.ts` 的 `NATIVE_MODELS` 里加它的名字和语言，`NativeEngineCard.tsx` 的 `NOTES` 和 `scripts/fork-localai-locales.cjs` 里加它的说明（有测试拦着：没有说明的模型过不了）。共享给别的设备、手机借出同名模型时的处理都是从这两张表里推出来的，不用另写。2026-10-05 直连引擎试过的其他模型（同样 7 段日语）：Nemotron 3.5 Streaming 0.6B 是真流式、最轻（M2 上也有 8 倍实时），但错字率 20.6%；Fun-ASR Nano 51%（两段陷入复读）；Parakeet TDT v3 和 GigaAM 不支持日语，没测。

### 第二个模型：Qwen3-ASR 1.7B（整段识别的模型怎么做到边说边出字）

模型是 [Qwen3-ASR-1.7B](https://huggingface.co/Qwen/Qwen3-ASR-1.7B)（阿里通义，Apache-2.0），用的是 [audio.cpp 自己的 GGUF 仓库](https://huggingface.co/audio-cpp/audio.cpp-gguf)里的 q8 文件（约 2.3 GB，地址带提交号）。

Qwen3-ASR 不是流式模型：给它一段完整的声音，它写出整段文字（audio.cpp 里它自带的"流式"模式每 30 秒才写一次，没法用）。但它在这个运行库里非常快——RTX 5070 Ti 上 10 秒的话约 0.2–0.5 秒，M2 上约 1.5 秒——所以可以这样做（`native-engine.js` 的 `openWindow`）：

- **边说边重读**：一段话的声音在主进程里攒着，说话期间每隔一会儿把"到目前为止的全部声音"交给引擎识别一遍（`POST /v1/audio/transcriptions`，一个 WAV 文件），结果作为"暂定文字"显示（`partial` 事件：整段文字，下一次可能改写）；这段话结束时再识别最后一遍作为定稿。如果最后一次重读之后只多了静音（结束一段话的那个停顿），就直接用它当定稿，不再识别一遍。
- **慢的电脑不会越落越远**：两次识别之间至少歇 0.6 秒，并且至少歇"上一次识别花的时间"那么久。显卡慢，只是暂定文字刷新得慢，定稿照样准时。这和 R2T2 不同——R2T2 必须实时跟上，5070 Ti 上处理真实说话也只有约 2–2.8 倍实时的余量。
- **断句**：一段话越长，每次重读越慢，而且定稿之前不会翻译，所以说满 8 秒后在词与词之间的空隙结束这一段、马上开下一段；VAD 强行切开的地方，这一段满 8 秒了也在那里结束（`localaiNative.ts` 的 `WINDOW_LIMITS`）。实测三组参数（同样 7 段、在应用里）：10 秒后找空隙 / 20 秒后才在 VAD 切点结束，17.2%，连着说时一行要 20 秒才定稿；8 秒 / 每个 VAD 切点，其余 6 段 16.1%，但有一段被切得太短读坏了；8 秒 / 8 秒，16.4%，最多 15 秒一行。用的是最后一组。
- **复读的防护**：这类模型偶尔会在某一处"卡住"，把同样几个字一直写到上限（实测：「波で」写了 250 遍，花了 3 秒；约一百次定稿里一次，而且同一段声音只在某些长度下才会）。引擎的请求里没有能压住它的参数。所以：暂定文字里遇到复读就截到复读开始的地方；定稿遇到复读，先在声音前面加半秒静音重读一遍（实测这样就好了），还不行就从中间最安静的地方切成两半分别识别，仍然复读的那一半截断。判断标准是同一小段（最多 20 个字）连续出现 8 次以上、这一串至少 40 个字并且一直到结尾（2026-10-06 收紧，见下面"审查之后"），「そうそうそうそう」「ありがとう、ありがとう」这类正常的重复不受影响。
- **实测**（同样 7 段、在应用里）：Windows（RTX 5070 Ti）错字率 16.4%，文字平均落后约 1 秒；M2 的 Mac 16.6%，落后约 2.3 秒。对照同一套打分：R2T2 18.2%、落后 2.5 秒；Mac 自带识别 12.5%、落后 1.7 秒。引擎进程约占 3 GB 显存（Mac 上约 3 GB 内存）。
- **语言**：30 种（中、英、粤、日、韩、俄、西、法、德、意、葡、阿、泰、越、印尼、土、印地、马来、荷、瑞典、丹麦、芬兰、波兰、捷克、菲律宾、波斯、希腊、匈牙利、马其顿、罗马尼亚），语言用代码告诉它（`languageAs: 'code'`）。不给语言时它会自己判断，这一点还没有接进界面。
- **按语言记住选择**（`nativePicked`、`chooseNative`）：原生识别模型是一种语言一行来选的。某种语言选过模型，就一直用那个；没选过的语言沿用当前在用的模型（它能听的话）；它听不了，那一行就显示"未选择模型"并提示去选，不会自动换成别的——换语言本来就要先停下会话，一步一步来。同一次会话里两种语言选了下载引擎的两个不同模型时会提示选成同一个（它一次只能跑一个）；Mac 上系统自带的识别和下载的引擎可以同时用（主进程的状态里有 `up`：现在能用的所有模型）。
- An installed model and a selected model are different states. Explicit native choices are retained; readiness reports an unavailable required choice rather than substituting a browser model.
- **推荐顺序**（`NATIVE_MODELS` 的顺序，模型库里第一个能听这种语言的带"推荐"）：Mac 自带识别 → Qwen3-ASR 1.7B → R2T2 → SenseVoice-Small → Qwen3-ASR 0.6B → Nemotron 3.5 ASR 0.6B。R2T2 的长处是写出来的字不再改动；短处是吃显卡、语言少、Mac 上跑不动。后三个是省资源的：不是最准的，是最省的。SenseVoice-Small 排在 0.6B 前面，因为两个一样准而它轻得多（2026-10-12，见下面"又轻又快的模型"）。同一个顺序也是"没选过模型的语言默认用哪个"（已下载的里面排最前的那个）和"别的设备没点名时给哪个"的顺序。

### 小模型：Qwen3-ASR 0.6B

给只有一台电脑、识别的同时还要跑 VRChat 的人：前两个模型都要占约 3 GB 显存，游戏已经把显存用得差不多时放不下。

- **模型**：[Qwen3-ASR-0.6B](https://huggingface.co/Qwen/Qwen3-ASR-0.6B)（阿里通义，Apache-2.0），[audio.cpp 的 GGUF 仓库](https://huggingface.co/audio-cpp/audio.cpp-gguf)里的 q8 文件（约 1.1 GB，地址带提交号）。和 1.7B 是同一个家族，走同一条路（`openWindow`），语言、断句、防复读都一样，只是目录里多一项。
- **怎么选出来的**（2026-10-06，RTX 5070 Ti，同样 7 段日语录音）。候选是它和 [Nemotron 3.5 ASR Streaming 0.6B](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b)（NVIDIA，约 0.9 GB）：

  | 模型 | 整段直接识别 | 按应用切出来的句子识别 | 10 秒的话要读 | 占显存 |
  |---|---|---|---|---|
  | Qwen3-ASR 1.7B q8 | 16.0% | 16.4–17.2% | 0.29 秒 | 约 3.0 GB |
  | Qwen3-ASR 0.6B q8 | 21.4% | 22.0% | 0.22 秒 | 约 1.8 GB |
  | Nemotron 3.5 ASR 0.6B q8 | 20.8% | 26.8% | 0.15 秒 | 约 1.0 GB |

  整段识别时两个小模型一样准，Nemotron 还省一半显存。但应用给模型的不是整段，而是 VAD 切出来的一句一句：这样 Nemotron 掉了 6 个点——短句经常整句不出字（约 60 句里 12 句是空的），一成的内容没了；句子前后补静音也没用。Qwen3-ASR 0.6B 几乎不受影响。所以接的是 Qwen3-ASR 0.6B。"按应用切出来的句子"那一列，是把应用实际发给引擎的每一段声音（`KOTOMIMI_NATIVE_DUMP`）原样再交给模型读一遍；Nemotron 这样测是 26.7%，在应用里跑是 26.8%，两种测法对得上。0.6B 在应用里抽测了 4 段，和这一列一致，文字平均落后约 1.3 秒。
- **Nemotron 也接了，排在最后**（2026-10-06，用户要求：它虽然差，但占用最小，留作显存实在不够时的选择）。它的说明里写明了错字约 27%、短句有时整句漏掉。它和 Qwen3-ASR 走同一条路（`mode: 'offline'`，`openWindow`）：它本身是流式模型，但读一次只要零点一秒左右，另开一条流式的路省不了什么。它要的语言是地区代码（`ja-JP`、`pt-BR`），由 `languageLocale` 从应用的语言代码换算（`NEMOTRON_LOCALES`）：它认识的地区写法原样给，其余给这种语言最常用的那个。不让它自动识别语言：让它自己判断时，一段日语的开头几个词被写成了一个英文字母。许可是 OpenMDW-1.1。
- **省多少**：显存约 1.8 GB 对 3.0 GB（省三分之一多），每次识别快四分之一。省得不算多，是因为它的声音编码器和 1.7B 差不多大。
- **不用来自动识别语言**：让它自己判断时，韩、俄、英、日、中都对，但一段西班牙语被写成了半句葡萄牙语。所以它没有 `detects`，"自动识别对方说的语言"仍然只用 1.7B 或 API。
- **旁证**：微软 2026 年 4 月的论文 [Pushing the Limits of On-Device Streaming ASR](https://arxiv.org/abs/2604.14493) 比了 Whisper、Parakeet、Canary、Qwen3-ASR 等五十多种配置，结论是 Qwen3-ASR 1.7B 整段识别最准，而 Nemotron（英语版）最适合在 CPU 上连续流式识别。和这里的结果不矛盾：Nemotron 的长处是不间断的流，而应用是按句送的。

### 又轻又快的模型：SenseVoice-Small（2026-10-12）

给手机挑模型时量出来的（`.dev/android-spike/faster/RESULTS.md`、`.dev/android-spike/asr-llama/FINDINGS.md`）：它和 Qwen3-ASR 0.6B 一样准，却只有四分之一大、快好几倍。手机端先接了它（`feat/android-node` 分支的 `android/`，0.6.0），电脑端用同一个名字 `sensevoice-small-q8` 接进原生引擎。

- **模型**：[SenseVoice-Small](https://huggingface.co/FunAudioLLM/SenseVoiceSmall)（阿里 FunAudioLLM），用的是发布者自己给 audio.cpp 做的 GGUF：[FunAudioLLM/SenseVoiceSmall-GGUF-audiocpp](https://huggingface.co/FunAudioLLM/SenseVoiceSmall-GGUF-audiocpp) 的 `sensevoice-small-q8-audiocpp-v1.gguf`，254,211,200 字节，SHA-256 `4dedf169f625437fb336f2959674f399819729a765e184128c0e25a6e16ff0ec`，地址带提交号 `5c3fcfe748a8714216bc135476d5863084fddb72`（本机那份拷贝的大小和哈希 2026-10-12 重新算过，对得上）。audio.cpp 里的家族名是 `sense_asr`。和 Qwen3-ASR 不是一类模型：它一遍把整段写出来（CTC），不是一个字一个字往下写，所以不会"复读"，读一次也几乎不花时间。
- **走哪条路**：和 Qwen3-ASR 一样（`mode: 'offline'`、`openWindow`）：说话时把"到目前为止的声音"反复读，一句完了再读最后一遍；断句的参数也一样（`WINDOW_LIMITS`，满 8 秒找空隙重开）——它的错字率就是在这样切出来的句子上量的。
- **必须告诉它"整段读"**：audio.cpp 默认先用另一个模型（Silero VAD）按停顿把录音切开再读，应用没带那个模型，一读就失败。所以 `server.json` 里这个模型多一项 `"default_request_options": {"audio_chunk_mode": "none"}`（`MODELS` 里的 `requestOptions`；audio.cpp 的"请求参数默认值"，和 `session_options` 是两回事）。别的模型的配置一个字没变。
- **准不准**（2026-10-13 记在 FINDINGS.md；按本项目一贯的打分：假名读音的错字率，对照人工校过的参考）：把应用自己从 7 段真实日语闲聊里切出来的 59 段声音逐段交给引擎读——Qwen3-ASR 1.7B 16.9%，**SenseVoice-Small 20.3%**，Qwen3-ASR 0.6B 20.7%。59 段里它没有一段读成空的（Nemotron 的毛病是短句整句不出字，它没有）。所以：和 0.6B 分不出高下，比 1.7B 差三个多点。
- **多轻多快**（这台电脑，RTX 5070 Ti，2026-10-12，用应用自己的代码把引擎起在另一个端口上量的，没开应用界面）：
  - 显存：引擎进程加载完占 **约 0.27 GB**（Windows 性能计数器"GPU 进程内存·专用"，265 MB；`nvidia-smi` 在 Windows 上不报单个进程的用量），读 8～24 秒的句子时 0.28～0.31 GB，另一轮连着读了几十次长短不一的句子后到过 0.38 GB。对照：Nemotron 约 1 GB，Qwen3-ASR 0.6B 约 1.8 GB，1.7B 约 3 GB。卡片上写的是"约 0.4 GB"。进程的内存（工作集）0.14～0.23 GB。
  - 读一次：8.6 秒的一句 48～95 毫秒；边说边读时每次 26～226 毫秒（0.7～8.2 秒的声音）；24 秒约 0.1 秒。说完到定稿 38 毫秒。
  - 启动：加载加预热不到 2 秒（文件已在系统缓存里时）。
  - 不用显卡也能跑（`backend: cpu`）：8 秒的一句约 1.6 秒，24 秒约 5.3 秒，也就是 4.5～5 倍实时——用的是引擎服务默认的线程数，量的时候电脑上别的程序正占着显卡（整卡用量从 9 GB 涨到了 14.7 GB），处理器忙不忙没看；RESULTS.md 里用命令行、8 线程量的是 16 倍。应用现在总是用显卡，没有给它开"只用处理器"的开关。
- **只听五种语言**：中文、粤语、英语、日语、韩语（`languages`），语言用代码告诉它。给它别的语言它不会拒绝：当成"没说"，把法语硬写成这五种里的一种，看着像读出来了。所以别的语言的模型库和菜单里没有它；选着它、又要听俄语时，俄语那一行显示"未选择模型"，和 R2T2 遇到泰语时一样。
- **不用来自动识别对方的语言**（没有 `detects`）。它确实能在这五种里自己判断（实测不给语言，日语那一句照样写对），但"自动检测"的意思是对方说什么语言都行：对方说俄语时它没有办法说"这不是我会的"，只会写成五种之一，而且开着自动检测时这台电脑每一路都由这同一个模型来听。要给它开放，至少得：先量它在应用切出的句子上判断语言准不准；界面和说明把"只在这五种里判断"讲清楚（现在的文字是"对方说哪种语言都能识别"）；共享清单里给它加 `auto` 之前想好别的设备会怎么理解。没把握，所以不提供。
- **它会在日文、中文里加空格**：一句话里的一小段常常是一个词一个空格地写出来（实测「元 は 金持ち の 息子 でし たが。」；边说边读的 12 次里有 11 次带空格，同一句读完整时又没有）。显示前去掉（`native-engine.js` 的 `unspaced`，`openWindow` 的 `tidy`）：日文/中文字符之间、这类字符和数字之间的空格去掉；韩语的空格、拉丁字母单词之间的空格留着（日语里夹的英文单词也留着）。规则和手机端的 `Share.unspaced` 一字不差，所以同一段话电脑读和手机读出来一样；手机借给电脑时手机自己已经去过一遍，电脑这边（`remote-engine.js`）按模型名再去一遍，不依赖对方。
- **很少写标点**：闲聊时几乎不写，朗读得清楚时会写。"一句一译"靠的是句子中间的句号（`sentenceCut.ts`），所以用它时和 R2T2 一样，连着说的一长段要等说完才翻译——不会出错，只是没有这个好处。有一点和别的模型不同：它每一次读，末尾都带一个句号或问号（哪怕话才说到一半：「元は金持ちの息子でしたが今は？」）。断句的规矩本来就要求句号后面再说出一截话才算数，所以这种末尾的标点不会被当成一句的结束（`sentenceCut.test.ts` 里用它实际写出来的几次读法钉住了）。没有替它补标点。两句话之间它有时只写一个空格、不写句号，去空格后两句就连在一起了：空格大多数时候是词与词之间的，没法拿来当句号用。
- **安静的地方它可能写一个语气词**（比如「あ。」）。没有处理：应用送给它的是 VAD 判断"有人说话"的片段，太短的片段本来就不留。
- **下载**：只在 Hugging Face 上有，魔搭上没有这个文件（魔搭上发布者的 `FunAudioLLM/SenseVoiceSmall-GGUF` 是另一个文件，少了 audio.cpp 要的那段说明，2,880 字节的差别，没试过能不能读）。所以它和 R2T2 一样没有 `mirror`，国内靠 `hf-mirror.com`（从北京出口查过，能下）。
- **Windows 和 Apple 芯片的 Mac 都提供**（没有 `platforms`；2026-10-12 先只给了 Windows，第二天在 Mac 上跑过后放开）。先查的是 Mac 的引擎包里有没有这个家族：没有 Mac 也查得到一半——audio.cpp v0.9.0 的发布流程（`.github/workflows/release.yml`）里 macOS arm64 那一项用的是和别的平台同一组参数，没有限定模型（`AUDIOCPP_MODEL_SET` 默认 `full`），`CMakeLists.txt` 里 `sense_asr` 的登记也不分平台，所以**按构建配置它在包里**。但它在 Metal 上跑不跑得对，当时没人跑过：把它移植进 audio.cpp 的人只在处理器上验证过（它的说明 `docs/community_models/sense_asr-pr.md` 里写的是"CUDA/Metal/Vulkan 应该能用"，并把量显卡列为待办）；而同一个模型换一个显卡后端能不能跑不能想当然——手机上 audio.cpp 的 Vulkan 后端读 Qwen3-ASR 时在两台手机上都直接崩了。所以先只给了跑过的系统。
  - **Mac 上的实测**（2026-10-13，M2，应用装好的那个引擎包里的 `audiocpp_cli`，`--family sense_asr --backend metal --request-option audio_chunk_mode=none --language ja`，同一个 GGUF，SHA-256 对过）：朗读的那一句（`selfcheck-ja.wav`，8.6 秒）一字不差，0.29 秒读完（29 倍实时），Metal 和处理器一样；应用切出来的那 59 段在 Metal 上读、去掉词间空格后按同一套打分是 **19.9%，没有一段是空的**（Windows 上 Vulkan 是 20.3%）；命令行进程的内存峰值约 0.53～0.54 GB。
  - **Mac 上没跑过的**：验证的是模型本身（命令行），不是应用实际走的那条路——引擎的服务（`audiocpp_server`）加边说边重读。那条路用这个模型在 Windows 上跑过，在 Mac 上 Qwen3-ASR 一直在走。
  - Mac 上系统自带识别已经覆盖这五种语言且更准，它在 Mac 上的用处是 macOS 26 以下，或想省内存的时候。
- **许可**：原模型在 Hugging Face 上写的是 FunASR 的模型许可（`license: other`），魔搭上的原模型和这个 GGUF 仓库写的是 Apache-2.0。说法不一，记在这里。
- **用户看到什么**："语音识别 → 这台电脑"的模型库里，"推荐"一组（`LocalAIAssist.test.tsx` 里按真实渲染钉住）：
  - Windows：日语、中文、英语、韩语是 Qwen3-ASR 1.7B（带"推荐"）、R2T2、**SenseVoice-Small**、Qwen3-ASR 0.6B、Nemotron；粤语是 Qwen3-ASR 1.7B（带"推荐"）、SenseVoice-Small、Qwen3-ASR 0.6B。
  - Mac（macOS 26 及以上）：日语、中文、英语、韩语是 Apple Speech（带"推荐"）、Qwen3-ASR 1.7B、**SenseVoice-Small**、Qwen3-ASR 0.6B、Nemotron；粤语是 Apple Speech（带"推荐"）、Qwen3-ASR 1.7B、SenseVoice-Small、Qwen3-ASR 0.6B。系统没有自带识别的 Mac 上，开头就是 Qwen3-ASR 1.7B（带"推荐"）。
  - 它在哪个系统上都不会带"推荐"标记：它会的五种语言，排在它前面的模型都会，而且更准。别的语言（比如俄语）没有它的卡片。
  - 它的说明："最轻也最快：约占 0.4 GB 显存。日语闲聊实测和 Qwen3-ASR 0.6B 一样准，很少写标点。只支持中文、粤语、英语、日语和韩语。"不写"约 20%"：20.3 和 20.7 分不出高下，而 0.6B 的卡片上写的是更早那次量的"约 22%"，两个数字摆在一起会让人以为它准两个点。"约 0.4 GB 显存"是 Windows 上量的；Mac 上是约 0.5 GB 内存。因为它成了最轻的，Nemotron 的说明从"最省显存……只在显存实在放不下上面几个时再选它"改成"占用小……只在上面几个放不下、或者不支持要听的语言时再选它"。
- **手机借来的同一个模型**：手机借出的名字也是 `sensevoice-small-q8`。电脑现在认识这个名字了：语言照旧按代码告诉它（`saidFor`，和以前"不认识的名字"的做法结果一样），句子的长度限制从默认的 45/60/90 秒变成和这台电脑自己跑时一样的 8/8/24 秒（`localai.ts` 里按名字查 `limits`），也就是手机上的 Qwen3-ASR 一直在用的那一套。

### 审查之后（2026-10-06）

请一个独立会话把三个原生引擎的主进程一侧审了一遍（`electron/native-engine.js`、`native-engines.js`、`apple-speech.js`；报告在分支 `claude/tender-hypatia-q6at92` 的 `REVIEW-native-engine.md`）。下载校验和解压的安全性它确认没问题，问题集中在进程的生死和两处丢字。照它改的：

- **启动和停止不会再交叉**（报告的 M1、M12）。以前两次启动挨得很近（设置里点一下、会话同时开始）时会各起一个进程，只有后一个被记住，前一个占着几个 G 显存直到重启电脑；启动途中点停止也停不住。现在每次启动、停止都是一个"轮次"，等待中发现自己不是最后一轮的就让开；停止会等旧进程真的退出再继续（3 秒不退就强杀），所以换模型时新旧两份显存不再重叠，删除正在用的模型也不会因为文件被占用而失败。
- **应用非正常退出后不留进程**（M4）。应用崩溃或被任务管理器结束时，引擎是独立进程，会留下来继续占显存。现在启动引擎时把进程号记在引擎目录的 `run.json`，下次打开应用时如果那个进程还在、而且确实是这个引擎的程序，就把它结束掉；另外凡是经 `process.exit` 离开的路径（信号、未捕获的错误）也都会先停引擎。
- **解压到一半不算装好**（M2）。解压期间引擎目录里有一个 `.unpacking` 标记，解压完整才删掉；有标记就当没装，下次重新下载、清掉残留再解压。以前只看主程序在不在，解压中断后会一直显示"已就绪"但启动不了，界面上也没法修。老版本装好的引擎没有这个标记，照常使用。
- **Windows 用户名里有系统代码页之外的字时也能解压**（M7，实测确认）：系统的 tar 收到的路径参数会变成问号。在这台中文系统上建了一个带韩文的文件夹，原来的写法解压失败；改成先进到目标文件夹、用相对路径调用后成功。
- **翻译和语法引擎只回答应用自己**（M5）。llama.cpp 的服务以前不带密钥，而且对任何来源的网页都放行：电脑上浏览器里开着的任何网页都能扫到端口、借显卡跑东西。现在每次启动随机生成一个密钥（`--api-key`），随端口一起告诉页面，并关掉 `/slots`；实测不带密钥或带错密钥是 401，`/health` 和预检请求不受影响。启动时也不再把用户自己为 llama.cpp 设的环境变量（`LLAMA_*`）带进去。识别引擎（audio.cpp）没有密钥选项，但它默认不发跨域头，网页读不到它的回答。
- **防复读不再误伤正常重复**（M3）。以前"同一小段连续 8 次"就算复读：「1400000000人」「哈哈哈哈哈哈哈哈」「はいはいはい…」都会被截断，后面的话也丢了。真正的复读会一直写到上限，所以现在要求这一串**至少 40 个字、并且一直到结尾**。
- **轻声的最后一个词不再丢**（M8）。"最后一次重读之后只多了静音"的判断，以前是"比整段最响的地方低 20 dB 就算静音"：前面笑了一声，后面轻轻说的「…ね」就被当成静音。现在静音的上限封在约 −30 dB。
- **引擎被停掉时，正在进行的识别会被告知**（M9），页面不再对着已经没有的识别继续送声音、干等。Mac 自带识别同样。页面重新加载或崩溃时，引擎一并停掉（M11）——占用计数在页面里，页面没了就没人会去停它们。
- **Mac 上引擎不再一直低优先级**（M6）：非管理员进程降了优先级就升不回来，所以只在 Windows 上"加载时降、加载完升"。
- 小项：下载被服务器提前掐断时保留已下载的部分（以前会整个删掉重来）；超出预期大小的下载会被中止；取消一个模型的下载不再连带中止另一个模型正在下的引擎；模型名用不带原型的表查（`constructor` 不再被当成模型）；语言代码只接受字母；识别只交给被点名的那个模型；两半重读的结果在日文、中文之间不再多一个空格；一段声音最长 120 秒；引擎日志超过 5 MB 时从头写。
- **没改的**：端口探测和启动之间的空隙（极小，重试即可）、206 回应不核对范围（最后有哈希兜底，只是白下一遍）、校验哈希期间不能取消。

## Mac 自带的语音识别

macOS 26 起系统里有一个在本机运行的语音识别（`SpeechAnalyzer` + `SpeechTranscriber`）。日语 VRChat 闲聊实测它是所有识别方式里最准的。以前要通过 LocalAI 里的一个后端才能用到它；现在应用自己带一个小程序（`native/apple-speech/SpeechHelper.swift`，约 200 KB），直接调用系统的识别，Mac 上不再需要为此安装 LocalAI。

- **对应用的其余部分，它就是"原生识别引擎"**：主进程里 `electron/apple-speech.js` 回答的问题、返回的状态和 Windows 上的 `native-engine.js` 一模一样，所以页面的识别器（`nativeAsr.ts`）、设置卡片和就绪检查不需要区分。不同的只有：没有运行库要下载，也没有服务要启动，所以一问就是"就绪"；它的"模型"是系统的语言包，一种语言一个（`apple-speech:ja`、`apple-speech:en`……），由系统自己下载，应用只是请小程序去要（卡片上的"下载"）；每一路按它听的语言各用各的。
- **小程序怎么用**：每段话启动一次（启动约 0.2 秒），声音从标准输入进去，文字从标准输出出来，都是一行一个 JSON。它里面并排跑两个识别器：系统的识别器平时每十秒左右才写出定稿，要求"快速结果"时一秒内就写，但写得差一些，连最后的定稿也会变差（实测「お正月のイメージ」变成「お正のイメージ」）。所以快的那个只用来显示正在说的内容，认真的那个出最后保留的文字。两个识别器不能放在同一个分析器里——放一起快的就不快了。
- **断句**：定稿在一次识别进行中要晚十秒左右才来，一结束就全部写出，所以说满 10 秒后会在词与词之间的空隙结束这一次、马上开下一次（`localaiNative.ts` 的 `APPLE_LIMITS`）；不在 VAD 强行切开的地方结束，那是切在词中间（实测「すごい大きいやつ」被切成「すごく。」和「いやつ」）。"空隙"按最近的音量来算（低于最近音量的十分之一），所以有底噪的麦克风也能找到。
- **实测**（同样 7 段、在 M2 的应用里）：错字率 12.5%，文字平均落后 2.4 秒。通过 LocalAI 时是 14.1%、落后 5.4 秒。
- **支持的语言**：日语、英语、韩语、中文（普通话）、西班牙语、法语、德语、意大利语、葡萄牙语、印地语、粤语——系统提供哪些，就列出哪些。没有俄语。
- **和下载的引擎并存**（`electron/native-engines.js` 的 `joinEngines`）：Mac 上有两个原生识别引擎——系统自带的这个，和应用下载的 audio.cpp（跑 Qwen3-ASR，听系统不支持的语言）。主进程把两个合成一个来回答页面：模型列表是两边的合集，各自的下载、删除交给各自的引擎；"引擎是否就绪"折算进每个模型自己的状态；最后启动的那个算"正在运行"，先启动的那个不停掉（共享给别的设备的会话可能还在用它），十分钟没人用才停；每次识别带上模型的名字，按名字交给对应的引擎。实测（M2）：自己选 Apple 语音识别时，别的设备通过共享要俄语，由 Qwen3 回答；要日语，由 Apple 回答，互不打断。
- **构建**：小程序不提交二进制，由 `native/apple-speech/build.sh` 编译成一个小的 .app（系统只把识别能力给有 bundle 标识的程序），放到 `resources/bin/darwin-arm64/` 下，随应用一起打包、一起签名。CI 的 macOS 任务里在打包前编译它；需要 macOS 26 的 SDK，没有时脚本只提示、不失败，那一版应用就不提供这个识别器。
- **最多保留 5 种语言**（2026-10-27，用户问用户怎么知道自己到上限了）：系统只让一个 App 同时占用几种语言（`AssetInventory.maximumReservedLocales`，macOS 27 上是 5），满了再要一种会被拒绝，以前下载会报一句系统的英文错误，用一种没占着的已下载语言时会话开始不了。现在辅助程序在占用一种新语言前先腾位置（`SpeechHelper.swift` 的 `makeRoom`）：先放掉占着却没下载的，再放掉最久没用过的，正在识别的语言不放（`--keep`）。"最久没用"的顺序由应用记在 `userData/apple-speech-used.json`，每次识别和下载时更新，传给辅助程序（`--order`）。放掉不是删除，文件留到系统需要空间时才清，以后再用会自动重新占上。用户不用知道这个上限。实测（M2，用户的 Mac）：5 个名额满时识别一个已下载未占用的英语变体，放掉了没下载的韩语；再识别一个，放掉了排在最前面的那个；最后把测试用的变体放回，用户原来的中、英、日、西四种照旧占着。

## Native models and language identification

LAN sharing advertises downloaded native recognizers, native translators, and native feedback models (`nativeShare.ts`). Apple Speech is listed by installed language and advertises paired-language recognition. A recognizer that reports language detection advertises `auto`. The shared inventory does not scan browser model downloads or include a local LocalAI process.

### Best-effort language identification

The selected recognizer remains selected even when it cannot report the language. Kotomimi can infer the language from the transcript using script evidence and a text detector (`src/lib/language/script.ts`, `identify.ts`). The **Best effort** badge explains this limitation. It does not promise that a recognizer can transcribe languages outside its capabilities, and a more capable installed recognizer does not silently replace the user's selection.

Shared scripts do not uniquely identify a language: Cyrillic is not always Russian, Arabic script is not always Arabic, and Devanagari is not always Hindi. Short or uncertain text can remain unlabelled while translation continues. A selected two-language pair can provide additional evidence. A transcript identified as the user's own language on the participant source is shown without redundant translation.

### Apple Speech with two languages

Apple Speech can compare two installed language candidates for each audio source. This is a selected pair, not unrestricted detection. Each source has its own recognition sessions and language preference. Final transcript language drives translation and feedback routing; provisional text does not settle the language.

The same paired behavior is available over LAN when both sides support the protocol and the Mac has both languages installed. An unconfirmed or unsupported paired request fails rather than silently switching to one language. See [setup, mode table, and hardware validation](docs/apple-speech-lan.md).

### Translation direction and remote model reporting

A translator's advertised language pair must match every direction needed by the session. The reverse direction matters when **I speak the other language too** is enabled. Generic chat models and native translators retain their own capability rules.

The remote session reports the recognizer that actually serves each source. The UI displays it when it differs from the requested/default choice and clears it when the run ends. A stale remote name may be treated as automatic by the host; paired Apple Speech negotiation is checked explicitly. This remote host behavior is distinct from preserving an explicit local native selection.

## Native model library

The stage and sharing libraries list native models, including installed system speech assets on Mac. Browser model groups and custom ONNX import are no longer part of Kotomimi's stage UI. Recommendations and model descriptions belong to each native model. Stage downloads select their original target row; sharing downloads only make models available to other devices.

## 原生翻译引擎

和原生识别引擎是同一套管理代码（`createNativeEngine`），换了运行库和模型清单：运行库是 [llama.cpp](https://github.com/ggml-org/llama.cpp) b11401 的官方发行包里的 `llama-server`（Windows x64 是 Vulkan 版约 33 MB，Apple 芯片的 Mac 是 Metal 版约 12 MB），模型是三个翻译模型的 Q4_K_M GGUF，各自来自官方仓库的固定提交：

| 模型 | 大小 | 日语闲聊 30 句译成中文，严重错误 | 语言 |
|---|---|---|---|
| Index-Translate 2B（哔哩哔哩 Index 团队，Apache-2.0） | 1.25 GB | 约 3 句 | 一百多种 |
| Hunyuan MT 2 1.8B（腾讯，Apache-2.0） | 1.08 GB | 约 8 句 | 36 种 |
| Hunyuan MT 1.5 1.8B（腾讯） | 1.08 GB | 约 8 句，还喜欢自己加词 | 36 种 |

- Models are stored under `<userData>/native-translator/`. Download and select them in the translation stage library. Historical latency measurements depend on the model and hardware.
- **怎么问它**：它们是翻译模型，不是聊天模型，各有训练时用的固定句式，所以请求按模型写在 `nativeTranslators.ts` 里：只有一条用户消息，没有系统提示词。Index-Translate 用它模型卡上的中文句式（"请将以下日语文本翻译为中文，直接输出翻译结果，不要进行任何解释。"），语言用中文名，源语言是"自动检测"时省略；贪心解码，关闭思考。Hunyuan MT 一边是中文时用中文句式，否则用英文句式，采样参数用官方建议的。
- 请求走的就是"API 模型"那条聊天接口的路，只是地址是本机引擎的端口（每次启动随机选一个空闲端口，只监听 127.0.0.1）。所以翻译会像 API 模型一样边写边显示。
- Readiness checks downloaded model availability without starting an engine. Session preparation starts the selected native engine; its lifetime follows active use.
- 开着共享时，它的模型也共享给其他设备（见上一节）。
- **Hunyuan MT 1.5 不再提供下载**（`retired`）：它和 Hunyuan MT 2 支持的语言一样、大小一样，实测严重错误一样多，还会自己加词，没有哪一点比后者好。已经下载过的电脑上它的卡片还在，可以继续用，也可以删掉。
- **Index 团队的其他模型**（2026-10-05 看过）：Index-Translate 9B（Q4_K_M 5.8 GB）同样 30 句实测，译文更自然，但严重错误和 2B 一样多（各 3–4 句，错的地方不同），慢一倍、多占约 4 GB 显存，没有接。官方的带约束写法（`【源文】…【约束要求】`，加"口语闲聊"或前两句上下文）也试了，错误没有减少。不写源语言时译文几乎一样。Index-Echo（语音直接出译文）官方只支持中文作源语言；Homura（控制音节数）和 Nailong（长文档）用不上。

## 原生语法反馈引擎

Grammar feedback can run on another device, through an API, or in this computer's native feedback engine. The native feedback engine uses its own llama.cpp process, separate from translation, so both stages can serve the same session.

- **模型**：[Gemma 4 E2B](https://huggingface.co/google/gemma-4-E2B-it)（Google，Apache-2.0）的 Q4_K_M GGUF（[unsloth 的仓库](https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF)，固定提交号），约 3 GB，占显存约 1.5 GB。
- **怎么选出来的**（2026-10-05，`%TEMP%\ktasr\coach-bench.mjs`）：中文母语者说的日语 28 句，14 句有错（助词、时态、活用、自他动词、あげる/くれる……），14 句是正确的口语（省略助词、俗语、不带标点）。都跑在 llama.cpp 上（RTX 5070 Ti），提示词用下面说的新版：

  | 模型 | 错句抓到 | 正确的不误报 | 每句 |
  |---|---|---|---|
  | Gemma 4 E2B | 11/14 | 14/14 | 0.14 秒 |
  | Qwen3-4B Instruct 2507 | 6/14 | 14/14 | 0.10 秒 |
  | Qwen3.5-4B | 9/14 | 4/14 | 0.28 秒 |
  | Qwen3.5-2B | 8/14 | 5/14 | 0.18 秒 |
  | DeepSeek（deepseek-flash，API，关掉思考） | 14/14 | 14/14 | 0.9 秒 |

- **提示词也改了**（`coachPrompt.ts`）：原来的提示词下，小模型会把正确的口语当成错误来"改"（Gemma 14 句正确的只放过 5 句，Qwen3.5-4B 只放过 1 句）。加了一段"这是朋友之间的口头闲聊，省略、俗语、不完整的句子都是对的，拿不准就回 ✓"，并在示例里加了几句口语。这对所有跑法都生效，包括 API 模型。
- **DeepSeek 不先思考**（`apiServices.ts` 的 `quick`）：deepseek-flash 默认每次回答前先想七百多字，一句要 1.7–2 秒，偶尔 5–7 秒；请求里带上 `thinking: { type: 'disabled' }` 后约 0.9 秒，28 句的结果完全一样。翻译和语法反馈用 DeepSeek 时都自动带上。
- Native feedback uses the OpenAI-compatible chat endpoint on its local engine port and includes the configured prompt examples. Missing models and preparation failures are reported; native holds keep the engine available while in use.

### 不先思考（2026-10-06）

给引擎的每个请求都带 `temperature: 0` 和 `chat_template_kwargs: { enable_thinking: false }`（`nativeCoaches.ts` 的 `NATIVE_COACH_EXTRA`）。上面表里的 0.14 秒是这样测出来的，但应用里一直没有带：Gemma 默认先思考再回答，同一句话实测 1.8 秒（不思考 0.3 秒），回答长度有上限时还会因为思考把额度用完而返回空白。本机使用和共享给别的设备时都按测速时的配置来。

## 模型的下载源（2026-10-10）

模型原来只从 Hugging Face 下载，国内不开代理连不上（用户的朋友在国内）。现在每个模型多一个备用地址：魔搭（ModelScope）上的同一个文件（`native-engine.js` 里每个模型的 `mirror`）。

- **哪些有**：三个 Qwen3-ASR / Nemotron 识别模型、Index-Translate、两个混元翻译模型、Gemma 4 E2B，共七个。魔搭上的仓库是发布者自己的或对应的副本；2026-10-10 逐个对过，文件大小和 SHA-256 与这里记的完全一致。R2T2 在魔搭上没有（见下面"Hugging Face 的公开镜像"）；2026-10-12 加的 SenseVoice-Small 也没有（魔搭上发布者的那个仓库是另一个文件）。两个运行库见下面"运行库"。
- **先问哪个**：电脑的时区是国内的（`Asia/Shanghai` 等）先问魔搭，否则先问 Hugging Face。只是先后顺序，不是限制。
- **哪个快用哪个（2026-10-13）**：还差 16 MB 以上的文件（模型、运行库、更新的安装包），开始前把所有地址同时各试 1 MB（最多 6 秒，试下来的丢掉），从最快的那个开始下（`quickestFirst`，`electron/fetch-file.js`）；时区只决定一样快或都没答时谁在前。起因：朋友在国内开着代理想从 GitHub 更新，因为时区是国内的被排到中转后面，而那天中转很慢——慢的地址只要还在来东西就一直用它。实测（这台电脑直连，真实的 0.43.113 安装包）：gh-proxy.com 和 GitHub 约 2.4 MB/s，ghfast.top 0.9，ghproxy.net 0.3，2.4 秒试完。同一天从北京出口：gh-proxy.com 0.6–1.2 MB/s，ghfast.top 0.4–0.5，ghproxy.net 不到 0.1，GitHub 连不上（出口自己的带宽也就这么多，说明不了国内家里的线路）。
- **什么时候换**：一个地址 15 秒没有开始回答、回答了错误、回答的不是这个文件（一个网页、大小不对），或者一点没下到就断了，就换下一个，从已经下到的地方接着下（各处是同一个文件）。
- **断了自己续（2026-10-11）**：下到一半断了、或者半分钟没有新数据，不用人再点，自己向刚才那个地址要剩下的部分。所有地址都轮过两遍（第二遍每个等 45 秒）还一点没有进展才报错，报错里写着问过哪些地址、各自说了什么（例如 `ghfast.top: The download did not answer. · github.com: …`），朋友截图过来就能看出卡在哪。
- **运行库（2026-10-11）**：两个运行库（audio.cpp、llama.cpp）是 GitHub 发布页上的文件，国内常常下不动。用户的朋友第一次下翻译模型时卡在 0% 然后失败：模型之前要先下 llama.cpp 运行库。2026-10-12 从北京电信的出口实测（`.dev/tools/china-exit.ps1`）：GitHub 的运行库下载有时 30 秒连不上，有时连上了只有约 30 KB/s；Hugging Face 连不上；魔搭和前两个中转正常。同一个出口下，改过的应用从空文件夹下到了翻译和语法反馈各自的运行库（经中转）和模型（魔搭）。现在它们多了三个备用地址：公开的 GitHub 下载中转（`ghfast.top`、`gh-proxy.com`、`ghproxy.net`，`native-engine.js` 的 `GITHUB_RELAYS`），国内时区先问它们，别处最后才问。这些是志愿者办的服务，随时可能关：关了的代价是多等 15 秒，下一个接上。不信任它们的内容：下完同样核对 SHA-256，2026-10-11 三个中转下来的两个运行库都对得上。从北京出口看，`ghfast.top` 和 `gh-proxy.com` 快，`ghproxy.net` 慢（约 30 KB/s），所以排第三。想要一个不靠别人的国内地址，得在用户自己的魔搭账号下放一份。
- **国内移动网（2026-10-31）**：又一位朋友用移动网下不了，开代理才行；截图里五个模型全是 0%。那其实是模型之前的运行库：运行库在下时每张卡片都显示下载中，进度却是模型自己的，所以任何网络上第一次下载都看着不动。现在运行库的进度算在点的那个模型上，并写着「先下载运行环境」，其他模型暂时不能点。中转从三个加到六个（`edgeone.gh-proxy.org`、`ghfile.geekertao.top`、`gh.ddlc.top`，各自的 CDN 不同）。运行库仍然没有放在国内的源：魔搭上没有，新线路是否过得了移动网也没实测过（我们的出口是电信）。
- **不会下错**：不管从哪边来，下完都要核对大小和 SHA-256，不对就丢掉。镜像上的文件以后要是变了，代价是白下一次，不会装进一个错的模型。
- **Hugging Face 的公开镜像（2026-10-12）**：凡是 Hugging Face 上的文件，再多问一个 `hf-mirror.com`（同样的路径，志愿者办的镜像），排在魔搭之后。R2T2 在魔搭上没有，靠它才在国内下得到；从北京出口它答了 R2T2 的第一兆。同样只凭 SHA-256 收下。SenseVoice-Small 也是只靠它（同样从国内查过有这个文件）。
- **实现**：问谁、先后、等多久、断了怎么续，都在 `electron/fetch-file.js`（`pullWhole`）；`native-engine.js` 只管核对和改名。
- 用户不需要选，也没有新的设置。

### 应用自己的更新（Windows，2026-10-12）

安装包（约 190 MB）也在 GitHub 发布页上，原来用 Node 的 `https` 直接下：不走系统代理、没有超时、断了不能续、下完不核对就运行。从北京出口，GitHub 给它的速度是每秒约 30 KB 或者干脆不回应，所以国内等于更新不了。

- 现在和运行库一样下（`electron/update-download.js`）：走系统的网络设置，国内时区先问三个中转，断了自己续，中途关掉应用下次接着下。
- **安装包是要运行的，中转是陌生人**：下完必须和这一版 `latest.yml` 里写的大小、SHA-512 一致才留下、才运行；不一致就丢掉并报错。`latest.yml` 由更新检查直接从 GitHub 读，不经过中转。哪一版的 `latest.yml` 没写这两样，就只从 GitHub 下，和原来一样。
- 实测：真实的 0.43.111 安装包，前 8 MB 经北京出口从中转来，其余直连续上，整包校验一致。
- **没改的**：检查有没有新版本仍然只问 GitHub（小文件，北京出口时通时不通）；macOS 的更新走 electron-updater 自己的下载，没动。

### 国内仍然到不了的（2026-10-12 查过一遍）

- The retained upstream browser model library has its own Hugging Face download path. It is not part of Kotomimi's native stage or sharing library; the native mirrors described above apply to native models.
  - **提示**：电脑的时区是国内的时候（`farSource.ts`，和主进程排下载顺序用的是同一个判断），模型库里"其他模型"的标题下多一行：「这些模型存放在海外，下载可能很慢或失败。上面推荐的不受影响。」上面没有推荐模型时只有第一句。别处不显示。
  - **措辞（用户要求注意）**：只说会遇到什么，不说为什么，不提任何绕过的办法；不禁用任何按钮，有办法的人照样可以下。改这句话时保持这三条。
- **VB-CABLE**（虚拟麦克风的驱动，`download.vb-audio.com`）：能连上，但北京出口只有每秒十几 KB，约 1 MB 的包要一分多钟。
- OpenAI、Gemini 等国外的云服务：本来就要代理，不是应用能解决的。

## Models outside the native catalog

To use a model outside Kotomimi's native catalog, run it in an external compatible service and choose **API model** or **Another device** for the relevant stage. Kotomimi's stage UI no longer imports Transformers.js/ONNX Whisper models. The retained upstream browser inference implementation is separate from the desktop Kotomimi provider.

