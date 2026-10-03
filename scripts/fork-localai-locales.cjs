#!/usr/bin/env node
/**
 * Fork: writes this fork's strings into every locale catalog — the LocalAI
 * Realtime provider's under `providers.localai`, the reading aids' under
 * `fork`. Idempotent — run it again after a rebase onto upstream that
 * touched `src/locales`:
 *
 *   node scripts/fork-localai-locales.cjs
 *
 * English everywhere but the two Chinese catalogs, so the catalogs stay in
 * lockstep with `en` (`src/locales/locales.consistency.test.ts`).
 */
const fs = require('node:fs');
const path = require('node:path');

const EN = {
  provider: {
    name: 'LocalAI Realtime',
    description: 'Your own LocalAI server on the network · text only · stages chosen apart',
    endpoint: 'Server address',
    endpointPlaceholder: 'Server address, e.g. 192.168.1.10:8080',
    translateKey: 'API key of the translation model',
    coachKey: 'API key of the feedback model',
    modelTooltip: 'The Realtime pipeline model, exactly as your server names it. The server\'s list only suggests: what you type is what runs.',
    asrModelTooltip: 'The speech-recognition model that writes the source text. Leave it to the server unless you want another of its models.',
    asrModelServer: 'Server default',
    translateStage: 'Translation',
    translateStageTooltip: 'What answers speech. The server\'s own pipeline does everything in one session. A text model lets you run recognition on the server and translation anywhere that speaks the OpenAI chat API: another machine, Ollama or LM Studio on this one, or a hosted API.',
    viaServer: 'The server\'s own pipeline',
    viaModel: 'The text model below',
    textBaseUrl: 'Address of the text model\'s server',
    textBaseUrlPlaceholder: 'Blank: the same server · or e.g. http://localhost:11434/v1',
    textModel: 'Text model',
    translateModelPlaceholder: 'Model name, e.g. hy-mt2-1.8b',
    needsKey: 'This server needs an API key',
    coachStage: 'Grammar feedback',
    coachStageTooltip: 'For when you speak the other side\'s language yourself. Your speech is not translated: a model checks it and answers ✓, or the corrected sentence and why. What you type is still translated.',
    coach: 'I speak the other side\'s language: check my grammar',
    coachModelPlaceholder: 'Blank: the translation text model',
  },
  fork: {
    furigana: 'Furigana over kanji (Japanese)',
    romanization: 'Romanization (Japanese, Korean, Russian)',
  },
};

const ZH_CN = {
  provider: {
    name: 'LocalAI Realtime',
    description: '局域网内自建的 LocalAI 服务 · 仅文本 · 各环节可分开指定模型',
    endpoint: '服务器地址',
    endpointPlaceholder: '服务器地址，例如 192.168.1.10:8080',
    translateKey: '翻译模型的 API 密钥',
    coachKey: '语法反馈模型的 API 密钥',
    modelTooltip: 'Realtime 管线模型，名称与服务器上的一致。服务器的列表只作提示：填什么就运行什么。',
    asrModelTooltip: '生成原文的语音识别模型。保持服务器默认即可，除非想换成服务器上的其他模型。',
    asrModelServer: '服务器默认',
    translateStage: '翻译',
    translateStageTooltip: '由谁来翻译语音。选服务器管线，识别和翻译都在同一个会话里完成。选文本模型，服务器只负责识别，翻译交给任何支持 OpenAI 聊天接口的地方：另一台机器、本机的 Ollama 或 LM Studio、云端 API。',
    viaServer: '服务器自带的管线',
    viaModel: '下面的文本模型',
    textBaseUrl: '文本模型的服务地址',
    textBaseUrlPlaceholder: '留空：同一台服务器 · 或如 http://localhost:11434/v1',
    textModel: '文本模型',
    translateModelPlaceholder: '模型名，例如 hy-mt2-1.8b',
    needsKey: '这个服务需要 API 密钥',
    coachStage: '语法反馈',
    coachStageTooltip: '适合自己直接说对方语言的场合。你说的话不再翻译，而是交给模型检查：没问题回 ✓，有问题给出改正后的句子和原因。打字输入的内容仍然会翻译。',
    coach: '我自己说对方的语言：检查我的语法',
    coachModelPlaceholder: '留空：使用翻译文本模型',
  },
  fork: {
    furigana: '汉字上方显示假名（日语）',
    romanization: '显示罗马音（日语、韩语、俄语）',
  },
};

const ZH_TW = {
  provider: {
    name: 'LocalAI Realtime',
    description: '區域網路內自建的 LocalAI 服務 · 僅文字 · 各環節可分開指定模型',
    endpoint: '伺服器位址',
    endpointPlaceholder: '伺服器位址，例如 192.168.1.10:8080',
    translateKey: '翻譯模型的 API 金鑰',
    coachKey: '文法回饋模型的 API 金鑰',
    modelTooltip: 'Realtime 管線模型，名稱與伺服器上的一致。伺服器的清單只作提示：填什麼就執行什麼。',
    asrModelTooltip: '產生原文的語音辨識模型。保持伺服器預設即可，除非想換成伺服器上的其他模型。',
    asrModelServer: '伺服器預設',
    translateStage: '翻譯',
    translateStageTooltip: '由誰來翻譯語音。選伺服器管線，辨識和翻譯都在同一個工作階段完成。選文字模型，伺服器只負責辨識，翻譯交給任何支援 OpenAI 聊天介面的地方：另一台機器、本機的 Ollama 或 LM Studio、雲端 API。',
    viaServer: '伺服器自帶的管線',
    viaModel: '下面的文字模型',
    textBaseUrl: '文字模型的服務位址',
    textBaseUrlPlaceholder: '留空：同一台伺服器 · 或如 http://localhost:11434/v1',
    textModel: '文字模型',
    translateModelPlaceholder: '模型名稱，例如 hy-mt2-1.8b',
    needsKey: '這個服務需要 API 金鑰',
    coachStage: '文法回饋',
    coachStageTooltip: '適合自己直接說對方語言的場合。你說的話不再翻譯，而是交給模型檢查：沒問題回 ✓，有問題給出改正後的句子和原因。打字輸入的內容仍然會翻譯。',
    coach: '我自己說對方的語言：檢查我的文法',
    coachModelPlaceholder: '留空：使用翻譯文字模型',
  },
  fork: {
    furigana: '漢字上方顯示假名（日語）',
    romanization: '顯示羅馬拼音（日語、韓語、俄語）',
  },
};

const OWN = { zh_CN: ZH_CN, zh_TW: ZH_TW };
const root = path.resolve(__dirname, '../src/locales');
let changed = 0;

for (const lang of fs.readdirSync(root)) {
  const file = path.join(root, lang, 'translation.json');
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const catalog = JSON.parse(text);
  if (!catalog.providers || typeof catalog.providers !== 'object') throw new Error(`${lang}: no "providers" block`);
  const strings = OWN[lang] ?? EN;
  catalog.providers.localai = strings.provider;
  catalog.fork = strings.fork;
  const next = JSON.stringify(catalog, null, 2).replace(/\n/g, eol) + (text.endsWith('\n') ? eol : '');
  if (next !== text) {
    fs.writeFileSync(file, next);
    changed += 1;
  }
}
console.log(`fork strings written; ${changed} catalog(s) changed.`);
