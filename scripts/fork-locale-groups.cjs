/**
 * Fork: the groups of strings written under `fork.<group>` by
 * `fork-localai-locales.cjs`, each string as [English, 简体, 繁體].
 */
module.exports = {
  // The tour's fork steps and copy (`src/components/Tour/steps.ts`): written under `tour.steps.<id>`, beside upstream's own, not under `fork`.
  tour: {
    'provider-settings': {
      content_kotomimi: [
        'Each stage has a card here: recognition, translation, grammar feedback. In its card you choose where it runs — another device on your network, an API model, or this computer — and, right under that, its model. Under Advanced → Provider this computer\'s models can also be shared with another device.',
        '这里每个环节一张卡片：语音识别、翻译、语法反馈。在卡片里选它在哪里运行（局域网里的另一台设备、API 模型、这台电脑），模型也在同一处选。到「高级 → 提供商」里，还可以把这台电脑的模型共享给另一台设备。',
        '這裡每個環節一張卡片：語音辨識、翻譯、文法回饋。在卡片裡選它在哪裡執行（區域網路裡的另一台裝置、API 模型、這台電腦），模型也在同一處選。到「進階 → 提供商」裡，還可以把這台電腦的模型共享給另一台裝置。',
      ],
    },
    models: {
      content_kotomimi: [
        'Models are downloaded here: open "Model library" in the card of a stage. The ones marked Recommended are the ones measured best on real conversation, and the mark beside each name says what was found of it. A model you download is put to use at once.',
        '模型在这里下载：在环节卡片里点「模型库」。带「推荐」的是用真实对话实测最好的，模型名字旁的小图标里写着实测结果。下载完会自动启用。',
        '模型在這裡下載：在環節卡片裡點「模型庫」。帶「推薦」的是用真實對話實測最好的，模型名稱旁的小圖示裡寫著實測結果。下載完會自動啟用。',
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
        'Speaking their language yourself? Turn on the Grammar feedback card in Settings: your speech is checked instead of translated.',
        '想自己直接说对方的语言？在设置里打开「语法反馈」那张卡片：你说的话不再翻译，而是帮你检查语法。',
        '想自己直接說對方的語言？在設定裡開啟「文法回饋」那張卡片：你說的話不再翻譯，而是幫你檢查文法。',
      ],
      share: [
        'Another device can use this computer\'s models: Advanced → Provider → Share with other devices.',
        '另一台设备也能用这台电脑的模型：「高级 → 提供商 → 共享给其他设备」。',
        '另一台裝置也能用這台電腦的模型：「進階 → 提供商 → 共享給其他裝置」。',
      ],
    },
  },
  // The setup wizard's own step and card for the Kotomimi provider (`src/components/SetupWizard/steps/StepKotomimi.tsx`).
  // Starting with the computer (`AutostartSection.tsx`).
  autostart: {
    title: ['Startup', '启动', '啟動'],
    toggle: ['Start in the background when I sign in to Windows', '登录 Windows 时在后台启动', '登入 Windows 時在背景啟動'],
    note: [
      "Kotomimi waits in the background after you sign in, with the recognition engine ready: open it and start at once.",
      "登录后 Kotomimi 在后台待命，并提前准备好识别引擎，打开就能用。",
      "登入後 Kotomimi 在背景待命，並提前準備好辨識引擎，開啟就能用。",
    ],
  },
  // The language menus' own list (`LanguageMenu.tsx`).
  languageMenu: {
    search: ['Type to find a language', '输入筛选语言', '輸入篩選語言'],
    none: ['No language by that name', '没有这个名字的语言', '沒有這個名稱的語言'],
    pin: ['Pin {{name}} to the top', '把{{name}}置顶', '把{{name}}置頂'],
    unpin: ['Unpin {{name}}', '取消置顶{{name}}', '取消置頂{{name}}'],
    pinShort: ['Pin to the top', '置顶', '置頂'],
    unpinShort: ['Unpin', '取消置顶', '取消置頂'],
  },
  wizard: {
    pathTitle: ['Kotomimi Pipeline', 'Kotomimi 自由搭配', 'Kotomimi 自由搭配'],
    pathBadge: ['Recommended', '推荐', '推薦'],
    pathDesc: [
      'Use the models of another device on your network, or this computer\'s own — and any mix of the two.',
      '用局域网里另一台设备的模型，或这台电脑自己的模型，也可以两边混着用。',
      '用區域網路裡另一台裝置的模型，或這台電腦自己的模型，也可以兩邊混著用。',
    ],
    pathCost: [
      'No account and no API key. Text only: subtitles with furigana, typed lookups and grammar feedback. Another device means a Kotomimi sharing its models, or a model server such as LocalAI; this computer downloads models onto your disk.',
      '不需要账号，也不需要 API 密钥。仅文本：带假名注音的字幕、打字翻译和语法反馈。另一台设备可以是开了共享的 Kotomimi，或 LocalAI 这类模型服务器；用这台电脑则要把模型下载到本地。',
      '不需要帳號，也不需要 API 金鑰。僅文字：帶假名注音的字幕、打字翻譯和文法回饋。另一台裝置可以是開了共享的 Kotomimi，或 LocalAI 這類模型伺服器；用這台電腦則要把模型下載到本機。',
    ],
    title: ['Which device does the work?', '由哪台设备来运行？', '由哪台裝置來執行？'],
    intro: [
      'Pick a starting point. Later, in Settings, recognition and translation can each run in a different place.',
      '先选一个起点。之后在设置里，识别和翻译可以各选各的地方，混着用。',
      '先選一個起點。之後在設定裡，辨識和翻譯可以各選各的地方，混著用。',
    ],
    server: ['Another device on my network', '局域网里的另一台设备', '區域網路裡的另一台裝置'],
    serverDesc: [
      'The models run on another computer: a Kotomimi with sharing turned on, or a model server such as LocalAI. This computer stays light.',
      '模型在另一台电脑上运行：开了共享的 Kotomimi，或 LocalAI 这类模型服务器。这台电脑几乎不占资源。',
      '模型在另一台電腦上執行：開了共享的 Kotomimi，或 LocalAI 這類模型伺服器。這台電腦幾乎不占資源。',
    ],
    device: ['This computer', '这台电脑', '這台電腦'],
    deviceDesc: [
      'Speech recognition runs right here, on models the app downloads; translation uses the online translator until you download a model for it. Nothing else is needed; a GPU helps.',
      '语音识别用应用下载的模型在本机运行；翻译先用在线翻译，下载翻译模型后也能在本机完成。不需要别的设备；有独立显卡会更快。',
      '語音辨識用應用程式下載的模型在本機執行；翻譯先用線上翻譯，下載翻譯模型後也能在本機完成。不需要別的裝置；有獨立顯示卡會更快。',
    ],
    share: ['This computer, for my other devices', '这台电脑给其他设备用', '這台電腦給其他裝置用'],
    shareDesc: [
      'Computing power to spare here? Let the models run on this computer for the other devices on your network — and for this computer itself.',
      '这台电脑算力闲置？让模型在这里运行，给局域网里的其他设备用，这台电脑自己也能用。',
      '這台電腦算力閒置？讓模型在這裡執行，給區域網路裡的其他裝置用，這台電腦自己也能用。',
    ],
    shareNotice: [
      "Nothing to enter. Finishing turns on sharing, so other Kotomimi devices on your network can find this computer. After setup, download models in the Speech recognition card: those are what the others can use.",
      "这里不用填任何东西。完成后会自动打开共享，局域网里的其他 Kotomimi 就能找到这台电脑。向导结束后，在设置的「语音识别」卡片里下载模型，别的设备用的就是这些。",
      "這裡不用填任何東西。完成後會自動開啟共享，區域網路裡的其他 Kotomimi 就能找到這台電腦。精靈結束後，在設定的「語音辨識」卡片裡下載模型，別的裝置用的就是這些。",
    ],
    shareSummary: ['Sharing', '共享', '共享'],
    shareSummaryOn: [
      'Turned on when you finish: other devices on your network can use this computer\'s models',
      '完成后打开，局域网里的其他设备可以用这台电脑的模型',
      '完成後開啟，區域網路裡的其他裝置可以用這台電腦的模型',
    ],
    tryServer: ['Connect', '连接', '連線'],
    keyNeeded: [
      'This device asks for an access key. Enter the key set on that device (on another Kotomimi, it is in its sharing Options), then press Connect.',
      '这台设备需要访问密钥。请填写那台设备设置的密钥（另一台 Kotomimi 的密钥在它共享的「选项」里），再点「连接」。',
      '這台裝置需要存取金鑰。請填寫那台裝置設定的金鑰（另一台 Kotomimi 的金鑰在它共享的「選項」裡），再按「連線」。',
    ],
    addressMissing: [
      'Choose a device from the list above, or type its address, for example 192.168.1.10:8790.',
      '请先在上面的列表里选一台设备，或填写它的地址，例如 192.168.1.10:8790。',
      '請先在上面的清單裡選一台裝置，或填寫它的位址，例如 192.168.1.10:8790。',
    ],
    serverFound: ['Connected — it offers {{count}} model(s).', '连接成功，对方有 {{count}} 个模型可用。', '連線成功，對方有 {{count}} 個模型可用。'],
    serverUnreachable: ['Could not connect: {{message}}', '连接不上：{{message}}', '連線不上：{{message}}'],
    pendingAddress: ['No device chosen yet — choose one in Settings before you start.', '还没有选另一台设备。开始之前请到设置里选好。', '還沒有選另一台裝置。開始之前請到設定裡選好。'],
    deviceNotice: [
      'Nothing to enter. After setup, download a speech recognition model in the Speech recognition card in Settings — the tour shows where. Translation works at once with the online translator, and offline models can be downloaded too.',
      '这里不用填任何东西。向导结束后，在设置的「语音识别」卡片里下载一个模型，引导会指给你看。翻译默认用在线翻译，马上可用，也可以再下载离线模型。',
      '這裡不用填任何東西。精靈結束後，在設定的「語音辨識」卡片裡下載一個模型，導覽會指給你看。翻譯預設用線上翻譯，馬上可用，也可以再下載離線模型。',
    ],
  },
  // Adding a model from Hugging Face (`src/components/CustomModels`).
  custom: {
    title: ['Add a Whisper model from Hugging Face', '添加 Hugging Face 上的 Whisper 模型', '新增 Hugging Face 上的 Whisper 模型'],
    intro: [
      "For a Whisper model the library does not list, such as one fine-tuned for your language. Give its Hugging Face repository id (most onnx-community/… and Xenova/… Whisper repositories work); it needs a graphics card.",
      "用于模型库里没有的 Whisper 模型，比如为某种语言微调的。填 Hugging Face 仓库名即可（onnx-community/… 和 Xenova/… 的 Whisper 仓库大多可用），需要显卡。",
      "用於模型庫裡沒有的 Whisper 模型，比如為某種語言微調的。填 Hugging Face 儲存庫名稱即可（onnx-community/… 和 Xenova/… 的 Whisper 儲存庫大多可用），需要顯示卡。",
    ],
    repo: ['Repository id', '仓库名', '儲存庫名稱'],
    language: ['The language it hears', '它识别的语言', '它辨識的語言'],
    anyLanguage: ['Every language', '多语言', '多語言'],
    add: ['Add', '添加', '新增'],
    adding: ['Looking…', '正在查询…', '正在查詢…'],
    added: ['Added {{name}} ({{size}} MB). Download it in the model library.', '已添加 {{name}}（{{size}} MB）。请到模型库里下载。', '已新增 {{name}}（{{size}} MB）。請到模型庫裡下載。'],
    downloaded: ['downloaded', '已下载', '已下載'],
    notDownloaded: ['not downloaded', '未下载', '未下載'],
    remove: ['Remove {{name}}', '移除 {{name}}', '移除 {{name}}'],
    error_bad_repo: ['That is not a repository id. It looks like owner/name.', '这不是仓库名。格式是 作者/名称。', '這不是儲存庫名稱。格式是 作者/名稱。'],
    error_not_found: ['No public repository by that name.', '找不到这个公开仓库。', '找不到這個公開儲存庫。'],
    error_unreachable: ['Could not reach Hugging Face: {{detail}}', '连接不上 Hugging Face：{{detail}}', '連線不上 Hugging Face：{{detail}}'],
    error_not_whisper: [
      'This repository is not a Whisper model in the ONNX layout. {{detail}}',
      '这个仓库不是 ONNX 格式的 Whisper 模型。{{detail}}',
      '這個儲存庫不是 ONNX 格式的 Whisper 模型。{{detail}}',
    ],
    error_exists: ['This model is already added.', '这个模型已经添加过了。', '這個模型已經新增過了。'],
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
  subtitle: {
    back: ['Back to the main window', '返回主窗口', '返回主視窗'],
  },
  fonts: {
    title: ['Fonts', '字体', '字型'],
    tooltip: [
      'Choose the fonts installed on this computer: one for the app itself, one for Latin letters, one for the romanization line, and one per language for conversation and subtitle text. A font is used where it has the glyphs; anything it lacks falls back to the app\'s own.',
      '从这台电脑已安装的字体里选：界面用一种，拉丁字母用一种，罗马音那一行用一种，对话和字幕文字可以按语言各选一种。选中的字体只在它有对应字形时生效，缺的字仍由应用默认字体显示。',
      '從這台電腦已安裝的字型裡選：介面用一種，拉丁字母用一種，羅馬拼音那一行用一種，對話和字幕文字可以按語言各選一種。選中的字型只在它有對應字形時生效，缺的字仍由應用程式預設字型顯示。',
    ],
    default: ['App default', '应用默认', '應用程式預設'],
    search: ['Search fonts', '搜索字体', '搜尋字型'],
    loading: ['Reading the installed fonts…', '正在读取已安装的字体…', '正在讀取已安裝的字型…'],
    none: ['No font matches', '没有匹配的字体', '沒有相符的字型'],
    others: ['Other fonts (may lack this script)', '其他字体（可能不含这种文字）', '其他字型（可能不含這種文字）'],
    ui: ['Interface', '界面', '介面'],
    uiHint: ['Menus, settings and buttons', '菜单、设置和按钮', '選單、設定和按鈕'],
    latin: ['Latin letters and digits', '拉丁字母和数字', '拉丁字母和數字'],
    latinHint: ['English letters and digits inside conversation text', '对话文字里的英文字母和数字', '對話文字裡的英文字母和數字'],
    roman: ['Romanization', '罗马音', '羅馬拼音'],
    romanHint: ['The line of readings under Japanese, Korean and Russian. App default: the same as Latin letters', '日语、韩语、俄语下面那一行读音。选「应用默认」则跟拉丁字母一样', '日語、韓語、俄語下面那一行讀音。選「應用程式預設」則跟拉丁字母一樣'],
    languages: ['Conversation text, by language', '对话文字，按语言设置', '對話文字，按語言設定'],
    text: ['Text', '正文', '正文'],
    reading: ['Readings above the text', '上方的注音假名', '上方的注音假名'],
    add: ['Add a language…', '添加语言…', '新增語言…'],
    remove: ['Reset {{language}}', '恢复 {{language}} 的默认字体', '恢復 {{language}} 的預設字型'],
  },
  // Sharing this computer's models on the local network (`src/components/LanSharing`).
  // The General page's one line about the provider, on the Advanced layout (`src/components/providers/ProviderPointer.tsx`).
  // The search of the local network for a device to use (`src/components/LanSharing/ServerFinder.tsx`).
  find: {
    title: ['Found on your network', '局域网里找到的设备', '區域網路裡找到的裝置'],
    search: ['Search my network for devices', '搜索局域网里的设备', '搜尋區域網路裡的裝置'],
    again: ['Search again', '重新搜索', '重新搜尋'],
    searching: ['Looking for devices on your network…', '正在搜索局域网里的设备…', '正在搜尋區域網路裡的裝置…'],
    none: [
      'Nothing found. Check that the other device is on, is on the same Wi-Fi or router as this one, and has "Share this computer\'s models" turned on in its Kotomimi. You can also type its address below.',
      '没有找到。请确认另一台设备已经开机、和这台电脑连着同一个 Wi-Fi 或路由器，并且在它的 Kotomimi 里打开了「共享这台电脑的模型」。也可以在下面手动填地址。',
      '沒有找到。請確認另一台裝置已經開機、和這台電腦連著同一個 Wi-Fi 或路由器，並且在它的 Kotomimi 裡開啟了「共享這台電腦的模型」。也可以在下面手動填位址。',
    ],
    kindKotomimi: ['Kotomimi', 'Kotomimi 共享', 'Kotomimi 共享'],
    kindServer: ['Model server', '模型服务器', '模型伺服器'],
    models: ['{{count}} model(s)', '{{count}} 个模型', '{{count}} 個模型'],
    needsKey: ['asks for an access key', '需要访问密钥', '需要存取金鑰'],
    thisComputer: ['On this computer', '这台电脑上的服务器', '這台電腦上的伺服器'],
    productHere: ['{{product}} on this computer', '这台电脑上的 {{product}}', '這台電腦上的 {{product}}'],
    use: ['Use {{name}}', '使用 {{name}}', '使用 {{name}}'],
    manual: ['Or type its address', '或者手动填写地址', '或者手動填寫位址'],
  },
  // Windows' virtual audio driver, asked about in the banner and no longer at start (`AudioSystemBanner.tsx`).
  audio: {
    vbcableMissing: [
      'The VB-CABLE virtual audio driver is not installed, so a spoken translation cannot be sent into a meeting. Subtitles do not need it.',
      '没有安装 VB-CABLE 虚拟声卡，所以翻译出来的语音送不进会议软件。只看字幕不需要它。',
      '沒有安裝 VB-CABLE 虛擬音效卡，所以翻譯出來的語音送不進會議軟體。只看字幕不需要它。',
    ],
    vbcableInstall: ['Install VB-CABLE', '安装 VB-CABLE', '安裝 VB-CABLE'],
    vbcableInstalling: ['Downloading… this can take a minute', '正在下载，可能要等一会儿…', '正在下載，可能要等一會兒…'],
  },
  // The LocalAI installed on this computer, run by the app (`src/components/LanSharing/LocalServerCard.tsx`).
  server: {
    title: ['LocalAI on this computer', '这台电脑上的 LocalAI', '這台電腦上的 LocalAI'],
    tooltip: [
      "A LocalAI is installed on this computer. Kotomimi starts and stops it; choose its models in the cards above, under \"This computer\". With sharing on, they are lent to other devices too.",
      "这台电脑装了 LocalAI，由 Kotomimi 负责启动和停止。上面各环节选「这台电脑」时可以选它的模型；打开共享后，它的模型也一起借给别的设备。",
      "這台電腦裝了 LocalAI，由 Kotomimi 負責啟動和停止。上面各環節選「這台電腦」時可以選它的模型；開啟共享後，它的模型也一起借給別的裝置。",
    ],
    stopped: ['Not running', '未启动', '未啟動'],
    starting: ['Starting…', '正在启动…', '正在啟動…'],
    running: ['Running · {{count}} model(s)', '运行中 · {{count}} 个模型', '執行中 · {{count}} 個模型'],
    external: ['Running · {{count}} model(s) · started by another program', '运行中 · {{count}} 个模型 · 由其他程序启动', '執行中 · {{count}} 個模型 · 由其他程式啟動'],
    failed: ['It would not start', '启动失败', '啟動失敗'],
    start: ['Start', '启动', '啟動'],
    stop: ['Stop', '停止', '停止'],
    autoStart: ['Start it when Kotomimi opens', '打开 Kotomimi 时自动启动', '開啟 Kotomimi 時自動啟動'],
    externalNote: [
      'Kotomimi did not start it — another program did — so it cannot be stopped from here, and its models are not unloaded when idle. To let Kotomimi run it, quit that program, then come back and press Start.',
      '它不是 Kotomimi 启动的，而是别的程序启动的，所以这里不能停止它，空闲的模型也不会自动卸载。想让 Kotomimi 来管，先退出那个程序，再回到这里点「启动」。',
      '它不是 Kotomimi 啟動的，而是別的程式啟動的，所以這裡不能停止它，閒置的模型也不會自動卸載。想讓 Kotomimi 來管，先結束那個程式，再回到這裡按「啟動」。',
    ],
    openPage: ['Open LocalAI\'s page to install or remove models', '打开 LocalAI 的页面，安装或删除模型', '開啟 LocalAI 的頁面，安裝或刪除模型'],
    lastWords: ['What LocalAI said last', 'LocalAI 最后的输出', 'LocalAI 最後的輸出'],
    pipelineTitle: [
      'What another device gets when it does not choose',
      '别的设备没指定模型时用哪个',
      '別的裝置沒指定模型時用哪個',
    ],
    pipelineSwitching: ['Switching…', '正在切换…', '正在切換…'],
    pipelineFailed: ['Could not switch: {{message}}', '切换失败：{{message}}', '切換失敗：{{message}}'],
    pipelineNote: [
      'A device that leaves the model to this computer gets these two. One that names a recognizer changes the first by itself. A change takes effect from the next session.',
      '别的设备把模型留给这台电脑决定时，用的就是这两个。对方指定了识别模型时，第一个会自动跟着换。改动从下一次会话开始生效。',
      '別的裝置把模型留給這台電腦決定時，用的就是這兩個。對方指定了辨識模型時，第一個會自動跟著換。改動從下一次工作階段開始生效。',
    ],
  },
  lan: {
    title: ['Share with other devices', '共享给其他设备', '共享給其他裝置'],
    tooltip: [
      "Lends the models of this computer to other devices on your network. On the other device, Kotomimi finds this computer under \"Another device\", and the model and language are chosen there. Works while Kotomimi is open.",
      "把这台电脑的模型借给局域网里的其他设备。对方在 Kotomimi 的「另一台设备」里搜索就能找到这台电脑，用哪个模型、什么语言在对方那边选。Kotomimi 开着时才能共享。",
      "把這台電腦的模型借給區域網路裡的其他裝置。對方在 Kotomimi 的「另一台裝置」裡搜尋就能找到這台電腦，用哪個模型、什麼語言在對方那邊選。Kotomimi 開著時才能共享。",
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
    copy: ['Copy', '复制', '複製'],
    copied: ['Copied', '已复制', '已複製'],
    noNetwork: ['This computer is on no network.', '这台电脑当前没有连接网络。', '這台電腦目前沒有連上網路。'],
    models: [
      'Models shared · {{count}}',
      '共享的模型 · {{count}} 个',
      '共享的模型 · {{count}} 個',
    ],
    fromLocalAI: ['From this computer\'s LocalAI ({{id}})', '来自这台电脑的 LocalAI（{{id}}）', '來自這台電腦的 LocalAI（{{id}}）'],
    sessionIdle: [
      'The other device ended the session: nobody had spoken for a long while, and it let its models go. Start again to continue.',
      '另一台设备结束了这次会话：太久没有人说话，它把模型从内存里释放了。重新点「开始」就能继续。',
      '另一台裝置結束了這次工作階段：太久沒有人說話，它把模型從記憶體釋放了。重新按「開始」就能繼續。',
    ],
    serving: ['Sharing', '共享中', '共享中'],
    servingClients: ['Sharing · {{count}} in use', '共享中 · {{count}} 路在用', '共享中 · {{count}} 路在用'],
    servingTip: [
      'This computer is lending its models to other devices. The languages and the choice of model are set on those devices, not here.',
      '这台电脑正在把模型借给其他设备用。语言和用哪个模型，在那些设备上设置，不在这里。',
      '這台電腦正在把模型借給其他裝置用。語言和用哪個模型，在那些裝置上設定，不在這裡。',
    ],
    noRecognizer: ['No speech recognition model downloaded yet', '还没有下载语音识别模型', '尚未下載語音辨識模型'],
    showLibrary: ['Download or manage models', '下载或管理模型', '下載或管理模型'],
    hideLibrary: ['Hide the model library', '收起模型库', '收起模型庫'],
    direction: ['Which direction to show models for', '显示哪个方向的模型', '顯示哪個方向的模型'],
    options: ['Options', '选项', '選項'],
    otherAddresses: ['This computer\'s other addresses', '这台电脑的其他地址', '這台電腦的其他位址'],
    port: ['Port', '端口', '連接埠'],
    key: ['Access key', '访问密钥', '存取金鑰'],
    keyPlaceholder: ['Blank: anyone on the network may connect', '留空：局域网里任何设备都能连接', '留空：區域網路裡任何裝置都能連線'],
    firewallBlocked: ['Windows Firewall is keeping other devices out', 'Windows 防火墙挡住了其他设备', 'Windows 防火牆擋住了其他裝置'],
    firewallPrivate: [
      'Allow opens this port to devices on your network. Windows will ask you to confirm.',
      '点「允许」后，局域网里的设备就能连上这个端口。Windows 会先请你确认。',
      '按「允許」後，區域網路裡的裝置就能連上這個連接埠。Windows 會先請你確認。',
    ],
    firewallPublic: [
      'Windows treats this network as public. Allow opens this port to devices on this same network only. Windows will ask you to confirm.',
      'Windows 把当前网络当作「公用网络」。点「允许」后，只对同一网络里的设备开放这个端口。Windows 会先请你确认。',
      'Windows 把目前的網路當作「公用網路」。按「允許」後，只對同一網路裡的裝置開放這個連接埠。Windows 會先請你確認。',
    ],
    firewallAllow: ['Allow', '允许', '允許'],
    firewallWaiting: ['Waiting for Windows…', '等待 Windows…', '等待 Windows…'],
    firewallDeclined: ['Still blocked: Windows was not told yes.', '仍然被挡住：Windows 那边没有得到确认。', '仍然被擋住：Windows 那邊沒有得到確認。'],
    firewall: [
      'The first time, your system\'s firewall may ask whether to allow Kotomimi on the network: allow it for private networks.',
      '第一次开启时，系统防火墙可能询问是否允许 Kotomimi 访问网络：请允许它在专用网络上通信。',
      '第一次開啟時，系統防火牆可能詢問是否允許 Kotomimi 存取網路：請允許它在私人網路上通訊。',
    ],
  },
};
