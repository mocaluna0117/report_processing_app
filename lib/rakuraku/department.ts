import "server-only";
import type { Frame, Page } from "playwright-core";

/**
 * 所属部門の切り替え（`select[name="bumonCd"]`）。
 *
 * これは**表示する対象を選ぶだけ**の操作で、楽楽精算のデータは変えない。
 *
 * ★ 現行の Python (`tenmatsu.py:1965-2002`) から意図的に変えた点が2つある。
 *   ① **選ぶときは値 (code) で指定する。** Python は部門名の部分一致で探していたが、
 *      実画面の表示は「品質管理部(1900)」のようにコード付きなので、
 *      名前の一部が重なる部門があるとすり替わる。
 *   ② **見つからないことを黙って握り潰さない。** Python は選択肢に無くても警告を出すだけで
 *      「いま選ばれている部門名」を返しており、呼び出し側からは成功と区別できなかった。
 *      その結果、**別部門の伝票を黙って取り続ける**ことが起こりうる。
 *      ここでは必ず4通りのどれかを返し、呼ぶ側が分岐できるようにする。
 */
export interface Department {
  /** option の value。切り替えにはこれを使う */
  code: string;
  /** 画面の表示そのまま（例「品質管理部(1900)」）。人に見せる用 */
  label: string;
}

export type DepartmentResult =
  /** 切り替えた */
  | { kind: "selected"; department: Department }
  /** すでにその部門だった（何もしていない） */
  | { kind: "already"; department: Department }
  /** 選択肢にない＝このアカウントでは選べない */
  | { kind: "not-available"; available: Department[] }
  /** プルダウン自体が無い＝部門内検索の権限が無い可能性 */
  | { kind: "no-select" };

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

/**
 * 目的の部門になっていることを確かめ、違えば切り替える。
 *
 * ★ 一覧を開く**直前に毎回**呼ぶこと。Vercel は呼び出しごとに別のブラウザになるので、
 *   「ジョブの最初に1回」では足りない。すでにその部門なら何もしない。
 */
export async function ensureDepartment(page: Page, code: string): Promise<DepartmentResult> {
  const frame = await findSelect(page);
  if (!frame) return { kind: "no-select" };

  const { selected, options } = await readState(frame);
  const available = options.filter((o) => o.code !== "" && o.label !== "");
  const wanted = available.find((o) => o.code === code);
  if (!wanted) return { kind: "not-available", available };
  if (selected === code) return { kind: "already", department: wanted };

  await frame.locator(SELECT).first().selectOption(code);
  // 切り替えると onchange で画面が読み込み直される。検索ボタンは押さない
  await page.waitForLoadState("load").catch(() => null);
  return { kind: "selected", department: wanted };
}
