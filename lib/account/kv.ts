/**
 * アカウントの置き場所の、いちばん下の読み書き（キーと値だけ）。
 *
 * - 本番: Upstash Redis（REST）。自動のやり直しはしない・2.5秒で打ち切る・利用状況の送信（telemetry）はしない。
 * - 手元の開発: `.cache/folio-dev-accounts.json`（proxy と API のルートは別の束に分かれるので、ファイルで共有する）。
 * - テスト: メモリ。
 *
 * ★失敗は StoreUnavailableError にする。Redis のトークンや URL は文に出さない。
 * ★proxy からも読むので server-only は付けない。
 */
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Redis } from "@upstash/redis";

export class StoreUnavailableError extends Error {
  constructor() {
    super("アカウントの置き場所に届きませんでした");
    this.name = "StoreUnavailableError";
  }
}

export interface Kv {
  mget(keys: string[]): Promise<(string | null)[]>;
  /** 無いときだけ書く。書けたら true */
  setNx(key: string, value: string, ttlSec?: number): Promise<boolean>;
  /** 今の値が expected のときだけ next に置き換える（null は「無い」） */
  cas(key: string, expected: string | null, next: string): Promise<boolean>;
  del(key: string): Promise<void>;
  /** by（既定 1）だけ増やす。初めて作ったときだけ期限を付ける。増やしたあとの値を返す */
  incrWithTtl(key: string, ttlSec: number, by?: number): Promise<number>;
  /** prefix で始まるキー */
  keys(prefix: string): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Upstash Redis
// ---------------------------------------------------------------------------

export const REDIS_TIMEOUT_MS = 2_500;

const CAS_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
if ARGV[1] == '' then
  if cur then return 0 end
elseif cur ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2])
return 1`;

const INCR_SCRIPT = `
local fresh = redis.call('EXISTS', KEYS[1]) == 0
local v = redis.call('INCRBY', KEYS[1], tonumber(ARGV[2]))
if fresh then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end
return v`;

async function guard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch {
    // ★元の例外には URL が入ることがあるので、そのまま外へ出さない
    throw new StoreUnavailableError();
  }
}

export function createRedisKv(config: { url: string; token: string }): Kv {
  const redis = new Redis({
    url: config.url,
    token: config.token,
    retry: false,
    automaticDeserialization: false,
    enableTelemetry: false,
    // ★命令は1つずつ送る（まとめて送ると、1つの失敗の扱いが分かりにくい）
    enableAutoPipelining: false,
    signal: () => AbortSignal.timeout(REDIS_TIMEOUT_MS),
  });
  return {
    mget: (keys) => guard(async () => (keys.length === 0 ? [] : ((await redis.mget(...keys)) as (string | null)[]))),
    setNx: (key, value, ttlSec) =>
      guard(async () => {
        const result = ttlSec ? await redis.set(key, value, { nx: true, ex: ttlSec }) : await redis.set(key, value, { nx: true });
        return result === "OK";
      }),
    cas: (key, expected, next) =>
      guard(async () => Number(await redis.eval(CAS_SCRIPT, [key], [expected ?? "", next])) === 1),
    del: (key) =>
      guard(async () => {
        await redis.del(key);
      }),
    incrWithTtl: (key, ttlSec, by = 1) =>
      guard(async () => Number(await redis.eval(INCR_SCRIPT, [key], [String(ttlSec), String(by)]))),
    keys: (prefix) =>
      guard(async () => {
        const found: string[] = [];
        let cursor = "0";
        // ★アカウントは20件までなので、数回で終わる
        for (let i = 0; i < 50; i += 1) {
          const [next, batch] = (await redis.scan(cursor, { match: `${prefix}*`, count: 100 })) as [string, string[]];
          found.push(...batch);
          cursor = String(next);
          if (cursor === "0") break;
        }
        return [...new Set(found)];
      }),
  };
}

// ---------------------------------------------------------------------------
// メモリ（テスト）とファイル（手元の開発）
// ---------------------------------------------------------------------------

interface Entry {
  value: string;
  /** 期限（ミリ秒）。無ければ null */
  expiresAt: number | null;
}

type Table = Record<string, Entry>;

/**
 * 同じ動きを、表の読み書きの形で作る（メモリとファイルで共有）。
 * ★読むだけのときは書き戻さない。書くときは lock で囲む（proxy と API のルートは別の束なので、
 *   同じファイルを別々に読み書きする。囲まないと、片方の書き込みがもう片方の古い表で消える）。
 */
function createTableKv(
  load: () => Promise<Table>,
  save: (table: Table) => Promise<void>,
  now: () => number,
  lock: <T>(run: () => Promise<T>) => Promise<T> = (run) => run(),
): Kv {
  const live = (table: Table, key: string) => {
    const entry = table[key];
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= now()) return null;
    return entry;
  };
  // ★同じ束の中でも1つずつ順に行う
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: (table: Table) => T | Promise<T>, write: boolean): Promise<T> => {
    const next = queue.then(() =>
      lock(async () => {
        const table = await load();
        const result = await run(table);
        if (write) await save(table);
        return result;
      }),
    );
    queue = next.catch(() => undefined);
    return next;
  };
  return {
    mget: (keys) => serial((t) => keys.map((k) => live(t, k)?.value ?? null), false),
    setNx: (key, value, ttlSec) =>
      serial((t) => {
        if (live(t, key)) return false;
        t[key] = { value, expiresAt: ttlSec ? now() + ttlSec * 1000 : null };
        return true;
      }, true),
    cas: (key, expected, next) =>
      serial((t) => {
        const cur = live(t, key)?.value ?? null;
        if (cur !== expected) return false;
        t[key] = { value: next, expiresAt: null };
        return true;
      }, true),
    del: (key) =>
      serial((t) => {
        delete t[key];
      }, true),
    incrWithTtl: (key, ttlSec, by = 1) =>
      serial((t) => {
        const cur = live(t, key);
        const value = (cur ? Number(cur.value) : 0) + by;
        t[key] = { value: String(value), expiresAt: cur ? cur.expiresAt : now() + ttlSec * 1000 };
        return value;
      }, true),
    keys: (prefix) => serial((t) => Object.keys(t).filter((k) => k.startsWith(prefix) && live(t, k)), false),
  };
}

export function createMemoryKv(now: () => number = Date.now): Kv {
  const table: Table = {};
  return createTableKv(
    async () => table,
    async () => undefined,
    now,
  );
}

/** ファイルの lock（別の束・別のプロセスと順番を守る）。古い lock（5秒）は捨てる */
async function withFileLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.close();
      break;
    } catch {
      try {
        if (Date.now() - (await stat(lockPath)).mtimeMs > 5_000) await unlink(lockPath).catch(() => undefined);
      } catch {
        // lock が消えたところ
      }
      if (Date.now() - started > 5_000) throw new StoreUnavailableError();
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  try {
    return await run();
  } finally {
    await unlink(lockPath).catch(() => undefined);
  }
}

/** 手元の開発用（.cache は git にも Vercel にも入れない） */
export function createFileKv(path: string, now: () => number = Date.now): Kv {
  return createTableKv(
    async () => {
      try {
        return JSON.parse(await readFile(path, "utf8")) as Table;
      } catch {
        return {};
      }
    },
    async (table) => {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      await writeFile(tmp, JSON.stringify(table), { mode: 0o600 });
      await rename(tmp, path);
    },
    now,
    (run) => withFileLock(path, run),
  );
}
