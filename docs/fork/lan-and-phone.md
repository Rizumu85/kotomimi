# Another device, and the phone

## 共享的安全加固

2026-10-06 请一个独立会话对共享功能做了一次安全审查（报告在分支 `claude/friendly-thompson-3mdnzx` 的 `REVIEW-lan-security.md`），设想的对手是同一网络里不可信的设备，以及浏览器里打开的网页。下面是照它改的，和权衡后没改的。都在 `electron/lan-server.js`，测试在 `electron/lan-server.test.js` 的"who is turned away"和"what a socket may make it hold"两组。

改了的：

- **网页进不来**。以前每个回答都带 `Access-Control-Allow-Origin: *`，也不看请求的 `Origin` 和 `Host`：局域网里任何人在浏览器里打开的任何网页都能读模型列表、开识别会话、发翻译请求。现在带 `Origin` 且不是应用自己页面（`file://`）的请求一律 403，不再有通配的跨域头；`Host` 必须是 IP、`localhost`、不带点的主机名，或以 `.local`、`.lan` 这类只在本地网络存在的后缀结尾——用一个公网域名指过来（DNS 重绑定）的请求 403。实测过应用自己的页面发出的请求：HTTP 不带 `Origin`，WebSocket 带 `Origin: file://`，所以已经发出去的旧版本客户端不受影响。
- **只接本地网络的来客**。服务仍然监听所有网卡（这样 VPN 也能用），但对方地址必须是本机、私有网段、链路本地地址、VPN 常用的 100.64/10，或 IPv6 的私有段；公网地址 403。
- **暂存有上限**。这台电脑上有 LocalAI 时，一个新连接在"归谁管"决定之前，它发来的消息会先存着；以前不限量，一个连接几秒钟就能让主进程涨到 900 MB。现在最多存 8 MB，超了就以 1009 关闭；决定最多等 15 秒，超时就交给页面处理。转给 LocalAI 的那条路上的排队也同样封顶。
- **一台设备最多 4 个连接**（总数仍是 6）：一台设备占不满全部名额。
- **不说话的连接会被关**：连上 30 秒内没有发 `session.update` 的，以 1008 关闭。
- **密钥不能无限试**：同一个地址一分钟内给了 10 次错的密钥，接下来这一分钟一律 429。没带密钥的请求不计数（别的设备搜索时就是不带密钥来问的）。比较密钥改成先各自取哈希再定长比较，长度也不从耗时里漏出去。
- **报错里不带本机路径**（`src/lib/lan/protocol.ts` 的 `withoutPaths`）：模型加载失败之类的消息会转给对方设备，其中的文件路径（里面有用户名）换成"…"。

权衡后没改的：

- **防火墙规则不限定程序**（报告的 F6）。安装器每次更新都把应用装进新的 `app-版本号` 文件夹，程序路径每版都变；规则要是绑定程序，每次更新后都得再弹一次管理员确认。保持按端口放行，只对专用/域网络，公共网络仅限本地子网。
- **没带密钥也告诉对方这台电脑的名字**（F7）。别的设备搜索时靠它在列表里显示"某某的电脑（需要密钥）"，去掉就只剩一个 IP；而电脑名在局域网里本来就是公开的。
- **没设密钥就是谁都能用**（F11）：有意如此，不设默认密钥是用户定的。上面几条把"谁"限定在了本地网络里的程序。
- 搜索时对找到的设备做反向域名查询（F10）：影响很小，没动。

### 两个审查 issue 的收尾（2026-10-06）

[Rizumu85/kotomimi#2](https://github.com/Rizumu85/kotomimi/issues/2) 和 [#4](https://github.com/Rizumu85/kotomimi/issues/4) 是 10 月 4 日的两份审查。逐条对过当时的代码：大部分早已修掉，这次补上剩下的，然后关闭。

这次补的：

- Shared requests are served by native models. If no suitable native translator is available, the request is refused; neither local Kotomimi sessions nor LAN sharing fall back to online Bing translation.
- **正在回答的翻译模型不会被第四个挤掉**（#2 低-8）：只在没人用的模型里腾位置。
- **读不到 LocalAI 的帮助时仍然告诉它监听地址**（#2 低-5），否则它会监听所有网卡。
- **共享端口只能是 1024 以上**（#2 中-3），主进程自己也检查。
- **访问密钥只留能发送的字符**（#2 低-2）：密钥要放进 WebSocket 的子协议里，带空格、斜杠或中文的密钥检查能过、开始必败。
- **应用启动的 LocalAI 在所有退出路径上都会被停掉**（#2 低-4 的一部分；应用被强杀时仍会留下）。
- **会话里的两句提示改对**（#4 第 12 条）：打字的句子没翻译出来，说的是"有一句打字没能翻译"，不再是"此方向没有翻译模型"；语法反馈失败说的是"有一句话没有得到语法反馈"，不再是"一次翻译失败"。为此加了两个诊断代码（`typed_translation_failed`、`feedback_failed`），契约的 `text-input-answered` 规则认前一个。
- **向导里的模型数和设备列表一致**（#4 第 18 条）：不把 Kotomimi 自己的管线条目算作模型。
- **词典加载失败会留下一条诊断**（#4 待确认项）：以前只是不显示注音，没有任何记录。
- **几处措辞**（#4 第 17 条）："听日语"改成"识别日语"，"实时管线"改成"那台设备上的配置名称"。

没做的，和原因：

- **旧设置迁移后重跑向导会清空指定的模型**（#4 第 16 条）：只影响 10 月 3 日之前装的版本，现在已经没有这样的安装。
- **默认不设访问密钥**（#2 高-2、#4 第 7 条）：用户的决定；已经把能连进来的限制在本地网络的程序，网页进不来（见上一节）。
- **防火墙规则不限定程序**（#2 低-7）、**没带密钥也说电脑名**（#2 中-1 的后半）：见上一节"权衡后没改的"。
- **搜索结果可以被冒充、局域网上明文传输**（#2 中-2）：局域网内的设计取舍，没有改。
- **另一台设备中途消失要等连接超时才发现**（#4 待确认项）：连接没有心跳。要做得在共享的一方定时发消息、客户端计时，是一个单独的功能，没做。
- "VAD 设置"、自定义模型的几句提示、英文名里的 Pipeline：没有改。

## 手机借给电脑做识别（2026-10-10，测试中）

一台安卓手机可以把它的识别引擎借给这台电脑（手机端在分支 `feat/android-node` 的 `android/`）。手机上跑的是和这台电脑下载的同一个引擎（audio.cpp）、同一批模型，对外回答的也是引擎自己的那个请求：一段声音，整段读一遍。

- **怎么连**：提供商页最上面「另一台设备」里点搜索，手机会和共享的电脑一起列出来（手机图标，标着"手机 · 语音识别"，下面是它的地址和借出的模型），点一下就连上了。搜索除了 8790、8080 之外多搜一个 8792（手机的端口，`electron/lan-discover.js` 的 `PHONE_PORT`），按回答里的 `X-Kotomimi-Node: engine` 认出是手机。
- **点了之后设置变成什么（2026-10-12 改）**：手机只借识别，所以只改语音识别这一个环节，翻译和语法反馈原样不动；「另一台设备」的地址也不动（那是各环节共用的那台）。语音识别卡片显示的就是「另一台设备」，下面多一行「设备」：共用的那台，和搜到的手机，选哪台用哪台；再下面是手机借出的模型（只读，手机上选）。设置里是 `asrVia: 'server'` 加 `asrOther`（手机的地址）和 `asrOtherModel`；`asrOther` 空着就是共用的那台。
  - **用户的话（2026-10-12）**：「手机虽然能在另一台设备搜索到但目前是 api 模型自动填。应该是在另一台设备里也显示，然后多个设备的话就能自己选」。原来点了手机，卡片跳到「API 模型」并替人填好地址和模型名——从"另一台设备"里选的东西变成了一个要懂的表单。
  - **里面怎么走**：卡片之后的一切仍然把它当一个 API 读（`localai.ts` 的 `settled` 把它换成 `asrVia: 'api'` 加手机的地址；`localaiDevice.ts` 的 `hearingPlace`）。所以检查、会话的搭建、边听边出字都是原来那条路，没有第二套。
  - **只有语音识别有"自己的设备"**：手机现在只借识别。翻译和语法反馈在「另一台设备」时仍然是共用的那台；两台电脑各管一个环节目前选不了。（2026-10-14 起翻译和语法反馈也可以在手机上，见下一节。）
  - **旧设置**：0.43.110 到 0.43.112 里点过手机的，设置还是「API 模型」加手机地址，照常能用；再点一次手机就换成新的样子。没有自动改写：端口猜出来的"这是手机"会让人切不回「API 模型」。
  - 搜不到时仍然可以在「API 模型」里自己填地址。设置向导里不列手机：向导问的是一台能做全部环节的设备。
- **模型以手机当时借出的为准**：会话开始时问到手机现在借的是哪个模型，就用哪个，不管当初记下的是哪个（手机的主人可能换过）。
- **怎么认出是手机**：会话开始时问一次那个地址的模型列表，回答里带 `X-Kotomimi-Node: engine` 就是（`src/lib/native/remoteEngine.ts` 的 `isEngineNode`）。不带的、没回答的、不是 `http://` 的，都照原来当作普通 API：一句话说完上传一次。
- **是手机时**：和本机的原生引擎走同一条路——边说边出字。说话时把"到目前为止的这一段"反复交给手机重读（主进程的 `openWindow`，原样复用，只是把请求发到手机的地址：`electron/remote-engine.js`）；断句、防复读、一句一译、多久重开一次识别（`WINDOW_LIMITS`）都和本机一样。多久重读一次跟着"上一次读了多久"走，所以慢的手机只是刷新得少，用户看到的就是那台手机自己的速度，不是这边定的速度。
- **和本机不同的一处**：一段话结束后等最后一次读完的时间，从 15 秒放到 60 秒。比说话慢的手机读完一段要更久；按本机的等法，等不到就只留下第一次读到的半句（2026-10-10 在 0.5 倍速的手机上看到：二十秒的话只留下「ゲームは、 like」）。
- **手机内存不够放下所选的模型时（2026-10-23，F22 实测）**：4 GB 的手机能腾出约 1.4 GB，Index-Translate 2B 要 1.5 GB，手机每句都回 503，电脑这边以前什么都不说。现在按手机列表里的 `memory_mb.available` 加上它正在用的引擎占的（识别模型、已加载的文本模型）算出它现在能给多少（`discover.ts` 的 `phoneRoom`，和手机自己的 `Share.ensure` 同一个算法），每个模型带上 `fits`：选手机时默认挑放得下的（`lentChoice`），卡片的下拉里放不下的标「（手机内存不够）」，开始前的检查对放不下的说「手机现在内存不够运行 X，请换一个小一点的模型」（`phone_model_too_big`），会话中手机回内存不够时提示一次（`phone_no_memory`）。同一台手机两边都在用时，"没有回应"只提示一次。
- **手机中途没回应时（2026-10-23）**：锁屏或切到后台后，有些厂商的系统会把手机端冻住，发过去的识别、句子要等满超时（一两分钟）才失败，屏幕上什么也不说。现在会话进行中每 5 秒问一次用到的每台手机（识别、翻译、语法反馈）的模型列表（`src/providers/openai/phoneWatch.ts`），连续两次没回答就提示一次「手机没有回应，可能锁屏后被系统暂停了。在手机上打开 Kotomimi 就能继续。」（`phone_quiet`）；它回答过之后再断才会再提示。会话本身不动，手机打开后接着回答。
- **手机的访问密钥（2026-10-23）**：手机默认不设密钥，同一 Wi-Fi 下的设备都能用；主人在手机「设置」里可以生成一个 6 位密钥（`android/` 的 `DoorKey`，0.9.1 起），之后每个请求都要带 `Authorization: Bearer <密钥>`，不带的回 401，但回答里照样有 `X-Kotomimi-Node: engine` 和名字。电脑的搜索因此把它列成"需要访问密钥"的手机（`electron/lan-discover.js` 的 `readAnswer`）；点它，在搜索下面输入密钥，密钥按手机地址存在设置里（`src/lib/lan/phoneKeys.ts`，`settings.lan.phoneKeys`），再搜一次，搜到就像点了它一样用上。之后去这台手机的请求都带上它：搜索、识别（上传和主进程的边听边读 `remote-engine.js`）、翻译和语法反馈（`textModel.ts`）、开场预热（`phoneText.ts`）、没回应的检查（`phoneWatch.ts`）。
- **实测（2026-10-10）**：没有快手机，用"假手机"测的——这台电脑的引擎放在和手机一样的小门后面，每次读都拖到"那个速度的手机该用的时间"才回答（`.dev/tools/fake-phone.mjs`）。同一段 20 秒的日语（前 17 秒是一整段不停的话）：

  | 手机的速度 | 第一次出字 | 文字变化次数 | 第一句译文 | 最长一次读 |
  |---|---|---|---|---|
  | 不放慢（这台电脑的显卡） | 5.3 秒 | 28 | 18.5 秒 | 0.5 秒 |
  | 4 倍速 | 7.0 秒 | 16 | 25.3 秒 | 4.2 秒 |
  | 2 倍速 | 5.5 秒 | 14 | 29.1 秒 | 8.4 秒 |
  | 1 倍速 | 7.7 秒 | 12 | 47.6 秒 | 16.9 秒 |

  各档读出的文字都完整。慢在哪：每次重读的是整段，段越长读得越久，所以长句子后半截的字会落后几秒；说完才有的译文要再等最后一次读完。
- **真手机**：多亲 F22 Pro（0.5 倍速，4 GB 内存）接通了、第一次出字正常，但读到十几秒的长段时手机内存不够，系统把手机端杀掉了（`LOW_MEMORY`）。这台手机本来就跟不上，只说明链路是通的。
- **还没做**：手机中途没了时，界面上只是那一句停在半截，没有明说；手机没有访问密钥。

## 手机借给电脑做翻译和语法反馈（2026-10-14，测试中）

手机端 0.8.0 起还借出这台电脑自己的三个文字模型（Index-Translate 2B、Hunyuan MT 2 1.8B、Gemma 4 E2B，同样的文件，手机上由 llama.cpp 在处理器上跑；手机端的说明在 `android/README.md` 的"翻译和语法反馈"）。电脑这边，翻译和语法反馈现在也可以把手机当作自己的「另一台设备」，和语音识别一样。

- **怎么认出来**：手机的模型列表里，识别模型在 `data`，文字模型在另一栏 `text`（`kind` 是 `translate` 或 `coach`，`loaded` 说它现在装没装入）。搜索把 `text` 一起带回来（`electron/lan-discover.js` 的 `textModels`，`src/lib/lan/discover.ts` 的 `FoundServer.text`）；只借文字模型的手机 `data` 是空的，也照样列出来。搜索结果里标着它能做什么，比如"手机 · 翻译、语法反馈"，下面是借出的模型名。0.7.x 及以前的手机没有 `text`，和以前一模一样。
- **设置**：`translateOther` / `translateOtherModel`、`coachOther` / `coachOtherModel`，和 `asrOther` / `asrOtherModel` 一样：环节在「另一台设备」、`*Other` 填了手机的地址，就在那台手机上；空着就是共用的那台。没有迁移，默认都是空。
- **卡片**：翻译和语法反馈的卡片在「另一台设备」时，搜到借这种模型的手机就多一行「设备」（共用的那台在前，手机在后），下面是「模型」：手机借出的这种模型里选一个，只借一个时就只显示它。选手机时先挑这台电脑自己的排序里最好的、并且能翻这对语言的（翻译是 Index-Translate 在前）。手机的翻译模型不支持这对语言时，卡片下面说一句（和这台电脑的原生翻译一样）。
- **在最上面的搜索里点手机**：手机能做的、而且现在放在「另一台设备」的环节都交给它；放在 API 或这台电脑的不动。语音识别和以前一样，不管原来在哪都交给手机（它借识别的话）。只借文字模型的手机点了以后哪个环节都没变的话，把翻译交给它（没有翻译模型就是语法反馈）。理由：在「另一台设备」里点一台设备，意思就是"另一台设备是它"——点共用的电脑时，所有在「另一台设备」的环节也都跟着走。
  - 朋友遇到的情况（2026-10-14）：语音识别在手机上，翻译和语法反馈还停在默认的「另一台设备」，那个地址已经连不上，最上面就一直说"这个地址连不上……"并给出"改连那台设备的 Kotomimi"。现在只要再点一次手机，翻译和语法反馈就跟过去了；没有环节用共用的那台时（全在手机、API、这台电脑上），那句话和按钮都不出现，也不要它的地址（`needsServer`）。
- **请求是这台电脑原生引擎的那一个**：翻译按那个模型自己的问法（`translatorRequest`：Index 的、Hunyuan 的，含 Hunyuan 带上一句的那种），语法反馈是 `coachPrompt` 的说明加例句和 `NATIVE_COACH_EXTRA`，只是地址换成手机的（`localai.ts` 的 `buildLocalAI`，阶段带 `phone: true`，**不带 `engine`**——带了会去问这台电脑自己的引擎在哪个端口）。手机借出这台电脑不认识的模型时，按 API 的样子问（通用的说明）。`settled` 不改写它们：只有语音识别的手机被读成 API。
- **检查**：问手机的 `/v1/models`，看 `text`（不看 `data`，那里是识别模型）。连不上说"手机（地址）连不上……"（`phone_unreachable`，识别在手机上时也用这句）；手机现在没借出选的那个模型说"手机（地址）现在没有借出……"（`phone_model_gone`）；模型不支持这对语言用卡片那句（`phone_translator_unfit`）。
- **慢的手机**：第一次问一个模型时手机才装入（弱手机 12 到 17 秒，内存紧时到 40 秒左右），而且一次只做一件事（识别和文字排同一个队）。所以：
  - 给手机的一次回答最多等 120 秒（这台电脑自己的是 60 秒；手机自己的上限是 3 分钟）（`phoneText.ts` 的 `PHONE_TEXT_TIMEOUT_MS`）。
  - 429（忙）和 503（现在内存不够）按回答里的 `Retry-After` 等一会儿再问，最多再问 3 次，都在那 120 秒里（`textModel.ts` 的 `busyRetries`）。只对手机这样，别的服务器和 API 不变。
  - 会话开始时，手机说还没装入（`loaded: false`）的模型先问一句只要一个字的话，让它开始装入（`warmPhones`）；不等它，会话照常开始，第一句在手机的队里排在它后面。语法反馈的这一句带着说明和例句，和真请求开头的几条消息一字不差（有测试守着），手机读过一遍就留在它唯一的槽里，第一句真话只读那一句。朋友的天玑 9500 上量到（2026-10-14，手机自检发的就是电脑版的这个请求）：Gemma 装入 4.6 到 5.2 秒，第一次请求 8 秒才出第一个字（488 个词元的说明，每秒约 60 个），第二次 0.5 秒；所以预热把这 8 秒挪到了会话开始。Index-Translate 一句 1.5 秒，装入 3.5 秒，预热省的是装入。
- **验证（2026-10-14）**：真手机这次没接上（USB 上没有，局域网里也没有在共享），所以用一个照手机小门写的替身（`.dev/tools/scratch/fake-text-phone.mjs`：127.0.0.1:8792，同样的模型列表、同样改写请求和拒绝方式，后面是这台电脑在处理器上跑的 llama-server）在测试窗口里走了一遍：搜索列出"手机 · 翻译、语法反馈"；两张卡片选它；检查通过；会话开始时两个预热请求发出去了；打字"今天天气真好，要不要一起去散步？"译成"今日は天気がいいですね、一緒に散歩に行かない？"（1.1 秒，请求就是 Index 自己的问法）；说"昨日はとても寒いです。"（合成的语音）拿到反馈"昨日はとても寒かったです。"加一句中文说明（3.2 秒）；替身关掉后检查说"手机（127.0.0.1:8792）连不上……"。
- **还没验证的**：真手机上的翻译（多亲 F22 Pro 这次没接上）；语法反馈在任何手机上都没跑过（Gemma 在 4 GB 的手机上不借）。
- **已知限制**：检查对同样的设置会沿用上一次"可以开始了"的回答（`providerStore` 的做法，对所有设备和 API 都一样），所以手机中途关掉共享后，要等设置有变化才重新问；会话里那几句会各自报翻译失败。

## Using another device and sharing with other devices

**Another device** delegates a stage to a remote host. **Share with other devices**, under the advanced Provider settings, makes this computer's installed native models available on the LAN. These are independent choices: local session stage locations do not control which models are shared.

### Sharing setup and ownership

- Download the desired native models in the sharing library and enable sharing. Keep Kotomimi running. The default port is 8790; clients use the host's address and access key.
- The client chooses the requested language, model, and segmentation settings. The host controls installed model availability and the access key.
- Apple Speech language assets, native recognizers, translators, and feedback models can be advertised. No browser models or managed LocalAI models are advertised or proxied.
- The title bar indicates when sharing is enabled and when clients are using it. Native engines are prepared when requested and managed by native engine lifetime/hold rules; listing a model does not load it.
- Sharing-library downloads do not change the host's own session model choices.

The server retains its access-key checks, LAN restrictions, connection limits, and idle-session handling. The existing security section describes these separately. Sharing models is also separate from the upstream browser-based caption-sharing feature.

### Protocol

The model list and capabilities identify shared Kotomimi models and their supported stages/languages. Realtime transcription can name a recognizer; translation and feedback use chat requests with their respective model capabilities. Paired Apple Speech sessions negotiate both languages and report the final transcript language. Translation models may declare directional capabilities. The host reports the model actually used when resolving a request.

External LocalAI-compatible servers remain supported directly as remote/API services. Kotomimi no longer provides a LocalAI management card, rewrites a locally managed LocalAI pipeline, or forwards its models through the sharing port.

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
- 两边都可以用下面的实机测试来确认对方的改动没有破坏约定。

