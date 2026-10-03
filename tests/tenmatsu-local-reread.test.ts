import { describe, expect, it } from "vitest";
import { FolderStore } from "@/lib/tenmatsu/local/fs";
import { LOCAL_KINDS } from "@/lib/tenmatsu/local/kind-config";
import { appendProcessed, readRecords, registerPending, setFlags } from "@/lib/tenmatsu/local/records";
import { mergeDetailFields, planReread, startReread } from "@/lib/tenmatsu/local/reread";
import { type RakurakuApi, RakurakuApiError } from "@/lib/tenmatsu/local/server-api";
import { FakeFs } from "./helpers/fake-fs";
import { type FakeApiScript, createFakeApi } from "./helpers/fake-rakuraku-api";

// 取得済みの顛末書に「支払金額(税抜)」を後から足す読み直し。値はすべて架空

const NOW = new Date(2026, 9, 3, 10, 0, 0);
const tenmatsu = LOCAL_KINDS.tenmatsu;

function setup() {
  const fs = new FakeFs();
  const store = new FolderStore(fs.root);
  const auth = {
    value: "token-0" as string | null,
    api: null as RakurakuApi | null,
    token() {
      return this.value;
    },
    setToken(token: string | null) {
      this.value = token;
    },
    async login() {
      return (await (this.api as RakurakuApi).login("sealed")).sessionToken;
    },
  };
  return { fs, store, auth };
}

async function saved(store: FolderStore, no: string, meta: Record<string, unknown>) {
  await appendProcessed(store, tenmatsu, no, `顛末書№${no.slice(-4)}.pdf`, meta, NOW, { pdf_size: 10, pdf_sha256: "aa" });
}

async function runReread(s: ReturnType<typeof setup>, script: FakeApiScript) {
  const api = createFakeApi(script);
  s.auth.api = api;
  const handle = startReread({ store: s.store, cfg: tenmatsu, api, auth: s.auth, deptCode: null, sleep: async () => undefined });
  const status = await handle.finished;
  return { api, status, log: handle.snapshot(0).log?.map((l) => l.text) ?? [] };
}

describe("読み直す伝票を選ぶ", () => {
  it("★税抜が無い保存済みの伝票だけ・新しい順・保留は除く", async () => {
    const s = setup();
    await saved(s.store, "TE00000001", { amount: "11,000 円" });
    await saved(s.store, "TE00000002", { amount: "22,000 円", amount_ex_tax: "20,000 円" });
    await saved(s.store, "TE00000003", { amount: "33,000 円" });
    await registerPending(s.store, tenmatsu, "TE00000004", "TE00000004", [], {}, NOW);
    const records = await readRecords(s.store, tenmatsu);
    expect(planReread(records, tenmatsu)).toEqual(["TE00000003", "TE00000001"]);
  });
});

describe("読んだ項目を記録に足す", () => {
  it("★記録に無い項目だけ足し、file・at・指紋・印には触らない", async () => {
    const s = setup();
    await saved(s.store, "TE00000001", { amount: "11,000 円", pj: "9901230101" });
    await setFlags(s.store, tenmatsu, "TE00000001", { budget_entered: true }, NOW);
    const before = (await readRecords(s.store, tenmatsu)).log[0];

    const count = await mergeDetailFields(
      s.store,
      tenmatsu,
      new Map([["TE00000001", { amount_ex_tax: "10,000 円", pj: "9909999999", not_a_meta_key: "x" }]]),
    );
    expect(count).toBe(1);
    const after = await readRecords(s.store, tenmatsu);
    const entry = after.log[0];
    expect(entry.amount_ex_tax).toBe("10,000 円");
    // 既にある値は上書きしない・記録に残さない項目は入れない
    expect(entry.pj).toBe("9901230101");
    expect(entry).not.toHaveProperty("not_a_meta_key");
    expect(entry.file).toBe(before.file);
    expect(entry.at).toBe(before.at);
    expect(entry.pdf_sha256).toBe("aa");
    expect(after.flags.TE00000001.budget_entered).toBe(true);
  });

  it("何も足さなければ書かない（控えを上書きしない）", async () => {
    const s = setup();
    await saved(s.store, "TE00000001", { amount_ex_tax: "10,000 円" });
    const count = await mergeDetailFields(s.store, tenmatsu, new Map([["TE00000001", { amount_ex_tax: "99 円" }]]));
    expect(count).toBe(0);
    expect((await readRecords(s.store, tenmatsu)).log[0].amount_ex_tax).toBe("10,000 円");
  });
});

describe("読み直しの実行", () => {
  it("★読めた分を記録に足し、読めなかった伝票は理由を出して続ける", async () => {
    const s = setup();
    await saved(s.store, "TE00000001", {});
    await saved(s.store, "TE00000002", {});
    const { api, status, log } = await runReread(s, {
      reread: (request) => {
        expect(request.denpyoNos).toEqual(["TE00000002", "TE00000001"]);
        return {
          fields: [{ denpyoNo: "TE00000002", fields: { amount_ex_tax: "20,000 円" } }],
          failed: [{ denpyoNo: "TE00000001", code: "DETAIL_NOT_FOUND", reason: "一覧に見つかりませんでした" }],
        };
      },
    });
    expect(status.state).toBe("done");
    expect(status.mode).toBe("reread");
    expect(status.processed).toBe(1);
    expect(status.message).toContain("1件の記録に支払金額(税抜)を足しました");
    expect(status.message).toContain("1件は読めませんでした");
    expect(log.some((l) => l.includes("TE00000001") && l.includes("一覧に見つかりませんでした"))).toBe(true);
    expect(api.calls.filter((c) => c.method === "login")).toHaveLength(0);
    const latest = (await readRecords(s.store, tenmatsu)).log;
    expect(latest.find((e) => e.denpyo_no === "TE00000002")?.amount_ex_tax).toBe("20,000 円");
  });

  it("★時間の上限で返事が無かった伝票は、続けて頼む", async () => {
    const s = setup();
    for (const no of ["TE00000001", "TE00000002", "TE00000003"]) await saved(s.store, no, {});
    const asked: string[][] = [];
    const { status } = await runReread(s, {
      reread: (request) => {
        asked.push(request.denpyoNos);
        const [first] = request.denpyoNos;
        return { fields: [{ denpyoNo: first, fields: { amount_ex_tax: "1 円" } }], failed: [] };
      },
    });
    expect(asked).toEqual([
      ["TE00000003", "TE00000002", "TE00000001"],
      ["TE00000002", "TE00000001"],
      ["TE00000001"],
    ]);
    expect(status.processed).toBe(3);
  });

  it("1件も返事が無ければ、同じ頼み方を繰り返さずに止める", async () => {
    const s = setup();
    await saved(s.store, "TE00000001", {});
    const { api, status } = await runReread(s, { reread: () => ({ fields: [], failed: [] }) });
    expect(api.calls.filter((c) => c.method === "reread")).toHaveLength(1);
    expect(status.state).toBe("done");
    expect(status.remaining).toBe(1);
  });

  it("★ログインが切れたら1回だけログインし直してやり直す", async () => {
    const s = setup();
    await saved(s.store, "TE00000001", {});
    const { api, status } = await runReread(s, {
      reread: (_request, count) =>
        count === 1
          ? new RakurakuApiError("SESSION_EXPIRED", "切れました", false, true)
          : { fields: [{ denpyoNo: "TE00000001", fields: { amount_ex_tax: "1 円" } }], failed: [] },
    });
    expect(api.calls.filter((c) => c.method === "login")).toHaveLength(1);
    expect(status.state).toBe("done");
    expect(status.processed).toBe(1);
  });

  it("対象が無ければ楽楽精算に触らない", async () => {
    const s = setup();
    await saved(s.store, "TE00000001", { amount_ex_tax: "1 円" });
    const { api, status } = await runReread(s, {});
    expect(api.calls).toHaveLength(0);
    expect(status.message).toBe("読み直す伝票はありませんでした");
  });
});
