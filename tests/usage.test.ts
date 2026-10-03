import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryKv, createRedisKv } from "@/lib/account/kv";
import { createAccountStore, KEYS } from "@/lib/account/store";
import { type AccountRecord, summarizeAccount } from "@/lib/account/record";
import { loadUsageReport } from "@/lib/account/usage-admin";
import {
  type Metric,
  RAKURAKU_CODE_LABELS,
  datePrefixOf,
  isMetric,
  jstDayOf,
  kindMetric,
  rakurakuFailure,
  recentDays,
} from "@/lib/usage/metrics";
import { LAST_FIELD, USAGE_TTL_SEC, scheduleUsage, writeUsage } from "@/lib/usage/record";
import { buildUsageReport } from "@/lib/usage/summary";
import { activeDays, cellText, dayText, failureRows, geminiDays, totalOf, whenText } from "@/lib/usage/view";

// 利用状況（2026-10-02）。★値はすべて架空。
/** 2026-10-02 12:00（日本時間） */
const NOW = Date.parse("2026-10-02T12:00:00+09:00");
const DAY = 86_400_000;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("数える名前", () => {
  it("決まった名前だけを通す", () => {
    expect(isMetric("teiki")).toBe(true);
    expect(isMetric("rk.fetch.natsuin")).toBe(true);
    expect(isMetric("rk.fail.LIST_NOT_PERMITTED")).toBe(true);
    expect(isMetric("rk.fetch.other")).toBe(false);
    expect(isMetric("rk.fail.架空")).toBe(false);
    expect(isMetric("teiki:架空 太郎")).toBe(false);
    expect(isMetric(1)).toBe(false);
  });

  it("一覧・取得は本文の種類から名前を決める（読めなければ数えない）", () => {
    expect(kindMetric("scan", { kind: "tenmatsu" })).toBe("rk.scan.tenmatsu");
    expect(kindMetric("fetch", { kind: "senketsu", sessionToken: "x" })).toBe("rk.fetch.senketsu");
    expect(kindMetric("fetch", { kind: "other" })).toBeNull();
    expect(kindMetric("scan", null)).toBeNull();
  });

  it("失敗は合計と符号の両方。知らない符号は「そのほか」", () => {
    expect(rakurakuFailure("LOGIN_FAILED")).toEqual(["rk.fail", "rk.fail.LOGIN_FAILED"]);
    expect(rakurakuFailure("SESSION_SECRET")).toEqual(["rk.fail", "rk.fail.INTERNAL"]);
    expect(rakurakuFailure("toString")).toEqual(["rk.fail", "rk.fail.INTERNAL"]);
  });

  it("日付は日本時間（UTC 15:00 で次の日）", () => {
    expect(jstDayOf(Date.parse("2026-10-01T14:59:59Z"))).toBe("20261001");
    expect(jstDayOf(Date.parse("2026-10-01T15:00:00Z"))).toBe("20261002");
    expect(recentDays(NOW, 3)).toEqual(["20261002", "20261001", "20260930"]);
    expect(datePrefixOf("20261002:teiki")).toBe("20261002");
    expect(datePrefixOf(LAST_FIELD)).toBeNull();
  });

  it("失敗の符号には、すべて画面の説明がある", () => {
    for (const label of Object.values(RAKURAKU_CODE_LABELS)) expect(label.length).toBeGreaterThan(0);
  });
});

describe("書く（メモリの Kv）", () => {
  it("日ごとに足し、最後に使った時刻を置き換える", async () => {
    const kv = createMemoryKv(() => NOW);
    await writeUsage(kv, "kasou-taro", ["teiki", "gemini.summary"], NOW);
    await writeUsage(kv, "kasou-taro", ["teiki", "teiki"], NOW + 1000);
    const [hash] = await kv.hgetallMany([KEYS.usage("kasou-taro")]);
    expect(hash).toMatchObject({
      "20261002:teiki": "3",
      "20261002:gemini.summary": "1",
      [LAST_FIELD]: String(NOW + 1000),
    });
  });

  it("★型をすり抜けた名前は残さない（何も残らなければ書かない）", async () => {
    const kv = createMemoryKv(() => NOW);
    await writeUsage(kv, "kasou-taro", ["架空 太郎の伝票" as Metric], NOW);
    expect(await kv.hgetallMany([KEYS.usage("kasou-taro")])).toEqual([null]);
  });

  it("その日の最初の書き込みで、31日の窓より前の項目を消す（日の印も一緒に）", async () => {
    let now = 0;
    const kv = createMemoryKv(() => now);
    for (const ago of [40, 31, 30, 0]) {
      now = NOW - ago * DAY;
      await writeUsage(kv, "kasou-taro", ["after"], now);
    }
    const [hash] = await kv.hgetallMany([KEYS.usage("kasou-taro")]);
    const days = new Set(Object.keys(hash ?? {}).map(datePrefixOf));
    expect(days).toEqual(new Set([jstDayOf(NOW - 30 * DAY), "20261002", null]));
    expect(hash?.[`${jstDayOf(NOW - 30 * DAY)}:after`]).toBe("1");
  });

  it("書いてから60日で消える（書くたびに延びる）", async () => {
    let now = NOW;
    const kv = createMemoryKv(() => now);
    await writeUsage(kv, "kasou-taro", ["teiki"], now);
    now += (USAGE_TTL_SEC - 10) * 1000;
    await writeUsage(kv, "kasou-taro", ["teiki"], now);
    now += (USAGE_TTL_SEC - 10) * 1000;
    expect((await kv.hgetallMany([KEYS.usage("kasou-taro")]))[0]).not.toBeNull();
    now += 20_000;
    expect(await kv.hgetallMany([KEYS.usage("kasou-taro")])).toEqual([null]);
  });

  it("アカウントを消すと、利用状況も消える", async () => {
    const kv = createMemoryKv(() => NOW);
    const store = createAccountStore(kv);
    await store.create(account("kasou-taro"));
    await writeUsage(kv, "kasou-taro", ["teiki"], NOW);
    await store.remove("kasou-taro");
    expect(await kv.hgetallMany([KEYS.usage("kasou-taro")])).toEqual([null]);
  });

  it("アカウントを使わない手元（id が null）では何もしない・要求の外でも例外を出さない", () => {
    expect(() => scheduleUsage(null, ["teiki"])).not.toThrow();
    expect(() => scheduleUsage("kasou-taro", Promise.reject(new Error("x")))).not.toThrow();
  });
});

describe("Upstash Redis（通信は作り物）", () => {
  const config = { url: "https://kasou.upstash.invalid", token: "kasou-token-do-not-leak" };

  it("足すのも読むのも EVAL の1命令", async () => {
    const bodies: unknown[][] = [];
    // ★Upstash は文字を base64 で返す（クライアントが入れ子の配列まで戻す）
    const b64 = (v: string) => Buffer.from(v).toString("base64");
    const results: unknown[] = [1, [["20261002:teiki", "2", "last", "1"].map(b64), []]];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as unknown[]);
        return new Response(JSON.stringify({ result: results.shift() }), { status: 200 });
      }),
    );
    const kv = createRedisKv(config);
    await kv.hincr("folio:use:kasou-taro", {
      add: { "20261002:teiki": 2, "20261002:after": 0 },
      max: { last: 1 },
      dayMark: "20261002:_",
      pruneBefore: "20260901",
      ttlSec: 60,
    });
    expect(await kv.hgetallMany(["folio:use:kasou-taro", "folio:use:kasou-hanako"])).toEqual([
      { "20261002:teiki": "2", last: "1" },
      null,
    ]);
    expect(String(bodies[0][0]).toLowerCase()).toBe("eval");
    // ★0 は送らない
    expect(bodies[0].slice(2)).toEqual([1, "folio:use:kasou-taro", "1", "20261002:teiki", "2", "1", "last", "1", "20261002:_", "20260901", "60"]);
    expect(bodies[1].slice(2)).toEqual([2, "folio:use:kasou-taro", "folio:use:kasou-hanako"]);
  });
});

function account(id: string, over: Partial<AccountRecord> = {}): AccountRecord {
  return {
    v: 1,
    id,
    name: `架空 ${id}`,
    role: "member",
    hash: "scrypt$1$10.8.1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g",
    mustChange: false,
    tempExpiresAt: null,
    disabled: false,
    sv: NOW,
    createdAt: NOW,
    passwordChangedAt: null,
    loginAt: null,
    ...over,
  };
}

describe("画面に送る形", () => {
  it("今あるアカウントの分だけ・30日の中・決まった名前・正の整数だけを拾う", async () => {
    const kv = createMemoryKv(() => NOW);
    const store = createAccountStore(kv);
    await store.create(account("kasou-hanako", { loginAt: NOW - 5000 }));
    await store.create(account("kasou-taro"));
    await writeUsage(kv, "kasou-taro", ["teiki", "rk.fetch.tenmatsu"], NOW);
    await writeUsage(kv, "kasou-taro", ["after"], NOW - 29 * DAY);
    // 消した人（キーだけ残っている）
    await writeUsage(kv, "kasou-gone", ["teiki"], NOW);
    const report = await loadUsageReport({ store, kv }, NOW);
    expect(report.today).toBe("20261002");
    expect(report.days).toHaveLength(30);
    expect(report.people.map((p) => p.id)).toEqual(["kasou-hanako", "kasou-taro"]);
    const [hanako, taro] = report.people;
    expect(hanako).toMatchObject({ loginAt: NOW - 5000, lastUsedAt: null, byDay: {} });
    expect(taro.lastUsedAt).toBe(NOW);
    expect(taro.byDay).toEqual({
      "20261002": { teiki: 1, "rk.fetch.tenmatsu": 1 },
      [jstDayOf(NOW - 29 * DAY)]: { after: 1 },
    });
  });

  it("壊れた項目・窓の外の日は捨てる", () => {
    const report = buildUsageReport(
      [summarizeAccount(account("kasou-taro"))],
      [
        {
          "20261002:teiki": "2",
          "20261002:other": "5",
          "20261002:after": "-1",
          "20261002:contact": "x",
          "20260901:teiki": "9",
          "20261002:_": "1",
          last: "abc",
        },
      ],
      NOW,
    );
    expect(report.people[0]).toMatchObject({ lastUsedAt: null, byDay: { "20261002": { teiki: 2 } } });
  });
});

describe("画面の文", () => {
  const person = buildUsageReport(
    [summarizeAccount(account("kasou-taro"))],
    [
      {
        "20261002:teiki": "3",
        "20261001:teiki": "4",
        "20261001:gemini.summary": "2",
        "20261001:gemini.fail": "1",
        "20261001:rk.fail": "3",
        "20261001:rk.fail.LIST_NOT_PERMITTED": "2",
        "20261002:rk.fail.TENANT_UNREACHABLE": "1",
      },
    ],
    NOW,
  );

  it("30日の合計と今日の分", () => {
    const p = person.people[0];
    expect(totalOf(p, ["teiki"])).toBe(7);
    expect(cellText(7, 3)).toBe("7（今日 3）");
    expect(cellText(4, 0)).toBe("4");
    expect(cellText(0, 0)).toBe("—");
    expect(activeDays(p, person.days)).toEqual(["20261002", "20261001"]);
  });

  it("失敗の内訳は多い順、説明つき", () => {
    expect(failureRows(person.people[0])).toEqual([
      { code: "LIST_NOT_PERMITTED", label: RAKURAKU_CODE_LABELS.LIST_NOT_PERMITTED, count: 2 },
      { code: "TENANT_UNREACHABLE", label: RAKURAKU_CODE_LABELS.TENANT_UNREACHABLE, count: 1 },
    ]);
  });

  it("Gemini は全員の日ごとの合計（使った日だけ）", () => {
    expect(geminiDays(person)).toEqual([{ day: "20261001", ok: 2, fail: 1 }]);
  });

  it("日付と時刻（日本時間）", () => {
    expect(dayText("20261002")).toBe("10/2（金）");
    expect(whenText(null, NOW)).toBe("—");
    expect(whenText(Date.parse("2026-10-02T09:05:00+09:00"), NOW)).toBe("今日 9:05");
    expect(whenText(Date.parse("2026-10-01T23:59:00+09:00"), NOW)).toBe("10/1 23:59");
    expect(whenText(Date.parse("2025-12-01T09:00:00+09:00"), NOW)).toBe("2025/12/1 9:00");
  });
});

describe("作りの見張り", () => {
  const code = (p: string) => readFileSync(join(__dirname, "..", p), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

  it("★利用状況の画面は、Redis で管理者だと確かめてから読む", () => {
    const page = code("app/account/usage/page.tsx");
    expect(page).toContain("await accountPageState(");
    expect(page).toContain('state.record.role !== "admin" || state.forced');
    expect(page.indexOf('state.record.role !== "admin"')).toBeLessThan(page.indexOf("loadUsageReport("));
  });

  it("Gemini のルートは、答えたときも失敗したときも数える", () => {
    for (const p of ["app/api/summarize/route.ts", "app/api/work-categories/route.ts", "app/api/name-reading/route.ts"]) {
      expect(code(p), p).toMatch(/scheduleUsage\(signed\.id, \[[^\]]*"gemini\.(summary|vision|kana)"/);
      expect(code(p), p).toContain('"gemini.fail"]');
    }
  });

  it("楽楽精算の一覧・取得・添付は、流す返事に usage を渡す", () => {
    for (const p of ["app/api/rakuraku/scan/route.ts", "app/api/rakuraku/fetch/route.ts", "app/api/rakuraku/attachment/route.ts", "app/api/rakuraku/reread/route.ts"]) {
      expect(code(p), p).toContain("usage: { id: signed.id");
    }
  });
});
