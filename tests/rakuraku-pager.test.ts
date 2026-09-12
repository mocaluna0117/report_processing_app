import { describe, expect, it } from "vitest";
import { isApproved, scanSummary } from "@/lib/rakuraku/parse/list";
import {
  type PagerAction,
  currentPageNo,
  parsePagerText,
  rankNextPageActions,
} from "@/lib/rakuraku/parse/pager";

// 期待値は移植元の検証 (tenmatsu-dl/server_test.py「一覧のページ送り」) から写した
describe("件数表示の読み取り", () => {
  it("「697件中 101件～200件目」を読める", () => {
    expect(parsePagerText("（697件中 101件～200件目）")).toEqual([697, 101, 200]);
  });
  it("全角数字・波ダッシュ・ハイフンの揺れを吸収する", () => {
    expect(parsePagerText("（６９７件中 １件－１００件目）")).toEqual([697, 1, 100]);
    expect(parsePagerText("(697件中 1件〜100件目)")).toEqual([697, 1, 100]);
  });
  it("桁区切りが入っていても読める", () => {
    expect(parsePagerText("1,234件中 1件～100件目")).toEqual([1234, 1, 100]);
  });
  it("前後に他の文字があっても読める", () => {
    expect(parsePagerText("表示件数 100件　（5件中 1件～5件目）")).toEqual([5, 1, 5]);
  });
  it("件数表示が無い画面では null（呼び出し側の判定に任せる）", () => {
    expect(parsePagerText("検索結果はありません")).toBeNull();
    expect(parsePagerText("")).toBeNull();
    expect(parsePagerText(null)).toBeNull();
  });
});

describe("今のページ番号", () => {
  it("件数表示から出せる", () => {
    expect(currentPageNo([697, 1, 100])).toBe(1);
    expect(currentPageNo([697, 101, 200])).toBe(2);
    expect(currentPageNo([697, 601, 697])).toBe(7);
  });
  it("件数表示が無ければ null", () => {
    expect(currentPageNo(null)).toBeNull();
  });
});

describe("「次へ」の探し方", () => {
  // ★楽楽精算の onclick は行き先のページ番号（0始まり）が入っていてページごとに描き直される。
  //   設定に固定した pageFeed(1) では 2ページ目から先へ進めなかった
  const icons: PagerAction[] = [
    { index: 0, onclick: "DenpyoKensaku.pageFeed(0);", text: "first_page", cls: "" },
    { index: 1, onclick: "DenpyoKensaku.pageFeed(0);", text: "chevron_left", cls: "" },
    { index: 2, onclick: "DenpyoKensaku.pageFeed(2);", text: "chevron_right", cls: "" },
    { index: 3, onclick: "DenpyoKensaku.pageFeed(6);", text: "last_page", cls: "" },
  ];

  it("★アイコン名で「次へ」を選ぶ", () => {
    const got = rankNextPageActions(icons, [697, 101, 200], "() => DenpyoKensaku.pageFeed(1)");
    expect(got[0].how).toBe("icon");
    expect(got[0].js).toContain("pageFeed(2)");
  });

  it("設定の固定JSは最後の手段にする", () => {
    const got = rankNextPageActions(icons, [697, 101, 200], "() => DenpyoKensaku.pageFeed(1)");
    expect(got.at(-1)?.how).toBe("config");
  });

  it("「前へ」を「次へ」と間違えない", () => {
    const got = rankNextPageActions(icons, [697, 101, 200], null);
    for (const g of got.filter((c) => c.how === "icon")) expect(g.js).not.toContain("pageFeed(0)");
  });

  it("★アイコン名が無ければ件数表示から次のページ番号で選ぶ", () => {
    const noIcon = icons.map((a) => ({ ...a, text: "" }));
    const got = rankNextPageActions(noIcon, [697, 101, 200], null);
    expect(got[0].how).toBe("number");
    expect(got[0].js).toContain("pageFeed(2)");
  });

  it("0始まり・1始まりのどちらの番号でも拾う", () => {
    const got = rankNextPageActions([{ index: 0, onclick: "pageFeed(3);", text: "", cls: "" }], [697, 101, 200], null);
    expect(got[0].how).toBe("number");
  });

  it("4つ並び（|< < > >|）なら3つ目を次へとみなす", () => {
    const blind = icons.map((a) => ({ ...a, text: "", onclick: "pageFeed(9);" }));
    expect(rankNextPageActions(blind, null, null)[0].index).toBe(2);
  });

  it("同じ要素を二重に候補へ入れない", () => {
    const got = rankNextPageActions(icons, [697, 101, 200], "() => x()");
    const indexes = got.filter((g) => g.index !== null).map((g) => g.index);
    expect(new Set(indexes).size).toBe(indexes.length);
  });

  it("候補が無ければ空（呼び出し側が文字リンクの経路へ進む）", () => {
    expect(rankNextPageActions([], null, null)).toEqual([]);
  });
});

describe("承認済みの判定", () => {
  it("★部分一致で見る（設定は「承認済」、実画面は「承認済み」）", () => {
    expect(isApproved("承認済み", ["承認済"])).toBe(true);
  });
  it("承認依頼中・取下げ・差戻しは含めない", () => {
    for (const s of ["承認依頼中 0/3", "取下げ", "差戻し"]) expect(isApproved(s, ["承認済"])).toBe(false);
  });
  it("前後の空白を無視する", () => {
    expect(isApproved("  承認済み  ", [" 承認済 "])).toBe(true);
  });
  it("★空の値で全件を承認済みにしない", () => {
    expect(isApproved("差戻し", [""])).toBe(false);
    expect(isApproved("差戻し", ["  "])).toBe(false);
  });
});

describe("読み終えたときの言い方", () => {
  it("最後まで読んで0件なら、確認した件数を添えて言う", () => {
    expect(scanSummary({ stoppedEarly: false, total: 697, last: 697, scanned: 697, reason: null }, "顛末書")).toBe(
      "新規対象はありません（697件すべてを確認しました）。",
    );
  });
  it("件数表示が読めなくても、読んだ行数で言う", () => {
    expect(scanSummary({ stoppedEarly: false, total: null, last: null, scanned: 5, reason: null }, "顛末書")).toContain(
      "5行を確認しました",
    );
  });
  it("★途中で止まったら「新規対象はありません」と言わない", () => {
    const early = scanSummary(
      { stoppedEarly: true, total: 697, last: 200, scanned: 200, reason: "3ページ目へ進めませんでした" },
      "顛末書",
    );
    expect(early).not.toContain("新規対象はありません");
    expect(early).toContain("697件中 200件目");
    expect(early).toContain("3ページ目へ進めませんでした");
    expect(early).toContain("未取得の顛末書");
  });
  it("理由が無ければ理由不明と言う", () => {
    expect(scanSummary({ stoppedEarly: true, total: null, last: null, scanned: 40, reason: null }, "専決決裁書")).toContain(
      "40行までしか読めませんでした（理由不明）",
    );
  });
  it("★Python の設定ファイルやコマンドを案内しない（利用者は触れない）", () => {
    const early = scanSummary({ stoppedEarly: true, total: 10, last: 5, scanned: 5, reason: "x" }, "顛末書");
    expect(early).not.toContain("config.json");
    expect(early).not.toContain("python");
  });
});
