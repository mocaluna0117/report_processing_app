import { describe, expect, it } from "vitest";
import type { ListItem, MissingAttachment, PdfLayoutEntry } from "@/lib/tenmatsu/client";
import type { ChosenFile } from "@/lib/tenmatsu/pending";
import { initialChosen, recomposeMissing } from "@/lib/tenmatsu/pending";
import {
  A4_PT,
  IMAGE_MARGIN_PT,
  PLACEHOLDER_ON_PC,
  buildPreviewPlan,
  imagePageBox,
  previewPageCount,
  previewUnavailableReason,
  renderableKind,
} from "@/lib/tenmatsu/preview";

/** あとからアップロードする枠（捺印決裁書。index 0 で先頭） */
const waitSlot = (files?: { file: string; name: string; size: number | null }[]) => ({
  index: 0,
  name: "あとからアップロードする書類",
  reason: "あとからアップロードする書類",
  awaiting: true,
  ...(files ? { files } : {}),
});

/** 保留中の捺印決裁書の内訳（枠は空。見積総覧1p・専決本体2p・本体2p） */
const natsuinLayout: PdfLayoutEntry[] = [
  { index: 1, name: "見積総覧（架空邸）.pdf", pages: 1 },
  { index: 2, name: "専決決裁書 本体（No.2267）", pages: 2 },
  { index: 3, name: "本体", pages: 2 },
];

const chosen = (...entries: [number, ChosenFile][]) => {
  const map = new Map<number, ChosenFile[]>();
  for (const [i, entry] of entries) map.set(i, [...(map.get(i) ?? []), entry]);
  return map;
};
const newFile = (name: string, size = 100): ChosenFile => ({ name, size });
const keptFile = (name: string, file: string): ChosenFile => ({ name, size: 0, kept: file });

const shape = (segments: ReturnType<typeof buildPreviewPlan>) =>
  (segments ?? []).map((s) =>
    s.kind === "base" ? `base ${s.from}-${s.to}` : s.kind === "file" ? `file ${s.entry.name}` : `ph ${s.entry?.name ?? ""}`,
  );

describe("確定後の姿を組み立てる（プレビュー）", () => {
  it("★何も入れていなければ土台そのまま", () => {
    const plan = buildPreviewPlan([waitSlot([])], new Map(), natsuinLayout, 5);
    expect(shape(plan)).toEqual(["base 0-5"]);
  });

  it("★入れた書類は土台の前（枠の位置）に、入れた順で並ぶ", () => {
    const plan = buildPreviewPlan(
      [waitSlot([])],
      chosen([0, newFile("申請書.pdf")], [0, newFile("委任状.pdf")]),
      natsuinLayout,
      5,
    );
    expect(shape(plan)).toEqual(["file 申請書.pdf", "file 委任状.pdf", "base 0-5"]);
  });

  it("★欠けが途中にある行では、その位置に入る（顛末書）", () => {
    // 本体2p → 写真1p → 欠けた見積(0p)
    const layout: PdfLayoutEntry[] = [
      { index: 0, name: "本体", pages: 2 },
      { index: 1, name: "写真.pdf", pages: 1 },
      { index: 2, name: "見積.pdf", pages: 0 },
    ];
    const missing = [{ index: 2, name: "見積.pdf", reason: "0バイト" }];
    const plan = buildPreviewPlan(missing, chosen([2, newFile("手書き見積.pdf")]), layout, 3);
    expect(shape(plan)).toEqual(["base 0-3", "file 手書き見積.pdf"]);
  });

  it("★欠けが真ん中のときは前後に土台が分かれる", () => {
    const layout: PdfLayoutEntry[] = [
      { index: 0, name: "本体", pages: 2 },
      { index: 1, name: "見積.pdf", pages: 0 },
      { index: 2, name: "写真.pdf", pages: 1 },
    ];
    const missing = [{ index: 1, name: "見積.pdf", reason: "0バイト" }];
    const plan = buildPreviewPlan(missing, chosen([1, newFile("見積.pdf")]), layout, 3);
    expect(shape(plan)).toEqual(["base 0-2", "file 見積.pdf", "base 2-3"]);
  });
});

describe("確定したあとの差し替えのプレビュー", () => {
  // 申請書1p・委任状1p（枠）→ 見積総覧1p → 専決本体2p → 本体2p ＝ 7ページ
  const savedLayout: PdfLayoutEntry[] = [
    { index: 0, name: "申請書.pdf", file: "000_01_申請書.pdf", pages: 1 },
    { index: 0, name: "委任状.pdf", file: "000_01_委任状.pdf", pages: 1 },
    { index: 1, name: "見積総覧（架空邸）.pdf", pages: 1 },
    { index: 2, name: "専決決裁書 本体（No.2267）", pages: 2 },
    { index: 3, name: "本体", pages: 2 },
  ];
  const saved: ListItem = {
    denpyo_no: "NK00001489",
    file: "御見積書（架空邸）.pdf",
    at: "2026-09-07T10:00:00",
    exists: true,
    pages: 7,
    size: 100,
    upload_slots: [
      {
        index: 0,
        name: "あとからアップロードする書類",
        files: [
          { file: "000_01_申請書.pdf", name: "申請書.pdf", size: 10, pages: 1 },
          { file: "000_01_委任状.pdf", name: "委任状.pdf", size: 20, pages: 1 },
        ],
      },
    ],
    pdf_layout: savedLayout,
  };

  it("★開いた直後は保存されているPDFと同じ並びになる", () => {
    const missing = recomposeMissing(saved);
    const plan = buildPreviewPlan(missing, initialChosen(missing), savedLayout, 7);
    expect(shape(plan)).toEqual(["base 0-1", "base 1-2", "base 2-7"]);
    expect(previewPageCount(plan ?? [])).toBe(7);
  });

  it("★入れてある書類を入れ替えると、そのページも入れ替わる", () => {
    const plan = buildPreviewPlan(
      recomposeMissing(saved),
      chosen(
        [0, keptFile("委任状.pdf", "000_01_委任状.pdf")],
        [0, keptFile("申請書.pdf", "000_01_申請書.pdf")],
      ),
      savedLayout,
      7,
    );
    expect(shape(plan)).toEqual(["base 1-2", "base 0-1", "base 2-7"]);
  });

  it("★外すとそのページが消え、足すと入れた位置に入る", () => {
    const plan = buildPreviewPlan(
      recomposeMissing(saved),
      chosen([0, newFile("差替.pdf")], [0, keptFile("委任状.pdf", "000_01_委任状.pdf")]),
      savedLayout,
      7,
    );
    expect(shape(plan)).toEqual(["file 差替.pdf", "base 1-2", "base 2-7"]);
    expect(previewPageCount(plan ?? [])).toBe(7); // 6 + 入れた1件
  });

  it("★土台にまだ入っていない書類は案内の1枚にする", () => {
    // 入れただけで結合前（PC側は pages を返さない）
    const layout: PdfLayoutEntry[] = natsuinLayout;
    const plan = buildPreviewPlan(
      [waitSlot([{ file: "000_01_申請書.pdf", name: "申請書.pdf", size: 10 }])],
      chosen([0, keptFile("申請書.pdf", "000_01_申請書.pdf")]),
      layout,
      5,
    );
    expect(shape(plan)).toEqual(["ph 申請書.pdf", "base 0-5"]);
    expect((plan ?? [])[0]).toMatchObject({ text: PLACEHOLDER_ON_PC });
  });

  it("入れ直したのに結合できなかった枠も、位置だけ示す", () => {
    const missing: MissingAttachment[] = [
      { index: 2, name: "見積.pdf", reason: "入れ直したファイル", filled: { name: "手書き.pdf", size: 5 } },
    ];
    const layout: PdfLayoutEntry[] = [
      { index: 0, name: "本体", pages: 2 },
      { index: 2, name: "見積.pdf", pages: 0 },
    ];
    const plan = buildPreviewPlan(missing, new Map(), layout, 2);
    expect(shape(plan)).toEqual(["base 0-2", "ph "]);
  });
});

describe("プレビューを出せないとき", () => {
  const base: ListItem = {
    denpyo_no: "NK1", file: "a.pdf", at: null, exists: true, pages: 5, size: 1,
  };

  it("★内訳が無い・食い違うときは組み立てない", () => {
    expect(buildPreviewPlan([waitSlot([])], new Map(), null, 5)).toBeNull();
    expect(buildPreviewPlan([waitSlot([])], new Map(), natsuinLayout, null)).toBeNull();
    // 合計（5）と実物（9）が合わない
    expect(buildPreviewPlan([waitSlot([])], new Map(), natsuinLayout, 9)).toBeNull();
  });

  it("★内訳の順と枠の位置が矛盾していたら組み立てない", () => {
    const layout: PdfLayoutEntry[] = [
      { index: 5, name: "本体", pages: 2 },
      { index: 1, name: "添付", pages: 1 },
    ];
    // index 1 の開始位置(0)が、index 5 を通り過ぎたカーソル(2)より前になる
    const missing = [{ index: 5, name: "本体", reason: "" }, { index: 1, name: "添付", reason: "" }];
    expect(buildPreviewPlan(missing, new Map(), layout, 3)).toBeNull();
  });

  it("理由は「未対応のサーバー」「古い記録」「PDFが無い」を言い分ける", () => {
    expect(previewUnavailableReason({ ...base })).toContain("未対応");
    expect(previewUnavailableReason({ ...base, pdf_layout: null, pending: true })).toContain(
      "この機能より前",
    );
    expect(previewUnavailableReason({ ...base, pdf_layout: null })).toContain("差し替え");
    expect(
      previewUnavailableReason({ ...base, pdf_layout: natsuinLayout, exists: false }),
    ).toContain("見つからない");
    expect(previewUnavailableReason({ ...base, pdf_layout: natsuinLayout })).toBeNull();
  });
});

describe("中身の見分けと画像の置き方", () => {
  it("★拡張子ではなく先頭のバイトで決める", () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    expect(renderableKind("写真.jpg", pdf)).toBe("pdf"); // 名前が違っても中身で決める
    expect(renderableKind("申請書.pdf", jpg)).toBe("image");
    expect(renderableKind("図.png", png)).toBe("image");
    expect(renderableKind("見積.xlsx", zip)).toBe("other");
    // 中身が読めないときだけ名前を見る（0バイトのPDFなど）
    expect(renderableKind("空.pdf", new Uint8Array())).toBe("pdf");
    expect(renderableKind("謎.bin", new Uint8Array())).toBe("other");
  });

  it("★画像の紙と位置はPC側と同じ規則（縦・横・中央）", () => {
    const portrait = imagePageBox(1000, 2000);
    expect(portrait.pageWidth).toBeCloseTo(A4_PT.width, 2);
    expect(portrait.pageHeight).toBeCloseTo(A4_PT.height, 2);
    // 余白を引いた高さいっぱいに入り、左右は中央
    expect(portrait.drawHeight).toBeCloseTo(A4_PT.height - 2 * IMAGE_MARGIN_PT, 2);
    expect(portrait.x).toBeCloseTo((A4_PT.width - portrait.drawWidth) / 2, 2);

    const landscape = imagePageBox(2000, 1000);
    expect(landscape.pageWidth).toBeCloseTo(A4_PT.height, 2); // 紙も横向きにする
    expect(landscape.pageHeight).toBeCloseTo(A4_PT.width, 2);
    expect(landscape.drawWidth).toBeCloseTo(A4_PT.height - 2 * IMAGE_MARGIN_PT, 2);
    expect(landscape.y).toBeCloseTo((landscape.pageHeight - landscape.drawHeight) / 2, 2);
  });
});
