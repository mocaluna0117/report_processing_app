import type { KindId, RakurakuCode, RouteId } from "@/lib/rakuraku/protocol";

/**
 * 「画面の下見」の記録の形と、開発者へ貼ってもらう文面。純関数のみ（ブラウザ・Node どちらでも動く）。
 *
 * ★ここに入れてよいのは**画面の作り**だけ。伝票の中身・伝票No.・氏名・金額・テナントの URL は入れない。
 *   表は見出し行だけを読み、値の入った行は読まない（lib/rakuraku/survey.ts）。
 * ★アカウントによって楽楽精算の画面が違う（「閲覧」タブが無い人がいる）ので、
 *   その人の画面の作りを本人に集めてもらい、開発者が設定を直すための材料にする。
 */

/** 数字を伏せる（伝票No.・金額が紛れ込まないように） */
export function redact(text: string, max = 40): string {
  return text
    .replace(/[\s　]+/g, " ")
    .replace(/\d{3,}/g, "#")
    .trim()
    .slice(0, max);
}

/** URL のうち、記録してよい問い合わせ部分（画面の種類を決めるものだけ値を残す） */
export const QUERY_WHITELIST = ["workflowId", "refId", "tmpFlg", "dispNo", "prevDispNo"] as const;

/**
 * 問い合わせ部分を、白名簿のものは `key=値`、それ以外は**キー名だけ**にする。
 * ★伝票No.は `eDenpyoNo` のような名前で入るので、値は決して残さない。
 */
export function pickQuery(search: string, whitelist: readonly string[] = QUERY_WHITELIST): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const parts: string[] = [];
  for (const [key, value] of params) {
    const safeKey = redact(key, 24);
    parts.push(whitelist.includes(key) ? `${safeKey}=${redact(value, 16)}` : `${safeKey}=…`);
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

/**
 * テナントの URL を落として、テナントの中の場所だけにする。
 * ★会社ごとの情報（テナントのホスト）を報告に入れないため。テナントの外は場所も書かない。
 */
export function relativeTenantPath(url: string, loginUrl: string): string {
  let target: URL;
  let base: URL;
  try {
    target = new URL(url);
    base = new URL(loginUrl);
  } catch {
    return "(URLを読めません)";
  }
  if (target.origin !== base.origin) return "(テナント外)";
  const dir = base.pathname.replace(/[^/]*$/, "");
  const path = target.pathname.startsWith(dir) ? target.pathname.slice(dir.length) : target.pathname;
  return `${path || "/"}${pickQuery(target.search)}`;
}

/** 画面の要素1つ（押せるもの）。★文字は redact 済み */
export interface SurveyElement {
  text: string;
  /** テナントの中の場所（href があるものだけ） */
  path: string | null;
  onclick: string;
  visible: boolean;
  frame: string;
  /** その要素を隠している先祖の目印（隠れているときだけ） */
  hiddenBy?: string;
  /** near の文字を含む先祖までの段数 */
  nearDepth?: number | null;
  /** 先祖6段の目印（tag#id.class） */
  ancestors?: string[];
}

/** 種類ごとの「一覧」ボタンの候補 */
export interface SurveyMenuGroup {
  kind: KindId;
  label: string;
  candidates: SurveyElement[];
}

/** 一覧を直接開いてみた結果 */
export interface SurveyProbeResult {
  kind: KindId;
  route: RouteId;
  routeLabel: string;
  /** ok＝一覧の表が出た、empty＝伝票が0件、skipped＝時間切れで未実施、それ以外は失敗の符号 */
  outcome: "ok" | "empty" | "skipped" | RakurakuCode;
  message: string | null;
  /** 着いた画面（テナントの中の場所） */
  path: string | null;
  title: string;
  hasListTable: boolean;
  /** 一覧の見出し行の文字（★値の行は読まない） */
  headers: string[];
  rowCount: number;
  /** 件数表示（数字は # にする） */
  pagerPattern: string | null;
  pageFeedCount: number;
  /** 先頭の行のリンク（場所と、問い合わせ部分のキー名だけ） */
  detailLinkPath: string | null;
  /** 伝票画面の目印がいくつ当たったか（設定が合っているかの手がかり） */
  markerHits: Record<string, number>;
}

/** 伝票画面の作り（1件だけ開いて数えたもの） */
export interface SurveyDetailResult {
  kind: KindId;
  route: RouteId;
  path: string | null;
  /** 部品の数（可視／全体） */
  selectors: { selector: string; total: number; visible: number }[];
  /** 「ラベル→値」の表のラベルだけ（★値は読まない） */
  labels: string[];
  message: string | null;
}

export interface SurveyReport {
  /** 下見をした日時（ISO・秒まで） */
  at: string;
  /** トップ画面 */
  home: { path: string; title: string; frames: string[] };
  department: { hasSelect: boolean; count: number; applied: string | null; message: string | null };
  /** 画面に出ている押せるもの（上部タブ・メニュー） */
  menus: SurveyElement[];
  /** 「ワークフロー」を押したあとに増えたもの（サブタブ） */
  afterWorkflow: SurveyElement[];
  /** 種類ごとの「一覧」ボタンの候補 */
  lists: SurveyMenuGroup[];
  /** 下見の中で押したものの文字（★押してよいものだけ） */
  clicked: string[];
  probes: SurveyProbeResult[];
  details: SurveyDetailResult[];
  /** 途中で起きた失敗（下見は止めずに続ける） */
  notes: string[];
}

const line = (el: SurveyElement): string => {
  const where = el.path ? ` → ${el.path}` : "";
  const click = el.onclick ? ` [onclick: ${el.onclick}]` : "";
  const hidden = el.visible ? "" : `（隠れています${el.hiddenBy ? `: ${el.hiddenBy}` : ""}）`;
  const near = el.nearDepth === undefined || el.nearDepth === null ? "" : `（近さ ${el.nearDepth}）`;
  const ancestors = el.ancestors && el.ancestors.length > 0 ? `\n      場所: ${el.ancestors.join(" > ")}` : "";
  return `  - ${el.text || "(文字なし)"}${where}${click}${hidden}${near} @${el.frame}${ancestors}`;
};

/** 開発者へ貼ってもらう文面 */
export function formatSurveyReport(report: SurveyReport): string {
  const out: string[] = [];
  out.push("# 楽楽精算の画面の下見");
  out.push("");
  out.push("この文面に、伝票の内容・伝票No.・氏名・金額・楽楽精算のURLは含まれていません。");
  out.push("（表は見出しだけ、URLは会社の場所を外した中の場所だけを記録しています）");
  out.push(`日時: ${report.at}`);
  out.push("");

  out.push("## トップ画面");
  out.push(`場所: ${report.home.path}`);
  out.push(`題名: ${report.home.title || "(なし)"}`);
  out.push(`フレーム: ${report.home.frames.join(" / ") || "(なし)"}`);
  out.push(
    `部門の切り替え: ${report.department.hasSelect ? `あり（${report.department.count}件）` : "なし"}` +
      (report.department.applied ? ` / 選んだ部門: ${report.department.applied}` : "") +
      (report.department.message ? ` / ${report.department.message}` : ""),
  );
  out.push("");

  out.push("## 画面に出ているメニュー");
  out.push(...(report.menus.length > 0 ? report.menus.map(line) : ["  (見つかりませんでした)"]));
  out.push("");

  if (report.afterWorkflow.length > 0) {
    out.push("## 「ワークフロー」を押したあとに増えたもの");
    out.push(...report.afterWorkflow.map(line));
    out.push("");
  }

  out.push("## 種類ごとの「一覧」の候補");
  for (const group of report.lists) {
    out.push(`### ${group.label}`);
    out.push(...(group.candidates.length > 0 ? group.candidates.map(line) : ["  (見つかりませんでした)"]));
  }
  out.push("");

  out.push("## 一覧を直接開いてみた結果");
  for (const probe of report.probes) {
    out.push(`### ${probe.routeLabel} / ${probe.kind}`);
    out.push(`  結果: ${probe.outcome}${probe.message ? `（${probe.message}）` : ""}`);
    out.push(`  着いた場所: ${probe.path ?? "(不明)"} / 題名: ${probe.title || "(なし)"}`);
    out.push(`  一覧の表: ${probe.hasListTable ? "あり" : "なし"} / 行数: ${probe.rowCount}`);
    out.push(`  見出し: ${probe.headers.join(" | ") || "(読めません)"}`);
    out.push(`  件数表示: ${probe.pagerPattern ?? "(なし)"} / ページ送りの要素: ${probe.pageFeedCount}`);
    out.push(`  伝票へのリンク: ${probe.detailLinkPath ?? "(なし)"}`);
    const hits = Object.entries(probe.markerHits)
      .map(([marker, n]) => `${marker}=${n}`)
      .join(" / ");
    out.push(`  伝票画面の目印の当たり: ${hits || "(なし)"}`);
  }
  out.push("");

  if (report.details.length > 0) {
    out.push("## 伝票画面の作り（1件だけ開いて数えたもの）");
    for (const detail of report.details) {
      out.push(`### ${detail.kind} / ${detail.route}`);
      out.push(`  場所: ${detail.path ?? "(不明)"}${detail.message ? `（${detail.message}）` : ""}`);
      for (const s of detail.selectors) out.push(`  ${s.selector}: ${s.total}個（見えているもの ${s.visible}個）`);
      out.push(`  項目のラベル: ${detail.labels.join(" | ") || "(読めません)"}`);
    }
    out.push("");
  }

  out.push("## 下見の中で押したもの");
  out.push(report.clicked.length > 0 ? `  ${report.clicked.join(" → ")}` : "  (何も押していません)");
  out.push("");

  if (report.notes.length > 0) {
    out.push("## 途中で起きたこと");
    out.push(...report.notes.map((n) => `  - ${n}`));
    out.push("");
  }

  out.push("## この文面に入れていないもの");
  out.push("  伝票の内容・伝票No.・氏名・金額・表の値・楽楽精算のURL（会社の場所）");
  return out.join("\n");
}
