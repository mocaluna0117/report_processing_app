/**
 * ブラウザと Folio のサーバー（`/api/rakuraku/*`）のあいだの約束事。
 *
 * ★両側から import するので、Playwright にも server-only にも依存しない。
 * ★行ごとの JSON（NDJSON）で流す。HTTP の状態は常に 200 で、**成否は最後の行**
 *   （`done` か `error`）で表す。どちらも届かずに終わったら、途中で接続が切れたということ。
 */

import type { SurveyReport } from "@/lib/rakuraku/parse/survey";

export type { SurveyReport } from "@/lib/rakuraku/parse/survey";

export type KindId = "tenmatsu" | "senketsu" | "natsuin";

export function isKindId(value: unknown): value is KindId {
  return value === "tenmatsu" || value === "senketsu" || value === "natsuin";
}

/**
 * 一覧を開く経路。アカウントの権限で使える画面が違うので、種類ごとに順に試す。
 * - jibumon … 「閲覧」タブの自部門検索（部門の伝票が出る）
 * - shinsei … 「ワークフロー」タブの申請検索（★自分が申請した伝票だけが出る）
 */
export type RouteId = "jibumon" | "shinsei";

export function isRouteId(value: unknown): value is RouteId {
  return value === "jibumon" || value === "shinsei";
}

/** その経路の一覧に出る伝票の範囲。own は画面で必ず利用者に伝える */
export type RouteScope = "department" | "own";

/** その経路をどうやって選んだか（画面とログの言い方を変える） */
export type RouteHow =
  /** 種類の既定（先頭の経路） */
  | "default"
  /** 前に使えた経路（封じたログイン状態が覚えていた） */
  | "remembered"
  /** 利用者が画面で固定した */
  | "pinned"
  /** 前の経路を開けなかったので切り替えた */
  | "fallback";

/**
 * 前に一覧を開けた経路。★封じたログイン状態の中だけで持ち回る。
 * ブラウザから URL を受け取らない（別の場所へ行かせないため。経路は id だけ受ける）。
 */
export interface RememberedRoute {
  id: RouteId;
  /** メニューをたどって見つけた一覧の URL（直接開ける種類では入らない） */
  url?: string;
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

/** `/api/rakuraku/departments` の応答（ブラウザ側で使う形に直したもの） */
export interface DepartmentsResponse {
  departments: DepartmentOption[];
  current: DepartmentOption | null;
  /**
   * 部門のプルダウンがあったか。
   * ★**無い＝失敗ではない**（「閲覧」タブが無いアカウントには切り替えが無い）。部門を指定せずに取得する。
   * ★プルダウンはあるのに選択肢が空、という別の状態と見分けるためにこの項目がある。
   */
  hasDepartmentSelect: boolean;
}

const isOption = (v: unknown): v is DepartmentOption =>
  isObject(v) && typeof v.code === "string" && typeof v.label === "string";

/**
 * `/departments` の応答を読む。
 * ★古いサーバーは hasDepartmentSelect を返さない（プルダウンが無いときは失敗を返していた）。
 *   そのときは「選択肢があればプルダウンも有った」とみなす（空を「選択肢が空」と誤判定しない）。
 */
export function normalizeDepartmentsResponse(raw: unknown): DepartmentsResponse {
  const body = isObject(raw) ? raw : {};
  const departments = Array.isArray(body.departments) ? body.departments.filter(isOption) : [];
  return {
    departments,
    current: isOption(body.current) ? body.current : null,
    hasDepartmentSelect:
      typeof body.hasDepartmentSelect === "boolean" ? body.hasDepartmentSelect : departments.length > 0,
  };
}

/** 進み具合の段階（画面の「いま何をしているか」に出す） */
export type ProgressStage =
  | "open"
  | "department"
  | "navigate"
  | "collect"
  | "detail"
  | "approval-log"
  | "body"
  | "attachments";

/**
 * 流すファイルの役割。body = 伝票の本体PDF、attachment = 添付（index は画面の表示順・1始まり）。
 * linked-body / linked-attachment は、捺印決裁書に紐づく専決決裁書の本体と添付（index はその伝票画面での表示順）。
 */
export type FileRole = "body" | "attachment" | "linked-body" | "linked-attachment";

export type ComposeGroupName = "decision" | "summary" | "estimate" | "other";

/** 捺印決裁書の組み立ての結果（最後に1回だけ流す） */
export interface ComposeEvent {
  type: "compose";
  /** 紐づく専決決裁書の伝票No.（数字だけ）。読めなければ null */
  linkedNo: string | null;
  pattern: 1 | 2;
  /** 結合する添付（この順に並べる）。index は専決決裁書の伝票画面での表示順 */
  picked: { index: number; name: string; group: ComposeGroupName }[];
  paren: string | null;
  parenFrom: "decision" | "summary" | "estimate" | "quote" | null;
  /** 確定したときに付ける名前 */
  finalName: string;
  /** 紐づけに失敗した理由（番号が読めない／一覧を開けない／見つからない／本体が取れない）。うまくいけば null */
  linkReason: string | null;
}

/** ファイルを流すときの1かたまりの大きさ（base64 にする前）。1行を大きくしすぎない */
export const FILE_CHUNK_BYTES = 192 * 1024;

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
  /**
   * どの経路で一覧を開いたか。★一覧を開けたときだけ流す。
   * 捺印決裁書が紐づく専決決裁書の一覧を開いたときは kind が専決決裁書になる。
   */
  | { type: "route"; kind: KindId; route: RouteId; label: string; scope: RouteScope; how: RouteHow }
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
  /**
   * ファイルの始まり。name は画面に出ていた名前（本体は「本体」）、ext は**中身で確かめた**拡張子
   * （判定できなければ名前の拡張子、それも無ければ空文字）。bytes は全体の大きさ。
   */
  | { type: "file.begin"; id: string; role: FileRole; index: number; name: string; ext: string; bytes: number }
  /** ファイルの中身の一部（base64）。seq は 0 始まりの通し番号 */
  | { type: "file.chunk"; id: string; seq: number; data: string }
  /** ファイルの終わり。★受け取った側は、かたまりの数と sha256 が合うか必ず確かめる */
  | { type: "file.end"; id: string; chunks: number; sha256: string }
  /** 伝票画面の添付の表示名（表示順）。★取れなかった添付も含めた全部 */
  | { type: "attachments"; names: string[] }
  /**
   * 添付を取れなかった。取れなかった添付は結合せず、保留にして手で入れられるようにする（黙って落とさない）。
   * code が TIME_BUDGET_EXCEEDED のときは、`/attachment` で個別に取り直せる。
   */
  | {
      type: "attachment.failed";
      index: number;
      name: string;
      code: RakurakuCode;
      reason: string;
      retryable: boolean;
      /** 紐づく専決決裁書の添付か（省略は自分の添付） */
      role?: "attachment" | "linked-attachment";
    }
  /** 紐づく専決決裁書が一覧で見つかった */
  | { type: "linked.found"; denpyoNo: string; href: string | null }
  /** 紐づく専決決裁書の画面から写す項目（支払先・決裁申請額など。捺印決裁書の画面に無いもの） */
  | { type: "linked.fields"; fields: Record<string, string> }
  /** 紐づく専決決裁書の添付の表示名ぜんぶ（★名前の決め方を後から直せるように全部残す） */
  | { type: "linked.attachments"; names: string[] }
  | ComposeEvent
  /** 「画面の下見」の結果（最後に1回だけ流す）。★画面の作りだけで、伝票の中身は入らない */
  | { type: "survey"; report: SurveyReport }
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
  /** 一覧の経路を固定する（画面の「一覧の経路」）。省略すると自動で順に試す */
  route?: RouteId;
}

export interface FetchRequest {
  sessionToken: string;
  kind: KindId;
  denpyoNo: string;
  /** 一覧で読んだ伝票画面の URL。無ければ一覧を開いて探す */
  href: string | null;
  /** 部門の値（href が無くて一覧を開くときに使う）。部門の切り替えが無いアカウントは null */
  deptCode: string | null;
  /** 一覧で読んだ、紐づく伝票の番号（捺印決裁書の「専決決裁書№」）。伝票画面で読めなかったときに使う */
  linkedNo?: string | null;
  /** 一覧の経路を固定する（画面の「一覧の経路」）。省略すると自動で順に試す */
  route?: RouteId;
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
  const { sessionToken, kind, deptCode, done, limit, maxPages, route } = raw;
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
  if (route !== undefined && !isRouteId(route)) return { ok: false, message: "一覧の経路の指定が不正です" };
  return {
    ok: true,
    value: {
      sessionToken,
      kind,
      deptCode: deptCode as string | null,
      done: done as string[],
      limit,
      ...(maxPages !== undefined ? { maxPages } : {}),
      ...(route !== undefined ? { route } : {}),
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
  const { linkedNo, route } = raw;
  if (route !== undefined && !isRouteId(route)) return { ok: false, message: "一覧の経路の指定が不正です" };
  if (linkedNo !== undefined && linkedNo !== null && (typeof linkedNo !== "string" || linkedNo.length > MAX_DENPYO_CHARS)) {
    return { ok: false, message: "紐づく伝票の番号が不正です" };
  }
  return {
    ok: true,
    value: {
      sessionToken,
      kind,
      denpyoNo: denpyoNo.trim(),
      href: href as string | null,
      deptCode: deptCode as string | null,
      ...(typeof linkedNo === "string" && linkedNo.trim() !== "" ? { linkedNo: linkedNo.trim() } : {}),
      ...(route !== undefined ? { route } : {}),
    },
  };
}

export interface AttachmentRequest {
  sessionToken: string;
  kind: KindId;
  denpyoNo: string;
  href: string | null;
  deptCode: string | null;
  /** 添付の番号（画面の表示順・1始まり） */
  index: number;
  /** `/fetch` で受け取った表示名。★違っていたら取らない（伝票の添付が差し替わっている） */
  expectedName: string;
  /** 一覧の経路を固定する（画面の「一覧の経路」）。省略すると自動で順に試す */
  route?: RouteId;
}

/** 1つの伝票に置ける添付の数の上限（楽楽精算の枠は5つ。余裕を持たせる） */
const MAX_ATTACHMENT_INDEX = 99;
const MAX_NAME_CHARS = 512;

/** `/attachment` の本文を確かめる */
export function parseAttachmentRequest(raw: unknown): Parsed<AttachmentRequest> {
  const base = parseFetchRequest(raw);
  if (!base.ok) return base;
  const { index, expectedName } = raw as Record<string, unknown>;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 1 || index > MAX_ATTACHMENT_INDEX) {
    return { ok: false, message: "添付の番号が不正です" };
  }
  if (typeof expectedName !== "string" || expectedName === "" || expectedName.length > MAX_NAME_CHARS) {
    return { ok: false, message: "添付の名前が不正です" };
  }
  return { ok: true, value: { ...base.value, index, expectedName } };
}

export interface SurveyRequest {
  sessionToken: string;
  /** 部門の値。部門の切り替えが無いアカウント・まだ選んでいないときは null */
  deptCode: string | null;
}

/** `/survey` の本文を確かめる */
export function parseSurveyRequest(raw: unknown): Parsed<SurveyRequest> {
  if (!isObject(raw)) return { ok: false, message: "本文を読めませんでした" };
  const { sessionToken, deptCode } = raw;
  if (typeof sessionToken !== "string" || sessionToken === "" || sessionToken.length > MAX_TOKEN_CHARS) {
    return { ok: false, message: "sessionToken が要ります" };
  }
  if (deptCode !== null && deptCode !== undefined && (typeof deptCode !== "string" || !DEPT_CODE_RE.test(deptCode))) {
    return { ok: false, message: "部門の値が不正です" };
  }
  return { ok: true, value: { sessionToken, deptCode: (deptCode as string | undefined) ?? null } };
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

// ---------------------------------------------------------------------------
// 流れてきたファイルを組み立てる（ブラウザ側）
// ---------------------------------------------------------------------------

export interface ReceivedFile {
  role: FileRole;
  index: number;
  name: string;
  ext: string;
  bytes: Uint8Array;
}

function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * `file.begin` → `file.chunk`… → `file.end` を受け取って、ファイルに組み立てる。
 *
 * ★**欠けたファイルを正しいファイルとして渡さない**。かたまりの順番・数・大きさ・sha256 のどれかが
 *   合わなければ例外にする（途中で切れた PDF をフォルダーに置かないため）。
 * ★かたまりは届いたそばから復元し、巨大な文字列を溜めない。
 */
export class FileAssembler {
  private readonly open = new Map<
    string,
    { role: FileRole; index: number; name: string; ext: string; bytes: number; parts: Uint8Array[]; received: number; next: number }
  >();

  /** ファイルに関する行なら処理して true、それ以外の行なら false。組み上がったら onFile を呼ぶ */
  async accept(event: RakurakuEvent, onFile: (file: ReceivedFile) => void | Promise<void>): Promise<boolean> {
    switch (event.type) {
      case "file.begin": {
        if (this.open.has(event.id)) throw new Error("同じファイルが二重に始まりました");
        this.open.set(event.id, {
          role: event.role,
          index: event.index,
          name: event.name,
          ext: event.ext,
          bytes: event.bytes,
          parts: [],
          received: 0,
          next: 0,
        });
        return true;
      }
      case "file.chunk": {
        const file = this.open.get(event.id);
        if (!file) throw new Error("始まっていないファイルの続きが届きました");
        if (event.seq !== file.next) throw new Error("ファイルの一部が抜けています（途中で切れた可能性があります）");
        const part = base64ToBytes(event.data);
        file.parts.push(part);
        file.received += part.length;
        file.next += 1;
        if (file.received > file.bytes) throw new Error("ファイルが予定より大きくなりました");
        return true;
      }
      case "file.end": {
        const file = this.open.get(event.id);
        if (!file) throw new Error("始まっていないファイルの終わりが届きました");
        this.open.delete(event.id);
        if (event.chunks !== file.next || file.received !== file.bytes) {
          throw new Error("ファイルの一部が抜けています（途中で切れた可能性があります）");
        }
        const bytes = new Uint8Array(file.bytes);
        let offset = 0;
        for (const part of file.parts) {
          bytes.set(part, offset);
          offset += part.length;
        }
        const digest = toHex(await crypto.subtle.digest("SHA-256", bytes));
        if (digest !== event.sha256) throw new Error("ファイルの中身が送られたものと一致しません");
        await onFile({ role: file.role, index: file.index, name: file.name, ext: file.ext, bytes });
        return true;
      }
      default:
        return false;
    }
  }

  /** 組み上がっていないファイルが残っているか（最後の行を受け取ったあとに確かめる） */
  get pending(): number {
    return this.open.size;
  }
}
