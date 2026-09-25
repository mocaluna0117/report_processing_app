import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ★このリポジトリは公開されている。楽楽精算まわりのテストと素材に、実在しうる値を入れない。
 *
 * 移植元の検証素材には、利用者の実際のログインIDが社員番号として紛れていた。
 * 素材を足すたびに人が気を付けるのでは漏れるので、形で見張る。
 * ※実際の値そのものをここに書くと、それ自体が漏えいになるので書かない。
 */
const ROOTS = ["tests/rakuraku", "lib/rakuraku", "app/api/rakuraku", "scripts/help-shots"];
const EXTRA_FILES = [
  "lib/rakuraku-credential.ts",
  "components/account/rakuraku-credential.tsx",
  "components/tenmatsu/rakuraku-line.tsx",
  "lib/tenmatsu/store.ts",
  "tests/tenmatsu-folder-settings.test.ts",
  "tests/tenmatsu-local-session.test.ts",
  "tests/tenmatsu-local-job.test.ts",
];

function collect(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(path);
    }
  };
  for (const root of ROOTS) walk(join(process.cwd(), root));
  // ★楽楽精算のIDとパスワードの登録（2026-09-25）。ID（社員番号）が紛れ込みやすいので、ここも見張る
  for (const file of EXTRA_FILES) out.push(join(process.cwd(), file));
  for (const name of readdirSync(join(process.cwd(), "tests"))) {
    if (/^rakuraku-.*\.test\.ts$/.test(name)) out.push(join(process.cwd(), "tests", name));
  }
  return out;
}

const CHECKS: { label: string; pattern: RegExp }[] = [
  // 社員番号の形（6桁・17で始まる）。架空の値には 99 で始まる番号を使う
  { label: "社員番号の形の数字", pattern: /(?<![0-9])17[0-9]{4}(?![0-9])/ },
  // テナントの場所。コードでは環境変数から読むので、どこにも書かない
  { label: "楽楽精算のテナントのホスト", pattern: /rakurakuseisan\.jp/ },
];

describe("★公開リポジトリに実在しうる値を入れない", () => {
  const files = collect();

  it("見張る対象のファイルが見つかっている", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const { label, pattern } of CHECKS) {
    it(`${label}が入っていない`, () => {
      const hits = files
        .filter((f) => !f.endsWith("rakuraku-privacy.test.ts"))
        .filter((f) => pattern.test(readFileSync(f, "utf-8")));
      expect(hits).toEqual([]);
    });
  }
});
