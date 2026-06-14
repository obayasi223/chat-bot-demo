import ChatClient from "./ChatClient";

export const dynamic = "force-dynamic";

export default function HearingPage() {
  return (
    <main
      style={{
        maxWidth: 720,
        margin: "0 auto",
        height: "100dvh",
        display: "flex",
        flexDirection: "column",
        padding: "12px 12px 0",
      }}
    >
      <header style={{ padding: "8px 4px 12px" }}>
        <h1 style={{ fontSize: 18, fontWeight: 800 }}>採用エントリー 事前ご案内</h1>
        <p style={{ fontSize: 12, color: "#6b7280" }}>
          ご応募にあたって、いくつかご質問させていただきます
        </p>
      </header>
      <div style={{ flex: 1, minHeight: 0, paddingBottom: 12 }}>
        <ChatClient />
      </div>
    </main>
  );
}
