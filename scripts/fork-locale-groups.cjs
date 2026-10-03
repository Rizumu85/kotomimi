/**
 * Fork: the groups of strings written under `fork.<group>` by
 * `fork-localai-locales.cjs`, each string as [English, 简体, 繁體].
 */
module.exports = {
  // The tour's fork steps and copy (`src/components/Tour/steps.ts`): written under `tour.steps.<id>`, beside upstream's own, not under `fork`.
  tour: {
    'provider-settings': {
      content_kotomimi: [
        'Here you choose whose models to use: another device on your network, or this computer. Under Advanced → Provider each stage — recognition, translation, grammar feedback — can be put where you like, and this computer\'s models can be shared with another device on your network.',
        '在这里选择用谁的模型：局域网里的另一台设备，还是这台电脑。到「高级 → 提供商」里，可以分别指定识别、翻译、语法反馈各自在哪里运行，也可以把这台电脑的模型共享给局域网里的另一台设备。',
        '在這裡選擇用誰的模型：區域網路裡的另一台裝置，還是這台電腦。到「進階 → 提供者」裡，可以分別指定辨識、翻譯、文法回饋各自在哪裡執行，也可以把這台電腦的模型共享給區域網路裡的另一台裝置。',
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
        'Another device can use this computer\'s models: Advanced → Provider → Share with other devices.',
        '另一台设备也能用这台电脑的模型：「高级 → 提供商 → 共享给其他设备」。',
        '另一台裝置也能用這台電腦的模型：「進階 → 提供者 → 共享給其他裝置」。',
      ],
    },
  },
  // The setup wizard's own step and card for the Kotomimi provider (`src/components/SetupWizard/steps/StepKotomimi.tsx`).
  wizard: {
    pathTitle: ['Kotomimi Pipeline', 'Kotomimi 自由搭配', 'Kotomimi 自由搭配'],
    pathBadge: ['This app\'s own', '本应用特色', '本應用程式特色'],
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
      'Pick a starting point. It is not either-or: later, in Settings, recognition and translation can each run in a different place.',
      '先选一个起点。这不是二选一：之后在设置里，识别和翻译可以各选各的地方，混着用。',
      '先選一個起點。這不是二選一：之後在設定裡，辨識和翻譯可以各選各的地方，混著用。',
    ],
    server: ['Another device on my network', '局域网里的另一台设备', '區域網路裡的另一台裝置'],
    serverDesc: [
      'The models run on another computer: a Kotomimi with sharing turned on, or a model server such as LocalAI. This computer stays light.',
      '模型在另一台电脑上运行：开了共享的 Kotomimi，或 LocalAI 这类模型服务器。这台电脑几乎不占资源。',
      '模型在另一台電腦上執行：開了共享的 Kotomimi，或 LocalAI 這類模型伺服器。這台電腦幾乎不占資源。',
    ],
    device: ['This computer', '这台电脑', '這台電腦'],
    deviceDesc: [
      'Models downloaded by the app run right here. Nothing else is needed; a GPU helps.',
      '用应用下载的模型，全部在本机运行。不需要别的设备；有独立显卡会更快。',
      '用應用程式下載的模型，全部在本機執行。不需要別的裝置；有獨立顯示卡會更快。',
    ],
    tryServer: ['Connect', '连接', '連線'],
    addressMissing: [
      'Choose a device from the list above, or type its address, for example 192.168.1.10:8790.',
      '请先在上面的列表里选一台设备，或填写它的地址，例如 192.168.1.10:8790。',
      '請先在上面的清單裡選一台裝置，或填寫它的位址，例如 192.168.1.10:8790。',
    ],
    serverFound: ['Connected — it offers {{count}} model(s).', '连接成功，对方有 {{count}} 个模型可用。', '連線成功，對方有 {{count}} 個模型可用。'],
    serverUnreachable: ['Could not connect: {{message}}', '连接不上：{{message}}', '連線不上：{{message}}'],
    pendingAddress: ['No device chosen yet — choose one in Settings before you start.', '还没有选另一台设备。开始之前请到设置里选好。', '還沒有選另一台裝置。開始之前請到設定裡選好。'],
    deviceNotice: [
      'Nothing to enter. After setup, download a speech recognition model under Models — the tour shows where. Translation works at once with the online translator, and offline models can be downloaded too.',
      '这里不用填任何东西。向导结束后，在「模型」里下载一个语音识别模型，引导会指给你看。翻译默认用在线翻译，马上可用，也可以再下载离线模型。',
      '這裡不用填任何東西。精靈結束後，在「模型」裡下載一個語音辨識模型，導覽會指給你看。翻譯預設用線上翻譯，馬上可用，也可以再下載離線模型。',
    ],
  },
  // Adding a model from Hugging Face (`src/components/CustomModels`).
  custom: {
    title: ['Add a Whisper model from Hugging Face', '添加 Hugging Face 上的 Whisper 模型', '新增 Hugging Face 上的 Whisper 模型'],
    intro: [
      'For a speech recognition model the library does not list — a Whisper fine-tuned for your language, say. Give the repository id; it must hold ONNX files in the Transformers.js layout (most onnx-community/… and Xenova/… Whisper repositories do), and it needs a GPU. Once added it appears in the model library to download.',
      '用于模型库里没有的语音识别模型，比如专门为某种语言微调的 Whisper。填仓库名即可；仓库里要有 Transformers.js 用的 ONNX 文件（onnx-community/… 和 Xenova/… 的 Whisper 仓库大多符合），并且需要显卡。添加后它会出现在模型库里，可以下载。',
      '用於模型庫裡沒有的語音辨識模型，比如專門為某種語言微調的 Whisper。填儲存庫名稱即可；儲存庫裡要有 Transformers.js 用的 ONNX 檔案（onnx-community/… 和 Xenova/… 的 Whisper 儲存庫大多符合），並且需要顯示卡。新增後它會出現在模型庫裡，可以下載。',
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
    use: ['Use {{name}}', '使用 {{name}}', '使用 {{name}}'],
    manual: ['Or type its address', '或者手动填写地址', '或者手動填寫位址'],
  },
  lan: {
    title: ['Share with other devices', '共享给其他设备', '共享給其他裝置'],
    intro: [
      'The other way round: this computer does the work, and another device on your network uses the models downloaded here.',
      '方向反过来：由这台电脑出力，局域网里的另一台设备来用这里下载好的模型。',
      '方向反過來：由這台電腦出力，區域網路裡的另一台裝置來用這裡下載好的模型。',
    ],
    tooltip: [
      'Lets another device on your network use the models this computer has downloaded — speech recognition and translation. The other device runs Kotomimi too and chooses "Use another device": this computer then appears in its list. Sharing works while this app is open.',
      '让局域网里的另一台设备使用这台电脑已下载的模型（语音识别和翻译）。对方同样运行 Kotomimi，选「用另一台设备」，这台电脑就会出现在它的列表里。本应用开着的时候才能共享。',
      '讓區域網路裡的另一台裝置使用這台電腦已下載的模型（語音辨識和翻譯）。對方同樣執行 Kotomimi，選「用另一台裝置」，這台電腦就會出現在它的清單裡。本應用程式開著的時候才能共享。',
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
    address: ['If it does not appear there, type this address', '没出现的话，手动填这个地址', '沒出現的話，手動填這個位址'],
    foundAs: [
      'On the other device, open Kotomimi and choose "Use another device". This computer appears in its list as {{name}}: click it.',
      '在另一台设备的 Kotomimi 里选「用另一台设备」，这台电脑会以「{{name}}」出现在列表里，点一下就连上了。',
      '在另一台裝置的 Kotomimi 裡選「用另一台裝置」，這台電腦會以「{{name}}」出現在清單裡，點一下就連上了。',
    ],
    foundAsUnnamed: [
      'On the other device, open Kotomimi and choose "Use another device". This computer appears in its list: click it.',
      '在另一台设备的 Kotomimi 里选「用另一台设备」，这台电脑会出现在列表里，点一下就连上了。',
      '在另一台裝置的 Kotomimi 裡選「用另一台裝置」，這台電腦會出現在清單裡，點一下就連上了。',
    ],
    copy: ['Copy', '复制', '複製'],
    copied: ['Copied', '已复制', '已複製'],
    noNetwork: ['This computer is on no network.', '这台电脑当前没有连接网络。', '這台電腦目前沒有連上網路。'],
    models: ['Models shared', '共享的模型', '共享的模型'],
    noRecognizer: ['No speech recognition model downloaded yet', '还没有下载语音识别模型', '尚未下載語音辨識模型'],
    showLibrary: ['Download or manage models', '下载或管理模型', '下載或管理模型'],
    hideLibrary: ['Hide the model library', '收起模型库', '收起模型庫'],
    direction: ['Which direction to show models for', '显示哪个方向的模型', '顯示哪個方向的模型'],
    options: ['Options', '选项', '選項'],
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
    firewallOk: ['Windows Firewall lets other devices in', 'Windows 防火墙已放行其他设备', 'Windows 防火牆已放行其他裝置'],
    firewall: [
      'The first time, your system\'s firewall may ask whether to allow Kotomimi on the network: allow it for private networks.',
      '第一次开启时，系统防火墙可能询问是否允许 Kotomimi 访问网络：请允许它在专用网络上通信。',
      '第一次開啟時，系統防火牆可能詢問是否允許 Kotomimi 存取網路：請允許它在私人網路上通訊。',
    ],
  },
};
