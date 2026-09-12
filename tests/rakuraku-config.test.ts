import { afterEach, describe, expect, it } from "vitest";
import { assertTenantUrl, readTenantConfig } from "@/lib/rakuraku/config";

const KEYS = ["RAKURAKU_LOGIN_URL", "RAKURAKU_DEPT_NAME"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const TENANT = { loginUrl: "https://example.test/abcd/", deptName: "架空部" };

describe("テナント設定の読み取り", () => {
  it("URLが無ければ null (機能そのものを止める)", () => {
    delete process.env.RAKURAKU_LOGIN_URL;
    expect(readTenantConfig()).toBeNull();
  });

  it("http は受け付けない", () => {
    process.env.RAKURAKU_LOGIN_URL = "http://example.test/abcd/";
    expect(readTenantConfig()).toBeNull();
  });

  it("URLの形をしていなければ null", () => {
    process.env.RAKURAKU_LOGIN_URL = "これはURLではない";
    expect(readTenantConfig()).toBeNull();
  });

  it("読めたら部門名も一緒に返す", () => {
    process.env.RAKURAKU_LOGIN_URL = " https://example.test/abcd/ ";
    process.env.RAKURAKU_DEPT_NAME = " 架空部 ";
    expect(readTenantConfig()).toEqual(TENANT);
  });

  it("部門名が無くても動く", () => {
    process.env.RAKURAKU_LOGIN_URL = "https://example.test/abcd/";
    delete process.env.RAKURAKU_DEPT_NAME;
    expect(readTenantConfig()?.deptName).toBe("");
  });
});

describe("テナント外のURLを開かせない (SSRF対策)", () => {
  it("同じオリジンなら通す", () => {
    expect(assertTenantUrl("https://example.test/abcd/detail?no=1", TENANT).pathname).toBe(
      "/abcd/detail",
    );
  });

  it("相対パスはテナントを基点に解く", () => {
    expect(assertTenantUrl("/abcd/list", TENANT).origin).toBe("https://example.test");
  });

  it("★別のホストは拒む", () => {
    expect(() => assertTenantUrl("https://evil.test/steal", TENANT)).toThrow("テナント外");
  });

  it("★ポートが違うだけでも拒む", () => {
    expect(() => assertTenantUrl("https://example.test:8443/abcd/", TENANT)).toThrow("テナント外");
  });

  it("★http への降格も拒む", () => {
    expect(() => assertTenantUrl("http://example.test/abcd/", TENANT)).toThrow("テナント外");
  });
});
