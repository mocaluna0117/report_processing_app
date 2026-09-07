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

/**
 * 結合できなかった添付1つ。
 * index は元の添付の位置 (本体が 0)。確定するときに files[].index で送り返す。
 */
export interface MissingAttachment {
  index: number;
  name: string;
  reason: string;
  /**
   * 利用者があとからアップロードする書類の置き場か (捺印決裁書)。
   * true の欠けは「結合できなかった」のではなく**最初から入れる前提**のもので、
   * これが残ったままでは確定できない (サーバーが断る)。無い＝古いサーバー。
   */
  awaiting?: boolean;
  /**
   * その枠にいま入っているファイル (並び順)。あとからアップロードする枠だけが返す。
   * ★無い＝**1つしか入れられない古いサーバー**。複数を送っても最後の1つしか残らないので、
   *   この項目が無いときは画面でも1つに制限する (allowsMultiple)。
   */
  files?: UploadedFile[];
  /**
   * 1つだけ入る枠 (結合できなかった添付) に、すでに入れてあるファイル。
   * 入れ直したのに結合できなかったときに返る。選び直さなくても確定できる。
   */
  filled?: { name: string; size: number | null } | null;
  /**
   * 入れなくても確定できる枠か（差し替えのときの「欠けたまま確定した添付」）。
   * ★folio の中だけで付ける印。サーバーは返さない。
   */
  optional?: boolean;
}

/** 枠に入っているファイル1つ。file はPC側の実ファイル名 (残すときに keep で送り返す) */
export interface UploadedFile {
  file: string;
  name: string;
  size: number | null;
  /**
   * いま /file で返るPDFに、このファイルが入れているページ数。
   * null＝まだ入っていない (入れただけで結合前) / 分からない。無い＝古いサーバー。
   */
  pages?: number | null;
}

/**
 * いま /file で返るPDFの内訳1つ (返る順に並ぶ)。
 * 「PDFのどのページが誰のものか」が分かるので、ダイアログの中で入れた書類を
 * その位置に差し込んで「確定後の姿」を見せられる (lib/tenmatsu/preview.ts)。
 * file が付くのは枠に入っている書類だけ (keep で送り返す名前と同じ)。
 */
export interface PdfLayoutEntry {
  index: number;
  name: string | null;
  file?: string;
  pages: number;
}

/** 確定した伝票の「あとからアップロードする枠」と、いま入っている書類 */
export interface UploadSlot {
  index: number;
  name: string;
  files: UploadedFile[];
}

/** 取得中にPCのコンソールへ出た1行 */
export interface RunLogLine {
  /** 1から増える通し番号。次に取りに行く位置 (since) に使う */
  seq: number;
  text: string;
}

/** GET /status の中身 (下の2つ以外の10個は常に揃う) */
export interface StatusPayload {
  /**
   * 実行中 / 最後に実行した書類の種類。
   * 無い＝この項目に未対応の古いサーバー。
   */
  kind?: string | null;
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
  /**
   * これまでにPCのコンソールへ出た行数。**無い＝この機能に未対応の古いサーバー**
   * (version では判定しない。既存の作法に合わせてキーの有無で見る)。
   * 次に取りに行く since はこの値を使う (最後の行の seq ではない)。
   */
  log_seq?: number;
  /**
   * since より後のコンソール出力。**?since= を付けて呼んだときだけ入る**
   * (/run の応答と since 無しの /status には入らない)。
   */
  log?: RunLogLine[];
  /**
   * この実行で添付を結合できず保留にした伝票。無い＝この機能に未対応の古いサーバー。
   * 完了の1行に件数を出す。
   */
  pending?: { denpyo_no: string; missing: string[]; awaiting?: boolean }[];
  /**
   * 本体PDFを取れず見送った伝票。記録に残らないので**次回の取得でやり直される**
   * （一覧には出ない）。無い＝この機能に未対応の古いサーバー。
   */
  skipped?: string[];
}

/**
 * 画面から切り替えられる完了フラグ。
 * **全種類の既知のキーを並べた閉じた合併**にしておく (string にはしない)。
 * 種類ごとに使うキーは違う (顛末書は2つ、専決決裁書はクラウドだけ) が、
 * 綴り違いはここで型に落ちるようにする。
 */
export type FlagKey = "budget_entered" | "cloud_stored";
export const FLAG_KEYS: readonly FlagKey[] = ["budget_entered", "cloud_stored"];
/** 顛末書のフラグ (hasFlags の既定。種類を渡さない呼び出しは顛末書とみなす) */
export const TENMATSU_FLAG_KEYS: readonly FlagKey[] = ["budget_entered", "cloud_stored"];

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
  /**
   * ここから下の6つは楽楽精算の一覧から読んだ値で、**古い記録には入っていない**
   * (サーバーが null を返す)。画面では空欄にする。folio では加工しない。
   */
  /** 申請日。一覧に日付しか無いので "2026/09/01" の形 (時刻は取れない) */
  shinsei_date?: string | null;
  /** 申請者 */
  shinseisha?: string | null;
  /** 支払金額(税込)。表示のままの文字列 (例 "71,500 円") */
  amount?: string | null;
  /** 支払先 */
  payee?: string | null;
  /** 物件名 (一覧の「どこで」から取り出した値)。**施主名を含むことがある** */
  property_name?: string | null;
  /** 最終承認日。サーバー側が未実装なのでいまは常に null */
  final_approved_at?: string | null;
  /** 表題。専決決裁書だけが返す (顛末書には無い項目) */
  title?: string | null;
  /** 内容。捺印決裁書だけが返す */
  content?: string | null;
  /** 紐づく専決決裁書の伝票No.。捺印決裁書だけが返す */
  senketsu_no?: string | null;
  /**
   * 動画・音声のため結合しなかった添付の名前。
   * 空・無しは「飛ばしたものは無い」。PDFに入っていない中身があることを画面に出す。
   */
  skipped_attachments?: string[] | null;
  /**
   * PJ (契約番号 10桁)。伝票画面の「どこで」のすぐ下の行から読んだ値。
   * アフターメンテナンスのお客様の情報とは**この上8桁**で突き合わせる。
   */
  pj?: string | null;
  /**
   * 添付を結合できず保留中か。
   * PDFはPCの _保留 フォルダにあり、正式なフォルダにはまだ入っていない。
   * 印は変えられない (サーバーが 409)。無い＝古いサーバー・古いキャッシュ。
   */
  pending?: boolean;
  /** 結合できなかった添付。保留中の行と、欠けたまま確定した行の両方に入る */
  missing_attachments?: MissingAttachment[] | null;
  /** アップロードして補った添付の名前 */
  replaced_attachments?: string[] | null;
  /**
   * 確定したあとでも入れた書類を差し替えられる種類 (捺印決裁書) の、いまの中身。
   * undefined＝差し替えに未対応のサーバー・古いキャッシュ。
   * null＝部品が残っていない記録 (この機能より前に確定したもの) で差し替えられない。
   */
  upload_slots?: UploadSlot[] | null;
  /** 書類を差し替えて組み直した日時。無ければ一度も差し替えていない */
  recomposed_at?: string | null;
  /**
   * いま /file で返るPDFの内訳 (ダイアログ内のプレビュー用)。
   * undefined＝未対応のサーバー・この項目より前のキャッシュ (一覧を再読み込みすると出ることがある)。
   * null＝その行では出せない (この機能より前の記録・内訳と実物が食い違う)。
   */
  pdf_layout?: PdfLayoutEntry[] | null;
  /** 監督。「どこで」の「監督：〇〇/営業：〇〇」から読んだ値 */
  supervisor?: string | null;
  /** 営業。同上 */
  sales_rep?: string | null;
}

/** GET /health (トークン不要) */
/** /health が返す「扱える書類の種類」1つ分 */
export interface HealthKind {
  kind: string;
  label: string;
  flag_keys: string[];
  file_prefix: string;
  save_dir: string;
  /** 確定したあとでも書類を差し替えられるか。無い＝差し替えに未対応のサーバー */
  keep_parts?: boolean;
}

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
  /**
   * このPCのツールが扱える書類の種類。
   * **この項目が無い＝種類に未対応の古いサーバー**。version では判定しない
   * (項目を増やしても version は 1 のままにする、という既存の決まりのため)。
   */
  kinds?: HealthKind[];
  /** 問い合わせた種類 (kind を付けなければ tenmatsu) */
  kind?: string;
  /** 実行中 / 最後に実行した種類 */
  job_kind?: string | null;
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
/**
 * 保留の確定はPC側で結合し直すので長めに取る。
 * Office の変換は1本 10〜30秒かかることがあり、添付が数本あると60秒では足りない。
 */
const PENDING_TIMEOUT_MS = 180_000;
/**
 * 1回に送れる添付の合計 (実体のバイト数)。
 * server.py の PENDING_BODY_MAX は base64 後の 80MB なので、その手前で止める。
 * ★サーバー側の定数と対で決めてある (片方だけ増やさないこと)。
 */
export const MAX_PENDING_UPLOAD_BYTES = 50 * 1024 * 1024;
export const EMPTY_PENDING_FILES_MESSAGE = "結合する添付が選ばれていません";

export type FailureKind =
  | "network" // fetch 自体が失敗した (原因は特定できない)
  | "timeout"
  | "auth" // 401
  | "badRequest" // 400
  | "notFound" // 404
  | "conflict" // 409
  | "tooLarge" // 413
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
    case 413:
      return {
        kind: "tooLarge",
        message:
          detail ?? "送るファイルが大きすぎます。ファイルを小さくするか、分けて確定してください",
      };
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
export function describeCompletion(
  status: StatusPayload,
  docLabel = "顛末書",
): Completion | null {
  if (status.state === "error") {
    const reason = status.error?.trim() || "原因不明";
    const log = status.error_file ? `。ログ: ${status.error_file}` : "";
    return { tone: "error", message: `エラーで停止しました (${reason})${log}` };
  }
  if (status.state !== "done") return null;
  // 保留があるのに「1件も無かった」と言うのは嘘なので、0件でも保存の形で出す。
  // ★あとから書類を入れる種類（捺印決裁書）は「結合できなかった」のではないので分けて数える
  const all = status.pending ?? [];
  const awaiting = all.filter((p) => p.awaiting === true).length;
  const held = all.length - awaiting;
  const missed = status.skipped?.length ?? 0;
  const tail =
    (missed > 0 ? ` (${missed}件は本体PDFを取れず見送り。次回やり直します)` : "");
  const base =
    // 全部がアップロード待ちなら「保存しました」ではなく「取得しました」と言う
    // （捺印決裁書は取得しただけでは保存されず、書類を入れて確定してから保存される）
    status.processed === 0 && held === 0 && awaiting > 0
      ? `${awaiting}件を取得しました (アップロード待ち)` + tail
      : status.processed > 0 || held > 0 || awaiting > 0 || missed > 0
        ? `${status.processed}件を保存しました` +
          (held > 0 ? ` (${held}件は添付を結合できず保留)` : "") +
          (awaiting > 0 ? ` (${awaiting}件はアップロード待ち)` : "") +
          tail
        : `新しく取得できる${docLabel}はありませんでした`;
  // remaining は「今回の残り」ではなく「1回の上限で見送った分」。黙って切り捨てない
  if (status.remaining > 0) {
    return {
      tone: "notice",
      message: `${base}。残り${status.remaining}件は次回実行してください (1回あたりの上限があります)`,
    };
  }
  // 保留・見送りは「あとでやることが残っている」ので、済んだ緑ではなく目に留まる色で出す
  return {
    tone: held > 0 || awaiting > 0 || missed > 0 ? "notice" : "ok",
    message: base,
  };
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
const isMissingAttachmentLike = (v: unknown): v is MissingAttachment => {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    Number.isInteger(o.index) &&
    typeof o.name === "string" &&
    typeof o.reason === "string" &&
    optionalBool(o.awaiting) &&
    (o.files === undefined ||
      (Array.isArray(o.files) && o.files.every(isUploadedFileLike))) &&
    (o.filled === undefined ||
      o.filled === null ||
      (typeof o.filled === "object" &&
        typeof (o.filled as Record<string, unknown>).name === "string"))
  );
};
const isUploadedFileLike = (v: unknown): v is UploadedFile => {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.file === "string" &&
    typeof o.name === "string" &&
    (typeof o.size === "number" || o.size === null || o.size === undefined) &&
    (Number.isInteger(o.pages) || o.pages === null || o.pages === undefined)
  );
};
const isPdfLayoutEntryLike = (v: unknown): v is PdfLayoutEntry => {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    Number.isInteger(o.index) &&
    (typeof o.name === "string" || o.name === null) &&
    (typeof o.file === "string" || o.file === undefined) &&
    Number.isInteger(o.pages)
  );
};
const isUploadSlotLike = (v: unknown): v is UploadSlot => {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    Number.isInteger(o.index) &&
    typeof o.name === "string" &&
    Array.isArray(o.files) &&
    o.files.every(isUploadedFileLike)
  );
};
const optionalText = (v: unknown): boolean =>
  v === undefined || v === null || typeof v === "string";

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
      o.flags_updated_at === null) &&
    // 楽楽精算の一覧から読んだ値。無い (古いサーバー・古いキャッシュ) のは正常
    optionalText(o.shinsei_date) &&
    optionalText(o.shinseisha) &&
    optionalText(o.amount) &&
    optionalText(o.payee) &&
    optionalText(o.property_name) &&
    optionalText(o.final_approved_at) &&
    optionalText(o.title) &&
    optionalText(o.content) &&
    optionalText(o.senketsu_no) &&
    optionalText(o.pj) &&
    optionalText(o.supervisor) &&
    optionalText(o.sales_rep) &&
    // 動画・音声のため結合しなかった添付の名前
    (o.skipped_attachments === undefined ||
      o.skipped_attachments === null ||
      (Array.isArray(o.skipped_attachments) &&
        o.skipped_attachments.every((x) => typeof x === "string"))) &&
    // 添付を結合できず保留中か / 結合できなかった添付 / 補った添付
    optionalBool(o.pending) &&
    (o.missing_attachments === undefined ||
      o.missing_attachments === null ||
      (Array.isArray(o.missing_attachments) &&
        o.missing_attachments.every(isMissingAttachmentLike))) &&
    (o.replaced_attachments === undefined ||
      o.replaced_attachments === null ||
      (Array.isArray(o.replaced_attachments) &&
        o.replaced_attachments.every((x) => typeof x === "string"))) &&
    // 確定したあとの差し替え (捺印決裁書)。無い＝未対応のサーバー・古いキャッシュ
    (o.upload_slots === undefined ||
      o.upload_slots === null ||
      (Array.isArray(o.upload_slots) && o.upload_slots.every(isUploadSlotLike))) &&
    optionalText(o.recomposed_at) &&
    // ダイアログ内プレビューの内訳。無い＝未対応のサーバー・古いキャッシュ
    (o.pdf_layout === undefined ||
      o.pdf_layout === null ||
      (Array.isArray(o.pdf_layout) && o.pdf_layout.every(isPdfLayoutEntryLike)))
  );
}

/**
 * その行の完了フラグが分かるか。
 * false は「PC側のサーバーが未対応」か「この機能より前のキャッシュ」で、
 * *フラグが未設定* という意味ではない (サーバーは未設定でも false を返す)。
 * 分からないものを false として扱わないために、判定はここを通す。
 */
export function hasFlags(
  item: ListItem,
  flagKeys: readonly FlagKey[] = TENMATSU_FLAG_KEYS,
): boolean {
  return flagKeys.every((key) => typeof item[key] === "boolean");
}

/**
 * 添付を結合できず保留中の行か。
 * undefined (古いサーバー・古いキャッシュ) は保留ではないとみなす。
 */
export function isPending(item: ListItem): boolean {
  return item.pending === true;
}

/**
 * バイト列を base64 にする。
 * ★0x8000 ずつに区切る。`String.fromCharCode(...bytes)` のように一度に展開すると、
 *   数十万バイトで「Maximum call stack size exceeded」になる (lib/auth.ts はその形)。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
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
export type FlagUpdate = Partial<Record<FlagKey, boolean>>;

/** 新しく入れるファイル1つ。index は /list の missing_attachments[].index */
export interface PendingNewFile {
  index: number;
  name: string;
  bytes: Uint8Array;
}

/**
 * その枠にいま入っているものを、この位置に残す指定。
 * keep は upload_slots[].files[].file (PC側の実ファイル名)。
 */
export interface PendingKeepFile {
  index: number;
  keep: string;
}

export type PendingFile = PendingNewFile | PendingKeepFile;

export const isPendingKeep = (f: PendingFile): f is PendingKeepFile => "keep" in f;

export interface PendingUpload {
  /**
   * 枠に入れる最終状態。★同じ index の並びがそのまま結合の順になる。
   * slots に入れた index は「この1回で最終状態を全部指定した」という意味で、
   * files にその index が1つも無ければ空にする (＝全部外す)。
   */
  files: PendingFile[];
  slots?: number[];
  /** 欠けたままでも確定するか (一覧に「添付が欠けています」と残る) */
  acceptMissing: boolean;
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
  /** since を渡すと、その番号より後のコンソール出力も一緒に取る */
  status(since?: number): Promise<StatusPayload>;
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
  /**
   * 保留中の伝票に添付を足して確定する。
   * 戻り値は setFlags と同じ規則で、null なら一覧を取り直すこと。
   */
  completePending(denpyoNo: string, upload: PendingUpload): Promise<ListItem | null>;
  /** 保留をやめる。次回の取得で取り直す (行は一覧から消える) */
  retryPending(denpyoNo: string): Promise<void>;
  /**
   * 確定した伝票を、入れた書類を入れ替えて組み直す (捺印決裁書)。
   * 同じ名前で上書きし、完了の印は外れる。失敗しても元のPDFはそのまま。
   */
  recomposePending(
    denpyoNo: string,
    files: PendingFile[],
    slots: number[],
  ): Promise<ListItem | null>;
  filePdf(no: string): Promise<Blob>;
}

export function createTenmatsuClient(options: {
  token: string;
  /**
   * 書類の種類。**顛末書では渡さない** (今までどおり kind を付けずに呼ぶ)。
   * 渡すと GET はクエリ、POST は本文に kind が入る。
   * ★client と保存先のキーは必ず同じ種類から作ること
   *   (取り違えると別の種類の一覧を上書き保存してしまう)。
   */
  kind?: string;
  /** テストから差し替える (グローバルの fetch には触らない) */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}): TenmatsuClient {
  const base = options.baseUrl ?? TENMATSU_BASE_URL;
  const kind = options.kind;
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
      json?: Record<string, unknown>;
    },
  ): Promise<Response> => {
    // Headers ではなく素のオブジェクトで持つ (テストがそのまま中身を読めるように)
    const headers: Record<string, string> = {};
    if (opts.auth) headers[TOKEN_HEADER] = options.token;
    // 種類を渡されたときだけ足す。顛末書 (kind なし) では
    // URLも本文も今までと1文字も変えない (古いサーバー・既存のテストのため)
    const url = kind
      ? `${base}${path}${path.includes("?") ? "&" : "?"}kind=${encodeURIComponent(kind)}`
      : `${base}${path}`;
    const payload =
      opts.json === undefined ? undefined : kind ? { ...opts.json, kind } : opts.json;
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    try {
      return await doFetch(url, {
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

  /** 送る前に大きさで断る。送ってから 413 を受けるより、理由が具体的に出せる */
  const checkUploadSize = (files: readonly PendingFile[]): void => {
    // 残すだけの指定 (keep) は中身を送らないので数えない
    const total = files.reduce((sum, f) => sum + (isPendingKeep(f) ? 0 : f.bytes.length), 0);
    if (total > MAX_PENDING_UPLOAD_BYTES) {
      throw new TenmatsuError(
        "tooLarge",
        null,
        `送るファイルの合計が大きすぎます (${formatFileSize(total)})。` +
          `1回に送れるのは ${formatFileSize(MAX_PENDING_UPLOAD_BYTES)} までです`,
      );
    }
  };

  /**
   * 確定 (complete) と差し替え (recompose) の送信。
   * 枠の最終状態は files の並びで決まる (同じ index を並べた順が結合の順)。
   */
  const sendPending = async (
    no: string,
    action: "complete" | "recompose",
    files: readonly PendingFile[],
    slots: readonly number[] | undefined,
    extra: Record<string, unknown>,
  ): Promise<ListItem | null> => {
    const res = await call("/pending", {
      auth: true,
      method: "POST",
      timeoutMs: PENDING_TIMEOUT_MS,
      json: {
        denpyo_no: no,
        action,
        ...extra,
        ...(slots && slots.length > 0 ? { slots: [...slots] } : {}),
        files: files.map((f) =>
          isPendingKeep(f)
            ? { index: f.index, keep: f.keep }
            : { index: f.index, name: f.name, data: bytesToBase64(f.bytes) },
        ),
      },
    });
    if (!res.ok) throw await fail(res);
    let parsed: { item?: unknown } = {};
    try {
      parsed = (await res.json()) as { item?: unknown };
    } catch {
      // 本文が読めなくても確定は済んでいる。呼ぶ側は null なら一覧を取り直す
    }
    return isListItemLike(parsed.item) ? parsed.item : null;
  };

  return {
    health: () => getJson<HealthPayload>("/health", false),
      // since を渡すと、その番号より後のコンソール出力も一緒に返る。
    // kind は call() が「?」の有無を見て & で足すので、ここでは付けない
    status: (since?: number) =>
      getJson<StatusPayload>(since === undefined ? "/status" : `/status?since=${since}`),
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
      const body: Record<string, unknown> = { denpyo_no: denpyoNo };
      // false も送る (チェックを外して押し間違いを戻せるようにする)。
      // null は「値は変えずに更新日時だけ動かす」扱いになるので送らない ＝ 未指定はキーごと落とす
      for (const key of FLAG_KEYS) {
        if (typeof flags[key] === "boolean") body[key] = flags[key];
      }
      // フラグを1つも入れずに送るとサーバーは 400 を返す (何もしない、ではない)。
      // 手元で分かる間違いなので、通信する前に弾く
      if (Object.keys(body).length === 1) {
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
    completePending: async (no, upload) => {
      checkUploadSize(upload.files);
      // 何も入れず、欠けたままの確定でもないなら送らない (サーバーは400)
      if (upload.files.length === 0 && !upload.acceptMissing && !upload.slots?.length) {
        throw new TenmatsuError("badRequest", null, EMPTY_PENDING_FILES_MESSAGE);
      }
      return await sendPending(no, "complete", upload.files, upload.slots, {
        accept_missing: upload.acceptMissing,
      });
    },
    recomposePending: async (no, files, slots) => {
      checkUploadSize(files);
      // ★枠は必ず slots で宣言する。全部外したときに files が空になり、
      //   宣言が無いと「触れていない枠」と区別できない（古い中身で組み直してしまう）
      return await sendPending(no, "recompose", files, slots, {});
    },
    retryPending: async (no) => {
      const res = await call("/pending", {
        auth: true,
        method: "POST",
        json: { denpyo_no: no, action: "retry" },
      });
      if (!res.ok) throw await fail(res);
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
