/**
 * 問い合わせ（不具合・改善の要望を開発者へ送る）の規則と文面。純関数のみ。
 *
 * ★画面（components/contact-dialog.tsx）とサーバー（lib/contact/handle.ts）で同じ検査を使う。
 * ★送り先のアドレスはここに書かない（公開リポジトリ）。サーバーの環境変数 CONTACT_TO だけが持つ。
 * ★「inquiry」はアフター受付の意味で使っているので、こちらは contact と呼ぶ。
 */
import { POSTAL_CODE, type PersonalInfoKind, redactPii } from "@/lib/summarize/redact";
import type { SharedFolderState } from "@/lib/shared/status";
import { DOC_KINDS } from "@/lib/tenmatsu/kinds";

export const CONTACT_CATEGORIES = [
  { id: "bug", label: "不具合" },
  { id: "idea", label: "改善の要望" },
  { id: "question", label: "質問" },
  { id: "other", label: "その他" },
] as const;

export type ContactCategoryId = (typeof CONTACT_CATEGORIES)[number]["id"];

/** どの画面のことか（path が空は「どの画面でもない・分からない」） */
export const CONTACT_PAGES: readonly { path: string; label: string }[] = [
  { path: "/", label: "定期点検" },
  { path: "/after", label: "アフターメンテナンス" },
  ...DOC_KINDS.map((kind) => ({ path: kind.route, label: kind.menuLabel })),
  { path: "", label: "どの画面でもない・分からない" },
];

export const CONTACT_LIMITS = {
  messageChars: 4_000,
  nameChars: 50,
  photos: 3,
  /** 縮めたあとの1枚の上限 */
  photoBytes: 1_500_000,
  /** ★Vercel の関数が受け取れるのは 4.5MB まで。余裕を持たせる */
  totalBytes: 3_500_000,
  /** 写真の長い辺をここまで縮める */
  photoEdge: 1_600,
} as const;

/**
 * 一緒に送る情報。★**状態だけ**を持つ形にしてある（ログインID・フォルダーの名前・エラーの原文・
 * ファイル名は入る場所が無い）。
 */
export interface ContactDiagnostics {
  /** 「Chrome 140・Windows」のような短い名前 */
  browser: string;
  /** 「1920×1080」。読めなければ「不明」 */
  viewport: string;
  rakuraku: "ログイン中" | "未ログイン" | "不明";
  shared: SharedFolderState | "unknown";
}

export interface ContactPayload {
  category: ContactCategoryId;
  page: string;
  message: string;
  name: string;
  diagnostics: ContactDiagnostics;
}

const SHARED_STATES: readonly (SharedFolderState | "unknown")[] = [
  "unsupported",
  "none",
  "prompt",
  "connecting",
  "connected",
  "error",
  "unknown",
];

const SHARED_LABEL: Record<SharedFolderState | "unknown", string> = {
  unsupported: "このブラウザでは使えない",
  none: "未設定",
  prompt: "未接続",
  connecting: "つないでいる途中",
  connected: "接続済み",
  error: "つなげない",
  unknown: "不明",
};

/** 改行とタブ以外の制御文字を取り除く */
const stripControls = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
/** 1行にする（件名・名前。★改行が入るとメールの見出しを崩せるので必ず通す） */
export const oneLine = (s: string) => stripControls(s).replace(/[\r\n\t\u2028\u2029]+/g, " ").trim();

/** ブラウザの名前を短く（全文の User-Agent は長くて読みにくい） */
export function browserLabel(ua: string): string {
  const pick = (re: RegExp) => ua.match(re)?.[1] ?? null;
  const edge = pick(/Edg(?:e|A|iOS)?\/(\d+)/);
  const chrome = pick(/(?:Chrome|CriOS)\/(\d+)/);
  const firefox = pick(/(?:Firefox|FxiOS)\/(\d+)/);
  const safari = /Safari\//.test(ua) ? pick(/Version\/(\d+)/) : null;
  const browser = edge
    ? `Edge ${edge}`
    : chrome
      ? `Chrome ${chrome}`
      : firefox
        ? `Firefox ${firefox}`
        : safari
          ? `Safari ${safari}`
          : "不明なブラウザ";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /iPhone|iPad|iPod/.test(ua)
      ? "iPhone・iPad"
      : /Mac OS X|Macintosh/.test(ua)
        ? "macOS"
        : /Android/.test(ua)
          ? "Android"
          : /Linux/.test(ua)
            ? "Linux"
            : "不明なOS";
  return `${browser}・${os}`;
}

/** 画面で集める。★引数に無いもの（ID・名前）は入れようがない */
export function collectDiagnostics(input: {
  ua: string;
  width: number | null;
  height: number | null;
  /** null はまだ分からない */
  loggedIn: boolean | null;
  sharedState: SharedFolderState | null;
}): ContactDiagnostics {
  const size = (n: number | null) => (n !== null && Number.isFinite(n) && n > 0 ? Math.round(n) : null);
  const w = size(input.width);
  const h = size(input.height);
  return {
    browser: browserLabel(input.ua),
    viewport: w && h ? `${w}×${h}` : "不明",
    rakuraku: input.loggedIn === null ? "不明" : input.loggedIn ? "ログイン中" : "未ログイン",
    shared: input.sharedState ?? "unknown",
  };
}

/** お客様の情報らしき文字があったときの注意 */
export function personalInfoWarning(kinds: readonly PersonalInfoKind[]): string | null {
  if (kinds.length === 0) return null;
  return (
    `${kinds.join("・")}らしき文字があります。お客様の情報なら、消すか「伏せ字にする」を押してください` +
    "（ご自分の名前や、画面に出ている文言なら、そのままで構いません）。"
  );
}

/** 「伏せ字にする」。要約と同じ伏せ字に、郵便番号も足す */
export function redactContactText(text: string): string {
  return redactPii(text).replace(POSTAL_CODE, "（郵便番号）");
}

export interface ContactDraftView {
  message: string;
  name: string;
  photos: number;
  photoBytes: number;
  photosChecked: boolean;
  sending: boolean;
}

/** 「送信」を押せない理由（空なら押せる）。画面にそのまま出す */
export function contactBlockers(draft: ContactDraftView): string[] {
  const reasons: string[] = [];
  if (draft.sending) reasons.push("送っています");
  if (draft.message.trim() === "") reasons.push("内容を書いてください");
  if (draft.message.length > CONTACT_LIMITS.messageChars) {
    reasons.push(`内容は ${CONTACT_LIMITS.messageChars.toLocaleString()}字までです（いま ${draft.message.length.toLocaleString()}字）`);
  }
  if (draft.name.length > CONTACT_LIMITS.nameChars) reasons.push(`お名前は ${CONTACT_LIMITS.nameChars}字までです`);
  if (draft.photos > CONTACT_LIMITS.photos) reasons.push(`写真は ${CONTACT_LIMITS.photos}枚までです`);
  if (draft.photoBytes > CONTACT_LIMITS.totalBytes) reasons.push("写真が大きすぎます。枚数を減らしてください");
  if (draft.photos > 0 && !draft.photosChecked) {
    reasons.push("写真にお客様の情報が写っていないか確かめて、印を押してください");
  }
  return reasons;
}

export type SanitizeResult = { ok: true; payload: ContactPayload } | { ok: false; message: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * 受け取った中身を検査する（サーバーで必ず通す）。決まった値以外は受け付けない。
 * ★長すぎる本文は切らずに断る（黙って切ると、大事な後半が届かない）。
 */
export function sanitizeContactPayload(raw: unknown): SanitizeResult {
  if (!isRecord(raw)) return { ok: false, message: "中身を読めませんでした" };
  const category = CONTACT_CATEGORIES.find((c) => c.id === raw.category)?.id;
  if (!category) return { ok: false, message: "種類を選んでください" };
  const page = CONTACT_PAGES.find((p) => p.path === raw.page)?.path;
  if (page === undefined) return { ok: false, message: "画面を選び直してください" };
  const message = typeof raw.message === "string" ? stripControls(raw.message).trim() : "";
  if (message === "") return { ok: false, message: "内容を書いてください" };
  if (message.length > CONTACT_LIMITS.messageChars) {
    return { ok: false, message: `内容は ${CONTACT_LIMITS.messageChars.toLocaleString()}字までです` };
  }
  const name = typeof raw.name === "string" ? oneLine(raw.name).slice(0, CONTACT_LIMITS.nameChars) : "";

  const d = isRecord(raw.diagnostics) ? raw.diagnostics : {};
  const browser = typeof d.browser === "string" ? oneLine(d.browser).slice(0, 60) : "";
  const viewport = typeof d.viewport === "string" && /^\d{1,5}×\d{1,5}$/.test(d.viewport) ? d.viewport : "不明";
  const rakuraku = d.rakuraku === "ログイン中" || d.rakuraku === "未ログイン" ? d.rakuraku : "不明";
  const shared = SHARED_STATES.find((s) => s === d.shared) ?? "unknown";

  return {
    ok: true,
    payload: {
      category,
      page,
      message,
      name,
      diagnostics: { browser: browser || "不明なブラウザ", viewport, rakuraku, shared },
    },
  };
}

const categoryLabel = (id: ContactCategoryId) => CONTACT_CATEGORIES.find((c) => c.id === id)?.label ?? id;
const pageLabel = (path: string) => CONTACT_PAGES.find((p) => p.path === path)?.label ?? "不明な画面";

/** 件名。★1行にしてから組み立てる（改行で見出しを崩させない） */
export function contactSubject(payload: ContactPayload): string {
  const head = oneLine(payload.message).slice(0, 30);
  return oneLine(`[Folio] ${categoryLabel(payload.category)}: ${pageLabel(payload.page)} — ${head}`).slice(0, 120);
}

/** 日時の表示（日本時間） */
function formatJst(at: number): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}/${Number(get("month"))}/${Number(get("day"))} ${get("hour")}:${get("minute")}`;
}

export interface ContactMeta {
  /** コミットの先頭7文字（サーバーが自分で書き足す。分からなければ null） */
  version: string | null;
  /** production / preview / development */
  environment: string | null;
  at: number;
  photos: number;
}

/** 一緒に送る情報の行（画面の「一緒に送る情報」とメールで同じものを出す） */
export function diagnosticsLines(d: ContactDiagnostics): string[] {
  return [
    `ブラウザ: ${d.browser}`,
    `画面の大きさ: ${d.viewport}`,
    `楽楽精算: ${d.rakuraku}`,
    `共有フォルダー: ${SHARED_LABEL[d.shared]}`,
  ];
}

/** メールの本文（テキストだけ。HTML にはしない） */
export function buildContactText(payload: ContactPayload, meta: ContactMeta): string {
  const rule = "────────────────";
  const version = meta.version
    ? `${meta.version.slice(0, 7)}${meta.environment ? ` (${meta.environment})` : ""}`
    : "不明";
  return [
    `種類: ${categoryLabel(payload.category)}`,
    `画面: ${pageLabel(payload.page)}${payload.page ? ` (${payload.page})` : ""}`,
    `お名前: ${payload.name || "（未記入）"}`,
    rule,
    payload.message,
    rule,
    "一緒に送った情報（お客様の情報は含みません）",
    `Folio の版: ${version}`,
    ...diagnosticsLines(payload.diagnostics),
    `送信: ${formatJst(meta.at)}（日本時間）`,
    `写真: ${meta.photos}枚`,
  ].join("\n");
}

/** 送れなかったときに「文面をコピー」で渡す文（開発者へ手で送ってもらう） */
export function contactCopyText(payload: ContactPayload, at: number): string {
  return `${contactSubject(payload)}\n\n${buildContactText(payload, { version: null, environment: null, at, photos: 0 })}`;
}
