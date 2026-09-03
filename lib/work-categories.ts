/**
 * 工事区分の一覧 (転記先Excelで使う固定の分類)。
 *
 * TypeScript の enum ではなく readonly タプル + 派生型で定義している:
 * - 値そのものが日本語ラベルなので、enum の「名前⇄値」の二重管理が不要
 * - 配列として反復できる (UIのプルダウン・画像認識への選択肢提示にそのまま使える)
 * - `WorkCategory` 型で文字列リテラルとして型安全に扱える
 */
export const WORK_CATEGORIES = [
  "基礎",
  "外壁",
  "屋根",
  "樋",
  "外部金物",
  "サッシ",
  "玄関ドア",
  "軒天",
  "配管",
  "床仕上",
  "クロス",
  "内部建具",
  "内部建材",
  "外構",
  "玄関タイル",
  "床下",
  "ユニットバス",
  "キッチン",
  "洗面化粧台",
  "トイレ",
  "電気設備",
  "換気システム",
  "バルコニー",
  "小屋裏",
  "漏水",
  "雨漏り",
  "有償工事",
  "住宅設備",
  "点検時指摘",
  "その他",
] as const;

export type WorkCategory = (typeof WORK_CATEGORIES)[number];

const CATEGORY_SET = new Set<string>(WORK_CATEGORIES);

export function isWorkCategory(v: string): v is WorkCategory {
  return CATEGORY_SET.has(v);
}

/** チェックシート上の項目名や画像認識の出力に見られる表記ゆれ → 工事区分 */
const ALIASES: Record<string, WorkCategory> = {
  外部建具: "サッシ",
  窓: "サッシ",
  外部天井: "軒天",
  軒天井: "軒天",
  浴室: "ユニットバス",
  UB: "ユニットバス",
  洗面台: "洗面化粧台",
  洗面所: "洗面化粧台",
  洗面: "洗面化粧台",
  換気: "換気システム",
  換気扇: "換気システム",
  電気: "電気設備",
  ベランダ: "バルコニー",
  給排水: "配管",
  給排水管: "配管",
  排水: "配管",
  屋根裏: "小屋裏",
  水漏れ: "漏水",
  壁紙: "クロス",
  フローリング: "床仕上",
};

function clean(s: string): string {
  return s.normalize("NFKC").replace(/[\s　]/g, "");
}

/**
 * 項目名の文字列を工事区分に正規化する。該当なしは null。
 * 例: 「外部建具(サッシ)」→ サッシ、「外部天井（軒天）」→ 軒天、「クロス 」→ クロス
 */
export function normalizeWorkCategory(raw: string): WorkCategory | null {
  const s = clean(raw);
  if (!s) return null;
  if (isWorkCategory(s)) return s;
  if (ALIASES[s]) return ALIASES[s];

  // 「外部建具(サッシ)」のような括弧付き表記は、括弧内 → 括弧外 の順で試す
  const paren = /^(.*?)\((.*?)\)$/.exec(s);
  if (paren) {
    for (const part of [paren[2], paren[1]]) {
      if (isWorkCategory(part)) return part;
      if (ALIASES[part]) return ALIASES[part];
    }
  }

  // 部分一致 (最長一致を優先)。2文字以上の区分名のみ対象
  let best: WorkCategory | null = null;
  for (const c of WORK_CATEGORIES) {
    if (c.length >= 2 && (s.includes(c) || c.includes(s)) && (!best || c.length > best.length)) {
      best = c;
    }
  }
  return best;
}

/** 区分名と、その区分に対応付けている別名 (本文中の語を探すときの手がかり) */
export function categoryKeywords(category: string): string[] {
  const keywords = category ? [category] : [];
  for (const [alias, c] of Object.entries(ALIASES)) {
    if (c === category) keywords.push(alias);
  }
  return keywords;
}

/**
 * 本文の中に候補の工事区分 (名称・別名) が現れるかを見る。該当なしは null。
 *
 * 複数当たる場合は本文中で「最後に」現れた語の区分を採る。
 * 「浴室の換気扇から異音」のように「場所の部位に症状」の語順では、
 * 直したい部位が後ろに来るため (浴室 < 換気扇 → 換気システム)。同じ位置なら長い語を優先する。
 *
 * 候補はその報告書が持つ区分だけに絞る (normalizeWorkCategory は全30区分が対象で、
 * 本文が区分名の一部でも当たってしまうため、自由文の振り分けには使えない)。
 */
export function findCategoryInText(text: string, candidates: readonly string[]): string | null {
  const s = clean(text);
  if (!s) return null;
  let best: { category: string; pos: number; length: number } | null = null;
  for (const category of candidates) {
    // 空欄と「その他」は振り分けの受け皿なので、キーワード一致の対象にしない
    if (!category || category === "その他") continue;
    for (const keyword of categoryKeywords(category)) {
      const pos = s.lastIndexOf(clean(keyword));
      if (pos === -1) continue;
      if (!best || pos > best.pos || (pos === best.pos && keyword.length > best.length)) {
        best = { category, pos, length: keyword.length };
      }
    }
  }
  return best?.category ?? null;
}

/** 工事区分の一覧順に並べ替えるためのインデックス */
export function workCategoryOrder(c: string): number {
  const i = (WORK_CATEGORIES as readonly string[]).indexOf(c);
  return i === -1 ? WORK_CATEGORIES.length : i;
}

/** /api/work-categories の判定結果1件 */
export interface WorkCategoryHit {
  category: WorkCategory;
  /** シート上で読み取った項目名 (参考) */
  item: string;
  confidence: "high" | "low";
}

export interface WorkCategoriesResponse {
  categories: WorkCategoryHit[];
  engine: "gemini" | "none";
  /** 実際に判定に使えたモデル名 */
  model?: string;
  /** 1日の上限到達などで飛ばしたモデル (残り枠の目安) */
  skipped?: string[];
  error?: string;
}

/** 画像認識 (Gemini) の生出力1件 */
export interface FlaggedItem {
  item?: unknown;
  category?: unknown;
  confidence?: unknown;
}

/** Geminiの出力を工事区分に正規化し、重複をまとめて一覧順に並べる */
export function normalizeHits(flagged: FlaggedItem[]): WorkCategoryHit[] {
  const byCategory = new Map<WorkCategory, WorkCategoryHit>();
  for (const f of flagged) {
    const item = typeof f.item === "string" ? f.item : "";
    const rawCategory = typeof f.category === "string" ? f.category : "";
    let confidence: "high" | "low" = f.confidence === "low" ? "low" : "high";
    let category: WorkCategory | null = isWorkCategory(rawCategory)
      ? rawCategory
      : (normalizeWorkCategory(item) ?? normalizeWorkCategory(rawCategory));
    if (!category) {
      category = "その他";
      confidence = "low";
    }
    const prev = byCategory.get(category);
    if (!prev || (prev.confidence === "low" && confidence === "high")) {
      byCategory.set(category, { category, item: item || prev?.item || category, confidence });
    }
  }
  return [...byCategory.values()].sort(
    (a, b) => workCategoryOrder(a.category) - workCategoryOrder(b.category),
  );
}
