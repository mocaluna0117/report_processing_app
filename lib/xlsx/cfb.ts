/**
 * 複合ファイル（Compound File Binary、MS-CFB）からストリームを取り出す。
 *
 * パスワード付きの xlsx は ZIP ではなくこの形式で、中に `EncryptionInfo`（鍵の作り方）と
 * `EncryptedPackage`（暗号化された本来の xlsx）が入っている。読むのはその2つだけなので、
 * ストリームを名前で引ければ足りる（どのストレージの下かは見ない。書き込みは扱わない）。
 *
 * ★壊れたファイルで無限に回らないよう、鎖をたどる回数はセクター数で打ち切る。
 */

export class CfbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CfbError";
  }
}

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const END_OF_CHAIN = 0xfffffffe;
const FREE_SECT = 0xffffffff;

/** 先頭8バイトが複合ファイルの印か（古い .xls も同じ印なので、中身は呼ぶ側が確かめる） */
export function isCfb(bytes: Uint8Array): boolean {
  return bytes.length >= 512 && SIGNATURE.every((b, i) => bytes[i] === b);
}

interface DirEntry {
  name: string;
  type: number;
  start: number;
  size: number;
}

export interface CfbFile {
  /** ストリームの名前の一覧（入れ子のストレージの下のものも含む） */
  names(): string[];
  /** 名前でストリームを読む。無ければ null */
  read(name: string): Uint8Array | null;
}

export function readCfb(bytes: Uint8Array): CfbFile {
  if (!isCfb(bytes)) throw new CfbError("複合ファイルではありません");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o: number) => view.getUint16(o, true);
  const u32 = (o: number) => view.getUint32(o, true);

  const sectorShift = u16(30);
  const miniShift = u16(32);
  if (sectorShift !== 9 && sectorShift !== 12) throw new CfbError("複合ファイルのセクターの大きさが想定と違います");
  const sectorSize = 1 << sectorShift;
  const miniSize = 1 << miniShift;
  const dirStart = u32(48);
  const miniCutoff = u32(56);
  const miniFatStart = u32(60);
  const miniFatCount = u32(64);
  let difatNext = u32(68);
  const difatCount = u32(72);

  const sectorCount = Math.floor((bytes.length - sectorSize) / sectorSize) + 1;
  const sectorOffset = (sector: number) => (sector + 1) * sectorSize;
  const sectorBytes = (sector: number) => {
    const start = sectorOffset(sector);
    if (start + sectorSize > bytes.length) {
      // 最後のセクターが切れているファイルもある（読める分だけ）
      if (start >= bytes.length) throw new CfbError("複合ファイルが途中で切れています");
      const out = new Uint8Array(sectorSize);
      out.set(bytes.subarray(start));
      return out;
    }
    return bytes.subarray(start, start + sectorSize);
  };

  // --- FAT（セクターの鎖）。DIFAT の 109 個はヘッダーに、残りは鎖でつながったセクターに入る
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) {
    const s = u32(76 + i * 4);
    if (s !== FREE_SECT && s !== END_OF_CHAIN) fatSectors.push(s);
  }
  const perSector = sectorSize / 4;
  for (let n = 0; n < difatCount && difatNext !== END_OF_CHAIN && difatNext !== FREE_SECT; n++) {
    const sec = sectorBytes(difatNext);
    const dv = new DataView(sec.buffer, sec.byteOffset, sec.byteLength);
    for (let i = 0; i < perSector - 1; i++) {
      const s = dv.getUint32(i * 4, true);
      if (s !== FREE_SECT && s !== END_OF_CHAIN) fatSectors.push(s);
    }
    difatNext = dv.getUint32((perSector - 1) * 4, true);
  }
  const fat = new Uint32Array(fatSectors.length * perSector);
  fatSectors.forEach((s, k) => {
    const sec = sectorBytes(s);
    const dv = new DataView(sec.buffer, sec.byteOffset, sec.byteLength);
    for (let i = 0; i < perSector; i++) fat[k * perSector + i] = dv.getUint32(i * 4, true);
  });

  const chain = (start: number, table: Uint32Array, limit: number): number[] => {
    const out: number[] = [];
    let s = start;
    while (s !== END_OF_CHAIN && s !== FREE_SECT) {
      if (s >= table.length || out.length > limit) throw new CfbError("複合ファイルの鎖が壊れています");
      out.push(s);
      s = table[s];
    }
    return out;
  };
  const readChain = (start: number, size: number): Uint8Array => {
    const sectors = chain(start, fat, sectorCount);
    const out = new Uint8Array(sectors.length * sectorSize);
    sectors.forEach((s, i) => out.set(sectorBytes(s), i * sectorSize));
    return size >= 0 ? out.subarray(0, Math.min(size, out.length)) : out;
  };

  // --- ディレクトリ（128バイトずつ）
  const dirBytes = readChain(dirStart, -1);
  const entries: DirEntry[] = [];
  for (let off = 0; off + 128 <= dirBytes.length; off += 128) {
    const dv = new DataView(dirBytes.buffer, dirBytes.byteOffset + off, 128);
    const nameLen = dv.getUint16(64, true);
    const type = dirBytes[off + 66];
    const nameChars: number[] = [];
    for (let i = 0; i + 2 <= Math.max(0, nameLen - 2) && i < 64; i += 2) nameChars.push(dv.getUint16(i, true));
    const sizeLow = dv.getUint32(120, true);
    const sizeHigh = dv.getUint32(124, true);
    entries.push({
      name: String.fromCharCode(...nameChars),
      type,
      start: dv.getUint32(116, true),
      // 512バイトのセクターの版は上位を使わない（ごみが入っていることがある）
      size: sectorShift === 9 ? sizeLow : sizeHigh * 2 ** 32 + sizeLow,
    });
  }
  const root = entries[0];
  if (!root || root.type !== 5) throw new CfbError("複合ファイルのルートが見つかりません");

  // --- ミニストリーム（小さいストリームはルートの中にまとめて入っている）
  let ministream: Uint8Array | null = null;
  let miniFat: Uint32Array | null = null;
  const readMini = (start: number, size: number): Uint8Array => {
    if (!ministream) ministream = readChain(root.start, root.size);
    if (!miniFat) {
      const raw = miniFatCount > 0 ? readChain(miniFatStart, -1) : new Uint8Array(0);
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      miniFat = new Uint32Array(raw.length / 4);
      for (let i = 0; i < miniFat.length; i++) miniFat[i] = dv.getUint32(i * 4, true);
    }
    const sectors = chain(start, miniFat, miniFat.length);
    const out = new Uint8Array(sectors.length * miniSize);
    sectors.forEach((s, i) => out.set(ministream!.subarray(s * miniSize, (s + 1) * miniSize), i * miniSize));
    return out.subarray(0, Math.min(size, out.length));
  };

  const streams = entries.filter((e) => e.type === 2);
  return {
    names: () => streams.map((e) => e.name),
    read: (name) => {
      const entry = streams.find((e) => e.name === name);
      if (!entry) return null;
      if (entry.size === 0) return new Uint8Array(0);
      return entry.size < miniCutoff ? readMini(entry.start, entry.size) : readChain(entry.start, entry.size);
    },
  };
}
