import { describe, expect, it } from "vitest";
import { KINDS, type ListRoute, detailMarkerFor, findRoute, getKind, isKindId, resolveKind } from "@/lib/rakuraku/kinds";
import type { KindId, RouteId } from "@/lib/rakuraku/protocol";

/**
 * 実画面で観測された伝票画面の URL の形（テナントの部分は除いた相対パス。架空の伝票No.）。
 * 閲覧（自部門検索）は 2026-09-01、ワークフロー（申請検索）は 2026-09-19 の「画面の下見」で確認。
 * ★経路によって伝票画面のパスが変わる（閲覧は sapWorkflowDenpyoView/workflowDetailView、
 *   ワークフローは sapWorkflowDenpyo/detailView）。
 */
const DETAIL_PATHS: Record<KindId, Partial<Record<RouteId, string>>> = {
  tenmatsu: {
    jibumon:
      "sapWorkflowDenpyoView/workflowDetailView?tmpFlg=false&eDenpyoNo=TE00009001&prevDispNo=4&workflowId=4&refId=4",
    shinsei: "sapWorkflowDenpyo/detailView?tmpFlg=false&eDenpyoNo=TE00009001&workflowId=4&refId=4",
  },
  senketsu: {
    jibumon:
      "sapWorkflowDenpyoView/workflowDetailView?tmpFlg=false&eDenpyoNo=SE00009001&prevDispNo=3&workflowId=3&refId=3",
    shinsei: "sapWorkflowDenpyo/detailView?tmpFlg=false&eDenpyoNo=SE00009001&workflowId=3&refId=3",
  },
  natsuin: { shinsei: "sapWorkflowDenpyo/detailView?tmpFlg=false&eDenpyoNo=NK00009001&workflowId=8&refId=8" },
};

const routesOf = (kind: { id: KindId; routes: readonly ListRoute[] }) =>
  kind.routes.map((route) => ({ route, detailPath: DETAIL_PATHS[kind.id][route.id] }));

describe("種類ごとの画面の設定", () => {
  it("3種類がそろっている", () => {
    expect(Object.keys(KINDS).sort()).toEqual(["natsuin", "senketsu", "tenmatsu"]);
  });

  for (const kind of Object.values(KINDS)) {
    it(`${kind.label}: 経路の id が重なっていない`, () => {
      const ids = kind.routes.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBeGreaterThan(0);
    });

    for (const { route, detailPath } of routesOf(kind)) {
      it(`★${kind.label} / ${route.label}: 一覧の目印が伝票画面の URL に含まれない（伝票を「一覧に戻った」と読み違えない）`, () => {
        for (const path of Object.values(DETAIL_PATHS[kind.id])) {
          expect(path).not.toContain(route.listUrlMarker);
        }
      });

      it.skipIf(!detailPath)(`${kind.label} / ${route.label}: 伝票画面の目印が実際の伝票画面の URL に含まれる`, () => {
        expect(detailPath).toContain(route.detailUrlMarker);
      });

      it(`${kind.label} / ${route.label}: 一覧のパスは相対（テナントの URL を含まない）`, () => {
        expect(route.listPath).not.toMatch(/^https?:/);
        expect(route.listPath).toContain(route.listUrlMarker);
      });

      it(`${kind.label} / ${route.label}: 未確認の経路にはメニューの手順を置かない（実画面を見てから足す）`, () => {
        if (route.unverified) expect(route.menuSteps).toBeUndefined();
      });
    }

    it(`${kind.label}: 列の見出しとラベルが空でない`, () => {
      for (const v of Object.values(kind.list.columns)) expect(v.trim()).not.toBe("");
      for (const v of Object.values(kind.detail.labels)) expect(v.trim()).not.toBe("");
    });
  }

  it("★2つの経路の伝票画面の目印が互いを含まない（片方の伝票をもう片方と読み違えない）", () => {
    const markers = [...new Set(Object.values(KINDS).flatMap((k) => k.routes.map((r) => r.detailUrlMarker)))];
    for (const a of markers) {
      for (const b of markers) {
        if (a !== b) expect(a).not.toContain(b);
      }
    }
  });

  it("顛末書・専決決裁書は「閲覧（自部門検索）」から試し、捺印決裁書はワークフローだけ", () => {
    expect(KINDS.tenmatsu.routes[0].id).toBe("jibumon");
    expect(KINDS.senketsu.routes[0].id).toBe("jibumon");
    expect(KINDS.tenmatsu.routes.map((r) => r.id)).toEqual(["jibumon", "shinsei"]);
    expect(KINDS.natsuin.routes.map((r) => r.id)).toEqual(["shinsei"]);
  });

  it("ワークフロー（申請検索）の一覧の列は、閲覧（自部門検索）と同じ見出しで読める", () => {
    // 2026-09-19 の下見で、どちらの経路も見出しが同じことを確認した（経路ごとの上書きは要らない）
    for (const kind of Object.values(KINDS)) {
      for (const route of kind.routes) expect(route.list).toBeUndefined();
    }
  });

  it("★ワークフロー（申請検索）の一覧に出るのは自分の申請分だけ、と印が付いている", () => {
    for (const kind of Object.values(KINDS)) {
      for (const route of kind.routes) {
        expect(route.scope).toBe(route.id === "shinsei" ? "own" : "department");
      }
    }
  });

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

  it("捺印決裁書は一覧も伝票画面も、専決決裁書の「閲覧」とはパスが別", () => {
    const jibumon = findRoute(KINDS.senketsu, "jibumon")!;
    expect(KINDS.natsuin.routes[0].listUrlMarker).not.toBe(jibumon.listUrlMarker);
    expect(KINDS.natsuin.routes[0].detailUrlMarker).not.toBe(jibumon.detailUrlMarker);
  });

  it("経路ごとの列の上書きは resolveKind で重なる", () => {
    const kind = { ...KINDS.tenmatsu, routes: [{ ...KINDS.tenmatsu.routes[0], list: { colStatus: "ステータス" } }] };
    const resolved = resolveKind(kind, kind.routes[0]);
    expect(resolved.list.colStatus).toBe("ステータス");
    expect(resolved.list.colDenpyoNo).toBe(KINDS.tenmatsu.list.colDenpyoNo);
    // 元の設定は書き換わらない
    expect(KINDS.tenmatsu.list.colStatus).toBe("状態");
  });

  it("★一覧から読んだ URL が別の経路の伝票画面なら、その目印で待つ（経路の推測が外れても開ける）", () => {
    const resolved = resolveKind(KINDS.tenmatsu, findRoute(KINDS.tenmatsu, "shinsei")!);
    expect(detailMarkerFor(resolved, DETAIL_PATHS.tenmatsu.jibumon!)).toBe("workflowDetailView");
    // URL が無い・どの経路の目印も含まないときは、いまの経路の目印
    expect(detailMarkerFor(resolved, null)).toBe("sapWorkflowDenpyo/detailView");
    expect(detailMarkerFor(resolved, "other/page")).toBe("sapWorkflowDenpyo/detailView");
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
