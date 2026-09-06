import { describe, expect, it } from "vitest";
import type { MissingAttachment } from "@/lib/tenmatsu/client";
import { MAX_PENDING_UPLOAD_BYTES, TenmatsuError } from "@/lib/tenmatsu/client";
import { SENKETSU, TENMATSU } from "@/lib/tenmatsu/kinds";
import {
  acceptMissingConfirmText,
  ATTACHMENT_ACCEPT,
  ATTACHMENT_PATTERN,
  ATTACHMENT_TYPES_TEXT,
  isDefiniteFailure,
  missingBadgeTitle,
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
