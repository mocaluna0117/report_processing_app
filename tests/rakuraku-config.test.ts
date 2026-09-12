import { afterEach, describe, expect, it } from "vitest";
import { assertTenantUrl, readTenantConfig, resolveTenantPath } from "@/lib/rakuraku/config";

const KEYS = ["RAKURAKU_LOGIN_URL", "RAKURAKU_DEPT_NAME"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const TENANT = { loginUrl: "https://example.test/abcd/" };

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

  it("読めたら URL を返す（前後の空白は落とす）", () => {
    process.env.RAKURAKU_LOGIN_URL = " https://example.test/abcd/ ";
    expect(readTenantConfig()).toEqual(TENANT);
  });

  it("★部門名の環境変数があっても使わない（部門はその都度楽楽精算から読む）", () => {
    process.env.RAKURAKU_LOGIN_URL = "https://example.test/abcd/";
    process.env.RAKURAKU_DEPT_NAME = "架空部";
    expect(readTenantConfig()).toEqual(TENANT);
  });
});

describe("テナントの中の相対パス", () => {
  it("ログイン画面の場所を基点に組む", () => {
    expect(resolveTenantPath("sapWorkflowJibumonKensaku/initializeView?workflowId=4&refId=4", TENANT)).toBe(
      "https://example.test/abcd/sapWorkflowJibumonKensaku/initializeView?workflowId=4&refId=4",
    );
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
