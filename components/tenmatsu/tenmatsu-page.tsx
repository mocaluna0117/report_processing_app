"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StorageBanner } from "@/components/storage-banner";
import { TenmatsuList } from "@/components/tenmatsu/tenmatsu-list";
import { TenmatsuPreviewDialog } from "@/components/tenmatsu/tenmatsu-preview-dialog";
import { TenmatsuStaffSync } from "@/components/tenmatsu/tenmatsu-staff-sync";
import { setNavigationGuard } from "@/lib/navigation-guard";
import { isStorageAvailable } from "@/lib/storage";
import {
  type FlagKey,
  type FlagUpdate,
  type HealthPayload,
  type ListItem,
  type StatusPayload,
  TENMATSU_BASE_URL,
  TOKEN_FORMAT_MESSAGE,
  TenmatsuError,
  createTenmatsuClient,
  describeCompletion,
  isFinished,
  isValidToken,
} from "@/lib/tenmatsu/client";
import { type ListFilter, resolvePerRun } from "@/lib/tenmatsu/list-view";
import {
  DOC_KIND_BY_ID,
  type DocKindId,
  clearListConfirmText,
  clearedNoticeText,
  findHealthKind,
  flagErrorText,
  supportsKind,
  unsupportedServerText,
} from "@/lib/tenmatsu/kinds";
import { type Connection, getSession, keepSession, shareToken } from "@/lib/tenmatsu/session";
import {
  clearCachedList,
  clearToken,
  hasTenmatsuData,
  loadCachedList,
  loadMaxPerRun,
  loadToken,
  saveCachedList,
  saveMaxPerRun,
  saveToken,
} from "@/lib/tenmatsu/store";
import { usePersistence } from "@/lib/use-persistence";

/** 進捗を取りに行く間隔 */
const POLL_MS = 2000;
/** 何回続けて進捗を取れなかったら諦めるか (一時的な失敗では止めない) */
const POLL_FAILURE_LIMIT = 5;

/** サーバーがPDFに変換できる添付。サーバーのエラー文と同じ並び・同じ表記にしてある */
const SUPPORTED_ATTACHMENTS =
  "PDF, JPG, JPEG, PNG, TXT, XLSX, XLS, XLSM, DOCX, DOC, PPTX, PPT, MSG";

const SECTION_CLASS = "rounded-lg border border-slate-200 bg-white p-4";
const SUBTITLE_CLASS = "ml-2 text-xs font-normal text-slate-500";
const PRIMARY_BUTTON_CLASS =
  "rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY_BUTTON_CLASS =
  "rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const ERROR_CLASS =
  "mt-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800";
const WARN_CLASS =
  "mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function TenmatsuPage({ kind: kindId }: { kind: DocKindId }) {
  // 種類の設定 (文言・列・完了の印・保存先のキー)。
  // ページ (サーバーコンポーネント) からは種類の名前だけを受け取り、
  // ここで引く (設定には関数が入るので、そのままは渡せない)
  const kind = DOC_KIND_BY_ID[kindId];
  /**
   * 画面の状態は「このページ読み込み限りの控え」から始める。
   * タブを移動して戻ってきたときに、接続し直さずに続きから使えるようにするため
   * (詳しい理由は lib/tenmatsu/session.ts)。
   * 控えが空 = この読み込みで初めて開いた ＝ 未接続から始まる。
   */
  const kept = getSession(kind.id);
  const [token, setToken] = useState<string | null>(kept.token);
  const [tokenInput, setTokenInput] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [editingToken, setEditingToken] = useState(kept.editingToken);

  const [connection, setConnection] = useState<Connection>(kept.connection);
  const [health, setHealth] = useState<HealthPayload | null>(kept.health);
  const [connectionError, setConnectionError] = useState<string | null>(kept.connectionError);

  const [items, setItems] = useState<ListItem[]>(kept.items);
  /** この画面でサーバーから取り直したか (false なら前回このブラウザで見た内容) */
  const [listFresh, setListFresh] = useState(kept.listFresh);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [status, setStatus] = useState<StatusPayload | null>(kept.status);
  const [starting, setStarting] = useState(false);
  // 戻ってきたときは進捗の追いかけも再開する (タブを離れている間は止まる)
  const [polling, setPolling] = useState(kept.polling);
  /**
   * この画面で実行を始めた / 進行中の処理に合流したか。
   * /status の done は次の実行まで残るので、これが無いと画面を開いただけの人に
   * 前回の「10件を保存しました」が出てしまう。
   */
  const [runObserved, setRunObserved] = useState(kept.runObserved);
  const [runError, setRunError] = useState<string | null>(null);
  const [runNotice, setRunNotice] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  /**
   * 変更中のチェックがある行 (伝票No.)。応答は行まるごとなので行単位で止める。
   * 判定は ref を正にする (state の反映を待たずに「いま保存中か」を見たいため)。
   */
  const savingFlagsRef = useRef<ReadonlySet<string>>(new Set());
  const [savingFlags, setSavingFlags] = useState<ReadonlySet<string>>(new Set());
  const [flagError, setFlagError] = useState<string | null>(null);
  /**
   * この画面でチェックを変えた行。完了になっても次に一覧を読み直すまでは隠さない。
   * これが無いと2つ目にチェックを入れた瞬間に行が消えて、押し間違いを戻せない。
   * 表示の都合だけで、チェックの値は /list のもの。
   */
  const [recentNos, setRecentNos] = useState<ReadonlySet<string>>(kept.recentNos);
  const [showCompleted, setShowCompleted] = useState(kept.showCompleted);
  const [listFilter, setListFilter] = useState<ListFilter>(kept.listFilter);
  /** 1回に取る件数の下書き。数字かどうかは押したときに見る (入力中は弾かない) */
  const [maxInput, setMaxInput] = useState(kept.maxInput);
  /** 保存されていた件数 (null なら未保存)。/health と合わせて入力欄の初期値にする */
  const [storedMaxPerRun, setStoredMaxPerRun] = useState<number | null>(kept.storedMaxPerRun);
  const [listNotice, setListNotice] = useState<string | null>(null);
  /**
   * 「一覧を消去」で消した直後か。自動の取り直しを止めるために持つ
   * (消した瞬間に戻ってきたら、消したことにならない)。
   * 「接続する」と「一覧を再読み込み」で下ろす。
   */
  const clearedRef = useRef(kept.cleared);

  const [previewNo, setPreviewNo] = useState<string | null>(null);
  /** 案内に出す自分のURL (サーバーの許可オリジンに足してもらうため) */
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setOrigin(location.origin);
  }, []);

  // ★client は必ずここから作る。種類を取り違えると、別の種類の一覧を取って
  //   この種類のキャッシュへ上書きしてしまう
  const makeClient = useCallback(
    (value: string) =>
      createTenmatsuClient({ token: value, ...(kind.apiKind ? { kind: kind.apiKind } : {}) }),
    [kind.apiKind],
  );
  const client = useMemo(() => makeClient(token ?? ""), [makeClient, token]);
  const running = polling || starting;
  /**
   * PC側のツールがこの種類に未対応か。
   * ★未対応のときは /status も /list も叩かない。古いサーバーは kind を無視して
   *   顛末書の一覧を返すので、そのまま保存するとこの種類のキャッシュが汚れる。
   */
  const kindUnsupported = connection === "ok" && !supportsKind(kind, health);
  /** 別の種類の取得が動いているか (同時に1つしか走らせられない) */
  const foreignRun =
    status?.kind && status.kind !== kind.id && !isFinished(status.state) ? status.kind : null;
  const labelOf = (id: string) => findHealthKind(health, id)?.label ?? id;

  const storage = usePersistence({
    restore: async () => {
      // 戻ってきたときは控えがそのまま最新なので、IndexedDB からは読み直さない
      // (読み直すと listFresh が下りて、繋がっているのに印を押せなくなる)
      if (kept.hydrated) return { partialErrors: [] };
      const partialErrors: string[] = [];
      try {
        setToken(await loadToken());
      } catch (e) {
        partialErrors.push(`トークン: ${errorText(e)}`);
      }
      try {
        setItems(await loadCachedList(kind.id));
      } catch (e) {
        partialErrors.push(`取得済み一覧: ${errorText(e)}`);
      }
      try {
        setStoredMaxPerRun(await loadMaxPerRun(kind.id));
      } catch (e) {
        partialErrors.push(`取得件数: ${errorText(e)}`);
      }
      return { partialErrors };
    },
    hasSaved: () => hasTenmatsuData(kind.id),
  });

  /**
   * チェックの保存中に見送った「一覧の取り直し」を覚えておく。
   * 取得中もチェックできるので、実行の完了とチェックの保存が重なり得る。
   * 覚えておかないと、完了時の取り直しが1回きりで消えてしまう。
   */
  const pendingRefreshRef = useRef(false);

  /** 保存中の印を上げ下げする (ref と state の両方) */
  const markSaving = (no: string, on: boolean) => {
    const next = new Set(savingFlagsRef.current);
    if (on) next.add(no);
    else next.delete(no);
    savingFlagsRef.current = next;
    setSavingFlags(next);
  };

  const refreshList = async () => {
    // チェックの保存中に取り直すと、古い /list が新しい書き込みを上書きしてしまう。
    // 見送ったことを覚えておき、保存が終わってから取り直す
    if (savingFlagsRef.current.size > 0) {
      pendingRefreshRef.current = true;
      return;
    }
    pendingRefreshRef.current = false;
    clearedRef.current = false;
    setListLoading(true);
    setListError(null);
    setFlagError(null);
    try {
      const fresh = await client.list();
      setItems(fresh);
      setListFresh(true);
      setRecentNos(new Set());
      storage.persist(() => saveCachedList(kind.id, fresh));
    } catch (e) {
      if (e instanceof TenmatsuError && e.kind === "auth") setEditingToken(true);
      setListError(`一覧を取得できませんでした (${errorText(e)})`);
    } finally {
      setListLoading(false);
    }
  };
  // ポーリングから呼ぶので、毎レンダー作り直される関数を ref 経由で持つ
  const refreshListRef = useRef(refreshList);
  refreshListRef.current = refreshList;

  /**
   * ローカルサーバーへ最初に触るのは必ずこのボタンから。マウント時には叩かない。
   * - Chrome 142 / Edge 143 以降、公開HTTPSのページから 127.0.0.1 へ出るときは
   *   「このデバイス上のアプリ」の許可を尋ねられる。読み込み直後に勝手に投げると
   *   プロンプトが見過ごされ、拒否がオリジン単位で残ってしまう
   * - ローカルサーバーを持たない同僚が開いたときに、いきなり失敗を見せないため
   */
  const connect = async () => {
    setConnection("checking");
    setConnectionError(null);
    try {
      const h = await client.health();
      setHealth(h);
      setConnection("ok");
      setListNotice(null);
      clearedRef.current = false;
      // 件数の初期値は 保存値 → 範囲内か → /health の既定値 の順で決める。
      // つなぎ直したときも入れ直す (サーバーを入れ替えて上下限が変わっていることがある)
      setMaxInput(String(resolvePerRun(storedMaxPerRun, h).value));
      // PC側がこの種類に未対応なら、ここから先へは進まない。
      // 古いサーバーは kind を無視して顛末書の一覧を返すので、取りに行ってはいけない
      if (!supportsKind(kind, h)) return;
      if (!token) return; // トークン未登録。入力欄が出るのでここで止める
      // .bat から始めた分や別タブの実行にも合流できるようにする
      if (h.job_state === "running") {
        setRunObserved(true);
        setPolling(true);
      } else if (isFinished(h.job_state)) {
        // 終わっている実行の結果も出す。「残りN件」を取り逃がさないため
        // (この画面で始めた実行ではないので runObserved は立てない → 前回の分として出る)
        try {
          setStatus(await client.status());
        } catch {
          // 結果が取れないだけなら黙って進む (一覧は下で取り直す)
        }
      }
      await refreshList();
    } catch (e) {
      setConnection("unreachable");
      setConnectionError(errorText(e));
    }
  };

  const registerToken = async () => {
    const value = tokenInput.trim();
    if (!isValidToken(value)) {
      setTokenError(TOKEN_FORMAT_MESSAGE);
      return;
    }
    setTokenError(null);
    setListLoading(true);
    setListError(null);
    const accept = () => {
      setToken(value);
      setTokenInput("");
      setEditingToken(false);
      storage.persist(() => saveToken(value));
      shareToken(value); // 種類が違うタブでも登録し直さずに使えるようにする
    };
    try {
      // 保存する前に1回使って確かめる (client は useMemo なのでこの時点ではまだ古い)
      const fresh = await makeClient(value).list();
      accept();
      setItems(fresh);
      setListFresh(true);
      storage.persist(() => saveCachedList(kind.id, fresh));
    } catch (e) {
      if (e instanceof TenmatsuError && e.kind === "auth") {
        // 間違っているので保存しない (入力欄をそのまま残して直してもらう)
        setTokenError(e.message);
      } else {
        // 通信の問題ならトークン自体は正しいかもしれないので登録は済ませる
        accept();
        setListError(`一覧を取得できませんでした (${errorText(e)})`);
      }
    } finally {
      setListLoading(false);
    }
  };

  const startRun = async () => {
    setRunError(null);
    setRunNotice(null);
    setStatusError(null);
    setListNotice(null);
    const draft = maxInput.trim();
    // 数字でないときだけ folio で止める。範囲外 (0 や 999) はそのまま送って、
    // サーバーの日本語のメッセージをそのまま出す (folio では丸めない)
    if (perRun.fromServer && !/^\d+$/.test(draft)) {
      setRunError(`1回に取る件数は半角の数字で入力してください (${perRun.min}〜${perRun.max})`);
      return;
    }
    setStarting(true);
    try {
      const {
        started,
        status: first,
        maxPerRun,
      } = await client.run(perRun.fromServer ? { maxPerRun: Number(draft) } : {});
      setStatus(first);
      setRunObserved(true);
      if (maxPerRun !== null) {
        // サーバーが実際に使った件数を残す (次も同じ件数で始められる)
        setMaxInput(String(maxPerRun));
        setStoredMaxPerRun(maxPerRun);
        storage.persist(() => saveMaxPerRun(kind.id, maxPerRun));
      }
      if (!started) {
        setRunNotice(
          "すでに実行中でした。進行中の処理の進捗を表示します" +
            " (入力した件数は、すでに動いている処理には反映されません)",
        );
      }
      // 200 でも、開始直後に失敗して done/error で返ってくることがある
      if (isFinished(first.state)) void refreshListRef.current();
      else setPolling(true);
    } catch (e) {
      if (e instanceof TenmatsuError && e.kind === "auth") setEditingToken(true);
      setRunError(`${kind.label}を取得できませんでした (${errorText(e)})`);
    } finally {
      setStarting(false);
    }
  };

  // 進捗の取得。実行中の間だけ動かし、アンマウント時に必ず止める
  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const s = await client.status();
        if (cancelled) return;
        failures = 0;
        setStatus(s);
        setStatusError(null);
        if (isFinished(s.state)) {
          setPolling(false);
          void refreshListRef.current();
          return;
        }
      } catch (e) {
        if (cancelled) return;
        // 1回の失敗では止めない (スリープ復帰などで一時的に落ちる)。
        // 「時間がかかっている」ことを理由に打ち切ってはいけない: 楽楽精算の画面が開き、
        // 手でログインする間ずっと running のままになることがある
        failures += 1;
        if (failures >= POLL_FAILURE_LIMIT) {
          setPolling(false);
          setStatusError(
            `進捗を取得できなくなりました (${errorText(e)})。` +
              "取得そのものはPC側で続いているかもしれません。「つなぎ直す」で確かめてください",
          );
          return;
        }
        setStatusError(`進捗を取得できませんでした (${errorText(e)})。取得し直しています`);
      }
      timer = setTimeout(tick, POLL_MS);
    };
    // 直後の1回目は撃たない (/run の応答で最新の進捗を持っている)
    timer = setTimeout(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [polling, client]);

  /**
   * 一覧が空のままサーバーに繋がっているときは、自動でPCの記録を取り直す。
   * 新しいブラウザで開いたときや、形の違う古いキャッシュを捨てたときのため。
   *
   * 繰り返さないための条件をすべて置く:
   * - connection === "ok" だけを起点にする (マウント時にサーバーへ触らない。
   *   Chrome 142 / Edge 143 の「このデバイス上のアプリ」の許可はクリックで出す)
   * - listFresh が立ったらもう撃たない → サーバーが本当に0件でも取りに行くのは1回だけ
   * - listError があるときは撃たない → 失敗のたびに撃ち続けない
   * - 「一覧を消去」の直後は撃たない → 消したのに戻ってきたら消したことにならない
   */
  useEffect(() => {
    if (connection !== "ok" || token === null || !storage.restored) return;
    // 配列の同一性で見ると毎回 new になって無限に回る
    if (items.length > 0 || listFresh) return;
    if (listLoading || running || listError !== null) return;
    if (savingFlags.size > 0 || clearedRef.current) return;
    void refreshListRef.current();
  }, [
    connection,
    token,
    storage.restored,
    items.length,
    listFresh,
    listLoading,
    listError,
    running,
    savingFlags.size,
  ]);

  /**
   * 画面の状態を控える。依存は付けない (毎レンダーの後にそのまま写す)。
   * これがあるので、タブを移動して戻ってきても「接続する」を押し直さずに済む。
   * 保存ではなくこのページ読み込み限りの控え (lib/tenmatsu/session.ts)。
   */
  useEffect(() => {
    keepSession(kind.id, {
      token,
      editingToken,
      connection,
      health,
      connectionError,
      items,
      listFresh,
      cleared: clearedRef.current,
      recentNos,
      showCompleted,
      listFilter,
      status,
      polling,
      runObserved,
      storedMaxPerRun,
      maxInput,
    });
  });

  // 取得中に画面を切り替えると進捗が見えなくなるので確認を出す
  useEffect(() => {
    setNavigationGuard(
      running
        ? `${kind.label}を取得中です。画面を切り替えると進捗の表示が止まります (取得そのものはPC側で続き、${kind.label}へ戻れば進捗の表示も追いつきます)。移動しますか？`
        : null,
    );
    return () => setNavigationGuard(null);
  }, [running]);

  const clearList = async () => {
    if (!confirm(clearListConfirmText(kind))) return;
    if (isStorageAvailable()) {
      try {
        await clearCachedList(kind.id);
      } catch (e) {
        storage.setStorageError(`一覧を消去できませんでした (${errorText(e)})`);
      }
    }
    // 消した直後に自動で取り直すと、消したことにならない。押したら戻すまでは空にしておく
    clearedRef.current = true;
    setItems([]);
    setListFresh(false);
    setPreviewNo(null);
    setFlagError(null);
    setRecentNos(new Set());
    setListNotice(clearedNoticeText(kind));
    storage.refreshHasSaved();
    storage.refreshUsage();
  };

  const forgetToken = async () => {
    if (
      !confirm("登録したトークンを消します。次に使うときはもう一度貼り付けが必要です。よろしいですか？")
    ) {
      return;
    }
    if (isStorageAvailable()) {
      try {
        await clearToken();
      } catch (e) {
        storage.setStorageError(`トークンの登録を消せませんでした (${errorText(e)})`);
      }
    }
    setToken(null);
    setEditingToken(false);
    setTokenError(null);
    storage.refreshHasSaved();
    storage.refreshUsage();
  };

  /**
   * 1行のチェックを1つだけ切り替える。
   * - 送るのは押した1つだけ (0個で送るとサーバーは400)
   * - **応答が来るまで画面の値は変えない。**成功したらサーバーが返した行で置き換える
   *   ＝ 失敗しても元に戻す処理が要らない (そもそも変わっていない) し、
   *      成功したように見えることもない。チェックは常に /list の値の写しになる
   * - exists=false の行でも変えられる (404 は記録の有無で決まる)
   */
  const toggleFlag = async (no: string, flag: FlagKey, next: boolean) => {
    if (kindUnsupported) return;
    const update: FlagUpdate = {};
    update[flag] = next;
    setFlagError(null);
    markSaving(no, true);
    // ok でも item が無いことがある。そのときは一覧を取り直すが、
    // 保存中の印を下ろしてからにする (refreshList は保存中は動かないため)
    let needsRefresh = false;
    try {
      const updated = await client.setFlags(
        no,
        update,
      );
      if (updated) {
        // 一覧の再取得は不要。返ってきた行だけ差し替える
        setItems((prev) => prev.map((i) => (i.denpyo_no === no ? updated : i)));
        setRecentNos((prev) => new Set(prev).add(no));
      } else {
        needsRefresh = true;
      }
    } catch (e) {
      if (e instanceof TenmatsuError && e.kind === "auth") setEditingToken(true);
      const definite =
        e instanceof TenmatsuError &&
        (e.kind === "badRequest" || e.kind === "notFound" || e.kind === "auth");
      // definite でないとき (通信できなかった・時間切れ・500) は
      // 「書けたのに失敗に見える」ことがある。そこで「保存されていません」と言うと、
      // 実行予算をダイテックへ二重入力させてしまう
      setFlagError(flagErrorText(kind, no, definite, errorText(e)));
    } finally {
      markSaving(no, false);
    }
    // 保存中に見送った取り直しがあれば、ここで取り直す (実行の完了と重なったとき)
    if (needsRefresh || pendingRefreshRef.current) await refreshListRef.current();
  };

  const loadPdf = useCallback((no: string) => client.filePdf(no), [client]);

  const showTokenForm = connection === "ok" && (editingToken || token === null);
  const perRun = resolvePerRun(storedMaxPerRun, health);
  /** チェックを触れないときの理由 (title に出す)。null なら触れる */
  // 取得中でも変更できる。サーバーは processed.json をロックで守っているので
  // 取得と同時に更新しても失われず、完了後の /list でサーバーの値に揃う
  const flagDisabledReason = !storage.restored
    ? "前回の内容を読み込んでいます"
    : connection !== "ok" || token === null
      ? "「接続する」でPCのサーバーにつなぐと変更できます"
      : !listFresh
        ? "前回このブラウザで見た内容です。「一覧を再読み込み」でPCの記録を読み込むと変更できます"
        : listLoading
          ? "一覧を読み込んでいます"
          : null;
  /**
   * 終わった実行の1行。
   * /status の done は次の実行まで残るので、この画面で始めた (合流した) 実行でなければ
   * 「前回このPCで実行した分」と断って出す。黙って隠すと「残りN件」を取り逃がす。
   */
  const completion = status && !running ? describeCompletion(status, kind.label) : null;
  const preview = previewNo ? (items.find((i) => i.denpyo_no === previewNo) ?? null) : null;

  return (
    <main>
      <p className="mt-4 text-sm text-slate-600">
        楽楽精算で最終承認まで進んだ{kind.label}を、本体と添付書類を1つに結合してこのPCへ保存します。
        このPCで動いているツールに直接つなぐので、PDFが folio のサーバーを通ることはありません。
      </p>

      {storage.storageError && <p className={WARN_CLASS}>{storage.storageError}</p>}

      <div className="mt-6 space-y-4">
        {/* ---------- ローカルサーバー ---------- */}
        <section className={SECTION_CLASS}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">
                ローカルサーバー
                <span className={SUBTITLE_CLASS}>
                  このPCで動いている顛末書取得ツールに直接つなぎます ({TENMATSU_BASE_URL})
                </span>
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                {connection === "idle" && "まだ接続していません"}
                {connection === "checking" && "接続を確認しています…"}
                {connection === "ok" && (
                  <>
                    <span className="font-medium text-emerald-700">接続できました</span>
                    {health?.demo && (
                      <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">
                        デモモード（架空データ）
                      </span>
                    )}
                    {health?.save_dir && (
                      <span className="ml-2 text-xs text-slate-500">保存先: {health.save_dir}</span>
                    )}
                  </>
                )}
                {connection === "unreachable" && "接続できていません"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void connect()}
              disabled={connection === "checking" || running || !storage.restored}
              className={connection === "ok" ? SECONDARY_BUTTON_CLASS : PRIMARY_BUTTON_CLASS}
            >
              {connection === "checking"
                ? "接続しています…"
                : connection === "ok"
                  ? "つなぎ直す"
                  : "接続する"}
            </button>
          </div>

          {connection === "idle" && (
            <p className="mt-2 text-sm text-slate-600">
              この機能は、顛末書取得ツールを入れたPCでだけ使えます。
              「顛末書サーバー起動.bat」を起動してから「接続する」を押してください。
            </p>
          )}

          {connection === "unreachable" && (
            <div className={WARN_CLASS}>
              {connectionError}
              <ul className="mt-1 list-disc pl-5 text-xs">
                <li>
                  「顛末書サーバー起動.bat」をダブルクリックして、黒い画面が出たままになっているか
                </li>
                <li>
                  ブラウザが「このデバイス上のアプリへのアクセスを許可しますか」と尋ねたら「許可」を選んだか
                  (あとから Edge は edge://settings/content、Chrome は chrome://settings/content
                  で直せます)
                </li>
                <li>
                  サーバーの config.json の allowed_origins に {origin || "このページのURL"}{" "}
                  を追加して、サーバーを起動し直したか
                </li>
              </ul>
            </div>
          )}

          {kindUnsupported && (
            <div className={WARN_CLASS}>{unsupportedServerText(kind)}</div>
          )}

          {showTokenForm ? (
            <div className="mt-3 border-t border-slate-100 pt-3">
              <p className="text-sm text-slate-600">
                サーバーを起動したときに黒い画面へ表示された「トークン」を貼り付けてください
                (最初の1回だけです)。
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  type="password"
                  value={tokenInput}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="コンソールに表示されたトークン"
                  onChange={(e) => setTokenInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && tokenInput.trim() !== "") void registerToken();
                  }}
                  className="w-80 rounded border border-slate-300 bg-white px-2 py-1.5 text-sm"
                />
                <button
                  type="button"
                  onClick={() => void registerToken()}
                  disabled={tokenInput.trim() === ""}
                  className={PRIMARY_BUTTON_CLASS}
                >
                  登録
                </button>
                {token !== null && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingToken(false);
                      setTokenInput("");
                      setTokenError(null);
                    }}
                    className={SECONDARY_BUTTON_CLASS}
                  >
                    やめる
                  </button>
                )}
              </div>
              <p className="mt-1 text-xs text-slate-400">
                トークンはこのブラウザ内にだけ保存され、folio
                のサーバーへは送りません。サーバーを入れ直すと変わります。
              </p>
            </div>
          ) : (
            token !== null && (
              <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">
                トークン登録済み (末尾 {token.slice(-4)})
                <button
                  type="button"
                  onClick={() => setEditingToken(true)}
                  className="ml-2 cursor-pointer underline hover:text-slate-700"
                >
                  登録し直す
                </button>
              </p>
            )
          )}

          {tokenError && <p className={ERROR_CLASS}>{tokenError}</p>}
        </section>

        {/* ---------- 取得 ---------- */}
        <section className={SECTION_CLASS}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">
                {kind.label}の取得
                <span className={SUBTITLE_CLASS}>
                  最終承認まで進んだ{kind.label}を、本体と添付を1つに結合してPCへ保存します
                </span>
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                {status && running ? (
                  <>
                    {status.message || "実行中です"}
                    {status.current && (
                      <span className="ml-2 text-xs text-slate-500">処理中: {status.current}</span>
                    )}
                  </>
                ) : health?.demo ? (
                  `デモモード（架空データ）で動いています。楽楽精算には接続せず、架空の${kind.label}を作って一覧に足します。`
                ) : (
                  "楽楽精算の画面がPC上で開き、数分かかることがあります (ログインを求められたらその画面で入力してください)。このタブを閉じても取得はPC側で続きます。"
                )}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {connection === "ok" && perRun.fromServer && (
                <label className="flex items-center gap-1.5 text-sm text-slate-600">
                  1回に取る件数
                  <input
                    // 値は文字列の下書きで持ち、valueAsNumber は読まない。
                    // 空欄の valueAsNumber は NaN で、JSON では null になり、
                    // サーバーは「未指定」と読んで黙って既定値で走ってしまう。
                    // min/max は入力そのものを止めないので、範囲外はサーバーへ届いて 400 になる
                    type="number"
                    inputMode="numeric"
                    min={perRun.min}
                    max={perRun.max}
                    value={maxInput}
                    autoComplete="off"
                    disabled={running}
                    onChange={(e) => setMaxInput(e.target.value)}
                    className="w-20 rounded border border-slate-300 bg-white px-2 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  <span className="text-xs text-slate-500">
                    件 ({perRun.min}〜{perRun.max})
                  </span>
                </label>
              )}
              <button
                type="button"
                onClick={() => void startRun()}
                disabled={
                  connection !== "ok" ||
                  token === null ||
                  running ||
                  !storage.restored ||
                  kindUnsupported ||
                  foreignRun !== null
                }
                aria-busy={running}
                className={PRIMARY_BUTTON_CLASS}
              >
                {running
                  ? `処理中… (${status?.done ?? 0}/${status?.total ?? 0} 完了)`
                  : foreignRun
                    ? `${labelOf(foreignRun)}を取得中…`
                    : `${kind.label}を取得`}
              </button>
            </div>
          </div>

          {connection === "ok" && !perRun.fromServer && (
            <p className="mt-2 text-xs text-amber-700">
              このPCのサーバーは件数の指定に未対応です (サーバーの既定値で動きます)。
              件数を変えたいときは ~/tenmatsu-dl/ を更新してください。
            </p>
          )}

          <p className="mt-2 text-xs text-slate-500">
            添付書類は {SUPPORTED_ATTACHMENTS} をPDFに変換して本体と結合します。
            Office の添付 (Excel・Word・PowerPoint・Outlookのメール) をPDFにできるのは、
            そのアプリが入ったWindowsだけです。メール (.msg) は本文だけをPDFにします。
            変換できないときは、その{kind.label}は取得せずに止めます (添付が欠けた正式書類を作らないため)。
            下に出るメッセージのとおり、手作業でPDFにしてから結合してください。
          </p>

          {runNotice && <p className={WARN_CLASS}>{runNotice}</p>}
          {statusError && <p className="mt-2 text-xs text-amber-700">{statusError}</p>}
          {completion &&
            (runObserved ? (
              completion.tone === "error" ? (
                <p className={ERROR_CLASS}>{completion.message}</p>
              ) : completion.tone === "notice" ? (
                <p className={WARN_CLASS}>{completion.message}</p>
              ) : (
                <p className="mt-2 text-sm text-emerald-700">{completion.message}</p>
              )
            ) : completion.tone === "ok" ? (
              <p className="mt-2 text-xs text-slate-500">
                前回このPCで実行した分: {completion.message}
              </p>
            ) : (
              <p className={WARN_CLASS}>前回このPCで実行した分: {completion.message}</p>
            ))}
          {runError && <p className={ERROR_CLASS}>{runError}</p>}
        </section>

        {/* ---------- 一覧 ---------- */}
        <section className={SECTION_CLASS}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">
              取得済み一覧
              <span className={SUBTITLE_CLASS}>
                {items.length}件
                {!listFresh && items.length > 0 && " (前回このブラウザで見た内容です)"}
              </span>
            </h2>
            <button
              type="button"
              onClick={() => void refreshList()}
              disabled={connection !== "ok" || token === null || listLoading}
              className={SECONDARY_BUTTON_CLASS}
            >
              {listLoading ? "読み込んでいます…" : "一覧を再読み込み"}
            </button>
          </div>

          {listNotice && <p className="mt-2 text-sm text-emerald-700">{listNotice}</p>}
          {listError && <p className={ERROR_CLASS}>{listError}</p>}
          {/* 取得のエラーとは別に出す (Excelの失敗などを潰さないため) */}
          {flagError && <p className={ERROR_CLASS}>{flagError}</p>}

          <TenmatsuList
            kind={kind}
            items={items}
            filter={listFilter}
            onFilterChange={setListFilter}
            showCompleted={showCompleted}
            onShowCompletedChange={setShowCompleted}
            recentNos={recentNos}
            savingNos={savingFlags}
            flagDisabledReason={flagDisabledReason}
            onToggleFlag={(no, flag, next) => void toggleFlag(no, flag, next)}
            canPreview={connection === "ok" && token !== null}
            onPreview={setPreviewNo}
          />
        </section>

        {/* 顛末書から読んだ監督・営業を、アフターメンテナンスのお客様の情報へ入れる。
            専決決裁書には監督・営業が無いので出さない。
            顧客データを取り込んでいないブラウザでは何も出ない */}
        {kind.showStaffSync && items.length > 0 && (
          <TenmatsuStaffSync items={items} listFresh={listFresh} disabled={running} />
        )}
      </div>

      {preview && (
        <TenmatsuPreviewDialog
          item={preview}
          saveDir={health?.save_dir ?? null}
          load={loadPdf}
          onClose={() => setPreviewNo(null)}
        />
      )}

      {(items.length > 0 || token !== null || storage.fontInfo) && (
        <StorageBanner
          description={
            storage.canPersist
              ? kind.text.storageDescription
              : "このタブでは保存を停止しています (再読み込みすると復元を試み直せます)。"
          }
          detail={`取得済み ${items.length}件 (未完了 ${items.filter((i) => i.completed !== true).length}件)${token !== null ? " / トークン登録済み" : ""}`}
          usageBytes={storage.usageBytes}
          fontInfo={storage.fontInfo}
          disabled={running}
          actions={[
            ...(items.length > 0
              ? [{ label: "一覧を消去", onClick: () => void clearList(), danger: true }]
              : []),
            ...(token !== null
              ? [{ label: "トークンの登録を消す", onClick: () => void forgetToken(), danger: true }]
              : []),
          ]}
          onClearFont={storage.clearFont}
        />
      )}

      <footer className="mt-10 border-t border-slate-200 pt-4 text-xs text-slate-400">
        {kind.label}のPDFはこのPCのローカルサーバーとブラウザの間だけでやり取りされ、folio
        のサーバーには送信されません。PDFの実体はPCの保存先フォルダにあり、ブラウザには保存しません。
      </footer>
    </main>
  );
}
