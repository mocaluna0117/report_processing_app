import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TenmatsuError, resolveRunLimits } from "@/lib/tenmatsu/client";
import { createLocalFolderClient, resetActiveRun, toTenmatsuError } from "@/lib/tenmatsu/local/client";
import { FolderError, FolderStore } from "@/lib/tenmatsu/local/fs";
import { LOCAL_KINDS } from "@/lib/tenmatsu/local/kind-config";
import { type Manifest, PendingError } from "@/lib/tenmatsu/local/manifest";
import { RecordsCorruptError, appendProcessed, registerPending } from "@/lib/tenmatsu/local/records";
import type { FetchResult } from "@/lib/tenmatsu/local/server-api";
import { FakeFs } from "./helpers/fake-fs";
import { type FakeApiScript, createFakeApi, file, scanOf, target } from "./helpers/fake-rakuraku-api";
import { makePdf } from "./helpers/pdf-parts";

const NOW = new Date(2026, 8, 13, 12, 0, 0);

beforeEach(() => resetActiveRun());
afterEach(() => resetActiveRun());

async function failure(promise: Promise<unknown>): Promise<TenmatsuError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof TenmatsuError) return e;
    throw e;
  }
  throw new Error("失敗するはずが、通ってしまった");
}

function setup(script: FakeApiScript = {}, kind: "tenmatsu" | "senketsu" | "natsuin" = "tenmatsu", options: { sleep?: (ms: number) => Promise<void> } = {}) {
  const fs = new FakeFs();
  const store = new FolderStore(fs.root);
  let token: string | null = "token-0";
  const api = createFakeApi(script);
  const client = createLocalFolderClient({
    kind,
    store,
    api,
    auth: { token: () => token, setToken: (t) => (token = t), login: async () => (await api.login("sealed-credential")).sessionToken },
    deptCode: () => "1900",
    now: () => NOW,
    sleep: options.sleep ?? (async () => undefined),
  });
  return { fs, store, api, client };
}

async function fetched(): Promise<FetchResult> {
  return { fields: { shinsei_date: "2026/09/10 11:37:00" }, body: file("body", 0, "本体", ".pdf", await makePdf(1)), attachmentNames: [], attachments: [], failures: [], linked: null, compose: null };
}

describe("フォルダー版のクライアント（旧方式と同じ約束で動く）", () => {
  it("疎通確認はフォルダーの名前と件数の上下限を返す（画面の件数欄がそのまま使える）", async () => {
    const { client } = setup();
    const health = await client.health();
    expect(health).toMatchObject({ ok: true, save_dir: "顛末書", job_state: "idle" });
    expect(resolveRunLimits(health)).toEqual({ value: 10, min: 1, max: 100, fromServer: true });
  });

  it("★フォルダーが無くなっていたら、選び直すよう伝える", async () => {
    const { fs, client } = setup();
    fs.vanish();
    const error = await failure(client.health());
    expect(error.kind).toBe("folderMissing");
  });

  it("★取得して一覧に出る。状態は購読で届き、since で行を取り出せる", async () => {
    const { client } = setup({ scan: scanOf([target("TE00009101")]), fetch: { TE00009101: await fetched() } });
    const result = await client.run({ maxPerRun: 5 });
    expect(result).toMatchObject({ started: true, maxPerRun: 5 });
    const states: string[] = [];
    const stop = client.subscribe((s) => states.push(s.state));
    // 決まった時間だけ待つと、ほかのテストと並んで重いときに間に合わない。終わるまで待つ (最大5秒)
    for (let waited = 0; (await client.status()).state === "running" && waited < 5000; waited += 20) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    stop();
    const status = await client.status(0);
    expect(status.state).toBe("done");
    expect(status.log?.some((l) => l.text === "  OK 保存: 顛末書№9101.pdf")).toBe(true);
    const items = await client.list();
    expect(items.map((i) => [i.denpyo_no, i.file, i.exists])).toEqual([["TE00009101", "顛末書№9101.pdf", true]]);
  });

  it("★件数が範囲外・整数でなければ、丸めずに断る", async () => {
    const { client } = setup();
    expect((await failure(client.run({ maxPerRun: 0 }))).message).toContain("1〜100");
    expect((await failure(client.run({ maxPerRun: 101 }))).kind).toBe("badRequest");
    expect((await failure(client.run({ maxPerRun: 2.5 }))).kind).toBe("badRequest");
  });

  it("★取得中にもう一度始めようとしたら started:false。保留の確定・取りやめ・差し替えは断る", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { client, store } = setup(
      { scan: scanOf([target("TE1"), target("TE2")]), fetch: { TE1: await fetched(), TE2: await fetched() } },
      "tenmatsu",
      { sleep: () => gate },
    );
    await registerPending(store, LOCAL_KINDS.tenmatsu, "TE9", "TE9", [], null, NOW);
    await client.run();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await client.run()).started).toBe(false);
    expect((await failure(client.completePending("TE9", { files: [], acceptMissing: true }))).kind).toBe("conflict");
    expect((await failure(client.retryPending("TE9"))).kind).toBe("conflict");
    expect((await client.health()).job_state).toBe("running");
    release();
  });

  it("★別の種類が取得中なら、この種類の取得も始めない（ページの中で1本だけ）", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = setup({ scan: scanOf([target("TE1"), target("TE2")]), fetch: { TE1: await fetched(), TE2: await fetched() } }, "tenmatsu", { sleep: () => gate });
    await first.client.run();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const other = setup({ scan: scanOf([]) }, "senketsu");
    expect((await other.client.run()).started).toBe(false);
    expect(other.api.calls).toEqual([]);
    release();
  });

  it("印を変えると更新後の行を返す。保留中の伝票には付けさせない", async () => {
    const { client, store } = setup();
    await appendProcessed(store, LOCAL_KINDS.tenmatsu, "TE1", "a.pdf", null, NOW);
    await registerPending(store, LOCAL_KINDS.tenmatsu, "TE2", "TE2", [], null, NOW);
    expect(await client.setFlags("TE1", { cloud_stored: true })).toMatchObject({ denpyo_no: "TE1", cloud_stored: true, budget_entered: false });
    expect((await failure(client.setFlags("TE2", { cloud_stored: true }))).kind).toBe("conflict");
    expect((await failure(client.setFlags("TE1", {}))).kind).toBe("badRequest");
    expect((await failure(client.setFlags("TE404", { cloud_stored: true }))).kind).toBe("notFound");
  });

  it("PDF を読む: 保存済みは保存先の PDF、保留中は途中の PDF", async () => {
    const { fs, client, store } = setup();
    fs.put("顛末書№0001.pdf", "保存済み");
    fs.put("_保留/TE2/_merged.pdf", "途中");
    await appendProcessed(store, LOCAL_KINDS.tenmatsu, "TE00000001", "顛末書№0001.pdf", null, NOW);
    await registerPending(store, LOCAL_KINDS.tenmatsu, "TE2", "TE2", [], null, NOW);
    expect(await (await client.filePdf("TE00000001")).text()).toBe("保存済み");
    expect(await (await client.filePdf("TE2")).text()).toBe("途中");
    expect((await failure(client.filePdf("TE404"))).kind).toBe("notFound");
  });

  it("★保留を確定すると更新後の行を返す（同じ名前があれば上書きせず別名）", async () => {
    const { fs, client, store } = setup();
    const manifest: Manifest = { parts: [{ index: 0, name: "本体", status: "ok", file: "000_本体.pdf" }, { index: 1, name: "見積.xlsx", status: "failed", reason: "結合できません" }] };
    fs.put("_保留/TE00000005/000_本体.pdf", await makePdf(1));
    fs.put("_保留/TE00000005/manifest.json", JSON.stringify(manifest));
    await registerPending(store, LOCAL_KINDS.tenmatsu, "TE00000005", "TE00000005", [{ index: 1, name: "見積.xlsx", reason: "結合できません" }], null, NOW);
    fs.put("顛末書№0005.pdf", "前からある");
    expect(await client.completePending("TE00000005", { files: [], acceptMissing: true })).toMatchObject({
      file: "顛末書№TE00000005.pdf",
      pending: false,
      missing_attachments: [{ index: 1, name: "見積.xlsx", reason: "結合できません" }],
    });
    expect(fs.text("顛末書№0005.pdf")).toBe("前からある");
  });

  it("★フォルダーの失敗は、画面が知っている種類に直す（開いていて書けない・許可が無い・無くなった）", () => {
    expect(toTenmatsuError(new FolderError("conflict", "閉じてから")).kind).toBe("conflict");
    expect(toTenmatsuError(new FolderError("permission", "許可")).kind).toBe("permission");
    expect(toTenmatsuError(new FolderError("folderMissing", "選び直して")).kind).toBe("folderMissing");
    expect(toTenmatsuError(new PendingError("mergeFailed", "結合できません")).kind).toBe("badRequest");
    expect(toTenmatsuError(new PendingError("noParts", "部品が無い")).kind).toBe("notFound");
    expect(toTenmatsuError(new RecordsCorruptError("壊れています", [], true)).message).toBe("壊れています");
  });

  it("確定の入れ方が正しくなければ badRequest、保留が無ければ notFound", async () => {
    const { client } = setup();
    expect((await failure(client.completePending("TE404", { files: [], acceptMissing: false }))).message).toBe("結合する添付が選ばれていません");
    expect((await failure(client.completePending("TE404", { files: [], acceptMissing: true }))).kind).toBe("notFound");
  });
});
