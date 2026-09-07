import { describe, expect, it } from "vitest";
import type { MissingAttachment } from "@/lib/tenmatsu/client";
import { MAX_PENDING_UPLOAD_BYTES, TenmatsuError } from "@/lib/tenmatsu/client";
import { SENKETSU, TENMATSU } from "@/lib/tenmatsu/kinds";
import {
  acceptMissingConfirmText,
  ATTACHMENT_ACCEPT,
  ATTACHMENT_PATTERN,
  ATTACHMENT_TYPES_TEXT,
  hasAwaiting,
  isAwaiting,
  isDefiniteFailure,
  missingBadgeTitle,
  missingReasonText,
  pendingIntroText,
  pendingBadgeTitle,
  pendingErrorText,
  pendingPlan,
  retryConfirmText,
} from "@/lib/tenmatsu/pending";

const miss = (index: number, name: string, reason = "PDFとして読めませんでした"): MissingAttachment => ({
  index,
  name,
  reason,
});

/** あとから利用者がアップロードする書類の置き場（捺印決裁書） */
const waitSlot = (index = 0): MissingAttachment => ({
  index,
  name: "あとからアップロードする書類",
  reason: "あとからアップロードする書類",
  awaiting: true,
});

const chosen = (...entries: [number, string, number][]) =>
  new Map(entries.map(([i, name, size]) => [i, { name, size }]));

describe("添付の対応形式", () => {
  it("★PC側のエラー文と同じ並び・同じ文字列", () => {
    // server.py の SUPPORTED_ATTACHMENT_TEXT と1文字でも違うと、
    // 画面の案内とサーバーの断り文句が食い違う
    expect(ATTACHMENT_TYPES_TEXT).toBe(
      "PDF, JPG, JPEG, PNG, TXT, XLSX, XLS, XLSM, DOCX, DOC, PPTX, PPT, MSG",
    );
  });

  it("結合できる形だけ受け取る", () => {
    for (const ok of ["見積.pdf", "写真.JPG", "報告書.Docx", "台帳.xlsm", "連絡.msg"]) {
      expect(ATTACHMENT_PATTERN.test(ok)).toBe(true);
    }
    for (const ng of ["現場動画.mp4", "一式.zip", "見積.pdf.exe", "拡張子なし"]) {
      expect(ATTACHMENT_PATTERN.test(ng)).toBe(false);
    }
  });

  it("accept は拡張子の並び", () => {
    expect(ATTACHMENT_ACCEPT.startsWith(".pdf,.jpg,")).toBe(true);
    expect(ATTACHMENT_ACCEPT).toContain(".msg");
  });
});

describe("確定できるかの判断", () => {
  const missing = [miss(2, "見積.pdf"), miss(3, "図面.xlsx")];

  it("全部そろえば確定できる", () => {
    const plan = pendingPlan(
      missing,
      new Map([
        [2, { name: "見積.pdf", size: 100 }],
        [3, { name: "図面.pdf", size: 200 }],
      ]),
    );
    expect(plan.ready).toBe(true);
    expect(plan.unfilled).toEqual([]);
    expect(plan.totalBytes).toBe(300);
    expect(plan.tooLarge).toBe(false);
  });

  it("★1つでも欠けていれば確定できず、どれが足りないか分かる", () => {
    const plan = pendingPlan(missing, new Map([[2, { name: "見積.pdf", size: 100 }]]));
    expect(plan.ready).toBe(false);
    expect(plan.unfilled.map((m) => m.name)).toEqual(["図面.xlsx"]);
  });

  it("何も選ばなければ全部が足りない", () => {
    expect(pendingPlan(missing, new Map()).unfilled).toHaveLength(2);
  });

  it("★合計が上限を超えたら分かる", () => {
    const plan = pendingPlan(
      missing,
      new Map([
        [2, { name: "見積.pdf", size: MAX_PENDING_UPLOAD_BYTES }],
        [3, { name: "図面.pdf", size: 1 }],
      ]),
    );
    expect(plan.tooLarge).toBe(true);
  });

  it("★拡張子が変わるものは知らせるが止めない (Wordを手でPDFにするのが普通の使い方)", () => {
    const plan = pendingPlan(
      missing,
      new Map([
        [2, { name: "見積.PDF", size: 1 }], // 大文字小文字は変更扱いにしない
        [3, { name: "図面.pdf", size: 1 }],
      ]),
    );
    expect(plan.ready).toBe(true);
    expect(plan.extensionChanged.map((m) => m.name)).toEqual(["図面.xlsx"]);
  });

  it("選ばれていない添付は合計にも拡張子の判定にも入れない", () => {
    const plan = pendingPlan(missing, new Map([[3, { name: "図面.xlsx", size: 5 }]]));
    expect(plan.totalBytes).toBe(5);
    expect(plan.extensionChanged).toEqual([]);
  });
});

describe("文言", () => {
  const missing = [miss(2, "見積.pdf", "0バイト"), miss(3, "図面.xlsx", "Excelを起動できません")];

  it("バッジの説明に欠けた添付が並ぶ", () => {
    expect(pendingBadgeTitle(missing)).toContain("見積.pdf、図面.xlsx");
    expect(missingBadgeTitle(missing)).toContain("見積.pdf (0バイト)");
  });

  it("★確認の文に種類の名前と欠けた添付が入る", () => {
    const text = acceptMissingConfirmText(TENMATSU, "顛末書No.1742.pdf", missing);
    expect(text).toContain("顛末書No.1742.pdf");
    expect(text).toContain("見積.pdf、図面.xlsx");
    expect(text).toContain("顛末書");
    expect(retryConfirmText(SENKETSU, "専決決裁書No.2267.pdf")).toContain("専決決裁書を取得");
  });

  it("★確かめようがない失敗は「できなかった」と断定しない", () => {
    expect(pendingErrorText(true, "理由")).toBe("確定できませんでした (理由)");
    const vague = pendingErrorText(false, "時間切れ");
    expect(vague).toContain("確認できませんでした");
    expect(vague).toContain("一覧を再読み込み");
  });

  it("サーバーが理由を返した失敗だけ断定する", () => {
    expect(isDefiniteFailure(new TenmatsuError("badRequest", 400, "x"))).toBe(true);
    expect(isDefiniteFailure(new TenmatsuError("tooLarge", 413, "x"))).toBe(true);
    expect(isDefiniteFailure(new TenmatsuError("timeout", null, "x"))).toBe(false);
    expect(isDefiniteFailure(new TenmatsuError("network", null, "x"))).toBe(false);
    expect(isDefiniteFailure(new Error("x"))).toBe(false);
  });
});

describe("アップロード待ち（捺印決裁書）", () => {
  it("欠けの中に1つでもあれば「アップロード待ち」と呼ぶ", () => {
    expect(hasAwaiting([])).toBe(false);
    expect(hasAwaiting([miss(2, "見積.pdf")])).toBe(false);
    expect(hasAwaiting([waitSlot()])).toBe(true);
    // 専決決裁書の本体も欠けている混在の行。捺印決裁書だけ否定的な言い方にしない
    expect(hasAwaiting([waitSlot(), miss(3, "専決決裁書 本体（No.2267）")])).toBe(true);
    expect(isAwaiting(miss(2, "見積.pdf"))).toBe(false);
  });

  it("★理由は「結合できなかった」ではなく前向きな文にする", () => {
    expect(missingReasonText(waitSlot())).toContain("ここに入れて確定");
    expect(missingReasonText(miss(2, "見積.pdf", "0バイト"))).toBe("0バイト");
  });

  it("★書類が選ばれるまで hasAwaiting が真（＝欠けたまま確定を出さない）", () => {
    const missing = [waitSlot(), miss(3, "専決決裁書 本体（No.2267）")];
    const none = pendingPlan(missing, chosen());
    expect(none.ready).toBe(false);
    expect(none.hasAwaiting).toBe(true);
    // 書類を入れれば、残るのは「結合できなかった分」だけ
    const filled = pendingPlan(missing, chosen([0, "申請書.pdf", 1000]));
    expect(filled.ready).toBe(false);
    expect(filled.hasAwaiting).toBe(false);
    const all = pendingPlan(missing, chosen([0, "申請書.pdf", 1000], [3, "専決.pdf", 2000]));
    expect(all.ready).toBe(true);
    expect(all.hasAwaiting).toBe(false);
  });

  it("★アップロードの枠では「形式が違う」と言わない（元の名前に拡張子が無い）", () => {
    const plan = pendingPlan([waitSlot()], chosen([0, "申請書.pdf", 500]));
    expect(plan.extensionChanged).toEqual([]);
  });

  it("バッジの説明を出し分ける", () => {
    expect(pendingBadgeTitle([waitSlot()])).toContain("入れると確定できます");
    expect(pendingBadgeTitle([waitSlot(), miss(3, "専決本体")]))
      .toContain("結合できなかった添付 (専決本体)");
    expect(pendingBadgeTitle([miss(2, "見積.pdf")])).toContain("添付を結合できなかったので");
  });

  it("★ダイアログの冒頭文は、アップロード待ちが無ければ今までどおり", () => {
    const plain = pendingIntroText(TENMATSU, [miss(2, "見積.pdf")]);
    expect(plain).toContain("結合できなかったのは次の 1件です");
    expect(plain).not.toContain("あとからアップロードする書類が必要");

    const wait = pendingIntroText(SENKETSU, [waitSlot()]);
    expect(wait).toContain("専決決裁書には、あとからアップロードする書類が必要です");
    expect(wait).not.toContain("結合できなかった添付も");

    const both = pendingIntroText(SENKETSU, [waitSlot(), miss(3, "専決本体")]);
    expect(both).toContain("結合できなかった添付も 1件あります");
  });
});
