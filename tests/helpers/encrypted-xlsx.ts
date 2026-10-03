/**
 * テスト用: xlsx を Office の「Agile 暗号」で暗号化し、複合ファイル（CFB）に包む。
 * 本番のコードには無い向き（暗号化）なので、テストの中だけに置く。
 * spinCount は既定 1000（本物は 100000。テストを速くするため）。
 */

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const le32 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
const fit = (b: Uint8Array, len: number, pad: number) => {
  if (b.length >= len) return b.slice(0, len);
  const out = new Uint8Array(len).fill(pad);
  out.set(b);
  return out;
};
const sha512 = async (d: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-512", d as BufferSource));
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

/** パディング無しの AES-CBC 暗号化（長さは16の倍数であること） */
async function aesEncryptRaw(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, "AES-CBC", false, ["encrypt"]);
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: iv as BufferSource }, k, data as BufferSource));
  return out.subarray(0, data.length);
}

export async function encryptAgile(
  plain: Uint8Array,
  password: string,
  options: { spinCount?: number } = {},
): Promise<{ info: Uint8Array; pkg: Uint8Array }> {
  const spinCount = options.spinCount ?? 1000;
  const keySalt = crypto.getRandomValues(new Uint8Array(16));
  const pwSalt = crypto.getRandomValues(new Uint8Array(16));
  const secret = crypto.getRandomValues(new Uint8Array(32));

  const pw = new Uint8Array(password.length * 2);
  for (let i = 0; i < password.length; i++) {
    pw[i * 2] = password.charCodeAt(i) & 0xff;
    pw[i * 2 + 1] = password.charCodeAt(i) >>> 8;
  }
  let h = await sha512(concat(pwSalt, pw));
  for (let i = 0; i < spinCount; i++) h = await sha512(concat(le32(i), h));
  const derive = async (block: number[]) => fit(await sha512(concat(h, new Uint8Array(block))), 32, 0x36);
  const kIn = await derive([0xfe, 0xa7, 0xd2, 0x76, 0x3b, 0x4b, 0x9e, 0x79]);
  const kVal = await derive([0xd7, 0xaa, 0x0f, 0x6d, 0x30, 0x61, 0x34, 0x4e]);
  const kKey = await derive([0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6]);
  const iv = pwSalt;
  const verifier = crypto.getRandomValues(new Uint8Array(16));
  const encIn = await aesEncryptRaw(kIn, iv, verifier);
  const encVal = await aesEncryptRaw(kVal, iv, await sha512(verifier));
  const encKey = await aesEncryptRaw(kKey, iv, secret);

  const segments: Uint8Array[] = [];
  for (let i = 0, o = 0; o < plain.length; i++, o += 4096) {
    const chunk = plain.subarray(o, Math.min(o + 4096, plain.length));
    const padded = fit(chunk, Math.ceil(chunk.length / 16) * 16, 0);
    const segIv = fit(await sha512(concat(keySalt, le32(i))), 16, 0x36);
    segments.push(await aesEncryptRaw(secret, segIv, padded));
  }
  const pkg = concat(le32(plain.length), le32(0), ...segments);

  const common = `blockSize="16" keyBits="256" hashSize="64" cipherAlgorithm="AES" cipherChaining="ChainingModeCBC" hashAlgorithm="SHA512"`;
  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
    `<encryption xmlns="http://schemas.microsoft.com/office/2006/encryption" xmlns:p="http://schemas.microsoft.com/office/2006/keyEncryptor/password">` +
    `<keyData saltSize="16" ${common} saltValue="${b64(keySalt)}"/>` +
    `<dataIntegrity encryptedHmacKey="" encryptedHmacValue=""/>` +
    `<keyEncryptors><keyEncryptor uri="http://schemas.microsoft.com/office/2006/keyEncryptor/password">` +
    `<p:encryptedKey spinCount="${spinCount}" saltSize="16" ${common} saltValue="${b64(pwSalt)}" ` +
    `encryptedVerifierHashInput="${b64(encIn)}" encryptedVerifierHashValue="${b64(encVal)}" encryptedKeyValue="${b64(encKey)}"/>` +
    `</keyEncryptor></keyEncryptors></encryption>`;
  const info = concat(new Uint8Array([4, 0, 4, 0, 0x40, 0, 0, 0]), new TextEncoder().encode(xml));
  return { info, pkg };
}

/** 複合ファイル（512バイトのセクター）を作る。4096バイト未満のストリームはミニストリームに入れる */
export function writeCfb(streams: { name: string; data: Uint8Array }[]): Uint8Array {
  const SECTOR = 512;
  const MINI = 64;
  const CUTOFF = 4096;
  const ceil = (n: number, d: number) => Math.ceil(n / d);

  const mini = streams.filter((s) => s.data.length > 0 && s.data.length < CUTOFF);
  const big = streams.filter((s) => s.data.length >= CUTOFF);
  const miniSectorsOf = (s: { data: Uint8Array }) => ceil(s.data.length, MINI);
  const miniTotal = mini.reduce((n, s) => n + miniSectorsOf(s), 0);
  const ministreamBytes = miniTotal * MINI;
  const ministreamSectors = ceil(ministreamBytes, SECTOR);
  const miniFatSectors = ceil(miniTotal * 4, SECTOR);
  const dirSectors = ceil((streams.length + 1) * 128, SECTOR);
  const bigSectors = big.reduce((n, s) => n + ceil(s.data.length, SECTOR), 0);
  let fatSectors = 1;
  while (fatSectors * 128 < fatSectors + dirSectors + miniFatSectors + ministreamSectors + bigSectors) fatSectors++;
  if (fatSectors > 109) throw new Error("テスト用の CFB には大きすぎます");
  const total = fatSectors + dirSectors + miniFatSectors + ministreamSectors + bigSectors;

  const fat = new Uint32Array(fatSectors * 128).fill(0xffffffff);
  let next = 0;
  const alloc = (count: number, special?: number): number => {
    if (count === 0) return 0xfffffffe;
    const start = next;
    for (let i = 0; i < count; i++) fat[start + i] = special ?? (i === count - 1 ? 0xfffffffe : start + i + 1);
    next += count;
    return start;
  };
  alloc(fatSectors, 0xfffffffd);
  const dirStart = alloc(dirSectors);
  const miniFatStart = alloc(miniFatSectors);
  const ministreamStart = alloc(ministreamSectors);

  const out = new Uint8Array((total + 1) * SECTOR);
  const dv = new DataView(out.buffer);
  out.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  dv.setUint16(24, 0x3e, true);
  dv.setUint16(26, 3, true);
  dv.setUint16(28, 0xfffe, true);
  dv.setUint16(30, 9, true);
  dv.setUint16(32, 6, true);
  dv.setUint32(44, fatSectors, true);
  dv.setUint32(48, dirStart, true);
  dv.setUint32(56, CUTOFF, true);
  dv.setUint32(60, miniFatSectors ? miniFatStart : 0xfffffffe, true);
  dv.setUint32(64, miniFatSectors, true);
  dv.setUint32(68, 0xfffffffe, true);
  dv.setUint32(72, 0, true);
  for (let i = 0; i < 109; i++) dv.setUint32(76 + i * 4, i < fatSectors ? i : 0xffffffff, true);
  const at = (sector: number) => (sector + 1) * SECTOR;

  // ミニストリームとミニ FAT
  const miniFat = new Uint32Array(Math.max(miniFatSectors * 128, 0)).fill(0xffffffff);
  const ministream = new Uint8Array(ministreamSectors * SECTOR);
  const starts = new Map<string, number>();
  let m = 0;
  for (const s of mini) {
    const n = miniSectorsOf(s);
    starts.set(s.name, m);
    for (let i = 0; i < n; i++) miniFat[m + i] = i === n - 1 ? 0xfffffffe : m + i + 1;
    ministream.set(s.data, m * MINI);
    m += n;
  }
  for (const s of big) {
    const n = ceil(s.data.length, SECTOR);
    const start = alloc(n);
    starts.set(s.name, start);
    out.set(s.data, at(start));
  }
  out.set(ministream, at(ministreamStart));
  out.set(new Uint8Array(miniFat.buffer), at(miniFatStart));
  out.set(new Uint8Array(fat.buffer), at(0));

  // ディレクトリ（ルートの子を右の兄弟で1列につなぐ）
  const entry = (i: number, name: string, type: number, start: number, size: number, child: number, right: number) => {
    const o = at(dirStart) + i * 128;
    for (let k = 0; k < name.length; k++) dv.setUint16(o + k * 2, name.charCodeAt(k), true);
    dv.setUint16(o + 64, (name.length + 1) * 2, true);
    out[o + 66] = type;
    out[o + 67] = 1;
    dv.setUint32(o + 68, 0xffffffff, true);
    dv.setUint32(o + 72, right, true);
    dv.setUint32(o + 76, child, true);
    dv.setUint32(o + 116, start, true);
    dv.setUint32(o + 120, size, true);
  };
  entry(0, "Root Entry", 5, ministreamSectors ? ministreamStart : 0xfffffffe, ministreamBytes, streams.length ? 1 : 0xffffffff, 0xffffffff);
  streams.forEach((s, i) =>
    entry(i + 1, s.name, 2, starts.get(s.name) ?? 0xfffffffe, s.data.length, 0xffffffff, i + 1 < streams.length ? i + 2 : 0xffffffff),
  );
  return out;
}

export async function encryptXlsx(plain: Uint8Array, password: string, options: { spinCount?: number } = {}): Promise<Uint8Array> {
  const { info, pkg } = await encryptAgile(plain, password, options);
  return writeCfb([
    { name: "EncryptionInfo", data: info },
    { name: "EncryptedPackage", data: pkg },
  ]);
}
