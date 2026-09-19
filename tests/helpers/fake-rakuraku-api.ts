import type {
  AttachmentRequest,
  FetchRequest,
  KindId,
  ReceivedFile,
  RouteHow,
  RouteId,
  RouteScope,
  ScanRequest,
  ScanTarget,
  SurveyReport,
} from "@/lib/rakuraku/protocol";
import { type FetchResult, RakurakuApiError, type RakurakuApi, type ScanResult, type StreamHandlers } from "@/lib/tenmatsu/local/server-api";

/**
 * 台本どおりに答える作り物の「Folio のサーバー」。楽楽精算にも HTTP にも触らない。
 * 呼ばれた順と中身を calls に残すので、「ログインは1回だけ」「保留中も対象から外した」などを確かめられる。
 */
export type FetchScript = FetchResult | RakurakuApiError | ((request: FetchRequest) => FetchResult | RakurakuApiError);

export interface FakeApiScript {
  /** ログインの結果。省略すると成功（トークンは token-1, token-2 … と増える） */
  login?: (userId: string, password: string, count: number) => RakurakuApiError | null;
  scan?: ScanResult | RakurakuApiError | ((request: ScanRequest, count: number) => ScanResult | RakurakuApiError);
  /** 伝票No.ごとの答え。配列なら呼ばれるたびに先頭から使う */
  fetch?: Record<string, FetchScript | FetchScript[]>;
  attachment?: (request: AttachmentRequest) => ReceivedFile | RakurakuApiError;
  /** 画面の下見の結果 */
  survey?: SurveyReport | RakurakuApiError;
  /** 流れてくる進捗の行 */
  logs?: string[];
  /** 一覧を開けた経路（scan / fetch のときに流す） */
  route?: { kind: KindId; route: RouteId; label: string; scope: RouteScope; how: RouteHow };
}

/** 中身の無い下見の結果（既定） */
const EMPTY_SURVEY: SurveyReport = {
  at: "2026-09-19 00:00:00",
  home: { path: "/", title: "", frames: [] },
  department: { hasSelect: false, count: 0, applied: null, message: null },
  menus: [],
  afterWorkflow: [],
  lists: [],
  clicked: [],
  probes: [],
  details: [],
  notes: [],
};

export interface FakeApi extends RakurakuApi {
  calls: { method: string; request?: unknown }[];
}

export function file(role: ReceivedFile["role"], index: number, name: string, ext: string, bytes: Uint8Array): ReceivedFile {
  return { role, index, name, ext, bytes };
}

export function target(denpyoNo: string, meta: Record<string, string | null> = {}): ScanTarget {
  return { denpyoNo, href: `https://example.test/abcd/workflowDetailView?eDenpyoNo=${denpyoNo}`, meta };
}

export function scanOf(items: ScanTarget[], extra: Partial<ScanResult> = {}): ScanResult {
  return { items, scanned: items.length, pages: 1, total: items.length, last: items.length, stoppedEarly: false, reason: null, department: null, ...extra };
}

export function createFakeApi(script: FakeApiScript): FakeApi {
  const calls: FakeApi["calls"] = [];
  let logins = 0;
  let scans = 0;
  const fetchCounts = new Map<string, number>();
  const emit = (handlers?: StreamHandlers) => {
    for (const line of script.logs ?? []) handlers?.log?.(line);
    if (script.route) handlers?.route?.(script.route);
    handlers?.session?.(`refreshed-${calls.length}`);
  };

  return {
    calls,
    login: async (userId, password) => {
      logins += 1;
      calls.push({ method: "login", request: { userId } });
      const error = script.login?.(userId, password, logins) ?? null;
      if (error) throw error;
      return { sessionToken: `token-${logins}`, expiresAt: null };
    },
    departments: async () => {
      calls.push({ method: "departments" });
      return { departments: [], current: null, sessionToken: "token-d", expiresAt: null };
    },
    survey: async (request, handlers) => {
      calls.push({ method: "survey", request });
      emit(handlers);
      if (script.survey instanceof RakurakuApiError) throw script.survey;
      return script.survey ?? EMPTY_SURVEY;
    },
    scan: async (request, handlers) => {
      scans += 1;
      calls.push({ method: "scan", request });
      const answer = typeof script.scan === "function" ? script.scan(request, scans) : (script.scan ?? scanOf([]));
      if (answer instanceof RakurakuApiError) throw answer;
      emit(handlers);
      return answer;
    },
    fetch: async (request, handlers) => {
      calls.push({ method: "fetch", request });
      const entry = script.fetch?.[request.denpyoNo];
      if (!entry) throw new Error(`台本に無い伝票です: ${request.denpyoNo}`);
      const count = fetchCounts.get(request.denpyoNo) ?? 0;
      fetchCounts.set(request.denpyoNo, count + 1);
      const step = Array.isArray(entry) ? entry[Math.min(count, entry.length - 1)] : entry;
      const answer = typeof step === "function" ? step(request) : step;
      if (answer instanceof RakurakuApiError) throw answer;
      emit(handlers);
      return answer;
    },
    attachment: async (request, handlers) => {
      calls.push({ method: "attachment", request });
      const answer = script.attachment?.(request) ?? new RakurakuApiError("ATTACHMENT_FAILED", "台本に無い添付です");
      if (answer instanceof RakurakuApiError) throw answer;
      emit(handlers);
      return answer;
    },
  };
}
