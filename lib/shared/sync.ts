"use client";

// 共有フォルダーとブラウザの保存を突き合わせる（1回分の同期）。
//
// 順番は **ファイル（正本）→ 写し（IndexedDB）**:
//   1. この端末の分を取り出す
//   2. フォルダーのファイルに重ねて書く（中身が変わらなければ書かない）
//   3. 重ねた結果をこの端末へ書き戻す（置き換えではなく**再度重ねる**。
//      1〜3のあいだにこの端末で直した分を消さないため）
//
// ★1つのデータでつまずいても、ほかのデータは進める（学習が壊れていても顧客の手直しは同期する）。
//   ただしフォルダーそのものが見えない・許可が無いときは、何もせず投げる。
// ★まだ1つもファイルが無いフォルダーへは、**尋ねずに書き出さない**
//   （別のフォルダーを選んでしまったときに、いきなり中身を作らないため）。
import {
  type ImportReport,
  type SharedMergeReport,
  applySharedLedger,
  countCustomers,
  loadSharedCustomerEdits,
  loadSharedLedger,
  mergeSharedCustomerEdits,
  saveImport,
} from "@/lib/after/customer-store";
import { type ParsedImport, parseCustomerFile } from "@/lib/after/import";
import type { CustomerSource } from "@/lib/after/types";
import {
  type FolderFile,
  type SeenCustomerFiles,
  conflictingSources,
  decideLedgerImport,
  fileChanged,
  keepMarks,
  ledgerConflictText,
  ledgerImportedText,
  markOf,
  pickCustomerFiles,
} from "@/lib/shared/customer-files";
import {
  type ExampleKind,
  loadSharedExamples,
  mergeSharedStoredExamples,
} from "@/lib/examples-store";
import {
  type SharedCustomerEdits,
  mergeCustomerEdits,
  pickSharedCustomerEdits,
} from "@/lib/shared/customer-edits";
import {
  type SharedDataset,
  type SharedDatasetId,
  SHARED_DATASETS,
  SHARED_DATASET_IDS,
} from "@/lib/shared/datasets";
import {
  type SharedExamples,
  mergeSharedExamples,
  pickSharedExamples,
} from "@/lib/shared/examples";
import { type SharedFolder, sharedErrorText } from "@/lib/shared/folder";
import { type SharedLedger, ledgerCount, mergeSharedLedger, pickSharedLedger } from "@/lib/shared/ledger";
import { loadSeenCustomerFiles, saveLastSync, saveSeenCustomerFiles } from "@/lib/shared/store";

/** 学習した書き方の種類 → 共有フォルダーのファイル */
export const EXAMPLE_DATASETS: Readonly<Record<ExampleKind, SharedDatasetId>> = {
  inquiry: "examples-inquiry",
  inspection: "examples-inspection",
};

export const EXAMPLE_KINDS = Object.keys(EXAMPLE_DATASETS) as ExampleKind[];

/** 同期のときにブラウザの保存を触る口（テストでは差し替えられる） */
export interface SyncDeps {
  loadCustomerEdits: () => Promise<SharedCustomerEdits>;
  mergeCustomerEdits: (shared: SharedCustomerEdits) => Promise<SharedMergeReport>;
  loadExamples: (kind: ExampleKind) => Promise<SharedExamples>;
  mergeExamples: (kind: ExampleKind, incoming: SharedExamples) => Promise<SharedExamples>;
  saveLastSync: (at: number) => Promise<void>;
  /** 取り込み元ごとの、この端末の顧客の数（減らしていないかを見るため） */
  countBySource: () => Promise<Record<CustomerSource, number>>;
  /** ファイルを取り込んでブラウザへ保存する */
  saveImport: (parsed: ParsedImport) => Promise<ImportReport>;
  loadSeenCustomerFiles: () => Promise<SeenCustomerFiles>;
  saveSeenCustomerFiles: (seen: SeenCustomerFiles) => Promise<void>;
  /** この端末の台帳（取り込み値そのもの） */
  loadLedger: () => Promise<SharedLedger>;
  applyLedger: (ledger: SharedLedger) => Promise<ImportReport[]>;
}

export const DEFAULT_SYNC_DEPS: SyncDeps = {
  loadCustomerEdits: loadSharedCustomerEdits,
  mergeCustomerEdits: mergeSharedCustomerEdits,
  loadExamples: loadSharedExamples,
  mergeExamples: mergeSharedStoredExamples,
  saveLastSync,
  countBySource: async () => (await countCustomers()).bySource,
  saveImport,
  loadSeenCustomerFiles,
  saveSeenCustomerFiles,
  loadLedger: loadSharedLedger,
  applyLedger: applySharedLedger,
};

/** この端末にあって、まだフォルダーに出していないかもしれない分の件数（初回の確認に出す） */
export interface SharedPending {
  customers: number;
  examples: Record<ExampleKind, number>;
}

/** 共有フォルダーの顧客ファイルを取り込んだ結果 */
export interface LedgerReport {
  /** 取り込めたファイルの1行（画面にそのまま出す） */
  imported: string[];
  /** 減るので確かめてもらうもの。ボタンを押すと取り込む */
  pending: { file: string; text: string }[];
  /** 顧客データとして読めなかったファイル（ほかのファイルが置いてあるだけのことが多い） */
  skipped: { file: string; message: string }[];
  /** 同じ取り込み元のファイルが2つ以上あって、どれを使うか決められない */
  conflicts: string[];
}

/** 顧客データの台帳（取り込み値そのもの）の同期 */
export interface LedgerSyncReport {
  /** 共有フォルダーにある台帳の件数 */
  count: number;
  /** この端末へ取り込んだ件数（追加＋更新） */
  applied: number;
  written: boolean;
}

export interface SyncFailure {
  dataset: SharedDatasetId;
  label: string;
  message: string;
}

export interface SyncReport {
  at: number;
  /**
   * フォルダーにまだ1つもファイルが無いので、**何も書かずに止めた**。
   * 画面で「このフォルダーへ書き出す」を押してもらってから、もう一度呼ぶ。
   */
  awaitingFirstWrite: boolean;
  /** この端末にある共有対象の件数 */
  pending: SharedPending;
  customers: { applied: number; unmatched: number; written: boolean };
  examples: Record<ExampleKind, { count: number; written: boolean }>;
  /** 共有フォルダーに置いた顧客データのファイル（xlsx / csv からの取り込み） */
  ledger: LedgerReport;
  /** 顧客データの台帳そのもの（共有フォルダーの 顧客データ.json） */
  customerLedger: LedgerSyncReport;
  /** 読めなかった・書けなかったデータ（ほかは進めている） */
  failures: SyncFailure[];
}

export interface SyncOptions {
  now?: number;
  /**
   * まだ1つもファイルが無いフォルダーへ、この端末の分を書き出してよいか。
   * ★既定は false（利用者がボタンで確かめてから書く）。
   */
  allowFirstWrite?: boolean;
  /**
   * 共有フォルダーの顧客ファイルを取り込むと件数が減る場合でも、取り込んでよいか。
   * ★既定は false（利用者がボタンで確かめてから入れ替える）。
   */
  allowLedgerReplace?: boolean;
  deps?: SyncDeps;
}

/** そのフォルダーに共有データがもう置かれているか */
export async function hasAnySharedData(folder: SharedFolder): Promise<boolean> {
  for (const id of SHARED_DATASET_IDS) {
    if (await folder.hasDataset(SHARED_DATASETS[id])) return true;
  }
  return false;
}

const emptyExamples = <T,>(make: () => T): Record<ExampleKind, T> =>
  Object.fromEntries(EXAMPLE_KINDS.map((kind) => [kind, make()])) as Record<ExampleKind, T>;

/**
 * 1回分の同期。
 * ★フォルダーが見えない・許可が無いときはここで投げる（画面につなぎ直しを出す）。
 */
export async function syncShared(
  folder: SharedFolder,
  options: SyncOptions = {},
): Promise<SyncReport> {
  const now = options.now ?? Date.now();
  const deps = options.deps ?? DEFAULT_SYNC_DEPS;
  // ★フォルダーそのものが使えるか。ここで落ちたら、以降は全部落ちるので投げる
  await folder.probe();
  // ★共有データを入れるフォルダーを決める（前の形のファイルが直下にあれば、ここで移す）
  await folder.ensureDataDir();

  // ★台帳を先に取り込む。手直しはそのあとで当てる（新しい台帳の上に乗せるため）
  const ledger = await importLedgerFiles(folder, deps, options.allowLedgerReplace ?? false);

  const [mineCustomers, mineExamples] = await Promise.all([
    deps.loadCustomerEdits(),
    Promise.all(EXAMPLE_KINDS.map((kind) => deps.loadExamples(kind))),
  ]);
  const byKind = Object.fromEntries(
    EXAMPLE_KINDS.map((kind, i) => [kind, mineExamples[i]]),
  ) as Record<ExampleKind, SharedExamples>;
  const pending: SharedPending = {
    customers: Object.keys(mineCustomers).length,
    examples: Object.fromEntries(
      EXAMPLE_KINDS.map((kind) => [kind, byKind[kind].items.length]),
    ) as Record<ExampleKind, number>,
  };

  const report: SyncReport = {
    at: now,
    awaitingFirstWrite: false,
    pending,
    customers: { applied: 0, unmatched: 0, written: false },
    examples: emptyExamples(() => ({ count: 0, written: false })),
    ledger,
    customerLedger: { count: 0, applied: 0, written: false },
    failures: [],
  };

  if (!options.allowFirstWrite && !(await hasAnySharedData(folder))) {
    // ★まだ空のフォルダー。尋ねずには書き出さない（読むものも無いので、ここで返す）
    report.awaitingFirstWrite = true;
    return report;
  }

  const fail = (dataset: SharedDataset, error: unknown) => {
    report.failures.push({
      dataset: dataset.id,
      label: dataset.label,
      message: sharedErrorText(error),
    });
  };

  // ---- 顧客データの台帳（★手直しより先。新しい台帳の上に手直しを乗せる） ----
  const ledgerDataset = SHARED_DATASETS["customer-ledger"];
  try {
    const mineLedger = await deps.loadLedger();
    const result = await folder.update(
      ledgerDataset,
      pickSharedLedger,
      (current) => (current ? mergeSharedLedger(current, mineLedger) : mineLedger),
      now,
    );
    const applied = await deps.applyLedger(result.items);
    report.customerLedger = {
      count: ledgerCount(result.items),
      applied: applied.reduce((n, r) => n + r.added + r.updated, 0),
      written: result.written,
    };
  } catch (e) {
    fail(ledgerDataset, e);
  }

  // ---- 顧客の手直し ----
  const editsDataset = SHARED_DATASETS["customer-edits"];
  try {
    const result = await folder.update(
      editsDataset,
      pickSharedCustomerEdits,
      (current) => (current ? mergeCustomerEdits(current, mineCustomers) : mineCustomers),
      now,
    );
    const merged = await deps.mergeCustomerEdits(result.items);
    report.customers = {
      applied: merged.applied,
      unmatched: merged.unmatched.length,
      written: result.written,
    };
  } catch (e) {
    fail(editsDataset, e);
  }

  // ---- 学習した書き方（アフター・定期点検） ----
  for (const kind of EXAMPLE_KINDS) {
    const dataset = SHARED_DATASETS[EXAMPLE_DATASETS[kind]];
    try {
      const mine = byKind[kind];
      const result = await folder.update(
        dataset,
        pickSharedExamples,
        (current) => (current ? mergeSharedExamples(current, mine) : mine),
        now,
      );
      const merged = await deps.mergeExamples(kind, result.items);
      report.examples[kind] = { count: merged.items.length, written: result.written };
    } catch (e) {
      fail(dataset, e);
    }
  }

  // ★1つでも通っていれば「同期できた」として日時を残す（全部だめなら残さない）
  if (report.failures.length < SHARED_DATASET_IDS.length) await deps.saveLastSync(now);
  return report;
}

/**
 * 共有フォルダーに置いた顧客データのファイルを取り込む（**読むだけ。フォルダーには書かない**）。
 *
 * ★2人目が同じ xlsx を手で取り込まなくて済むようにするための段。
 *   手で取り込む道（ドラッグ＆ドロップ）は今までどおり残っている。
 * ★変わっていないファイルは読まない（数千件の取り込みは重い）。
 * ★顧客データでないファイルが置いてあっても、飛ばして先へ進む。
 */
async function importLedgerFiles(
  folder: SharedFolder,
  deps: SyncDeps,
  allowReplace: boolean,
): Promise<LedgerReport> {
  const out: LedgerReport = { imported: [], pending: [], skipped: [], conflicts: [] };
  let files: FolderFile[];
  try {
    files = pickCustomerFiles(await folder.store.listFiles(folder.dir));
  } catch {
    // 一覧を読めないときは、この段を飛ばす（手直しの同期は続ける）
    return out;
  }
  const seen = await deps.loadSeenCustomerFiles();
  // ★フォルダーから消えたファイルの印は落とす。顧客は消さない
  let next = keepMarks(seen, files);
  const changed = files.filter((file) => fileChanged(seen, file));
  if (changed.length === 0) {
    if (Object.keys(next).length !== Object.keys(seen).length) await deps.saveSeenCustomerFiles(next);
    return out;
  }

  // ★先に全部読んで、取り込み元を出しそろえる。**同じ取り込み元が2つ**あるまま
  //   取り込むと、名前の順でどちらが勝つかが決まってしまい、置き間違いに気づけない
  const ready: { file: FolderFile; parsed: ParsedImport }[] = [];
  for (const file of changed) {
    try {
      ready.push({
        file,
        parsed: parseCustomerFile(await folder.store.readBytes([...folder.dir, file.name]), file.name),
      });
    } catch (e) {
      // 顧客データでないファイル（ほかの書類が置いてあるだけ）。印は付けずに飛ばす
      out.skipped.push({ file: file.name, message: e instanceof Error ? e.message : String(e) });
    }
  }
  // 変わっていないファイルの取り込み元は、前に取り込んだときの印から分かる（読み直さない）
  const known = files
    .map((file) => ({ name: file.name, source: seen[file.name]?.source }))
    .filter((e): e is { name: string; source: CustomerSource } => e.source !== undefined)
    .filter((e) => !ready.some((r) => r.file.name === e.name));
  const conflicts = conflictingSources([
    ...known,
    ...ready.map((r) => ({ name: r.file.name, source: r.parsed.source })),
  ]);
  const blocked = new Set(conflicts.map((c) => c.source));
  for (const conflict of conflicts) out.conflicts.push(ledgerConflictText(conflict.source, conflict.files));

  const bySource = await deps.countBySource();
  for (const { file, parsed } of ready) {
    // ★どれを使うか決められない取り込み元は、1つも取り込まない（黙って片方を選ばない）
    if (blocked.has(parsed.source)) continue;
    const decision = decideLedgerImport({
      source: parsed.source,
      fileName: file.name,
      existing: bySource[parsed.source] ?? 0,
      incoming: parsed.customers.length,
      confirmed: allowReplace,
    });
    if (decision.kind === "ask") {
      out.pending.push({ file: file.name, text: decision.text });
      continue;
    }
    const report = await deps.saveImport(parsed);
    bySource[parsed.source] = report.added + report.updated + Math.max(0, (bySource[parsed.source] ?? 0) - report.removed);
    out.imported.push(
      ledgerImportedText({
        fileName: file.name,
        source: parsed.source,
        added: report.added,
        updated: report.updated,
        removed: report.removed,
      }),
    );
    next = { ...next, [file.name]: markOf(file, parsed.source, seen[file.name]?.mine) };
  }
  await deps.saveSeenCustomerFiles(next);
  return out;
}
