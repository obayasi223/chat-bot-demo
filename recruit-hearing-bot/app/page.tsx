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
        IBMを知りながら、就活の軸を見つける対話
      </h1>
      <p style={{ lineHeight: 1.7, color: "#374151", marginBottom: 24 }}>
        IBMについて理解を深めながら、あなたの「就活の軸」を一緒に言葉にしていく対話の場です。
        合否を決めるものではありません。気になることはいつでも質問でき、雑談するくらいの気持ちで進められます。
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
        対話を始める →
      </Link>
    </main>
  );
}
