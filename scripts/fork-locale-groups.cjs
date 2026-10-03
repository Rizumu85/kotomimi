/**
 * Fork: the groups of strings written under `fork.<group>` by
 * `fork-localai-locales.cjs`, each string as [English, 简体, 繁體].
 */
module.exports = {
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
