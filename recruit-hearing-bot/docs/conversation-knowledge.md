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
| Digression | `lib/intent.ts` / `lib/handleText.ts` | 応募者の入力が質問なら、その場で答えてから**同じ質問へ戻す**（`REASK_LEAD`）。回答は保存せず、進捗も進めない。 |
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

| Vector | 意味 | Direction | 速度 |
| --- | --- | --- | --- |
| answer | 現在の質問への回答 | PROCEED | ヒューリスティックで即決（AI不要） |
| question | 質問・相談 | ANSWER_QUESTION | FAQヒット時はAI不要で即答 |
| unsure | 回答に詰まっている | CLARIFY | AI不要 |
| offtopic | 無関係・雑談 | FALLBACK | AI不要 |
| empty | 空 | CLARIFY | AI不要 |

`source`（heuristic / ai / fallback）も返すので、ログで判断根拠を追える。

### ファイル構成

| ファイル | 役割 |
| --- | --- |
| `lib/harness/circuit.ts` | サーキットブレーカ。連続失敗で一定時間AIを遮断（用途別: classify/answer/deepen）。 |
| `lib/harness/aiRuntime.ts` | AI呼び出しの統一ラッパ。タイムアウト／エラー分類／テレメトリ／回路フィードバック。`runText` / `runStream`。 |
| `lib/harness/classify.ts` | ベクトル分類と方向決定（`classifyTurn`）。 |
| `lib/intent.ts` | ナレッジ回答の生成（answer-only。FAQ→AI→fallback）。 |
| `lib/knowledge.ts` | FAQ・フォールバック・簡易マッチ。 |
| `lib/aiDeepen.ts` | 深掘り判定（ハーネス経由）。 |

### 速度・堅牢性のポイント

- **AIを呼ぶ回数を最小化**: 明確な回答はヒューリスティックで即PROCEED。質問もFAQヒットならAIを呼ばない。
- **曖昧時のみ軽量AI**: 分類は出力数トークン（`maxOutputTokens: 4`, `temperature: 0`）で最速。
- **サーキットブレーカ**: 連続失敗時は即フォールバックに倒し、タイムアウト連発を防止。
- **タイムアウト**: 用途別に環境変数で調整（下記）。
- **テレメトリ**: `ai_slow` / `ai_error` / `ai_bypass` を構造化ログで出力（`AI_LOG_LEVEL`）。

### 主な環境変数

| 変数 | 既定 | 用途 |
| --- | --- | --- |
| `AI_TIMEOUT_MS` | 10000 | AI全体の既定タイムアウト |
| `AI_TIMEOUT_CLASSIFY_MS` | 5000 | 分類のタイムアウト |
| `AI_TIMEOUT_ANSWER_MS` | 10000 | ナレッジ回答のタイムアウト |
| `AI_TIMEOUT_DEEPEN_MS` | 12000 | 深掘りのタイムアウト |
| `AI_FAIL_THRESHOLD` | 3 | 遮断に至る失敗回数 |
| `AI_FAIL_WINDOW_MS` | 60000 | 失敗カウントの対象期間 |
| `AI_COOLDOWN_MS` | 90000 | 遮断時間 |
| `AI_SLOW_MS` | 6000 | 低速ログのしきい値 |
| `AI_LOG_LEVEL` | warn | ログレベル（off/error/warn/info/debug） |

## エラーコード体系（参考）

`lib/errors.ts` に集約。各レスポンスへ `requestId` を付与し、画面表示とサーバログを突合できる。
代表例: `INVALID_JSON` `EMPTY_TEXT` `SESSION_ERROR` `STATE_LOAD_ERROR` `STATE_SAVE_ERROR`
`MESSAGE_LOG_ERROR` `AI_TIMEOUT` `AI_ERROR` `DB_UNAVAILABLE` `INTERNAL`。
