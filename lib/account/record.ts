/**
 * Redis に置くアカウントの形と検査。純関数。
 * ★置くのはアカウントの情報だけ（顧客データは置かない）。パスワードはハッシュだけ。
 * ★Redis の中身は信じずに、必ず parseAccountRecord を通してから使う。
 */
export type AccountRole = "admin" | "member";

export interface AccountRecord {
  v: 1;
  /** ログインID（揃えたもの） */
  id: string;
  /** 右上に出す名前 */
  name: string;
  role: AccountRole;
  /** scrypt のハッシュ（lib/account/password.ts） */
  hash: string;
  /** 仮のパスワードのまま（自分のパスワードを決めるまで使えない） */
  mustChange: boolean;
  /** 仮のパスワードの期限（ミリ秒）。仮でなければ null */
  tempExpiresAt: number | null;
  disabled: boolean;
  /** 版（ミリ秒）。作成・パスワード変更・仮パスワード発行・停止で変わり、他の端末のログインが切れる */
  sv: number;
  createdAt: number;
  passwordChangedAt: number | null;
}

const LOGIN_ID = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

export function parseAccountRecord(raw: unknown): AccountRecord | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (r.v !== 1) return null;
  if (typeof r.id !== "string" || !LOGIN_ID.test(r.id)) return null;
  if (typeof r.name !== "string" || r.name.length === 0 || r.name.length > 40) return null;
  if (r.role !== "admin" && r.role !== "member") return null;
  if (typeof r.hash !== "string" || !r.hash.startsWith("scrypt$")) return null;
  if (typeof r.mustChange !== "boolean" || typeof r.disabled !== "boolean") return null;
  if (r.tempExpiresAt !== null && !isTime(r.tempExpiresAt)) return null;
  if (!isTime(r.sv) || !isTime(r.createdAt)) return null;
  if (r.passwordChangedAt !== null && !isTime(r.passwordChangedAt)) return null;
  return {
    v: 1,
    id: r.id,
    name: r.name,
    role: r.role,
    hash: r.hash,
    mustChange: r.mustChange,
    tempExpiresAt: r.tempExpiresAt as number | null,
    disabled: r.disabled,
    sv: r.sv,
    createdAt: r.createdAt,
    passwordChangedAt: r.passwordChangedAt as number | null,
  };
}

/** 管理の画面に出す形（★ハッシュは出さない） */
export interface AccountSummary {
  id: string;
  name: string;
  role: AccountRole;
  mustChange: boolean;
  tempExpiresAt: number | null;
  disabled: boolean;
  createdAt: number;
  passwordChangedAt: number | null;
}

export function summarizeAccount(record: AccountRecord): AccountSummary {
  return {
    id: record.id,
    name: record.name,
    role: record.role,
    mustChange: record.mustChange,
    tempExpiresAt: record.tempExpiresAt,
    disabled: record.disabled,
    createdAt: record.createdAt,
    passwordChangedAt: record.passwordChangedAt,
  };
}
