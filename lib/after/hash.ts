/**
 * 内容から安定したIDを作る (FNV-1a 64bit 相当を32bit×2で計算)。
 * 助っ人クラウドの管理IDは重複するため、行の内容そのものを鍵にする。
 * crypto.subtle は非同期なので使わない (取り込みは同期の純関数にしたい)。
 */
export function fnv1a64(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c + i;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
