<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="Kotomimi：听懂对方说的外语，并且字幕带假名注音；可选择混搭本地模型、局域网的另一台设备或任意 API，用于识别语音、翻译文本以及语法纠正">
</p>

<p align="center">
  <a href="https://github.com/Rizumu85/kotomimi/releases/latest"><b>下载最新版</b></a>
  · <a href="#三步上手">三步上手</a>
  · <a href="#两台设备一起用">两台设备一起用</a>
  · <a href="#english">English</a>
</p>

<p align="center">
  <img src="./assets/readme/session.png" width="100%" alt="一次真实的会话：说一句中文，得到汉字上方带假名的日语译文">
</p>

## 这是什么

Kotomimi（ことみみ）是一个实时语音翻译应用：你或对方开口说话，屏幕上马上出现原文和译文。它是 [Sokuji](https://github.com/kizuna-ai-lab/sokuji) 的个人分支，为"跟日本人聊天、顺便学日语"这件事加了几样东西：

- **读得懂的字幕**：日语汉字上方标假名，日语、韩语、俄语下面可以加一行罗马音。
- **字幕窗口**：点右上角「字幕」，窗口变成一条字幕：对方最新的一句和译文是主角，下面一行小字是你自己那句和它的语法反馈。字的大小和每一行的位置是固定的，说得再长也不会缩小或跳动；窗口高度跟着字号走，也可以自己拉小。字幕有四种样式可选：深色底、淡底柔影、无底亮字黑边、无底暗字白边。工具条上还有一个"穿透"按钮，打开后鼠标点得到字幕下面的游戏。
- **自己决定模型在哪运行**：语音识别、翻译、语法反馈是三个环节，各自可以在这台电脑、局域网里另一台设备、或任意 API 上运行，随便混搭。
- **两台设备一起用**：一台电脑出力，另一台设备直接用它的模型。
- **打字也能翻**：会话中按 `Ctrl+K`，打一句母语，得到对方语言的译文。
- **语法反馈**：自己说对方的语言时，会告诉你这句话说得对不对、该怎么改。
- **丰富的字体自定义**：界面、拉丁字母、每种语言的正文和注音，分别选电脑上装的字体。

Sokuji 原有的功能和云服务提供商（OpenAI、Gemini、Soniox 等）都还在。

## 三步上手

1. **下载安装。** 到 [Releases](https://github.com/Rizumu85/kotomimi/releases/latest) 下载：

   - **Windows**：`Kotomimi-x.y.z.Setup.exe`。安装包没有代码签名，Windows 会提示"未知发布者"：点"更多信息"，再点"仍要运行"。
   - **macOS（Apple 芯片）**：`Kotomimi-x.y.z-arm64.dmg`。没有经过 Apple 公证：拖进"应用程序"后，第一次要右键点应用，选"打开"。

2. **跟着向导走。** 只有四步：界面语言、用途、语言、完成。向导结束后，引导会带你下载一个语音识别模型，然后就能用。翻译默认用在线翻译，不用下载。

   向导默认让一切都在这台电脑上运行。想换个去处，随时在设置里改：
   - 家里另一台电脑已经在共享模型：在环节卡片里选"另一台设备"，它会自己搜出来，点一下就连上。
   - 想让家里别的设备也用这台电脑的模型：打开设置里的"共享给其他设备"。

3. **点"开始会话"，开口说话。**

不需要注册账号，也不需要 API 密钥。

## 每个环节各选各的

一句话从说出口到变成译文，要过语音识别和翻译两个环节；想练口语时，还可以打开语法反馈。设置里每个环节一张卡片，都有同样的三个去处，用哪个模型也在同一张卡片里选：

<p align="center">
  <img src="./assets/readme/places.png" width="335" alt="提供商下面每个环节一张卡片：语音识别、翻译、语法反馈各自在另一台设备、API 模型、这台电脑之间选，模型也在卡片里选">
</p>

| 去处 | 是什么 | 适合 |
|---|---|---|
| **另一台设备** | 局域网里开了共享的 Kotomimi，或 LocalAI 这类模型服务器 | 这台电脑配置一般，家里有台更好的 |
| **API 模型** | 任何 OpenAI 兼容的接口：识别用 `/v1/audio/transcriptions`，翻译和语法反馈用 `/v1/chat/completions` | 想用云端的大模型 |
| **这台电脑** | 应用自己下载的模型，模型库就在卡片里，可以完全离线 | 不想依赖别的设备和网络 |

各个环节可以选不同的去处。比如上图：这台电脑负责听，翻译交给另一台设备上的模型。

## 两台设备一起用

<p align="center">
  <img src="./assets/readme/two-devices.svg" width="100%" alt="一台电脑打开共享，另一台设备选另一台设备后自动找到它并使用它的模型">
</p>

1. 在**出力的电脑**上：打开设置，切到高级布局，在"提供商"页最下面打开"共享这台电脑的模型"。卡片上会显示这台电脑在对方列表里的名字。
2. 在**另一台设备**上：在设置的"另一台设备"一栏里点搜索，应用会把局域网里找到的设备列出来，点一下就连上；然后在想交给它的环节卡片里选"另一台设备"。

要点：

- 两台设备要连着同一个 Wi-Fi 或路由器，出力的电脑上应用要开着。
- Windows 防火墙挡住时，共享卡片里会出现黄色提示和一个"允许"按钮，点它，再在 Windows 的确认窗口里点"是"。
- 语言、用哪个模型、断句灵敏度，在**使用的那台设备**上设置。出力的电脑只决定有哪些模型可选，对方选了哪个，它才加载哪个。
- 搜不到时（比如改过端口），可以手动填卡片上显示的地址。

## 还有这些

<details>
<summary><b>边听边出字的识别引擎</b></summary>

<br>

应用自带的识别模型要等一句话说完才出字。在"语音识别 → 这台电脑"的模型库里，最上面带"推荐"的是 **Qwen3-ASR 1.7B GGUF**：点下载（约 2.4 GB），应用会自己把运行它的引擎也装好，下载完自动启用，不需要另外安装任何东西。

- 文字边说边出，一般只比声音慢 1 秒左右；日语闲聊实测错字率约 16%，比应用自带的模型都准。支持 30 种语言。每个模型名字旁的 ⓘ 里写了实测结果，可以对着选。
- 说话时显示的是"暂定"文字，最后几个字可能还会变；一句话说完（连着说时最多 15 秒）就定稿并翻译。
- 对方连着说好几句时，不用等他说完：每说完一句就先翻译这一句（"翻译"卡片里的"一句一译"，默认开，可以关）。这要识别模型边听边写标点，Qwen3-ASR 可以。
- 需要独立显卡，约占 3 GB 显存。显卡忙不过来时（显卡不强，或同时开着游戏）只是文字刷新得慢一些。模型只在会话中占显存：点"开始会话"时加载（开机后第一次约半分钟，之后每次几秒），结束一分钟后释放。
- 只有一台电脑、同时还要开 VRChat？用最下面的 **Qwen3-ASR 0.6B GGUF**（约 1.1 GB）：显存从约 3 GB 降到约 2 GB，错字多一些（约 22%），其他都一样。
- 显存连 2 GB 都腾不出来时，最下面还有 **Nemotron 3.5 ASR 0.6B GGUF**（约 0.9 GB，占约 1 GB 显存）：错字更多（约 27%），短句有时会漏掉。
- 它下面还有一个 **Confucius4 R2T2 GGUF**（只在 Windows）：写出来的字不会再改，但显卡忙不过来时文字会越落越远；偶尔会有十几秒不出字、然后一口气补上的情况。一般用上面那个就好。
- 想让它提前准备好，可以在设置的"启动"里打开"登录 Windows 时在后台启动"（默认关）：开机后 Kotomimi 不弹窗口地在后台待命（右下角通知区域有它的图标，点一下显示窗口，右键可以退出），并把模型预先加载一遍，这样第一次开始会话就不用等那半分钟。
- Mac（macOS 26 及以上）在最上面显示的是 **Apple Speech**：系统自带的语音识别，实测是最准的，同样边听边出字，不占显存；语言包由系统下载，点一下"下载"就行。系统不支持的语言（比如俄语）用它下面的 Qwen3-ASR 1.7B GGUF。有了这两个，Mac 上不需要再装 LocalAI。

这些原生引擎的模型，在打开共享后也会共享给局域网里的其他设备；对方没有指定模型时，优先用它们。

对方说什么语言不确定时，把「翻译语言」里 **对方的语言** 选成 **自动检测**：对方说日语、韩语、英语、俄语……都能识别并翻成你的语言，不用手动切换；你自己说的话翻译成下面"翻译对方主要说的语言"里选的那种。需要 Qwen3-ASR 1.7B GGUF（装在这台电脑或代听的那台设备上都行）或一个 API 识别模型。对方说的就是你的语言时，原样显示，不重复翻译。

开着语法反馈练口语时，中途说一句自己的语言也没关系：这句不会被拿去挑语法，而是直接翻译成对方的语言。

语法反馈也有同样的做法："语法反馈 → 这台电脑"的模型库最上面是 **Gemma 4 E2B**（约 3 GB），几乎即时给出反馈，不需要 API。用 DeepSeek 等 API 模型会更准一些，但每句要等一秒左右。

翻译也有同样的做法："翻译 → 这台电脑"的模型库最上面是 **Index-Translate 2B**（约 1.3 GB，一百多种语言），点下载后应用自己装好运行它的引擎。实测它比应用自带的翻译模型翻得更准，一句话只要 0.1 秒左右。这个在 Windows 和 Apple 芯片的 Mac 上都能用。

</details>

<details>
<summary><b>这台电脑上装了 LocalAI</b></summary>

<br>

有些模型不归应用自己运行，比如 Apple 的语音识别、MLX 模型、GGUF 翻译模型。它们可以由同一台电脑上的 [LocalAI](https://localai.io) 来跑。电脑上装了 LocalAI 时，设置里会多一节"这台电脑上的 LocalAI"：

- 启动和停止由 Kotomimi 来做，可以设成随应用启动，应用退出时一起停。
- 它只在这台电脑上监听，不对局域网开自己的端口。别的设备只能通过 Kotomimi 的共享用到它的模型。
- 打开共享后，它的模型和应用自己下载的模型一起共享出去：同一个开关、同一个地址，别的设备在自己的环节卡片里就能选到。
- 不会把所有模型都加载起来：对方选了哪个才加载哪个；换下来的识别模型如果没人在用就立即卸载，其余模型空闲 10 分钟后自动卸载。
- 这台电脑自己也能用它的模型：某个环节选"这台电脑"时，模型下拉里多一项"LocalAI"，选了它，下面就能挑 LocalAI 里的模型。
- 可以选别的设备没指定模型时用哪个识别模型、哪个翻译模型。
- 安装和删除模型仍然在 LocalAI 自己的页面里做，卡片上有链接。

没装 LocalAI 的电脑看不到这些，不影响任何别的功能。

</details>

<details>
<summary><b>阅读辅助和字体</b></summary>

<br>

- **假名注音和罗马音**在对话区右上角的显示设置里开关。注音在本机用词典和规则算出来，不调用任何模型，也不联网。
- **字体**在设置的"字体"里选：界面字体、拉丁字母和罗马音的字体，以及每种语言的正文字体和注音字体。拉丁字体只作用于拉丁字母和数字，不会盖掉中文、日文的字体。

</details>

<details>
<summary><b>已经知道的限制</b></summary>

<br>

- "Kotomimi 自由搭配"只出文字，不合成语音。需要语音输出时，用 Sokuji 原有的提供商。
- 内置的 SenseVoice 模型识别日语时会漏掉假名。日语建议用 Whisper，或在"自定义模型"里添加 `onnx-community/kotoba-whisper-v2.2-ONNX`。
- 识别走 API 时，文字要等一句话说完才出现，没有逐字更新。
- macOS 版只有 Apple 芯片的构建，而且不能自动更新，新版本要手动下载。
- 这是个人分支，更新节奏和功能取舍以自用为准。

</details>

## 想了解细节

- [FORK.md](FORK.md)：这个分支加了什么、各环节怎么搭配、和服务器之间的约定、怎么构建和发布。
- 遇到问题：[提交 issue](https://github.com/Rizumu85/kotomimi/issues)。请不要去打扰 Sokuji 官方，这个分支的问题不是他们的。

## 致谢与许可

Kotomimi 建立在 [Kizuna AI Lab](https://github.com/kizuna-ai-lab) 的 [Sokuji](https://github.com/kizuna-ai-lab/sokuji) 之上，绝大部分代码是他们的工作。本仓库沿用同一份许可：[AGPL-3.0](LICENSE)。各模型和依赖的许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

## English

Kotomimi is a personal fork of [Sokuji](https://github.com/kizuna-ai-lab/sokuji), a live speech translation app. It adds what its author wanted for talking with Japanese speakers while learning the language:

- **Subtitles you can read**: furigana over Japanese kanji, and an optional romanization line under Japanese, Korean and Russian.
- **Stages you place yourself**: speech recognition, translation and grammar feedback each run on this computer, on another device on your network, or on any OpenAI-compatible API, in any mix.
- **Two devices together**: one computer shares the models it has downloaded; another device finds it on the network and uses them, downloading nothing.
- **Text while they speak**: a recognition engine the app downloads and runs itself (audio.cpp with Qwen3-ASR 1.7B, thirty languages, and its small 0.6B sibling for a computer that runs a game beside it; on Windows also Confucius4 R2T2) writes about a second behind the voice, with nothing else to install. Translation has one too (llama.cpp with Index-Translate 2B), on Windows and Apple-silicon Macs. On a Mac (macOS 26 or later) the first recognizer is the system's own speech recognition, built in, with Qwen3-ASR behind it for the languages the system does not hear — no LocalAI needed.
- **Typed lookups** (`Ctrl+K`), **grammar feedback** on your own speech, **fonts** chosen per language, and the languages you switch between **pinned** to the top of the language menus.

**Install**: download from [Releases](https://github.com/Rizumu85/kotomimi/releases/latest). The Windows installer is not code-signed, so Windows warns about an unknown publisher; the macOS build (Apple silicon) is not notarized, so right-click the app and choose Open the first time. Then follow the setup wizard and pick "Kotomimi Pipeline". No account and no API key are needed.

**Limits**: the Kotomimi provider is text-only; the built-in SenseVoice model drops kana in Japanese (use Whisper); recognition through an API shows text only when a sentence ends.

Everything else — how the stages combine, the wire contract, building and releasing — is in [FORK.md](FORK.md) (Chinese). Sokuji is the work of [Kizuna AI Lab](https://github.com/kizuna-ai-lab); this fork keeps its license, [AGPL-3.0](LICENSE). Please report this fork's problems [here](https://github.com/Rizumu85/kotomimi/issues), not upstream.
