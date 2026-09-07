import { describe, expect, it } from "vitest";
import type { MissingAttachment } from "@/lib/tenmatsu/client";
import { MAX_PENDING_UPLOAD_BYTES, TenmatsuError } from "@/lib/tenmatsu/client";
import { NATSUIN, SENKETSU, TENMATSU } from "@/lib/tenmatsu/kinds";
import {
  acceptMissingConfirmText,
  allowsMultiple,
  initialChosen,
  isKept,
  moveEntry,
  recomposeConfirmText,
  recomposeMissing,
  recomposeDisabledReason,
  recomposeIntroText,
  recomposedBadgeTitle,
  removeEntry,
  slotHintText,
  slotsAsMissing,
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

/**
 * 枠ごとの中身。同じ index を2回書けば、その枠に2つ入れたことになる
 * （並びは書いた順）。
 */
const chosen = (...entries: [number, string, number][]) => {
  const map = new Map<number, { name: string; size: number }[]>();
  for (const [i, name, size] of entries) {
    map.set(i, [...(map.get(i) ?? []), { name, size }]);
  }
  return map;
};

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
        [2, [{ name: "見積.pdf", size: 100 }]],
        [3, [{ name: "図面.pdf", size: 200 }]],
      ]),
    );
    expect(plan.ready).toBe(true);
    expect(plan.unfilled).toEqual([]);
    expect(plan.totalBytes).toBe(300);
    expect(plan.tooLarge).toBe(false);
  });

  it("★1つでも欠けていれば確定できず、どれが足りないか分かる", () => {
    const plan = pendingPlan(missing, new Map([[2, [{ name: "見積.pdf", size: 100 }]]]));
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
        [2, [{ name: "見積.pdf", size: MAX_PENDING_UPLOAD_BYTES }]],
        [3, [{ name: "図面.pdf", size: 1 }]],
      ]),
    );
    expect(plan.tooLarge).toBe(true);
  });

  it("★拡張子が変わるものは知らせるが止めない (Wordを手でPDFにするのが普通の使い方)", () => {
    const plan = pendingPlan(
      missing,
      new Map([
        [2, [{ name: "見積.PDF", size: 1 }]], // 大文字小文字は変更扱いにしない
        [3, [{ name: "図面.pdf", size: 1 }]],
      ]),
    );
    expect(plan.ready).toBe(true);
    expect(plan.extensionChanged.map((m) => m.name)).toEqual(["図面.xlsx"]);
  });

  it("選ばれていない添付は合計にも拡張子の判定にも入れない", () => {
    const plan = pendingPlan(missing, new Map([[3, [{ name: "図面.xlsx", size: 5 }]]]));
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

describe("枠に複数の書類を入れる（捺印決裁書）", () => {
  const slot = (files?: { file: string; name: string; size: number | null }[]) => ({
    ...waitSlot(),
    ...(files ? { files } : {}),
  });

  it("★1つでも入っていれば確定できる（何件入れても欠けにはしない）", () => {
    const one = pendingPlan([slot([])], chosen([0, "申請書.pdf", 100]));
    expect(one.ready).toBe(true);
    const many = pendingPlan(
      [slot([])],
      chosen([0, "申請書.pdf", 100], [0, "委任状.pdf", 200]),
    );
    expect(many.ready).toBe(true);
    expect(many.totalBytes).toBe(300);
  });

  it("★複数入れられるのは files を返す新しいサーバーだけ", () => {
    // 古いサーバーへ同じ枠に複数送ると、最後の1つしか残らない（画面でも1つに制限する）
    expect(allowsMultiple(waitSlot())).toBe(false);
    expect(allowsMultiple(slot([]))).toBe(true);
    expect(allowsMultiple(miss(2, "見積.pdf"))).toBe(false);
  });

  it("★いま入っている書類を初期の並びにする（何もしなくても確定できる）", () => {
    const missing = [
      slot([
        { file: "000_01_申請書.pdf", name: "申請書.pdf", size: 10 },
        { file: "000_02_委任状.pdf", name: "委任状.pdf", size: 20 },
      ]),
      miss(3, "専決本体"),
    ];
    const start = initialChosen(missing);
    expect(start.get(0)?.map((e) => e.name)).toEqual(["申請書.pdf", "委任状.pdf"]);
    expect(start.get(0)?.every(isKept)).toBe(true);
    expect(start.has(3)).toBe(false);
    // 残すだけのものは送らないので、1回の上限には数えない
    const plan = pendingPlan(missing, start);
    expect(plan.totalBytes).toBe(0);
    expect(plan.unfilled.map((m) => m.name)).toEqual(["専決本体"]);
  });

  it("★入れ直したあと結合できなかった枠は、選び直さなくても確定できる", () => {
    const already: MissingAttachment = {
      ...miss(2, "見積.pdf"),
      filled: { name: "手書き見積.pdf", size: 30 },
    };
    expect(pendingPlan([already], chosen()).ready).toBe(true);
  });

  it("並べ替えと外すは元の並びを壊さない", () => {
    const list = ["a", "b", "c"];
    expect(moveEntry(list, 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveEntry(list, 1, 1)).toEqual(["a", "c", "b"]);
    expect(moveEntry(list, 0, -1)).toEqual(list);      // 先頭を上へは動かさない
    expect(moveEntry(list, 2, 1)).toEqual(list);       // 末尾を下へも同じ
    expect(removeEntry(list, 1)).toEqual(["a", "c"]);
    expect(list).toEqual(["a", "b", "c"]);
  });

  it("枠の説明は件数と、複数入れられるかで変わる", () => {
    expect(slotHintText(0, true)).toContain("複数入れられます");
    expect(slotHintText(2, true)).toContain("入れた書類 2件");
    expect(slotHintText(0, false)).toContain("1つです");
  });
});

describe("確定したあとの差し替え（捺印決裁書）", () => {
  const saved = {
    denpyo_no: "NK00001489",
    file: "お見積書（架空邸）.pdf",
    at: "2026-09-07T10:00:00",
    exists: true,
    pages: 7,
    size: 100,
    upload_slots: [
      {
        index: 0,
        name: "あとからアップロードする書類",
        files: [{ file: "000_01_申請書.pdf", name: "申請書.pdf", size: 10 }],
      },
    ],
  };

  it("★確定した行の枠を、ダイアログが扱う形に直す", () => {
    const missing = slotsAsMissing(saved);
    expect(missing).toHaveLength(1);
    expect(missing[0].awaiting).toBe(true);
    expect(allowsMultiple(missing[0])).toBe(true);
    expect(initialChosen(missing).get(0)?.map((e) => e.name)).toEqual(["申請書.pdf"]);
    // 枠が無い行（顛末書・古いサーバー）は空
    expect(slotsAsMissing({ ...saved, upload_slots: undefined })).toEqual([]);
  });

  it("★欠けたまま確定した添付も、ここで足せる（足さなくても組み直せる）", () => {
    const withMissing = {
      ...saved,
      missing_attachments: [miss(3, "専決決裁書 本体（No.2267）", "見つかりませんでした")],
    };
    const list = recomposeMissing(withMissing);
    expect(list.map((m) => m.index)).toEqual([0, 3]);
    expect(list[1].optional).toBe(true);
    // 足さなくても確定できる（最初の確定で受け入れ済みの欠けなので）
    const plan = pendingPlan(list, initialChosen(list));
    expect(plan.ready).toBe(true);
    expect(missingReasonText(list[1])).toContain("入れなくても組み直せます");
    expect(recomposeIntroText(NATSUIN, 1)).toContain("欠けたまま確定した添付 1件");
    expect(recomposeIntroText(NATSUIN)).not.toContain("欠けたまま");
  });

  it("★全部外したままでは確定できない", () => {
    expect(pendingPlan(recomposeMissing(saved), new Map()).ready).toBe(false);
  });

  it("★押せない理由を出し分ける（未対応のサーバー・部品なし・取得中）", () => {
    expect(recomposeDisabledReason(saved, null)).toBeNull();
    expect(recomposeDisabledReason({ ...saved, upload_slots: undefined }, null)).toContain(
      "未対応",
    );
    expect(recomposeDisabledReason({ ...saved, upload_slots: null }, null)).toContain(
      "部品が残っていない",
    );
    expect(recomposeDisabledReason(saved, "取得中です")).toBe("取得中です");
  });

  it("★差し替えの文言に、印が外れることを書く", () => {
    expect(recomposeIntroText(NATSUIN)).toContain("同じファイル名");
    expect(recomposeIntroText(NATSUIN)).toContain("押すまで");
    const confirm = recomposeConfirmText(NATSUIN, "お見積書（架空邸）.pdf", "格納済みの印");
    expect(confirm).toContain("お見積書（架空邸）.pdf");
    expect(confirm).toContain("格納済みの印は外れます");
    expect(recomposedBadgeTitle("2026-09-08T09:00:00", "格納済みの印")).toContain(
      "格納済みの印は外してあります",
    );
  });

  it("★差し替えできる種類では「あとから足せない」と言わない", () => {
    const natsuin = acceptMissingConfirmText(NATSUIN, "お見積書.pdf", [miss(3, "専決本体")]);
    expect(natsuin).toContain("「差し替え」で足すこともできます");
    const tenmatsu = acceptMissingConfirmText(TENMATSU, "顛末書No.1.pdf", [miss(2, "見積.pdf")]);
    expect(tenmatsu).toContain("あとから足すことはできません");
  });
});
