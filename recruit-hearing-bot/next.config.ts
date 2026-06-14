import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 親ディレクトリにも lockfile があるため、このプロジェクトをルートに固定する
  turbopack: {
    root: __dirname,
  },
  // ルート(/)はチャット画面(/hearing)へリダイレクト
  async redirects() {
    return [
      {
        source: "/",
        destination: "/hearing",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
