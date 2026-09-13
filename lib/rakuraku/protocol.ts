/**
 * ブラウザと Folio のサーバー（`/api/rakuraku/*`）のあいだの約束事。
 *
 * ★両側から import するので、Playwright にも server-only にも依存しない。
 * ★行ごとの JSON（NDJSON）で流す。HTTP の状態は常に 200 で、**成否は最後の行**
 *   （`done` か `error`）で表す。どちらも届かずに終わったら、途中で接続が切れたということ。
 */

export type KindId = "tenmatsu" | "senketsu" | "natsuin";

export function isKindId(value: unknown): value is KindId {
  return value === "tenmatsu" || value === "senketsu" || value === "natsuin";
}

/**
 * 失敗の符号。画面はこの符号で出し分ける。
 *
 * ★ 「権限が無い」と「画面が変わった」を必ず区別する。
 *   現行の Python ツールはここを分けておらず、権限が理由でも
 *   「config.json の list_url を直してください」と案内してしまい、
 *   利用者を誤った対処へ導いていた。
 */
export type RakurakuCode =
  // 入口
  | "DISABLED"
  | "PREVIEW_BLOCKED"
  | "BAD_REQUEST"
  | "FORBIDDEN_ORIGIN"
  | "NO_PASSWORD"
  // ブラウザ
  | "BROWSER_LAUNCH_FAILED"
  | "BROWSER_BUSY"
  | "TENANT_UNREACHABLE"
  // ログイン
  | "LOGIN_FORM_NOT_FOUND"
  | "LOGIN_FAILED"
  | "LOGIN_COOLDOWN"
  | "SESSION_EXPIRED"
  // 部門と権限
  | "DEPT_NOT_AVAILABLE"
  | "DEPT_SELECT_MISSING"
  | "DEPT_SWITCH_FAILED"
  | "LIST_NOT_PERMITTED"
  | "MENU_NOT_FOUND"
  | "MENU_AMBIGUOUS"
  // 取得
  | "LIST_NOT_FOUND"
  | "DETAIL_NOT_FOUND"
  | "BODY_PDF_FAILED"
  | "ATTACHMENT_FAILED"
  | "ATTACHMENT_MISMATCH"
  | "TIME_BUDGET_EXCEEDED"
  | "INTERNAL";

/** 部門の選択肢。code は切り替えに使う値、label は画面の表示そのまま（例「品質管理部(1900)」） */
export interface DepartmentOption {
  code: string;
  label: string;
}

/** 進み具合の段階（画面の「いま何をしているか」に出す） */
export type ProgressStage = "open" | "department" | "navigate" | "collect" | "detail" | "approval-log";

/** 一覧から見つけた、取得する伝票 */
export interface ScanTarget {
  denpyoNo: string;
  /** 伝票画面の URL。あれば検索せずに直接開ける */
  href: string | null;
  /** 一覧から読んだ項目（記録に残して画面の一覧に出す） */
  meta: Record<string, string | null>;
}

export type ErrorEvent = {
  type: "error";
  code: RakurakuCode;
  message: string;
  /** その伝票だけ見送れば続けられるか */
  retryable: boolean;
  /** ログインし直しが要るか */
  sessionLost: boolean;
  /** 部門が選べなかったとき、このアカウントで選べるもの（画面の選択肢を直すのに使う） */
  available?: DepartmentOption[];
};

export type RakurakuEvent =
  /** 何も送るものが無い間の生存確認。読み飛ばしてよい */
  | { type: "ping" }
  | { type: "progress"; stage: ProgressStage; message: string }
  /** 移植元が画面に print していた1行。先頭の「  ! 」「  OK 」などの書き方もそのまま */
  | { type: "log"; line: string }
  /** 新しいログイン状態。★これ以降は必ずこちらを使う（クッキーが入れ替わることがある） */
  | { type: "session"; sessionToken: string }
  | {
      type: "targets";
      items: ScanTarget[];
      /** 読んだ行数（重複を除く） */
      scanned: number;
      pages: number;
      total: number | null;
      last: number | null;
      /** ★最後のページに届く前に読むのをやめたか。「対象が0件」とは別物 */
      stoppedEarly: boolean;
      /** 読み切れなかった理由。★画面に出す1行は `parse/list.ts` の scanSummary でブラウザが作る */
      reason: string | null;
      /** 一覧を開いたときの所属部門。部門の切り替えが無いアカウントは null */
      department: DepartmentOption | null;
    }
  /**
   * 伝票画面から読んだ項目（記録のキー → 値）。★読めなかった項目はキーごと入らない。
   * 使う側は**値があるときだけ**一覧の値を上書きする（取れなかった値で既存の値を消さない）。
   */
  | { type: "fields"; fields: Record<string, string> }
  | { type: "done" }
  | ErrorEvent;

/** 1回に取る件数。★範囲外は丸めずに断る（黙って件数を変えない） */
export const SCAN_LIMIT = { min: 1, max: 100 } as const;
/** 一覧を読むページ数の上限（1ページ100件で約2000件）。無限ループを防ぐ */
export const SCAN_MAX_PAGES = 20;

export interface ScanRequest {
  sessionToken: string;
  kind: KindId;
  /** 部門の値。部門の切り替えが無いアカウントは null */
  deptCode: string | null;
  /** 保存済み＋保留中の伝票No.（★保留中も含める。確定するまで取り直さないため） */
  done: string[];
  /** 何件見つけたらページ送りをやめるか */
  limit: number;
  maxPages?: number;
}

export interface FetchRequest {
  sessionToken: string;
  kind: KindId;
  denpyoNo: string;
  /** 一覧で読んだ伝票画面の URL。無ければ一覧を開いて探す */
  href: string | null;
  /** 部門の値（href が無くて一覧を開くときに使う）。部門の切り替えが無いアカウントは null */
  deptCode: string | null;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

const MAX_TOKEN_CHARS = 200_000;
const MAX_DONE = 50_000;
const MAX_DENPYO_CHARS = 64;
const DEPT_CODE_RE = /^[0-9A-Za-z_-]{1,32}$/;
const MAX_HREF_CHARS = 2_048;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `/scan` の本文を確かめる。★直さずに断る（件数やページ数を黙って丸めない） */
export function parseScanRequest(raw: unknown): Parsed<ScanRequest> {
  if (!isObject(raw)) return { ok: false, message: "本文を読めませんでした" };
  const { sessionToken, kind, deptCode, done, limit, maxPages } = raw;
  if (typeof sessionToken !== "string" || sessionToken === "" || sessionToken.length > MAX_TOKEN_CHARS) {
    return { ok: false, message: "sessionToken が要ります" };
  }
  if (!isKindId(kind)) return { ok: false, message: "書類の種類が不正です" };
  if (deptCode !== null && (typeof deptCode !== "string" || !DEPT_CODE_RE.test(deptCode))) {
    return { ok: false, message: "部門の値が不正です" };
  }
  if (
    !Array.isArray(done) ||
    done.length > MAX_DONE ||
    !done.every((no) => typeof no === "string" && no.length <= MAX_DENPYO_CHARS)
  ) {
    return { ok: false, message: "取得済みの伝票No.の一覧が不正です" };
  }
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < SCAN_LIMIT.min || limit > SCAN_LIMIT.max) {
    return { ok: false, message: `1回に取る件数は ${SCAN_LIMIT.min}〜${SCAN_LIMIT.max} の整数にしてください` };
  }
  if (
    maxPages !== undefined &&
    (typeof maxPages !== "number" || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > SCAN_MAX_PAGES)
  ) {
    return { ok: false, message: `ページ数は 1〜${SCAN_MAX_PAGES} の整数にしてください` };
  }
  return {
    ok: true,
    value: {
      sessionToken,
      kind,
      deptCode: deptCode as string | null,
      done: done as string[],
      limit,
      ...(maxPages !== undefined ? { maxPages } : {}),
    },
  };
}

/** `/fetch` の本文を確かめる。★URL の行き先（テナントの中か）はサーバー側で別に確かめる */
export function parseFetchRequest(raw: unknown): Parsed<FetchRequest> {
  if (!isObject(raw)) return { ok: false, message: "本文を読めませんでした" };
  const { sessionToken, kind, denpyoNo, href, deptCode } = raw;
  if (typeof sessionToken !== "string" || sessionToken === "" || sessionToken.length > MAX_TOKEN_CHARS) {
    return { ok: false, message: "sessionToken が要ります" };
  }
  if (!isKindId(kind)) return { ok: false, message: "書類の種類が不正です" };
  if (typeof denpyoNo !== "string" || denpyoNo.trim() === "" || denpyoNo.length > MAX_DENPYO_CHARS) {
    return { ok: false, message: "伝票No.が不正です" };
  }
  if (href !== null && (typeof href !== "string" || href === "" || href.length > MAX_HREF_CHARS)) {
    return { ok: false, message: "伝票画面のURLが不正です" };
  }
  if (deptCode !== null && (typeof deptCode !== "string" || !DEPT_CODE_RE.test(deptCode))) {
    return { ok: false, message: "部門の値が不正です" };
  }
  return {
    ok: true,
    value: { sessionToken, kind, denpyoNo: denpyoNo.trim(), href: href as string | null, deptCode: deptCode as string | null },
  };
}

/** 流れてきた1行を読む。★知らない形は読み飛ばさずに失敗させる（取り違えたまま進まない） */
export function parseEventLine(line: string): RakurakuEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("サーバーからの応答を読めませんでした（途中で切れた可能性があります）");
  }
  if (!isObject(value) || typeof value.type !== "string") {
    throw new Error("サーバーからの応答の形が不正です");
  }
  return value as RakurakuEvent;
}

/**
 * 応答の本文を1行ずつ読む。
 * ★途中でやめたとき（for await を抜けたとき）は読み取りを取り消し、サーバー側にも伝える。
 */
export async function* readNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<RakurakuEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) yield parseEventLine(line);
      }
    }
    buffer += decoder.decode();
    finished = true;
    if (buffer.trim()) yield parseEventLine(buffer.trim());
  } finally {
    if (finished) reader.releaseLock();
    else await reader.cancel().catch(() => undefined);
  }
}

/** 最後の行か（これが来たら、その呼び出しは終わり） */
export function isTerminalEvent(event: RakurakuEvent): event is { type: "done" } | ErrorEvent {
  return event.type === "done" || event.type === "error";
}
