import { describe, expect, it } from "vitest";
import {
  SHARED_INTRO_TEXT,
  type SharedStatusInput,
  changedCustomers,
  clearExamplesConfirmText,
  firstWriteText,
  formatSyncTime,
  lastSyncText,
  sharedChip,
  sharedStatus,
  syncResultText,
  unmatchedText,
  usesSharedFolder,
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
  ledger: { imported: [], pending: [], skipped: [], conflicts: [] },
  customerLedger: { count: 5, applied: 0, written: false },
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
    expect(text).toContain("顧客データ 5件");
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

describe("共有フォルダーの顧客ファイル", () => {
  it("取り込めたら、その1行を出す", () => {
    const view = sharedStatus(
      input({ report: report({ ledger: { imported: ["「台帳.csv」を取り込みました"], pending: [], skipped: [] , conflicts: [] } }) }),
    );
    expect(view.notes.join()).toContain("「台帳.csv」を取り込みました");
    expect(view.ledgerReplace).toBeNull();
  });

  it("★減るときは、押すまで入れ替えないと分かる形で出す", () => {
    const view = sharedStatus(
      input({
        report: report({
          ledger: { imported: [], pending: [{ file: "助っ人.csv", text: "3,000件 が 12件 に置き換わります。" }], skipped: [] , conflicts: [] },
        }),
      }),
    );
    expect(view.ledgerReplace).toContain("3,000件");
    expect(view.ledgerReplace).toContain("共有フォルダーの顧客ファイルを取り込む");
    expect(view.tone).toBe("warn");
  });

  it("顧客データでないファイルは、飛ばしたと書くだけ", () => {
    const view = sharedStatus(
      input({ report: report({ ledger: { imported: [], pending: [], skipped: [{ file: "メモ.csv", message: "判定できません" }] , conflicts: [] } }) }),
    );
    expect(view.notes.join()).toContain("「メモ.csv」は顧客データとして読めない");
  });

  it("書き出しの確認中でも、取り込みの結果は出す（読むだけなので先に動いている）", () => {
    const view = sharedStatus(
      input({
        report: report({ awaitingFirstWrite: true, ledger: { imported: ["取り込みました"], pending: [], skipped: [] , conflicts: [] } }),
      }),
    );
    expect(view.firstWrite).not.toBeNull();
    expect(view.notes.join()).toContain("取り込みました");
  });
});

describe("共有フォルダーのデータを使う画面", () => {
  it("定期点検・アフター・顛末書は使う", () => {
    expect(usesSharedFolder("/")).toBe(true);
    expect(usesSharedFolder("/after")).toBe(true);
    expect(usesSharedFolder("/tenmatsu")).toBe(true);
  });

  it("★専決決裁書・捺印決裁書・ログインの画面は使わない（自動で同期しない）", () => {
    expect(usesSharedFolder("/senketsu")).toBe(false);
    expect(usesSharedFolder("/natsuin")).toBe(false);
    expect(usesSharedFolder("/login")).toBe(false);
  });
});

describe("同期で顧客データが変わったか", () => {
  const base = report({ customers: { applied: 0, unmatched: 0, written: false } });

  it("何も取り込まなければ読み直さない", () => {
    expect(changedCustomers(base)).toBe(false);
  });

  it("★手直し・台帳の JSON・顧客ファイル、どれで変わっても読み直す", () => {
    expect(changedCustomers({ ...base, customers: { applied: 1, unmatched: 0, written: false } })).toBe(true);
    expect(changedCustomers({ ...base, customerLedger: { count: 5, applied: 5, written: false } })).toBe(true);
    expect(
      changedCustomers({ ...base, ledger: { ...base.ledger, imported: ["助っ人クラウド.xlsx を取り込みました"] } }),
    ).toBe(true);
  });
});

describe("ヘッダーの共有フォルダーの表示", () => {
  const chip = (over: Partial<Parameters<typeof sharedChip>[0]> = {}) =>
    sharedChip({ ...input(), known: true, usesShared: true, ...over });

  it("★読み込む前（サーバーで描いた直後）は「共有フォルダー」とだけ出す", () => {
    expect(chip({ known: false, state: "none" })).toMatchObject({ text: "共有フォルダー", tone: "unknown" });
  });

  it("つながっていて何も問題が無ければ静かに出す", () => {
    const view = chip({ report: report(), lastSync: 1_700_000_000_000 });
    expect(view).toMatchObject({ text: "共有フォルダー: 接続済み", tone: "on" });
    expect(view.title).toContain("Folio共有");
    expect(view.title).toContain("最終同期 11/15 07:13");
  });

  it("同期の途中はそう出す", () => {
    expect(chip({ syncing: true }).text).toBe("共有フォルダー: 同期中…");
  });

  it("★使う画面でつながっていなければ目立たせる", () => {
    expect(chip({ state: "none" })).toMatchObject({ text: "共有フォルダー: 未設定", tone: "alert" });
    expect(chip({ state: "prompt" })).toMatchObject({ text: "共有フォルダー: 未接続", tone: "alert" });
    expect(chip({ state: "error", error: "見つかりません" })).toMatchObject({
      text: "共有フォルダー: つなげません",
      tone: "alert",
    });
  });

  it("★専決決裁書・捺印決裁書では、つながっていなくても静かに出す", () => {
    expect(chip({ state: "prompt", usesShared: false }).tone).toBe("off");
    expect(chip({ state: "none", usesShared: false }).tone).toBe("off");
  });

  it("未接続のときは、つながないと相手の変更が届かないことを書く", () => {
    const view = chip({ state: "prompt" });
    expect(view.title).toContain("相手の変更は届かず");
    expect(view.title).toContain("押すと共有フォルダーの欄が開きます");
  });

  it("★確かめてほしいこと（初回の書き出し・入れ替え・失敗）があれば、つながっていても目立たせる", () => {
    expect(chip({ report: report({ awaitingFirstWrite: true }) })).toMatchObject({
      text: "共有フォルダー: 確認してください",
      tone: "alert",
    });
    const replace = report({
      ledger: { imported: [], pending: [{ file: "a.xlsx", text: "減ります。" }], skipped: [], conflicts: [] },
    });
    expect(chip({ report: replace }).tone).toBe("alert");
    const failed = report({ failures: [{ dataset: "customer-edits", label: "手直し", message: "書けません" }] });
    expect(chip({ report: failed }).tone).toBe("alert");
  });

  it("このブラウザで使えないときは、使えないと出す（目立たせない）", () => {
    expect(chip({ state: "unsupported" })).toMatchObject({ text: "共有フォルダー: 使えません", tone: "off" });
  });
});
