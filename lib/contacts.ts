// 連絡先 (①②) の手直し。完了報告書ダイアログの入力欄から呼ぶ純関数。
// 電話番号はブラウザ内でのみ扱い、外部へ送らない。
import { parsePhoneCell } from "@/lib/after/normalize";
import { trimWide } from "@/lib/text";
import type { Contact } from "@/lib/types";

/** 番号を消した欄の場所を保つための空の連絡先 (①を消しても②が②のまま残るように) */
export const EMPTY_CONTACT: Contact = { phone: "", relation: "", confidence: "ok" };

/**
 * index 番目の連絡先を入力文字列で差し替える。
 *
 * - 「090-0000-0000（奥様）」のような続柄付きは parsePhoneCell で番号と続柄に分ける
 * - 続柄を書かなければ、もとの続柄を残す (番号だけ直すことが多い)
 * - 番号として読めない文字列 (数字が無い) は要確認 (warn) のまま残す (勝手に消さない)
 * - 空欄にしたら、後ろに連絡先があれば空の連絡先で場所を保ち、末尾の空欄は落とす
 *   (①②とも消せば [] に戻る)。空にした欄の続柄は残すので、番号を打ち直しても続柄は消えない
 */
export function setContactPhone(
  contacts: readonly Contact[],
  index: number,
  raw: string,
): Contact[] {
  const next: (Contact | undefined)[] = [...contacts];
  const existing = next[index];
  const text = trimWide(raw);
  if (!text) {
    // 場所を保つのに要るのは空の枠だけ。続柄は残す
    // (番号を消してから打ち直す操作でも「（奥様）」が消えないようにする)
    next[index] = { ...EMPTY_CONTACT, relation: existing?.relation ?? "" };
  } else {
    const parsed = parsePhoneCell(text);
    next[index] = parsed
      ? { ...parsed, relation: parsed.relation || existing?.relation || "" }
      : { phone: text, relation: existing?.relation ?? "", confidence: "warn" };
  }
  // ②だけ入れたときの①など、間の欠けは空の連絡先で埋める
  const filled: Contact[] = Array.from(next, (c) => c ?? { ...EMPTY_CONTACT });
  while (filled.length > 0 && !filled[filled.length - 1].phone) filled.pop();
  return filled;
}
