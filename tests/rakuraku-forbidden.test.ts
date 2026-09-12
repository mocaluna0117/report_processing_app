import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ★楽楽精算に対しては**検索・閲覧・ダウンロードだけ**を行う。データを変える操作につながる
 *   ボタンを、サーバー側のコードが参照すらしないことを形で見張る（移植計画 6-10）。
 *
 * - 伝票画面の「閉じる」は `window.parent.close()` を呼び、ブラウザの窓ごと閉じる。
 *   代わりに一覧の URL へ移動して戻る。承認履歴のダイアログの「閉じる」も紛れるので押さない。
 * - 「取下げ」「コピー」「確定」はデータを変える操作。
 *
 * コメントで理由を説明するのは構わないので、コメントを除いてから調べる。
 */
const ROOTS = ["lib/rakuraku", "app/api/rakuraku"];

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name)) out.push(path);
    }
  };
  for (const root of ROOTS) walk(join(process.cwd(), root));
  return out;
}

/** コメントを外す（文字列の中の // まで消えることがあるが、見逃す方向にしか働かないので許す） */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const FORBIDDEN: { label: string; pattern: RegExp }[] = [
  { label: "「閉じる」ボタンのクラス", pattern: /accesskeyClose/ },
  { label: "「取下げ」ボタンのクラス", pattern: /accesskeyTorisage/ },
  { label: "「確定」ボタンのクラス", pattern: /accesskeyFix/ },
  { label: "「コピー」ボタンのクラス", pattern: /accesskeyCopy/ },
  { label: "窓を閉じる呼び出し", pattern: /\b(?:parent|top|window)\s*\.\s*close\s*\(/ },
  { label: "「閉じる」の文字で探すこと", pattern: /["'`]閉じる["'`]/ },
  { label: "「取下げ」の文字で探すこと", pattern: /["'`]取下げ["'`]/ },
];

describe("★楽楽精算のデータを変える操作につながるものを参照しない", () => {
  const files = sources();

  it("見張る対象のファイルが見つかっている", () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it("コメントを外す仕組みが効いている", () => {
    expect(stripComments("a // accesskeyClose\n/* accesskeyClose */b")).not.toContain("accesskeyClose");
    expect(stripComments('const u = "https://example.test/"; accesskeyClose')).toContain("accesskeyClose");
  });

  for (const { label, pattern } of FORBIDDEN) {
    it(`${label}が無い`, () => {
      const hits = files.filter((f) => pattern.test(stripComments(readFileSync(f, "utf-8"))));
      expect(hits).toEqual([]);
    });
  }
});
