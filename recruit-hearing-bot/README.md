# IBMフィット ヒアリングボット（recruit-hearing-bot）

「IBMに入りたいか・自分に合っていそうか」を迷っている方の気持ちを、チャット形式の対話で一緒に整理する AI ボットです。合否を判定するものではありません。

> **このリポジトリについて**
> 就職活動用のポートフォリオとして作成したものです。
> 実務で開発した Web制作ヒアリングボット（`web_hearing`）の構成を参考に、
> **コア機能だけを抜き出して再実装したデモ版**です。本番の全機能は含みません（[省略した機能](#デモ版で省略した機能)を参照）。

## デモ

相談者がチャットに沿って答えていくと、AI が回答の具体性を判定し、必要なら自動で深掘り質問を返します。
答えに詰まったときは、これまでのお話をふまえて考えるヒントを一緒に挙げます。最後に内容のサマリを提示して完了します。

```bash
npm install
npm run dev   # http://localhost:3000
```

APIキー・DB が未設定でも起動し、「チャットUI・フロー進行・ストリーミング・リロード復帰」は動作します（下記フォールバック参照）。

## 主な機能

- **対話型ヒアリングフロー** — 質問を1問ずつ提示し、回答をスロットに収集。進捗バーとサマリ表示つき（`lib/flows.ts` / `lib/handleText.ts`）
- **AIによる自動深掘り** — 経験・スキル・志望動機など特定項目で、回答が薄ければ AI が追加質問を1回だけ自動生成（`lib/aiDeepen.ts`）
- **脱線への対応** — ヒアリング中の質問・相談・「わからない」を分類し、FAQで答えてから元の質問へ戻す（IBM watsonx Assistant の return-to-flow を参考。`lib/harness/classify.ts` / `lib/intent.ts` / `lib/knowledge.ts`）
- **トークン単位のストリーミング表示** — AIの出力を SSE で逐次描画（`app/api/hearing/route.ts`）
- **会話の永続化と再開** — 状態とチャットログを保存し、リロードしても続きから再開（Cookieセッション）
- **AIハーネス** — 全AI呼び出しをラップし、タイムアウト・サーキットブレーカ・エラー分類・構造化ログを一元化。AIが詰まっても会話は止めず固定フローへ倒す（`lib/harness/`）
- **段階的フォールバック** — 環境変数の有無で挙動が縮退し、未設定でも必ず動く

| 機能 | 設定あり | 設定なし時の挙動 |
|---|---|---|
| AI深掘り・質問応答（`GEMINI_API_KEY`） | Gemini で生成 | スキップ／FAQ即時マッチのみ |
| 永続化（Supabase 2変数） | PostgreSQL に保存 | インメモリ（再起動で消える） |

## 技術スタック

- **フレームワーク**: Next.js 16（App Router）+ React 19 + TypeScript
- **AI**: Google Gemini 2.5 Flash（`@google/genai`）
- **DB**: Supabase / PostgreSQL（任意。未設定ならインメモリ）
- **スタイル**: Tailwind CSS

## セットアップ

```bash
npm install
cp .env.example .env.local   # 任意。何も埋めなくても起動する
npm run dev
```

環境変数（すべて任意）:

- `GEMINI_API_KEY` … AI深掘り・質問応答を有効化（未設定なら固定フローのみ）
- `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` … 永続化（両方設定で有効。テーブルは `supabase.sql` を実行）

## デプロイ（Vercel）

このアプリはリポジトリ直下ではなく **`recruit-hearing-bot/` サブディレクトリ**にあります。
Vercel にデプロイする際は **Root Directory を `recruit-hearing-bot` に設定**してください
（未設定だとリポジトリ直下に Next.js アプリが見つからず、全ページが 404 NOT_FOUND になります）。

- Vercel: Project → Settings → Build and Deployment → **Root Directory** = `recruit-hearing-bot`
- CLI: `vercel --cwd recruit-hearing-bot`

環境変数（`GEMINI_API_KEY` など）は未設定でも動作します（前述のフォールバック）。

## ディレクトリ構成

```
app/
  page.tsx                 # ランディング
  hearing/                 # ヒアリング画面（ChatClient = チャットUI）
  api/hearing/route.ts     # GET=状態/開始, POST=1ターン処理（SSE）
lib/
  flows.ts                 # 質問フロー定義（スロット）
  handleText.ts            # 会話の中核ロジック
  aiDeepen.ts / intent.ts  # AI深掘り / ナレッジ応答
  knowledge.ts             # FAQ・回答ポリシー
  harness/                 # AIハーネス（classify / circuit / aiRuntime）
  store.ts / dbState.ts / dbMessages.ts  # 永続化（Supabase ⇄ インメモリ）
  gemini.ts / session.ts / state.ts
supabase.sql               # テーブル定義
```

## カスタマイズ

- **質問を変える**: `lib/flows.ts` の `RECRUIT_FLOW.slots` を編集。`deepen: true` の項目だけ AI 深掘りの対象になります。
- **別ドメインに転用**: 新しい `Flow` を定義して `FLOWS` に登録し、`DEFAULT_FLOW_ID` を差し替えます。

## デモ版で省略した機能

本番（`web_hearing`）にはあるが、本デモでは省略している主な機能:

招待リンク / 再開コード、ファイル・画像添付、音声入力、管理画面、
Google Sheets への自動エクスポート（Cron）、OpenAI フォールバック、複数回の深掘りなど。
