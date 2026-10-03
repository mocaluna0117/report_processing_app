import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readXlsxSheets } from "@/lib/after/xlsx-read";
import { isCfb, readCfb } from "@/lib/xlsx/cfb";
import { WrongPasswordError, decryptXlsx, isEncryptedOffice, parseEncryptionInfo } from "@/lib/xlsx/decrypt";
import { sha512 } from "@/lib/xlsx/sha512";
import { encryptXlsx, writeCfb } from "./helpers/encrypted-xlsx";
import { buildXlsx } from "./helpers/xlsx-fixture";

// パスワード付き xlsx（Agile 暗号）を開く。値はすべて架空

describe("同期の SHA-512", () => {
  it("★WebCrypto と同じ結果（長さの境目を含む）", async () => {
    for (const len of [0, 1, 55, 68, 111, 112, 127, 128, 129, 255, 256, 1000]) {
      const data = crypto.getRandomValues(new Uint8Array(len));
      const want = new Uint8Array(await crypto.subtle.digest("SHA-512", data));
      expect(sha512(data), `長さ ${len}`).toEqual(want);
    }
  });

  it("10万回まわしても数秒かからない", () => {
    const started = Date.now();
    let h: Uint8Array = new Uint8Array(64);
    const buf = new Uint8Array(68);
    for (let i = 0; i < 100_000; i++) {
      buf.set(h, 4);
      h = sha512(buf);
    }
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe("複合ファイルを読む", () => {
  it("★小さいストリーム（ミニストリーム）も大きいストリームも名前で読める", () => {
    const small = new Uint8Array(300).map((_, i) => i % 251);
    const large = new Uint8Array(10_000).map((_, i) => (i * 7) % 253);
    const cfb = readCfb(writeCfb([
      { name: "Small", data: small },
      { name: "Large", data: large },
    ]));
    expect(cfb.names()).toEqual(["Small", "Large"]);
    expect(cfb.read("Small")).toEqual(small);
    expect(cfb.read("Large")).toEqual(large);
    expect(cfb.read("None")).toBeNull();
  });

  it("ZIP は複合ファイルではない", () => {
    expect(isCfb(buildXlsx([{ name: "S", rows: [["a"]] }]))).toBe(false);
  });
});

describe("パスワード付きの xlsx を開く", () => {
  const plain = buildXlsx([{ name: "7期～", rows: [["PJ", "受付日"], ["9901230101", "46235"]] }]);

  it("★正しいパスワードなら元の xlsx に戻り、そのまま読める", async () => {
    const encrypted = await encryptXlsx(plain, "架空のパスワード1");
    expect(isEncryptedOffice(encrypted)).toBe(true);
    const opened = await decryptXlsx(encrypted, "架空のパスワード1");
    expect(opened).toEqual(plain);
    expect(readXlsxSheets(opened)[0].rows[1]).toEqual(["9901230101", "46235"]);
  });

  it("★違うパスワードは WrongPasswordError（中身を返さない）", async () => {
    const encrypted = await encryptXlsx(plain, "right");
    await expect(decryptXlsx(encrypted, "wrong")).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it("4096バイトを超える本体も、かたまりごとに復号できる", async () => {
    const rows = Array.from({ length: 400 }, (_, i) => [`架空${i}`, String(46000 + i), "x".repeat(20)]);
    const big = buildXlsx([{ name: "S", rows }]);
    expect(big.length).toBeGreaterThan(4096);
    const opened = await decryptXlsx(await encryptXlsx(big, "pw"), "pw");
    expect(opened).toEqual(big);
  });

  it("パスワードの無い普通の xlsx は暗号化されたものとみなさない", () => {
    expect(isEncryptedOffice(plain)).toBe(false);
  });
});

// ★実物（git 管理外）。置いてあれば、暗号の形式が想定どおり（Agile 4.4・AES-256・SHA-512）か確かめる
const REAL = "進捗管理表_例/2026.4～年次点検進捗管理表（8期）.xlsx";
describe.skipIf(!existsSync(REAL))("実物の年次点検進捗管理表", () => {
  it("暗号の情報を読める（パスワードは使わない）", () => {
    const bytes = new Uint8Array(readFileSync(REAL));
    expect(isEncryptedOffice(bytes)).toBe(true);
    const info = readCfb(bytes).read("EncryptionInfo")!;
    const params = parseEncryptionInfo(info);
    expect(params.password.hash).toBe("SHA-512");
    expect(params.keyData.keyBits).toBe(256);
    expect(params.password.spinCount).toBe(100000);
  });

  // 利用者が仮のパスワード folio-test を付けた控えを置いたときだけ、実際に開けるか確かめる
  const TEST_COPY = "進捗管理表_例/年次点検_folio-test.xlsx";
  it.skipIf(!existsSync(TEST_COPY))("仮のパスワードの控えを開ける", async () => {
    const opened = await decryptXlsx(new Uint8Array(readFileSync(TEST_COPY)), "folio-test");
    expect(readXlsxSheets(opened).length).toBeGreaterThan(0);
  }, 60_000);
});

describe("表を開く（支出報告書）", () => {
  const plain = buildXlsx([{ name: "S", rows: [["PJ"]] }]);

  it("パスワード付きはパスワードで開き、無ければ入れるよう求める・違えばそう言う", async () => {
    const { openSheets, PasswordNeededError } = await import("@/lib/shishutsu/load");
    const encrypted = await encryptXlsx(plain, "架空");
    expect((await openSheets(encrypted, "架空", "年次点検進捗管理表"))[0].rows[0]).toEqual(["PJ"]);
    await expect(openSheets(encrypted, "", "年次点検進捗管理表")).rejects.toBeInstanceOf(PasswordNeededError);
    await expect(openSheets(encrypted, "違う", "年次点検進捗管理表")).rejects.toThrow("年次点検進捗管理表のパスワードが違います");
    // パスワードの無い表は、入っていても使わない
    expect((await openSheets(plain, "架空", "表"))[0].rows[0]).toEqual(["PJ"]);
  });
});
