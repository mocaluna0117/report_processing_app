// アフターメンテナンスの事業者判定。
// 定期点検 (lib/pdf/parse-photo-report.ts の resolveDeveloper) とは規則が違うので別にする。

export const DEVELOPER_EU = "EU";
export const DEVELOPER_TAKAMATSU = "タカマツハウス";
export const DEVELOPER_CHINTAI = "賃貸住宅事業部";
export const DEVELOPER_SOUKO = "倉庫事業";

/** 41始まり (その他事業者) は物件名から判定する */
export const DEVELOPER_41_RULES: readonly [RegExp, string][] = [
  [/SECUREA|セキュレア/i, "大和ハウス工業"],
  [/リーフィア/, "小田急不動産"],
  [/三鷹市下連雀/, "コスモスイニシア"],
  [/北加瀬1丁目の家|鹿島田の家/, "福禄不動産"],
];

export interface DeveloperResult {
  developer: string | null;
  issue?: string;
}

/**
 * 物件番号 (PJ) の先頭2桁と物件名から事業者を決める。
 * 41始まりで物件名から特定できないものは、空欄+要確認にして画面で直してもらう
 * (誤った事業者を入れるより安全)。
 */
export function resolveAfterDeveloper(pj: string | null, propertyName: string): DeveloperResult {
  if (!pj) return { developer: null, issue: "PJが不明なため事業者を判定できません" };
  const prefix = pj.slice(0, 2);
  if (prefix === "10" || prefix === "11") return { developer: DEVELOPER_EU };
  if (prefix === "21") return { developer: DEVELOPER_TAKAMATSU };
  if (prefix === "31") return { developer: DEVELOPER_CHINTAI };
  if (prefix === "51") return { developer: DEVELOPER_SOUKO };
  if (prefix === "41") {
    for (const [pattern, developer] of DEVELOPER_41_RULES) {
      if (pattern.test(propertyName)) return { developer };
    }
    return {
      developer: null,
      issue: "PJが41始まり (その他事業者) ですが物件名から事業者を特定できません。手入力してください",
    };
  }
  return { developer: null, issue: `PJの先頭2桁 (${prefix}) が想定外のため事業者を判定できません` };
}

/** 助っ人クラウドの担当支店 → 事業者。エンドユーザーだけ略記に直す */
export function developerFromBranch(branch: string): string | null {
  const value = branch.trim();
  if (!value) return null;
  return value === "エンドユーザー" ? DEVELOPER_EU : value;
}
