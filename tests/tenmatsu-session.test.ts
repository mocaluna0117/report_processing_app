import { beforeEach, describe, expect, it } from "vitest";
import { getSession, keepSession, resetSessions, shareToken } from "@/lib/tenmatsu/session";

/** keepSession に渡す形（hydrated 以外の全部） */
const snapshot = (over: Partial<ReturnType<typeof getSession>> = {}) => {
  const { hydrated: _drop, ...rest } = getSession("tenmatsu");
  return { ...rest, ...over };
};

beforeEach(() => {
  resetSessions();
});

describe("種類ごとの控え", () => {
  it("同じ種類には毎回同じオブジェクトを返す", () => {
    expect(getSession("tenmatsu")).toBe(getSession("tenmatsu"));
  });

  it("種類が違えば別のオブジェクト", () => {
    expect(getSession("tenmatsu")).not.toBe(getSession("senketsu"));
  });

  it("最初は未接続・空の一覧から始まる", () => {
    const s = getSession("senketsu");
    expect(s.hydrated).toBe(false);
    expect(s.connection).toBe("idle");
    expect(s.items).toEqual([]);
  });

  it("★控えた内容が別の種類へ漏れない", () => {
    keepSession("tenmatsu", snapshot({ connection: "ok", listFresh: true }));
    expect(getSession("tenmatsu").connection).toBe("ok");
    expect(getSession("tenmatsu").hydrated).toBe(true);
    expect(getSession("senketsu").connection).toBe("idle");
    expect(getSession("senketsu").hydrated).toBe(false);
  });

  it("★トークンは全部の種類で共有する", () => {
    getSession("tenmatsu");
    getSession("senketsu");
    shareToken("tok-1");
    expect(getSession("tenmatsu").token).toBe("tok-1");
    expect(getSession("senketsu").token).toBe("tok-1");
    shareToken(null);
    expect(getSession("senketsu").token).toBeNull();
  });

  it("★あとから開いた種類もトークンを引き継ぐ (登録し直さずに済む)", () => {
    keepSession("tenmatsu", snapshot({ token: "tok-1" }));
    expect(getSession("senketsu").token).toBe("tok-1");
    // 引き継ぐのはトークンだけ。接続や一覧は引き継がない
    expect(getSession("senketsu").connection).toBe("idle");
  });

  it("種類を指定して控えを捨てられる", () => {
    keepSession("tenmatsu", snapshot({ connection: "ok" }));
    keepSession("senketsu", snapshot({ connection: "ok" }));
    resetSessions("tenmatsu");
    expect(getSession("tenmatsu").connection).toBe("idle");
    expect(getSession("senketsu").connection).toBe("ok");
  });
});
