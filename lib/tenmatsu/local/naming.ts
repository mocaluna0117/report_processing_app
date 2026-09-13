/**
 * 保存するファイルの名前を決める。
 *
 * 移植元: tenmatsu.py 998-1050（last4 / safe_component / decide_output_path / decide_named_output_path）
 *
 * ★**上書きは絶対にしない**。`{接頭辞}{下4桁}.pdf` → 埋まっていれば `{接頭辞}{フル伝票No}.pdf` →
 *   `_2`…`_99`。99 まで埋まっていたら例外にする（黙って上書きしない）。
 */
import { last4 } from "@/lib/rakuraku/parse/natsuin";
import type { FolderStore, Path } from "./fs";

/**
 * Python の str.strip() が落とす空白と同じ集合。
 * ★JS の trim() とは少し違う（JS は BOM を落とし、U+001C〜U+001F と U+0085 を落とさない）。
 *   移植元と同じ名前にならないと「同じ伝票なのに別のファイル名」になるので揃える。
 */
const PY_SPACE = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000";
const PY_STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "g");

export function pyStrip(text: string): string {
  return text.replace(PY_STRIP, "");
}

/** Windows と macOS で使えない文字を `_` にする。前後の空白と末尾の「.」を落とす。空になれば "unnamed" */
export function safeComponent(name: string): string {
  const cleaned = pyStrip(name.replace(/[\\/:*?"<>|]/g, "_")).replace(/\.+$/, "");
  return cleaned || "unnamed";
}

/** Python の Path(name).stem と同じ（最後の「.」より前。先頭の「.」だけなら全部） */
export function stemOf(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const at = base.lastIndexOf(".");
  return at > 0 ? base.slice(0, at) : base;
}

export { last4 };

/**
 * `{接頭辞}{下4桁}.pdf`。既にあれば上書きせずフル伝票No.の名前にし、それも埋まっていれば `_2`〜`_99`。
 * 戻り値はファイル名（dir の中の名前）。
 */
export async function decideOutputName(store: FolderStore, dir: Path, denpyoNo: string, prefix: string): Promise<string> {
  const primary = `${prefix}${safeComponent(last4(denpyoNo))}.pdf`;
  if (!(await store.exists([...dir, primary]))) return primary;
  const fallback = `${prefix}${safeComponent(denpyoNo)}.pdf`;
  if (!(await store.exists([...dir, fallback]))) return fallback;
  for (let i = 2; i < 100; i++) {
    const candidate = `${prefix}${safeComponent(denpyoNo)}_${i}.pdf`;
    if (!(await store.exists([...dir, candidate]))) return candidate;
  }
  throw new Error(`保存名を決められませんでした: ${denpyoNo}`);
}

/**
 * 伝票ごとに決めた名前で保存する（捺印決裁書）。既にあれば `_2`, `_3` … を付ける。
 * ★上書きはしない。全角の「（）」はファイル名に使えるのでそのまま残る。
 */
export async function decideNamedOutputName(store: FolderStore, dir: Path, name: string): Promise<string> {
  const stem = safeComponent(stemOf(name));
  const primary = `${stem}.pdf`;
  if (!(await store.exists([...dir, primary]))) return primary;
  for (let i = 2; i < 100; i++) {
    const candidate = `${stem}_${i}.pdf`;
    if (!(await store.exists([...dir, candidate]))) return candidate;
  }
  throw new Error(`保存名を決められませんでした: ${name}`);
}
