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
import { FolderError, type FolderStore } from "./fs";
import { type RunAuth, type RunHandle, startRun } from "./job";
import { LOCAL_KINDS, PENDING_MERGED_NAME, RUN_LIMITS } from "./kind-config";
import { type StatsCache, buildListItems, memoryStatsCache } from "./list";
import { PendingError } from "./manifest";
import { completePending, recomposeSaved } from "./pending-ops";
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
  if (e instanceof RecordNotFoundError) return new TenmatsuError("notFound", null, e.message);
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

    list: async () => await guard(() => buildListItems(store, cfg, cache)),

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
  };
}
