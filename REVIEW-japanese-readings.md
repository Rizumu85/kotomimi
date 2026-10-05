# Review: reading corrections for Japanese (`src/lib/annotate/japaneseReadings.ts`)

Reviewed on branch `localai` at `6c76dd6`, with the dictionary from `npm ci` (`@sglkc/kuromoji`, IPADIC). Every row
below comes from a probe that builds the tokenizer exactly as `japaneseReadings.test.ts` does. For each line the probe printed
the dictionary's reading, the corrected reading, the ruby parts and the Hepburn line. About 980 distinct lines were run.

- **Dictionary**: kuromoji alone, the token's `reading`.
- **Corrected**: after `correctReadings`, what the app shows today.
- **Correct**: what a speaker says.

Companion test file: `src/lib/annotate/japaneseReadings.review.test.ts`.

| Group in the test file | Count | State today |
|---|---|---|
| fires and is wrong | 42 | fail (by design) |
| romanized after a correction | 6 | fail (by design) |
| keeps (must not regress) | 41 | pass |
| not yet put right (`it.skip`, ranked) | 77 | each fails if turned on (checked) |

The proposed conditions in sections 1 and 2 were also applied to a **scratch copy** of the module; the shipped file was not
edited. In that copy, all 48 failing cases pass, the 41 keeps still pass and 60 of the 77 misses pass (ranks 1–16). Every
existing test in `japaneseReadings.test.ts` and `annotate.test.ts` still passes except one, `三日後 → さんにちご`, whose
expected reading is itself wrong (see 4.6). The diff is in the appendix. Across all ~980 probe lines, the readings the
copy changes are exactly the ones these tables list.

---

## 1. False positives: a rule fires and the reading it gives is wrong

Ordered by how much each matters in casual VRChat speech, highest first.

### 1.1 方: "tends to / is on the … side" read as a person (high frequency)

`Vる方だ`, `Vた方だ` and `〜な方だ` are everyday self-description, and in all of them 方 is ほう. Two branches of the 方 rule
fire on them. The "politely" branch fires on a 動詞 or 助動詞 before 方 with です/だ/でし after it. The な branch fires on a
動詞 before 方 with な after it.

| # | Sentence | Token | Dictionary | Corrected | Correct | Rule (branch) |
|---|---|---|---|---|---|---|
| 1 | 俺は結構食べる方だよ | 方 | ほう | かた | ほう | 方, politely (before 食べる, 動詞-自立) |
| 2 | わりと寝る方です | 方 | ほう | かた | ほう | 方, politely |
| 3 | よく喋る方だと思う | 方 | ほう | かた | ほう | 方, politely |
| 4 | 頑張った方だと思う | 方 | ほう | かた | ほう | 方, politely (before た) |
| 5 | 結構食べた方だよ | 方 | ほう | かた | ほう | 方, politely (before た) |
| 6 | まだマシな方だね | 方 | ほう | かた | ほう | 方, politely (before な, 助動詞) |
| 7 | 人見知りする方なんだよね | 方 | ほう | かた | ほう | 方, な branch |

**Proposed condition:** カタ only when the token before 方 is one of these:

- 動詞-非自立 (てる, ている, くれる …), as in 配信してる方, 来てくれてる方.
- た whose own preceding token is 動詞-接尾 or 動詞-非自立, as in 優勝され-た方, 来てくださっ-た方.

Never after な (助動詞), a plain 自立 verb, or た after a 自立 verb. With this condition, all four cases the rule was written
for still read かた: 配信されている方ですね, 来てくれてる方なんだね, 優勝された方です and 来てくださった方です. They are
pinned under "keeps" in the test file.

### 1.2 方 after この/その/あの: a choice or a direction (medium)

| # | Sentence | Token | Dictionary | Corrected | Correct | Rule |
|---|---|---|---|---|---|---|
| 8 | この方にする | 方 | ほう | かた | ほう | 方, THIS_ONE (anything but が after) |
| 9 | あの方に行こう | 方 | ほう | かた | ほう | 方, THIS_ONE |
| 10 | その方を選ぶ | 方 | ほう | かた | ほう | 方, THIS_ONE |

**Proposed condition:** after THIS_ONE, カタ only when は, も, です, でし, だ or だっ follows. This keeps この方は先生です
(かた). Before に, を and で the dictionary's ほう stays. The cost is "この方に聞いて" (ask this person), which is rarer in talk.

### 1.3 声: the dictionary's ごえ is right after a noun or a verb stem (high in VRChat)

The rule `声: ゴエ → コエ` is unconditional. VRChat talk is full of voice compounds, and in all of them ごえ is right.

| # | Sentence | Token | Dictionary | Corrected | Correct | Rule |
|---|---|---|---|---|---|---|
| 11 | アニメ声だね | 声 | ごえ | こえ | ごえ | 声 (unconditional) |
| 12 | 萌え声 | 声 | ごえ | こえ | ごえ | 声 |
| 13 | ロリ声 | 声 | ごえ | こえ | ごえ | 声 |
| 14 | 囁き声 | 声 | ごえ | こえ | ごえ | 声 |

**Proposed condition:** コエ only when the token before is neither a content noun (名詞-一般, サ変接続, 形容動詞語幹 or
固有名詞) nor a verb. The cases the rule was written for still read こえ, because the token before is a pronoun: みんな声大きい,
これ声入ってる？ (both pinned under "keeps").

### 1.4 観: -観 before the copula is a view (medium)

`観: カン → ミ when 助動詞 follows`, and the copula is a 助動詞.

| # | Sentence | Token | Dictionary | Corrected | Correct | Rule |
|---|---|---|---|---|---|---|
| 15 | 世界観です | 観 | かん | み | かん | 観 (助動詞 after) |
| 16 | 価値観です | 観 | かん | み | かん | 観 |
| 17 | 恋愛観だ | 観 | かん | み | かん | 観 |
| 18 | 人生観だね | 観 | かん | み | かん | 観 |

**Proposed condition:** exclude the copula (`basic_form` だ or です) and な. 映画観たり, アニメ観ます and 映画観た still read み.

### 1.5 十分 that means "enough" (medium)

When 十分 stands at the end of a clause, the dictionary splits it 十/分 and reads じゅうふん, which is already wrong. The counter
rule then makes it じゅっぷん.

| # | Sentence | Token | Dictionary | Corrected | Correct | Rule |
|---|---|---|---|---|---|---|
| 19 | それで十分 | 十 / 分 | じゅう / ふん | じゅっ / ぷん | じゅう / ぶん | DOUBLING 十 + P_OF |
| 20 | 時間は十分 | 十 / 分 | じゅう / ふん | じゅっ / ぷん | じゅう / ぶん | same |
| 21 | もう一時間で十分 | 十 / 分 | じゅう / ふん | じゅっ / ぷん | じゅう / ぶん | same |

**Proposed condition:** read 十 + 分 as じゅう / ぶん when all three hold:

- the token before is not a numeral, and not あと, 約, 残り or 大体;
- the token after 分 is nothing, punctuation, a 終助詞 or the copula.

あと十分, あと十分待って, 三十分待った and あと十分で着く stay じゅっぷん (all pinned).

### 1.6 何 before と / って that does not quote (medium-low)

| # | Sentence | Token | Dictionary | Corrected | Correct | Rule |
|---|---|---|---|---|---|---|
| 22 | 何と戦ってるの | 何 | なに | なん | なに | 何, NAN contains と |
| 23 | え、何って？ | 何 | なに | なん | なに | 何, NAN contains って |

**Proposed condition:** before と or って, なん only when the token after them has `basic_form` 言う, いう, 思う or ゆう.
何と言っても stays なん (pinned).

### 1.7 金: gold, and Friday (medium-low)

| # | Sentence | Token | Dictionary | Corrected | Correct | Rule |
|---|---|---|---|---|---|---|
| 24 | 金と銀 | 金 | きん | かね | きん | 金 (particle after) |
| 25 | 金か銀か | 金 | きん | かね | きん | 金 |
| 26 | 金と土 (Friday and Saturday) | 金 | きん | かね | きん | 金 |
| 27 | 金に塗る | 金 | きん | かね | きん | 金 |
| 28 | 金は空いてる (Friday is free) | 金 | きん | かね | きん | 金 |

**Proposed condition:**

- Do not fire before a 並立助詞: と, か and や carry `pos_detail_1` 並立助詞 or 副助詞／並立助詞／終助詞 here.
- Before に or は, do not fire when the next word's `basic_form` is 塗る, 染める, 光る, 輝く, 空く or 暇.

This keeps 金はある and 金に困ってる as かね (pinned). Excluding に and は outright was tried and loses both.

### 1.8 水: -水 after a noun is すい (medium-low)

The rule is `スイ → ミズ when a particle follows`, and nothing checks what comes before.

| # | Sentence | Token | Dictionary | Corrected | Correct | Rule |
|---|---|---|---|---|---|---|
| 29 | 化粧水が | 水 | すい | みず | すい | 水 |
| 30 | 炭酸水を | 水 | すい | みず | すい | 水 |
| 31 | 天然水が | 水 | すい | みず | すい | 水 |

**Proposed condition:** also require that the token before is not a content noun. Note that IPADIC tags 毎日 as 固有名詞
(the newspaper), so exempt it by name. 毎日水を (みず) and 走るやつ水の上を (みず) stay correct (pinned).

### 1.9 Counters

| # | Sentence | Token | Dictionary | Corrected | Correct | Rule | Proposed condition |
|---|---|---|---|---|---|---|---|
| 32 | 一ヘルツ | 一 / ヘルツ | いち / へるつ | いっ / ぺるつ | いち / へるつ | DOUBLING + P_OF | For a katakana unit, never apply P_OF. Double before か, さ, た and ぱ-row units only (いっキロ, いっセンチ, いっページ), never before は-row ones. |
| 33 | 六ヘルツ | 六 / ヘルツ | ろく / へるつ | ろっ / ぺるつ | ろく / へるつ | same | same |
| 34 | 百ヘルツ | 百 / ヘルツ | ひゃく / へるつ | ひゃっ / ぺるつ | ひゃく / へるつ | same | same |
| 35 | 八ヘクタール | 八 / ヘクタール | はち / へくたーる | はっ / ぺくたーる | はち / へくたーる | same | same |
| 36 | 腹八分目にしとく | 八 / 分目 | はち / ふんめ | はっ / ぷんめ | はち / ぶんめ | DOUBLING 八 + P_OF | The counter 分目 is ブンメ, and the numeral is left alone. |
| 37 | 三年一組 | 一 | いち | ひと | いち | NATIVE 組 | Not after 年: a school class. |
| 38 | 三年二組 | 二 | に | ふた | に | NATIVE_TWO 組 | same |

### 1.10 Single cases

| # | Sentence | Token | Dictionary | Corrected | Correct | Rule | Proposed condition |
|---|---|---|---|---|---|---|---|
| 39 | どんな風が吹いてる | 風 | かぜ | ふう | かぜ | 風 (THIS_KIND) | ふう only when に, な, だ, です, で, じゃ, って or nothing follows. |
| 40 | 傘の柄 | 柄 | え | がら | え | 柄 (unconditional) | Not after の + a tool (傘, ナイフ, 包丁, 刀, 剣, 箒, スコップ, ハンマー, 斧, フライパン). |
| 41 | ナイフの柄 | 柄 | え | がら | え | 柄 | same |
| 42 | がんばれ日本 | 日本 | にっぽん | にほん | にっぽん | 日本 (unconditional) | Not after がんばれ/頑張れ. The rule's own comment says cheering keeps にっぽん. |

### 1.11 Debatable: left out of the failing set

These were run, and the rule fires on them, but both readings are said. They are recorded here so nobody re-derives them.

| Sentence | Dictionary → corrected | Why it is debatable |
|---|---|---|
| 今バージョン / 今イベ / 今アプデ / 今企画 | こん → いま | Game and stream talk says こんイベ and こんアプデ about as often as いま. |
| こんな風初めて | かぜ → ふう | "This kind of wind" vs. "like this". |
| 静かな方です / 上手な方です | ほう → かた | A person described politely vs. "I'm on the quiet side". The 1.1 condition reads them ほう. |
| いろんな方に / どんな方 | ほう → かた | People vs. directions. |
| 撮ってる方だね | ほう → かた | Even with 動詞-非自立 before it, both readings are said. |
| その方は / あの方は | ほう → かた | "That person" vs. "that one". |
| 後に分かった | ご → あと | のちに in narration; あとに is also heard. |
| 後に下がって | ご → あと | The meaning is うしろ: wrong before and after the rule, since the dictionary says ご. |
| テストも行った | おこなった → いった | Only を is checked before 行っ. Casual talk would say やった. |
| 一組の時の担任 | いち → ひと | A school class without 年 in front: no cue to tell it apart. |
| 日本代表 | にっぽん → にほん | Sports broadcasting says にっぽん. Both are heard. |
| 金を取った / 金が取れた | きん → かね | Gold medal vs. money. |

---

## 2. Misses, ranked by how often the pattern comes up in casual conversation

"Sim" means the condition was run on the scratch copy, and every listed example passed there.

| Rank | Pattern | Example: dictionary → correct | Proposed rule (condition) | Sim |
|---|---|---|---|---|
| 1 | 他 is ほか | 他の人 たのひと → ほかのひと · 他に何かある？ たに → ほかに · 他にも · 他は？ · 他のワールド | 他 with reading タ → ホカ when the next token is a particle (not 接続助詞), punctuation, nothing, or 何. その他 and 他人 are dictionary words of their own and stay. | yes |
| 2 | Days of the month and counted days | 二日 ににち → ふつか · 三日 · 四日間 よんにちかん · 五日後 · 七日 ななにち → なのか · 十日 · 二十日 → はつか · 二十四日 → にじゅうよっか · 二日目 · 二泊三日 → にはくみっか | A run of numerals worth 2–10, 14 or 24, before 日 (接尾, ニチ) or 日間, reads from a table: フツ/カ, ミッ/カ, ヨッ/カ, イツ/カ, ムイ/カ, ナノ/カ, ヨウ/カ, ココノ/カ, トオ/カ. For 二十日, ruby cannot span tokens, so it reads 二[は]十[つ]日[か]. 一日 stays いちにち; ついたち only after a month, not proposed. 三日月, 三日坊主 and 二日酔い are dictionary words and are unaffected. | yes |
| 3 | この間, その間 are あいだ | この間さ このかん → このあいだ · その間に | The dictionary has one token この間/その間/あの間 (名詞-副詞可能) read …カン → …アイダ. Ruby aligns as 間[あいだ]. | yes |
| 4 | お腹が空く is すく | お腹空いた おなかあいた → おなかすいた · お腹が空いてる · 腹空いた | 空い read アイ after 腹 or お腹, or after が with 腹/お腹 before it → スイ. 席空いてる stays あいてる (pinned). | yes |
| 5 | 入ろう is はいろう | 入ろう にゅうろう → はいろう · 一緒に入ろう · インスタンス入ろう | The dictionary has 入ろう as one サ変 noun (入牢) read ニュウロウ → ハイロウ. Ruby aligns as 入[はい]ろう. | yes |
| 6 | 被る is かぶる | アバター被ってる こうむってる → かぶってる · 帽子被った · キャラ被り | A verb whose surface starts with 被 and whose reading starts with コウム → カブ…, unless を stands before it (損害を被った stays こうむった, pinned). | yes |
| 7 | Counters after Arabic digits, which speech recognition often writes | 3本 3ほん → 3ぼん · 6本 → 6ぽん · 10分 → 10ぷん · 3日 → 3か · 1人で, romaji 1nin de → hitori de | `counted` returns early because a digit token has no reading. Work from the number's value instead. Last digit 3 → AFTER_THREE. 1, 6, 8, tens or a round hundred → は→ぱ on a kanji counter. 2–10, 14, 20 or 24 + 日 → か. 1人/2人 → the digit reads ヒト/フタ and 人 reads リ. The digit itself gets no ruby, so 1人 shows 人[り]; whether to merge digit and counter into one ruby is a design call. | yes |
| 8 | 何時 is なんじ | 何時まで いつまで → なんじまで · 何時までいる？ | 何時 (代名詞, イツ) → ナンジ. Speech recognition writes いつ in kana, so 何時 in a transcript is なんじ. | yes |
| 9 | 何曜日, 何月 | 何曜日 なにようび → なんようび · 何月 なにつき → なんがつ · 何月生まれ | 何 before 曜日 or 月 → ナン, and the 月 rule also accepts 何 before it (→ ガツ). | yes |
| 10 | 十分 (the dictionary word) as minutes | 十分後に集合ね じゅうぶんご → じゅっぷんご · 十分くらい · 十分しか寝てない | The word 十分 (形容動詞語幹, ジュウブン) followed by 後, 前, 間, くらい, ぐらい, ほど, 以内, しか or おき → ジュップン. | yes |
| 11 | 金ない | 金ない きんない → かねない · 金なくて · 金ないから | Add 形容詞 with `basic_form` ない as a trigger beside particle and verb. | yes |
| 12 | 風 after という, って and な-words | という風に というかぜに → というふうに · って風に · 変な風に聞こえる · みたいな風に | Before という, って, みたいな or 助動詞 な, with the 1.10 #39 after-condition → フウ. THIS_KIND's ああいう never matches either, because the dictionary splits it ああ/いう (ああいう風 stays かぜ). | yes |
| 13 | 開く that is open (intransitive) | 店開いてる？ ひらいてる → あいてる · ドアが開いた → あいた | 開い (ヒライ) before た, てる, ている or てない, after が or after 店, 穴, ドア, 窓, 扉 or 席 → アイ. It must leave メニュー開いて, ファイル開いて and 本を開いて as ひらいて (pinned). | yes |
| 14 | 描く is かく about drawing | 絵描いてる ええがいてる → えかいてる · 絵を描くの好き · イラスト描く | 描… (エガ…) after 絵, イラスト or 漫画, or after を with one of them before it → カ…. | yes |
| 15 | Single words read in their written form | 明後日 みょうごにち → あさって · 入り口 いりくち → いりぐち · いつも通り いつもとおり → いつもどおり · 生声 なまこえ → なまごえ · 一声かけて いっせい → ひとこえ · 今日中 (line-final) きょうなか → きょうじゅう | 明後日 → アサッテ. 入り口 → イリグチ. 通り after a 副詞 → ドオリ (言われた通り stays). 声 after the 接頭詞 生 → ゴエ. 一声 before かける → ヒトコエ. 中 read ナカ after 今日 at the end of a line → ジュウ (今日中に and 今日中だよ are already じゅう). | yes |
| 16 | 方 that is a person, unseen today | 知ってる方いますか ほう → かた · 先生方 かた → がた · 皆さん方 · あなた方 | 方 after 動詞-非自立, followed by いる/いらっしゃる/おる → カタ. 方 (接尾, カタ) after 先生, 皆さん, 皆様, あなた or お客さん → ガタ. | yes |
| 17 | Native counters the list names but never reaches | 一手間 いちてま → ひとてま · 一仕事 · 一工夫 · 一夏の思い出 · 一部屋 · 一勝負 | The dictionary tags these 名詞-一般 or サ変接続, so `isCounter` rejects them before NATIVE is consulted (4.3). Consult NATIVE first. Leave out 押し, because 一押し as "top pick" is いちおし. | no |
| 18 | Less frequent | 一ページ目 いちぺーじめ → いっぺーじめ · 一ポイント → いっぽいんと · 二十歳 にじゅうさい → はたち · 何なら なになら → なんなら · 一足遅かった いっそく → ひとあし · 三桁 さんけた → みけた · 角を曲がって かく → かど · 表に出て ひょう → おもて · 何と比べて なん → なに · 日中 にちちゅう → にっちゅう · 風邪薬 かぜやく → かぜぐすり · 両声類 りょうこえるい → りょうせいるい · 他人事 たじんじ → ひとごと | ぱ-row katakana units double after 一, 六, 八 and 十, but not 百 (ひゃくパーセント). This one is in the sim, but its test lines sit in this group. The others are one-word or one-collocation rules. Note that 何と比べて is the dictionary's own なん. | partly |

### 2.1 Checked and left alone

**Right already.** The dictionary reads these correctly in conversational lines:

- 明日 あした, 昨日, 今日, 私 わたし, 一番, 大人, 下手, 上手, 上手い, 人が, あの人, 外国人
- 何人, 何日, 何回, 何個, 何年, 何歳, 何度, 今年 ことし, 昨年, 去年, 人気, 大事, 床
- 生配信, 生放送, 生で見た, 一昨日 おととい, 今朝, 三日月, 二日酔い
- 入る, 入って, 入れる, 気に入った
- 来ない こない, 来よう こよう, 来れる, 来い, 来なかった, 来ます, 来て
- 行ってる, 行っちゃった, 行っとく
- 下さい, 下がって, 年下, 上の空 うわのそら, 一人暮らし, 一人っ子

**No cue in the neighbours.** The context does not decide these, so the dictionary's reading should stay:

- 辛い (つらい, or からい with food)
- 家 (いえ / うち)
- 何か (なにか, or the filler なんか)
- 本当 (ほんとう / ほんと)
- 止めて (とめて / やめて)
- 空いてる for a train or a road (すいてる) vs. a seat (あいてる)
- 昨夜 (さくや / ゆうべ)
- 市場 (しじょう / いちば)

---

## 3. Romaji and furigana after corrections

**Hepburn for changed tokens is right inside a word.** Examples: 一回だけ `ikkai dake`, 三本 `sanbon`, 一人で `hitori de`,
一人目 `hitorime`, 三本目 `sanbonme`, 一発目 `ippatsume`, 百本 `hyappon`, 十中八九 `jutchuuhakku`.

**Bug: a doubled numeral before another numeral loses its doubling.** 百, 千 and 兆 are 名詞-数, not 接尾, so `romaji()`
starts a new word at them. The numeral before ends on ッ, and wanakana drops a trailing ッ: `toRomaji('イッ') === 'i'`. Run
output:

| Line | Ruby (right) | Romaji today | Expected |
|---|---|---|---|
| 六百円 | 六[ろっ]百[ぴゃく]円[えん] | `ro pyakuen` | `roppyakuen` |
| 八百円 | 八[はっ]百[ぴゃく]円[えん] | `ha pyakuen` | `happyakuen` |
| 八千円 | 八[はっ]千[せん]円[えん] | `ha sen'en` | `hassen'en` |
| 一千円 | 一[いっ]千[せん]円[えん] | `i sen'en` | `issen'en` |
| 一兆円 | 一[いっ]兆[ちょう]円[えん] | `i chouen` | `itchouen` |
| 一千万 | 一[いっ]千[せん]万[まん] | `i sen man` | `issen…` |

六百円 and 八百円 are in the existing tests, which check only the furigana. Fix in `romaji()`: do not flush a word that ends
on ッ.

```ts
if (!joins(token) && !word.endsWith('ッ')) flush();
```

This was simulated: all six pass, and `annotate.test.ts` and `japaneseReadings.test.ts` stay green. A wider style choice is to
join consecutive 数 tokens into one word. Today 三百六十五日 is `san byaku roku juu gonichi` and 二十一回 is `ni juu ikkai`.

**Furigana alignment is unaffected.** In every probe line, the probe checked each changed token whose surface mixes kanji
and kana. It looked for a change that made `furiganaParts` fall back to whole-word ruby, which would mean the kana no longer
line up. There were none: 0 of 275 tokens changed by the current rules, and 0 of 376 changed by the proposed ones. Examples:

- Current: 行っ → 行[い]っ, 入り → 入[はい]り, 中っ → 中[なか]っ, 来ら → 来[こ]ら, 長けれ → 長[なが]けれ,
  腹の中 → 腹[なか]の中[なか].
- Proposed: この間 → この間[あいだ], 入ろう → 入[はい]ろう, 空い → 空[す]い, 被っ → 被[かぶ]っ, 描い → 描[か]い.

Two display limits come with multi-token readings:

- A reading that spans tokens is split per token: 二十日 → 二[は]十[つ]日[か].
- An Arabic digit has no kanji, so 1人 can only show 人[り].

---

## 4. Code quality of `japaneseReadings.ts`

### 4.1 Ordering and interactions

- `counted` runs first, and a match `continue`s, so a numeral is never re-read by `reread`. The counter at i+1 is visited
  again on the next step, both as a possible numeral (intended: 三百回 → 百 ビャク, then 百+回 → ビャッ) and by `reread`.
  The interplay is right in the cases run:
  - 一晩中: NATIVE 晩 → ひと, then 中 → じゅう.
  - 三足: そく is kept, because a numeral stands before it.
  - 一人一人: ひとりひとり.
- **Not idempotent in one case.** `correctReadings(correctReadings(x))` was run over all ~980 probe lines, and one differs:
  三百ヘルツ goes サン|ビャッ|ペルツ, then サン|ビャク|ペルツ. On the second pass 三+百 resets 百 to ビャク, and 百+ヘルツ no
  longer re-doubles because ヘルツ already reads ペルツ. The app calls the function once per line, so this is harmless today,
  and the katakana fix in 1.9 removes it.
- **`isCounter` accepts every 名詞-接尾**, which includes さん (人名), 的 and katakana units. The filtering then happens by
  the row tables, and that is how ヘルツ got through (1.9). IPADIC marks real counters `pos_detail_2 === '助数詞'` (回, センチ
  and ヘルツ all carry it). Using that, plus a "first character is kanji" check before P_OF, states the intent directly.

### 4.2 Dead or unreachable entries

- **THIS_KIND `ああいう`** can never match. The dictionary splits it ああ (感動詞) / いう, so ああいう風 stays かぜ and
  ああいう方 is never seen.
- **`NATIVE`: 28 of its 40 entries can never fire.** This was checked by tokenizing 一+each entry:
  - Dictionary words, never split: 一回り, 一休み, 一息, 一声, 一味, 一癖, 一苦労, 一安心, 一筋, 一言, 一口, 一昔, 一皮, 一段落,
    一区切り, 一眠り. The doc comment ("only the ones the dictionary leaves apart") is wrong for these, and they are harmless.
  - Split, but tagged 名詞-一般 or サ変接続, so `isCounter` rejects them: 部屋, 手間, 仕事, 工夫, 夏, 冬, 勝負, 泳ぎ, 踏ん張り,
    頑張り, 押し, 巻き. The rule was meant to catch these and silently does not: 一手間 いちてま, 一部屋 いちへや. That is miss
    rank 17.
  - Live: 通り, 切れ, 粒, 握り, 箱, 皿, 組, 桁, 袋, 束, 駅, 晩.

### 4.3 Mutation safety

The input array is copied lazily on the first change, and each changed token is replaced by a spread copy. A deep-frozen
input runs without throwing, and the existing test checks that the dictionary's tokens are not written on. When nothing
changes, the same array is returned. The `readonly` return type keeps callers from writing on it.

### 4.4 Missing fields

Tokens without `pos` or `reading` pass through unchanged, and nothing throws. Unknown words (VRChat, ｗｗｗ, Arabic digits)
come with `reading` undefined. The only property access on `reading` is guarded (`t.reading?.startsWith`). The `!number.reading`
guard in `counted` is why Arabic-digit counters are never handled (miss rank 7).

### 4.5 Performance

A 9,400-character line (6,600 tokens) takes about 1.0 ms in `correctReadings` against about 30 ms in `tokenize`. The cost is
linear, with at most one array copy per call. The array literals rebuilt inside `.includes()` on each call are negligible.

### 4.6 Tests that pin wrong readings

`japaneseReadings.test.ts` asserts two readings a speaker would not use:

- `三日後` → `さんにちご`, where it should be みっかご.
- `8月10日なの` → `8がつ10にちなの`, where 10日 is とおか.

Both have to change together with the day rule (miss rank 2). In the simulation, the first is the only existing assertion
that failed.

### 4.7 Comment and code disagree

The 日本 rule's comment says にっぽん "is for names and cheering", but the rule rewrites every にっぽん (1.10 #42).

---

## Appendix: the simulated proposal

This is the scratch copy of the proposed conditions, as a diff against `japaneseReadings.ts` at `6c76dd6`, abridged by hand
(types dropped, the days table and `arabic()` summarized in comments). It is not applied; `japaneseReadings.ts` was not
edited. It is shown so that each condition above can be read in code form. Not every part is
production-ready:

- The Arabic-digit handling writes the digit string itself back as its reading.
- The tool list for 柄 and the days table are minimal.

<details>
<summary>diff (japaneseReadings.ts)</summary>

```diff
@@ const surface … (helpers)
+const KATAKANA_START = /^[ァ-ヶー]/;
+const isCopula = (t) => t?.pos === '助動詞' && (t.basic_form === 'だ' || t.basic_form === 'です');
+const isContentNoun = (t) => t?.pos === '名詞' && ['一般', 'サ変接続', '形容動詞語幹', '固有名詞'].includes(t.pos_detail_1 ?? '') && t.surface_form !== '毎日';
+const ends = (t) => t === undefined || t.pos === '記号' || t.pos_detail_1 === '終助詞' || isCopula(t);
+const HANDLES = new Set(['傘', 'ナイフ', '包丁', '刀', '剣', '箒', 'ほうき', 'スコップ', 'ハンマー', '斧', 'フライパン']);
+const GATA = new Set(['先生', '皆さん', '皆様', 'あなた', '貴方', 'お客さん', 'お客様']);
+const DRAWN = new Set(['絵', 'イラスト', '漫画', 'マンガ']);
+const DAYS = { 2: ['フツ', 'カ'], 3: ['ミッ', 'カ'], 4: ['ヨッ', 'カ'], 5: ['イツ', 'カ'], 6: ['ムイ', 'カ'], 7: ['ナノ', 'カ'], 8: ['ヨウ', 'カ'], 9: ['ココノ', 'カ'], 10: ['トオ', 'カ'] };
-const NAN = new Set([… 'って', 'て', 'じゃ', 'と', …]);
+const NAN = new Set([… 'て', 'じゃ', …, '曜日']);            // と and って moved to QUOTING
+const QUOTING = new Set(['言う', 'いう', '思う', 'ゆう']);

 case '柄':
-  return t.reading === 'エ' ? 'ガラ' : undefined;
+  return t.reading === 'エ' && !(surface(before) === 'の' && HANDLES.has(surface(tokens[i - 2]))) ? 'ガラ' : undefined;
 case '水':
-  return t.reading === 'スイ' && after?.pos === '助詞' ? 'ミズ' : undefined;
+  return t.reading === 'スイ' && after?.pos === '助詞' && !isContentNoun(before) ? 'ミズ' : undefined;
 case '金':
-  return (after?.pos === '助詞' && surface(after) !== 'の') || after?.pos === '動詞' ? 'カネ' : undefined;
+  if (after?.pos === '助詞' && ((after.pos_detail_1 ?? '').includes('並立助詞') || surface(after) === 'の')) return undefined;
+  if (['に', 'は'].includes(surface(after)) && ['塗る', '染める', '光る', '輝く', '空く', '暇'].includes(tokens[i + 2]?.basic_form ?? '')) return undefined;
+  return after?.pos === '助詞' || after?.pos === '動詞' || (after?.pos === '形容詞' && after.basic_form === 'ない') ? 'カネ' : undefined;
 case '何':
-  return t.reading === 'ナニ' && NAN.has(surface(after)) ? 'ナン' : undefined;
+  if (t.reading !== 'ナニ') return undefined;
+  if (surface(after) === 'と' || surface(after) === 'って') return QUOTING.has(tokens[i + 2]?.basic_form ?? '') ? 'ナン' : undefined;
+  return NAN.has(surface(after)) || surface(after) === '月' ? 'ナン' : undefined;
+case '何時':
+  return t.reading === 'イツ' ? 'ナンジ' : undefined;
+case '十分':
+  return t.reading === 'ジュウブン' && ['後', '前', '間', 'くらい', 'ぐらい', 'ほど', '以内', 'しか', 'おき'].includes(surface(after)) ? 'ジュップン' : undefined;
 case '月':
-  return t.reading === 'ツキ' && isNumeral(before) ? 'ガツ' : undefined;
+  return t.reading === 'ツキ' && (isNumeral(before) || surface(before) === '何') ? 'ガツ' : undefined;
 case '風':
-  return t.reading === 'カゼ' && THIS_KIND.has(surface(before)) ? 'フウ' : undefined;
+  if (t.reading !== 'カゼ') return undefined;
+  if (!['に', 'な', 'だ', 'です', 'で', 'じゃ', 'って', undefined].includes(after?.surface_form)) return undefined;
+  return THIS_KIND.has(surface(before)) || ['という', 'って', 'みたいな'].includes(surface(before)) || (surface(before) === 'な' && before?.pos === '助動詞') ? 'フウ' : undefined;
 case '観':
-  return t.reading === 'カン' && (after?.pos === '助動詞' || ['たり', 'て', 'た'].includes(surface(after))) ? 'ミ' : undefined;
+  return t.reading === 'カン' && ((after?.pos === '助動詞' && !isCopula(after) && surface(after) !== 'な') || ['たり', 'て', 'た'].includes(surface(after))) ? 'ミ' : undefined;
 case '声':
-  return t.reading === 'ゴエ' ? 'コエ' : undefined;
+  if (t.reading === 'コエ' && surface(before) === '生' && before?.pos === '接頭詞') return 'ゴエ';
+  return t.reading === 'ゴエ' && !isContentNoun(before) && before?.pos !== '動詞' ? 'コエ' : undefined;
+case '他':
+  return t.reading === 'タ' && (after === undefined || after.pos === '記号' || (after.pos === '助詞' && after.pos_detail_1 !== '接続助詞') || surface(after) === '何') ? 'ホカ' : undefined;
+case 'この間': case 'その間': case 'あの間':
+  return t.reading?.endsWith('カン') ? `${t.reading.slice(0, -2)}アイダ` : undefined;
+case '空い':
+  return t.reading === 'アイ' && (['腹', 'お腹'].includes(surface(before)) || (surface(before) === 'が' && ['腹', 'お腹'].includes(surface(tokens[i - 2])))) ? 'スイ' : undefined;
+case '入ろう':  return t.reading === 'ニュウロウ' ? 'ハイロウ' : undefined;
+case '明後日':  return t.reading === 'ミョウゴニチ' ? 'アサッテ' : undefined;
+case '入り口':  return t.reading === 'イリクチ' ? 'イリグチ' : undefined;
+case '通り':    return t.reading === 'トオリ' && before?.pos === '副詞' ? 'ドオリ' : undefined;
+case '一声':    return t.reading === 'イッセイ' && ['かけ', '掛け', 'かける', '掛ける'].includes(surface(after)) ? 'ヒトコエ' : undefined;
 case '日本': case '日本人':
+  if (['がんばれ', '頑張れ', 'ガンバレ'].includes(surface(before))) return undefined;
 case '中':
+  if (t.reading === 'ナカ' && surface(before) === '今日' && after === undefined) return 'ジュウ';
 case '方': {
+  if (t.reading === 'カタ' && t.pos_detail_1 === '接尾' && GATA.has(surface(before))) return 'ガタ';
   if (t.reading !== 'ホウ') return undefined;
   …
-  if (THIS_ONE.has(surface(before))) return surface(after) === 'が' ? undefined : 'カタ';
-  const politely = ['です', 'だ', 'でし', '々', 'たち'].includes(surface(after));
-  if (politely && (before?.pos === '助動詞' || before?.pos === '動詞')) return 'カタ';
-  return surface(after) === 'な' && before?.pos === '動詞' ? 'カタ' : undefined;
+  if (THIS_ONE.has(surface(before))) return ['は', 'も', 'です', 'でし', 'だ', 'だっ'].includes(surface(after)) ? 'カタ' : undefined;
+  const two = tokens[i - 2];
+  const someone = (before?.pos === '動詞' && before.pos_detail_1 === '非自立')
+    || (surface(before) === 'た' && two?.pos === '動詞' && (two.pos_detail_1 === '接尾' || two.pos_detail_1 === '非自立'));
+  if (!someone) return undefined;
+  const politely = ['です', 'だ', 'でし', '々', 'たち', 'な'].includes(surface(after));
+  const there = after?.pos === '動詞' && ['いる', 'いらっしゃる', 'おる'].includes(after.basic_form ?? '');
+  return politely || there ? 'カタ' : undefined;
 }
 default:
+  // 被る → かぶる unless after を; 描く → かく after 絵/イラスト/漫画; 開いて(る)/開いた → あい after が or 店/穴/ドア/窓/扉/席
+  if (t.surface_form.startsWith('被') && t.pos === '動詞' && t.reading?.startsWith('コウム') && surface(before) !== 'を') return `カブ${t.reading.slice(3)}`;
+  if (t.surface_form.startsWith('描') && t.pos === '動詞' && t.reading?.startsWith('エガ') && (DRAWN.has(surface(before)) || (surface(before) === 'を' && DRAWN.has(surface(tokens[i - 2]))))) return `カ${t.reading.slice(2)}`;
+  if (t.surface_form === '開い' && t.reading === 'ヒライ' && ['た', 'てる', 'ている', 'てない'].includes(surface(after)) && (surface(before) === 'が' || ['店', '穴', 'ドア', '窓', '扉', '席'].includes(surface(before)))) return 'アイ';
   return undefined;

 function counted(tokens, i) {
+  // 二十日: はつか, split over the two numerals.
+  if (number?.surface_form === '二' && surface(counter) === '十' && tokens[i + 2]?.surface_form === '日' && !isNumeral(tokens[i - 1])) return ['ハ', 'ツ'];
+  // Arabic digits: read the counter from the number's value (see rank 7).
+  if (isNumeral(number) && isCounter(counter) && counter.reading && /^[0-9０-９]+$/.test(number.surface_form)) return arabic(tokens, i);
   if (!isNumeral(number) || !isCounter(counter) || !number.reading || !counter.reading) return undefined;
+  if (counter.surface_form === '分目') return [number.reading, 'ブンメ'];
+  if (counter.surface_form === '組' && surface(tokens[i - 1]) === '年') return undefined;
+  if (digit === '十' && counter.surface_form === '分' && !isNumeral(tokens[i - 1]) && !['あと', '約', '残り', '大体'].includes(surface(tokens[i - 1])) && ends(tokens[i + 2])) return ['ジュウ', 'ブン'];
+  // 二日 … 十日, 十四日, 二十四日, and 日間 after them (DAYS table).
   …
   const first = counter.reading[0];
+  if (KATAKANA_START.test(counter.surface_form)) {
+    if (doubling.rows.includes(first) && !H_ROW.includes(first)) return [doubled, counter.reading];
+    if ('パピプペポ'.includes(first) && digit !== '百') return [doubled, counter.reading];
+    return undefined;
+  }
```

</details>
