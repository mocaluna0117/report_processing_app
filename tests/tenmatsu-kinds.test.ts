import { describe, expect, it } from "vitest";
import type { HealthPayload } from "@/lib/tenmatsu/client";
import {
  DOC_KINDS,
  DOC_KIND_BY_ID,
  SENKETSU,
  TENMATSU,
  clearListConfirmText,
  clearedNoticeText,
  findHealthKind,
  flagErrorText,
  supportsKind,
  unsupportedServerText,
} from "@/lib/tenmatsu/kinds";

const health = (kinds?: HealthPayload["kinds"]): HealthPayload => ({
  ok: true,
  service: "tenmatsu-local",
  version: 1,
  save_dir: "C:\\Users\\x\\顛末書",
  job_state: "idle",
  ...(kinds ? { kinds } : {}),
});

describe("顛末書の設定 (いまの画面と1対1)", () => {
  it("完了の印は実行予算とクラウドの2つ", () => {
    expect(TENMATSU.flagColumns).toEqual([
      { key: "budget_entered", head: "実行予算", label: "実行予算入力済み", todo: "未入力", done: "入力済み" },
      { key: "cloud_stored", head: "クラウド", label: "クラウド格納済み", todo: "未格納", done: "格納済み" },
    ]);
    expect(TENMATSU.flagKeys).toEqual(["budget_entered", "cloud_stored"]);
  });

  it("絞り込みは3つ", () => {
    expect(TENMATSU.listFilters.map((f) => [f.value, f.label])).toEqual([
      ["all", "すべて"],
      ["budget", "実行予算が未入力"],
      ["cloud", "クラウド未格納"],
    ]);
  });

  it("列の並びと右寄せ", () => {
    expect(TENMATSU.dataColumns.map((c) => c.head)).toEqual([
      "物件名", "申請日", "申請者", "支払金額(税込)", "支払先", "最終承認日",
    ]);
    expect(TENMATSU.dataColumns.filter((c) => c.align === "right").map((c) => c.field))
      .toEqual(["amount"]);
  });

  it("★リクエストに kind を付けない (古いサーバーとの互換)", () => {
    expect(TENMATSU.apiKind).toBeNull();
  });

  it("監督・営業の反映欄を出す", () => {
    expect(TENMATSU.showStaffSync).toBe(true);
  });

  it("★「一覧を消去」の確認文がいまの文言と同じ", () => {
    expect(clearListConfirmText(TENMATSU)).toBe(
      "この画面に保存している取得済み一覧 (物件名・申請者・支払先・支払金額を含みます) を" +
        "このブラウザから消去します。" +
        "PCに保存されたPDFと、実行予算入力済み・クラウド格納済みの印は消えません。" +
        "再接続すれば元に戻ります。よろしいですか？",
    );
  });

  it("★消したあとの案内がいまの文言と同じ", () => {
    expect(clearedNoticeText(TENMATSU)).toBe(
      "この画面に保存していた分を消しました。" +
        "「一覧を再読み込み」または「つなぎ直す」で元に戻ります" +
        " (PDFと入力済み・格納済みの印はPCに残っています)",
    );
  });

  it("★印のエラー文がいまの文言と同じ", () => {
    expect(flagErrorText(TENMATSU, "TE00001476", true, "理由")).toBe(
      "伝票No. TE00001476 の入力済み・格納済みの印を変更できませんでした (理由)",
    );
    expect(flagErrorText(TENMATSU, "TE00001476", false, "理由")).toBe(
      "伝票No. TE00001476 の入力済み・格納済みの印を保存できたか確認できませんでした (理由)。" +
        "「一覧を再読み込み」で確かめてください",
    );
  });

  it("★保存の説明がいまの文言と同じ", () => {
    expect(TENMATSU.text.storageDescription).toBe(
      "顛末書の取得済み一覧には、伝票No.・物件名 (施主名を含むことがあります)・申請者・支払先・支払金額・入力済み/格納済みの印が入ります。これらはローカルサーバーのトークン・1回に取る件数とあわせて、このブラウザ内にだけ保存され、folio のサーバーには送信されません。印の正本はPCの記録で、この一覧はその写しです (消しても再接続すれば戻ります)。PDFの実体はこのPCの保存先フォルダにあり、ブラウザには保存しません。定期点検の「保存データを消去」では消えません。共有の端末では、使い終わったら「一覧を消去」を押してください。",
    );
    expect(TENMATSU.text.completedHint).toBe(
      "実行予算入力済みとクラウド格納済みの両方にチェックが付いた行のことです",
    );
  });
});

describe("専決決裁書の設定", () => {
  it("★実行予算の印は無い (クラウドだけ)", () => {
    expect(SENKETSU.flagColumns.map((c) => c.key)).toEqual(["cloud_stored"]);
    expect(SENKETSU.flagKeys).toEqual(["cloud_stored"]);
  });

  it("絞り込みは2つ", () => {
    expect(SENKETSU.listFilters.map((f) => f.value)).toEqual(["all", "cloud"]);
  });

  it("★表題が入り、金額の見出しが決裁申請額になる", () => {
    expect(SENKETSU.dataColumns.map((c) => c.head)).toEqual([
      "表題", "物件名", "申請日", "申請者", "決裁申請額(税込)", "支払先", "最終承認日",
    ]);
    expect(SENKETSU.dataColumns[0].field).toBe("title");
    expect(SENKETSU.dataColumns.find((c) => c.head === "決裁申請額(税込)")?.field).toBe("amount");
  });

  it("リクエストに kind を付ける", () => {
    expect(SENKETSU.apiKind).toBe("senketsu");
  });

  it("★監督・営業の反映欄は出さない", () => {
    expect(SENKETSU.showStaffSync).toBe(false);
  });

  it("ルートとファイル名の接頭辞", () => {
    expect(SENKETSU.route).toBe("/senketsu");
    expect(SENKETSU.filePrefix).toBe("専決決裁書No.");
  });

  it("文言に種類の名前が入る", () => {
    expect(clearListConfirmText(SENKETSU)).toContain("表題・物件名・申請者・支払先・決裁申請額");
    expect(clearListConfirmText(SENKETSU)).toContain("クラウド格納済みの印は消えません");
    expect(clearedNoticeText(SENKETSU)).toContain("格納済みの印はPCに残っています");
    expect(flagErrorText(SENKETSU, "SE1", true, "理由")).toContain("格納済みの印を変更できませんでした");
  });
});

describe("種類ぜんぶ", () => {
  it("id とルートが重ならない", () => {
    expect(new Set(DOC_KINDS.map((k) => k.id)).size).toBe(DOC_KINDS.length);
    expect(new Set(DOC_KINDS.map((k) => k.route)).size).toBe(DOC_KINDS.length);
  });

  it("並び順は 顛末書 → 専決決裁書", () => {
    expect(DOC_KINDS.map((k) => k.id)).toEqual(["tenmatsu", "senketsu"]);
    expect(DOC_KIND_BY_ID.senketsu).toBe(SENKETSU);
  });

  it("flagKeys は flagColumns から作られる", () => {
    for (const kind of DOC_KINDS) {
      expect(kind.flagKeys).toEqual(kind.flagColumns.map((c) => c.key));
    }
  });

  it("★絞り込みが使うフラグは、その種類が持つフラグだけ", () => {
    for (const kind of DOC_KINDS) {
      for (const f of kind.listFilters) {
        if (f.flagKey) expect(kind.flagKeys).toContain(f.flagKey);
      }
    }
  });
});

describe("PC側が対応しているか", () => {
  it("顛末書は古いサーバーでも使える", () => {
    expect(supportsKind(TENMATSU, health())).toBe(true);
    expect(supportsKind(TENMATSU, null)).toBe(true);
  });

  it("★専決決裁書は kinds が無ければ未対応とみなす", () => {
    expect(supportsKind(SENKETSU, health())).toBe(false);
  });

  it("kinds にあれば対応", () => {
    const ok = health([
      { kind: "tenmatsu", label: "顛末書", flag_keys: ["budget_entered", "cloud_stored"], file_prefix: "顛末書No.", save_dir: "a" },
      { kind: "senketsu", label: "専決決裁書", flag_keys: ["cloud_stored"], file_prefix: "専決決裁書No.", save_dir: "b" },
    ]);
    expect(supportsKind(SENKETSU, ok)).toBe(true);
    expect(findHealthKind(ok, "senketsu")?.label).toBe("専決決裁書");
    expect(findHealthKind(ok, "nope")).toBeNull();
  });

  it("kinds にあっても自分が無ければ未対応", () => {
    const only = health([
      { kind: "tenmatsu", label: "顛末書", flag_keys: [], file_prefix: "顛末書No.", save_dir: "a" },
    ]);
    expect(supportsKind(SENKETSU, only)).toBe(false);
    expect(unsupportedServerText(SENKETSU)).toContain("専決決裁書に未対応");
  });
});
