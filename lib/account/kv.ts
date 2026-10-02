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
import { datePrefixOf } from "@/lib/usage/metrics";

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
  /** ハッシュの項目に足し、ほかの項目を大きいほうにそろえる（利用状況。1命令で行う） */
  hincr(key: string, change: HashChange): Promise<void>;
  /** ハッシュをまとめて読む（無いキーは null） */
  hgetallMany(keys: string[]): Promise<(Record<string, string> | null)[]>;
}

export interface HashChange {
  /** 足す数（項目 → 数） */
  add: Record<string, number>;
  /** 今より大きければ置き換える項目（最後に使った時刻など。★あとから古い時刻が届いても巻き戻さない） */
  max: Record<string, number>;
  /**
   * その日の印の項目（例「20261002:_」）。★これが初めて置かれたときだけ、
   * 頭が8桁の日付で pruneBefore より前の項目を消す（毎回すべての項目を見ない）
   */
  dayMark: string;
  /** 「YYYYMMDD」。これより前の日付の項目を消す */
  pruneBefore: string;
  /** キーの期限（書くたびに延ばし直す） */
  ttlSec: number;
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

const HINCR_SCRIPT = `
local key = KEYS[1]
local i = 1
local n = tonumber(ARGV[i]); i = i + 1
for _ = 1, n do
  redis.call('HINCRBY', key, ARGV[i], tonumber(ARGV[i + 1])); i = i + 2
end
local m = tonumber(ARGV[i]); i = i + 1
for _ = 1, m do
  local cur = tonumber(redis.call('HGET', key, ARGV[i]))
  if not cur or tonumber(ARGV[i + 1]) > cur then redis.call('HSET', key, ARGV[i], ARGV[i + 1]) end
  i = i + 2
end
local mark, before, ttl = ARGV[i], ARGV[i + 1], tonumber(ARGV[i + 2])
if redis.call('HSETNX', key, mark, '1') == 1 then
  for _, f in ipairs(redis.call('HKEYS', key)) do
    local d = string.match(f, '^(%d%d%d%d%d%d%d%d):')
    if d and d < before then redis.call('HDEL', key, f) end
  end
end
redis.call('EXPIRE', key, ttl)
return 1`;

const HGETALL_MANY_SCRIPT = `
local out = {}
for i, k in ipairs(KEYS) do out[i] = redis.call('HGETALL', k) end
return out`;

/** HGETALL の [項目, 値, 項目, 値…] を表にする（空なら null） */
function pairsToRecord(flat: unknown): Record<string, string> | null {
  if (!Array.isArray(flat) || flat.length === 0) return null;
  const record: Record<string, string> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) record[String(flat[i])] = String(flat[i + 1]);
  return record;
}

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
    hincr: (key, change) =>
      guard(async () => {
        const add = Object.entries(change.add).filter(([, by]) => Number.isSafeInteger(by) && by !== 0);
        const max = Object.entries(change.max).filter(([, v]) => Number.isSafeInteger(v));
        await redis.eval(
          HINCR_SCRIPT,
          [key],
          [
            String(add.length),
            ...add.flatMap(([field, by]) => [field, String(by)]),
            String(max.length),
            ...max.flatMap(([field, v]) => [field, String(v)]),
            change.dayMark,
            change.pruneBefore,
            String(change.ttlSec),
          ],
        );
      }),
    hgetallMany: (keys) =>
      guard(async () => {
        if (keys.length === 0) return [];
        const result = (await redis.eval(HGETALL_MANY_SCRIPT, keys, [])) as unknown;
        const rows = Array.isArray(result) ? result : [];
        return keys.map((_, i) => pairsToRecord(rows[i]));
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
    // ★ハッシュは JSON の文字として持つ（Redis と同じ動きになるよう、期限は書くたびに延ばし直す）
    hincr: (key, change) =>
      serial((t) => {
        const cur = live(t, key);
        const hash = cur ? (JSON.parse(cur.value) as Record<string, string>) : {};
        for (const [field, by] of Object.entries(change.add)) {
          if (Number.isSafeInteger(by) && by !== 0) hash[field] = String(Number(hash[field] ?? 0) + by);
        }
        for (const [field, v] of Object.entries(change.max)) {
          if (Number.isSafeInteger(v) && !(Number(hash[field]) >= v)) hash[field] = String(v);
        }
        if (!(change.dayMark in hash)) {
          hash[change.dayMark] = "1";
          for (const field of Object.keys(hash)) {
            const day = datePrefixOf(field);
            if (day !== null && day < change.pruneBefore) delete hash[field];
          }
        }
        t[key] = { value: JSON.stringify(hash), expiresAt: now() + change.ttlSec * 1000 };
      }, true),
    hgetallMany: (keys) =>
      serial((t) => keys.map((k) => {
        const entry = live(t, k);
        const hash = entry ? (JSON.parse(entry.value) as Record<string, string>) : null;
        return hash && Object.keys(hash).length > 0 ? hash : null;
      }), false),
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
