# Kotomimi 手机端

把一台安卓手机借给电脑上的 Kotomimi 做语音识别。现在是第一步：**自检版**——下载模型，读一段固定的录音，告诉你这台手机跟不跟得上。还不能和电脑连。

识别引擎和电脑版是同一个（[audio.cpp](https://github.com/0xShug0/audio.cpp) 0.9.0），模型也是同一批文件。

## 给朋友测

1. 装上 `app-debug.apk`（要允许"安装未知来源的应用"）。
2. 下载一个模型（建议连 Wi-Fi；断了可以接着下）。
3. 点"开始自检"，等它读完，把报告分享回来。

报告里是这台手机自己的数字：芯片、内存、每种线程数读 14 秒录音用了多久、占多少内存、电池温度。不包含任何你自己的声音。

## 怎么看结果

倍速 = 一秒钟能读几秒的话。电脑版边听边出字，是把越来越长的同一段话反复读，所以：

- 4 倍以上：跟得上
- 2 到 4 倍：勉强
- 2 倍以下：跟不上

2026-10-10 在多亲 F22 Pro（联发科 MT6769，4 GB）上：Qwen3-ASR 0.6B 最快 0.5–0.7 倍速，占 2 GB 内存，跟不上。连着读手机会发热降速，同一次自检里排在后面的几次会偏慢。

## 自己编

要 Android Studio（带 SDK、NDK 和它的 CMake）。

```bash
# 1. 引擎：从 audio.cpp 的源码编出安卓版，放进 App 里（约十分钟，不进 git）
android/scripts/build-engine.sh

# 2. 安装包
cd android && ./gradlew assembleDebug
```

安装包在 `android/app/build/outputs/apk/debug/app-debug.apk`。

引擎带齐了 ggml 给安卓准备的七档处理器版本（armv8.0 到 armv9.2），运行时自己挑这台手机能用的最快一档，所以同一个安装包在旧手机和新手机上都不吃亏。只用处理器；手机显卡（Vulkan）还没接。

从电脑上直接让手机跑一遍自检：

```bash
adb shell am start -n io.github.rizumu85.kotomimi.node/.MainActivity --ez selfcheck true
adb shell cat /sdcard/Android/data/io.github.rizumu85.kotomimi.node/files/report.txt
```

## 还没有的

- 和电脑连接（发现、传声音、回文字）。
- 小样里的样子（`.dev/phone-node/`，杏橙薄荷那一版）：现在只用了它的颜色。
- Nemotron 和 R2T2：引擎里已经编进去了，App 里还没列出来。
- 手机显卡、持续运行（前台服务、发热后的速度）。

自检用的录音是 LibriSpeech 里的一段英文朗读（CC BY 4.0），随 audio.cpp 的源码一起来。
