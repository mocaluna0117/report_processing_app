/**
 * PJ（事業部・PJ・現場）の書き方をそろえる。支出報告書の 事業部ｺｰﾄﾞ / PJ / 現場コード / 現場枝番 の列と、
 * 進捗管理表の行と顛末書の突き合わせに使う。
 *
 * 進捗管理表・顛末書に出てくる書き方（2026-10-03 に利用者と確認）:
 *   - `21-56-1`      … 事業部 21 / PJ 56 / 現場 1
 *   - `1056-1`       … 事業部 1（注文住宅）/ PJ 1056 / 現場 1
 *   - `2101270301`   … 10桁 = 事業部2桁 + PJ4桁 + 現場2桁 + 末尾2桁（顛末書ではこの末尾が「現場枝番」）
 *   - `103170101`    … 9桁 = 先頭の 0 が落ちた10桁（事業部 01）
 *   ★10桁の事業部 `10` は支出報告書では `1` と書く（`11` はそのまま）
 */

export interface PjParts {
  /** 事業部ｺｰﾄﾞ（支出報告書に書く値。10 は 1） */
  division: number;
  pj: number;
  site: number;
  /** 10桁の末尾2桁（顛末書の PJ コードなら現場枝番）。書き方に無ければ null */
  branch: number | null;
}

const toAscii = (s: string) => s.normalize("NFKC");

export function parsePj(text: string | null | undefined): PjParts | null {
  const raw = toAscii(String(text ?? "")).replace(/\s/g, "");
  if (!raw) return null;
  let m = /^(\d{1,2})-(\d{1,5})-(\d{1,2})$/.exec(raw);
  if (m) return { division: divisionOf(m[1]), pj: Number(m[2]), site: Number(m[3]), branch: null };
  m = /^(\d{1,5})-(\d{1,2})$/.exec(raw);
  if (m) return { division: 1, pj: Number(m[1]), site: Number(m[2]), branch: null };
  if (/^\d{9,10}$/.test(raw)) {
    const d = raw.padStart(10, "0");
    return {
      division: divisionOf(d.slice(0, 2)),
      pj: Number(d.slice(2, 6)),
      site: Number(d.slice(6, 8)),
      branch: Number(d.slice(8, 10)),
    };
  }
  return null;
}

function divisionOf(text: string): number {
  const n = Number(text);
  return n === 10 ? 1 : n;
}

/** 突き合わせの鍵（枝番は見ない。同じ現場の別の工事も同じ鍵） */
export function pjKey(parts: PjParts | null): string | null {
  return parts ? `${parts.division}-${parts.pj}-${parts.site}` : null;
}
