import { describe, expect, it } from "vitest";
import { loginErrorText } from "@/lib/account/messages";
import {
  canonicalTemp,
  dummyHash,
  generateTempPassword,
  hashPassword,
  verifyPassword,
} from "@/lib/account/password";
import {
  displayNameProblem,
  loginIdProblem,
  normalizeLoginId,
  passwordProblems,
} from "@/lib/account/policy";
import { nextVersion, parseAccountRecord, replacedByLogin, sessionRevoked, summarizeAccount } from "@/lib/account/record";
import { type SessionClaims, keyedHash, signSession, verifySession } from "@/lib/account/token";
import { encodeSignedInMarker, readSignedInMarker } from "@/lib/auth";

// 人ごとのアカウントの純関数（2026-09-24）。★値はすべて架空（公開リポジトリ）。
const FAST = { log2N: 10, r: 8, p: 1 };
const SECRET = "kasou-secret-kasou-secret-kasou-secret-0123";
const NOW = 1_800_000_000;

describe("ログインID・表示名の決まり", () => {
  it("揃える（全角→半角・空白・大文字）", () => {
    expect(normalizeLoginId("  Ｋａｓｏｕ-Taro ")).toBe("kasou-taro");
  });

  it("小文字の英数字と . _ - で3〜32文字", () => {
    expect(loginIdProblem("kasou-taro")).toBeNull();
    expect(loginIdProblem("k.s_1")).toBeNull();
    expect(loginIdProblem("ab")).toContain("3文字以上");
    expect(loginIdProblem("a".repeat(33))).toContain("32文字まで");
    expect(loginIdProblem("-kasou")).toContain("先頭は英数字");
    expect(loginIdProblem("架空太郎")).toContain("半角");
  });

  it("表示名は1〜20文字", () => {
    expect(displayNameProblem("架空")).toBeNull();
    expect(displayNameProblem("  ")).toContain("入れて");
    expect(displayNameProblem("あ".repeat(21))).toContain("20文字まで");
  });
});

describe("パスワードの決まり（8文字以上。記号・大文字の決まりは無し）", () => {
  const ok = { loginId: "kasou-taro", confirm: "" };
  const problems = (password: string, over: Partial<Parameters<typeof passwordProblems>[0]> = {}) =>
    passwordProblems({ ...ok, password, confirm: password, ...over });

  it("8文字以上で、確認と一致すれば使える", () => {
    expect(problems("sakura-tanbo")).toEqual([]);
    expect(problems("やまのぼり")).toContain("パスワードは8文字以上にしてください（いま5文字）");
    expect(problems("かわのながれがはやい")).toEqual([]);
  });

  it("短い・同じ文字だけ・よくあるもの・IDを含むものは使えない", () => {
    expect(problems("abc")[0]).toContain("8文字以上");
    expect(problems("aaaaaaaa")).toContain("同じ文字だけのパスワードは使えません");
    expect(problems("Password123")[0]).toContain("よく使われる");
    expect(problems("my-kasou-taro-pw")).toContain("ログインIDを含むパスワードは使えません");
  });

  it("今（仮）のパスワードと同じもの、確認が違うものは使えない", () => {
    expect(problems("sakura-tanbo", { current: "sakura-tanbo" })).toContain("今のパスワードと違うものにしてください");
    expect(problems("sakura-tanbo", { confirm: "sakura-tanb0" })).toContain(
      "確認のために入れたパスワードが一致しません",
    );
  });

  it("全角で打っても半角と同じに扱う", () => {
    expect(problems("ｓａｋｕｒａ-ｔａｎｂｏ", { confirm: "sakura-tanbo" })).toEqual([]);
  });
});

describe("パスワードをしまう（scrypt）", () => {
  it("ハッシュだけを作り、同じパスワードで通る・違えば通らない", async () => {
    const hash = await hashPassword("架空のパスワード", FAST);
    expect(hash.startsWith("scrypt$1$10.8.1$")).toBe(true);
    expect(hash).not.toContain("架空のパスワード");
    expect(await verifyPassword("架空のパスワード", hash)).toBe(true);
    expect(await verifyPassword("架空のパスワード2", hash)).toBe(false);
  });

  it("同じパスワードでも毎回違うハッシュ（塩）", async () => {
    expect(await hashPassword("sakura-tanbo", FAST)).not.toBe(await hashPassword("sakura-tanbo", FAST));
  });

  it("★壊れた・重すぎるハッシュでも例外を出さず通さない", async () => {
    for (const bad of ["", "abc", "scrypt$1$x$y$z", "scrypt$1$30.8.1$AAAAAAAAAAAAAAAAAAAAAA$AAAA", "bcrypt$..."]) {
      expect(await verifyPassword("x", bad)).toBe(false);
    }
  });

  it("ID が無いとき用のダミーは、何を入れても通らない", async () => {
    expect(await verifyPassword("sakura-tanbo", await dummyHash(FAST))).toBe(false);
  });

  it("仮のパスワードは12文字（xxxx-xxxx-xxxx）で、見間違えやすい文字を使わない", () => {
    for (let i = 0; i < 50; i += 1) {
      const temp = generateTempPassword();
      expect(temp).toMatch(/^[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}$/);
    }
  });

  it("★仮のパスワードは、大文字・小文字・ハイフン・空白を区別しない", () => {
    expect(canonicalTemp("AB2C-DEFG-HJK3")).toBe("ab2cdefghjk3");
    expect(canonicalTemp("ab2c defg hjk3")).toBe("ab2cdefghjk3");
    expect(canonicalTemp("ＡＢ２Ｃ－ＤＥＦＧ－ＨＪＫ３")).toBe("ab2cdefghjk3");
  });
});

describe("ログインの印の署名", () => {
  const claims: SessionClaims = { u: "kasou-taro", sv: 1_700_000_000_000, mc: 0, chk: NOW, exp: NOW + 30 * 86_400 };

  it("作ったものは同じ秘密で読める", () => {
    const token = signSession(claims, SECRET);
    expect(token.startsWith("v2.")).toBe(true);
    expect(verifySession(token, SECRET, NOW)).toEqual(claims);
  });

  it("★中身を書き換えたもの・別の秘密・期限切れは読めない", () => {
    const token = signSession(claims, SECRET);
    const [, payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...claims, u: "kasou-admin" })).toString("base64url");
    expect(verifySession(`v2.${forged}.${sig}`, SECRET, NOW)).toBeNull();
    expect(verifySession(`v2.${payload}.${sig}x`, SECRET, NOW)).toBeNull();
    expect(verifySession(token, `${SECRET}-other`, NOW)).toBeNull();
    expect(verifySession(token, SECRET, claims.exp)).toBeNull();
  });

  it("おかしな形・未来の確認時刻・長すぎる期限は読めない", () => {
    const bad = (c: Partial<SessionClaims>) => verifySession(signSession({ ...claims, ...c }, SECRET), SECRET, NOW);
    expect(bad({ u: "Kasou" })).toBeNull();
    expect(bad({ chk: NOW + 120 })).toBeNull();
    expect(bad({ exp: NOW + 400 * 86_400 })).toBeNull();
    expect(bad({ mc: 2 as 0 })).toBeNull();
    for (const t of [undefined, null, "", "v1.1.2", "v2.a", "v2.a.b.c", "x".repeat(2000)]) {
      expect(verifySession(t, SECRET, NOW)).toBeNull();
    }
    expect(verifySession(signSession(claims, SECRET), "", NOW)).toBeNull();
  });

  it("キー名用の HMAC は、元の文字を残さない", () => {
    const h = keyedHash(SECRET, "fail-id", "kasou-taro");
    expect(h).toHaveLength(16);
    expect(h).not.toContain("kasou");
    expect(keyedHash(SECRET, "fail-ip", "kasou-taro")).not.toBe(h);
  });
});

describe("Redis に置くアカウントの検査", () => {
  const good = {
    v: 1,
    id: "kasou-taro",
    name: "架空 太郎",
    role: "member",
    hash: "scrypt$1$15.8.1$salt$hash",
    mustChange: true,
    tempExpiresAt: 1_800_000_000_000,
    disabled: false,
    sv: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    passwordChangedAt: null,
  };

  it("正しい形だけを受け付ける（文字列の JSON でも）。最後のログインの時刻が無い前のアカウントも読める", () => {
    expect(parseAccountRecord(good)).toEqual({ ...good, loginAt: null });
    expect(parseAccountRecord(JSON.stringify(good))).toEqual({ ...good, loginAt: null });
    expect(parseAccountRecord({ ...good, loginAt: good.sv })).toEqual({ ...good, loginAt: good.sv });
  });

  it("★版は増えるだけ（時計が戻っても）。印の版のほうが新しいのは、読みが遅れているだけ", () => {
    expect(nextVersion(null, 1000)).toBe(1000);
    expect(nextVersion({ sv: 500 }, 1000)).toBe(1000);
    expect(nextVersion({ sv: 5000 }, 1000)).toBe(5001);
    const record = parseAccountRecord({ ...good, mustChange: false, loginAt: good.sv })!;
    expect(sessionRevoked(record, good.sv)).toBe(false);
    expect(sessionRevoked(record, good.sv + 1)).toBe(false);
    expect(sessionRevoked(record, good.sv - 1)).toBe(true);
    expect(sessionRevoked({ ...record, disabled: true }, good.sv)).toBe(true);
    expect(sessionRevoked(null, good.sv)).toBe(true);
    // 最後に版を進めたのがログインなら「ほかの端末でログインした」
    expect(replacedByLogin(record)).toBe(true);
    expect(replacedByLogin({ ...record, loginAt: good.sv - 1 })).toBe(false);
    expect(replacedByLogin({ ...record, loginAt: null })).toBe(false);
  });

  it("★おかしなものは受け付けない（Redis の中身を信じない）", () => {
    for (const over of [{ v: 2 }, { id: "X" }, { role: "owner" }, { hash: "plain" }, { sv: -1 }, { disabled: "no" }, { loginAt: "x" }]) {
      expect(parseAccountRecord({ ...good, ...over })).toBeNull();
    }
    expect(parseAccountRecord("{not json")).toBeNull();
    expect(parseAccountRecord(null)).toBeNull();
  });

  it("★管理の画面に出す形にハッシュは入らない", () => {
    const summary = summarizeAccount(parseAccountRecord(good)!);
    expect(JSON.stringify(summary)).not.toContain("scrypt");
  });
});

describe("表示用の印（ヘッダー）", () => {
  it("日本語の名前でも読み書きできる", () => {
    const raw = encodeSignedInMarker({ id: "kasou-taro", name: "架空 太郎", admin: true, mustChange: false });
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(readSignedInMarker(raw)).toEqual({
      id: "kasou-taro",
      name: "架空 太郎",
      admin: true,
      mustChange: false,
    });
  });

  it("★前の合言葉の \"1\" も、壊れた値も null（「前の合言葉」とは出さない。例外を出さない）", () => {
    for (const raw of ["1", "MQ", "bnVsbA", undefined, null, "", "!!!", "e30", "x".repeat(600)]) {
      expect(readSignedInMarker(raw)).toBeNull();
    }
  });
});

describe("ログインの失敗の文", () => {
  it("★ID の有無・パスワードの違いを言い分けない。知らない値は出さない", () => {
    expect(loginErrorText("1")).toBe("ログインIDかパスワードが違います");
    expect(loginErrorText("locked")).toContain("15分");
    expect(loginErrorText("<script>")).toBeNull();
    expect(loginErrorText(null)).toBeNull();
  });
});
