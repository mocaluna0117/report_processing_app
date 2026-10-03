/**
 * パスワード付きの xlsx（Office の「Agile 暗号」、ECMA-376 / MS-OFFCRYPTO 2.3.4.10〜）をブラウザの中で開く。
 *
 * 2026-10-03: 年次点検進捗管理表がパスワード付きのまま Box に置かれているため（支出報告書で読む）。
 * ★パスワードも中身も外へ送らない（WebCrypto だけで復号する）。パスワードは保存しない。
 *
 * 手順:
 *   1. 複合ファイルから EncryptionInfo（XML）と EncryptedPackage を取り出す
 *   2. パスワード → ハッシュを spinCount 回 → 用途ごとの鍵（検証用・鍵の復号用）
 *   3. 検証用の値でパスワードを確かめる（違えば WrongPasswordError）
 *   4. 本当の鍵を取り出し、本体を 4096 バイトずつ復号（IV は塩とかたまりの番号から作る）
 */
import { CfbError, isCfb, readCfb } from "./cfb";
import { sha512 } from "./sha512";

export class WrongPasswordError extends Error {
  constructor() {
    super("パスワードが違います");
    this.name = "WrongPasswordError";
  }
}

export class EncryptedXlsxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptedXlsxError";
  }
}

const BLOCK_VERIFIER_INPUT = new Uint8Array([0xfe, 0xa7, 0xd2, 0x76, 0x3b, 0x4b, 0x9e, 0x79]);
const BLOCK_VERIFIER_VALUE = new Uint8Array([0xd7, 0xaa, 0x0f, 0x6d, 0x30, 0x61, 0x34, 0x4e]);
const BLOCK_KEY_VALUE = new Uint8Array([0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6]);
const SEGMENT = 4096;

const HASHES: Record<string, string> = { SHA1: "SHA-1", "SHA-1": "SHA-1", SHA256: "SHA-256", SHA384: "SHA-384", SHA512: "SHA-512" };

export interface AgileParams {
  keyData: { salt: Uint8Array; blockSize: number; keyBits: number; hash: string };
  password: {
    salt: Uint8Array;
    blockSize: number;
    keyBits: number;
    hash: string;
    spinCount: number;
    encryptedVerifierHashInput: Uint8Array;
    encryptedVerifierHashValue: Uint8Array;
    encryptedKeyValue: Uint8Array;
  };
}

/** パスワード付きの Office ファイル（中に EncryptionInfo がある複合ファイル）か */
export function isEncryptedOffice(bytes: Uint8Array): boolean {
  if (!isCfb(bytes)) return false;
  try {
    return readCfb(bytes).names().includes("EncryptionInfo");
  } catch {
    return false;
  }
}

const b64 = (s: string): Uint8Array => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

function attr(tag: string, name: string): string {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  if (!m) throw new EncryptedXlsxError(`暗号の情報に ${name} がありません`);
  return m[1];
}

/** EncryptionInfo を読む。Agile（版 4.4）だけを扱う */
export function parseEncryptionInfo(info: Uint8Array): AgileParams {
  if (info.length < 8) throw new EncryptedXlsxError("暗号の情報が短すぎます");
  const major = info[0] | (info[1] << 8);
  const minor = info[2] | (info[3] << 8);
  if (major !== 4 || minor !== 4) {
    throw new EncryptedXlsxError(`この暗号の形式（${major}.${minor}）には対応していません。Excel でパスワードを付け直して保存してください`);
  }
  const xml = new TextDecoder().decode(info.subarray(8));
  const keyData = /<keyData\b[^>]*>/.exec(xml)?.[0];
  const encKey = /<(?:\w+:)?encryptedKey\b[^>]*>/.exec(xml)?.[0];
  if (!keyData || !encKey) throw new EncryptedXlsxError("パスワードで開く形式ではありません");
  const hashOf = (tag: string) => {
    const h = HASHES[attr(tag, "hashAlgorithm").toUpperCase()];
    if (!h) throw new EncryptedXlsxError("この暗号のハッシュには対応していません");
    return h;
  };
  for (const tag of [keyData, encKey]) {
    if (attr(tag, "cipherAlgorithm") !== "AES" || attr(tag, "cipherChaining") !== "ChainingModeCBC") {
      throw new EncryptedXlsxError("この暗号の方式には対応していません");
    }
  }
  return {
    keyData: {
      salt: b64(attr(keyData, "saltValue")),
      blockSize: Number(attr(keyData, "blockSize")),
      keyBits: Number(attr(keyData, "keyBits")),
      hash: hashOf(keyData),
    },
    password: {
      salt: b64(attr(encKey, "saltValue")),
      blockSize: Number(attr(encKey, "blockSize")),
      keyBits: Number(attr(encKey, "keyBits")),
      hash: hashOf(encKey),
      spinCount: Number(attr(encKey, "spinCount")),
      encryptedVerifierHashInput: b64(attr(encKey, "encryptedVerifierHashInput")),
      encryptedVerifierHashValue: b64(attr(encKey, "encryptedVerifierHashValue")),
      encryptedKeyValue: b64(attr(encKey, "encryptedKeyValue")),
    },
  };
}

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

/** 長さをそろえる（足りなければ埋める。埋める値は用途で違う） */
function fit(bytes: Uint8Array, length: number, pad: number): Uint8Array {
  if (bytes.length >= length) return bytes.slice(0, length);
  const out = new Uint8Array(length).fill(pad);
  out.set(bytes);
  return out;
}

const digest = async (hash: string, data: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest(hash, data as BufferSource));

/** パスワードから、ブロック鍵ごとの鍵を作る前の値（spinCount 回のハッシュ）。時間がかかるので1回だけ */
async function passwordHash(password: string, p: AgileParams["password"]): Promise<Uint8Array> {
  const pw = new Uint8Array(password.length * 2);
  for (let i = 0; i < password.length; i++) {
    const c = password.charCodeAt(i);
    pw[i * 2] = c & 0xff;
    pw[i * 2 + 1] = c >>> 8;
  }
  let h: Uint8Array = await digest(p.hash, concat(p.salt, pw));
  const buf = new Uint8Array(4 + h.length);
  // ★SHA-512 は同期の実装でまわす（WebCrypto だと 10万回で 8 秒かかる）
  const step = p.hash === "SHA-512" ? (d: Uint8Array) => Promise.resolve(sha512(d)) : (d: Uint8Array) => digest(p.hash, d);
  for (let i = 0; i < p.spinCount; i++) {
    buf.set(le32(i), 0);
    buf.set(h, 4);
    h = await step(buf);
  }
  return h;
}

/**
 * パディング無しの AES-CBC 復号。WebCrypto は PKCS#7 の詰め物を必ず外そうとするので、
 * 「詰め物だけのかたまり」を暗号化したものを後ろに足してから復号し、それを外させる。
 */
export async function aesCbcRaw(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  if (data.length === 0) return new Uint8Array(0);
  if (data.length % 16 !== 0) throw new EncryptedXlsxError("暗号のかたまりの長さが合いません");
  const k = await crypto.subtle.importKey("raw", key as BufferSource, "AES-CBC", false, ["encrypt", "decrypt"]);
  const last = data.subarray(data.length - 16);
  const padBlock = new Uint8Array(16).fill(16);
  const extra = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: last as BufferSource }, k, padBlock)).subarray(0, 16);
  const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv: iv as BufferSource }, k, concat(data, extra) as BufferSource);
  return new Uint8Array(plain);
}

async function blockKey(hash: string, base: Uint8Array, block: Uint8Array, keyBits: number): Promise<Uint8Array> {
  return fit(await digest(hash, concat(base, block)), keyBits / 8, 0x36);
}

/** 復号した本当の鍵（パスワードが違えば WrongPasswordError） */
export async function unlockKey(params: AgileParams, password: string): Promise<Uint8Array> {
  const p = params.password;
  const base = await passwordHash(password, p);
  const iv = fit(p.salt, p.blockSize, 0x36);
  const [kIn, kVal, kKey] = await Promise.all([
    blockKey(p.hash, base, BLOCK_VERIFIER_INPUT, p.keyBits),
    blockKey(p.hash, base, BLOCK_VERIFIER_VALUE, p.keyBits),
    blockKey(p.hash, base, BLOCK_KEY_VALUE, p.keyBits),
  ]);
  const input = (await aesCbcRaw(kIn, iv, p.encryptedVerifierHashInput)).subarray(0, p.salt.length);
  const expected = await digest(p.hash, input);
  const value = await aesCbcRaw(kVal, iv, p.encryptedVerifierHashValue);
  if (!expected.every((b, i) => value[i] === b)) throw new WrongPasswordError();
  return (await aesCbcRaw(kKey, iv, p.encryptedKeyValue)).subarray(0, params.keyData.keyBits / 8);
}

/** EncryptedPackage を復号して、本来の xlsx（ZIP）のバイト列を返す */
export async function decryptPackage(params: AgileParams, key: Uint8Array, pkg: Uint8Array): Promise<Uint8Array> {
  if (pkg.length < 8) throw new EncryptedXlsxError("暗号化された本体が短すぎます");
  const view = new DataView(pkg.buffer, pkg.byteOffset, pkg.byteLength);
  const size = view.getUint32(0, true) + view.getUint32(4, true) * 2 ** 32;
  const body = pkg.subarray(8);
  const out = new Uint8Array(Math.ceil(body.length / 16) * 16);
  const { salt, blockSize, hash } = params.keyData;
  for (let i = 0, o = 0; o < body.length; i++, o += SEGMENT) {
    let chunk = body.subarray(o, Math.min(o + SEGMENT, body.length));
    if (chunk.length % 16 !== 0) chunk = fit(chunk, Math.ceil(chunk.length / 16) * 16, 0);
    const iv = fit(await digest(hash, concat(salt, le32(i))), blockSize, 0x36);
    out.set(await aesCbcRaw(key, iv, chunk), o);
  }
  if (size > out.length) throw new EncryptedXlsxError("暗号化された本体が途中で切れています");
  return out.subarray(0, size);
}

/**
 * パスワード付きの xlsx を開く。戻り値は普通の xlsx（ZIP）のバイト列。
 * ★パスワードが違えば WrongPasswordError。暗号の形式が違えば EncryptedXlsxError。
 */
export async function decryptXlsx(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  let info: Uint8Array | null;
  let pkg: Uint8Array | null;
  try {
    const cfb = readCfb(bytes);
    info = cfb.read("EncryptionInfo");
    pkg = cfb.read("EncryptedPackage");
  } catch (e) {
    if (e instanceof CfbError) throw new EncryptedXlsxError(`ファイルを読めませんでした（${e.message}）`);
    throw e;
  }
  if (!info || !pkg) throw new EncryptedXlsxError("パスワード付きの Excel ファイルではありません");
  const params = parseEncryptionInfo(info);
  const key = await unlockKey(params, password);
  const plain = await decryptPackage(params, key, pkg);
  if (plain[0] !== 0x50 || plain[1] !== 0x4b) throw new WrongPasswordError();
  return plain;
}
