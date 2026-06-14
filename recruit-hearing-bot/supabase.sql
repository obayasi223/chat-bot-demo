-- Supabase スキーマ（recruit-hearing-bot MVP）
-- Supabase の SQL Editor に貼り付けて実行してください。

-- 会話状態：1セッション1行。state(jsonb) に State をまるごと保存する。
create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  session_id text not null unique,
  state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_conversations_session_id
  on conversations (session_id);

-- チャットログ：1メッセージ1行。
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  role text not null check (role in ('user', 'bot')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_messages_session_created
  on messages (session_id, created_at);

-- 注意：
-- このMVPはサーバ側で service role key を使ってアクセスするため、
-- RLS は有効化していません（クライアントから直接DBへはアクセスしません）。
-- 本番運用する場合は RLS とアクセスポリシーの設計を行ってください。
