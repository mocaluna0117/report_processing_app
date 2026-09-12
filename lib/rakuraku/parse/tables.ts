/**
 * 画面の表から値を選ぶ（純粋な規則）。表を読むこと自体は lib/rakuraku/tables.ts が行う。
 *
 * 移植元: tenmatsu.py 2937-3096, 4293-4309
 * ブラウザ側からも使うので、Playwright にも server-only にも依存しない。
 */
import { pickLatestDate } from "./datetime";
import { parsePj } from "./fields";

export interface TableData {
  id?: string | null;
  cls?: string | null;
  visible?: boolean;
  rows: string[][];
  /** クリックの後に現れた表か（承認履歴の読み取りで使う） */
  isNew?: boolean;
}

/** ラベル比較用の正規化。空白・全角空白・「.」を落とす（一覧の列探しと同じ規則） */
export function normLabel(text: string | null | undefined): string {
  return (text ?? "").replace(/[\s\u3000.]/g, "");
}

/**
 * ヘッダー行のセルから、候補のどれかに合う列番号を探す。無ければ -1。
 * ★完全一致を**全候補について先に**試し、それでも無ければ部分一致で探す。
 */
export function findLabelCol(cells: readonly string[], wants: readonly string[]): number {
  for (const exact of [true, false]) {
    for (const want of wants) {
      const w = normLabel(want);
      if (!w) continue;
      const i = cells.findIndex((cell) => {
        const got = normLabel(cell);
        return Boolean(got) && (exact ? got === w : got.includes(w));
      });
      if (i >= 0) return i;
    }
  }
  return -1;
}

/**
 * 「ラベル→値」の表から、ラベルに対応する値を取り出す。無ければ null。
 *
 * 伝票画面は `<tr><th>申請日</th><td>…</td></tr>` の形。1行に「ラベル・値・ラベル・値」と
 * 2組並ぶ書き方もあるので、**ラベルのセルの次の、空でないセル**を値とする。
 *
 * ★部分一致は「セルがラベルを含む」方向**だけ**。逆（ラベルがセルを含む）まで許すと、
 *   「申請日」を探して「日」だけのセルに当たり、別の項目の値を持ってくる。完全一致を最優先する。
 */
export function pickLabeledValue(tables: readonly TableData[], label: string): string | null {
  const want = normLabel(label);
  if (!want) return null;
  for (const exact of [true, false]) {
    for (const table of tables) {
      for (const row of table.rows ?? []) {
        for (let i = 0; i < row.length; i++) {
          const got = normLabel(row[i]);
          if (!got || !(exact ? got === want : got.includes(want))) continue;
          for (const value of row.slice(i + 1)) {
            if ((value ?? "").trim()) return value.trim();
          }
        }
      }
    }
  }
  return null;
}

/**
 * 「どこで」の行、無ければ**すぐ下の行**にあるPJコード（10桁）を取り出す。
 *
 * 見出しが確認できていないので位置で探し、**10桁の数字かどうかで確かめる**。
 * 確かめられるので位置で探しても危なくない。戻り値は [PJ, その行の見出し]。
 * ★「どこで」の見出しは**完全一致**でだけ探す。
 */
export function pickPjNearLabel(
  tables: readonly TableData[],
  label: string,
): [pj: string | null, heading: string | null] {
  const want = normLabel(label);
  if (!want) return [null, null];
  for (const table of tables) {
    const rows = table.rows ?? [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row.some((c) => normLabel(c) === want)) continue;
      for (const value of row) {
        const got = parsePj(value);
        if (got) return [got, row[0] ?? null];
      }
      if (i + 1 < rows.length) {
        const below = rows[i + 1];
        for (const value of below) {
          const got = parsePj(value);
          if (got) return [got, below[0] ?? null];
        }
        return [null, below[0] ?? null];
      }
    }
  }
  return [null, null];
}

export interface FinalApprovedOptions {
  /** 日付の列の見出し候補（例: 日付・承認日・処理日・日時） */
  dateColumns: readonly string[];
  /** これを含む行は日付があっても候補にしない（差戻し・取下げ・却下・否認） */
  excludeWords?: readonly string[];
  /** 列が特定できないとき、承認履歴らしい表を見分ける語 */
  keywords?: readonly string[];
  /**
   * クリックの後に現れた表だけを見るか（既定 true）。
   * false は、すでにダイアログが開いている画面を読む確認用に限る。
   */
  requireNew?: boolean;
}

/**
 * 承認履歴の表から「最終承認日」を選ぶ。取れなければ null。
 *
 * ★決め方は「日付」列の日付のうち**いちばん新しいもの**。承認履歴が上から順か下から順か
 *   確認できていないので、並び順に依存しない。
 * ★候補から外すもの:
 *   - 差戻し・取下げ等を含む**行**。差戻し後に再承認された伝票で、差戻しの日を採らないため
 *   - 日付が空の行（まだ承認していない承認者）
 *   外した結果1件も残らなければ null。**代わりに差戻しの日を返したりしない**。
 * ★**クリック後に現れた表だけ**を見る（requireNew）。伝票画面には元から「承認ルート」
 *   （日付列はあるが時刻が無い）や「支払予定日」があり、そこから採ると**時刻の無い値や
 *   別の日付**を返す。実際にこれで多くの記録が日付だけの値になった（実バグ）。
 *
 * 2段構え: (1) 日付らしい見出しを持つ表 (2) 見出しが読めないとき、承認履歴らしい表の全セル
 */
export function pickFinalApprovedAt(
  tables: readonly TableData[],
  options: FinalApprovedOptions,
): string | null {
  const requireNew = options.requireNew ?? true;
  // 現れた表を先に見る（安定ソート）
  let ordered = [...tables].sort((a, b) => Number(!a.isNew) - Number(!b.isNew));
  if (requireNew) ordered = ordered.filter((t) => t.isNew);
  const exclude = (options.excludeWords ?? []).filter(Boolean);

  // (1) 「日付」列を持つ表
  for (const table of ordered) {
    const rows = table.rows ?? [];
    let col = -1;
    let headerIdx = -1;
    // 表題の行が上にあることがあるので、先頭5行まで見出しを探す
    for (let r = 0; r < Math.min(5, rows.length); r++) {
      col = findLabelCol(rows[r], options.dateColumns);
      if (col >= 0) {
        headerIdx = r;
        break;
      }
    }
    if (col < 0) continue;
    const candidates: string[] = [];
    for (const row of rows.slice(headerIdx + 1)) {
      const whole = row.map((c) => c ?? "").join(" ");
      if (exclude.some((w) => whole.includes(w))) continue;
      candidates.push(col < row.length ? row[col] : "");
    }
    const got = pickLatestDate(candidates);
    if (got) return got;
  }

  // (2) 列が特定できないとき。「承認履歴らしい」表だけを見る
  const keys = (options.keywords ?? []).filter(Boolean);
  for (const table of ordered) {
    if (requireNew && !table.isNew) continue;
    const lines = (table.rows ?? []).map((row) => row.map((c) => c ?? "").join(" "));
    const whole = lines.join(" ");
    if (keys.length > 0 && !keys.some((k) => whole.includes(k))) continue;
    const got = pickLatestDate(lines, exclude);
    if (got) return got;
  }
  return null;
}

const LINE_BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/;

/**
 * クリック後に**増えた行だけ**を返す（承認履歴が表で書かれていなかったとき用）。
 * ★元からある行を外すのが目的。伝票画面の「支払予定日」などを最終承認日と間違えないため。
 */
export function diffAddedLines(beforeText: string | null | undefined, afterText: string | null | undefined): string[] {
  const split = (t: string | null | undefined) =>
    (t ?? "").split(LINE_BREAK).map((l) => l.trim()).filter(Boolean);
  const before = new Set(split(beforeText));
  return split(afterText).filter((l) => !before.has(l));
}

/**
 * 同じ表かどうかを見分ける印（id・class・先頭行）。行数は増減しうるので入れない。
 */
export function tableSignature(table: TableData): string {
  const first = table.rows?.[0] ?? [];
  return `${table.id ?? ""}|${table.cls ?? ""}|${first.map((c) => c ?? "").join(" ")}`;
}

/**
 * クリック前後で「中身まで同じ表か」を見分ける印。
 * ★先頭行だけの印では、元からある空の表に承認履歴が流し込まれる作りのとき
 *   「前からある表」と見えてしまう。中身まで入れて比べる。
 */
export function tableContentKey(table: TableData): string {
  const body = (table.rows ?? []).map((row) => row.map((c) => c ?? "").join("\u241e")).join("\u241f");
  return `${tableSignature(table)}|${body}`;
}
