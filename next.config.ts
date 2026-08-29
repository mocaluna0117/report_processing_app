import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // フォントはファイル名にハッシュを含む (作り直すと名前が変わる) ので長期キャッシュしてよい
        source: "/report/fonts/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      {
        // テンプレートは名前が固定なので、作り直したら次の読み込みで反映されるようにする
        source: "/report/completion-report.xlsx",
        headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }],
      },
    ];
  },
};

export default nextConfig;
