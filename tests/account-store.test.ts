import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAuthConfig } from "@/lib/account/config";
import { StoreUnavailableError, createFileKv, createMemoryKv, createRedisKv } from "@/lib/account/kv";
import { createKeyedLimiter } from "@/lib/account/rate-limit";
import type { AccountRecord } from "@/lib/account/record";
import { FAIL_TTL_SEC, KEYS, createAccountStore } from "@/lib/account/store";

// アカウントの置き場所（2026-09-24）。★値はすべて架空。
const SECRET = "kasou-secret-kasou-secret-kasou-secret-0123";
const record = (over: Partial<AccountRecord> = {}): AccountRecord => ({
  v: 1,
  id: "kasou-taro",
  name: "架空 太郎",
  role: "member",
  hash: "scrypt$1$10.8.1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g",
  mustChange: false,
  tempExpiresAt: null,
  disabled: false,
  sv: 1_700_000_000_000,
  createdAt: 1_700_000_000_000,
  passwordChangedAt: null,
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("設定の読み方", () => {
  const vercel = { VERCEL: "1", VERCEL_ENV: "production" };
  const complete = {
    ...vercel,
    FOLIO_SESSION_SECRET: SECRET,
    KV_REST_API_URL: "https://kasou.upstash.invalid",
    KV_REST_API_TOKEN: "kasou-token",
  };

  it("手元でアカウントを使わないなら off（今までの開発と同じ）", () => {
    expect(readAuthConfig({})).toEqual({ kind: "off" });
    expect(readAuthConfig({ NODE_ENV: "development" })).toEqual({ kind: "off" });
  });

  it("★手元で APP_PASSWORD だけ入れたら、開いたままにせず止める（前は APP_PASSWORD だけで守れた）", () => {
    expect(readAuthConfig({ NODE_ENV: "development", APP_PASSWORD: "x" })).toEqual({ kind: "broken", missing: ["FOLIO_ACCOUNTS"] });
  });

  it("★Vercel の上で足りなければ broken（閉じる）。足りない名前だけを返し、値は出さない", () => {
    const broken = readAuthConfig({ ...vercel, KV_REST_API_TOKEN: "kasou-token" });
    expect(broken).toEqual({ kind: "broken", missing: ["FOLIO_SESSION_SECRET", "KV_REST_API_URL"] });
    expect(JSON.stringify(broken)).not.toContain("kasou-token");
    expect(readAuthConfig({ VERCEL_ENV: "preview" }).kind).toBe("broken");
    expect(readAuthConfig({ NODE_ENV: "production" }).kind).toBe("broken");
  });

  it("秘密が短い・URL が https でないのも broken", () => {
    expect(readAuthConfig({ ...complete, FOLIO_SESSION_SECRET: "short" }).kind).toBe("broken");
    expect(readAuthConfig({ ...complete, KV_REST_API_URL: "http://kasou.invalid" }).kind).toBe("broken");
  });

  it("そろっていれば accounts。★前の合言葉（APP_PASSWORD・FOLIO_LEGACY_UNTIL）は、あっても使わない", () => {
    const config = readAuthConfig({ ...complete, APP_PASSWORD: "kasou-shared", FOLIO_LEGACY_UNTIL: "1800000000", FOLIO_BOOTSTRAP: " code " });
    expect(config).toEqual({
      kind: "accounts",
      store: { kind: "redis", url: "https://kasou.upstash.invalid", token: expect.any(String) },
      secret: SECRET,
      bootstrap: "code",
    });
    expect(JSON.stringify(config)).not.toContain("kasou-shared");
    expect(readAuthConfig(complete)).toMatchObject({ kind: "accounts", bootstrap: null });
  });

  it("連携の名前が UPSTASH_REDIS_REST_* でも読む", () => {
    const config = readAuthConfig({
      ...vercel,
      FOLIO_SESSION_SECRET: SECRET,
      UPSTASH_REDIS_REST_URL: "https://kasou.upstash.invalid",
      UPSTASH_REDIS_REST_TOKEN: "kasou-token",
    });
    expect(config.kind).toBe("accounts");
  });

  it("★手元の開発はファイル。ただし本番ではファイルを使わない", () => {
    expect(readAuthConfig({ FOLIO_ACCOUNTS: "file", FOLIO_SESSION_SECRET: SECRET })).toMatchObject({
      kind: "accounts",
      store: { kind: "file" },
    });
    expect(readAuthConfig({ ...vercel, FOLIO_ACCOUNTS: "file", FOLIO_SESSION_SECRET: SECRET }).kind).toBe("broken");
  });
});

describe("メモリの置き場所（テスト・開発と同じ動き）", () => {
  it("無いときだけ書く・値が合うときだけ置き換える", async () => {
    const kv = createMemoryKv();
    expect(await kv.setNx("a", "1")).toBe(true);
    expect(await kv.setNx("a", "2")).toBe(false);
    expect(await kv.cas("a", "2", "3")).toBe(false);
    expect(await kv.cas("a", "1", "3")).toBe(true);
    expect(await kv.cas("b", null, "x")).toBe(true);
    expect(await kv.cas("b", null, "y")).toBe(false);
    expect(await kv.mget(["a", "b", "c"])).toEqual(["3", "x", null]);
  });

  it("戻す（1つ減らす）こともできる。期限は最初に作ったときのまま", async () => {
    const kv = createMemoryKv();
    expect(await kv.incrWithTtl("n", 10)).toBe(1);
    expect(await kv.incrWithTtl("n", 10, -1)).toBe(0);
  });

  it("数えるものは期限つき。期限が来たら消える", async () => {
    let now = 0;
    const kv = createMemoryKv(() => now);
    expect(await kv.incrWithTtl("n", 10)).toBe(1);
    expect(await kv.incrWithTtl("n", 10)).toBe(2);
    now = 10_001;
    expect(await kv.mget(["n"])).toEqual([null]);
    expect(await kv.incrWithTtl("n", 10)).toBe(1);
  });
});

describe("アカウントの読み書き", () => {
  it("作る（同じ ID は2回作れない）・読む・一覧", async () => {
    const store = createAccountStore(createMemoryKv());
    expect(await store.create(record())).toBe(true);
    expect(await store.create(record())).toBe(false);
    await store.create(record({ id: "kasou-hanako", name: "架空 花子" }));
    expect((await store.get("kasou-taro"))?.name).toBe("架空 太郎");
    expect((await store.list()).map((r) => r.id)).toEqual(["kasou-hanako", "kasou-taro"]);
  });

  it("★書き換えは、読んだときから変わっていないときだけ（割り込まれたらやり直す）", async () => {
    const kv = createMemoryKv();
    const store = createAccountStore(kv);
    await store.create(record());
    const [raw] = await kv.mget([KEYS.account("kasou-taro")]);
    let first = true;
    const result = await store.update("kasou-taro", (r) => {
      if (first) {
        first = false;
        // 読んだあとに、管理者が止めた（別の書き込み）
        void kv.cas(KEYS.account("kasou-taro"), raw, JSON.stringify({ ...r, disabled: true }));
      }
      return { ...r, name: "架空 太郎（改）" };
    });
    expect(result.ok).toBe(true);
    const saved = await store.get("kasou-taro");
    // ★停止が上書きされずに残っている
    expect(saved).toMatchObject({ disabled: true, name: "架空 太郎（改）" });
  });

  it("無いアカウントは missing。壊れた中身は無いものとして扱う", async () => {
    const kv = createMemoryKv();
    const store = createAccountStore(kv);
    expect(await store.update("kasou-none", (r) => r)).toEqual({ ok: false, reason: "missing" });
    await kv.setNx(KEYS.account("kasou-bad"), "{broken");
    expect(await store.get("kasou-bad")).toBeNull();
  });

  it("試す前に数える。15分で消え、正しく入れたら数え直す", async () => {
    let now = 0;
    const store = createAccountStore(createMemoryKv(() => now));
    expect(await store.reserveAttempt(["fid", "fip"])).toEqual([1, 1]);
    expect(await store.reserveAttempt(["fid", "fip"])).toEqual([2, 2]);
    await store.clearFailures("fid");
    expect(await store.reserveAttempt(["fid", "fip"])).toEqual([1, 3]);
    now = FAIL_TTL_SEC * 1000 + 1;
    expect(await store.reserveAttempt(["fid", "fip"])).toEqual([1, 1]);
  });

  it("★同時に数えても取りこぼさない（照合の前に数えるので、上限を超えて照合しない）", async () => {
    const store = createAccountStore(createMemoryKv());
    const counts = await Promise.all(Array.from({ length: 20 }, () => store.reserveAttempt(["fid"])));
    expect(counts.map(([n]) => n).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("最初の管理者のコードの印は1回だけ置ける。外せば置き直せる", async () => {
    const store = createAccountStore(createMemoryKv());
    expect(await store.markBootstrapUsed(KEYS.boot("h"), 3600)).toBe(true);
    expect(await store.markBootstrapUsed(KEYS.boot("h"), 3600)).toBe(false);
    await store.unmarkBootstrap(KEYS.boot("h"));
    expect(await store.markBootstrapUsed(KEYS.boot("h"), 3600)).toBe(true);
  });
});

describe("手元の開発用のファイル", () => {
  it("★別々の束（proxy と API のルート）が同時に書いても、片方の書き込みが消えない", async () => {
    const dir = mkdtempSync(join(tmpdir(), "folio-kv-"));
    try {
      const path = join(dir, "accounts.json");
      const a = createFileKv(path);
      const b = createFileKv(path);
      await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).incrWithTtl("n", 60)));
      await Promise.all([a.setNx("x", "1"), b.setNx("y", "2")]);
      expect(await a.mget(["n", "x", "y"])).toEqual(["10", "1", "2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });


  it("proxy と API のルート（別の束）で同じものを読める。ファイルは本人だけが読める", async () => {
    const dir = mkdtempSync(join(tmpdir(), "folio-kv-"));
    try {
      const path = join(dir, "accounts.json");
      await createAccountStore(createFileKv(path)).create(record());
      expect((await createAccountStore(createFileKv(path)).get("kasou-taro"))?.id).toBe("kasou-taro");
      expect(statSync(path).mode & 0o077).toBe(0);
      expect(readFileSync(path, "utf8")).not.toContain("架空のパスワード");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Upstash Redis（通信は作り物）", () => {
  const config = { url: "https://kasou.upstash.invalid", token: "kasou-token-do-not-leak" };

  it("決まった命令を送る（compare-and-set は EVAL）", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ result: 1 }), { status: 200 });
      }),
    );
    const kv = createRedisKv(config);
    expect(await kv.cas("folio:acct:kasou-taro", null, "{}")).toBe(true);
    expect(await kv.incrWithTtl("folio:fail:id:x", 900)).toBe(1);
    const [cas, incr] = bodies as string[][];
    expect(cas[0].toLowerCase()).toBe("eval");
    expect(cas.slice(2)).toEqual([1, "folio:acct:kasou-taro", "", "{}"]);
    expect(incr.slice(2)).toEqual([1, "folio:fail:id:x", "900", "1"]);
  });

  it("★届かないときは StoreUnavailableError。トークンも URL も文に出さない", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError(`fetch failed ${config.url} ${config.token}`);
      }),
    );
    const kv = createRedisKv(config);
    const error = await kv.mget(["a"]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreUnavailableError);
    expect(String((error as Error).message)).not.toMatch(/kasou-token|upstash\.invalid/);
  });
});

describe("Redis の手前の回数制限（キーごと）", () => {
  it("キーごとに数える（1人の連打で全員が止まらない）", () => {
    const limiter = createKeyedLimiter({ windowMs: 60_000, max: 2 });
    expect(limiter.take("a", 0)).toBe(true);
    expect(limiter.take("a", 1)).toBe(true);
    expect(limiter.take("a", 2)).toBe(false);
    expect(limiter.take("b", 2)).toBe(true);
    expect(limiter.take("a", 60_001)).toBe(true);
  });
});
