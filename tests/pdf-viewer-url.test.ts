import { describe, expect, it } from "vitest";
import { pdfViewerUrl } from "@/lib/pdf-viewer-url";

describe("ブラウザの PDF 表示へ渡す URL", () => {
  it("★ページの一覧（サイドバー）を閉じて、幅いっぱいに合わせる", () => {
    expect(pdfViewerUrl("blob:https://example.test/abc")).toBe("blob:https://example.test/abc#navpanes=0&view=FitH");
  });
  it("前から付いていた指定は置き換える（二重にしない）", () => {
    expect(pdfViewerUrl("blob:x#page=2")).toBe("blob:x#navpanes=0&view=FitH");
  });
});
