import "server-only";

/**
 * アカウントの管理（GET|POST /api/accounts）。管理者だけ。
 *
 * ★毎回 Redis で「本人が今も管理者で、止められていない」ことを確かめる（印の中身だけを信じない）。
 * ★仮のパスワードは、作ったときの返事にだけ入れる（ほかには残さない）。ハッシュは返さない。
 * ★自分自身は止めない・消さない・仮パスワードにしない（管理者がいなくなるのを防ぐ）。
 */
import type { AuthConfig } from "@/lib/account/config";
import { StoreUnavailableError } from "@/lib/account/kv";
import { type OriginInput, isSameOriginPost } from "@/lib/account/origin";
import { canonicalTemp, generateTempPassword, hashPassword, type ScryptParams } from "@/lib/account/password";
import { displayNameProblem, loginIdProblem, normalizeLoginId } from "@/lib/account/policy";
import { type AccountRecord, type AccountSummary, summarizeAccount } from "@/lib/account/record";
import { ACCOUNT_LIMIT, type AccountStore, KEYS } from "@/lib/account/store";
import { type SessionClaims, keyedHash } from "@/lib/account/token";

/** 仮のパスワードの期限（7日） */
export const TEMP_VALID_MS = 7 * 24 * 60 * 60 * 1000;

export type AdminAction =
  | { action: "create"; id: string; name: string }
  | { action: "reset"; id: string }
  | { action: "disable"; id: string }
  | { action: "enable"; id: string }
  | { action: "delete"; id: string };

export interface AdminResponse {
  ok: boolean;
  message: string;
  accounts?: AccountSummary[];
  /** 作った・発行した仮のパスワード（この返事だけ） */
  tempPassword?: string;
  tempFor?: string;
}

/** 受け取った操作を検査する。純関数 */
export function planAdminAction(raw: unknown, selfId: string): { ok: true; plan: AdminAction } | { ok: false; message: string } {
  if (!raw || typeof raw !== "object") return { ok: false, message: "操作を読めませんでした" };
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? normalizeLoginId(r.id) : "";
  const idProblem = loginIdProblem(id);
  if (idProblem) return { ok: false, message: idProblem };
  switch (r.action) {
    case "create": {
      const name = typeof r.name === "string" ? r.name.trim() : "";
      const nameProblem = displayNameProblem(name);
      if (nameProblem) return { ok: false, message: nameProblem };
      return { ok: true, plan: { action: "create", id, name } };
    }
    case "reset":
    case "disable":
    case "enable":
    case "delete":
      if (id === selfId) return { ok: false, message: "自分自身には使えません（自分のパスワードは上の欄で変えてください）" };
      return { ok: true, plan: { action: r.action, id } };
    default:
      return { ok: false, message: "操作を読めませんでした" };
  }
}

export interface AdminInput {
  config: Extract<AuthConfig, { kind: "accounts" }>;
  method: "GET" | "POST";
  origin: OriginInput;
  claims: SessionClaims | null;
  body: unknown;
  nowMs: number;
}

const reply = (status: number, body: AdminResponse) => ({ status, body });

async function listAll(store: AccountStore): Promise<AccountSummary[]> {
  return (await store.list()).map(summarizeAccount);
}

export async function handleAccountsRequest(
  input: AdminInput,
  deps: { store: AccountStore; scrypt?: ScryptParams },
): Promise<{ status: number; body: AdminResponse }> {
  if (input.method === "POST" && !isSameOriginPost(input.origin)) {
    return reply(403, { ok: false, message: "別のページからは操作できません" });
  }
  const { claims } = input;
  if (!claims || claims.mc === 1) return reply(401, { ok: false, message: "ログインし直してください" });
  const { store } = deps;
  try {
    const me = await store.get(claims.u);
    if (!me || me.disabled || me.sv !== claims.sv) return reply(401, { ok: false, message: "ログインし直してください" });
    if (me.role !== "admin") return reply(403, { ok: false, message: "管理者だけが使えます" });
    if (input.method === "GET") return reply(200, { ok: true, message: "", accounts: await listAll(store) });

    const planned = planAdminAction(input.body, me.id);
    if (!planned.ok) return reply(400, { ok: false, message: planned.message });
    const plan = planned.plan;
    const now = input.nowMs;

    if (plan.action === "create") {
      if ((await store.list()).length >= ACCOUNT_LIMIT) {
        return reply(400, { ok: false, message: `アカウントは${ACCOUNT_LIMIT}件までです` });
      }
      const temp = generateTempPassword();
      const record: AccountRecord = {
        v: 1,
        id: plan.id,
        name: plan.name,
        role: "member",
        hash: await hashPassword(canonicalTemp(temp), deps.scrypt),
        mustChange: true,
        tempExpiresAt: now + TEMP_VALID_MS,
        disabled: false,
        sv: now,
        createdAt: now,
        passwordChangedAt: null,
      };
      if (!(await store.create(record))) return reply(409, { ok: false, message: "そのログインIDはもう使われています" });
      return reply(200, {
        ok: true,
        message: `「${plan.name}」（${plan.id}）を作りました`,
        accounts: await listAll(store),
        tempPassword: temp,
        tempFor: plan.id,
      });
    }

    if (plan.action === "delete") {
      if (!(await store.get(plan.id))) return reply(404, { ok: false, message: "そのアカウントは見つかりません" });
      await store.remove(plan.id);
      return reply(200, { ok: true, message: `${plan.id} を消しました`, accounts: await listAll(store) });
    }

    let temp: string | undefined;
    const hash = plan.action === "reset" ? await hashPassword(canonicalTemp((temp = generateTempPassword())), deps.scrypt) : null;
    const updated = await store.update(plan.id, (r) => {
      if (plan.action === "reset") return { ...r, hash: hash as string, mustChange: true, tempExpiresAt: now + TEMP_VALID_MS, sv: now };
      if (plan.action === "disable") return r.disabled ? null : { ...r, disabled: true, sv: now };
      return r.disabled ? { ...r, disabled: false } : null;
    });
    if (!updated.ok) {
      return reply(updated.reason === "missing" ? 404 : 409, {
        ok: false,
        message: updated.reason === "missing" ? "そのアカウントは見つかりません" : "同じときに別の変更があったため、やり直してください",
      });
    }
    if (plan.action === "reset") {
      // ★失敗が続いて止まっていても、仮のパスワードですぐ入れるようにする
      await store.clearFailures(KEYS.failId(keyedHash(input.config.secret, "fail-id", plan.id)));
      return reply(200, {
        ok: true,
        message: `${plan.id} の仮のパスワードを発行しました（前のパスワードとログインは使えなくなります）`,
        accounts: await listAll(store),
        tempPassword: temp,
        tempFor: plan.id,
      });
    }
    return reply(200, {
      ok: true,
      message: plan.action === "disable" ? `${plan.id} を止めました（5分以内にログインが切れます）` : `${plan.id} を使えるようにしました`,
      accounts: await listAll(store),
    });
  } catch (e) {
    if (e instanceof StoreUnavailableError) {
      return reply(503, { ok: false, message: "いまアカウントの置き場所に届きません。少し待ってからもう一度押してください" });
    }
    throw e;
  }
}
