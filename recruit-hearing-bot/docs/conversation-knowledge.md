# 会話設計ナレッジ（IBM watsonx Assistant 由来）

ヒアリングボットを「人間らしく・柔軟に」するための設計ナレッジ。
IBM watsonx Assistant のドキュメントを参照し、本プロジェクトへの適用方針をまとめる。

## 参照元（IBM Cloud Docs）

- Controlling the conversational flow（Disambiguation / Digressions）
  https://cloud.ibm.com/docs/watson-assistant?topic=watson-assistant-dialog-runtime
- Change conversation topic（digression の有効化）
  https://cloud.ibm.com/docs/watson-assistant?topic=watson-assistant-change-topic
- Tutorial: Digressions
  https://cloud.ibm.com/docs/watson-assistant?topic=watson-assistant-tutorial-digressions
- Irrelevance detection（無関係入力の検知）
  https://cloud.ibm.com/docs/watson-assistant?topic=watson-assistant-irrelevance-detection

## 中核となる3概念

### 1. Digression（脱線）
> 会話の途中でユーザーは気が散ったり、関連する質問をしたり、考えを変えたりする。

- ユーザーがフローの途中で別の話題（質問）に移ることを許容し、答えた後に**元のフローへ戻す**（return to flow）。
- スロット入力（質問項目）では、**起こりうる関連質問を想定してハンドラを用意**するのが推奨。
- 「現在のノードを優先（The current node gets priority）」。今のフローで扱えない入力のときだけ他へ脱線する。

### 2. Irrelevance detection / フォールバック
- 完全に無関係な入力は「無関係」と分類し、無理に答えない。
- まだ実装していない話題は、`anything_else`（No matches）で「今は対応できないが、別のことは手伝える」と返す。

### 3. Disambiguation（曖昧性解消）
- 複数の意図が僅差で一致するときは、勝手に推測せず、候補を提示してユーザーに選ばせる。
- （本MVPでは未実装。将来、複数フロー対応時に検討）

## 本プロジェクトへの適用

| IBM概念 | 実装箇所 | 振る舞い |
| --- | --- | --- |
| Digression | `lib/intent.ts` / `lib/handleText.ts` | 相談者の入力が質問なら、その場で答えてから**同じ質問へ戻す**（`pickReask` で言い回しを自然に分散）。回答は保存せず、進捗も進めない。 |
| 関連質問の想定 | `lib/knowledge.ts`（FAQ） | 選考の流れ・所要時間・個人情報・修正方法・中断/再開・必須/任意・連絡先をFAQ化。 |
| Irrelevance / Fallback | `lib/knowledge.ts`（`FALLBACK_ANSWER`） | ナレッジに無い質問は推測せず「担当者より追ってご回答」と返す。 |
| 回答 vs 質問の判定 | `lib/intent.ts` | AIが `[ANSWER]` マーカーを先頭出力したら「回答」とみなしフロー続行。それ以外は質問とみなし回答をストリーム。 |

### 判定フロー（1ターン）
1. `looksLikeQuestion()` の軽い判定で「質問っぽい」入力だけAIに回す（無駄なレイテンシ回避）。
2. AI（`streamQuestionReply`）が回答/質問を判定。
   - 回答 → 通常処理（保存・深掘り・次へ）。
   - 質問 → FAQベースで回答をストリーム → 元の質問へ戻す。
3. Gemini 未設定時は `findFaqAnswer()`（キーワード簡易マッチ）→ 無ければ `FALLBACK_ANSWER`。
4. タイムアウト（`QUESTION_TIMEOUT_MS`）で詰まりを防止し、フォールバックへ。

## カスタマイズ手順

- FAQ内容・口調は `lib/knowledge.ts` を編集（会社名・選考プロセス・問い合わせ先など）。
- 無関係話題への対応文は `FALLBACK_ANSWER` を編集。
- タイムアウトは環境変数 `QUESTION_TIMEOUT_MS` / `DEEPEN_TIMEOUT_MS` で調整。

## ハーネス構造（分類 → 方向 → 実行）

「ナレッジ参照を最速にする」ため、毎ターンを**高速分類（validation）**してから動く。

```
入力
 └─ classifyTurn()  … ベクトル分類（高速2段構え）
      1) ヒューリスティック（決定的・即時）
         - 空 → empty
         - 「わからない/特になし」等 → unsure
         - 質問記号・疑問語が無い → answer（IBM: current node priority）
      2) 曖昧（質問っぽい）時だけ軽量AIラベル呼び出し（数トークン）
         - ANSWER / QUESTION / OFFTOPIC
 └─ Direction（次に取る方向）に変換
      answer   → PROCEED          （保存・深掘り・前進）
      question → ANSWER_QUESTION   （FAQ即時→AI→fallback、その後 元の質問へ戻す）
      unsure   → CLARIFY           （補足を促して同じ質問へ）
      offtopic → FALLBACK          （担当者へ引き継ぎ→戻す）
      empty    → CLARIFY
```

### ベクトル（TurnVector）と方向（Direction）

| Vector | 意味 | Direction | 振る舞い |
| --- | --- | --- | --- |
| answer | 現在の質問への回答 | PROCEED | 保存・深掘り・前進（分類はヒューリスティックで即決＝AI不要） |
| question | 質問・相談 | ANSWER_QUESTION | FAQ即答、外れたらAI回答。その後 元の質問へ戻す |
| unsure | 回答に詰まっている | CLARIFY | **会話ログを踏まえた提案（ヒント／切り口／例）を生成**。失敗時は定型文。最後にボタン誘導＋元の質問へ戻す |
| offtopic | 無関係・雑談 | FALLBACK | 担当者へ引き継ぎ→戻す |
| empty | 空 | CLARIFY | （実際は入口で弾く） |

### 「わからない」時の提案生成（assist）

`unsure` 判定時は `lib/assist.ts` の `streamUnsureAssist` が、これまでの回答ログ
（`collectedContext`：既出のQ&Aを箇条書き化）を文脈に、答えを引き出す
**具体的な視点・切り口・例を2〜3個**生成してストリーム提示する。
- 例：志望動機で詰まったら、既出の「職種・経験・スキル」に結びつけた切り口を提案。
- 思考オフ・短文・ストリームで高速。AI不可/失敗時は定型文（`CLARIFY_MESSAGE`）へフォールバック。
- 提案後に「答えにくい・特になし」ボタンの離脱導線も案内。

`source`（heuristic / ai / fallback）も返すので、ログで判断根拠を追える。

### 回答の十分性判定（assess）と自然な相づち

深掘り対象スロット（`deepen: true`）では、回答そのものから
**「本人を理解するのに十分な情報が取れたか」を推定**する（`lib/aiDeepen.ts` の `assessAnswer`）。
構造化JSONで一度に次の3点を得る:

```
{ "enough": true/false,        // 十分性の推測（= 取れたかどうか）
  "reflect": "相づち・共感",     // 相手の回答に触れた1文（自然な質疑の“傾聴”）
  "ask": "追加質問" }           // 不足時のみ。これまでの内容に触れて掘り下げる
```

- **十分性の推測**: 具体的な経験・理由・気持ちが語られていれば `enough=true`。
  明らかに曖昧・ごく短い・抽象的な場合のみ `enough=false` で掘る（過剰な深掘りを抑制）。
- **自然な相づち**: `reflect` を次の質問の前置きに使うことで、毎回同じ定型文ではなく
  **相手の回答内容に触れた一言**から会話が続く（`GAIN_BY_KEY` の定型はAI不可時のフォールバック）。
- **多段深掘り**: 追加回答も含めて再判定し、足りなければ上限まで掘る（`AI_DEEPEN_MAX_ROUNDS`、既定2回）。
  上限到達・スキップ時は `enough` に関わらず前進し、`sufficiency` に結果を残す。
- **十分性の可視化**: 各回答の `sufficiency`（`sufficient`/`partial`/`unknown`）を保存し、
  `meta.sufficientCount` / `meta.deepenTotal` / `meta.deepenRound` で進捗とともに把握できる。
- AI未設定／失敗時は `enough=true`（=確実に前進）にフォールバックし、会話を止めない。

### 観点バランスの算出（coverage）

取れたデータから「どのベクトル（観点）もまんべんなく取れているか」を**数式で**算出する
（`lib/coverage.ts` の `computeCoverage`）。**AIを使わない純粋関数**なので、
回答テキストのストリーミング後段（クリティカルパス外）で軽量に計算でき、体感速度に影響しない。

観点（axis）は分析軸で、`flows` のスロットへ対応づける（既定: 動機/価値観/強み/不安/働き方）。

```
観点ごとのスコア:
  len_a   = chars_a / (chars_a + K)              … 文字量の飽和（K=COVERAGE_LEN_SCALE, 既定60）
  suff_a  = sufficient:1 / partial:0.6           … AIの十分性推定があれば加味
  score_a = clamp01( α·suff_a + (1−α)·len_a )    … α=COVERAGE_SUFF_WEIGHT（既定0.6）
            （十分性が未判定の観点は len_a のみ。「特になし」等は0文字＝取れていない扱い）

全体:
  coverage = mean(score)                         … 充足度（どれだけ取れたか）
  evenness = H / ln(n)   （Pielou）              … 均等度（H=−Σ p·ln p, p=score/Σscore）
  balance  = 1 / (1 + CV)（CV=std/mean）          … 参考のバランス指標
  balanced = evenness ≥ E_min かつ min(score) ≥ gap   … まんべんなく取れているか
             （E_min=COVERAGE_EVENNESS_MIN 既定0.85 / gap=COVERAGE_GAP_THRESHOLD 既定0.5）
```

- `weakestAxisId`（最も手薄な観点）と `gaps`（しきい値未満の観点）も返すので、
  「次にどの観点を補うべきか」を提示・誘導する判断材料になる。
- 結果は API の `meta.coverage` に含めて返し、画面では「観点バランス」パネルで可視化する。
- パラメータはすべて環境変数で調整可能（`COVERAGE_*`）。

### ファイル構成

| ファイル | 役割 |
| --- | --- |
| `lib/harness/circuit.ts` | サーキットブレーカ。連続失敗で一定時間AIを遮断（用途別: classify/answer/deepen）。 |
| `lib/harness/aiRuntime.ts` | AI呼び出しの統一ラッパ。タイムアウト／エラー分類／テレメトリ／回路フィードバック。`runText` / `runStream`。 |
| `lib/harness/classify.ts` | ベクトル分類と方向決定（`classifyTurn`）。 |
| `lib/intent.ts` | ナレッジ回答の生成（answer-only。FAQ→AI→fallback）。 |
| `lib/knowledge.ts` | FAQ・フォールバック・簡易マッチ。 |
| `lib/aiDeepen.ts` | 回答の十分性判定＋自然な相づち・追加質問の生成（`assessAnswer`、ハーネス経由）。 |
| `lib/coverage.ts` | 観点バランスの算出（`computeCoverage`、純粋関数・AI不使用）。充足度・均等度・取りこぼし。 |

### 速度・堅牢性のポイント

目標は1ターンの体感速度 **約2秒**。次の多層で実現する。

1. **AIを呼ぶ回数を最小化**: 明確な回答はヒューリスティックで即PROCEED（AIゼロ）。質問もFAQヒットならAIを呼ばない（即答）。
2. **思考(thinking)オフ**: 分類・深掘り・FAQ回答は `thinkingBudget: 0` で実行。Gemini 2.5 Flash の最大のレイテンシ要因（内部思考）を除去し、TTFTを短縮。
3. **曖昧時のみ軽量AI**: 分類は出力数トークン（`maxOutputTokens: 4`, `temperature: 0`, 思考オフ）で最速。
4. **ストリーミング**: 確定文（質問・進捗・まとめ）は即時emit。AI生成部は最初のトークンが出た瞬間に表示。
5. **DB処理の並列化**: ユーザー発話ログをターン処理と並行実行。保存とbotログも並列（`Promise.allSettled`）。ストリーム開始前の待ちは「Cookie確定＋状態読込」のみ。
6. **サーキットブレーカ**: 連続失敗時は即フォールバックに倒し、タイムアウト連発を防止。
7. **テレメトリ**: `ai_slow` / `ai_error` / `ai_bypass` を構造化ログで出力（`AI_LOG_LEVEL`）。

#### ターン別のAIコスト（目安）

| ターン | AI呼び出し | 体感 |
| --- | --- | --- |
| 通常スロットへの回答（name/status/work_style/wrap） | なし（分類はヒューリスティック） | DBのみ。最速 |
| 深掘りスロットへの回答（trigger/values/strengths/concerns） | 十分性判定1回（構造化JSON・思考オフ）。不足時は上限まで追加 | 約1〜2秒/回 |
| 質問（FAQヒット） | なし | 即時 |
| 質問（FAQ外） | 分類ラベル＋回答（いずれも思考オフ） | 約2秒前後 |

> さらに速くしたい場合は、`AI_*_MODEL` で各フェーズを高速モデルへ切替可能。
> ただし一部の「lite」モデルはTTFTが高くストリーミング体感が悪化することがあるため、
> まずは思考オフ（実装済み）で評価するのを推奨。

### 主な環境変数

| 変数 | 既定 | 用途 |
| --- | --- | --- |
| `AI_TIMEOUT_MS` | 10000 | AI全体の既定タイムアウト |
| `AI_TIMEOUT_CLASSIFY_MS` | 5000 | 分類のタイムアウト |
| `AI_TIMEOUT_ANSWER_MS` | 10000 | ナレッジ回答のタイムアウト |
| `AI_TIMEOUT_DEEPEN_MS` | 12000 | 深掘り（十分性判定）のタイムアウト |
| `AI_DEEPEN_MAX_ROUNDS` | 2 | 深掘りの上限往復数（0で深掘り無効） |
| `AI_FAIL_THRESHOLD` | 3 | 遮断に至る失敗回数 |
| `AI_FAIL_WINDOW_MS` | 60000 | 失敗カウントの対象期間 |
| `AI_COOLDOWN_MS` | 90000 | 遮断時間 |
| `AI_SLOW_MS` | 6000 | 低速ログのしきい値 |
| `AI_LOG_LEVEL` | warn | ログレベル（off/error/warn/info/debug） |
| `AI_CLASSIFY_MODEL` | （既定モデル） | 分類フェーズのモデル上書き |
| `AI_ANSWER_MODEL` | （既定モデル） | ナレッジ回答フェーズのモデル上書き |
| `AI_DEEPEN_MODEL` | （既定モデル） | 深掘りフェーズのモデル上書き |
| `AI_ASSIST_MODEL` | （既定モデル） | 提案生成フェーズのモデル上書き |
| `AI_TIMEOUT_ASSIST_MS` | 10000 | 提案生成のタイムアウト |
| `COVERAGE_LEN_SCALE` | 60 | 文字量スコアの飽和スケール（chars=K で0.5） |
| `COVERAGE_SUFF_WEIGHT` | 0.6 | 十分性スコアの重み（残りが文字量の重み） |
| `COVERAGE_GAP_THRESHOLD` | 0.5 | これ未満を「取りこぼし」とみなすしきい値 |
| `COVERAGE_EVENNESS_MIN` | 0.85 | 「均等」とみなす evenness 下限 |

> 思考オフは `thinkingBudget: 0` をコード側で指定済み（分類・回答・深掘り）。
> 既定モデルは `GEMINI_MODEL`（未設定なら `gemini-2.5-flash`）。

## エラーコード体系（参考）

`lib/errors.ts` に集約。各レスポンスへ `requestId` を付与し、画面表示とサーバログを突合できる。
代表例: `INVALID_JSON` `EMPTY_TEXT` `SESSION_ERROR` `STATE_LOAD_ERROR` `STATE_SAVE_ERROR`
`MESSAGE_LOG_ERROR` `AI_TIMEOUT` `AI_ERROR` `DB_UNAVAILABLE` `INTERNAL`。
