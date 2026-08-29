"use client";

/**
 * 完了報告書PDFに使うフォントの取り回し。
 *
 * 既定は同梱の Noto Sans JP。見本と同じ游ゴシックを使いたい場合は、
 * **この端末に入っているフォントファイルを利用者自身に登録してもらう**。
 * 游ゴシックは再配布できない (Microsoft/字游工房のライセンス) が、
 * フォント自身の埋め込み許可 (fsType) は「Editable」なので、
 * ライセンスを持つ端末で自分の文書に埋め込むのは許可されている。
 * 登録したフォントはこの端末の IndexedDB にだけ置き、外部へは送らない。
 */
import { loadMeta, saveMeta, deleteMeta } from "@/lib/storage";

export interface LocalFontFaces {
  /** フォントファイルの中身 (.ttc の場合もある) */
  regular: Uint8Array;
  bold: Uint8Array;
  /** .ttc の中の何番目の書体か */
  regularFaceIndex: number;
  boldFaceIndex: number;
}

export interface LocalFontInfo {
  family: string;
  regularName: string;
  boldName: string;
  /** 保存しているファイルの合計バイト数 (容量表示用) */
  bytes: number;
}

const META_FONT_INFO = "report:fontInfo";
const META_FONT_REGULAR = "report:fontRegular";
const META_FONT_BOLD = "report:fontBold";

/** ttc/ttf を読み、書体の一覧 (表示名・太さ) を返す */
export interface FaceCandidate {
  index: number;
  postscriptName: string;
  fullName: string;
  family: string;
  weight: number;
  /** UI用の派生書体 (Yu Gothic UI など) は既定では選ばない */
  isUiVariant: boolean;
}

export async function listFaces(bytes: Uint8Array): Promise<FaceCandidate[]> {
  const fontkit = await import("@pdf-lib/fontkit").then((m) => m.default ?? m);
  // fontkit は ArrayBuffer 由来の Buffer 相当を要求する
  const font = (fontkit as { create(data: Uint8Array): unknown }).create(bytes);
  const collection = font as { fonts?: unknown[] };
  const faces = (collection.fonts ?? [font]) as {
    postscriptName?: string;
    fullName?: string;
    familyName?: string;
    "OS/2"?: { usWeightClass?: number };
  }[];
  return faces.map((face, index) => {
    const postscriptName = face.postscriptName ?? `face${index}`;
    return {
      index,
      postscriptName,
      fullName: face.fullName ?? postscriptName,
      family: face.familyName ?? postscriptName,
      weight: face["OS/2"]?.usWeightClass ?? 400,
      isUiVariant: /UI/i.test(postscriptName) || /UI/i.test(face.fullName ?? ""),
    };
  });
}

/** 太さの希望に合う書体を選ぶ (UI派生は避ける) */
export function pickFace(faces: FaceCandidate[], want: "regular" | "bold"): FaceCandidate {
  const target = want === "bold" ? 700 : 400;
  const ranked = [...faces].sort((a, b) => {
    if (a.isUiVariant !== b.isUiVariant) return a.isUiVariant ? 1 : -1;
    return Math.abs(a.weight - target) - Math.abs(b.weight - target);
  });
  return ranked[0];
}

/** 登録されているフォントの情報 (未登録なら null) */
export async function loadLocalFontInfo(): Promise<LocalFontInfo | null> {
  const info = await loadMeta<LocalFontInfo>(META_FONT_INFO);
  return info ?? null;
}

/** 登録されているフォント本体 (未登録なら null) */
export async function loadLocalFonts(): Promise<LocalFontFaces | null> {
  const [info, regular, bold] = await Promise.all([
    loadLocalFontInfo(),
    loadMeta<{ bytes: Uint8Array; faceIndex: number }>(META_FONT_REGULAR),
    loadMeta<{ bytes: Uint8Array; faceIndex: number }>(META_FONT_BOLD),
  ]);
  if (!info || !regular || !bold) return null;
  return {
    regular: regular.bytes,
    bold: bold.bytes,
    regularFaceIndex: regular.faceIndex,
    boldFaceIndex: bold.faceIndex,
  };
}

/**
 * 選んでもらったフォントファイルから、通常用と太字用を割り当てて登録する。
 * 1つだけ選ばれた場合は両方に使う (太字は通常フォントの重ね描きで代用される)。
 */
export async function registerFromFiles(files: File[]): Promise<LocalFontInfo> {
  if (files.length === 0) throw new Error("フォントファイルが選ばれていません");
  const loaded = await Promise.all(
    files.slice(0, 4).map(async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      return { bytes, faces: await listFaces(bytes), name: file.name };
    }),
  );
  const heaviest = (entry: (typeof loaded)[number]) =>
    Math.max(...entry.faces.filter((f) => !f.isUiVariant).map((f) => f.weight), 0);
  const sorted = [...loaded].sort((a, b) => heaviest(a) - heaviest(b));
  const regularFile = sorted[0];
  const boldFile = sorted.length > 1 ? sorted[sorted.length - 1] : sorted[0];
  return saveLocalFonts({ regular: regularFile.bytes, bold: boldFile.bytes });
}

/** フォントファイル2つ (通常・太字) を登録する */
export async function saveLocalFonts(files: {
  regular: Uint8Array;
  bold: Uint8Array;
}): Promise<LocalFontInfo> {
  const [regularFaces, boldFaces] = await Promise.all([
    listFaces(files.regular),
    listFaces(files.bold),
  ]);
  const regular = pickFace(regularFaces, "regular");
  const bold = pickFace(boldFaces, "bold");
  const info: LocalFontInfo = {
    family: regular.family,
    regularName: regular.fullName,
    boldName: bold.fullName,
    bytes: files.regular.byteLength + files.bold.byteLength,
  };
  await saveMeta(META_FONT_REGULAR, { bytes: files.regular, faceIndex: regular.index });
  await saveMeta(META_FONT_BOLD, { bytes: files.bold, faceIndex: bold.index });
  await saveMeta(META_FONT_INFO, info);
  return info;
}

/** 登録を解除する (同梱の Noto Sans JP に戻る) */
export async function clearLocalFonts(): Promise<void> {
  await Promise.all([
    deleteMeta(META_FONT_INFO),
    deleteMeta(META_FONT_REGULAR),
    deleteMeta(META_FONT_BOLD),
  ]);
}

/** ブラウザが端末のフォント一覧を読めるか (Chrome/Edge のみ) */
export function canQueryLocalFonts(): boolean {
  return typeof window !== "undefined" && "queryLocalFonts" in window;
}

interface FontData {
  postscriptName: string;
  fullName: string;
  family: string;
  style: string;
  blob(): Promise<Blob>;
}

/**
 * 端末のフォント一覧から游ゴシック (または指定した書体) を探して登録する。
 * 権限の確認ダイアログが出る。使えない環境では null を返す。
 */
export async function registerFromLocalFonts(
  familyPattern = /^Yu Gothic$|^游ゴシック/i,
): Promise<LocalFontInfo | null> {
  if (!canQueryLocalFonts()) return null;
  const query = (window as unknown as { queryLocalFonts(): Promise<FontData[]> }).queryLocalFonts;
  const all = await query.call(window);
  const matched = all.filter((f) => familyPattern.test(f.family) && !/UI/i.test(f.fullName));
  const find = (test: RegExp) => matched.find((f) => test.test(f.postscriptName) || test.test(f.style));
  const regular = find(/Regular|Medium/i) ?? matched[0];
  const bold = find(/Bold/i) ?? regular;
  if (!regular || !bold) return null;
  const [regularBytes, boldBytes] = await Promise.all([
    regular.blob().then(async (b) => new Uint8Array(await b.arrayBuffer())),
    bold.blob().then(async (b) => new Uint8Array(await b.arrayBuffer())),
  ]);
  return saveLocalFonts({ regular: regularBytes, bold: boldBytes });
}
