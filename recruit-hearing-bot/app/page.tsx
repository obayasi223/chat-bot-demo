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
        IBMで働くこと、一緒に考えてみませんか
      </h1>
      <p style={{ lineHeight: 1.7, color: "#374151", marginBottom: 24 }}>
        「IBMに入りたいか」「自分に合っていそうか」を迷っている方のためのヒアリングです。
        合否を決めるものではありません。対話しながら、あなたの気持ちを一緒に整理していきましょう。
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
        ヒアリングを始める →
      </Link>
    </main>
  );
}
