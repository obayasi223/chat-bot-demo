import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "IBM理解と就活の軸を深める対話",
  description:
    "IBMについて理解を深めながら、あなたの「就活の軸」を対話で一緒に言葉にしていくAIボット",
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
