import Link from "next/link";

export default function Home() {
  return (
    <main
      style={{
        maxWidth: 760,
        margin: "0 auto",
        padding: "72px 24px",
      }}
    >
      <div
        style={{
          display: "inline-block",
          padding: "4px 12px",
          background: "#0f62fe",
          color: "#fff",
          fontSize: 13,
          fontWeight: 600,
          letterSpacing: "0.04em",
          marginBottom: 24,
        }}
      >
        IBM Career Axis Studio
      </div>
      <h1
        style={{
          fontSize: 40,
          fontWeight: 600,
          lineHeight: 1.3,
          letterSpacing: "-0.01em",
          marginBottom: 20,
          color: "#161616",
        }}
      >
        IBMを知りながら、
        <br />
        就活の軸を見つける対話
      </h1>
      <p
        style={{
          fontSize: 18,
          lineHeight: 1.8,
          color: "#393939",
          marginBottom: 36,
        }}
      >
        IBMについて理解を深めながら、あなたの「就活の軸」を一緒に言葉にしていく対話の場です。
        気になることはいつでも質問でき、雑談するくらいの気持ちで進められます。
      </p>
      <Link
        href="/hearing"
        style={{
          display: "inline-block",
          padding: "16px 28px",
          background: "#0f62fe",
          color: "#fff",
          fontWeight: 600,
          fontSize: 17,
          textDecoration: "none",
        }}
      >
        対話を始める →
      </Link>
    </main>
  );
}
