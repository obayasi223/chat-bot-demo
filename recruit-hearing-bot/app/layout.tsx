import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "IBMで働くこと、一緒に考えるヒアリング",
  description:
    "IBMに入りたいか・自分に合っていそうか迷っている方の気持ちを、対話で一緒に整理するヒアリング",
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
