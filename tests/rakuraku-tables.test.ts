import { describe, expect, it } from "vitest";
import {
  type TableData,
  diffAddedLines,
  findLabelCol,
  pickFinalApprovedAt,
  pickLabeledValue,
  pickPjNearLabel,
  tableContentKey,
  tableSignature,
} from "@/lib/rakuraku/parse/tables";

// 期待値は移植元の検証 (tenmatsu-dl/server_test.py「承認履歴」「ラベル→値」「どこで」) から写した。架空の値
const DATE_COLS = ["日付", "承認日", "処理日", "日時"];
const EXCL = ["差戻", "取下", "却下", "否認"];
const pick = (tables: TableData[], opts: Partial<Parameters<typeof pickFinalApprovedAt>[1]> = {}) =>
  pickFinalApprovedAt(tables, { dateColumns: DATE_COLS, excludeWords: EXCL, ...opts });

const LOG_TABLE: TableData = {
  isNew: true,
  rows: [
    ["順番", "承認部門", "承認者", "日付", "処理", "コメント"],
    ["1", "アフターメンテナンス課", "テスト 太郎", "2026/09/04 17:51:38", "申請", ""],
    ["2", "品質管理部", "テスト 花子", "2026/09/08 09:20:11", "差戻し", "金額を確認"],
    ["3", "品質管理部", "テスト 花子", "2026/09/05 10:00:00", "承認", ""],
    ["4", "管理本部", "テスト 一郎", "2026/09/06 13:45", "承認", ""],
    ["5", "管理本部", "テスト 二郎", "", "", ""],
  ],
};

describe("最終承認日 — 「日付」列のいちばん新しい日付を採る（差戻しは除く）", () => {
  it("いちばん新しい承認の日付を採る（並び順に依存しない）", () => {
    expect(pick([LOG_TABLE])).toBe("2026/09/06 13:45");
  });
  it("★差戻しの行は日付が新しくても採らない", () => {
    expect(pick([LOG_TABLE])).not.toBe("2026/09/08 09:20:11");
  });
  it("秒の無い行は秒を作らずそのまま返す", () => {
    expect((pick([LOG_TABLE]) ?? "").split(":").length - 1).toBe(1);
  });
  it("見出しが「承認日」でも見つける", () => {
    expect(pick([{ isNew: true, rows: [["承認者", "承認日"], ["A", "2026/09/05"], ["B", "2026/09/07"]] }])).toBe(
      "2026/09/07",
    );
  });
  it("日付として読めるものが無ければ null", () => {
    expect(
      pick([{ isNew: true, rows: [["承認者", "日付"], ["A", "----"], ["B", "9999/99/99"], ["C", "承認待ち"]] }]),
    ).toBeNull();
  });
  it("★差戻ししか無ければ null（差戻しの日を代わりに返さない）", () => {
    expect(pick([{ isNew: true, rows: [["承認者", "日付", "処理"], ["A", "2026/09/08", "差戻し"]] }])).toBeNull();
  });
  it("除外語を空にすれば差戻しも候補になる", () => {
    expect(pick([LOG_TABLE], { excludeWords: [] })).toBe("2026/09/08 09:20:11");
  });
  it("同じ日付が複数あっても同じ値を返す", () => {
    expect(pick([{ isNew: true, rows: [["日付"], ["2026/09/05"], ["2026/09/05"]] }])).toBe("2026/09/05");
  });
  it("見出しが無くても、クリック後に現れた承認履歴らしい表なら全セルから採る", () => {
    expect(
      pick([{ isNew: true, rows: [["テスト 一郎 承認 2026/09/09"], ["テスト 二郎 承認 2026/09/10"]] }], {
        keywords: ["承認"],
      }),
    ).toBe("2026/09/10");
  });
  it("★クリック前からあった表（支払予定日など）からは採らない", () => {
    expect(
      pick([{ isNew: false, rows: [["支払予定日", "2026/10/31"], ["承認", "済"]] }], { keywords: ["承認"] }),
    ).toBeNull();
  });

  // ★実際に起きた不具合: 伝票画面に元からある「承認ルート」は「日付」列を持ち、時刻が無い。
  //   ダイアログが出る前にこれを読むと、多くの記録が日付だけになった
  const routeOld: TableData = {
    isNew: false,
    rows: [
      ["承認部門", "承認者", "コード", "日付"],
      ["管理本部", "テスト 一郎", "990001", "2026/09/02"],
      ["管理本部", "テスト 二郎", "990016", "2026/09/03"],
    ],
  };
  it("★クリック前からあった「日付」列の表（承認ルート）からも採らない", () => {
    expect(pick([routeOld])).toBeNull();
  });
  it("★ダイアログの表と並んでいてもダイアログ側を採る", () => {
    expect(pick([routeOld, LOG_TABLE])).toBe("2026/09/06 13:45");
  });
  it("requireNew=false なら元からある表も読む（確認用の退路）", () => {
    expect(pick([routeOld], { requireNew: false })).toBe("2026/09/03");
  });
  it("表が無ければ null", () => {
    expect(pick([])).toBeNull();
    expect(pick([{ rows: [] }])).toBeNull();
  });
});

describe("クリック前後の表の見分け", () => {
  it("★中身が変わった表は「現れた表」として数える（同じ表に流し込む作りに備える）", () => {
    const same: TableData = { id: "t1", cls: "c", rows: [["日付"], ["2026/09/02"]] };
    const grew: TableData = { id: "t1", cls: "c", rows: [["日付"], ["2026/09/02"], ["2026/09/06 13:45"]] };
    expect(tableSignature(same)).toBe(tableSignature(grew));
    expect(tableContentKey(same)).not.toBe(tableContentKey(grew));
  });
  it("行もセルも無い表でも落ちない", () => {
    expect(tableSignature({ rows: [] })).toBe("||");
  });
  it("増えた行だけを返す", () => {
    expect(diffAddedLines("a\nb", "a\nb\n承認 2026/09/06\n")).toEqual(["承認 2026/09/06"]);
  });
  it("前後の空白と空行は無視する", () => {
    expect(diffAddedLines(" a \n", "a\n\n  b  \r\nc")).toEqual(["b", "c"]);
  });
});

describe("ラベル→値 — 伝票画面の表からラベルの隣の値を取る", () => {
  const DETAIL: TableData[] = [
    {
      rows: [
        ["伝票No.", "TE00009002"],
        ["申請者", "テスト 花子"],
        ["申請日", "2026/09/04 17:51:38"],
        ["予算外？", "予算外", "支払予定日", "2026/10/31"],
        ["申請日時（表示用）", "2026/09/04 17時51分"],
      ],
    },
  ];
  it("申請日", () => {
    expect(pickLabeledValue(DETAIL, "申請日")).toBe("2026/09/04 17:51:38");
  });
  it("★完全一致を優先する（「申請日時」に当たらない）", () => {
    expect(pickLabeledValue(DETAIL, "申請日")).not.toBe("2026/09/04 17時51分");
  });
  it("1行に2組並んでいても2組目を取れる", () => {
    expect(pickLabeledValue(DETAIL, "支払予定日")).toBe("2026/10/31");
  });
  it("「.」の揺れを吸収する（伝票No.）", () => {
    expect(pickLabeledValue(DETAIL, "伝票No")).toBe("TE00009002");
  });
  it("申請者は申請日と混ざらない", () => {
    expect(pickLabeledValue(DETAIL, "申請者")).toBe("テスト 花子");
  });
  it("無いラベルは null", () => {
    expect(pickLabeledValue(DETAIL, "存在しないラベル")).toBeNull();
    expect(pickLabeledValue([], "申請日")).toBeNull();
  });
  it("★逆向きの部分一致はしない（「日」だけのセルに「申請日」を当てない）", () => {
    expect(pickLabeledValue([{ rows: [["日", "ちがう値"]] }], "申請日")).toBeNull();
  });
  it("値が空のセルは飛ばして次を採る", () => {
    expect(pickLabeledValue([{ rows: [["申請日", "", "  ", "2026/09/04"]] }], "申請日")).toBe("2026/09/04");
  });
});

describe("PJコード — 「どこで」の近くの10桁", () => {
  const WHERE_TABLE: TableData[] = [
    {
      rows: [
        ["申請日", "2026/09/04 17:51:38"],
        ["どこで", "注文受注物件：テスト物件A　監督：架空　一郎/営業：架空　二郎"],
        ["工事番号", "9901230101"],
      ],
    },
  ];
  it("★「どこで」のすぐ下の行からPJを採る", () => {
    expect(pickPjNearLabel(WHERE_TABLE, "どこで")[0]).toBe("9901230101");
  });
  it("その行の見出しも返す", () => {
    expect(pickPjNearLabel(WHERE_TABLE, "どこで")[1]).toBe("工事番号");
  });
  it("下の行が10桁でなければ null", () => {
    expect(pickPjNearLabel([{ rows: [["どこで", "受注物件：A"], ["備考", "特になし"]] }], "どこで")[0]).toBeNull();
  });
  it("同じ行に10桁があればそれを採る", () => {
    expect(pickPjNearLabel([{ rows: [["どこで", "9901230101"]] }], "どこで")).toEqual(["9901230101", "どこで"]);
  });
});

describe("列の見出し探し", () => {
  it("★完全一致を全候補について先に試す", () => {
    // 部分一致なら「日付」が先の「承認日付け」に当たるが、完全一致の「承認日」を優先する
    expect(findLabelCol(["承認日付け", "承認日"], ["日付", "承認日"])).toBe(1);
  });
  it("完全一致が無ければ部分一致", () => {
    expect(findLabelCol(["番号", "処理日時"], ["日時"])).toBe(1);
  });
  it("無ければ -1", () => {
    expect(findLabelCol(["番号"], ["日付"])).toBe(-1);
  });
});
