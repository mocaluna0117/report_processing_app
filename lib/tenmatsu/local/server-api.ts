/**
 * ブラウザから Folio のサーバー（`/api/rakuraku/*`）を呼ぶ。
 *
 * ★パスワードはログインのときだけ送る。どこにも保存しない（呼ぶ側のメモリにだけある）。
 * ★ログインは**自動でやり直さない**（楽楽精算は連続して失敗するとアカウントがロックされる）。
 *   やり直すかどうかは呼ぶ側（job.ts）が1回だけ判断する。
 * ★行ごとの JSON の最後の行（done / error）が来なかったら、途中で切れたとみなして失敗にする。
 */
import {
  type AttachmentRequest,
  type ComposeEvent,
  type DepartmentOption,
  type DepartmentsResponse,
  type ErrorEvent,
  type FetchRequest,
  FileAssembler,
  type KindId,
  type ProgressStage,
  type RakurakuCode,
  type RakurakuEvent,
  type ReceivedFile,
  type RouteHow,
  type RouteId,
  type RouteScope,
  type ScanRequest,
  type ScanTarget,
  type SurveyReport,
  normalizeDepartmentsResponse,
  type SurveyRequest,
  readNdjson,
} from "@/lib/rakuraku/protocol";

/** サーバーとのやり取りで起きた失敗。code はサーバーの符号か、ブラウザ側で決めた NETWORK / STREAM_CUT / UNAUTHORIZED */
export type ApiCode = RakurakuCode | "NETWORK" | "STREAM_CUT" | "UNAUTHORIZED";

export class RakurakuApiError extends Error {
  constructor(
    readonly code: ApiCode,
    message: string,
    readonly retryable = false,
    readonly sessionLost = false,
    readonly available?: DepartmentOption[],
  ) {
    super(message);
    this.name = "RakurakuApiError";
  }

  static fromEvent(event: ErrorEvent): RakurakuApiError {
    return new RakurakuApiError(event.code, event.message, event.retryable, event.sessionLost, event.available);
  }
}

export interface StreamHandlers {
  log?: (line: string) => void;
  progress?: (stage: ProgressStage, message: string) => void;
  /** 新しいログイン状態。★これ以降は必ずこちらを使う */
  session?: (sessionToken: string) => void;
  /**
   * どの経路で一覧を開いたか。★経路によって一覧に出る伝票の範囲が違うので、画面に必ず出す。
   * kind は、捺印決裁書が紐づく専決決裁書の一覧を開いたときだけ別の種類になる。
   */
  route?: (event: { kind: KindId; route: RouteId; label: string; scope: RouteScope; how: RouteHow }) => void;
}

export interface ScanResult {
  items: ScanTarget[];
  scanned: number;
  pages: number;
  total: number | null;
  last: number | null;
  stoppedEarly: boolean;
  reason: string | null;
  department: DepartmentOption | null;
}

export interface AttachmentFailure {
  index: number;
  name: string;
  code: RakurakuCode;
  reason: string;
  retryable: boolean;
}

/** 捺印決裁書に紐づく専決決裁書から受け取ったもの */
export interface LinkedResult {
  denpyoNo: string;
  href: string | null;
  /** 写す項目（支払先・決裁申請額など） */
  fields: Record<string, string>;
  /** 添付の表示名ぜんぶ */
  attachmentNames: string[] | null;
  body: ReceivedFile | null;
  attachments: ReceivedFile[];
  failures: AttachmentFailure[];
}

export interface FetchResult {
  fields: Record<string, string>;
  body: ReceivedFile | null;
  /** 添付の表示名（表示順）。捺印決裁書のように添付を取らない種類は null */
  attachmentNames: string[] | null;
  attachments: ReceivedFile[];
  failures: AttachmentFailure[];
  /** 紐づく専決決裁書（捺印決裁書で、一覧に見つかったときだけ） */
  linked: LinkedResult | null;
  /** 組み立ての結果（捺印決裁書だけ。★これが無いまま終わったら受け取りきれていない） */
  compose: ComposeEvent | null;
}

export interface RakurakuApi {
  /** expiresAt はログイン状態の期限 (ミリ秒)。古いサーバーは返さないので null */
  login(userId: string, password: string): Promise<{ sessionToken: string; expiresAt: number | null }>;
  departments(
    sessionToken: string,
  ): Promise<DepartmentsResponse & { sessionToken: string; expiresAt: number | null }>;
  scan(request: ScanRequest, handlers?: StreamHandlers, signal?: AbortSignal): Promise<ScanResult>;
  fetch(request: FetchRequest, handlers?: StreamHandlers, signal?: AbortSignal): Promise<FetchResult>;
  attachment(request: AttachmentRequest, handlers?: StreamHandlers, signal?: AbortSignal): Promise<ReceivedFile>;
  /** 画面の下見（楽楽精算の画面の作りだけを集める） */
  survey(request: SurveyRequest, handlers?: StreamHandlers, signal?: AbortSignal): Promise<SurveyReport>;
}

export type { KindId };

const NETWORK_MESSAGE = "Folio のサーバーに接続できませんでした。インターネットの接続を確かめて、もう一度試してください";

export function createRakurakuApi(options: { fetchImpl?: typeof fetch; baseUrl?: string } = {}): RakurakuApi {
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const base = options.baseUrl ?? "";

  const post = async (path: string, body: unknown, signal?: AbortSignal): Promise<Response> => {
    let res: Response;
    try {
      res = await doFetch(`${base}/api/rakuraku/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
        credentials: "same-origin",
        signal,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      throw new RakurakuApiError("NETWORK", NETWORK_MESSAGE, true);
    }
    if (res.status === 401) {
      throw new RakurakuApiError("UNAUTHORIZED", "Folio へのログインが切れました。画面を読み込み直して、Folio にログインし直してください");
    }
    if (!res.ok) throw new RakurakuApiError("INTERNAL", `Folio のサーバーが応答しませんでした（HTTP ${res.status}）`, true);
    return res;
  };

  /** 普通の JSON で返るルート（ログイン・部門） */
  const json = async <T>(path: string, body: unknown): Promise<T> => {
    const res = await post(path, body);
    const parsed = (await res.json().catch(() => null)) as ({ ok?: boolean; code?: RakurakuCode; message?: string } & T) | null;
    if (!parsed) throw new RakurakuApiError("INTERNAL", "Folio のサーバーからの応答を読めませんでした", true);
    if (parsed.ok !== true) {
      const code = parsed.code ?? "INTERNAL";
      // ★やり直してよいか・ログインし直しが要るかはサーバーの言うとおりにする
      //   （古いサーバーは返さないので、今までどおり符号から決める）
      const body = parsed as { retryable?: unknown; sessionLost?: unknown };
      throw new RakurakuApiError(
        code,
        parsed.message ?? "失敗しました",
        body.retryable === true,
        typeof body.sessionLost === "boolean" ? body.sessionLost : code === "SESSION_EXPIRED",
      );
    }
    return parsed;
  };

  /** 行ごとの JSON で返るルート。最後の行まで読み、ファイルを組み立てて onEvent に渡す */
  const stream = async (
    path: string,
    body: unknown,
    handlers: StreamHandlers,
    signal: AbortSignal | undefined,
    onEvent: (event: RakurakuEvent) => void,
    onFile: (file: ReceivedFile) => void,
  ): Promise<void> => {
    const res = await post(path, body, signal);
    if (!res.body) throw new RakurakuApiError("STREAM_CUT", "Folio のサーバーからの応答が空でした", true);
    const assembler = new FileAssembler();
    let finished = false;
    try {
      for await (const event of readNdjson(res.body)) {
        if (await assembler.accept(event, onFile)) continue;
        switch (event.type) {
          case "ping":
            break;
          case "log":
            handlers.log?.(event.line);
            break;
          case "progress":
            handlers.progress?.(event.stage, event.message);
            break;
          case "session":
            handlers.session?.(event.sessionToken);
            break;
          case "route":
            handlers.route?.(event);
            break;
          case "error":
            finished = true;
            throw RakurakuApiError.fromEvent(event);
          case "done":
            finished = true;
            break;
          default:
            onEvent(event);
        }
        if (finished) break;
      }
    } catch (e) {
      if (e instanceof RakurakuApiError || (e instanceof DOMException && e.name === "AbortError")) throw e;
      throw new RakurakuApiError("STREAM_CUT", `Folio のサーバーとの通信が途中で切れました（${e instanceof Error ? e.message : "原因不明"}）`, true);
    }
    if (!finished) {
      throw new RakurakuApiError("STREAM_CUT", "Folio のサーバーとの通信が途中で切れました（時間の上限に達した可能性があります）", true);
    }
    if (assembler.pending > 0) {
      throw new RakurakuApiError("STREAM_CUT", "受け取りきれなかったファイルがあります（通信が途中で切れた可能性があります）", true);
    }
  };

  return {
    login: async (userId, password) => {
      const res = await json<{ sessionToken: string; expiresAt?: number }>("login", { userId, password });
      return { sessionToken: res.sessionToken, expiresAt: typeof res.expiresAt === "number" ? res.expiresAt : null };
    },

    departments: async (sessionToken) => {
      const res = await json<{ sessionToken: string; expiresAt?: number }>("departments", { sessionToken });
      return {
        ...normalizeDepartmentsResponse(res),
        sessionToken: res.sessionToken,
        expiresAt: typeof res.expiresAt === "number" ? res.expiresAt : null,
      };
    },

    scan: async (request, handlers = {}, signal) => {
      let result: ScanResult | null = null;
      await stream("scan", request, handlers, signal, (event) => {
        if (event.type === "targets") {
          const { type: _type, ...rest } = event;
          result = rest;
        }
      }, () => undefined);
      if (!result) throw new RakurakuApiError("STREAM_CUT", "一覧の読み取り結果を受け取れませんでした", true);
      return result;
    },

    survey: async (request, handlers = {}, signal) => {
      let report: SurveyReport | null = null;
      await stream(
        "survey",
        request,
        handlers,
        signal,
        (event) => {
          if (event.type === "survey") report = event.report;
        },
        () => undefined,
      );
      if (!report) throw new RakurakuApiError("STREAM_CUT", "下見の結果を受け取れませんでした", true);
      return report;
    },

    fetch: async (request, handlers = {}, signal) => {
      const out: FetchResult = { fields: {}, body: null, attachmentNames: null, attachments: [], failures: [], linked: null, compose: null };
      let gotFields = false;
      const linked = (): LinkedResult => {
        out.linked ??= { denpyoNo: "", href: null, fields: {}, attachmentNames: null, body: null, attachments: [], failures: [] };
        return out.linked;
      };
      await stream(
        "fetch",
        request,
        handlers,
        signal,
        (event) => {
          if (event.type === "fields") {
            out.fields = event.fields;
            gotFields = true;
          } else if (event.type === "attachments") {
            out.attachmentNames = event.names;
          } else if (event.type === "attachment.failed") {
            const { type: _type, role, ...failure } = event;
            if (role === "linked-attachment") linked().failures.push(failure);
            else out.failures.push(failure);
          } else if (event.type === "linked.found") {
            linked().denpyoNo = event.denpyoNo;
            linked().href = event.href;
          } else if (event.type === "linked.fields") {
            linked().fields = event.fields;
          } else if (event.type === "linked.attachments") {
            linked().attachmentNames = event.names;
          } else if (event.type === "compose") {
            out.compose = event;
          }
        },
        (file) => {
          if (file.role === "body") out.body = file;
          else if (file.role === "attachment") out.attachments.push(file);
          else if (file.role === "linked-body") linked().body = file;
          else linked().attachments.push(file);
        },
      );
      if (!gotFields || !out.body || (request.kind === "natsuin" && !out.compose)) {
        throw new RakurakuApiError("STREAM_CUT", "伝票の取得結果を受け取りきれませんでした", true);
      }
      return out;
    },

    attachment: async (request, handlers = {}, signal) => {
      let got: ReceivedFile | null = null;
      await stream("attachment", request, handlers, signal, () => undefined, (file) => {
        if (file.role === "attachment" && file.index === request.index) got = file;
      });
      if (!got) throw new RakurakuApiError("STREAM_CUT", "添付を受け取りきれませんでした", true);
      return got;
    },
  };
}
