/**
 * 部門の読み込みの規則（画面から切り離した純関数）。
 *
 * ★一時的な失敗は**1回だけ**自動でやり直す。楽楽精算の**ログインは絶対にやり直さない**（続けて失敗すると
 *   アカウントがロックされる）が、部門の読み込みはIDもパスワードも送らない（封じた状態を使って開くだけ）ので、
 *   やり直してもロックされない。
 * ★やり直しは1回だけ。回数を増やすと、混み合っているときに自分で待ち行列を伸ばしてしまう。
 * ★「プルダウンが無い」と「プルダウンはあるが選択肢が空」を必ず分ける。前者は部門を指定せずに取得してよいが、
 *   後者は取得を始めた時点で止まる（lib/rakuraku/navigation.ts の applyDepartment）。混ぜると、押しても
 *   必ず失敗するボタンを出すことになる。
 */
import type { DepartmentOption } from "@/lib/rakuraku/protocol";
import type { StatusPayload } from "@/lib/tenmatsu/client";
import { type ApiCode, type RakurakuApi, RakurakuApiError } from "./server-api";

/** 最初の1回＋やり直し1回 */
export const DEPT_RETRY_ATTEMPTS = 2;
export const DEPT_RETRY_WAIT_MS = 2_000;

/** プルダウンはあるのに選択肢が空だったときの文（このまま取得しても止まるので、逃げ道は出さない） */
export const DEPT_OPTIONS_EMPTY_TEXT =
  "このアカウントでは部門を選べません（部門の選択肢が空でした）。楽楽精算の管理者に権限をご確認ください";

/** ★やり直しても同じ結果になるか、やり直すと害があるもの */
const NEVER_RETRY: readonly ApiCode[] = [
  "SESSION_EXPIRED",
  "DEPT_SELECT_MISSING",
  "UNAUTHORIZED",
  "DISABLED",
  "PREVIEW_BLOCKED",
  "FORBIDDEN_ORIGIN",
  "BAD_REQUEST",
  "NO_PASSWORD",
  "LOGIN_FAILED",
  "LOGIN_COOLDOWN",
  "LOGIN_FORM_NOT_FOUND",
];

/** 一時的な失敗（楽楽精算に触る前か、触っても何も送っていないもの） */
const RETRY_CODES: readonly ApiCode[] = [
  "INTERNAL",
  "BROWSER_BUSY",
  "BROWSER_LAUNCH_FAILED",
  "TENANT_UNREACHABLE",
  "NETWORK",
  "STREAM_CUT",
];

export function isRetryableDeptError(error: unknown): boolean {
  if (!(error instanceof RakurakuApiError)) return false;
  if (NEVER_RETRY.includes(error.code)) return false;
  return error.retryable || RETRY_CODES.includes(error.code);
}

export type DepartmentsOutcome =
  /** 選べる部門が読めた */
  | {
      kind: "list";
      departments: DepartmentOption[];
      current: DepartmentOption | null;
      sessionToken: string;
      expiresAt: number | null;
    }
  /** プルダウンそのものが無いアカウント。部門を指定せずに取得してよい */
  | { kind: "none"; sessionToken: string | null; expiresAt: number | null }
  /** プルダウンはあるのに選択肢が空。★取得しても止まるので、逃げ道は出さない */
  | { kind: "empty"; sessionToken: string; expiresAt: number | null }
  | { kind: "failed"; code: ApiCode; message: string; sessionLost: boolean; attempts: number };

export interface ReadDepartmentsDeps {
  api: Pick<RakurakuApi, "departments">;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
  attempts?: number;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 部門を読む。一時的な失敗なら1回だけ待ってやり直す */
export async function readDepartments(
  deps: ReadDepartmentsDeps,
  sessionToken: string,
): Promise<DepartmentsOutcome> {
  const attempts = deps.attempts ?? DEPT_RETRY_ATTEMPTS;
  const waitMs = deps.waitMs ?? DEPT_RETRY_WAIT_MS;
  const sleep = deps.sleep ?? wait;

  for (let attempt = 1; ; attempt++) {
    try {
      const res = await deps.api.departments(sessionToken);
      if (!res.hasDepartmentSelect) {
        return { kind: "none", sessionToken: res.sessionToken, expiresAt: res.expiresAt };
      }
      if (res.departments.length === 0) {
        return { kind: "empty", sessionToken: res.sessionToken, expiresAt: res.expiresAt };
      }
      return {
        kind: "list",
        departments: res.departments,
        current: res.current,
        sessionToken: res.sessionToken,
        expiresAt: res.expiresAt,
      };
    } catch (e) {
      // 古いサーバーは「プルダウンが無い」を失敗として返す。いまは正常な状態として扱う
      if (e instanceof RakurakuApiError && e.code === "DEPT_SELECT_MISSING") {
        return { kind: "none", sessionToken: null, expiresAt: null };
      }
      if (attempt >= attempts || !isRetryableDeptError(e)) {
        const error = e instanceof RakurakuApiError ? e : null;
        return {
          kind: "failed",
          code: error?.code ?? "INTERNAL",
          message: e instanceof Error ? e.message : String(e),
          sessionLost: error?.sessionLost ?? false,
          attempts: attempt,
        };
      }
      await sleep(waitMs);
    }
  }
}

/** 前に選んだ部門 → 楽楽精算がいま選んでいる部門 → 先頭、の順に選ぶ */
export function pickDepartment(
  list: readonly DepartmentOption[],
  savedCode: string | null,
  currentCode: string | null,
): DepartmentOption | null {
  return (
    list.find((d) => d.code === savedCode) ?? list.find((d) => d.code === currentCode) ?? list[0] ?? null
  );
}

/** 読めなかったときに画面へ出す1行（文面は今までと同じ。出す場所だけ変える） */
export function departmentErrorText(outcome: Extract<DepartmentsOutcome, { kind: "failed" }>): string {
  return `部門を読み込めませんでした (${outcome.message})`;
}

/**
 * 取得が「部門を選べない」で止まったときに、画面の部門の選択肢を直すための指示。
 * ★「部門を指定せずに取得」を選んだ人が、実は部門を選べるアカウントだったときの戻り道。
 */
export function departmentFixFromStatus(
  status: StatusPayload,
): { departments: DepartmentOption[]; deptCode: string | null } | null {
  if (status.state !== "error" || status.error_code !== "DEPT_NOT_AVAILABLE") return null;
  const departments = status.error_departments ?? [];
  if (departments.length === 0) return null;
  return { departments, deptCode: departments[0]?.code ?? null };
}
