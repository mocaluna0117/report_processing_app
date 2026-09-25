import "server-only";
import { randomBytes } from "node:crypto";
import type { Kv } from "@/lib/account/kv";

/**
 * 楽楽精算へ自動でログインしてよいかの「状態」（2026-09-25）。★秘密は入らない（ID もパスワードも無い）。
 *
 * 置き場所は Folio のアカウントと同じ（本番は Upstash Redis `folio:rk:<Folio の ID>`、手元はメモリ）。
 * どのタブ・どのサーバーから来ても同じ決まりを守るために、ここで持つ。
 *
 * 決まり（楽楽精算は続けて失敗するとアカウントがロックされるため）:
 * 1. 自動のログインは、前にログインしたときに成功していた（failures === 0）ときだけ。
 *    1回でも失敗したら、アカウントの画面で入れ直して確かめるまで、自動ではログインしない。
 * 2. 控えの版（ver）が、ここの版と違えば使わない（ほかの画面で入れ直した・消した）。
 * 3. 同じアカウントのログインは同時に1つだけ（inFlight）。
 * 4. パスワードを打つ**前に**「送った」と書く。打つ前の失敗（つながらない・欄が無い・混み合い）は数えない。
 *    送ったまま止まったもの（150秒）は失敗として数える（成功したか分からないものは、失敗の側に倒す）。
 * 5. 失敗のあと60秒は、どのログインも受け付けない。
 * 6. 自動のログインは1アカウント1日20回まで（成功も数える。ぐるぐる回るのを止める）。
 * 7. 「確かめて保存」は、3回続けて失敗したら1時間待つ。
 * ★判断は必ず CAS の中で行う。置き場所に届かなければログインしない（呼ぶ側に StoreUnavailableError が届く）。
 */

export const CREDENTIAL_KEYS = {
  state: (folioId: string) => `folio:rk:${folioId}`,
  day: (folioId: string, day: string) => `folio:rk-day:${folioId}:${day}`,
};

export const CREDENTIAL_LIMITS = {
  failCooldownMs: 60_000,
  inFlightStaleMs: 150_000,
  autoPerDay: 20,
  verifyFailLimit: 3,
  verifyLockMs: 60 * 60_000,
} as const;

export type FailReason = "LOGIN_FAILED" | "LOGIN_UNCONFIRMED" | "UNKNOWN_OUTCOME";
export type LoginPurpose = "verify" | "auto";

export interface InFlight {
  id: string;
  /** 始めた時刻。送ったあとは送った時刻 */
  at: number;
  phase: "pre" | "submitted";
  purpose: LoginPurpose;
}

export interface CredentialState {
  v: 1;
  /** いま使える登録の版。null は未登録・消した */
  ver: string | null;
  /** 続けて失敗した回数（成功で 0 に戻る） */
  failures: number;
  lastOkAt: number | null;
  lastFailAt: number | null;
  lastFailReason: FailReason | null;
  inFlight: InFlight | null;
}

export const EMPTY_STATE: CredentialState = {
  v: 1,
  ver: null,
  failures: 0,
  lastOkAt: null,
  lastFailAt: null,
  lastFailReason: null,
  inFlight: null,
};

const isTime = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const REASONS: readonly FailReason[] = ["LOGIN_FAILED", "LOGIN_UNCONFIRMED", "UNKNOWN_OUTCOME"];

/**
 * 置き場所の中身を読む。★壊れていたら「未登録・失敗1回」とみなす（自動のログインをしない側に倒す）。
 */
export function parseCredentialState(raw: string | null): CredentialState {
  if (raw === null) return EMPTY_STATE;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ...EMPTY_STATE, failures: 1 };
  }
  const flight = v.inFlight as Record<string, unknown> | null | undefined;
  const inFlight: InFlight | null =
    flight &&
    typeof flight === "object" &&
    typeof flight.id === "string" &&
    isTime(flight.at) &&
    (flight.phase === "pre" || flight.phase === "submitted") &&
    (flight.purpose === "verify" || flight.purpose === "auto")
      ? { id: flight.id, at: flight.at, phase: flight.phase, purpose: flight.purpose }
      : null;
  if (
    v.v !== 1 ||
    (v.ver !== null && typeof v.ver !== "string") ||
    typeof v.failures !== "number" ||
    !Number.isSafeInteger(v.failures) ||
    v.failures < 0
  ) {
    return { ...EMPTY_STATE, failures: 1 };
  }
  return {
    v: 1,
    ver: v.ver as string | null,
    failures: v.failures,
    lastOkAt: isTime(v.lastOkAt) ? v.lastOkAt : null,
    lastFailAt: isTime(v.lastFailAt) ? v.lastFailAt : null,
    lastFailReason: REASONS.includes(v.lastFailReason as FailReason) ? (v.lastFailReason as FailReason) : null,
    inFlight,
  };
}

/** 途中で止まったままの試しを片付ける。★送ったあとで止まったものは、失敗として数える */
export function settleStale(state: CredentialState, now: number): CredentialState {
  const flight = state.inFlight;
  if (!flight || now - flight.at < CREDENTIAL_LIMITS.inFlightStaleMs) return state;
  if (flight.phase === "pre") return { ...state, inFlight: null };
  return { ...state, inFlight: null, failures: state.failures + 1, lastFailAt: now, lastFailReason: "UNKNOWN_OUTCOME" };
}

export type Refusal =
  | "CREDENTIAL_MISSING"
  | "CREDENTIAL_STALE"
  | "CREDENTIAL_REJECTED"
  | "LOGIN_IN_PROGRESS"
  | "LOGIN_COOLDOWN"
  | "LOGIN_LIMIT";

export type StartDecision = { ok: true } | { ok: false; code: Refusal; waitMs?: number };

/** 始めてよいか（純関数）。state は settleStale を通したもの */
export function decideStart(
  state: CredentialState,
  input: { purpose: LoginPurpose; ver: string | null; now: number },
): StartDecision {
  const { now } = input;
  if (state.inFlight) return { ok: false, code: "LOGIN_IN_PROGRESS" };
  if (state.lastFailAt !== null && now - state.lastFailAt < CREDENTIAL_LIMITS.failCooldownMs) {
    return { ok: false, code: "LOGIN_COOLDOWN", waitMs: CREDENTIAL_LIMITS.failCooldownMs - (now - state.lastFailAt) };
  }
  if (input.purpose === "auto") {
    if (state.ver === null) return { ok: false, code: "CREDENTIAL_MISSING" };
    if (input.ver !== state.ver) return { ok: false, code: "CREDENTIAL_STALE" };
    if (state.failures > 0) return { ok: false, code: "CREDENTIAL_REJECTED" };
    return { ok: true };
  }
  if (
    state.failures >= CREDENTIAL_LIMITS.verifyFailLimit &&
    state.lastFailAt !== null &&
    now - state.lastFailAt < CREDENTIAL_LIMITS.verifyLockMs
  ) {
    return { ok: false, code: "LOGIN_LIMIT", waitMs: CREDENTIAL_LIMITS.verifyLockMs - (now - state.lastFailAt) };
  }
  return { ok: true };
}

export type LoginOutcome = { kind: "ok"; newVer?: string } | { kind: "failed"; reason: FailReason } | { kind: "not-sent" };

/** 試しの結果を書き込む形にする（純関数） */
export function applyOutcome(state: CredentialState, attemptId: string, outcome: LoginOutcome, now: number): CredentialState {
  const base = state.inFlight?.id === attemptId ? { ...state, inFlight: null } : state;
  if (outcome.kind === "not-sent") return base;
  if (outcome.kind === "failed") {
    return { ...base, failures: base.failures + 1, lastFailAt: now, lastFailReason: outcome.reason };
  }
  return {
    ...base,
    ver: outcome.newVer ?? base.ver,
    failures: 0,
    lastOkAt: now,
    lastFailAt: null,
    lastFailReason: null,
  };
}

/** 日本時間の日付（1日の回数を数える単位） */
export function dayKeyOf(now: number): string {
  return new Date(now + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");
}

export type StartResult = { ok: true; attemptId: string } | { ok: false; code: Refusal; waitMs?: number };

export interface CredentialStateStore {
  get(folioId: string, now: number): Promise<CredentialState>;
  start(folioId: string, input: { purpose: LoginPurpose; ver: string | null; now: number }): Promise<StartResult>;
  /** パスワードを打つ直前に呼ぶ。false なら打たない（登録が変わった・ほかの試しに替わった） */
  markSubmitted(folioId: string, attemptId: string, now: number): Promise<boolean>;
  finish(folioId: string, attemptId: string, outcome: LoginOutcome, now: number): Promise<CredentialState | null>;
  /** 登録を消す（版を無くす）。★失敗の回数は残す（消して入れ直しても、上限をすり抜けられないように） */
  unregister(folioId: string): Promise<void>;
  /** アカウントを消すとき（何も残さない） */
  remove(folioId: string): Promise<void>;
}

const CAS_TRIES = 3;
const DAY_TTL_SEC = 2 * 24 * 3600;

export function createCredentialStateStore(kv: Kv): CredentialStateStore {
  const read = async (folioId: string) => {
    const [raw] = await kv.mget([CREDENTIAL_KEYS.state(folioId)]);
    return { raw, state: parseCredentialState(raw) };
  };
  const write = (folioId: string, raw: string | null, next: CredentialState) =>
    kv.cas(CREDENTIAL_KEYS.state(folioId), raw, JSON.stringify(next));

  return {
    get: async (folioId, now) => settleStale((await read(folioId)).state, now),

    start: async (folioId, input) => {
      for (let attempt = 0; attempt < CAS_TRIES; attempt += 1) {
        const { raw, state: stored } = await read(folioId);
        const state = settleStale(stored, input.now);
        const decision = decideStart(state, input);
        if (!decision.ok) {
          // 止まったままの試しは、断るときでも片付けておく（失敗の数に入れる）
          if (state !== stored) await write(folioId, raw, state).catch(() => false);
          return decision;
        }
        const attemptId = randomBytes(9).toString("base64url");
        const next: CredentialState = { ...state, inFlight: { id: attemptId, at: input.now, phase: "pre", purpose: input.purpose } };
        if (!(await write(folioId, raw, next))) continue;
        if (input.purpose === "auto") {
          const count = await kv.incrWithTtl(CREDENTIAL_KEYS.day(folioId, dayKeyOf(input.now)), DAY_TTL_SEC);
          if (count > CREDENTIAL_LIMITS.autoPerDay) {
            await finishWith(folioId, attemptId, { kind: "not-sent" }, input.now);
            return { ok: false, code: "LOGIN_LIMIT" };
          }
        }
        return { ok: true, attemptId };
      }
      return { ok: false, code: "LOGIN_IN_PROGRESS" };
    },

    markSubmitted: async (folioId, attemptId, now) => {
      for (let attempt = 0; attempt < CAS_TRIES; attempt += 1) {
        const { raw, state } = await read(folioId);
        if (state.inFlight?.id !== attemptId || state.inFlight.phase !== "pre") return false;
        const next: CredentialState = { ...state, inFlight: { ...state.inFlight, phase: "submitted", at: now } };
        if (await write(folioId, raw, next)) return true;
      }
      return false;
    },

    finish: (folioId, attemptId, outcome, now) => finishWith(folioId, attemptId, outcome, now),

    unregister: async (folioId) => {
      for (let attempt = 0; attempt < CAS_TRIES; attempt += 1) {
        const { raw, state } = await read(folioId);
        if (raw === null || state.ver === null) return;
        if (await write(folioId, raw, { ...state, ver: null })) return;
      }
    },

    remove: (folioId) => kv.del(CREDENTIAL_KEYS.state(folioId)),
  };

  async function finishWith(folioId: string, attemptId: string, outcome: LoginOutcome, now: number): Promise<CredentialState | null> {
    for (let attempt = 0; attempt < CAS_TRIES; attempt += 1) {
      const { raw, state } = await read(folioId);
      const next = applyOutcome(state, attemptId, outcome, now);
      if (await write(folioId, raw, next)) return next;
    }
    return null;
  }
}
