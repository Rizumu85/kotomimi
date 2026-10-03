/**
 * Fork: the groups of strings written under `fork.<group>` by
 * `fork-localai-locales.cjs`, each string as [English, 简体, 繁體].
 */
module.exports = {
  // The tour's fork steps and copy (`src/components/Tour/steps.ts`): written under `tour.steps.<id>`, beside upstream's own, not under `fork`.
  tour: {
    'provider-settings': {
      content_kotomimi: [
        'Here you choose a server or this computer. Under Advanced → Provider each stage — recognition, translation, grammar feedback — can be put where you like, and this computer\'s models can be shared with another device on your network.',
        '在这里选择连接服务器，还是用这台电脑的模型。到「高级 → 提供商」里，可以分别指定识别、翻译、语法反馈各自在哪里运行，也可以把这台电脑的模型共享给局域网里的另一台设备。',
        '在這裡選擇連線伺服器，還是用這台電腦的模型。到「進階 → 提供者」裡，可以分別指定辨識、翻譯、文法回饋各自在哪裡執行，也可以把這台電腦的模型共享給區域網路裡的另一台裝置。',
      ],
    },
    'reading-aids': {
      title: ['Reading aids', '阅读辅助', '閱讀輔助'],
      content: ['Help for reading the other language, switched here:', '帮你读懂外语的辅助显示，在这里开关：', '幫你讀懂外語的輔助顯示，在這裡開關：'],
      furigana: ['Furigana — kana above Japanese kanji.', '假名注音：日语汉字上方显示读音。', '假名注音：日語漢字上方顯示讀音。'],
      romanization: ['Romanization — a line in Latin letters under Japanese, Korean and Russian.', '罗马音：日语、韩语、俄语下方加一行拉丁字母读音。', '羅馬拼音：日語、韓語、俄語下方加一行拉丁字母讀音。'],
      fonts: ['Fonts for each language are under Settings → Fonts.', '各语言的字体在「设置 → 字体」里选。', '各語言的字型在「設定 → 字型」裡選。'],
    },
    'kotomimi-tips': {
      title: ['Three more things', '还有三件事', '還有三件事'],
      content: ['Worth knowing before you start:', '开始之前值得知道：', '開始之前值得知道：'],
      typed: [
        'During a session a box appears at the bottom: type a sentence to have it translated. Ctrl+K jumps to it.',
        '会话开始后，底部会出现输入框：打一句话就能翻译。按 Ctrl+K 可以直接跳到输入框。',
        '工作階段開始後，底部會出現輸入框：打一句話就能翻譯。按 Ctrl+K 可以直接跳到輸入框。',
      ],
      coach: [
        'Speaking their language yourself? Turn on Grammar feedback under Advanced → Provider: your speech is checked instead of translated.',
        '想自己直接说对方的语言？到「高级 → 提供商」打开「语法反馈」：你说的话不再翻译，而是帮你检查语法。',
        '想自己直接說對方的語言？到「進階 → 提供者」開啟「文法回饋」：你說的話不再翻譯，而是幫你檢查文法。',
      ],
      share: [
        'Another device can use this computer\'s models: Advanced → Provider → Share on the local network.',
        '另一台设备也能用这台电脑的模型：「高级 → 提供商 → 局域网共享」。',
        '另一台裝置也能用這台電腦的模型：「進階 → 提供者 → 區域網路共享」。',
      ],
    },
  },
  // The setup wizard's own step and card for the Kotomimi provider (`src/components/SetupWizard/steps/StepKotomimi.tsx`).
  wizard: {
    pathTitle: ['Kotomimi Pipeline', 'Kotomimi 自由搭配', 'Kotomimi 自由搭配'],
    pathBadge: ['This app\'s own', '本应用特色', '本應用程式特色'],
    pathDesc: [
      'Your own server on the network, or this computer\'s own models — and any mix of the two.',
      '用局域网里你自己的服务器，或这台电脑自己的模型，也可以两边混着用。',
      '用區域網路裡你自己的伺服器，或這台電腦自己的模型，也可以兩邊混著用。',
    ],
    pathCost: [
      'No account and no API key. Text only: subtitles with furigana, typed lookups and grammar feedback. A server means a LocalAI, or another Kotomimi sharing its models; this computer downloads models onto your disk.',
      '不需要账号，也不需要 API 密钥。仅文本：带假名注音的字幕、打字翻译和语法反馈。服务器可以是 LocalAI，或另一台开启了共享的 Kotomimi；用这台电脑则要把模型下载到本地。',
      '不需要帳號，也不需要 API 金鑰。僅文字：帶假名注音的字幕、打字翻譯和文法回饋。伺服器可以是 LocalAI，或另一台開啟了共享的 Kotomimi；用這台電腦則要把模型下載到本機。',
    ],
    title: ['Where should it run?', '在哪里运行？', '在哪裡執行？'],
    intro: [
      'Choose what listens and translates. You can change it, or mix the two stage by stage, later in Settings.',
      '选择由谁来识别和翻译。之后可以在设置里随时更改，也可以按环节混搭。',
      '選擇由誰來辨識和翻譯。之後可以在設定裡隨時更改，也可以按環節混搭。',
    ],
    server: ['A server on my network', '局域网里的服务器', '區域網路裡的伺服器'],
    serverDesc: [
      'A LocalAI, or another computer running Kotomimi with sharing turned on. This computer stays light.',
      'LocalAI，或另一台开启了「局域网共享」的 Kotomimi。这台电脑几乎不占资源。',
      'LocalAI，或另一台開啟了「區域網路共享」的 Kotomimi。這台電腦幾乎不占資源。',
    ],
    device: ['This computer', '这台电脑', '這台電腦'],
    deviceDesc: [
      'Models downloaded by the app run right here. Nothing else is needed; a GPU helps.',
      '用应用下载的模型，全部在本机运行。不需要别的设备；有独立显卡会更快。',
      '用應用程式下載的模型，全部在本機執行。不需要別的裝置；有獨立顯示卡會更快。',
    ],
    tryServer: ['Connect', '连接', '連線'],
    addressMissing: ['Type the server\'s address first, for example 192.168.1.10:8080.', '请先填写服务器地址，例如 192.168.1.10:8080。', '請先填寫伺服器位址，例如 192.168.1.10:8080。'],
    serverFound: ['Connected — the server lists {{count}} model(s).', '连接成功，服务器上有 {{count}} 个模型。', '連線成功，伺服器上有 {{count}} 個模型。'],
    serverUnreachable: ['Could not reach the server: {{message}}', '连接不上服务器：{{message}}', '連線不上伺服器：{{message}}'],
    pendingAddress: [
      'No server address yet — add it in Settings before you start.',
      '还没有填服务器地址。开始之前请到设置里补上。',
      '還沒有填伺服器位址。開始之前請到設定裡補上。',
    ],
    deviceNotice: [
      'Nothing to enter. After setup, download a speech recognition model under Models — the tour shows where. Translation works at once with the online translator, and offline models can be downloaded too.',
      '这里不用填任何东西。向导结束后，在「模型」里下载一个语音识别模型，引导会指给你看。翻译默认用在线翻译，马上可用，也可以再下载离线模型。',
      '這裡不用填任何東西。精靈結束後，在「模型」裡下載一個語音辨識模型，導覽會指給你看。翻譯預設用線上翻譯，馬上可用，也可以再下載離線模型。',
    ],
  },
  // Help: the fork's own link, in place of upstream's support address and discussion board.
  help: {
    issues: ['Report a problem', '反馈问题', '回報問題'],
    issuesTooltip: [
      'Kotomimi is an independent fork of Sokuji. Problems with this app are reported on its own GitHub page.',
      'Kotomimi 是 Sokuji 的独立分支。这个应用的问题请到它自己的 GitHub 页面反馈。',
      'Kotomimi 是 Sokuji 的獨立分支。這個應用程式的問題請到它自己的 GitHub 頁面回報。',
    ],
  },
  // The fonts (`src/components/Fonts`).
  fonts: {
    title: ['Fonts', '字体', '字型'],
    tooltip: [
      'Choose the fonts installed on this computer: one for the app itself, one for Latin letters and the romanization line, and one per language for conversation and subtitle text. A font is used where it has the glyphs; anything it lacks falls back to the app\'s own.',
      '从这台电脑已安装的字体里选：界面用一种，拉丁字母和罗马音用一种，对话和字幕文字可以按语言各选一种。选中的字体只在它有对应字形时生效，缺的字仍由应用默认字体显示。',
      '從這台電腦已安裝的字型裡選：介面用一種，拉丁字母和羅馬拼音用一種，對話和字幕文字可以按語言各選一種。選中的字型只在它有對應字形時生效，缺的字仍由應用程式預設字型顯示。',
    ],
    default: ['App default', '应用默认', '應用程式預設'],
    search: ['Search fonts', '搜索字体', '搜尋字型'],
    loading: ['Reading the installed fonts…', '正在读取已安装的字体…', '正在讀取已安裝的字型…'],
    none: ['No font matches', '没有匹配的字体', '沒有相符的字型'],
    others: ['Other fonts (may lack this script)', '其他字体（可能不含这种文字）', '其他字型（可能不含這種文字）'],
    ui: ['Interface', '界面', '介面'],
    uiHint: ['Menus, settings and buttons', '菜单、设置和按钮', '選單、設定和按鈕'],
    latin: ['Latin letters and romanization', '拉丁字母和罗马音', '拉丁字母和羅馬拼音'],
    latinHint: ['Letters and digits in conversation text, and the romanization line', '对话文字里的英文字母和数字，以及罗马音那一行', '對話文字裡的英文字母和數字，以及羅馬拼音那一行'],
    languages: ['Conversation text, by language', '对话文字，按语言设置', '對話文字，按語言設定'],
    text: ['Text', '正文', '正文'],
    reading: ['Readings above the text', '上方的注音假名', '上方的注音假名'],
    add: ['Add a language…', '添加语言…', '新增語言…'],
    remove: ['Reset {{language}}', '恢复 {{language}} 的默认字体', '恢復 {{language}} 的預設字型'],
  },
  // Sharing this computer's models on the local network (`src/components/LanSharing`).
  lan: {
    title: ['Share on the local network', '局域网共享', '區域網路共享'],
    tooltip: [
      'Lets another device on your network use the models this computer has downloaded — speech recognition and translation. The other device runs Kotomimi too, and types this computer\'s address where a server\'s goes. Sharing works while this app is open.',
      '让局域网里的另一台设备使用这台电脑已下载的模型（语音识别和翻译）。对方同样运行 Kotomimi，把这台电脑的地址填到"服务器地址"里即可。本应用开着的时候才能共享。',
      '讓區域網路裡的另一台裝置使用這台電腦已下載的模型（語音辨識和翻譯）。對方同樣執行 Kotomimi，把這台電腦的位址填到「伺服器位址」裡即可。本應用程式開著的時候才能共享。',
    ],
    enable: ['Share this computer\'s models', '共享这台电脑的模型', '共享這台電腦的模型'],
    starting: ['Starting…', '正在启动…', '正在啟動…'],
    on: ['Sharing — no device connected yet', '正在共享，暂时没有设备连接', '正在共享，暫時沒有裝置連線'],
    onWithClients: ['Sharing — {{count}} connection(s) in use', '正在共享，当前有 {{count}} 路连接', '正在共享，目前有 {{count}} 路連線'],
    portInUse: [
      'Port {{port}} is taken by another program. Choose another under Options.',
      '端口 {{port}} 已被其他程序占用。请在"选项"里换一个端口。',
      '連接埠 {{port}} 已被其他程式占用。請在「選項」裡換一個連接埠。',
    ],
    failed: ['Sharing could not start: {{message}}', '无法开始共享：{{message}}', '無法開始共享：{{message}}'],
    address: ['Address for the other device', '给另一台设备填的地址', '給另一台裝置填的位址'],
    copy: ['Copy', '复制', '複製'],
    copied: ['Copied', '已复制', '已複製'],
    noNetwork: ['This computer is on no network.', '这台电脑当前没有连接网络。', '這台電腦目前沒有連上網路。'],
    howTo: [
      'On the other device, choose Kotomimi Pipeline and type this address as the server address.',
      '在另一台设备的 Kotomimi 里选择"Kotomimi 自由搭配"，把这个地址填到"服务器地址"。',
      '在另一台裝置的 Kotomimi 裡選擇「Kotomimi 自由搭配」，把這個位址填到「伺服器位址」。',
    ],
    models: ['Models shared', '共享的模型', '共享的模型'],
    noRecognizer: ['No speech recognition model downloaded yet', '还没有下载语音识别模型', '尚未下載語音辨識模型'],
    showLibrary: ['Download or manage models', '下载或管理模型', '下載或管理模型'],
    hideLibrary: ['Hide the model library', '收起模型库', '收起模型庫'],
    options: ['Options', '选项', '選項'],
    port: ['Port', '端口', '連接埠'],
    key: ['Access key', '访问密钥', '存取金鑰'],
    keyPlaceholder: ['Blank: anyone on the network may connect', '留空：局域网里任何设备都能连接', '留空：區域網路裡任何裝置都能連線'],
    firewall: [
      'The first time, your system\'s firewall may ask whether to allow Kotomimi on the network: allow it for private networks.',
      '第一次开启时，系统防火墙可能询问是否允许 Kotomimi 访问网络：请允许它在专用网络上通信。',
      '第一次開啟時，系統防火牆可能詢問是否允許 Kotomimi 存取網路：請允許它在私人網路上通訊。',
    ],
  },
};
