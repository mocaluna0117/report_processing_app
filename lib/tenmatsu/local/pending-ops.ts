/**
 * 保留中の伝票を確定する・確定した伝票を組み直す。
 *
 * 移植元: tenmatsu.py 836-990（complete_pending / recompose_saved / _store_parts）、server.py 688-817
 *
 * ★保存先の PDF・記録・部品を書き換える順番に意味がある。各所のコメントを消さないこと。
 */
import type { PendingFile, PendingUpload } from "@/lib/tenmatsu/client";
import { fingerprintOf } from "./fingerprint";
import { type FolderStore, type Path } from "./fs";
import { type LocalKindConfig, PARTS_DIR, PENDING_MERGED_NAME } from "./kind-config";
import {
  PendingError,
  applyUploads,
  checkSlotsFilled,
  cleanupParts,
  mergeManifest,
  missingRecords,
  readManifest,
  uploadedNames,
  writeManifest,
} from "./manifest";
import { decideNamedOutputName, decideOutputName, last4, safeComponent } from "./naming";
import {
  type LogEntry,
  addLogEntry,
  claimedNames,
  hasValue,
  localStamp,
  partsDirPath,
  pendingDirPath,
  readRecords,
  updateRecords,
  withRecordsLock,
} from "./records";

/** 作業用のフォルダー（移植元と同じ名前。保存先の中） */
export const WORK_DIR = "_work";

export interface PendingOpResult {
  /** 保存したファイル名 */
  savedName: string;
  /** 記録は済んだが、片付けができなかったこと（利用者に伝える） */
  warnings: string[];
}

// 同じ伝票への確定・差し替えが重ならないようにする（二重に押された・同じ画面の中で重なった）
const pendingLocks = new WeakMap<object, Promise<unknown>>();

function withPendingLock<T>(store: FolderStore, fn: () => Promise<T>): Promise<T> {
  const previous = pendingLocks.get(store.root) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  pendingLocks.set(
    store.root,
    run.catch(() => undefined),
  );
  return run;
}

/**
 * 欠けた添付を入れて結合し直し、正式なフォルダーへ保存する。戻り値は保存したファイル名。
 *
 * upload.files / slots の意味は applyUploads（枠は「望む最終状態」を1回で送る）。
 * acceptMissing が真なら、欠けたままでも保存する（一覧に「添付が欠けています」と残る）。
 * ★ただし「あとからアップロードする書類」（awaiting、捺印決裁書）は acceptMissing でも通さない。
 * 保存名は記録の final_name があればそれ、無ければ接頭辞＋下4桁。
 * keepParts の種類（捺印決裁書）は、確定したあとも部品を `_部品/` に残す。
 */
export function completePending(
  store: FolderStore,
  cfg: LocalKindConfig,
  denpyoNo: string,
  upload: PendingUpload,
  now: Date = new Date(),
): Promise<PendingOpResult> {
  return withPendingLock(store, async () => {
    const records = await readRecords(store, cfg);
    const info = records.pending[denpyoNo];
    if (!info) throw new PendingError("notPending", `伝票 ${denpyoNo} は保留になっていません`);
    const dir = pendingDirPath(info.dir);
    const manifest = await readManifest(store, dir, { composed: cfg.composed, missing: "noFiles" });
    const parts = manifest.parts;

    await applyUploads(store, dir, manifest, upload.files, upload.slots ?? []);
    if (upload.files.length > 0 || (upload.slots ?? []).length > 0) {
      // 結合に失敗しても、入れた分と並びは残す（もう一度選ばせない）
      await writeManifest(store, dir, manifest);
    }

    checkSlotsFilled(parts);
    const stillMissing = missingRecords(parts);
    if (stillMissing.length > 0 && !upload.acceptMissing) {
      throw new PendingError("invalid", `添付 ${stillMissing.map((m) => m.name).join("、")} が足りません`);
    }

    // 失敗は mergeFailed（保留のまま残す。manifest の内訳は前のまま）
    const merged = await mergeManifest(store, dir, manifest, { strictFirst: true });

    // 伝票ごとに決めた名前があればそれで保存する（捺印決裁書）。無ければ接頭辞＋下4桁
    // ★ほかの記録が指している名前は使わない（名前を変えて空いた名前を取ると、元の記録が別のPDFを指す）
    const reserved = claimedNames(records, cfg);
    const finalName = info.meta?.final_name;
    const savedName =
      typeof finalName === "string" && finalName
        ? await decideNamedOutputName(store, [], finalName, reserved)
        : await decideOutputName(store, [], denpyoNo, cfg.filePrefix, reserved);
    const fingerprint = await fingerprintOf(merged.bytes);
    // 保存先で開かれていて書けないときは FolderError（conflict）。保留はそのまま残る
    await store.writeBytes([savedName], merged.bytes);

    const meta: Record<string, unknown> = { ...(info.meta ?? {}) };
    if (stillMissing.length > 0) meta.missing_attachments = stillMissing;
    const replaced = uploadedNames(parts);
    if (replaced.length > 0) meta.replaced_attachments = replaced;
    // ★記録の追加と保留の削除は1回の書き換えで行う。分けると、その間に同じ伝票が
    //   「保存済み」と「保留」の両方で見える
    await updateRecords(store, cfg, (data) => {
      addLogEntry(data, cfg, denpyoNo, savedName, meta, now, fingerprint);
      delete data.pending[denpyoNo];
    });

    const warnings: string[] = [];
    if (cfg.keepParts) {
      // ★内訳（pages）を書くのはここ。保存先へ置けた後なので、manifest の pages は確実に保存した PDF の内訳になる
      await writeManifest(store, dir, manifest);
      const stored = await storeParts(store, dir, manifest, partsDirPath(info.dir));
      if (!stored) warnings.push(`部品を残せませんでした（差し替えはできません）: ${PARTS_DIR}/${info.dir}`);
    } else {
      await store.remove(dir, { recursive: true }).catch(() => {
        // 消せなくても記録は済んでいるので続ける（一覧にはもう出ない）
        warnings.push(`保留のフォルダーを消せませんでした（手で消してください）: ${dir.join("/")}`);
      });
    }
    return { savedName, warnings };
  });
}

/** 確定した部品を `_部品/` へ残す（あとで差し替えて組み直せるように）。できなければ false */
async function storeParts(store: FolderStore, from: Path, manifest: Parameters<typeof cleanupParts>[2], to: Path): Promise<boolean> {
  try {
    await cleanupParts(store, from, manifest);
    // ★移し先を先に消す（残っていると中へ入れてしまう。moveDir がそうする）
    await store.moveDir(from, to);
    return true;
  } catch {
    // 記録は済んでいるので続ける（差し替えはできなくなる）
    return false;
  }
}

/**
 * 確定した書類を、入れた書類を変えて組み直す（捺印決裁書）。戻り値は保存したファイル名。
 *
 * `_部品/<伝票No.>/` を作業フォルダーへ**写して**、確定と同じ規則で枠の最終状態を作り、結合し直して
 * **同じ名前で上書き**する。
 * ★成功するまで保存先の PDF も `_部品/` も変えない。途中で失敗すれば元のまま残る
 *   （だから「差し替えをやめる」の仕組みが要らない）。
 * ★名前は変えない（`_2` も付けない）。クラウドに上げた名前と食い違わないように。
 * ★中身が変わるので、完了の印（クラウド格納済み）は外す。
 */
export function recomposeSaved(
  store: FolderStore,
  cfg: LocalKindConfig,
  denpyoNo: string,
  files: readonly PendingFile[],
  slots: readonly number[],
  now: Date = new Date(),
): Promise<PendingOpResult> {
  return withPendingLock(store, async () => {
    if (!cfg.keepParts) throw new PendingError("invalid", `${cfg.label}は書類の差し替えに対応していません`);
    const data = await withRecordsLock(store, cfg, () => readRecords(store, cfg));
    if (data.pending[denpyoNo]) {
      throw new PendingError("invalid", `伝票 ${denpyoNo} は保留中です（「書類を足す」で確定してください）`);
    }
    if (!data.done.includes(denpyoNo)) throw new PendingError("notSaved", `伝票 ${denpyoNo} の記録がありません`);
    const entry: Partial<LogEntry> = [...data.log].reverse().find((e) => e.denpyo_no === denpyoNo) ?? {};
    const savedName =
      (typeof entry.file === "string" && entry.file) ||
      (typeof entry.final_name === "string" && entry.final_name) ||
      `${cfg.filePrefix}${last4(denpyoNo)}.pdf`;
    // ★記録の名前のPDFが無ければ書かずに止める。以前は元の名前で新しいファイルを作ってしまい、
    //   利用者が名前を変えたファイルが古いまま残っていた（クラウドに古い方を上げてしまう）
    const missingFile = () =>
      new PendingError(
        "fileMissing",
        `保存先に「${savedName}」が見つからないので差し替えできません。` +
          "名前を変えた場合は、一覧の「PDFを選ぶ」で選び直してから差し替えてください",
      );
    if ((await store.stat([savedName]))?.kind !== "file") throw missingFile();

    const src = partsDirPath(safeComponent(denpyoNo));
    await readManifest(store, src, { composed: cfg.composed, missing: "noParts" });

    const work: Path = [WORK_DIR, `${safeComponent(denpyoNo)}_差し替え`];
    await store.remove(work, { recursive: true });
    await store.copyDir(src, work);

    let manifest;
    let merged;
    try {
      manifest = await readManifest(store, work, { composed: cfg.composed, missing: "noParts" });
      await applyUploads(store, work, manifest, files, slots);
      await writeManifest(store, work, manifest);
      checkSlotsFilled(manifest.parts);
      merged = await mergeManifest(store, work, manifest, { strictFirst: true });
      // 組み立てている間に名前を変えられていたら、やはり書かない
      if ((await store.stat([savedName]))?.kind !== "file") throw missingFile();
      // ★同じ名前で上書きする。PDF を開いたままだと書けない（FolderError の conflict で案内が出る）
      await store.writeBytes([savedName], merged.bytes);
    } catch (e) {
      await store.remove(work, { recursive: true }).catch(() => undefined);
      throw e;
    }

    // 上書きが済んだので、内訳（pages）を書き直す（新しい PDF の内訳になる）
    const warnings: string[] = [];
    try {
      await writeManifest(store, work, manifest);
      await store.remove([...work, PENDING_MERGED_NAME]);
      await cleanupParts(store, work, manifest);
      await store.moveDir(work, src);
    } catch {
      warnings.push(`部品を残せませんでした（次の差し替えはできません）: ${src.join("/")}`);
    }

    // 前の記録から引き継ぐ（欠け・入れた書類は今の manifest から作り直す）
    const meta: Record<string, unknown> = {};
    for (const key of cfg.metaKeys) {
      if (key === "missing_attachments" || key === "replaced_attachments") continue;
      if (hasValue(entry[key])) meta[key] = entry[key];
    }
    const stillMissing = missingRecords(manifest.parts);
    if (stillMissing.length > 0) meta.missing_attachments = stillMissing;
    const replaced = uploadedNames(manifest.parts);
    if (replaced.length > 0) meta.replaced_attachments = replaced;
    if (merged.skipped.length > 0) meta.skipped_attachments = merged.skipped.map((x) => x.replace(/^\d{3}_(\d{2}_)?/, ""));
    meta.recomposed_at = localStamp(now);
    // 中身が変わったので指紋も新しいバイト列から作る（前の記録から写さない）
    const fingerprint = await fingerprintOf(merged.bytes);
    await updateRecords(store, cfg, (records) => {
      addLogEntry(records, cfg, denpyoNo, savedName, meta, now, fingerprint);
      // ★中身が変わったので完了の印は外す（クラウドにあるものは古い）
      delete records.flags[denpyoNo];
    });
    return { savedName, warnings };
  });
}
