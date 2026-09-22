import { describe, expect, it } from "vitest";
import {
  SHARED_INTRO_TEXT,
  type SharedStatusInput,
  clearExamplesConfirmText,
  firstWriteText,
  formatSyncTime,
  lastSyncText,
  sharedStatus,
  syncResultText,
  unmatchedText,
} from "@/lib/shared/status";
import type { SyncReport } from "@/lib/shared/sync";

// 共有フォルダーの欄の文言と、押せる・押せないの判定（2026-09-22）。
// ★画面のテスト基盤が無いので、ここで文言そのものを固定する。
//   とくに「見つからない手直しは捨てていない」「消去は相手からも消える」は、
//   消えると事故になる説明なので必ず残す。

const report = (over: Partial<SyncReport> = {}): SyncReport => ({
  at: 1_700_000_000_000,
  awaitingFirstWrite: false,
  pending: { customers: 3, examples: { inquiry: 8, inspection: 4 } },
  customers: { applied: 2, unmatched: 0, written: true },
  examples: { inquiry: { count: 8, written: false }, inspection: { count: 4, written: false } },
  failures: [],
  ...over,
});

const input = (over: Partial<SharedStatusInput> = {}): SharedStatusInput => ({
  state: "connected",
  folderName: "Folio共有",
  lastSync: null,
  syncing: false,
  error: null,
  report: null,
  canPersist: true,
  ...over,
});

describe("日時の表示", () => {
  it("★日本時間で出す（端末の時差設定に左右されない）", () => {
    // 2023-11-14T22:13:20Z = 日本時間 11/15 07:13
    expect(formatSyncTime(1_700_000_000_000)).toBe("11/15 07:13");
  });

  it("まだ同期していなければ、そう書く", () => {
    expect(lastSyncText(null)).toBe("まだ同期していません");
    expect(lastSyncText(1_700_000_000_000)).toBe("最終同期 11/15 07:13");
  });
});

describe("初めてのフォルダー", () => {
  it("★フォルダーの名前と件数を出して、押してもらってから書き出す", () => {
    const text = firstWriteText("Folio共有", { customers: 3, examples: { inquiry: 8, inspection: 4 } });
    expect(text).toContain("Folio共有");
    expect(text).toContain("手直し 3件");
    expect(text).toContain("学習した書き方 12件");
  });

  it("名前が読めなくても文になる", () => {
    expect(firstWriteText(null, { customers: 0, examples: { inquiry: 0, inspection: 0 } })).toContain(
      "このフォルダー",
    );
  });

  it("欄には確認文が出て、同期の結果は出さない", () => {
    const view = sharedStatus(input({ report: report({ awaitingFirstWrite: true }) }));
    expect(view.firstWrite).toContain("まだ共有データがありません");
    expect(view.notes.join()).not.toContain("共有しています");
  });
});

describe("同期の結果", () => {
  it("共有している件数と、取り込んだ手直しの件数を出す", () => {
    const text = syncResultText(report());
    expect(text).toContain("手直し 3件");
    expect(text).toContain("学習した書き方 12件");
    expect(text).toContain("2件");
  });

  it("★見つからない手直しは「捨てていない」と分かるように書く", () => {
    const text = unmatchedText(5)!;
    expect(text).toContain("5件");
    expect(text).toContain("同じ顧客ファイルを取り込むと結び付きます");
    expect(text).toContain("共有フォルダーからは消えません");
    expect(unmatchedText(0)).toBeNull();
  });

  it("見つからない手直しがあれば気づける色にする", () => {
    const view = sharedStatus(input({ report: report({ customers: { applied: 0, unmatched: 5, written: false } }) }));
    expect(view.tone).toBe("warn");
    expect(view.notes.join()).toContain("5件");
  });

  it("うまくいけば落ち着いた色", () => {
    expect(sharedStatus(input({ report: report() })).tone).toBe("ok");
  });

  it("★一部が読めなくても、そのデータの名前と理由を出す", () => {
    const view = sharedStatus(
      input({
        report: report({
          failures: [{ dataset: "examples-inquiry", label: "学習した書き方（アフター）", message: "壊れています" }],
        }),
      }),
    );
    expect(view.tone).toBe("warn");
    expect(view.notes.join()).toContain("学習した書き方（アフター）: 壊れています");
  });
});

describe("「共有フォルダーと同期」を押せるか", () => {
  it("つながっていれば押せる", () => {
    const view = sharedStatus(input());
    expect(view.canSync).toBe(true);
    expect(view.syncReason).toContain("相手の変更を取り込み");
  });

  it.each([
    ["unsupported", "Chrome か Edge"],
    ["none", "共有フォルダーを選ぶ"],
    ["prompt", "共有フォルダーにつなぐ"],
    ["connecting", "つないでいます"],
    ["error", "つなぎ直して"],
  ] as const)("%s のときは押せず、理由が出る", (state, reason) => {
    const view = sharedStatus(input({ state }));
    expect(view.canSync).toBe(false);
    expect(view.syncReason).toContain(reason);
  });

  it("★保存を止めているタブでは同期しない（復元できるまで書かない原則）", () => {
    const view = sharedStatus(input({ canPersist: false }));
    expect(view.canSync).toBe(false);
    expect(view.syncReason).toContain("保存を停止");
  });

  it("同期の最中は二重に押せない", () => {
    expect(sharedStatus(input({ syncing: true })).canSync).toBe(false);
  });
});

describe("見出し", () => {
  it("まだ選んでいないときは、何が共有されるかを書く", () => {
    const view = sharedStatus(input({ state: "none", folderName: null }));
    expect(view.headline).toBe(SHARED_INTRO_TEXT);
    // ★共有しないものも書いておく（受付一覧まで出ていると誤解させない）
    expect(view.headline).toContain("受付一覧と定期点検の抽出結果は共有しません");
  });

  it("前回のフォルダーがあれば、名前と最終同期を出す", () => {
    const view = sharedStatus(input({ state: "prompt", lastSync: 1_700_000_000_000 }));
    expect(view.headline).toContain("Folio共有");
    expect(view.notes[0]).toBe("最終同期 11/15 07:13");
  });

  it("失敗の文面はそのまま出す", () => {
    const view = sharedStatus(input({ state: "error", error: "共有フォルダーが見つかりません" }));
    expect(view.notes).toContain("共有フォルダーが見つかりません");
    expect(view.tone).toBe("warn");
  });
});

describe("学習した書き方の消去", () => {
  it("★共有していると相手からも消えることを、確認の前に書く", () => {
    const text = clearExamplesConfirmText(12, true);
    expect(text).toContain("12件");
    expect(text).toContain("相手の端末からも消えます");
  });

  it("共有していなければ、これまでどおりの短い確認", () => {
    const text = clearExamplesConfirmText(12, false);
    expect(text).toContain("12件");
    expect(text).not.toContain("相手");
  });
});
