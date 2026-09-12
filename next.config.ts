import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * 開発サーバーを同じネットワークの別端末から開けるようにする。
   * Next は既定で、起動時のホスト名以外からの開発用アセットの取得を 403 で止める。
   * ここに書くのは私的アドレスだけ (開発時のみ有効。本番には影響しない)。
   * `npm run dev:lan` は -H にそのアドレスを渡すので、ここに無いアドレスでも通る。
   */
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*"],

  /**
   * 楽楽精算を操作する Chromium は、まとめてバンドルできない。
   * - `serverExternalPackages`: Next が中身を解析せず、そのまま require する
   * - `outputFileTracingIncludes`: 実行時に読まれるファイルは静的解析で拾えないので、
   *   明示して関数に同梱する。
   *   ★ playwright-core は**丸ごと**入れること。lib/coreBundle.js が
   *     browsers.json などを実行時に require するが、束ねられた中の require なので
   *     Next の追跡では辿れない（1つずつ足すと取りこぼしが続く。13MBなので丸ごとで困らない）。
   */
  serverExternalPackages: ["playwright-core", "@sparticuz/chromium"],
  outputFileTracingIncludes: {
    "/api/rakuraku/**": [
      "./node_modules/@sparticuz/chromium/bin/**/*",
      "./node_modules/playwright-core/**/*",
    ],
  },

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
