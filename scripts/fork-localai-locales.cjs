#!/usr/bin/env node
/**
 * Fork: writes this fork's strings into every locale catalog — the Kotomimi
 * provider's under `providers.localai`, and the rest under `fork` (the
 * reading aids, the fonts, sharing on the local network). Idempotent — run
 * it again after a rebase onto upstream that touched `src/locales`:
 *
 *   node scripts/fork-localai-locales.cjs
 *
 * Each string is written once here, as [English, 简体, 繁體]. English goes
 * everywhere but the two Chinese catalogs, so the catalogs stay in lockstep
 * with `en` (`src/locales/locales.consistency.test.ts`).
 */
const fs = require('node:fs');
const path = require('node:path');

const PROVIDER = {
  name: ['Kotomimi Pipeline', 'Kotomimi 自由搭配', 'Kotomimi 自由搭配'],
  description: [
    'Choose where each stage runs: another device on your network, this computer, or any text model · text only',
    '识别、翻译、语法反馈各自选在哪里运行：局域网里的另一台设备、这台电脑、或任意文本模型 · 仅文本',
    '辨識、翻譯、文法回饋各自選在哪裡執行：區域網路裡的另一台裝置、這台電腦、或任意文字模型 · 僅文字',
  ],
  endpoint: ['Address of the other device', '另一台设备的地址', '另一台裝置的位址'],
  endpointPlaceholder: [
    'Address of the other device, e.g. 192.168.1.10:8790',
    '另一台设备的地址，例如 192.168.1.10:8790',
    '另一台裝置的位址，例如 192.168.1.10:8790',
  ],
  serverKey: ['Access key of the server', '服务器的访问密钥', '伺服器的存取金鑰'],
  translateKey: ['API key of the translation model', '翻译模型的 API 密钥', '翻譯模型的 API 金鑰'],
  coachKey: ['API key of the feedback model', '语法反馈模型的 API 密钥', '文法回饋模型的 API 金鑰'],

  route: ['Where each stage runs', '各环节在哪里运行', '各環節在哪裡執行'],
  placeServer: ['Another device', '另一台设备', '另一台裝置'],
  placeDevice: ['This computer', '这台电脑', '這台電腦'],
  choiceServer: ['Use another device', '用另一台设备', '用另一台裝置'],
  choiceDevice: ['Use this computer', '用这台电脑', '用這台電腦'],
  notDownloaded: ['no model downloaded', '还没下载模型', '尚未下載模型'],
  notChosen: ['no model chosen', '还没选模型', '尚未選模型'],

  hearStage: ['Speech recognition', '语音识别', '語音辨識'],
  hearStageTooltip: [
    'What listens: it decides when a sentence ends and writes down what was said. A server on your network (a LocalAI, or another Kotomimi sharing its models), or a model this computer runs itself.',
    '负责"听"的一环：判断一句话什么时候说完，并把说的内容写成文字。可以交给局域网里的服务器（LocalAI，或另一台共享模型的 Kotomimi），也可以用这台电脑自己运行的模型。',
    '負責「聽」的一環：判斷一句話什麼時候說完，並把說的內容寫成文字。可以交給區域網路裡的伺服器（LocalAI，或另一台共享模型的 Kotomimi），也可以用這台電腦自己執行的模型。',
  ],
  hearDeviceNote: [
    'This computer listens with a model downloaded by the app. Choose or download it under Models; its pause detection is under Voice activity detection.',
    '由这台电脑用应用下载的模型来识别。在"模型"里选择或下载；断句的灵敏度在"VAD 设置"里调。',
    '由這台電腦用應用程式下載的模型來辨識。在「模型」裡選擇或下載；斷句的靈敏度在「VAD 設定」裡調整。',
  ],
  pipelineModel: ['Realtime model', 'Realtime 管线模型', 'Realtime 管線模型'],
  modelTooltip: [
    'The Realtime pipeline model, exactly as your server names it. The server\'s list only suggests: what you type is what runs.',
    'Realtime 管线模型，名称与服务器上的一致。服务器的列表只作提示：填什么就运行什么。',
    'Realtime 管線模型，名稱與伺服器上的一致。伺服器的清單只作提示：填什麼就執行什麼。',
  ],
  kotomimiServer: [
    'This server is another Kotomimi sharing its models.',
    '这台服务器是另一台正在共享模型的 Kotomimi。',
    '這台伺服器是另一台正在共享模型的 Kotomimi。',
  ],
  recognizer: ['Recognizer', '识别模型', '辨識模型'],
  asrModelTooltip: [
    'The speech-recognition model that writes the source text. Leave it to the server unless you want another of its models.',
    '生成原文的语音识别模型。保持服务器默认即可，除非想换成服务器上的其他模型。',
    '產生原文的語音辨識模型。保持伺服器預設即可，除非想換成伺服器上的其他模型。',
  ],
  asrModelServer: ['Server default', '服务器默认', '伺服器預設'],
  asrFixedNote: [
    'A leg whose answers come from elsewhere uses the server\'s own recognizer: LocalAI accepts no other there.',
    '翻译或语法不由服务器管线完成的那一路，只能用服务器默认的识别模型：LocalAI 在这种会话里不接受别的。',
    '翻譯或文法不由伺服器管線完成的那一路，只能用伺服器預設的辨識模型：LocalAI 在這種工作階段不接受別的。',
  ],

  translateStage: ['Translation', '翻译', '翻譯'],
  translateStageTooltip: [
    'What turns the recognized text into the other language. The server\'s own pipeline does it inside the same session. A text model can be anywhere that speaks the OpenAI chat API: another machine, Ollama or LM Studio on this one, a hosted API. Or a translation model this computer runs itself.',
    '把识别出的文字翻成另一种语言的一环。服务器管线：和识别在同一个会话里完成。文本模型：任何支持 OpenAI 聊天接口的地方都行，另一台机器、本机的 Ollama 或 LM Studio、云端 API。这台电脑：用应用下载的翻译模型。',
    '把辨識出的文字翻成另一種語言的一環。伺服器管線：和辨識在同一個工作階段完成。文字模型：任何支援 OpenAI 聊天介面的地方都行，另一台機器、本機的 Ollama 或 LM Studio、雲端 API。這台電腦：用應用程式下載的翻譯模型。',
  ],
  viaServer: ['Server pipeline', '服务器管线', '伺服器管線'],
  viaModel: ['Text model', '文本模型', '文字模型'],
  viaServerNote: [
    'The server recognizes and translates in one session, with the model it is set up with.',
    '识别和翻译都由服务器在同一个会话里完成，用它自己配置好的模型。',
    '辨識和翻譯都由伺服器在同一個工作階段完成，用它自己設定好的模型。',
  ],
  viaServerKotomimiNote: [
    'The other Kotomimi picks its best downloaded translation model for your languages.',
    '由对面那台 Kotomimi 按你的语言对，自动选它已下载的最合适的翻译模型。',
    '由對面那台 Kotomimi 依你的語言對，自動選它已下載的最合適的翻譯模型。',
  ],
  viaDeviceNote: [
    'This computer translates with a model downloaded by the app. Choose or download it under Models.',
    '由这台电脑用应用下载的翻译模型来翻译。在"模型"里选择或下载。',
    '由這台電腦用應用程式下載的翻譯模型來翻譯。在「模型」裡選擇或下載。',
  ],
  textModel: ['Model', '模型', '模型'],
  textBaseUrl: ['Served at', '服务地址', '服務位址'],
  textBaseUrlPlaceholder: [
    'Blank: the server above · or e.g. http://localhost:11434/v1',
    '留空：上面那台服务器 · 或如 http://localhost:11434/v1',
    '留空：上面那台伺服器 · 或如 http://localhost:11434/v1',
  ],
  translateModelPlaceholder: ['Choose a text model', '选择文本模型', '選擇文字模型'],
  needsKey: ['It needs an API key', '这个服务需要 API 密钥', '這個服務需要 API 金鑰'],

  coachStage: ['Grammar feedback', '语法反馈', '文法回饋'],
  coachStageTooltip: [
    'For when you speak the other side\'s language yourself. Your speech is not translated: a model checks it and answers ✓, or the corrected sentence and why. What you type is still translated.',
    '适合自己直接说对方语言的场合。你说的话不再翻译，而是交给模型检查：没问题回 ✓，有问题给出改正后的句子和原因。打字输入的内容仍然会翻译。',
    '適合自己直接說對方語言的場合。你說的話不再翻譯，而是交給模型檢查：沒問題回 ✓，有問題給出改正後的句子和原因。打字輸入的內容仍然會翻譯。',
  ],
  coach: ['I speak their language: check my grammar', '我自己说对方的语言：检查我的语法', '我自己說對方的語言：檢查我的文法'],
  coachModelPlaceholder: ['Blank: the translation text model', '留空：使用翻译的文本模型', '留空：使用翻譯的文字模型'],
  coachPrompt: ['Feedback instructions', '语法反馈提示词', '文法回饋提示詞'],
  coachPromptPlaceholder: [
    'Blank: written automatically for your two languages. Your own text may use {{spoken}} and {{native}}.',
    '留空：按你的母语和所练的语言自动生成。自己写时可以用 {{spoken}} 和 {{native}} 代表这两种语言。',
    '留空：依你的母語和所練的語言自動產生。自己寫時可以用 {{spoken}} 和 {{native}} 代表這兩種語言。',
  ],
  coachPromptPreview: ['Show the automatic instructions for this language pair', '查看当前语言对自动生成的提示词', '檢視目前語言對自動產生的提示詞'],

  serverNeedsKey: ['The other device asks for an access key', '另一台设备需要访问密钥', '另一台裝置需要存取金鑰'],
  serverNeedsKeyTooltip: [
    'Turn this on when the other device was given an access key — a Kotomimi with one set under its sharing options, for example. The key is entered beside the address.',
    '另一台设备设了访问密钥时打开，例如对面那台 Kotomimi 在共享的「选项」里设置了密钥。密钥在地址旁边填写。',
    '另一台裝置設了存取金鑰時開啟，例如對面那台 Kotomimi 在共享的「選項」裡設定了金鑰。金鑰在位址旁邊填寫。',
  ],
};

const FORK = {
  furigana: ['Furigana over kanji (Japanese)', '汉字上方显示假名（日语）', '漢字上方顯示假名（日語）'],
  romanization: ['Romanization (Japanese, Korean, Russian)', '显示罗马音（日语、韩语、俄语）', '顯示羅馬拼音（日語、韓語、俄語）'],
};

/** Further groups of the fork's own strings, each written under `fork.<group>` — and the tour's fork copy, written beside upstream's under `tour.steps.<id>`: filled in beside this file. */
const { tour: TOUR, ...GROUPS } = require('./fork-locale-groups.cjs');

const COLUMN = { zh_CN: 1, zh_TW: 2 };
const pick = (table, column) => Object.fromEntries(Object.entries(table).map(([key, value]) => [key, value[column] ?? value[0]]));

const root = path.resolve(__dirname, '../src/locales');
let changed = 0;

for (const lang of fs.readdirSync(root)) {
  const file = path.join(root, lang, 'translation.json');
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const catalog = JSON.parse(text);
  if (!catalog.providers || typeof catalog.providers !== 'object') throw new Error(`${lang}: no "providers" block`);
  const column = COLUMN[lang] ?? 0;
  catalog.providers.localai = pick(PROVIDER, column);
  catalog.fork = { ...pick(FORK, column), ...Object.fromEntries(Object.entries(GROUPS).map(([group, table]) => [group, pick(table, column)])) };
  if (!catalog.tour || !catalog.tour.steps) throw new Error(`${lang}: no "tour.steps" block`);
  for (const [step, table] of Object.entries(TOUR)) catalog.tour.steps[step] = { ...(catalog.tour.steps[step] ?? {}), ...pick(table, column) };
  const next = JSON.stringify(catalog, null, 2).replace(/\n/g, eol) + (text.endsWith('\n') ? eol : '');
  if (next !== text) {
    fs.writeFileSync(file, next);
    changed += 1;
  }
}
console.log(`fork strings written; ${changed} catalog(s) changed.`);
