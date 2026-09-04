// 顛末書ローカルサーバー (そのPCで動く server.py) との通信と、その応答の型。
//
// ブラウザから http://127.0.0.1:8765 を直接叩く。folio のサーバー (Vercel) は経由しない
// ＝ 施主の個人情報を含むPDFも一覧も、この端末の外へは出ない。
// http:// を https:// のページから呼べるのは、ループバックが Secure Contexts 仕様で
// "potentially trustworthy" 扱いだから (混在コンテンツにはならない)。
//
// fetch は引数で受け取れるようにしてある (テストがグローバルに触らずに済むように)。

/** ローカルサーバーの状態。done は次の実行かサーバー再起動まで done のまま残る */
export type JobState = "idle" | "running" | "done" | "error";

/** 今回の実行で保存できた1件 */
export interface SavedItem {
  denpyo_no: string;
  file: string;
}

/** GET /status の中身 (10個のキーは常に揃う) */
export interface StatusPayload {
  state: JobState;
  /** 進捗。processed は完了時にしか入らないので、途中経過はこの done/total を使う */
  done: number;
  total: number;
  /** いま処理中の伝票No. */
  current: string | null;
  /** 人間向けの1行 (例「顛末書No.1469.pdf を保存しました」) */
  message: string;
  error: string | null;
  /** 失敗したときの、PC上のログのパス */
  error_file: string | null;
  /** 完了時の保存件数 (実行中はずっと 0) */
  processed: number;
  /** 1回あたりの上限で今回は見送った件数。0 でなければ必ず画面に出す (黙って切り捨てない) */
  remaining: number;
  saved: SavedItem[];
}

/**
 * GET /list の1行。
 * 並びは「PC側の記録に足した順の逆」で、取得日時での並べ替えではない
 * (一度取り直した伝票は、元の位置のまま取得日時だけ新しくなる)。folio では並べ替えない。
 */
export interface ListItem {
  denpyo_no: string;
  file: string;
  /** 取得日時。タイムゾーンなしのローカル時刻 (例 "2026-09-04T10:00:00")。記録が無ければ null */
  at: string | null;
  /** PCの保存先にPDFが残っているか。false は「記録はあるがファイルが消えている」 */
  exists: boolean;
  /** exists=false なら null。exists=true でもPDFを読めなければ null */
  pages: number | null;
  size: number | null;
  /**
   * ここから下の4つは、完了フラグに対応したサーバーだけが返す。
   * PC側の ~/tenmatsu-dl/ を更新していないと undefined になり、
   * 古いブラウザのキャッシュにも入っていない。**false で埋めてはいけない**
   * (入力し終えた伝票が未入力に見えて、手作業をやり直させることになる)。
   * 判定は hasFlags を通すこと。
   */
  /** ダイテックへ実行予算を入力し終えたか (取得後の手作業。画面から切り替える) */
  budget_entered?: boolean;
  /** クラウドへ格納し終えたか (同上) */
  cloud_stored?: boolean;
  /**
   * 上の2つが揃ったか。サーバーが計算した値なので folio では計算し直さない。
   * exists は見ていないので、PDFが消えている行でも completed になり得る。
   */
  completed?: boolean;
  /** フラグを最後に変えた日時。at と同じ形。一度も変えていなければ null */
  flags_updated_at?: string | null;
}

/** GET /health (トークン不要) */
export interface HealthPayload {
  ok: boolean;
  service: string;
  /**
   * サーバーの版。フィールドが増えても 1 のまま上がらないので、
   * 新しい機能の有無をこれで判定してはいけない (resolveRunLimits を参照)。
   */
  version: number;
  /** PDFの保存先フォルダ (そのPCのパス) */
  save_dir: string;
  job_state: JobState;
  /**
   * ここから下の5つは新しいサーバーだけが返す。
   * PC側の ~/tenmatsu-dl/ を更新していない端末では undefined になる。
   * 件数の3つは直接読まず resolveRunLimits を通すこと。
   */
  /** 1回あたりの件数の既定値 (サーバーの config.json の値) */
  max_per_run?: number;
  /** 指定できる下限 (server.py の定数。PCごとには変わらない) */
  max_per_run_min?: number;
  /** 指定できる上限 (同上) */
  max_per_run_max?: number;
  /** ブラウザの画面を出さずに動かす設定になっているか */
  headless?: boolean;
  /** デモモード (架空データ。本番の記録には触らない) で動いているか */
  demo?: boolean;
}

/**
 * ローカルサーバーのアドレス。
 * 画面から変えられるようにはしていない。入力欄を出すと打ち間違いと
 * 「別のPCを指してしまう」事故のほうが多く、使う端末が1台だけだから。
 * ポートを変えるときは config.json の server.port と ここ の両方を直して再デプロイする。
 */
export const TENMATSU_BASE_URL = "http://127.0.0.1:8765";

/** トークンを載せるヘッダー (server.py の TOKEN_HEADER と合わせる) */
const TOKEN_HEADER = "X-Tenmatsu-Token";

/** 1リクエストの上限。/run はすぐ返る (処理はサーバー側のスレッド) ので短くてよい */
const TIMEOUT_MS = 15_000;
/** PDFの読み出しだけは大きいので長めに取る */
const FILE_TIMEOUT_MS = 60_000;

export type FailureKind =
  | "network" // fetch 自体が失敗した (原因は特定できない)
  | "timeout"
  | "auth" // 401
  | "badRequest" // 400
  | "notFound" // 404
  | "conflict" // 409
  | "forbidden" // 403 (ブラウザからは通常見えない。下の注記を参照)
  | "server"
  | "unknown";

/** ローカルサーバーとのやり取りが失敗したときに投げる */
export class TenmatsuError extends Error {
  readonly kind: FailureKind;
  /** HTTPステータス。fetch 自体が失敗したときは null */
  readonly status: number | null;
  constructor(kind: FailureKind, status: number | null, message: string) {
    super(message);
    this.name = "TenmatsuError";
    this.kind = kind;
    this.status = status;
  }
}

/**
 * fetch が失敗したときの案内。
 * 許可していないオリジンへの応答 (403) にはCORSヘッダーが付かないので、ブラウザは中身を読めず
 * ただの TypeError になる。つまり「起動していない」「ブラウザの許可が無い」「許可オリジンに
 * 入っていない」の3つは JS からは区別できない。原因を1つに決めつけないこと。
 */
export const NETWORK_FAILURE_MESSAGE =
  "ローカルサーバーに接続できませんでした。" +
  "(1) 「顛末書サーバー起動.bat」が起動していない、" +
  "(2) ブラウザの「このデバイス上のアプリ」の許可が出ていない、" +
  "(3) このページのURLがサーバーの allowed_origins に入っていない — " +
  "のいずれかです (どれなのかはブラウザ側からは分かりません)";

/**
 * 失敗の理由を日本語にする唯一の場所。
 * status が null なら fetch 自体が失敗したとき (通信不能・許可なし・オリジン不許可)。
 */
export function describeFailure(
  status: number | null,
  serverError?: string | null,
  timedOut = false,
): { kind: FailureKind; message: string } {
  if (status === null) {
    return timedOut
      ? {
          kind: "timeout",
          message:
            "ローカルサーバーが時間内に応答しませんでした。" +
            "サーバーの黒い画面 (コンソール) にエラーが出ていないか確認してください",
        }
      : { kind: "network", message: NETWORK_FAILURE_MESSAGE };
  }
  // サーバーは失敗時に必ず {"error": "日本語"} を返す。読めたらそれを優先して使う
  const detail = serverError?.trim() || null;
  switch (status) {
    case 400:
      // /file の「伝票No.が指定されていません」だけでなく /run (件数) と /flags でも起きる。
      // どれもサーバーが必ず日本語の error を返すので、ここは本文が読めなかったときの保険
      return { kind: "badRequest", message: detail ?? "送った内容に問題があります" };
    case 401:
      // サーバーは「未登録」も「間違い」も同じ 401 を返すので、両方に効く文言にする
      return {
        kind: "auth",
        message:
          "トークンが違います (まだ登録していない場合も同じ応答になります)。" +
          "サーバーの起動時にコンソールへ表示されたトークンを登録し直してください",
      };
    case 403:
      // ブラウザ経由ではCORSヘッダーが付かず TypeError になるため、ここには来ない (念のため)
      return {
        kind: "forbidden",
        message:
          detail ??
          "このURLからは利用できません。サーバーの config.json の allowed_origins に" +
            "このページのURLを追加して、サーバーを起動し直してください",
      };
    case 404:
      return { kind: "notFound", message: detail ?? "見つかりませんでした" };
    case 409:
      return { kind: "conflict", message: detail ?? "すでに実行中です" };
    default:
      if (status >= 500) {
        return {
          kind: "server",
          message: detail ?? `サーバー内部でエラーが起きました (HTTP ${status})`,
        };
      }
      return { kind: "unknown", message: detail ?? `想定外の応答が返りました (HTTP ${status})` };
  }
}

/**
 * トークンとして使える文字か (空白・改行・非ASCIIを弾く)。
 * サーバーのトークンは secrets.token_urlsafe(32) なので必ずASCII。非ASCIIを送ると
 * server.py の compare_digest が例外を投げ、HTTPの応答すら返らずに接続が切れる
 * ＝ 上の「接続できませんでした」と見分けが付かない失敗になる。貼り付けの時点で弾く。
 */
export function isValidToken(token: string): boolean {
  return /^[!-~]+$/.test(token);
}

export const TOKEN_FORMAT_MESSAGE =
  "トークンに使えない文字が含まれています。" +
  "コンソールに表示されている英数字と -_ だけの文字列を、前後の空白や改行を入れずに貼り付けてください";

/** ポーリングを止めてよい状態か */
export function isFinished(state: JobState): boolean {
  return state === "done" || state === "error";
}

export interface Completion {
  /** ok: そのまま / notice: 残りがある (琥珀) / error: 失敗 (赤) */
  tone: "ok" | "notice" | "error";
  message: string;
}

/**
 * 終わったときの1行。実行中・未実行なら null。
 *
 * 注意: /status の done は次の実行までずっと done のままなので、
 * 「この画面で始めた / 合流した処理がある」ときだけ呼ぶこと (画面を開いただけで出さない)。
 */
export function describeCompletion(status: StatusPayload): Completion | null {
  if (status.state === "error") {
    const reason = status.error?.trim() || "原因不明";
    const log = status.error_file ? `。ログ: ${status.error_file}` : "";
    return { tone: "error", message: `エラーで停止しました (${reason})${log}` };
  }
  if (status.state !== "done") return null;
  const base =
    status.processed > 0
      ? `${status.processed}件を保存しました`
      : "新しく取得できる顛末書はありませんでした";
  // remaining は「今回の残り」ではなく「1回の上限で見送った分」。黙って切り捨てない
  if (status.remaining > 0) {
    return {
      tone: "notice",
      message: `${base}。残り${status.remaining}件は次回実行してください (1回あたりの上限があります)`,
    };
  }
  return { tone: "ok", message: base };
}

/** 取得日時の表示。サーバーが返すのはタイムゾーンなしのローカル時刻なので、文字列のまま整える */
export function formatFetchedAt(at: string | null): string {
  const m = at?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return "－";
  return `${m[1]}/${Number(m[2])}/${Number(m[3])} ${m[4]}:${m[5]}`;
}

export function formatFileSize(size: number | null): string {
  if (size === null || !Number.isFinite(size)) return "－";
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)}KB`;
  return `${(size / 1024 / 1024).toFixed(1)}MB`;
}

const optionalBool = (v: unknown): boolean => v === undefined || typeof v === "boolean";

/**
 * /list の1行として使える形か (IndexedDBに残したキャッシュの検証にも使う)。
 *
 * フラグ4つは必須にしない。ここは /list の応答も通す (list() が filter する) ので、
 * 必須にすると完了フラグに未対応のサーバー相手に全行を落として「まだ取得した顛末書は
 * ありません」と表示してしまう。記録があるのに0件と言うのは、remaining や
 * exists=false を黙って隠さない方針と正面から矛盾する。
 * 「フラグが分からない行」は hasFlags で見分けて、画面で「－」と出す。
 */
export function isListItemLike(v: unknown): v is ListItem {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.denpyo_no === "string" &&
    typeof o.file === "string" &&
    (typeof o.at === "string" || o.at === null) &&
    typeof o.exists === "boolean" &&
    (typeof o.pages === "number" || o.pages === null) &&
    (typeof o.size === "number" || o.size === null) &&
    // 入っているときだけ型を確かめる (無い＝フラグ未対応のサーバー・古いキャッシュ)
    optionalBool(o.budget_entered) &&
    optionalBool(o.cloud_stored) &&
    optionalBool(o.completed) &&
    (o.flags_updated_at === undefined ||
      typeof o.flags_updated_at === "string" ||
      o.flags_updated_at === null)
  );
}

/**
 * その行の完了フラグが分かるか。
 * false は「PC側のサーバーが未対応」か「この機能より前のキャッシュ」で、
 * *フラグが未設定* という意味ではない (サーバーは未設定でも false を返す)。
 * 分からないものを false として扱わないために、判定はここを通す。
 */
export function hasFlags(item: ListItem): boolean {
  return typeof item.budget_entered === "boolean" && typeof item.cloud_stored === "boolean";
}

/**
 * 件数の折り込みの既定値。
 * server.py の MIN_PER_RUN / MAX_PER_RUN と config.json の既定値に合わせてある。
 * 上下限を返さない古いサーバーのときだけ使う。
 */
const RUN_COUNT_FALLBACK = { value: 10, min: 1, max: 100 } as const;

/** 件数入力欄に必要な値 */
export interface RunLimits {
  /** 入力欄の初期値 (サーバーの既定値) */
  value: number;
  min: number;
  max: number;
  /**
   * サーバーが上下限を返したか。
   * false は「PC側のサーバーが古い」＝ 件数を送っても読み捨てられて既定値で動く。
   * 件数の入力欄を出すかどうかの判断に使う。
   */
  fromServer: boolean;
}

const intOr = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isInteger(v) ? v : fallback;

/**
 * 件数入力欄の初期値と上下限を決める唯一の場所。
 *
 * /health の version はフィールドが増えても 1 のままなので version では判定できない。
 * max_per_run_min が来ているかどうかで「新しいサーバーか」を判定する。
 */
export function resolveRunLimits(health: HealthPayload | null | undefined): RunLimits {
  const lo = intOr(health?.max_per_run_min, RUN_COUNT_FALLBACK.min);
  const hi = intOr(health?.max_per_run_max, RUN_COUNT_FALLBACK.max);
  // 上下が逆に届いても入力できるようにする
  const min = Math.min(lo, hi);
  const max = Math.max(lo, hi);
  const value = Math.min(max, Math.max(min, intOr(health?.max_per_run, RUN_COUNT_FALLBACK.value)));
  return { value, min, max, fromServer: typeof health?.max_per_run_min === "number" };
}

/** POST /run に載せる、その回だけの設定 */
export interface RunOptions {
  /** 1回あたりの取得件数。省略するとサーバーの config.json の既定値で動く */
  maxPerRun?: number;
  /** ブラウザの画面を出さずに動かすか。省略するとサーバーの設定のまま (画面には出していない) */
  headless?: boolean;
}

export interface RunResult {
  /** すでに実行中 (409) だったら false */
  started: boolean;
  status: StatusPayload;
  /**
   * サーバーが実際に使った件数。
   * 件数指定に未対応の古いサーバーと 409 のときは null になる。
   * null は「指定した件数が効いていない」なので、指定したのに null なら画面で断る。
   */
  maxPerRun: number | null;
  /** 実際に使われた headless。返らなければ null */
  headless: boolean | null;
}

export const RUN_COUNT_FORMAT_MESSAGE = "取得件数は整数で指定してください";

/** 取得後の手作業の進捗。変えるものだけ入れる (両方省略は不可) */
export interface FlagUpdate {
  budget_entered?: boolean;
  cloud_stored?: boolean;
}

export const EMPTY_FLAGS_MESSAGE = "変更するフラグが指定されていません";

/** POST /run の応答。max_per_run / headless は新しいサーバーだけが返す */
interface RunResponseBody {
  status?: StatusPayload;
  max_per_run?: unknown;
  headless?: unknown;
}

/** POST /flags の応答。item はサーバー側で dict | null なので、無いことがある */
interface FlagsResponseBody {
  item?: unknown;
}

export interface TenmatsuClient {
  /** 疎通確認。トークンは送らない (プリフライトを増やさず、最初の1回を単純なGETに保つ) */
  health(): Promise<HealthPayload>;
  status(): Promise<StatusPayload>;
  list(): Promise<ListItem[]>;
  /** 実行を始める。すでに実行中 (409) はエラーにせず started:false で返す */
  run(options?: RunOptions): Promise<RunResult>;
  /**
   * 取得後の手作業の進捗 (実行予算入力済み・クラウド格納済み) を記録する。
   * 変えるフラグだけを渡す。1つも渡さないのは呼ぶ側の間違いなので、通信せずに例外にする。
   *
   * 記録はPCの processed.json に入るので、ブラウザのデータを消しても別の端末から見ても残る。
   * 戻り値は更新後の行。null は「保存はできたが更新後の行が受け取れなかった」で
   * 失敗ではない ＝ その場合は一覧を取り直すこと。
   */
  setFlags(denpyoNo: string, flags: FlagUpdate): Promise<ListItem | null>;
  filePdf(no: string): Promise<Blob>;
}

export function createTenmatsuClient(options: {
  token: string;
  /** テストから差し替える (グローバルの fetch には触らない) */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}): TenmatsuClient {
  const base = options.baseUrl ?? TENMATSU_BASE_URL;
  const doFetch = options.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  const call = async (
    path: string,
    opts: {
      auth: boolean;
      method?: "GET" | "POST";
      timeoutMs?: number;
      /**
       * JSONで送る本文。渡したときだけ Content-Type: application/json を付ける。
       * 「本文はあるが Content-Type が無い」組み合わせを作れないように1つの引数にまとめている
       * (サーバーはそれを 400 にせず、黙って既定値で動いてしまう)。
       */
      json?: unknown;
    },
  ): Promise<Response> => {
    // Headers ではなく素のオブジェクトで持つ (テストがそのまま中身を読めるように)
    const headers: Record<string, string> = {};
    if (opts.auth) headers[TOKEN_HEADER] = options.token;
    const body = opts.json === undefined ? undefined : JSON.stringify(opts.json);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    try {
      return await doFetch(`${base}${path}`, {
        method: opts.method ?? "GET",
        headers,
        body,
        // サーバーはキャッシュ用のヘッダーを返さないので、毎回取りに行かせる
        cache: "no-store",
        // Access-Control-Allow-Credentials を返さないサーバーなので include にはしない
        credentials: "omit",
        signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
      });
    } catch (e) {
      const timedOut = e instanceof DOMException && e.name === "TimeoutError";
      const { kind, message } = describeFailure(null, null, timedOut);
      throw new TenmatsuError(kind, null, message);
    }
  };

  /** !res.ok を TenmatsuError にする ({error} を読めたら添える) */
  const fail = async (res: Response): Promise<TenmatsuError> => {
    let serverError: string | null = null;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body?.error === "string") serverError = body.error;
    } catch {
      // JSONでない応答 (何かに差し替えられた場合など) はステータスだけで判断する
    }
    const { kind, message } = describeFailure(res.status, serverError);
    return new TenmatsuError(kind, res.status, message);
  };

  const getJson = async <T>(path: string, auth = true): Promise<T> => {
    const res = await call(path, { auth });
    if (!res.ok) throw await fail(res);
    return (await res.json()) as T;
  };

  return {
    health: () => getJson<HealthPayload>("/health", false),
    status: () => getJson<StatusPayload>("/status"),
    list: async () => {
      const body = await getJson<{ items?: unknown }>("/list");
      return Array.isArray(body.items) ? body.items.filter(isListItemLike) : [];
    },
    run: async (opts = {}) => {
      // 指定されたキーだけを入れる。null を送るとサーバーは「未指定」と同じに扱うので
      // (server.py の `is not None` 判定)、省略と区別が付かなくなる
      const body: { max_per_run?: number; headless?: boolean } = {};
      if (opts.maxPerRun !== undefined) {
        // NaN や小数は JSON.stringify が null にしてしまい、サーバーは既定値で走る
        // ＝ 指定した件数が黙って無視される。範囲 (1〜100) の判定はサーバーに任せ、
        // ここでは「値の意味が変わってしまう形」だけを弾く
        if (!Number.isInteger(opts.maxPerRun)) {
          throw new TenmatsuError("badRequest", null, RUN_COUNT_FORMAT_MESSAGE);
        }
        body.max_per_run = opts.maxPerRun;
      }
      if (opts.headless !== undefined) body.headless = opts.headless;

      // Content-Type を付けるのでプリフライトが飛ぶが、往復は増えない。
      // X-Tenmatsu-Token は CORS の安全なヘッダーではないので /list /status /file /run は
      // 元々プリフライトしている。サーバーは Allow-Headers に Content-Type と
      // X-Tenmatsu-Token の両方を返す。トークンも本文も要らない /health だけが単純リクエスト
      const res = await call("/run", { auth: true, method: "POST", json: body });
      if (!res.ok && res.status !== 409) throw await fail(res);
      let parsed: RunResponseBody = {};
      try {
        parsed = (await res.json()) as RunResponseBody;
      } catch {
        // 下で status が無いものとして扱う
      }
      if (!parsed.status) {
        throw new TenmatsuError(
          res.status === 409 ? "conflict" : "unknown",
          res.status,
          res.status === 409
            ? "すでに実行中です"
            : "実行を開始できたか確認できませんでした。「一覧を再読み込み」で状態を確かめてください",
        );
      }
      // 200 でも、すぐ失敗して state が done/error になっていることがある
      return {
        started: res.ok,
        status: parsed.status,
        // 古いサーバーは本文を読み捨てるので返ってこない ＝ 指定した件数は効いていない
        maxPerRun: typeof parsed.max_per_run === "number" ? parsed.max_per_run : null,
        headless: typeof parsed.headless === "boolean" ? parsed.headless : null,
      };
    },
    setFlags: async (denpyoNo, flags) => {
      const body: { denpyo_no: string; budget_entered?: boolean; cloud_stored?: boolean } = {
        denpyo_no: denpyoNo,
      };
      // false も送る (チェックを外して押し間違いを戻せるようにする)。
      // null は「値は変えずに更新日時だけ動かす」扱いになるので送らない ＝ 未指定はキーごと落とす
      if (flags.budget_entered !== undefined) body.budget_entered = flags.budget_entered;
      if (flags.cloud_stored !== undefined) body.cloud_stored = flags.cloud_stored;
      // フラグを1つも入れずに送るとサーバーは 400 を返す (何もしない、ではない)。
      // 手元で分かる間違いなので、通信する前に弾く
      if (body.budget_entered === undefined && body.cloud_stored === undefined) {
        throw new TenmatsuError("badRequest", null, EMPTY_FLAGS_MESSAGE);
      }
      const res = await call("/flags", { auth: true, method: "POST", json: body });
      if (!res.ok) throw await fail(res);
      let parsed: FlagsResponseBody = {};
      try {
        parsed = (await res.json()) as FlagsResponseBody;
      } catch {
        // item が無いものとして扱う (保存自体は成功している)
      }
      // サーバーは item を null で返せる (更新後の行を引き当てられなかったとき)。
      // 保存は済んでいるので失敗にはしない。呼ぶ側は null なら一覧を取り直す
      return isListItemLike(parsed.item) ? parsed.item : null;
    },
    filePdf: async (no) => {
      // トークンはヘッダーだけ。クエリには載せない (URLは履歴やログに残るため)
      const res = await call(`/file?no=${encodeURIComponent(no)}`, {
        auth: true,
        timeoutMs: FILE_TIMEOUT_MS,
      });
      if (!res.ok) throw await fail(res);
      // Content-Disposition は Access-Control-Expose-Headers が無いので読めない。
      // 表示名は /list の file を使うこと
      return await res.blob();
    },
  };
}
