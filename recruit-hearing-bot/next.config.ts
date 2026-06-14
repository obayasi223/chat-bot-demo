import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 親ディレクトリにも lockfile があるため、このプロジェクトをルートに固定する
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
