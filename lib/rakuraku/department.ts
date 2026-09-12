import "server-only";
import type { Frame, Page, Request } from "playwright-core";

/**
 * 所属部門の切り替え（`select[name="bumonCd"]`）。
 *
 * これは**表示する対象を選ぶだけ**の操作で、楽楽精算のデータは変えない。
 *
 * ★ 現行の Python (`tenmatsu.py:1965-2002`) から意図的に変えた点が3つある。
 *   ① **選ぶときは値 (code) で指定する。** Python は部門名の部分一致で探していたが、
 *      実画面の表示は「品質管理部(1900)」のようにコード付きなので、
 *      名前の一部が重なる部門があるとすり替わる。
 *   ② **見つからないことを黙って握り潰さない。** Python は選択肢に無くても警告を出すだけで
 *      「いま選ばれている部門名」を返しており、呼び出し側からは成功と区別できなかった。
 *      その結果、**別部門の伝票を黙って取り続ける**ことが起こりうる。
 *      ここでは必ずどれかの形で返し、呼ぶ側が分岐できるようにする。
 *   ③ **切り替えが本当に効いたかを確かめる。** Python は切り替えたあと
 *      `page.wait_for_load_state("load")` で待ったつもりだったが、読み込み済みの画面では
 *      **即座に返るので実際には何も待っていなかった**。そのまま一覧へ移動すると、
 *      切り替えの通信が取り消されたり一覧の通信と前後したりして、**元の部門の一覧を読む**おそれがある。
 *      （Python の利用者は既定の部門のまま使っていたので表面化しなかった。部門をその都度選ぶ今回は踏む）
 */
export interface Department {
  /** option の value。切り替えにはこれを使う */
  code: string;
  /** 画面の表示そのまま（例「品質管理部(1900)」）。人に見せる用 */
  label: string;
}

export type DepartmentResult =
  /** 切り替えた（効いたことを確かめ済み） */
  | { kind: "selected"; department: Department }
  /** すでにその部門だった（何もしていない） */
  | { kind: "already"; department: Department }
  /** 選択肢にない＝このアカウントでは選べない */
  | { kind: "not-available"; available: Department[] }
  /** プルダウン自体が無い＝部門内検索の権限が無い可能性 */
  | { kind: "no-select" }
  /** 選んだが、確かめ直すと別の部門のままだった */
  | { kind: "not-applied"; department: Department; current: Department | null };

export interface EnsureDepartmentOptions {
  /**
   * 切り替えたあと、この URL を開き直して選ばれている部門を読み直す（トップ画面の URL を渡す）。
   * ★画面の中の表示ではなく、**楽楽精算が覚えている部門**を確かめるため。
   *   渡さなければ、いまの画面の選択肢を読み直すだけになる。
   */
  reopenUrl?: string;
  /** 選んだあと、切り替えの通信が始まるのを待つ時間 */
  requestStartWaitMs?: number;
  /** 切り替えの通信が終わるのを待つ上限 */
  settleTimeoutMs?: number;
}

const SELECT = 'select[name="bumonCd"]';

interface RawState {
  selected: string;
  options: Department[];
}

/** プルダウンを持っているフレームを探す。楽楽精算は frameset なので全部見る */
async function findSelect(page: Page): Promise<Frame | null> {
  for (const frame of page.frames()) {
    const count = await frame
      .locator(SELECT)
      .count()
      .catch(() => 0);
    if (count > 0) return frame;
  }
  return null;
}

async function readState(frame: Frame): Promise<RawState> {
  return await frame
    .locator(SELECT)
    .first()
    .evaluate((el): RawState => {
      const select = el as HTMLSelectElement;
      const options = [...select.options].map((o) => ({
        code: o.value,
        label: (o.text || "").trim(),
      }));
      return { selected: select.options[select.selectedIndex]?.value ?? "", options };
    });
}

/**
 * 選べる部門を読む。プルダウンが無ければ null（＝権限が無い可能性）。
 * 空の選択肢は落とす（区切り用の空 option が混ざることがある）。
 */
export async function listDepartments(page: Page): Promise<Department[] | null> {
  const frame = await findSelect(page);
  if (!frame) return null;
  const { options } = await readState(frame);
  return options.filter((o) => o.code !== "" && o.label !== "");
}

/** いま選ばれている部門。プルダウンが無ければ null */
export async function currentDepartment(page: Page): Promise<Department | null> {
  const frame = await findSelect(page);
  if (!frame) return null;
  const { selected, options } = await readState(frame);
  return options.find((o) => o.code === selected) ?? null;
}

/** 上限つきで待つ。時間切れでも例外にしない */
async function within(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise.catch(() => null),
    new Promise((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

/**
 * 目的の部門になっていることを確かめ、違えば切り替える。
 *
 * ★ 一覧を開く**直前に毎回**呼ぶこと。Vercel は呼び出しごとに別のブラウザになるので、
 *   「ジョブの最初に1回」では足りない。すでにその部門なら何もしない。
 */
export async function ensureDepartment(
  page: Page,
  code: string,
  options: EnsureDepartmentOptions = {},
): Promise<DepartmentResult> {
  const frame = await findSelect(page);
  if (!frame) return { kind: "no-select" };

  const { selected, options: all } = await readState(frame);
  const available = all.filter((o) => o.code !== "" && o.label !== "");
  const wanted = available.find((o) => o.code === code);
  if (!wanted) return { kind: "not-available", available };
  if (selected === code) return { kind: "already", department: wanted };

  // 切り替えで起きた通信を集め、**全部の応答が返るまで**待ってから次へ進む。
  // 画面の作り（フォームを送り直す／裏で通信する／画面の中だけで変わる）が分からなくても待てるように、
  // 読み込みではなく通信そのものを見る。検索ボタンは押さない。
  const requests: Request[] = [];
  const onRequest = (request: Request) => requests.push(request);
  page.on("request", onRequest);
  try {
    await frame.locator(SELECT).first().selectOption(code);
    await page.waitForTimeout(options.requestStartWaitMs ?? 1_000);
  } finally {
    page.off("request", onRequest);
  }
  const settleMs = options.settleTimeoutMs ?? 15_000;
  await within(Promise.all(requests.map((r) => r.response())), settleMs);
  if (requests.some((r) => r.isNavigationRequest())) {
    await page.waitForLoadState("load", { timeout: settleMs }).catch(() => null);
  }

  if (options.reopenUrl) {
    await page.goto(options.reopenUrl, { waitUntil: "load", timeout: 30_000 });
  }
  const current = await currentDepartment(page);
  if (current?.code !== code) return { kind: "not-applied", department: wanted, current };
  return { kind: "selected", department: wanted };
}
