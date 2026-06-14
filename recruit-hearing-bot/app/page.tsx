import Link from "next/link";

export default function Home() {
  return (
    <main
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: "48px 20px",
      }}
    >
      <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 12 }}>
        採用エントリー 事前ご案内
      </h1>
      <p style={{ lineHeight: 1.7, color: "#374151", marginBottom: 24 }}>
        ご応募にあたり、画面の案内に沿ってご質問にお答えください。
        ご入力いただいた内容は、選考を進めるうえで担当者が確認いたします。
      </p>
      <Link
        href="/hearing"
        style={{
          display: "inline-block",
          padding: "12px 20px",
          borderRadius: 12,
          background: "#111",
          color: "#fff",
          fontWeight: 700,
          textDecoration: "none",
        }}
      >
        ご案内を始める →
      </Link>
    </main>
  );
}
