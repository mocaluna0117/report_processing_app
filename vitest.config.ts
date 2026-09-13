import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    // 実物のブラウザを使う検証が並んで走ると、起動や終了に10秒（既定）を超えることがある
    hookTimeout: 60000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      // `import "server-only"` は素の node では例外を投げる (クライアントに混ざるのを防ぐ仕掛け)。
      // テストではその見張りが要らないので、同じパッケージが持つ空の実装に差し替える。
      "server-only": fileURLToPath(new URL("node_modules/server-only/empty.js", import.meta.url)),
    },
  },
});
