import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KINDS, getKind, isKindId } from "@/lib/rakuraku/kinds";

/** 実画面で観測された伝票画面の URL の形（テナントの部分は除いた相対パス。架空の伝票No.） */
const DETAIL_PATHS = {
  tenmatsu: "sapWorkflowDenpyoView/workflowDetailView?tmpFlg=false&eDenpyoNo=TE00009001&prevDispNo=4&workflowId=4&refId=4",
  senketsu: "sapWorkflowDenpyoView/workflowDetailView?tmpFlg=false&eDenpyoNo=SE00009001&prevDispNo=3&workflowId=3&refId=3",
  natsuin: "sapWorkflowDenpyo/detailView?eDenpyoNo=NK00009001&workflowId=8",
} as const;

describe("種類ごとの画面の設定", () => {
  it("3種類がそろっている", () => {
    expect(Object.keys(KINDS).sort()).toEqual(["natsuin", "senketsu", "tenmatsu"]);
  });

  for (const kind of Object.values(KINDS)) {
    it(`★${kind.label}: 一覧の目印が伝票画面の URL に含まれない（伝票を「一覧に戻った」と読み違えない）`, () => {
      expect(DETAIL_PATHS[kind.id]).not.toContain(kind.listUrlMarker);
    });

    it(`${kind.label}: 伝票画面の目印が実際の伝票画面の URL に含まれる`, () => {
      expect(DETAIL_PATHS[kind.id]).toContain(kind.list.detailUrlMarker);
    });

    it(`${kind.label}: 一覧のパスは相対（テナントの URL を含まない）`, () => {
      expect(kind.listPath).not.toMatch(/^https?:/);
      expect(kind.listPath).toContain(kind.listUrlMarker);
    });

    it(`${kind.label}: 列の見出しとラベルが空でない`, () => {
      for (const v of Object.values(kind.list.columns)) expect(v.trim()).not.toBe("");
      for (const v of Object.values(kind.detail.labels)) expect(v.trim()).not.toBe("");
    });
  }

  it("★承認済みは「承認済」（部分一致で実画面の「承認済み」に当たる値）", () => {
    for (const kind of Object.values(KINDS)) expect(kind.list.approvedValues).toEqual(["承認済"]);
  });
});

describe("★種類をまたいで設定が漏れない", () => {
  it("「どこで」と PJ は顛末書だけ", () => {
    expect(KINDS.tenmatsu.detail.labels).toHaveProperty("where");
    expect(KINDS.tenmatsu.detail.labels).toHaveProperty("pj");
    for (const id of ["senketsu", "natsuin"] as const) {
      expect(KINDS[id].detail.labels).not.toHaveProperty("where");
      expect(KINDS[id].detail.labels).not.toHaveProperty("pj");
      expect(KINDS[id].list.columns).not.toHaveProperty("where");
    }
  });

  it("合成（捺印決裁書が専決決裁書を取り込む）と部品の保持は捺印決裁書だけ", () => {
    expect(KINDS.natsuin.compose).toBeDefined();
    expect(KINDS.natsuin.keepParts).toBe(true);
    for (const id of ["tenmatsu", "senketsu"] as const) {
      expect(KINDS[id].compose).toBeUndefined();
      expect(KINDS[id].keepParts).toBe(false);
    }
  });

  it("合成の紐づけ先は実在する種類で、紐づけの鍵を捺印決裁書が読んでいる", () => {
    const compose = KINDS.natsuin.compose!;
    expect(isKindId(compose.linkedKind)).toBe(true);
    expect(KINDS.natsuin.detail.labels).toHaveProperty(compose.linkKey);
  });

  it("捺印決裁書は一覧も伝票画面もパスが別", () => {
    expect(KINDS.natsuin.listUrlMarker).not.toBe(KINDS.senketsu.listUrlMarker);
    expect(KINDS.natsuin.list.detailUrlMarker).not.toBe(KINDS.senketsu.list.detailUrlMarker);
  });

  it("共通の値を種類ごとに持っていても、片方を書き換えるともう片方が変わる作りになっていない", () => {
    expect(KINDS.tenmatsu.list.columns).not.toBe(KINDS.senketsu.list.columns);
    expect(KINDS.tenmatsu.detail.labels).not.toBe(KINDS.senketsu.detail.labels);
  });
});

describe("種類の取り出し", () => {
  it("知っている種類を返す", () => {
    expect(getKind("senketsu").label).toBe("専決決裁書");
  });
  it("★知らない種類は黙って顛末書に落とさず、止める", () => {
    expect(() => getKind("unknown")).toThrow("知らない種類");
    expect(isKindId("")).toBe(false);
  });
});

describe("★押してはいけない操作をコードに持たない", () => {
  // 伝票画面の「閉じる」は window.parent.close() でブラウザの窓ごと閉じる。
  // 「取下げ」「コピー」はデータを変える。どれも参照すらしない（コメントにも書かない）
  const FORBIDDEN = ["accesskeyClose", "accesskeyTorisage", "accesskeyFix", "window.parent.close"];

  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts")) files.push(path);
    }
  };
  walk(join(process.cwd(), "lib/rakuraku"));
  walk(join(process.cwd(), "app/api/rakuraku"));

  it("楽楽精算を操作するコードが見つかっている", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const word of FORBIDDEN) {
    it(`${word} がどこにも無い`, () => {
      const hits = files.filter((f) => readFileSync(f, "utf-8").includes(word));
      expect(hits).toEqual([]);
    });
  }
});
