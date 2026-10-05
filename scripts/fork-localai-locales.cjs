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
  // The API place's service menu (`apiServices.ts`).
  apiService: ['Service', '服务', '服務'],
  apiServiceCustom: ['Custom address', '自定义地址', '自訂位址'],
  apiServiceArk: ['Doubao (Volcengine Ark)', '豆包（火山方舟）', '豆包（火山方舟）'],
  apiServiceSiliconFlow: ['SiliconFlow', '硅基流动 SiliconFlow', '矽基流動 SiliconFlow'],
  apiServiceOllama: ['Ollama on this computer', '这台电脑的 Ollama', '這台電腦的 Ollama'],
  apiServiceModel: ["Choose from the list on the right, or type a name", "点右边从列表里选，或直接输入名称", "點右邊從清單裡選，或直接輸入名稱"],
  modelList: ["Choose from the models this service lists", "从这个服务的模型列表里选", "從這個服務的模型清單裡選"],
  modelSuggested: ["Suits this step", "适合这一步", "適合這一步"],
  modelListAsking: ["Getting the list…", "正在获取模型列表…", "正在取得模型清單…"],
  modelListNoAddress: ["Fill in the address first.", "请先填写地址。", "請先填寫位址。"],
  modelListKeyMissing: ["Fill in the API key first.", "请先填写 API 密钥。", "請先填寫 API 金鑰。"],
  modelListKeyRefused: ["The service refused this key.", "这个服务不接受这个密钥。", "這個服務不接受這個金鑰。"],
  modelListUnreachable: ["The service could not be reached.", "连不上这个服务。", "連不上這個服務。"],
  modelListNone: ["This service lists no models. Type the name instead.", "这个服务没有提供模型列表，请直接输入名称。", "這個服務沒有提供模型清單，請直接輸入名稱。"],
  modelSearch: ["Search models", "搜索模型", "搜尋模型"],
  modelListNoMatch: ["No model found. Try fewer letters.", "没有找到，试试少打几个字。", "沒有找到，試試少打幾個字。"],
  apiServiceArkModel: ['A model\'s name, or your endpoint id (ep-…)', '模型名称，或你的接入点 ID（ep-…）', '模型名稱，或你的接入點 ID（ep-…）'],
  apiKeyReused: ['Filled in with the key saved under "{{name}}".', '已填入你在「{{name}}」里保存的密钥。', '已填入你在「{{name}}」裡儲存的金鑰。'],
  asrKey: ['API key of the speech recognition API', '语音识别 API 的密钥', '語音辨識 API 的金鑰'],
  translateKey: ['API key of the translation model', '翻译模型的 API 密钥', '翻譯模型的 API 金鑰'],
  coachKey: ['API key of the feedback model', '语法反馈模型的 API 密钥', '文法回饋模型的 API 金鑰'],
  textBaseUrlPlaceholder: ['e.g. https://api.openai.com/v1 or http://localhost:11434/v1', '例如 https://api.openai.com/v1 或 http://localhost:11434/v1', '例如 https://api.openai.com/v1 或 http://localhost:11434/v1'],
  textModelPlaceholder: ['The model\'s name, e.g. gpt-4o-mini', '模型名称，例如 gpt-4o-mini', '模型名稱，例如 gpt-4o-mini'],

  // This computer's models.
  notDownloaded: ['No model downloaded yet', '还没下载模型', '尚未下載模型'],
  browse: ['Model library', '模型库', '模型庫'],
  hears: ['Recognizes {{language}}', '识别{{language}}', '辨識{{language}}'],
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
  // Under "this computer": the LocalAI installed here, as one more choice in the model's own menu (`LocalAIHere`).
  hereLocalAI: ['LocalAI (on this computer)', 'LocalAI（这台电脑上的）', 'LocalAI（這台電腦上的）'],
  hereApp: ['Models Kotomimi downloaded', 'Kotomimi 下载的模型', 'Kotomimi 下載的模型'],
  hereModel: ['LocalAI\'s model', 'LocalAI 的模型', 'LocalAI 的模型'],
  hereModelOwn: ['LocalAI\'s own choice', '由 LocalAI 决定', '由 LocalAI 決定'],
  hereModelPick: ['Choose a model', '请选择模型', '請選擇模型'],
  hereStopped: ['LocalAI is not running.', 'LocalAI 没有在运行。', 'LocalAI 沒有在執行。'],
  hereStarting: ['Starting LocalAI…', '正在启动 LocalAI…', '正在啟動 LocalAI…'],
  hereAbsent: ['No LocalAI was found on this computer.', '这台电脑上没有找到 LocalAI。', '這台電腦上沒有找到 LocalAI。'],
  hereStart: ['Start LocalAI', '启动 LocalAI', '啟動 LocalAI'],
  hereDown: [
    'The LocalAI on this computer is not running yet. Start it in the stage\'s card — or, if Kotomimi has only just opened, give it a moment.',
    '这台电脑的 LocalAI 还没有运行。在环节卡片里点「启动 LocalAI」；如果刚打开 Kotomimi，稍等一会儿它就会起来。',
    '這台電腦的 LocalAI 還沒有執行。在環節卡片裡按「啟動 LocalAI」；如果剛開啟 Kotomimi，稍等一會兒它就會起來。',
  ],
  kotomimiThere: ['Use the Kotomimi on that device', '改连那台设备的 Kotomimi', '改連那台裝置的 Kotomimi'],
  kotomimiThereLooking: ['Looking for it…', '正在查找…', '正在尋找…'],
  kotomimiThereNone: [
    'No Kotomimi is sharing on that device. Open Kotomimi there, turn on "Share with other devices", then try again.',
    '那台设备上没有正在共享的 Kotomimi。请在那台设备上打开 Kotomimi，开启「共享给其他设备」，再试一次。',
    '那台裝置上沒有正在共享的 Kotomimi。請在那台裝置上打開 Kotomimi，開啟「共享給其他裝置」，再試一次。',
  ],
  pipelineModel: ['Setup name on that device', '那台设备上的配置名称', '那台裝置上的設定名稱'],
  pipelineNote: [
    'Normally left alone. Change it only when that device is a LocalAI set up with more than one combination of recognition and translation.',
    '一般不用改。只有那台设备是 LocalAI，并且配了不止一套识别和翻译的组合时才需要改。',
    '一般不用改。只有那台裝置是 LocalAI，並且設了不只一套辨識和翻譯的組合時才需要改。',
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

  // The other device not chosen yet, or its access key blank: said when it is checked, and when Start is pressed.
  addressMissing: [
    'No other device is chosen yet. In Settings, under "Another device", search for it or type its address.',
    '还没有选另一台设备。请在设置的「另一台设备」一栏里搜索它，或填写它的地址。',
    '還沒有選另一台裝置。請在設定的「另一台裝置」一欄裡搜尋它，或填寫它的位址。',
  ],
  serverKeyMissing: [
    'The other device asks for an access key. Enter it in Settings, under "Another device".',
    '另一台设备需要访问密钥。请在设置的「另一台设备」一栏里填写。',
    '另一台裝置需要存取金鑰。請在設定的「另一台裝置」一欄裡填寫。',
  ],

  // The other device, or a stage's API, did not answer as it should: where to look. Said in the cards, the wizard, and at Start.
  serverUnreachable: [
    'The other device ({{address}}) did not answer. Check that it is on and on the same network as this computer, and that Kotomimi there is sharing (or its model server is running); then check again.',
    '另一台设备（{{address}}）没有回应。请确认它开着、和这台电脑连着同一个网络，那边的 Kotomimi 开着共享（或者模型服务器在运行），然后再检查一次。',
    '另一台裝置（{{address}}）沒有回應。請確認它開著、和這台電腦連著同一個網路，那邊的 Kotomimi 開著共享（或者模型伺服器在執行），然後再檢查一次。',
  ],
  checkSlow: [
    'No answer within {{seconds}} s. The address may be wrong, or the device busy loading a model; check again in a moment.',
    '等了 {{seconds}} 秒还没有回应。可能是地址不对，或者那台设备正忙着加载模型；稍等一下再检查一次。',
    '等了 {{seconds}} 秒還沒有回應。可能是位址不對，或者那台裝置正忙著載入模型；稍等一下再檢查一次。',
  ],
  serverHttp: [
    'The other device answered with an error (HTTP {{status}}). Restarting the app or the model server there usually helps.',
    '另一台设备回应了错误（HTTP {{status}}）。通常重启那边的应用或模型服务器就好。',
    '另一台裝置回應了錯誤（HTTP {{status}}）。通常重新啟動那邊的應用程式或模型伺服器就好。',
  ],
  serverNoModels: [
    'The other device has no model yet: install or download one there first.',
    '另一台设备上还没有任何模型，请先在那台设备上安装或下载。',
    '另一台裝置上還沒有任何模型，請先在那台裝置上安裝或下載。',
  ],
  serverKeyNeeded: [
    'The other device asks for an access key. Under "Another device", turn on "It asks for an access key" and enter the key set on that device.',
    '另一台设备需要访问密钥。请在「另一台设备」一栏打开「它需要访问密钥」，填写那台设备设置的密钥。',
    '另一台裝置需要存取金鑰。請在「另一台裝置」一欄開啟「它需要存取金鑰」，填寫那台裝置設定的金鑰。',
  ],
  serverKeyRefused: [
    'The other device did not accept the access key. Enter the key set on that device (on another Kotomimi, it is in its sharing Options).',
    '另一台设备不接受这个访问密钥。请填写那台设备设置的密钥（另一台 Kotomimi 的密钥在它共享的「选项」里）。',
    '另一台裝置不接受這個存取金鑰。請填寫那台裝置設定的金鑰（另一台 Kotomimi 的金鑰在它共享的「選項」裡）。',
  ],
  apiUnreachable: [
    'The API at {{address}} could not be reached. Check the address in its card, and that this computer is online.',
    '连不上 API（{{address}}）。请检查对应卡片里的地址，以及这台电脑能不能上网。',
    '連不上 API（{{address}}）。請檢查對應卡片裡的位址，以及這台電腦能不能上網。',
  ],
  apiKeyNeeded: [
    'The API at {{address}} asks for a key. In its card, turn on "The API asks for a key" and enter it.',
    'API（{{address}}）需要密钥。请在对应卡片里打开「这个 API 需要密钥」并填写。',
    'API（{{address}}）需要金鑰。請在對應卡片裡開啟「這個 API 需要金鑰」並填寫。',
  ],
  apiKeyRefused: [
    'The API at {{address}} did not accept the key. Check the API key in its card.',
    'API（{{address}}）不接受这个密钥。请检查对应卡片里的 API 密钥。',
    'API（{{address}}）不接受這個金鑰。請檢查對應卡片裡的 API 金鑰。',
  ],

  serverNoAsr: [
    'The other device has no speech recognition model for {{source}}. Download one there first (in the model library of its sharing card), or let this computer listen.',
    '另一台设备上没有能识别{{source}}的语音识别模型。请先在那台设备上下载一个（在它共享卡片的模型库里），或者改由这台电脑识别。',
    '另一台裝置上沒有能辨識{{source}}的語音辨識模型。請先在那台裝置上下載一個（在它共享卡片的模型庫裡），或者改由這台電腦辨識。',
  ],

  // Auto Detect where nothing detects the language: said when it is checked, and when Start is pressed.
  sourceAuto: [
    "The language cannot be detected with this setup: the app's own translation models, and speech recognition by another Kotomimi, need to be told it. Translate with the native engine or an API model, or choose the language.",
    "这样搭配时不能自动识别语言：应用自带的翻译模型、另一台 Kotomimi 的语音识别，都需要知道说的是哪种语言。请把翻译换成原生引擎或 API 模型，或者选好语言。",
    "這樣搭配時不能自動辨識語言：應用程式內建的翻譯模型、另一台 Kotomimi 的語音辨識，都需要知道說的是哪種語言。請把翻譯換成原生引擎或 API 模型，或者選好語言。",
  ],

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

  // The native recognition engine: a runtime the app downloads and runs beside itself.
  detectOther: ["Detect the other side's language", '自动识别对方说的语言', '自動辨識對方說的語言'],
  detectOtherTooltip: [
    'Whatever language the others speak is recognized and translated into yours, with nothing to switch. What you say is still translated into the language chosen above. Recognition needs Qwen3-ASR 1.7B GGUF or an API; translation needs the native engine or an API.',
    '对方说哪种语言都能识别并翻译成你的语言，不用手动切换；你自己说的话仍按上面选的语言翻译。识别要用 Qwen3-ASR 1.7B GGUF 或 API，翻译要用原生引擎或 API。',
    '對方說哪種語言都能辨識並翻譯成你的語言，不用手動切換；你自己說的話仍按上面選的語言翻譯。辨識要用 Qwen3-ASR 1.7B GGUF 或 API，翻譯要用原生引擎或 API。',
  ],
  hearsOther: ['Hears the other side (any language)', '听对方（自动识别语言）', '聽對方（自動辨識語言）'],
  detectOtherNeeds: [
    'Only Qwen3-ASR 1.7B GGUF can tell the language by itself. Choose it here.',
    '只有 Qwen3-ASR 1.7B GGUF 能自己识别语言，请在这里选它。',
    '只有 Qwen3-ASR 1.7B GGUF 能自己辨識語言，請在這裡選它。',
  ],
  nativeNone: ['No model chosen', '未选择模型', '未選擇模型'],
  nativeUnchosen: [
    'No speech recognition model is chosen for {{source}} yet. Choose one in the Speech recognition card.',
    '还没有为{{source}}选择语音识别模型。请在「语音识别」卡片里选一个。',
    '還沒有為{{source}}選擇語音辨識模型。請在「語音辨識」卡片裡選一個。',
  ],
  nativeTwoModels: [
    '{{name}} and {{other}} cannot run at the same time. Choose the same model for both languages.',
    '{{name}} 和 {{other}} 不能同时运行，请给两种语言选同一个模型。',
    '{{name}} 和 {{other}} 不能同時執行，請給兩種語言選同一個模型。',
  ],
  tag_native: ['Native engine', '原生引擎', '原生引擎'],
  tagHint_native: [
    "Runs on the graphics card in an engine the app downloads with it: quicker than the app's own way. Loaded when a session starts (about half a minute the first time after the computer boots) and freed a minute after it ends.",
    "由应用一并下载的独立引擎用显卡运行，比应用自带的方式快。开始会话时加载（开机后第一次约半分钟），结束一分钟后释放显存。",
    "由應用程式一併下載的獨立引擎用顯示卡執行，比應用程式內建的方式快。開始工作階段時載入（開機後第一次約半分鐘），結束一分鐘後釋放顯示記憶體。",
  ],
  nativeLoading: ['Loading the models… About half a minute the first time after the computer boots.', '正在加载模型…开机后第一次大约要半分钟。', '正在載入模型…開機後第一次大約要半分鐘。'],
  tag_system: ['Built into macOS', '系统自带', '系統內建'],
  tagHint_system: [
    'The speech recognition of macOS itself: no video memory taken, nothing to warm up. The system downloads each language.',
    'Mac 系统自带的语音识别：不占显存，不需要预热。每种语言的语言包由系统下载。',
    'Mac 系統內建的語音辨識：不佔顯示記憶體，不需要預熱。每種語言的語言包由系統下載。',
  ],
  nativeEntry: ["{{name}} (native engine)", "{{name}}（原生引擎）", "{{name}}（原生引擎）"],
  nativeReady: ["The engine is ready.", "引擎已就绪。", "引擎已就緒。"],
  nativeWarmingShort: [
    "Starting the engine… About half a minute the first time after the computer boots.",
    "正在启动引擎…开机后第一次大约要半分钟。",
    "正在啟動引擎…開機後第一次大約要半分鐘。",
  ],
  nativeFailedShort: ["The engine could not start.", "引擎没能启动。", "引擎沒能啟動。"],
  nativeRetry: ["Try again", "重试", "重試"],
  nativeUnsupportedShort: ["Not available for this system", "这个系统暂不支持", "這個系統暫不支援"],
  nativeUnheard: [
    "{{name}} does not hear one of your two languages. Choose another model for it.",
    "{{name}} 听不了你选的其中一种语言，请换一个模型。",
    "{{name}} 聽不了你選的其中一種語言，請換一個模型。",
  ],
  nativeUnsupported: [
    "The native recognition engine is not available for this system. Choose another model in the Speech recognition card.",
    "这个系统暂不支持原生识别引擎。请在「语音识别」卡片里换一个模型。",
    "這個系統暫不支援原生辨識引擎。請在「語音辨識」卡片裡換一個模型。",
  ],
  nativeMissing: [
    "{{name}} is not downloaded yet. Download it in the Speech recognition card, or choose another model.",
    "{{name}} 还没有下载。请在「语音识别」卡片里下载，或者换一个模型。",
    "{{name}} 還沒有下載。請在「語音辨識」卡片裡下載，或者換一個模型。",
  ],
  nativeWarming: [
    "The recognition engine is still starting — about half a minute the first time after the computer boots. You can start as soon as it is ready.",
    "识别引擎还在启动，开机后第一次大约要半分钟。准备好后就可以开始。",
    "辨識引擎還在啟動，開機後第一次大約要半分鐘。準備好後就可以開始。",
  ],
  typedFailed: ['A sentence you typed was not translated: the translation model did not answer.', '有一句打字没能翻译：翻译模型没有回应。', '有一句打字沒能翻譯：翻譯模型沒有回應。'],
  feedbackFailed: ['One sentence got no grammar feedback: the feedback model did not answer.', '有一句话没有得到语法反馈：反馈模型没有回应。', '有一句話沒有得到語法回饋：回饋模型沒有回應。'],
  nativeInterrupted: ['The engine stopped while it was starting. Press Start again.', '引擎在启动途中被停下了，请再点一次开始。', '引擎在啟動途中被停下了，請再點一次開始。'],
  nativeBusy: ['A device you share with is using this engine with {{name}}. Wait for it to finish, or choose {{name}} here too.', '共享的设备正在用这个引擎跑 {{name}}。等它用完，或者这里也选 {{name}}。', '共享的裝置正在用這個引擎跑 {{name}}。等它用完，或者這裡也選 {{name}}。'],
  nativeFailed: [
    "The recognition engine of this computer could not start. In the Speech recognition card, press \"Try again\" — or choose another model.",
    "这台电脑的识别引擎没能启动。请在「语音识别」卡片里点「重试」，或者换一个模型。",
    "這台電腦的辨識引擎沒能啟動。請在「語音辨識」卡片裡點「重試」，或者換一個模型。",
  ],

  // What was found of each recognizer on Japanese VRChat talk (`measuredRank.ts`): for a person choosing, not a benchmark.
  noteNativeR2t2: [
    "Japanese talk, measured: about 18% of the characters wrong. It writes as it listens (about 2.5 s behind) and never changes what it wrote. When the graphics card cannot keep up (a weaker card, or a game running), the text falls further and further behind. About 3 GB of video memory.",
    "日语闲聊实测错字约 18%。边听边出字（慢约 2.5 秒），写出的字不再改。显卡忙不过来时（显卡不强，或同时开着游戏），文字会越落越远。约占 3 GB 显存。",
    "日語閒聊實測錯字約 18%。邊聽邊出字（慢約 2.5 秒），寫出的字不再改。顯示卡忙不過來時（顯示卡不強，或同時開著遊戲），文字會越落越遠。約佔 3 GB 顯示記憶體。",
  ],
  noteNativeQwen: [
    "Japanese talk, measured: about 16% of the characters wrong. It writes as you speak (about 1 s behind); the last few words settle when the sentence ends. When the graphics card is busy it only refreshes less often. About 3 GB of video memory, thirty languages.",
    "日语闲聊实测错字约 16%。边说边出字（慢约 1 秒），句尾几个字要等这句说完才定稿。显卡忙不过来时只是刷新慢一些。约占 3 GB 显存，支持 30 种语言。",
    "日語閒聊實測錯字約 16%。邊說邊出字（慢約 1 秒），句尾幾個字要等這句說完才定稿。顯示卡忙不過來時只是重新整理慢一些。約佔 3 GB 顯示記憶體，支援 30 種語言。",
  ],
  noteNativeQwenSmall: [
    "The light one, for a computer that runs a game at the same time: about 2 GB of video memory instead of 3. Japanese talk, measured: about 22% of the characters wrong, more than the 1.7B. Otherwise it works the same way, with the same thirty languages.",
    "省资源的小模型，适合同一台电脑还开着游戏时用：约占 2 GB 显存（1.7B 约 3 GB）。日语闲聊实测错字约 22%，比 1.7B 多一些。其他和 1.7B 一样，同样支持 30 种语言。",
    "省資源的小模型，適合同一台電腦還開著遊戲時用：約佔 2 GB 顯示記憶體（1.7B 約 3 GB）。日語閒聊實測錯字約 22%，比 1.7B 多一些。其他和 1.7B 一樣，同樣支援 30 種語言。",
  ],
  noteNativeNemotron: [
    "The lightest: about 1 GB of video memory. Japanese talk, measured: about 27% of the characters wrong, and a short sentence is sometimes left out altogether. Choose it only when the computer has no room for the ones above. Over thirty languages.",
    "最省显存：约占 1 GB。日语闲聊实测错字约 27%，短句有时会整句漏掉。只在显存实在放不下上面几个时再选它。支持三十多种语言。",
    "最省顯示記憶體：約佔 1 GB。日語閒聊實測錯字約 27%，短句有時會整句漏掉。只在顯示記憶體實在放不下上面幾個時再選它。支援三十多種語言。",
  ],
  // The native translation engine (llama.cpp's server) and what was found of its models.
  // The native feedback engine (llama.cpp's server with a small chat model) and what was found of its model.
  nativeCoachReady: ['The feedback engine is ready.', '语法反馈引擎已就绪。', '語法回饋引擎已就緒。'],
  nativeCoachWarmingShort: ['Starting the feedback engine…', '正在启动语法反馈引擎…', '正在啟動語法回饋引擎…'],
  nativeCoachFailedShort: ['The feedback engine could not start.', '语法反馈引擎没能启动。', '語法回饋引擎沒能啟動。'],
  nativeCoachUnsupported: [
    'The native feedback engine is not available for this system. Choose another model in the Grammar feedback card.',
    '这个系统暂不支持原生语法反馈引擎。请在「语法反馈」卡片里换一个模型。',
    '這個系統暫不支援原生語法回饋引擎。請在「語法回饋」卡片裡換一個模型。',
  ],
  nativeCoachMissing: [
    '{{name}} is not downloaded yet. Download it in the Grammar feedback card, or choose another model.',
    '{{name}} 还没有下载。请在「语法反馈」卡片里下载，或者换一个模型。',
    '{{name}} 還沒有下載。請在「語法回饋」卡片裡下載，或者換一個模型。',
  ],
  nativeCoachWarming: [
    'The feedback engine is still starting — a few seconds. You can start as soon as it is ready.',
    '语法反馈引擎还在启动，只要几秒。准备好后就可以开始。',
    '語法回饋引擎還在啟動，只要幾秒。準備好後就可以開始。',
  ],
  nativeCoachFailed: [
    'The feedback engine could not start. In the Grammar feedback card, press "Try again" — or choose another model.',
    '语法反馈引擎没能启动。请在「语法反馈」卡片里点「重试」，或者换一个模型。',
    '語法回饋引擎沒能啟動。請在「語法回饋」卡片裡點「重試」，或者換一個模型。',
  ],
  noteGemma4: [
    'Japanese grammar, measured: it caught 11 of 14 mistakes and left right casual speech alone; about 0.1 s an answer. About 1.5 GB of video memory.',
    '日语语法实测：14 句错句抓到 11 句，正确的口语不会乱改；每句约 0.1 秒。约占 1.5 GB 显存。',
    '日語語法實測：14 句錯句抓到 11 句，正確的口語不會亂改；每句約 0.1 秒。約佔 1.5 GB 顯示記憶體。',
  ],
  translatorReady: ['The translation engine is ready.', '翻译引擎已就绪。', '翻譯引擎已就緒。'],
  translatorWarmingShort: ['Starting the translation engine…', '正在启动翻译引擎…', '正在啟動翻譯引擎…'],
  translatorFailedShort: ['The translation engine could not start.', '翻译引擎没能启动。', '翻譯引擎沒能啟動。'],
  translatorUnfit: [
    '{{name}} does not translate between your two languages. Choose another model for it.',
    '{{name}} 不支持你选的这两种语言，请换一个模型。',
    '{{name}} 不支援你選的這兩種語言，請換一個模型。',
  ],
  translatorUnsupported: [
    'The native translation engine is not available for this system. Choose another model in the Translation card.',
    '这个系统暂不支持原生翻译引擎。请在「翻译」卡片里换一个模型。',
    '這個系統暫不支援原生翻譯引擎。請在「翻譯」卡片裡換一個模型。',
  ],
  translatorMissing: [
    '{{name}} is not downloaded yet. Download it in the Translation card, or choose another model.',
    '{{name}} 还没有下载。请在「翻译」卡片里下载，或者换一个模型。',
    '{{name}} 還沒有下載。請在「翻譯」卡片裡下載，或者換一個模型。',
  ],
  translatorWarming: [
    'The translation engine of this computer is still starting — a few seconds. You can start as soon as it is ready.',
    '这台电脑的翻译引擎还在启动，只要几秒。准备好后就可以开始。',
    '這台電腦的翻譯引擎還在啟動，只要幾秒。準備好後就可以開始。',
  ],
  translatorFailed: [
    'The translation engine of this computer could not start. In the Translation card, press "Try again" — or choose another model.',
    '这台电脑的翻译引擎没能启动。请在「翻译」卡片里点「重试」，或者换一个模型。',
    '這台電腦的翻譯引擎沒能啟動。請在「翻譯」卡片裡點「重試」，或者換一個模型。',
  ],
  noteIndexTranslate: [
    "Japanese into Chinese, measured: serious mistakes in about 3 of 30 sentences, the best measured; about 0.1 s a sentence. About 2 GB of video memory, over a hundred languages.",
    "日语译中文实测：30 句里严重错误约 3 句，是测过的里面最好的；一句约 0.1 秒。约占 2 GB 显存，支持一百多种语言。",
    "日語譯中文實測：30 句裡嚴重錯誤約 3 句，是測過的裡面最好的；一句約 0.1 秒。約佔 2 GB 顯示記憶體，支援一百多種語言。",
  ],
  noteHyMt2: [
    "Japanese into Chinese, measured: serious mistakes in about 8 of 30 sentences; about 0.1 s a sentence.",
    "日语译中文实测：30 句里严重错误约 8 句；一句约 0.1 秒。",
    "日語譯中文實測：30 句裡嚴重錯誤約 8 句；一句約 0.1 秒。",
  ],
  noteHyMt15: [
    "Japanese into Chinese, measured: serious mistakes in about 8 of 30 sentences, and it tends to add words of its own.",
    "日语译中文实测：30 句里严重错误约 8 句，还会自己加词。",
    "日語譯中文實測：30 句裡嚴重錯誤約 8 句，還會自己加詞。",
  ],
  noteAppleSpeech: [
    "Japanese talk, measured: about 13% of the characters wrong, the most accurate of all. It writes as it listens (about 2 s behind).",
    "日语闲聊实测错字约 13%，是所有里最准的。边听边出字（慢约 2 秒）。",
    "日語閒聊實測錯字約 13%，是所有裡最準的。邊聽邊出字（慢約 2 秒）。",
  ],
  noteQwen17: [
"Japanese talk, measured: about 19% of the characters wrong. It writes only once a sentence has ended (about 10 s behind); the GGUF version above writes as you speak.",
"日语闲聊实测错字约 19%。要等一句话说完才出字（慢约 10 秒）；上面的 GGUF 版边说边出字。",
"日語閒聊實測錯字約 19%。要等一句話說完才出字（慢約 10 秒）；上面的 GGUF 版邊說邊出字。",
  ],
  noteWhisperTurbo: [
    "Measured on Japanese VRChat talk: about 21% of the characters wrong, and steady. It writes only once a sentence has ended.",
    "日语 VRChat 闲聊实测：错字率约 21%，表现稳定。同样要等一句话说完才出字。",
    "日語 VRChat 閒聊實測：錯字率約 21%，表現穩定。同樣要等一句話說完才出字。",
  ],
  noteVoxtral4b: [
    "Measured on Japanese VRChat talk: quick — the text is about 2.6 s behind the voice — but about 27% of the characters wrong. For when speed matters more than accuracy.",
    "日语 VRChat 闲聊实测：出字快（比声音慢约 2.6 秒），但错字较多（约 27%）。更看重速度、能接受错字时选它。",
    "日語 VRChat 閒聊實測：出字快（比聲音慢約 2.6 秒），但錯字較多（約 27%）。更看重速度、能接受錯字時選它。",
  ],
  noteCohere: [
    "Measured on Japanese VRChat talk: about 33% of the characters wrong, and about a quarter of what was said left out. Not a good choice for Japanese conversation.",
    "日语 VRChat 闲聊实测：错字率约 33%，还会漏掉大约四分之一的话。不建议用于日语对话。",
    "日語 VRChat 閒聊實測：錯字率約 33%，還會漏掉大約四分之一的話。不建議用於日語對話。",
  ],
  noteWhisperMedium: [
    "Measured on Japanese VRChat talk: about 34% of the characters wrong.",
    "日语 VRChat 闲聊实测：错字率约 34%。",
    "日語 VRChat 閒聊實測：錯字率約 34%。",
  ],
  noteQwen06: [
    "Measured on Japanese VRChat talk: about 35% of the characters wrong. Small: for when the graphics card has little memory to spare.",
    "日语 VRChat 闲聊实测：错字率约 35%。体积小，显存紧张时可以用。",
    "日語 VRChat 閒聊實測：錯字率約 35%。體積小，顯示記憶體吃緊時可以用。",
  ],
  noteMoonshineJa: [
    "Measured on Japanese VRChat talk: about 70% of the characters wrong. Only for a computer whose graphics card cannot be used at all.",
    "日语 VRChat 闲聊实测：错字率约 70%。只适合显卡完全用不了时应急。",
    "日語 VRChat 閒聊實測：錯字率約 70%。只適合顯示卡完全用不了時應急。",
  ],
  noteGranite41: [
    "Measured on Japanese VRChat talk: it keeps repeating the same sentence. Not usable for Japanese conversation.",
    "日语 VRChat 闲聊实测：会不停重复同一句话，日语对话基本没法用。",
    "日語 VRChat 閒聊實測：會不停重複同一句話，日語對話基本沒法用。",
  ],
  noteSenseVoice: [
    "Measured on Japanese VRChat talk: it writes no kana, so Japanese comes out unreadable.",
    "日语 VRChat 闲聊实测：不会输出假名，日语基本读不通。",
    "日語 VRChat 閒聊實測：不會輸出假名，日語基本讀不通。",
  ],
};

const FORK = {
  sourceItalic: ['Source text in italics', '原文用斜体', '原文用斜體'],
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
