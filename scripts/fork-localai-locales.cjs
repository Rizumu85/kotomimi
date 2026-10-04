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
    'Recognition, translation and grammar feedback — and you mix where each model runs: this computer, another device on your network, or any API model.',
    '能识别、翻译、语法反馈，并且可以混搭选择运行的模型：本地电脑、局域网的另一台设备，或任意 API 模型。',
    '能辨識、翻譯、文法回饋，並且可以混搭選擇執行的模型：本機電腦、區域網路的另一台裝置，或任意 API 模型。',
  ],

  // The three places.
  placeServer: ['Another device', '另一台设备', '另一台裝置'],
  viaModel: ['API model', 'API 模型', 'API 模型'],
  placeDevice: ['This computer', '这台电脑', '這台電腦'],
  // The wizard's one question.
  choiceServer: ['Use another device', '用另一台设备', '用另一台裝置'],
  choiceDevice: ['Use this computer', '用这台电脑', '用這台電腦'],

  // The other device.
  otherDeviceHint: [
    'To use the models of another device on your local network, search the network for it.',
    '如需配合本地局域网的另一台设备使用模型，可以查找局域网的设备。',
    '如需搭配本地區域網路的另一台裝置使用模型，可以尋找區域網路的裝置。',
  ],
  endpoint: ['Address', '地址', '位址'],
  endpointPlaceholder: ['e.g. 192.168.1.10:8790', '例如 192.168.1.10:8790', '例如 192.168.1.10:8790'],
  serverNeedsKey: ['It asks for an access key', '它需要访问密钥', '它需要存取金鑰'],
  serverNeedsKeyTooltip: [
    'Turn this on when the other device was given an access key — a Kotomimi with one set under its sharing options, for example.',
    '另一台设备设了访问密钥时打开，例如对面那台 Kotomimi 在共享的「选项」里设置了密钥。',
    '另一台裝置設了存取金鑰時開啟，例如對面那台 Kotomimi 在共享的「選項」裡設定了金鑰。',
  ],
  serverKey: ['Access key', '访问密钥', '存取金鑰'],
  kotomimiServer: [
    'It is another Kotomimi sharing its models.',
    '它是另一台正在共享模型的 Kotomimi。',
    '它是另一台正在共享模型的 Kotomimi。',
  ],
  localServerNote: [
    'This address is this computer itself: a model server running here, such as LocalAI. Choose "Another device" in a stage to use its models.',
    '这个地址就是这台电脑：本机上运行的模型服务器（例如 LocalAI）。在环节里选「另一台设备」就会用它的模型。',
    '這個位址就是這台電腦：本機上執行的模型伺服器（例如 LocalAI）。在環節裡選「另一台裝置」就會用它的模型。',
  ],
  connectFirst: [
    'No other device is connected yet: search for one above, or type its address.',
    '还没有连接另一台设备：先在上面查找，或填写它的地址。',
    '還沒有連線另一台裝置：先在上面尋找，或填寫它的位址。',
  ],

  // Whether it can all start.
  ready: ['Ready to start', '可以开始了', '可以開始了'],
  checking: ['Checking…', '正在检查…', '正在檢查…'],
  checkNow: ['Check', '检查', '檢查'],
  recheck: ['Check again', '重新检查', '重新檢查'],

  // What every card shares.
  model: ['Model', '模型', '模型'],
  auto: ['Automatic · {{name}}', '自动 · {{name}}', '自動 · {{name}}'],
  deviceDefault: ['The device\'s own choice', '由那台设备决定', '由那台裝置決定'],
  advanced: ['Advanced', '高级', '進階'],
  apiKey: ['API key', 'API 密钥', 'API 金鑰'],
  asrApiBaseUrl: ['API address', 'API 地址', 'API 位址'],
  asrApiNeedsKey: ['The API asks for a key', '这个 API 需要密钥', '這個 API 需要金鑰'],
  asrKey: ['API key of the speech recognition API', '语音识别 API 的密钥', '語音辨識 API 的金鑰'],
  translateKey: ['API key of the translation model', '翻译模型的 API 密钥', '翻譯模型的 API 金鑰'],
  coachKey: ['API key of the feedback model', '语法反馈模型的 API 密钥', '文法回饋模型的 API 金鑰'],
  textBaseUrlPlaceholder: ['e.g. https://api.openai.com/v1 or http://localhost:11434/v1', '例如 https://api.openai.com/v1 或 http://localhost:11434/v1', '例如 https://api.openai.com/v1 或 http://localhost:11434/v1'],
  textModelPlaceholder: ['The model\'s name, e.g. gpt-4o-mini', '模型名称，例如 gpt-4o-mini', '模型名稱，例如 gpt-4o-mini'],

  // This computer's models.
  notDownloaded: ['No model downloaded yet', '还没下载模型', '尚未下載模型'],
  browse: ['Model library', '模型库', '模型庫'],
  hears: ['Hears {{language}}', '听{{language}}', '聽{{language}}'],
  chatModelsNoGpu: [
    'These models need a graphics card with WebGPU, which this computer does not offer. Use another device or an API model for the feedback.',
    '这些模型需要支持 WebGPU 的显卡，这台电脑没有。语法反馈请改用另一台设备或 API 模型。',
    '這些模型需要支援 WebGPU 的顯示卡，這台電腦沒有。文法回饋請改用另一台裝置或 API 模型。',
  ],

  // Speech recognition.
  hearStage: ['Speech recognition', '语音识别', '語音辨識'],
  hearStageTooltip: [
    'What listens: it decides when a sentence ends and writes down what was said.',
    '负责「听」的一环：判断一句话什么时候说完，并把说的内容写成文字。',
    '負責「聽」的一環：判斷一句話什麼時候說完，並把說的內容寫成文字。',
  ],
  asrFixedNote: [
    'That device is reached as a plain LocalAI, which always hears with its own default recognizer when the translation or the feedback uses a model chosen here. Through the Kotomimi on that device, the recognizer can be chosen here.',
    '现在连的是那台设备上的 LocalAI 本身：翻译或语法反馈另选了模型时，它只用自己默认的识别模型。改连那台设备上的 Kotomimi，就能在这里选识别模型。',
    '現在連的是那台裝置上的 LocalAI 本身：翻譯或文法回饋另選了模型時，它只用自己預設的辨識模型。改連那台裝置上的 Kotomimi，就能在這裡選辨識模型。',
  ],
  serverSilent: [
    'This address does not answer. A Kotomimi on that device lends its models, and its LocalAI\'s, through its own sharing.',
    '这个地址连不上。那台设备上的 Kotomimi 会通过自己的共享提供模型（包括它的 LocalAI 里的）。',
    '這個位址連不上。那台裝置上的 Kotomimi 會透過自己的共享提供模型（包括它的 LocalAI 裡的）。',
  ],
  kotomimiThere: ['Use the Kotomimi on that device', '改连那台设备的 Kotomimi', '改連那台裝置的 Kotomimi'],
  kotomimiThereLooking: ['Looking for it…', '正在查找…', '正在尋找…'],
  kotomimiThereNone: [
    'No Kotomimi is sharing on that device. Open Kotomimi there, turn on "Share with other devices", then try again.',
    '那台设备上没有正在共享的 Kotomimi。请在那台设备上打开 Kotomimi，开启「共享给其他设备」，再试一次。',
    '那台裝置上沒有正在共享的 Kotomimi。請在那台裝置上打開 Kotomimi，開啟「共享給其他裝置」，再試一次。',
  ],
  pipelineModel: ['Realtime pipeline', '实时管线', '即時管線'],
  pipelineNote: [
    'Normally left alone: it is the pipeline the other device runs its live session with. Change it only when that device is a LocalAI set up with more than one.',
    '一般不用改：这是另一台设备跑实时会话用的管线。只有那台设备是 LocalAI，而且配了不止一条管线时才需要改。',
    '一般不用改：這是另一台裝置跑即時工作階段用的管線。只有那台裝置是 LocalAI，而且設了不只一條管線時才需要改。',
  ],
  asrApiBaseUrlPlaceholder: ['e.g. https://api.openai.com/v1', '例如 https://api.openai.com/v1', '例如 https://api.openai.com/v1'],
  asrApiModelPlaceholder: ['e.g. whisper-1, whisper-large-v3', '例如 whisper-1、whisper-large-v3', '例如 whisper-1、whisper-large-v3'],
  hearApiNote: [
    'Any service with OpenAI\'s transcription API works (OpenAI, Groq, a LocalAI). This computer cuts the sentences and uploads each one, so the text appears when a sentence is finished.',
    '任何提供 OpenAI 转写接口的服务都行（OpenAI、Groq、LocalAI 等）。断句由这台电脑来做，每句话说完后上传识别，所以文字在一句话说完时才出现。',
    '任何提供 OpenAI 轉寫介面的服務都行（OpenAI、Groq、LocalAI 等）。斷句由這台電腦來做，每句話說完後上傳辨識，所以文字在一句話說完時才出現。',
  ],

  // Translation.
  translateStage: ['Translation', '翻译', '翻譯'],
  translateStageTooltip: [
    'What turns the recognized text into the other language. An API model is any service that speaks the OpenAI chat API: a hosted one, or Ollama or LM Studio on this computer.',
    '把识别出的文字翻成另一种语言的一环。API 模型可以是任何支持 OpenAI 聊天接口的服务：云端的，或这台电脑上的 Ollama、LM Studio。',
    '把辨識出的文字翻成另一種語言的一環。API 模型可以是任何支援 OpenAI 聊天介面的服務：雲端的，或這台電腦上的 Ollama、LM Studio。',
  ],
  translateInSession: [
    'The device\'s own choice (translated in the same session it hears in)',
    '由那台设备决定（和识别在同一个会话里完成）',
    '由那台裝置決定（和辨識在同一個工作階段完成）',
  ],
  translateKotomimiOwn: [
    'The device\'s own choice (its best model for your languages)',
    '由那台设备决定（按语言对自动选最合适的）',
    '由那台裝置決定（依語言對自動選最合適的）',
  ],

  // Grammar feedback.
  coachStage: ['Grammar feedback', '语法反馈', '文法回饋'],
  coachStageTooltip: [
    'For when you speak the other side\'s language yourself. Your speech is not translated: a model checks it and answers ✓, or the corrected sentence and why. What you type is still translated.',
    '适合自己直接说对方语言的场合。你说的话不再翻译，而是交给模型检查：没问题回 ✓，有问题给出改正后的句子和原因。打字输入的内容仍然会翻译。',
    '適合自己直接說對方語言的場合。你說的話不再翻譯，而是交給模型檢查：沒問題回 ✓，有問題給出改正後的句子和原因。打字輸入的內容仍然會翻譯。',
  ],
  coach: ['I speak their language: check my grammar', '我自己说对方的语言：检查我的语法', '我自己說對方的語言：檢查我的文法'],
  coachNoModel: [
    'The other device has no text model that can give feedback. Use an API model or this computer instead.',
    '另一台设备上没有能给语法反馈的文本模型，可以改用 API 模型或这台电脑。',
    '另一台裝置上沒有能給文法回饋的文字模型，可以改用 API 模型或這台電腦。',
  ],
  coachPrompt: ['Feedback instructions', '语法反馈提示词', '文法回饋提示詞'],
  coachPromptPlaceholder: [
    'Blank: written automatically for your two languages. Your own text may use {{spoken}} and {{native}}.',
    '留空：按你的母语和所练的语言自动生成。自己写时可以用 {{spoken}} 和 {{native}} 代表这两种语言。',
    '留空：依你的母語和所練的語言自動產生。自己寫時可以用 {{spoken}} 和 {{native}} 代表這兩種語言。',
  ],
  coachPromptPreview: ['Used while the box is blank, for this language pair:', '留空时，当前语言对用的是这一份：', '留空時，目前語言對用的是這一份：'],

  // A stage with nothing to run: said when it is checked, and when Start is pressed.
  asrUnnamed: [
    'Speech recognition has no model to run yet. In its card under the provider, choose one — for an API model, fill in its address and model name — or choose another place.',
    '语音识别还没有可用的模型。请在提供商下面的「语音识别」卡片里选好（用 API 模型时要填地址和模型名），或者换一个位置。',
    '語音辨識還沒有可用的模型。請在提供商下面的「語音辨識」卡片裡選好（用 API 模型時要填位址和模型名稱），或者換一個位置。',
  ],
  translateUnnamed: [
    'Translation has no model to run yet. In its card under the provider, choose one — for an API model, fill in its address and model name — or choose another place.',
    '翻译还没有可用的模型。请在提供商下面的「翻译」卡片里选好（用 API 模型时要填地址和模型名），或者换一个位置。',
    '翻譯還沒有可用的模型。請在提供商下面的「翻譯」卡片裡選好（用 API 模型時要填位址和模型名稱），或者換一個位置。',
  ],
  coachUnnamed: [
    'Grammar feedback has no model to run yet. In its card under the provider, choose one — for an API model, fill in its address and model name — or choose another place.',
    '语法反馈还没有可用的模型。请在提供商下面的「语法反馈」卡片里选好（用 API 模型时要填地址和模型名），或者换一个位置。',
    '文法回饋還沒有可用的模型。請在提供商下面的「文法回饋」卡片裡選好（用 API 模型時要填位址和模型名稱），或者換一個位置。',
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
