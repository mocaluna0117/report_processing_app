/**
 * 選んだ PC のフォルダーを使う `TenmatsuClient`（新方式）。
 *
 * 旧方式（`createTenmatsuClient`: PC で動く Python のローカルサーバー）と**同じ約束**で動くので、
 * 画面はどちらのクライアントかを気にせずに使える。
 *   - 楽楽精算からの取得 … Folio のサーバー（`/api/rakuraku/*`）
 *   - 結合・保存・記録 … このブラウザの中（選んだフォルダーへ書く。Folio のサーバーには残さない）
 *
 * ★取得中は、保留の確定・差し替え・取りやめを断る（記録と部品の書き換えが重なるため。移植元と同じ）。
 * ★同じページの中で取得は1本だけ（別の種類が走っていても断る）。
 */
import type { KindId } from "@/lib/rakuraku/kinds";
import type { RouteId } from "@/lib/rakuraku/protocol";
import {
  type FlagUpdate,
  type HealthPayload,
  type ListItem,
  type PendingFile,
  type PendingUpload,
  type RunOptions,
  type RunResult,
  type StatusPayload,
  type TenmatsuClient,
  EMPTY_FLAGS_MESSAGE,
  EMPTY_PENDING_FILES_MESSAGE,
  RUN_COUNT_FORMAT_MESSAGE,
  TenmatsuError,
} from "@/lib/tenmatsu/client";
import { createHashMemo } from "./fingerprint";
import { FolderError, type FolderStore } from "./fs";
import { ImportError, type ImportSummary, importRecords, previewImport } from "./import";
import { type RunAuth, type RunHandle, startRun } from "./job";
import { LOCAL_KINDS, PENDING_MERGED_NAME, RUN_LIMITS } from "./kind-config";
import { type StatsCache, buildListItems, memoryStatsCache } from "./list";
import { PendingError } from "./manifest";
import { completePending, recomposeSaved } from "./pending-ops";
import {
  type BackfillTarget,
  type RelinkCandidate,
  RelinkError,
  applyRelinks,
  otherKindClaims,
  planBackfill,
  planRelinks,
  relinkCandidates,
  relinkRecord,
  renamePrefix,
  runBackfill,
} from "./relink";
import { RecordNotFoundError, RecordsCorruptError, pendingDirPath, readRecords, retryPending, setFlags } from "./records";
import type { RakurakuApi } from "./server-api";

/** このページの中で走っている取得（種類をまたいで1本） */
let activeRun: { kind: KindId; handle: RunHandle } | null = null;

/** このページの中で取得が走っているか（種類を渡すとその種類だけ） */
export function hasActiveRun(kind?: KindId): boolean {
  if (!activeRun || activeRun.handle.snapshot().state !== "running") return false;
  return kind === undefined || activeRun.kind === kind;
}

/** 走っている取得の種類（無ければ null） */
export function activeRunKind(): KindId | null {
  return hasActiveRun() ? activeRun!.kind : null;
}

/** テスト用。走っている取得の控えを消す */
export function resetActiveRun(): void {
  activeRun = null;
}

export interface LocalFolderClientOptions {
  kind: KindId;
  store: FolderStore;
  api: RakurakuApi;
  auth: RunAuth;
  /** 部門の値。取得のたびに読む（画面で選び直せるように） */
  deptCode(): string | null;
  /** 一覧の経路の固定。取得のたびに読む（画面で選び直せるように）。null なら自動 */
  routePin?(): RouteId | null;
  statsCache?: StatsCache;
  now?: () => Date;
  requestIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type LocalFolderClient = TenmatsuClient & {
  /** 取得の状態が変わるたびに呼ばれる（ポーリングの代わり）。戻り値で購読をやめる */
  subscribe(listener: (status: StatusPayload) => void): () => void;
  /** いまの伝票が終わったら止める */
  abort(): void;
  /** 今までの方式の記録を取り込むとどうなるかを、書かずに調べる */
  previewImport(text: string): Promise<ImportSummary>;
  /** 今までの方式の記録を取り込む。★取得中は断る */
  importRecords(text: string): Promise<ImportSummary>;
  /**
   * 一覧を読み、名前を変えられたPDFを中身で見つけたら記録を今の名前に結び直す。
   * relinked は結び直した分（画面で「つなぎ直しました」と伝える）。
   */
  listWithRelinks(): Promise<{ items: ListItem[]; relinked: { denpyoNo: string; from: string; to: string }[] }>;
  /** 以前の記録に中身の指紋を付ける（裏で少しずつ。取得中はやらない） */
  backfillFingerprints(): Promise<{ written: number; remaining: number }>;
  /** 「ファイルなし」の伝票について、選べるPDF（どの記録にも使われていない、保存先の直下のPDF） */
  relinkCandidates(denpyoNo: string): Promise<RelinkCandidate[]>;
  /** 選んだPDFをその伝票に結ぶ。★取得中は断る */
  relinkFile(denpyoNo: string, name: string): Promise<ListItem | null>;
  /** 選ぶ候補のPDFの中身（どの記録にも使われていない直下のPDFだけ読める） */
  candidatePdf(denpyoNo: string, name: string): Promise<Blob>;
  /** 以前の保存名（「顛末書No.1476.pdf」）を、いまの表記（「顛末書№1476.pdf」）に直す。★取得中は断る */
  renameLegacyNames(): Promise<{ renamed: number; skipped: { denpyoNo: string; reason: string }[] }>;
};

const IDLE: StatusPayload = {
  state: "idle",
  done: 0,
  total: 0,
  current: null,
  message: "",
  error: null,
  error_file: null,
  processed: 0,
  remaining: 0,
  saved: [],
  log_seq: 0,
};

/** フォルダー版の失敗を、画面が知っている形（TenmatsuError）に直す */
export function toTenmatsuError(e: unknown): TenmatsuError {
  if (e instanceof TenmatsuError) return e;
  if (e instanceof FolderError) {
    const kind =
      e.kind === "conflict"
        ? "conflict"
        : e.kind === "permission"
          ? "permission"
          : e.kind === "folderMissing"
            ? "folderMissing"
            : e.kind === "notFound"
              ? "notFound"
              : e.kind === "invalidName"
                ? "badRequest"
                : "unknown";
    return new TenmatsuError(kind, null, e.message);
  }
  if (e instanceof PendingError) {
    const kind = e.kind === "invalid" || e.kind === "mergeFailed" ? "badRequest" : "notFound";
    return new TenmatsuError(kind, null, e.message);
  }
  if (e instanceof RelinkError) {
    const kind =
      e.kind === "invalid" ? "badRequest" : e.kind === "notFound" || e.kind === "notSaved" ? "notFound" : "conflict";
    return new TenmatsuError(kind, null, e.message);
  }
  if (e instanceof RecordNotFoundError) return new TenmatsuError("notFound", null, e.message);
  if (e instanceof ImportError) return new TenmatsuError("badRequest", null, e.message);
  if (e instanceof RecordsCorruptError) return new TenmatsuError("server", null, e.message);
  return new TenmatsuError("unknown", null, e instanceof Error ? e.message : String(e));
}

const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    throw toTenmatsuError(e);
  }
};

export function createLocalFolderClient(options: LocalFolderClientOptions): LocalFolderClient {
  const cfg = LOCAL_KINDS[options.kind];
  const { store } = options;
  const cache = options.statsCache ?? memoryStatsCache();

  const mine = () => (activeRun?.kind === options.kind ? activeRun.handle : null);
  const running = () => activeRun !== null && activeRun.handle.snapshot().state === "running";

  /** 取得中は、記録と部品を書き換える操作を断る */
  const refuseWhileRunning = () => {
    if (running()) {
      throw new TenmatsuError("conflict", null, "取得中は添付を結合できません。取得が終わってから操作してください");
    }
  };

  /** 中身のハッシュの覚え書き（同じファイルを何度も読まない） */
  const memo = createHashMemo();
  /** 直前の一覧で見つけた、指紋を付けたい記録 */
  let backfillTargets: BackfillTarget[] = [];
  let backfillRun: Promise<{ written: number; remaining: number }> | null = null;

  const listWithRelinks = async () => {
    let records = await readRecords(store, cfg);
    let items = await buildListItems(store, cfg, cache, records);
    const relinked: { denpyoNo: string; from: string; to: string }[] = [];
    const missing = items.filter((i) => !i.pending && !i.exists).map((i) => i.denpyo_no);
    // ★取得中は結び直さない（保存して記録するまでの間と重ならないように。終われば一覧を読み直す）
    if (missing.length > 0 && !running()) {
      try {
        const plan = await planRelinks(store, cfg, records, missing, {
          memo,
          otherClaims: await otherKindClaims(store, cfg),
        });
        const applied = await applyRelinks(store, cfg, plan.relinks, options.now?.() ?? new Date());
        if (applied.length > 0) {
          relinked.push(...applied.map((r) => ({ denpyoNo: r.denpyoNo, from: r.from, to: r.to })));
          records = await readRecords(store, cfg);
          items = await buildListItems(store, cfg, cache, records);
        }
      } catch {
        // 結び直しに失敗しても一覧は出す（「ファイルなし」のまま。手で選び直せる）
      }
    }
    backfillTargets = planBackfill(records, cfg, items);
    return { items, relinked };
  };

  const findItem = async (denpyoNo: string): Promise<ListItem | null> =>
    (await buildListItems(store, cfg, cache)).find((item) => item.denpyo_no === denpyoNo) ?? null;

  return {
    health: async (): Promise<HealthPayload> =>
      await guard(async () => {
        await store.probe();
        return {
          ok: true,
          service: "folio-folder",
          version: 1,
          save_dir: store.name,
          job_state: activeRun?.handle.snapshot().state ?? "idle",
          job_kind: activeRun?.kind ?? null,
          kind: options.kind,
          max_per_run: RUN_LIMITS.value,
          max_per_run_min: RUN_LIMITS.min,
          max_per_run_max: RUN_LIMITS.max,
          kinds: [
            {
              kind: cfg.id,
              label: cfg.label,
              flag_keys: [...cfg.flagKeys],
              file_prefix: cfg.filePrefix,
              save_dir: store.name,
              keep_parts: cfg.keepParts,
            },
          ],
        };
      }),

    status: async (since) => mine()?.snapshot(since) ?? { ...IDLE, kind: options.kind, ...(since === undefined ? {} : { log: [] }) },

    list: async () => await guard(async () => (await listWithRelinks()).items),

    run: async (runOptions: RunOptions = {}): Promise<RunResult> => {
      const limit = runOptions.maxPerRun ?? RUN_LIMITS.value;
      if (!Number.isInteger(limit)) throw new TenmatsuError("badRequest", null, RUN_COUNT_FORMAT_MESSAGE);
      // ★範囲外は丸めずに断る（黙って件数を変えない）
      if (limit < RUN_LIMITS.min || limit > RUN_LIMITS.max) {
        throw new TenmatsuError("badRequest", null, `1回に取る件数は ${RUN_LIMITS.min}〜${RUN_LIMITS.max} で指定してください`);
      }
      if (running()) {
        return { started: false, status: activeRun!.handle.snapshot(), maxPerRun: null, headless: null };
      }
      // 始める前にフォルダーが使えるか確かめる（許可が無いまま楽楽精算に触らない）
      await guard(() => store.probe());
      const handle = startRun(
        {
          store,
          cfg,
          api: options.api,
          auth: options.auth,
          deptCode: options.deptCode(),
          routePin: options.routePin?.() ?? null,
          now: options.now,
          sleep: options.sleep,
          requestIntervalMs: options.requestIntervalMs,
        },
        { limit },
      );
      activeRun = { kind: options.kind, handle };
      return { started: true, status: handle.snapshot(), maxPerRun: limit, headless: true };
    },

    setFlags: async (denpyoNo: string, flags: FlagUpdate) =>
      await guard(async () => {
        const update = Object.fromEntries(Object.entries(flags).filter(([, v]) => typeof v === "boolean"));
        if (Object.keys(update).length === 0) throw new TenmatsuError("badRequest", null, EMPTY_FLAGS_MESSAGE);
        const records = await readRecords(store, cfg);
        if (records.pending[denpyoNo]) {
          throw new TenmatsuError("conflict", null, "保留中の伝票には印を付けられません（先に確定してください）");
        }
        await setFlags(store, cfg, denpyoNo, update, options.now?.());
        return await findItem(denpyoNo);
      }),

    completePending: async (denpyoNo: string, upload: PendingUpload) =>
      await guard(async () => {
        refuseWhileRunning();
        if (upload.files.length === 0 && !upload.acceptMissing && !upload.slots?.length) {
          throw new TenmatsuError("badRequest", null, EMPTY_PENDING_FILES_MESSAGE);
        }
        await completePending(store, cfg, denpyoNo, upload, options.now?.());
        return await findItem(denpyoNo);
      }),

    retryPending: async (denpyoNo: string) =>
      await guard(async () => {
        refuseWhileRunning();
        await retryPending(store, cfg, denpyoNo);
      }),

    recomposePending: async (denpyoNo: string, files: PendingFile[], slots: number[]) =>
      await guard(async () => {
        refuseWhileRunning();
        await recomposeSaved(store, cfg, denpyoNo, files, slots, options.now?.());
        return await findItem(denpyoNo);
      }),

    filePdf: async (denpyoNo: string) =>
      await guard(async () => {
        const records = await readRecords(store, cfg);
        const held = records.pending[denpyoNo];
        let path: string[];
        if (held) {
          path = [...pendingDirPath(held.dir || denpyoNo), PENDING_MERGED_NAME];
        } else {
          const item = (await buildListItems(store, cfg, cache, records)).find((i) => i.denpyo_no === denpyoNo && !i.pending);
          if (!item) throw new TenmatsuError("notFound", null, `伝票 ${denpyoNo} の記録がありません`);
          // ★見つからないPDFは開かない（名前を変えた場合は「PDFを選ぶ」で結び直してもらう）
          if (!item.exists) {
            throw new TenmatsuError(
              "notFound",
              null,
              `保存先に「${item.file}」が見つかりません。名前を変えた場合は、一覧の「PDFを選ぶ」で選び直してください`,
            );
          }
          path = [item.file];
        }
        const bytes = await store.readBytes(path);
        return new Blob([bytes as BlobPart], { type: "application/pdf" });
      }),

    subscribe: (listener) => {
      const handle = mine();
      return handle ? handle.subscribe(listener) : () => undefined;
    },

    abort: () => {
      mine()?.abort();
    },

    previewImport: async (text: string) => await guard(() => previewImport(store, cfg, text)),

    listWithRelinks: async () => await guard(listWithRelinks),

    backfillFingerprints: async () => {
      // 同時に2本走らせない（2回目の呼び出しには同じ結果を返す）
      if (backfillRun) return await backfillRun;
      backfillRun = (async () => {
        let written = 0;
        try {
          while (backfillTargets.length > 0 && !running()) {
            const batch = backfillTargets;
            const result = await runBackfill(store, cfg, batch, memo, { shouldStop: running });
            written += result.written;
            if (result.processed === 0) break;
            backfillTargets = batch.slice(result.processed);
            // 画面の操作を止めないよう、1回ごとに手を離す
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        } catch {
          // 指紋の後付けは急がない。失敗しても次に一覧を読んだときにやり直す
        } finally {
          backfillRun = null;
        }
        return { written, remaining: backfillTargets.length };
      })();
      return await backfillRun;
    },

    relinkCandidates: async (denpyoNo: string) => await guard(() => relinkCandidates(store, cfg, denpyoNo, memo)),

    relinkFile: async (denpyoNo: string, name: string) =>
      await guard(async () => {
        if (running()) {
          throw new TenmatsuError("conflict", null, "取得中はPDFを選び直せません。取得が終わってから操作してください");
        }
        await relinkRecord(store, cfg, denpyoNo, name, memo, options.now?.() ?? new Date());
        return await findItem(denpyoNo);
      }),

    candidatePdf: async (denpyoNo: string, name: string) =>
      await guard(async () => {
        // ★選べる候補のPDFだけを読む（ほかの記録のPDFや、フォルダーの中は読まない）
        const candidates = await relinkCandidates(store, cfg, denpyoNo, memo);
        if (!candidates.some((c) => c.name === name)) {
          throw new TenmatsuError("notFound", null, `「${name}」は選べるPDFではありません`);
        }
        const bytes = await store.readBytes([name]);
        return new Blob([bytes as BlobPart], { type: "application/pdf" });
      }),

    renameLegacyNames: async () =>
      await guard(async () => {
        if (running()) {
          throw new TenmatsuError("conflict", null, "取得中は保存名を直せません。取得が終わってから操作してください");
        }
        const result = await renamePrefix(store, cfg, options.now?.() ?? new Date());
        return { renamed: result.renamed.length, skipped: result.skipped };
      }),

    importRecords: async (text: string) =>
      await guard(async () => {
        if (running()) {
          throw new TenmatsuError("conflict", null, "取得中は記録を取り込めません。取得が終わってから操作してください");
        }
        return await importRecords(store, cfg, text);
      }),
  };
}
