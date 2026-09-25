/**
 * アカウントの読み書き（Kv の上）。★置くのはアカウントの情報だけ（顧客データは置かない）。
 *
 * - 書き換えは compare-and-set。本人のパスワード変更が、同じときの管理者の停止を上書きしないように。
 * - ログインの回数は、打ち込まれた ID・IP をそのまま残さない（keyedHash でキー名にする）。
 *   ★照合する前に数える（reserveAttempt）。読んでから数えると、同時に送られた分が上限を超えて照合される。
 */
import type { Kv } from "@/lib/account/kv";
import { type AccountRecord, parseAccountRecord } from "@/lib/account/record";

export const ACCOUNT_PREFIX = "folio:acct:";
export const KEYS = {
  account: (id: string) => `${ACCOUNT_PREFIX}${id}`,
  failId: (hash: string) => `folio:fail:id:${hash}`,
  failIp: (hash: string) => `folio:fail:ip:${hash}`,
  boot: (hash: string) => `folio:boot:${hash}`,
  /** 楽楽精算の自動ログインの状態（lib/rakuraku/credential-state.ts と同じキー。★folio:acct: で始めない＝一覧に混ざらない） */
  rakuraku: (id: string) => `folio:rk:${id}`,
};

/** 失敗を数える長さ（15分） */
export const FAIL_TTL_SEC = 15 * 60;
/** 同じ ID で5回、同じ場所（IP）から30回試したら、15分止める（正しく入れたら ID の分は数え直す） */
export const FAIL_MAX_ID = 5;
export const FAIL_MAX_IP = 30;
/** アカウントの上限 */
export const ACCOUNT_LIMIT = 20;

export type UpdateResult = { ok: true; record: AccountRecord } | { ok: false; reason: "missing" | "conflict" };

export interface AccountStore {
  get(id: string): Promise<AccountRecord | null>;
  /**
   * 試す前に1回分を数える（照合する前に数えるので、同時に何回送られても上限を超えて照合しない）。
   * 数えたあとの回数を返す。
   */
  reserveAttempt(keys: string[]): Promise<number[]>;
  /** 数えた1回分を戻す（正しく入れたとき。場所（IP）の数は失敗だけにする） */
  releaseAttempt(key: string): Promise<void>;
  clearFailures(key: string): Promise<void>;
  create(record: AccountRecord): Promise<boolean>;
  /** change が null を返したら書かない */
  update(id: string, change: (current: AccountRecord) => AccountRecord | null): Promise<UpdateResult>;
  /** 無ければ作り、あれば置き換える（最初の管理者だけが使う） */
  upsert(id: string, make: (current: AccountRecord | null) => AccountRecord): Promise<AccountRecord | null>;
  remove(id: string): Promise<void>;
  list(): Promise<AccountRecord[]>;
  /** 最初の管理者のコードを使った印（1回だけ true）。★コードの期限より長く残す */
  markBootstrapUsed(key: string, ttlSec: number): Promise<boolean>;
  /** 印を置いたあとで管理者を書けなかったとき、印を外す（コードを無駄にしない） */
  unmarkBootstrap(key: string): Promise<void>;
}

export function createAccountStore(kv: Kv): AccountStore {
  const read = async (id: string) => {
    const [raw] = await kv.mget([KEYS.account(id)]);
    return { raw, record: parseAccountRecord(raw) };
  };
  return {
    get: async (id) => (await read(id)).record,
    reserveAttempt: async (keys) => {
      const counts: number[] = [];
      for (const key of keys) counts.push(await kv.incrWithTtl(key, FAIL_TTL_SEC));
      return counts;
    },
    releaseAttempt: async (key) => {
      await kv.incrWithTtl(key, FAIL_TTL_SEC, -1);
    },
    clearFailures: (key) => kv.del(key),
    create: (record) => kv.setNx(KEYS.account(record.id), JSON.stringify(record)),
    update: async (id, change) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { raw, record } = await read(id);
        if (!record || raw === null) return { ok: false, reason: "missing" };
        const next = change(record);
        if (!next) return { ok: true, record };
        if (await kv.cas(KEYS.account(id), raw, JSON.stringify(next))) return { ok: true, record: next };
      }
      return { ok: false, reason: "conflict" };
    },
    upsert: async (id, make) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { raw, record } = await read(id);
        const next = make(record);
        if (await kv.cas(KEYS.account(id), raw, JSON.stringify(next))) return next;
      }
      return null;
    },
    // ★楽楽精算の自動ログインの状態も一緒に消す（同じ ID で作り直した人に残さない）
    remove: async (id) => {
      await kv.del(KEYS.rakuraku(id));
      await kv.del(KEYS.account(id));
    },
    list: async () => {
      const keys = (await kv.keys(ACCOUNT_PREFIX)).sort();
      const raws = await kv.mget(keys);
      return raws.map(parseAccountRecord).filter((r): r is AccountRecord => r !== null);
    },
    markBootstrapUsed: (key, ttlSec) => kv.setNx(key, "1", Math.max(60, Math.ceil(ttlSec))),
    unmarkBootstrap: (key) => kv.del(key),
  };
}
