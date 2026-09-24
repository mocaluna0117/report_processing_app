/**
 * アカウントの読み書き（Kv の上）。★置くのはアカウントの情報だけ（顧客データは置かない）。
 *
 * - 書き換えは compare-and-set。本人のパスワード変更が、同じときの管理者の停止を上書きしないように。
 * - ログインの失敗の回数は、打ち込まれた ID・IP をそのまま残さない（keyedHash でキー名にする）。
 */
import type { Kv } from "@/lib/account/kv";
import { type AccountRecord, parseAccountRecord } from "@/lib/account/record";

export const ACCOUNT_PREFIX = "folio:acct:";
export const KEYS = {
  account: (id: string) => `${ACCOUNT_PREFIX}${id}`,
  failId: (hash: string) => `folio:fail:id:${hash}`,
  failIp: (hash: string) => `folio:fail:ip:${hash}`,
  boot: (hash: string) => `folio:boot:${hash}`,
};

/** 失敗を数える長さ（15分） */
export const FAIL_TTL_SEC = 15 * 60;
/** 同じ ID で5回、同じ場所（IP）から30回違えたら、15分止める */
export const FAIL_MAX_ID = 5;
export const FAIL_MAX_IP = 30;
/** アカウントの上限 */
export const ACCOUNT_LIMIT = 20;

export type UpdateResult = { ok: true; record: AccountRecord } | { ok: false; reason: "missing" | "conflict" };

export interface AccountStore {
  get(id: string): Promise<AccountRecord | null>;
  /** ログインのときに1回で読む（アカウント・ID の失敗回数・IP の失敗回数） */
  loginSnapshot(id: string, failIdKey: string, failIpKey: string): Promise<{
    record: AccountRecord | null;
    idFails: number;
    ipFails: number;
  }>;
  recordFailure(keys: string[]): Promise<void>;
  clearFailures(key: string): Promise<void>;
  create(record: AccountRecord): Promise<boolean>;
  /** change が null を返したら書かない */
  update(id: string, change: (current: AccountRecord) => AccountRecord | null): Promise<UpdateResult>;
  /** 無ければ作り、あれば置き換える（最初の管理者だけが使う） */
  upsert(id: string, make: (current: AccountRecord | null) => AccountRecord): Promise<AccountRecord | null>;
  remove(id: string): Promise<void>;
  list(): Promise<AccountRecord[]>;
  /** 最初の管理者のコードを使った印（1回だけ true） */
  markBootstrapUsed(key: string): Promise<boolean>;
}

const count = (raw: string | null) => {
  const n = Number(raw ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export function createAccountStore(kv: Kv): AccountStore {
  const read = async (id: string) => {
    const [raw] = await kv.mget([KEYS.account(id)]);
    return { raw, record: parseAccountRecord(raw) };
  };
  return {
    get: async (id) => (await read(id)).record,
    loginSnapshot: async (id, failIdKey, failIpKey) => {
      const [raw, idFails, ipFails] = await kv.mget([KEYS.account(id), failIdKey, failIpKey]);
      return { record: parseAccountRecord(raw), idFails: count(idFails), ipFails: count(ipFails) };
    },
    recordFailure: async (keys) => {
      for (const key of keys) await kv.incrWithTtl(key, FAIL_TTL_SEC);
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
    remove: (id) => kv.del(KEYS.account(id)),
    list: async () => {
      const keys = (await kv.keys(ACCOUNT_PREFIX)).sort();
      const raws = await kv.mget(keys);
      return raws.map(parseAccountRecord).filter((r): r is AccountRecord => r !== null);
    },
    markBootstrapUsed: (key) => kv.setNx(key, "1", 30 * 24 * 60 * 60),
  };
}
