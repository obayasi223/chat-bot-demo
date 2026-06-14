import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "採用エントリー 事前ご案内",
  description: "ご応募にあたっての事前ご案内を行うチャットフォーム",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
