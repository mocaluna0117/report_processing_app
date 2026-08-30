// 助っ人クラウド (旧システム) と点検保守台帳 (DX) で同じ物件を指すレコードを見つける。
// 点検保守台帳が正なので、対応が付いた助っ人クラウド側は消し、
// 点検保守台帳が空欄の項目だけを助っ人クラウドから補う。純関数のみ (IndexedDB には触らない)。
//
// 判定の考え方:
// - 手がかりは PJ・氏名・住所・物件名 の4つ。1つだけの一致は当てにならない
//   (助っ人クラウドの管理ID→PJ変換は規則が不完全で、別人のPJと衝突することが実際にある。
//    「青葉区美しが丘4丁目A号棟」のように事業者違いで物件名だけ同じ例もある)。
//   そこで2つ以上そろって初めて同じ物件とみなす。
// - 住所がはっきり違うものは、他がそろっていても消さない
//   (同じ施主が別の場所に2棟目を建てた例がある)。画面で知らせるだけにする。
// - 同じ敷地に複数棟あると n対m の候補になる。助っ人クラウド側の件数が
//   点検保守台帳側以下なら全部が台帳に載っているので消してよい。多い場合は台帳に無い棟が
//   混じっているので消さない。
import { effectiveFields } from "@/lib/after/customer";
import { normalizeSearchText } from "@/lib/after/normalize";
import type { Customer, CustomerFields } from "@/lib/after/types";
import { hiraganaToKatakana } from "@/lib/kana";

/** 画面に出す「重複かもしれない」の知らせ (要確認として扱う) */
export const DUPLICATE_ISSUE =
  "点検保守台帳 (DX) に似た顧客がいます。同じ物件なら、この助っ人クラウドのデータは使わないでください";

/**
 * 住所の照合キー。「3丁目14番10号」と「3-14-10」を同じにする。
 * 区切りは "-" のまま残す (「44-1」と「44-13」を取り違えないため)。
 */
export function addressKey(raw: string): string {
  return hiraganaToKatakana(raw.normalize("NFKC"))
    .toLowerCase()
    .replace(/丁目|番地|[番号]/g, "-")
    .replace(/[‐‑‒–—―ｰ−ー-]/g, "-")
    .replace(/[\s、,.。・()（）]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** 氏名の照合キー。法人格・肩書き・括弧書きは付いたり付かなかったりするので落とす */
export function nameKey(raw: string): string {
  return normalizeSearchText(
    raw
      .replace(/株式会社|有限会社|合同会社|合資会社|㈱|㈲/g, "")
      .replace(/代表取締役社長|代表取締役|代表社員|代表者|理事長|社長/g, "")
      .replace(/[（(][^)）]*[)）]/g, ""),
  );
}

/** 括弧書き・【】は取り込み元によって付いたり付かなかったりする */
const stripDecorations = (raw: string) => raw.replace(/[（(][^)）]*[)）]|【[^】]*】/g, "");

/** 物件名の照合キー。「新築工事/新築計画」も取り込み元によって有無が違う */
export function propertyKey(raw: string): string {
  return normalizeSearchText(stripDecorations(raw).replace(/新築工事|新築計画/g, ""));
}

/**
 * 物件名の棟・区画の記号 (「C棟」「C号棟」「3号地」「B区画」→ C / C / 3 / B)。
 * 同じ敷地の別棟を見分けるための最後の砦。取り込み元で「C棟」「C号棟」と書き方が違うので、
 * 記号だけを取り出して比べる。無ければ空文字 (制約なし)。
 */
const UNIT = /([A-Za-z0-9])\s*(?:号棟|号室|号地|号館|区画|棟)/;

export function unitToken(propertyName: string): string {
  return UNIT.exec(stripDecorations(propertyName).normalize("NFKC").toUpperCase())?.[1] ?? "";
}

/** unknown: どちらかが空 / same: 同じ / extends: 建物名や枝番が付いただけ / conflict: 別の住所 */
export type AddressRelation = "unknown" | "same" | "extends" | "conflict";

/**
 * 住所どうしの関係を見る。
 * 点検保守台帳の住所は「所在地住居表示 + 建物名」なので助っ人クラウドより長いことがあり、
 * 「44-1」に対する「44-1-3」のように枝番が付くこともある。どちらも同じ住所として扱う。
 */
export function compareAddress(a: string, b: string): AddressRelation {
  if (!a || !b) return "unknown";
  if (a === b) return "same";
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  // 続きが数字なら別の番地 (「2-12-9」と「2-12-91」)。それ以外は建物名か枝番とみなす
  if (long.startsWith(short) && !/^\d/.test(long.slice(short.length))) return "extends";
  return "conflict";
}

interface Keys {
  customer: Customer;
  fields: CustomerFields;
  pj: string;
  name: string;
  address: string;
  property: string;
  unit: string;
}

function keysOf(customer: Customer): Keys {
  const fields = effectiveFields(customer);
  return {
    customer,
    fields,
    pj: fields.pj ?? "",
    name: nameKey(fields.ownerName),
    address: addressKey(fields.address),
    property: propertyKey(fields.propertyName),
    unit: unitToken(fields.propertyName),
  };
}

/** 一致した手がかりの数と、住所の関係 */
function compare(s: Keys, d: Keys): { signals: number; address: AddressRelation } {
  const address = compareAddress(s.address, d.address);
  let signals = 0;
  if (s.pj && s.pj === d.pj) signals += 1;
  if (s.name && s.name === d.name) signals += 1;
  if (address === "same" || address === "extends") signals += 1;
  if (s.property && s.property === d.property) signals += 1;
  return { signals, address };
}

/** 手がかりが2つ以上そろったか (これ未満は同じ物件とみなさない) */
const REQUIRED_SIGNALS = 2;

const isEmptyValue = (value: unknown): boolean =>
  value === null || value === "" || (Array.isArray(value) && value.length === 0);

const FIELD_KEYS = [
  "pj",
  "developer",
  "propertyName",
  "ownerName",
  "ownerKana",
  "address",
  "contacts",
  "emails",
  "handoverDate",
  "salesRep",
  "memo",
] as const satisfies readonly (keyof CustomerFields)[];

export interface DedupResolution {
  /** 点検保守台帳に載っているので消してよい助っ人クラウドの顧客ID */
  removeIds: Set<string>;
  /** 点検保守台帳の顧客ID → 助っ人クラウドから補える項目 (台帳が空欄のものだけ) */
  supplements: Map<string, Partial<CustomerFields>>;
  /** 重複かもしれないが決め切れない助っ人クラウドの顧客ID (消さずに画面で知らせる) */
  uncertainIds: Set<string>;
}

/**
 * 助っ人クラウドと点検保守台帳を突き合わせる。
 * 取り込み順に関係なく同じ結果になるよう、両方の全件を受け取って毎回まとめて判定する。
 */
export function resolveDuplicates(suketto: Customer[], dx: Customer[]): DedupResolution {
  const removeIds = new Set<string>();
  const supplements = new Map<string, Partial<CustomerFields>>();
  const uncertainIds = new Set<string>();
  if (suketto.length === 0 || dx.length === 0) return { removeIds, supplements, uncertainIds };

  const dxKeys = dx.map(keysOf);
  // 総当たりを避けるため、点検保守台帳を PJ・氏名・物件名 で索引する。
  // 手がかりは4つで住所はそのうち1つなので、2つ以上そろうペアは必ずこの3つのどれかで一致する。
  // (住所は前方一致も見るため索引に向かないが、この3つで候補は漏れなく拾える)
  const byPj = new Map<string, Keys[]>();
  const byName = new Map<string, Keys[]>();
  const byProperty = new Map<string, Keys[]>();
  const push = (map: Map<string, Keys[]>, key: string, value: Keys) => {
    if (!key) return;
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  for (const d of dxKeys) {
    push(byPj, d.pj, d);
    push(byName, d.name, d);
    push(byProperty, d.property, d);
  }

  // 候補ペア (手がかり2つ以上) を集め、住所が矛盾するものは分けておく
  const edges: [Keys, Keys][] = [];
  const conflicting = new Set<string>();
  for (const s of suketto.map(keysOf)) {
    const candidates = new Set<Keys>([
      ...(byPj.get(s.pj) ?? []),
      ...(byName.get(s.name) ?? []),
      ...(byProperty.get(s.property) ?? []),
    ]);
    for (const d of candidates) {
      // 棟・区画の記号が両方にあって食い違うなら別の建物。他が何件そろっていても結び付けない
      // (同じ敷地の「A棟」と「B号棟」は施主も住所も同じなので、これが唯一の見分け方)
      if (s.unit && d.unit && s.unit !== d.unit) continue;
      const { signals, address } = compare(s, d);
      if (signals < REQUIRED_SIGNALS) continue;
      if (address === "conflict") conflicting.add(s.customer.id);
      else edges.push([s, d]);
    }
  }

  // 候補ペアを連結成分にまとめる (同じ敷地の複数棟は 3対3 のようなかたまりになる)
  const componentOf = new Map<Keys, number>();
  const components: { suketto: Set<Keys>; dx: Set<Keys> }[] = [];
  for (const [s, d] of edges) {
    const cs = componentOf.get(s);
    const cd = componentOf.get(d);
    if (cs === undefined && cd === undefined) {
      components.push({ suketto: new Set([s]), dx: new Set([d]) });
      componentOf.set(s, components.length - 1);
      componentOf.set(d, components.length - 1);
    } else if (cs === undefined) {
      components[cd as number].suketto.add(s);
      componentOf.set(s, cd as number);
    } else if (cd === undefined) {
      components[cs].dx.add(d);
      componentOf.set(d, cs);
    } else if (cs !== cd) {
      // 2つのかたまりが1つにつながった
      for (const x of components[cd].suketto) {
        components[cs].suketto.add(x);
        componentOf.set(x, cs);
      }
      for (const x of components[cd].dx) {
        components[cs].dx.add(x);
        componentOf.set(x, cs);
      }
      components[cd].suketto.clear();
      components[cd].dx.clear();
    }
  }

  for (const component of components) {
    const list = [...component.suketto];
    if (list.length === 0) continue;
    if (list.length > component.dx.size) {
      // 台帳に載っていない棟が混じっている。どれが余りか決められないので消さない
      for (const s of list) uncertainIds.add(s.customer.id);
      continue;
    }
    for (const s of list) removeIds.add(s.customer.id);
    // 補完は「かたまりの中で値が1つに定まる項目」だけにする
    // (3対3 のようなときに、どの棟の値かを取り違えないため)
    for (const d of component.dx) {
      const values: Partial<CustomerFields> = {};
      for (const key of FIELD_KEYS) {
        // 空欄かどうかは台帳の取り込み値だけで見る (前回の補完を当てにすると、
        // 助っ人クラウド側の値が変わったときに追従できなくなる)
        if (!isEmptyValue(d.customer.imported[key])) continue;
        const distinct = new Set<string>();
        let value: CustomerFields[typeof key] | undefined;
        for (const s of list) {
          const candidate = s.fields[key];
          if (isEmptyValue(candidate)) continue;
          distinct.add(JSON.stringify(candidate));
          value = candidate;
        }
        if (distinct.size === 1 && value !== undefined) {
          Object.assign(values, { [key]: value });
        }
      }
      if (Object.keys(values).length > 0) supplements.set(d.customer.id, values);
    }
  }

  for (const id of conflicting) {
    if (!removeIds.has(id)) uncertainIds.add(id);
  }
  return { removeIds, supplements, uncertainIds };
}

/**
 * 「重複かもしれない」の知らせを付け外しする。
 * 変化が無ければ同じオブジェクトを返す (保存が要るかを参照の比較で判定できるように)。
 */
export function withDuplicateIssue(customer: Customer, uncertain: boolean): Customer {
  const has = customer.issues.some((issue) => issue.message === DUPLICATE_ISSUE);
  if (has === uncertain) return customer;
  const issues = uncertain
    ? [...customer.issues, { field: null, message: DUPLICATE_ISSUE }]
    : customer.issues.filter((issue) => issue.message !== DUPLICATE_ISSUE);
  return { ...customer, issues };
}
