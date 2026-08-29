/**
 * フォントを「その文書で使う文字だけ」に絞る (HarfBuzz の hb-subset を WebAssembly で使う)。
 *
 * pdf-lib (fontkit) のサブセット化は字形数の多い日本語フォントで字形が欠けるため使えない。
 * ここで先に小さくしてから、pdf-lib には subset:false で丸ごと埋め込む。
 * TrueType Collection (.ttc) から1書体だけ取り出すこともできる (faceIndex)。
 */

/** hb-subset の WebAssembly が公開している関数 */
interface HbSubsetExports {
  memory: WebAssembly.Memory;
  malloc(size: number): number;
  free(pointer: number): void;
  hb_blob_create(data: number, length: number, mode: number, userData: number, destroy: number): number;
  hb_blob_destroy(blob: number): void;
  hb_blob_get_data(blob: number, lengthOut: number): number;
  hb_blob_get_length(blob: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(face: number): void;
  hb_face_reference_blob(face: number): number;
  hb_set_add(set: number, codepoint: number): void;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(input: number): void;
  hb_subset_input_unicode_set(input: number): number;
  hb_subset_input_set_flags(input: number, flags: number): void;
  hb_subset_or_fail(face: number, input: number): number;
}

/** hb_subset_flags_t: 名前・レイアウト情報を残す (PDFの表示名や記号の欠落を防ぐ) */
const HB_SUBSET_FLAGS_RETAIN_GIDS = 0x0002;
const HB_SUBSET_FLAGS_NAME_LEGACY = 0x0008;
const HB_MEMORY_MODE_READONLY = 0;

let wasmPromise: Promise<WebAssembly.Instance> | null = null;

/** WebAssembly を読み込む (ブラウザは /report/harfbuzz-subset.wasm、Nodeは node_modules から) */
async function loadWasm(): Promise<WebAssembly.Instance> {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      const bytes = await readWasmBytes();
      const { instance } = await WebAssembly.instantiate(bytes, {});
      return instance;
    })().catch((e) => {
      wasmPromise = null;
      throw e;
    });
  }
  return wasmPromise;
}

async function readWasmBytes(): Promise<BufferSource> {
  if (typeof window !== "undefined") {
    const res = await fetch("/report/harfbuzz-subset.wasm", { cache: "force-cache" });
    if (!res.ok) throw new Error(`フォント圧縮モジュールを読み込めません (${res.status})`);
    return await res.arrayBuffer();
  }
  // Node (テスト・開発スクリプト)。パッケージ内のファイルは exports で公開されていないので
  // 入口のパスから辿る
  const { readFile } = await import("node:fs/promises");
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const require = createRequire(pathToFileURL(join(process.cwd(), "package.json")));
  const entry = require.resolve("harfbuzzjs");
  const path = join(dirname(entry.startsWith("file:") ? fileURLToPath(entry) : entry), "harfbuzz-subset.wasm");
  const buffer = await readFile(path);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

export interface SubsetOptions {
  /** .ttc の中の何番目の書体か (単体フォントは0) */
  faceIndex?: number;
}

/**
 * font を text に出てくる文字だけに絞って返す。
 * 元のフォントに無い文字は黙って落ちる (呼び出し側で不足を検査する)。
 */
export async function subsetFont(
  font: Uint8Array,
  codePoints: Iterable<number>,
  options: SubsetOptions = {},
): Promise<Uint8Array> {
  const instance = await loadWasm();
  const hb = instance.exports as unknown as HbSubsetExports;
  const heap = () => new Uint8Array(hb.memory.buffer);

  const fontPointer = hb.malloc(font.byteLength);
  heap().set(font, fontPointer);
  const blob = hb.hb_blob_create(
    fontPointer,
    font.byteLength,
    HB_MEMORY_MODE_READONLY,
    0,
    0,
  );
  const face = hb.hb_face_create(blob, options.faceIndex ?? 0);
  const input = hb.hb_subset_input_create_or_fail();
  if (!input) {
    hb.hb_face_destroy(face);
    hb.hb_blob_destroy(blob);
    hb.free(fontPointer);
    throw new Error("フォントのサブセット化を開始できませんでした");
  }
  try {
    hb.hb_subset_input_set_flags(input, HB_SUBSET_FLAGS_NAME_LEGACY);
    const unicodes = hb.hb_subset_input_unicode_set(input);
    for (const cp of codePoints) hb.hb_set_add(unicodes, cp);

    const subset = hb.hb_subset_or_fail(face, input);
    if (!subset) throw new Error("フォントのサブセット化に失敗しました");
    try {
      const resultBlob = hb.hb_face_reference_blob(subset);
      const length = hb.hb_blob_get_length(resultBlob);
      const data = hb.hb_blob_get_data(resultBlob, 0);
      // WebAssembly のメモリは後で解放されるのでコピーして返す
      const out = heap().slice(data, data + length);
      hb.hb_blob_destroy(resultBlob);
      return out;
    } finally {
      hb.hb_face_destroy(subset);
    }
  } finally {
    hb.hb_subset_input_destroy(input);
    hb.hb_face_destroy(face);
    hb.hb_blob_destroy(blob);
    hb.free(fontPointer);
  }
}

/** 文字列から必要なコードポイントを集める (常に入れておく記号も足す) */
export function codePointsOf(texts: Iterable<string>, always = " 〓"): Set<number> {
  const set = new Set<number>();
  for (const text of [...texts, always]) {
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp !== undefined) set.add(cp);
    }
  }
  return set;
}

void HB_SUBSET_FLAGS_RETAIN_GIDS;
