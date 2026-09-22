/**
 * 共有フォルダー（Box Drive などで見えるフォルダー）に、共有データを読み書きする。
 *
 * ★正本はフォルダーの中のファイル。ブラウザの保存は写し（顛末書の _記録 と同じ考え方）。
 * ★同時に書いても壊れないように、**読んだ時点から変わっていないか**を書く直前に確かめ、
 *   変わっていたら読み直して重ね直す（楽観チェック）。ロックのファイルは作らない：
 *   - 同期のフォルダーではロックが相手に届くまで遅れ、肝心の瞬間に見えない
 *   - 突き合わせは可換・冪等で、各PCが全部を持っているので、書き負けても次の同期で戻る
 * ★変わっていないときは書かない（控え .bak を無駄に潰さない）。
 * ★読めないファイルは**自分で直さず止める**。直した結果を正本として相手にも配ってしまうため。
 *
 * Box Drive での実測（2026-09-22・利用者のPC）: 1往復 約0.5秒、書くたびに更新時刻が変わる。
 * ★**大きさは変わらないことがある**ので、変化の判定は「大きさと更新時刻の両方」で見る。
 */
import type { SharedDataset } from "@/lib/shared/datasets";
import { backupName } from "@/lib/shared/datasets";
import {
  type SharedEnvelope,
  SharedCorruptError,
  formatEnvelope,
  formatItems,
  parseEnvelope,
} from "@/lib/shared/envelope";
import { FolderError, type FolderStore } from "@/lib/tenmatsu/local/fs";

/** ほかの端末が同時に書いていて、何度読み直しても落ち着かなかった */
export class SharedBusyError extends Error {
  constructor(readonly file: string) {
    super(
      `${file} を別の端末が同時に書き換えています。少し待ってから「共有フォルダーと同期」を押してください`,
    );
    this.name = "SharedBusyError";
  }
}

export interface SharedFolderTiming {
  /** 半端なファイルを読んだときに読み直す回数（同期の途中に当たることがある） */
  readAttempts: number;
  /** 読み直すまでの待ち */
  readWaitMs: number;
  /** 書く直前に変わっていたときに、やり直す回数 */
  writeAttempts: number;
  sleep: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const DEFAULT_SHARED_TIMING: SharedFolderTiming = {
  readAttempts: 3,
  readWaitMs: 400,
  writeAttempts: 3,
  sleep: wait,
};

/** 読んだ時点のファイルの様子（書く直前に見比べる） */
export interface FileMark {
  exists: boolean;
  size: number;
  lastModified: number;
}

const NO_FILE: FileMark = { exists: false, size: -1, lastModified: -1 };

/**
 * 読んだ時点から変わったか。
 * ★大きさだけでは足りない（同じ長さで中身だけ変わることがある。Box で実測）。
 */
export function statChanged(before: FileMark, after: FileMark): boolean {
  if (before.exists !== after.exists) return true;
  return before.size !== after.size || before.lastModified !== after.lastModified;
}

export interface ReadResult<T> {
  /** ファイルが無ければ null（まだ誰も書いていない） */
  envelope: SharedEnvelope<T> | null;
  mark: FileMark;
}

export interface UpdateResult<T> {
  items: T;
  /** 書いたか（中身が変わっていなければ書かない） */
  written: boolean;
  /** やり直した回数（0＝一度で書けた） */
  retries: number;
}

/** 共有フォルダー1つ分の読み書き */
export class SharedFolder {
  constructor(
    readonly store: FolderStore,
    readonly writer: string,
    readonly timing: SharedFolderTiming = DEFAULT_SHARED_TIMING,
  ) {}

  get name(): string {
    return this.store.name;
  }

  /** フォルダーがまだ使えるか（無くなっていれば folderMissing） */
  probe(): Promise<void> {
    return this.store.probe();
  }

  private async mark(dataset: SharedDataset): Promise<FileMark> {
    const stat = await this.store.stat([dataset.file]);
    if (!stat || stat.kind !== "file") return NO_FILE;
    return { exists: true, size: stat.size, lastModified: stat.lastModified };
  }

  /** そのデータのファイルがもう置かれているか（初回の書き出しを確かめるのに使う） */
  async hasDataset(dataset: SharedDataset): Promise<boolean> {
    return (await this.mark(dataset)).exists;
  }

  /**
   * 読む。ファイルが無ければ null。
   * ★半端な JSON（同期の途中）は少し待って読み直す。それでも駄目なら止める。
   */
  async read<T>(
    dataset: SharedDataset,
    pick: (value: unknown) => T | null,
  ): Promise<ReadResult<T>> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.timing.readAttempts; attempt++) {
      const mark = await this.mark(dataset);
      if (!mark.exists) return { envelope: null, mark };
      try {
        const text = await this.store.readText([dataset.file]);
        return { envelope: parseEnvelope(dataset, text, pick), mark };
      } catch (e) {
        // 形が違う・別の種類・新しい版は読み直しても変わらないので、そのまま返す
        if (!(e instanceof SharedCorruptError) && !(e instanceof FolderError)) throw e;
        lastError = e;
        if (attempt < this.timing.readAttempts) await this.timing.sleep(this.timing.readWaitMs);
      }
    }
    throw lastError;
  }

  /**
   * 読んで・重ねて・変わっていれば書く。
   * `merge` は「いまファイルにある中身（無ければ null）」を受け取り、書きたい中身を返す。
   */
  async update<T>(
    dataset: SharedDataset,
    pick: (value: unknown) => T | null,
    merge: (current: T | null) => T,
    now: number,
  ): Promise<UpdateResult<T>> {
    for (let attempt = 0; attempt < this.timing.writeAttempts; attempt++) {
      const { envelope, mark } = await this.read(dataset, pick);
      const current = envelope?.items ?? null;
      const merged = merge(current);
      // ★中身が変わっていなければ書かない（控えを無駄に潰さない）
      if (current !== null && formatItems(current) === formatItems(merged)) {
        return { items: merged, written: false, retries: attempt };
      }
      // ★書く直前にもう一度見比べる。読んでから誰かが書いていたら、読み直してやり直す
      if (statChanged(mark, await this.mark(dataset))) continue;
      if (mark.exists) {
        // 控えは1世代だけ（顛末書の _記録 と同じ）
        await this.store.copyFile([dataset.file], [backupName(dataset.file)]);
      }
      await this.store.writeBytes([dataset.file], formatEnvelope(dataset, merged, this.writer, now));
      return { items: merged, written: true, retries: attempt };
    }
    throw new SharedBusyError(dataset.file);
  }
}

/**
 * 画面に出す文面。
 * ★「ほかのアプリで開いていませんか」は PDF を想定した言い方なので、共有フォルダー用に言い換える。
 */
export function sharedErrorText(error: unknown): string {
  if (error instanceof SharedBusyError) return error.message;
  if (error instanceof FolderError) {
    switch (error.kind) {
      case "folderMissing":
        return "共有フォルダーが見つかりません（Box が動いていないか、フォルダーが移動・削除された可能性があります）。つなぎ直すか、選び直してください";
      case "permission":
        return "共有フォルダーを読み書きする許可がありません。「共有フォルダーにつなぐ」を押して許可してください";
      case "conflict":
        return "共有フォルダーのファイルにいま書けませんでした（Box の同期中か、ほかの人が同時に書いた可能性があります）。少し待ってからもう一度同期してください";
      case "quota":
        return "共有フォルダーの空き容量が足りません";
      default:
        return `共有フォルダーを読み書きできませんでした（${error.message}）`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
