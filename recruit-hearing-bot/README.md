# 採用ヒアリングボット（recruit-hearing-bot）

採用エントリーの事前ヒアリングをチャット形式で行う AI ボットの MVP。
`web_hearing`（Web制作ヒアリングボット）の構造を参考に、コア部分だけを実装したものです。

## 何をするか

- チャットUIで、応募者に質問を順番に投げかけて回答を集めます。
- 「経験・スキル・志望動機」など深掘り対象の項目では、回答内容の十分さを **AI（Gemini）が判定** し、
  足りなければ追加質問を1回だけ自動生成します。
- 回答はトークン単位で**ストリーミング表示**（SSE）されます。
- 会話状態とチャットログは永続化され、リロードしても続きから再開できます。
  保存先は **Supabase**（設定時）／**インメモリ**（未設定時の仮実装）を自動で切り替えます。

## 技術スタック

- **フレームワーク**: Next.js 16 (App Router) + TypeScript
- **AI**: Google Gemini 2.5 Flash（`@google/genai`）
- **DB**: Supabase (PostgreSQL) ※任意。未設定ならインメモリにフォールバック
- **スタイル**: Tailwind CSS（UIは主にインラインスタイル）

## すぐ試す（DB・APIキー不要）

```bash
npm install
npm run dev
```

http://localhost:3000 を開くだけで動きます。
- Supabase 未設定 → 会話はインメモリ保持（再起動で消える「仮」）
- `GEMINI_API_KEY` 未設定 → AI深掘りはスキップし、固定の質問フローだけ進む

つまり、何も設定しなくても「チャットUI・フロー進行・ストリーミング・リロード復帰」は確実に動作します。
AI深掘りを有効にするには `GEMINI_API_KEY` を、データを永続化するには Supabase を設定してください。

## ディレクトリ構成

```
recruit-hearing-bot/
├── app/
│   ├── page.tsx               # ランディング（/hearing への導線）
│   ├── hearing/
│   │   ├── page.tsx           # ヒアリング画面
│   │   └── ChatClient.tsx     # チャットUI（クライアント）
│   └── api/hearing/route.ts   # サーバエンドポイント（GET=状態/開始, POST=1ターン処理）
├── lib/
│   ├── flows.ts               # 質問フロー定義（スロット）
│   ├── handleText.ts          # 会話の中核ロジック
│   ├── aiDeepen.ts            # AI深掘り質問の生成
│   ├── gemini.ts              # Gemini ラッパー
│   ├── state.ts               # 状態の型定義
│   ├── session.ts             # Cookieベースの簡易セッション
│   ├── dbState.ts             # 会話状態の読み書き
│   ├── dbMessages.ts          # チャットログの読み書き
│   └── supabase/admin.ts      # Supabase 管理クライアント
└── supabase.sql               # テーブル定義
```

## セットアップ

### 1. 依存をインストール

```bash
npm install
```

### 2.（任意）環境変数を設定

`.env.example` を `.env.local` にコピーして、必要なものだけ埋めます。

```bash
cp .env.example .env.local
```

- `GEMINI_API_KEY` … Gemini（任意）。未設定なら AI 深掘りをスキップして固定フローのみ進行。
- `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` … Supabase（任意）。
  両方設定すると永続化され、未設定ならインメモリ（仮）になります。

### 3.（永続化する場合のみ）Supabase のテーブルを作成

Supabase を使う場合は、プロジェクトを用意し `supabase.sql` の内容を SQL Editor で実行します。

### 4. 開発サーバを起動

```bash
npm run dev
```

http://localhost:3000 を開き、「ヒアリングを始める」から /hearing へ。

## カスタマイズ

- **質問内容を変える**: `lib/flows.ts` の `RECRUIT_FLOW.slots` を編集。
  `deepen: true` を付けた項目だけ AI 深掘りの対象になります。
- **別ドメインのヒアリングにする**: 新しい `Flow` を定義して `FLOWS` に登録し、
  `DEFAULT_FLOW_ID` を差し替えます。

## MVPで省略した点（web_hearing にはある）

招待リンク / 再開コード、ファイル・画像添付、音声入力、管理画面、
Google Sheets への自動エクスポート（Cron）、OpenAI フォールバック、Circuit Breaker など。
これらは必要に応じて後から追加できます。
