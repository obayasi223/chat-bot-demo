import type { Metadata } from "next";
import { IBM_Plex_Sans_JP } from "next/font/google";
import "./globals.css";

const plex = IBM_Plex_Sans_JP({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-plex",
});

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
    <html lang="ja" className={plex.variable}>
      <body>{children}</body>
    </html>
  );
}
