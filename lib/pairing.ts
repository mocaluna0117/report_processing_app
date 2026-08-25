export type ReportKind = "photo" | "inspection";

export interface ParsedFileName {
  kind: ReportKind | null;
  date: string | null; // YYYYMMDD
  ownerKey: string; // 空白を除いた正規化施主名 (ペアキー用)
  ownerDisplay: string; // 表示用 (単一スペース区切り)
  original: string;
}

/**
 * 「20260722 【写真報告書】山田　太郎様邸 .PDF」のようなファイル名を正規化して分解する。
 * 実ファイルで確認済みの揺れ: 全角スペース / 末尾「 .PDF」/ 「 (1)」サフィックス /
 * スペース+アンダースコア混在 / macOSのNFD。
 */
export function parseFileName(name: string): ParsedFileName {
  let s = name.normalize("NFKC"); // NFD結合 + 全角空白/英数字→半角
  s = s.replace(/\.pdf\s*$/i, "").trim();
  s = s.replace(/[(（]\s*\d+\s*[)）]\s*$/, "").trim(); // 重複DLの「 (1)」等

  let kind: ReportKind | null = null;
  if (s.includes("写真報告書")) kind = "photo";
  else if (s.includes("点検報告書")) kind = "inspection";
  s = s.replace(/【[^】]*】/g, " ").replace(/(写真報告書|点検報告書)/g, " ");

  const dateMatch = s.match(/(?:^|\D)(\d{8})(?:\D|$)/);
  const date = dateMatch ? dateMatch[1] : null;
  if (date) s = s.replace(date, " ");

  s = s
    .replace(/[\s_・.]+/g, " ")
    .trim()
    .replace(/(様邸|様|邸)$/, "")
    .trim();

  return { kind, date, ownerKey: s.replace(/\s+/g, ""), ownerDisplay: s, original: name };
}

export interface FileEntry {
  id: string;
  name: string;
}

export interface Pair<T extends FileEntry = FileEntry> {
  photo: T | null;
  inspection: T | null;
  date: string | null;
  ownerDisplay: string;
  /** 曖昧マッチで組んだペア (UIで要確認表示) */
  needsReview: boolean;
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const tmp = dp[i];
      dp[i] = Math.min(
        dp[i] + 1,
        dp[i - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = tmp;
    }
  }
  return dp[a.length];
}

/**
 * ファイル群を写真報告書/点検報告書に分類し、「日付+施主名」でペアリングする。
 * 完全一致で組めない分は同一日付内の編集距離最小でフォールバック (needsReview付き)。
 */
export function pairFiles<T extends FileEntry>(
  files: T[],
): { pairs: Pair<T>[]; unclassified: T[] } {
  const parsed = files.map((f) => ({ file: f, meta: parseFileName(f.name) }));
  const unclassified = parsed.filter((p) => p.meta.kind === null).map((p) => p.file);
  const photos = parsed.filter((p) => p.meta.kind === "photo");
  const inspections = parsed.filter((p) => p.meta.kind === "inspection");

  const pairs: Pair<T>[] = [];
  const usedInspections = new Set<string>();

  // 1. 日付+施主名の完全一致
  for (const p of photos) {
    const key = `${p.meta.date}|${p.meta.ownerKey}`;
    const match = inspections.find(
      (i) =>
        !usedInspections.has(i.file.id) &&
        `${i.meta.date}|${i.meta.ownerKey}` === key,
    );
    if (match) usedInspections.add(match.file.id);
    pairs.push({
      photo: p.file,
      inspection: match?.file ?? null,
      date: p.meta.date,
      ownerDisplay: p.meta.ownerDisplay,
      needsReview: false,
    });
  }

  // 2. 残りは同一日付内の曖昧マッチ。同日に複数世帯を回る運用が前提なので、
  //    別世帯を誤ペアしないよう (a) 姓の一致を必須、(b) しきい値は短い氏名で距離1まで、
  //    (c) 距離昇順の安定割当 (先勝ちの横取りを防ぐ) とする。
  const candidates: { pair: Pair<T>; file: T; dist: number }[] = [];
  for (const pair of pairs) {
    if (pair.inspection || !pair.photo) continue;
    const photoMeta = parseFileName(pair.photo.name);
    const threshold =
      photoMeta.ownerKey.length <= 4 ? 1 : Math.floor(photoMeta.ownerKey.length / 3);
    for (const i of inspections) {
      if (usedInspections.has(i.file.id)) continue;
      if (i.meta.date !== photoMeta.date) continue;
      const surnameA = photoMeta.ownerDisplay.split(" ")[0] ?? "";
      const surnameB = i.meta.ownerDisplay.split(" ")[0] ?? "";
      const sameSurname =
        surnameA === surnameB ||
        surnameA.startsWith(surnameB) ||
        surnameB.startsWith(surnameA);
      if (!sameSurname) continue;
      const dist = levenshtein(i.meta.ownerKey, photoMeta.ownerKey);
      if (dist <= threshold) candidates.push({ pair, file: i.file, dist });
    }
  }
  candidates.sort((a, b) => a.dist - b.dist);
  for (const c of candidates) {
    if (c.pair.inspection || usedInspections.has(c.file.id)) continue;
    usedInspections.add(c.file.id);
    c.pair.inspection = c.file;
    c.pair.needsReview = true;
  }

  // 3. ペアにならなかった点検報告書も行として出す (手動割当用)
  for (const i of inspections) {
    if (usedInspections.has(i.file.id)) continue;
    pairs.push({
      photo: null,
      inspection: i.file,
      date: i.meta.date,
      ownerDisplay: i.meta.ownerDisplay,
      needsReview: false,
    });
  }

  return { pairs, unclassified };
}
