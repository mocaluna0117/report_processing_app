/**
 * 顛末書・専決決裁書・捺印決裁書の画面の「手順」と「押せない理由」。純関数のみ。
 *
 * ★この画面は「保存先フォルダー → 楽楽精算にログイン → 部門 → 取得」の順に進むが、枠が同じ見え方で
 *   並ぶので、初めての人には順番も、取得ボタンが押せない理由も分からなかった。ここで段と理由を決め、
 *   画面（components/tenmatsu/tenmatsu-folder-page.tsx）は描くだけにする。
 * ★取得ボタンの可否 canStartRun は**画面にあった式をそのまま移したもの**。理由 runBlockedReason と
 *   食い違うと「押せないのに理由が出ない」に戻るので、tests/tenmatsu-flow.test.ts で総当たりに確かめる。
 */
import { type FlowPlan, type FlowStepDef, type StepEval, resolveFlow } from "@/lib/flow-steps";
import { RAKURAKU_CHIP_ID } from "@/lib/rakuraku-login-dialog";
import type { DocKind, DocKindId } from "@/lib/tenmatsu/kinds";
import { LOCAL_KINDS } from "@/lib/tenmatsu/local/kind-config";
import { FOLDER_UNSUPPORTED_TEXT } from "@/lib/tenmatsu/local/folder-handle";
import type { FolderConnection } from "@/lib/tenmatsu/local/session";

export interface TenmatsuFlowInput {
  kind: DocKind;
  /** このブラウザで保存先フォルダーを使えるか */
  supported: boolean;
  /** 前回の内容の読み込みが終わったか */
  restored: boolean;
  /** 前に選んだフォルダーを覚えているか */
  hasHandle: boolean;
  handleName: string | null;
  connection: FolderConnection;
  /** フォルダーに繋がって読み書きできるか */
  connected: boolean;
  loggedIn: boolean;
  loginBusy: boolean;
  /** 部門の数。null = まだ読み込んでいない、0 = 切り替えが無いアカウント */
  departmentCount: number | null;
  /** 選んでいる部門の表示名。未選択は null */
  deptLabel: string | null;
  /** 部門を読めなかった（自動のやり直しも失敗した）。読み直しと「指定せず」の導線を出す */
  departmentFailed: boolean;
  /** 利用者が「部門を指定せずに取得する」を選んだ。★取得では deptCode を null で送る */
  departmentSkipped: boolean;
  running: boolean;
  /** 別の種類の取得が動いていれば、その種類 */
  otherRunKind: DocKindId | null;
  itemCount: number;
  /** ログインIDをこのブラウザに保存してあるか（初回かどうかの判定に使う） */
  userIdSaved: boolean;
}

/** 段の定義。飛び先の id は種類ごとに分ける（3つのタブが同じ部品を使うため） */
export function tenmatsuStepDefs(kind: DocKind): FlowStepDef[] {
  const label = kind.label;
  const lastDescription =
    kind.id === "natsuin"
      ? "取得した直後はすべて「アップロード待ち」です。一覧の「書類を足す」から書類を入れて確定すると、保存先フォルダーに入ります。"
      : kind.id === "tenmatsu"
        ? "取得したPDFは保存先フォルダーにあります。実行予算の入力とクラウド格納が済んだら、一覧の右端の印を押して記録します。"
        : "取得したPDFは保存先フォルダーにあります。クラウド格納が済んだら、一覧の右端の印を押して記録します。";
  return [
    {
      id: "folder",
      label: "保存先フォルダー",
      description: `Folio の共有フォルダーを選び、ブラウザに聞かれたら「許可」を選びます (3種類とも1回で済みます)。`,
      targetId: `${kind.id}-folder`,
    },
    {
      id: "login",
      label: "楽楽精算にログイン",
      description:
        "ご自分の楽楽精算のログインIDとパスワードを入れます。失敗しても自動でやり直しません (アカウントがロックされるため)。",
      // ★入力欄はモーダルに移したので、行き先は画面の欄ではなくヘッダーの表示（押すとモーダルが開く）
      targetId: RAKURAKU_CHIP_ID,
    },
    {
      id: "dept",
      label: "部門を選ぶ",
      description:
        "選べる部門を楽楽精算から自動で読み込みます。切り替えが無いアカウント（「閲覧」タブが無い方）は、何もせずに通り過ぎます。",
      targetId: `${kind.id}-run`,
    },
    {
      id: "run",
      label: `${label}を取得`,
      description: `1回に取る件数 (1〜100) を確かめて「${label}を取得」を押します。1件あたり10秒ほどかかります。`,
      targetId: `${kind.id}-run`,
    },
    {
      id: "list",
      label: "一覧で確認",
      description: lastDescription,
      targetId: `${kind.id}-list`,
    },
  ];
}

/**
 * 部門の段が片付いているか。
 *
 * ★「部門を指定せず」が効くのは**部門を読めていないときだけ**。選択肢が読めているのに指定せずに進むと、
 *   取得の開始時に applyDepartment（lib/rakuraku/navigation.ts）が止める。押せるのに必ず失敗するボタンは出さない。
 * ★canStartRun と runBlockedReason が食い違うと「押せないのに理由が出ない」に戻るので、判定はこの1か所だけ。
 */
function departmentReady(input: TenmatsuFlowInput): boolean {
  if (input.departmentCount === null) return input.departmentSkipped;
  return input.departmentCount === 0 || input.deptLabel !== null;
}

/** 取得を始められるか。★画面にあった canRun の式をそのまま移したもの（部門の判定だけ上にまとめた） */
export function canStartRun(input: TenmatsuFlowInput): boolean {
  return (
    input.connected &&
    input.loggedIn &&
    departmentReady(input) &&
    !input.running &&
    input.otherRunKind === null &&
    input.restored
  );
}

/**
 * 取得の欄に出す「何を1つのPDFにするか」の1文と、その続き。
 *
 * ★以前はここに5文（捺印は flowNote と合わせて約520字）が常に並んでいて読み飛ばされていた。
 *   要点1文だけを常に出し、保留・動画・保護のかかったPDFの話は「くわしく」に入れる
 *   （利用者の決定 2026-09-21）。★保留の決まりは畳んでも必ず残す。
 */
export function composeSummary(kind: DocKind): string {
  return LOCAL_KINDS[kind.id].composed
    ? `${kind.label}の本体と、紐づく専決決裁書の本体・添付を1つのPDFにします (${kind.label}そのものの添付は使いません)。`
    : "添付のPDFと画像 (JPG・PNG) を本体と結合します。";
}

export function composeDetails(kind: DocKind): string[] {
  return [
    ...(LOCAL_KINDS[kind.id].composed
      ? ["専決決裁書から並べるのは、決定通知書 (無ければ見積総覧・見積：・写真) の添付です。"]
      : []),
    "開くのにパスワードが要らない保護のかかったPDFも結合できます。",
    `Excel・Word・PowerPoint・メールの添付は結合できないので、その${kind.label}は保留にし、結合できた分だけのPDFをフォルダーの _保留 に置いて、残りの取得は続けます。一覧の「${kind.text.resolveButton}」から、手でPDFにしたものを入れて確定してください (${kind.text.resolveNote})。`,
    "動画・音声は紙にできないので結合せず飛ばし、その行に「動画は未結合」と出します。",
  ];
}

/** 部門を読めなかったときに、取得ボタンの下へ出す理由 */
export const DEPT_READ_FAILED_BLOCK_TEXT =
  "部門を読み込めませんでした。「もう一度読み込む」か「部門を指定せずに取得する」を押してください";

/** 部門を読んでいる最中（画面が勝手に読みに行くので、利用者は待つだけでよい） */
export const DEPT_READING_TEXT = "部門を読み込んでいます。少しお待ちください";

export interface BlockedReasonText {
  text: string;
  /** その理由を直せる欄（押すとそこへ動く）。同じ欄の中にあるものは null */
  targetId: string | null;
  targetLabel: string | null;
}

/**
 * 取得ボタンが押せない理由。
 * ★押せないのに理由が出ない状態を作らない（部門が未選択・読み込み中は今まで無言だった）。
 */
export function runBlockedReason(input: TenmatsuFlowInput): BlockedReasonText | null {
  const folder = { targetId: `${input.kind.id}-folder`, targetLabel: "保存先フォルダーへ" };
  const rakuraku = { targetId: RAKURAKU_CHIP_ID, targetLabel: "ログイン" };
  const here = { targetId: null, targetLabel: null };
  if (input.running) return null; // ボタン自身が進み具合を出している
  if (!input.restored) return { text: "前回の内容を読み込んでいます…", ...here };
  // ★対応外のブラウザは「つないでください」では直せないので、先に理由を分ける
  //   （つながっていれば対応しているので、その組み合わせは見ない）
  if (!input.supported && !input.connected) return { text: FOLDER_UNSUPPORTED_TEXT, ...folder };
  if (!input.connected) return { text: "保存先フォルダーにつないでください", ...folder };
  if (!input.loggedIn) return { text: "楽楽精算にログインしてください", ...rakuraku };
  if (!departmentReady(input)) {
    if (input.departmentCount === null) {
      return { text: input.departmentFailed ? DEPT_READ_FAILED_BLOCK_TEXT : DEPT_READING_TEXT, ...here };
    }
    return { text: "部門を選んでください", ...here };
  }
  if (input.otherRunKind !== null) {
    return { text: `${otherLabel(input.otherRunKind)}の取得が動いています。終わってから始めてください`, ...here };
  }
  return null;
}

/** フォルダーのボタンが押せない理由（対応外のブラウザは別に大きく出しているので、ここでは出さない） */
export function folderBlockedReason(input: TenmatsuFlowInput): string | null {
  if (!input.restored) return "前回の内容を読み込んでいます…";
  if (input.running) return "取得中はフォルダーを変えられません";
  return null;
}

/** 一覧が空のときの文。★「まだ取得していない」と「フォルダーにつないでいない」を分ける */
export function listEmptyText(kind: DocKind, connected: boolean): string {
  return connected
    ? `まだ取得した${kind.label}はありません。上の「${kind.label}を取得」を押すと、ここに並びます。`
    : `保存先フォルダーにつなぐと、取得済みの${kind.label}がここに出ます。`;
}

/** 何も始めていない画面か（初回の案内を出すかどうか） */
export function isFreshTenmatsu(input: TenmatsuFlowInput): boolean {
  return input.restored && !input.hasHandle && !input.userIdSaved && !input.loggedIn && input.itemCount === 0;
}

const KIND_LABELS: Record<DocKindId, string> = {
  tenmatsu: "顛末書",
  senketsu: "専決決裁書",
  natsuin: "捺印決裁書",
};
const otherLabel = (id: DocKindId) => KIND_LABELS[id];

export function tenmatsuFlow(input: TenmatsuFlowInput): FlowPlan {
  const defs = tenmatsuStepDefs(input.kind);
  const label = input.kind.label;
  const ready = canStartRun(input);

  const folder: StepEval = !input.supported
    ? { kind: "blocked", hint: FOLDER_UNSUPPORTED_TEXT }
    : !input.restored
      ? { kind: "blocked", hint: "前回の内容を読み込んでいます。少しお待ちください" }
      : input.connected
        ? { kind: "done", ...(input.handleName ? { note: input.handleName } : {}) }
        : input.connection === "checking"
          ? { kind: "ready", hint: "フォルダーにつないでいます…" }
          : input.hasHandle
            ? {
                kind: "ready",
                hint: "「フォルダーにつなぐ」を押し、ブラウザに聞かれたら「許可」を選んでください",
              }
            : {
                kind: "ready",
                // ★フォルダーは共有フォルダー1つだけ選ぶ。書類ごとのフォルダーはその中に自動で作る
                hint: `「共有フォルダーを選ぶ」を押してください。その中に「${label}」を作って、PDFと記録を置きます`,
              };

  const login: StepEval = input.loggedIn
    ? { kind: "done" }
    : input.loginBusy
      ? { kind: "ready", hint: "ログインしています…", note: "ログイン中" }
      : {
          kind: "ready",
          // ★入力欄はモーダルに移した（2026-09-22）。押す場所を2つとも書く
          hint: "この段か、右上の「楽楽精算: 未ログイン」を押すとログインの画面が開きます。ログインIDとパスワードを入れてください",
        };

  const dept: StepEval = !input.loggedIn
    ? { kind: "ready", hint: "先に楽楽精算にログインしてください" }
    : input.departmentCount === null && input.departmentSkipped
      ? { kind: "done", note: "指定せず" }
      : input.departmentCount === 0
        ? { kind: "done", note: "切り替えなし" }
        : input.departmentCount === null
          ? {
              kind: "ready",
              hint: input.departmentFailed
                ? `部門を読み込めませんでした。「${label}の取得」の欄の「もう一度読み込む」か「部門を指定せずに取得する」を押してください`
                : DEPT_READING_TEXT,
            }
          : input.deptLabel === null
            ? { kind: "ready", hint: `「${label}の取得」の欄の「部門」で部門を選んでください` }
            : { kind: "done", note: input.deptLabel };

  const run: StepEval = input.running
    ? {
        kind: "ready",
        hint: "取得が終わるまでお待ちください。ほかの画面へ移っても続きますが、ブラウザのタブを閉じると止まります",
        note: "取得中…",
      }
    : input.otherRunKind !== null
      ? {
          kind: "blocked",
          hint: `${otherLabel(input.otherRunKind)}の取得が動いています。終わってから始めてください`,
        }
      : !ready
        ? { kind: "ready", hint: runBlockedReason(input)?.text ?? "" }
        : input.itemCount > 0
          ? { kind: "done" }
          : {
              kind: "ready",
              hint: `1回に取る件数を確かめて「${label}を取得」を押してください (1件あたり10秒ほどかかります)`,
            };

  const list: StepEval = {
    kind: "ready",
    hint: defs[4].description,
    ...(input.itemCount > 0 ? { note: `${input.itemCount}件` } : {}),
  };

  return resolveFlow(defs, [folder, login, dept, run, list], defs[4].description);
}
