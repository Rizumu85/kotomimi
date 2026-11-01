# Kotomimi 手机端

把一台安卓手机借给电脑上的 Kotomimi 做识别、翻译或语法反馈：电脑把声音或文字传过来，手机读完传回去。电脑那边怎么用手机，见 [lan-and-phone.md](../docs/fork/lan-and-phone.md)。

## 模型

| 列表里 | 引擎 | 大小 | 说明 |
|---|---|---|---|
| 识别 · SenseVoice-Small | audio.cpp | 254 MB | 最小最快，只听中文、粤语、英语、日语、韩语 |
| 识别 · Qwen3-ASR 0.6B | audio.cpp 或 llama.cpp | 1.1 GB / 0.9 GB | 两行是两份文件 |
| 识别 · Qwen3-ASR 1.7B | audio.cpp 或 llama.cpp | 2.4 GB / 2.3 GB | 两行是两份文件 |
| 翻译 · Hunyuan MT 2 1.8B | llama.cpp | 1.1 GB | 和电脑版同一个文件 |
| 翻译 · Index-Translate 2B | llama.cpp | 1.2 GB | 和电脑版同一个文件 |
| 语法反馈 · Gemma 4 E2B | llama.cpp | 2.9 GB | 和电脑版同一个文件；4 GB 的手机放不下 |

[audio.cpp](https://github.com/0xShug0/audio.cpp) 0.9.0 是电脑版用的引擎；[llama.cpp](https://github.com/ggml-org/llama.cpp) b11401 在手机处理器上读 Qwen3-ASR 快一倍左右。两个引擎都只在处理器上跑（见"量过、去掉了的三种"）。

## 给朋友测

1. 装上 `app-debug.apk`（要允许"安装未知来源的应用"）。只用这样装一次，以后 App 自己更新。
2. 下载模型，建议连 Wi-Fi。听的是那五种语言就先下 SenseVoice-Small；只想借给电脑，Qwen3-ASR 下 llama.cpp 那一行就够了。在国内不用开代理：App 开始时各试一小段，哪个来源快用哪个，分四路下，断了自己接着下，下完核对。
3. 自检之前：拔掉充电线，关掉省电模式，电量在一半以上；刚下完模型先放几分钟，让手机凉下来。
4. 点"自检"，把手机放在桌上别动，别切到别的 App，别锁屏。读完把报告分享回来。报告里只有这台手机的数字和两段自带录音读出的字，没有你的声音。
5. 跟得上的话，点"开始共享"，照下面"和电脑连接"试一次真的。

每个识别模型的每个引擎读 5 遍，翻译和反馈模型每个 4 遍，每遍之前都等手机凉下来，所以时间大半花在等上：快的手机十几二十分钟，慢的手机和全部模型都下了要半小时以上。

## 怎么看自检结果

**识别**看倍速，一秒钟能读几秒的话，越大越好。电脑版边听边出字，是把越来越长的同一段话反复读，所以 4 倍以上跟得上，2 到 4 倍勉强，2 倍以下跟不上。

**翻译和语法反馈**看秒，越小越好。这几条线是暂定的：

- 翻译：一句话从发出到写完，1.5 秒以内跟得上，4 秒以内勉强。
- 语法反馈：第二句起等第一个字，3 秒以内跟得上，8 秒以内勉强。第一句要读完整段说明，写在报告里，不拿它下结论。

- 斜杠两边是先后两遍。读错的那一遍不算成绩：和录音说的比，错的超过二十分之一就算读错。
- 带 `*` 的那一遍是等了 3 分钟还没凉下来就读的。凉下来是指回到开始时的 3°C 以内，或 20 秒不再降，而且系统不再说手机热。
- 放不下的模型只有一行"没测"和原因。
- 报告最后的"共享用的是"写着现在借哪个模型、为什么，屏幕上那句"跟得上 / 跟不上"说的也是它。

自检录音有两段：英文是 LibriSpeech 的一段朗读（14.2 秒，CC BY 4.0），随 audio.cpp 的源码来，由 `build-engine.sh` 放进安装包；日语是 LibriVox 朗读的芥川龙之介《杜子春》中的一句（8.6 秒，公有领域，[来源](https://archive.org/details/toshisyun_um_librivox)第 1 个文件 29.75 秒起），在 `app/src/main/assets/selfcheck-ja.wav`。

## 三台手机量到的

| | 多亲 F22 Pro（MT6769，4 GB） | 天玑 9500 | 骁龙 8 至尊版 |
|---|---|---|---|
| Qwen3-ASR 0.6B | llama.cpp 1.05 倍，audio.cpp 0.58 倍 | | llama.cpp 7.17 倍，audio.cpp 4.41 倍 |
| Qwen3-ASR 1.7B | | llama.cpp 2.7 倍，audio.cpp 1.3 倍 | llama.cpp 3.32 倍，audio.cpp 2.17 倍 |
| SenseVoice-Small | 3.1 倍，装入半秒，占 0.3 GB | | 24.2 倍 |
| 翻译一句 | Hunyuan 5.6~8.4 秒，Index-Translate 8.4~10.2 秒 | Index-Translate 1.5 秒 | Hunyuan 0.7 秒，Index-Translate 0.8 秒 |
| 语法反馈 Gemma 第二句起等第一个字 | 放不下 | 0.5 秒 | 0.3 秒 |

准不准不在手机上量：同一个模型读同一段声音，在哪台设备上写出来的字都一样，两个引擎差不到一个百分点。59 段真实日语对话按假名读音的错字率：Qwen3-ASR 1.7B 16.9%，SenseVoice-Small 20.3%，Qwen3-ASR 0.6B 20.7%。

## 量过、去掉了的三种

| | F22 Pro（Mali-G52） | 天玑 9500 | 骁龙 8 至尊版（Adreno 830） |
|---|---|---|---|
| 显卡（Vulkan） | 两个引擎都崩 | llama.cpp 0.9 倍（处理器 3 倍），audio.cpp 崩 | 两个引擎都崩 |
| KleidiAI | 快 4~8% | 慢 25~27% | 1.7B 快 17%，仍不到 4 倍 |
| OpenCL | 后端不收 Mali | 用不了 | 能读，比处理器慢 41~52% |

没有一种让哪台手机借出更好的模型，所以都不进安装包。`scripts/build-llama.sh vulkan kleidiai-v82 kleidiai-v86 opencl` 仍能编出来，App 不认，要再量就用 adb 推到手机上手动跑。

## SenseVoice-Small

- 毛病：标点写得少；只有安静或杂音时会写出"あ。"之类的字；刚开口的头一秒会乱猜，下一遍改过来。
- 来源：Hugging Face 的 [FunAudioLLM/SenseVoiceSmall-GGUF-audiocpp](https://huggingface.co/FunAudioLLM/SenseVoiceSmall-GGUF-audiocpp) 和镜像 `hf-mirror.com`。魔搭的 `FunAudioLLM/SenseVoiceSmall-GGUF` 是另一个文件，少了 audio.cpp 要的模型说明，没试过能不能读。
- 许可证各处写的不一样，这里只照抄：Hugging Face 的原模型是 `license: other`，指向 FunASR 的 [MODEL_LICENSE](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE)；魔搭的原模型 `iic/SenseVoiceSmall`、App 下载的 GGUF 仓库和魔搭的 GGUF 仓库都写 Apache-2.0。

## 和电脑连接

手机和电脑在同一个 Wi-Fi 下。手机上点"开始共享"，等它显示"等电脑连上"和地址，比如 `192.168.1.23:8792`，之后可以锁屏，通知栏里能停。有的系统会冻结锁屏的 App，电脑会提示手机没回应。

电脑上：设置 → 提供商，最上面「另一台设备」里搜索局域网，点列出来的手机。搜不到时（比如路由器不让设备互相访问）手填：语音识别 → 「API 模型」，地址 `http://<手机地址>/v1`，模型填手机报的名字。手填是一句话说完才出字，搜到的是边听边出字。

手机默认谁都能用。要设访问密钥在 App 的设置里，电脑第一次连时会问。

**借出去的是哪个识别模型**：点一下哪一行就借哪一行，会记住，之后只能点别的行换。没点过时手机自己挑：

- 自检过：在读得对的模型里，借跟得上（4 倍以上）的里面最准的，同一个模型借快的那个引擎。一个也跟不上就借最快的：字来得晚，比字差一点更糟。
- 没自检过：借最小的那个，同一个模型借 llama.cpp 那一行。
- 最准的次序是定死的：1.7B、SenseVoice-Small、0.6B。自检之后才下载的模型不算在内，点它那一行或再自检一次。

翻译和反馈模型不用选，下载好的共享时都借出去，电脑要哪个按名字问，第一次问时才装入。

## 手机对外提供什么

端口 8792，故意不用电脑共享的 8790。接口和错误码见 [lan-and-phone.md](../docs/fork/lan-and-phone.md)。引擎只听手机本机（识别 8793，文字模型 8794 起，每次启动一把新钥匙），外面的请求都经过这层小门（`Share.kt`、`Chat.kt`），不把请求原样转给引擎：

- 网页发来的请求、用公网域名指过来的请求都拒绝。设了密钥时，除了手机的名字什么都不答。
- 手机一次只做一件事，识别和文字排同一个队：两个引擎同时干活时线程比核多，llama.cpp 又是空转等对方，会慢几十倍。同时最多接 12 个请求；文字请求连正在答的最多 4 个，再来回 429。等的电脑走了就不做，答到一半走了引擎马上停。
- 声音：只收 WAV，llama.cpp 最长 90 秒，audio.cpp 最长 30 秒（它占的内存跟着声音长度涨），太长回 413。空的 WAV 回空字。
- 文字：请求最长 256 KB，最多 64 条消息，所有文字最多 8000 个字，只能是纯文字。小门照读到的重写一份，只带模型名、消息、`stream`、`max_tokens` 和电脑版自己会发的那几样参数，别的（`grammar`、`tools`、`id_slot` 等）全丢掉。最多写 1024 个词元，一次回答最长 3 分钟。回给电脑的也是小门自己写的，引擎的版本号之类不往外说。
- SenseVoice-Small：引擎启动时就告诉它整段读，不然 audio.cpp 要用另一个没带的模型切段。语言不是那五种时小门回 400：audio.cpp 不报错，会把法语硬写成这五种之一。小门还去掉它写在日语、中文里的空格。
- llama.cpp 读 Qwen3-ASR：它没有这个接口，小门当成一次对话来问，替模型写好回答开头的语言（短句差别很大），按声音长度限制写多长（96 + 每秒 12 个词元），只把 `<asr_text>` 后面的字传回去。
- llama.cpp 的上下文定死：自检 1024，共享 2048，文字模型 4096。不定的话按 65536 留内存，4 GB 的手机会被系统杀掉。读过的东西不另存（`--cache-ram 0`），否则最多存到 8 GB。

## 内存怎么分

`Share.ensure` 按当时的内存来，所以小手机轮流装，大手机都留着。每个模型记着引擎自己占、系统拿不回去的内存（`Model.holdsMb`，MB）：

| SenseVoice-Small | 0.6B audio.cpp | 0.6B llama.cpp | 1.7B audio.cpp | 1.7B llama.cpp | Hunyuan MT 2 | Index-Translate | Gemma 4 E2B |
|---|---|---|---|---|---|---|---|
| 250 | 1870 | 1300 | 4000（估的） | 3200（估的） | 1210 | 1541 | 3250（估的） |

- 旁边还有别的引擎时，起完要剩 400 MB，不够就停最久没被问过的那个，再算。旁边没别的了，够它自己占就起。
- 文字模型把别的全停掉还不够：什么都不停，回 503。识别模型是主人要借的：别的都停了还不够也照样起。
- 被停掉的引擎下次问到再装入。系统说内存紧了、开着的引擎不止一个时，先停最久没问的。
- 整台手机放不下的模型（它占的数加 1 GB 比总内存大）：不借，也不给下，那一行写"这台手机内存不够"。

`adb logcat -s share` 看得到每一次。

## 应用自己的更新

打开 App 时自己查，一天最多一次；右上角"检查更新"随时可以点。有新版本时最上面多一行，点"更新"就下载、核对、交给系统，系统问过之后才装，装完要自己再打开一次。第一次更新要先在系统那一页允许这个 App 安装应用。正在共享时不会自己开始装，因为装的时候共享会断；要点"安装"才装。装不上时这一行写原因，括号里是系统给的名字。

国内各家系统（MIUI / HyperOS、ColorOS、OriginOS、HarmonyOS）对 App 自己发起的安装各有各的拦法，没试过。有 Google 服务的手机可能弹"Unsafe app blocked"，要点"More details"里的"Install anyway"。

**版本放在哪**：GitHub `Rizumu85/kotomimi` 的发布，全都标成**预发布**。仓库的"最新发布"是电脑版的，手机端绝不能是"最新"。

- 每个版本：标签 `phone-vX.Y.Z`，一个文件 `Kotomimi-phone-X.Y.Z.apk`。
- 固定标签 `phone-latest`，里面只有 `phone.json`，每次发布换掉它。已经装出去的 App 只认这个地址，这个发布不能删，标签不能改名。

```json
{"version":"0.7.0","code":11,"apk":"https://github.com/Rizumu85/kotomimi/releases/download/phone-v0.7.0/Kotomimi-phone-0.7.0.apk","bytes":69390606,"sha256":"…64 个十六进制字符…","sdk":28,"notes":"一句话，说这一版有什么"}
```

`code` 比手机上的大才算新版本。`apk` 必须在这个仓库的发布下面。`sdk`（最低安卓版本）和 `notes`（只取第一行，最多 40 个字）可以不写。App 不认识的字段一律不管；要改得连老版本都读不了，就换个文件名，别动 `phone.json`。

**从哪儿问、从哪儿下**：GitHub 本身，加三个公开中转 `ghfast.top`、`gh-proxy.com`、`ghproxy.net`，手机在国内时中转排前面。`phone.json` 四处同时问，带一个每小时变一次的 `?t=…`：中转先说有更新的版本就信它，"没有新版本"要 GitHub 自己说才算；它没答，就取中转里版本最高的，不会比上次知道的更旧。安装包和模型一样，各试 1 MB，哪个快用哪个。

**谁在保护用户**：是安卓，不是 App。系统只在新安装包和已装的是**同一个签名**、版本号不更低时才肯覆盖。中转没法让手机装上别的东西，最坏只是白下一次。交给系统前照样核对 SHA-256。

**签名**（重要）

- 所有安装包都用**这台电脑的 debug 密钥**签：`%USERPROFILE%\.android\debug.keystore`，证书 SHA-256 是 `0d0db733ff8d3558a71935b3d43a564ef2a6d95ecf939cc4ecff8fc65c68d19f`。
- 更新只能覆盖同一个密钥签的那一份，所以每个版本都必须用这个密钥编。
- 密钥丢了或换了（重装系统、换电脑、删了 `.android`、改成正式签名），所有人都得卸载重装，下载好的模型也跟着没了。值得备份这个文件。
- `scripts/publish.sh` 会核对签名，不是这个密钥签的就拒绝发布。

**发布**：改 `app/build.gradle.kts` 的 `versionCode`（每次加一）和 `versionName`，以及 `SelfCheck.kt` 里的 `BuildConfigLite.VERSION`，两处不一致脚本会拒绝。

```bash
cd android && ./gradlew assembleDebug
android/scripts/publish.sh --notes "一句话，说这一版有什么"         # 只说它要做什么
android/scripts/publish.sh --notes "一句话，说这一版有什么" --yes   # 真的发布
```

它核对版本和签名，写出 `phone.json`，建 `phone-vX.Y.Z` 预发布，再更新 `phone-latest`。这些情况它不做：这个版本发布过而安装包不一样；GitHub 上已是更高版本；`android/` 有没提交的改动；当前提交没推到 GitHub。断了可以再跑，已经对的不会重传。

**不发布也能试**：debug 版从自己私有文件夹的一个文件读测试地址，只有 `adb shell run-as` 写得进去，地址只能是 `http://127.0.0.1:端口/…`。设了时"检查更新"旁边多"· 测试"，每次打开都查。

```bash
# 手机上装的版本号要比它低
node android/scripts/update-test-server.mjs android/app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:23456 tcp:23456
adb shell "run-as io.github.rizumu85.kotomimi.node sh -c 'mkdir -p files && echo http://127.0.0.1:23456/good/phone.json > files/update-test'"

# 试完收拾
adb shell run-as io.github.rizumu85.kotomimi.node rm files/update-test
adb reverse --remove tcp:23456
```

`good` 换成别的就是别的情况：`slow`、`hash`、`stale`、`future`、`sdk`、`garbage`、`hang`，别的词是 404。换了地址要把 App 切到后台再切回来。

## 自己编

要 Android Studio（带 SDK、NDK 和它的 CMake）；Windows 上还要 Visual Studio 的 C++ 编译器（显卡后端的着色器要用它编一个小工具）。

```bash
android/scripts/build-engine.sh   # audio.cpp，十几分钟，不进 git
android/scripts/build-llama.sh    # llama.cpp，十几分钟，要能连 GitHub，不进 git
cd android && ./gradlew assembleDebug
```

安装包在 `android/app/build/outputs/apk/debug/app-debug.apk`，约 37 MB。不跑第 2 步也能编，只是没有 llama.cpp。

- audio.cpp 带齐 ggml 的七档处理器版本，运行时自己挑。Vulkan 后端会编出来但不打包，留在 `.engine/build-arm64-v8a/`。
- llama.cpp 是六个独立程序：自检用的 `llama-mtmd-cli` 和共享用的 `llama-server`，各有 v80、v82、v86 三档。App 按处理器的指令集挑，一跑就报"非法指令"就退一档。它的 `libggml*.so` 和 audio.cpp 的同名不同版，放不进同一个文件夹，所以编成不带库的单个程序。

```bash
adb shell am start -n io.github.rizumu85.kotomimi.node/.MainActivity --ez selfcheck true
adb shell cat /sdcard/Android/data/io.github.rizumu85.kotomimi.node/files/report.txt
adb shell am start -n io.github.rizumu85.kotomimi.node/.MainActivity --ez share true     # false 是停止
adb shell am start -n io.github.rizumu85.kotomimi.node/.MainActivity --ez update true    # 查新版本
adb logcat -s share    # 或 update

# 不经 Wi-Fi 从电脑问手机
adb forward tcp:18792 tcp:8792
curl http://127.0.0.1:18792/v1/models
adb forward --remove tcp:18792

# 这一次借指定的一行，不改记住的选择；llama.cpp 的带 llama- 前缀
adb shell am start -n io.github.rizumu85.kotomimi.node/.MainActivity --ez share true --es model llama-qwen3-asr-0.6b-q8

# 先用 llama.cpp 的某一档，看退档那条路
adb shell am start -n io.github.rizumu85.kotomimi.node/.MainActivity --ez share true --es llama v86
```

## 还没有的

- 识别引擎读长段时的内存：4 GB 的手机读十几秒的长段可能被系统杀掉，起引擎前的内存检查只管文字模型。
- 大内存手机上三种模型一起放着没试过，两个 1.7B 和 Gemma 占多少内存是估的。
- 文字模型换更适合手机的文件或引擎（Q4_0、LiteRT-LM、MNN）。
- Nemotron 和 R2T2 已编进引擎，App 里没列出来。
- 点过一行之后改回"让手机自己挑"。
