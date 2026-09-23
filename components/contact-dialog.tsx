"use client";

/**
 * 問い合わせ（不具合・改善の要望を開発者へ送る）。Folio 全体で1つ。ヘッダーと使い方から開く。
 *
 * ★送るのは、利用者が書いた文・選んだ写真・**状態だけ**の「一緒に送る情報」。
 *   楽楽精算のログインID・共有フォルダーの名前・取得のログは読まない
 *   （tests/contact-dialog.test.ts がこのファイルの中身を読んで見張っている）。
 * ★下書きはこのタブのメモリにだけ置く（lib/contact/dialog.ts）。
 * ★送り先のアドレスは画面に出さない（サーバーの環境変数だけが持つ）。
 */
import { useEffect, useRef, useState } from "react";
import { ModalShell } from "@/components/modal-shell";
import { MoreDetails } from "@/components/more-details";
import { PhotoError, compressPhoto } from "@/lib/contact/compress";
import {
  closeContact,
  clearContactDraft,
  type ContactDraft,
  getContactDraft,
  isContactOpen,
  saveContactDraft,
  subscribeContact,
} from "@/lib/contact/dialog";
import {
  CONTACT_CATEGORIES,
  CONTACT_LIMITS,
  CONTACT_PAGES,
  type ContactPayload,
  collectDiagnostics,
  contactBlockers,
  contactCopyText,
  diagnosticsLines,
  personalInfoWarning,
  redactContactText,
} from "@/lib/contact/form";
import type { ContactResponse } from "@/lib/contact/handle";
import { getSharedConnection } from "@/lib/shared/connection";
import { findPersonalInfo } from "@/lib/summarize/redact";
import { getSessionToken } from "@/lib/tenmatsu/local/session";

const INPUT_CLASS =
  "w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50";
const PRIMARY_BUTTON_CLASS =
  "rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY_BUTTON_CLASS =
  "rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";

const MESSAGE_PLACEHOLDER = [
  "例）",
  "何をしたら: 顛末書の画面で「一覧を再読み込み」を押した",
  "どうなった: 完了の印が消えた",
  "どうしてほしい: 印が残ってほしい",
].join("\n");

type Outcome =
  | { kind: "sent"; message: string }
  | { kind: "failed"; message: string; copyText: string }
  | null;

const newId = () =>
  typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

/** 今の状態から「一緒に送る情報」を作る（★状態だけ。ID・名前は読まない） */
function currentDiagnostics() {
  const connection = getSharedConnection();
  return collectDiagnostics({
    ua: typeof navigator === "undefined" ? "" : navigator.userAgent,
    width: typeof window === "undefined" ? null : window.innerWidth,
    height: typeof window === "undefined" ? null : window.innerHeight,
    loggedIn: getSessionToken() !== null,
    sharedState: connection.known ? connection.state : null,
  });
}

export function ContactDialog() {
  const [open, setOpen] = useState(isContactOpen);
  const [draft, setDraftState] = useState<ContactDraft>(getContactDraft);
  // ★開くのと同時に、メモリの下書き（と開いた画面）を読む。effect で後から読むと、
  //   前の下書きのまま一度描かれてしまう
  useEffect(
    () =>
      subscribeContact((next) => {
        if (next) setDraftState(getContactDraft());
        setOpen(next);
      }),
    [],
  );
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);

  // 開くたびに、前の結果の表示を片付けて入力欄に合わせる
  useEffect(() => {
    if (!open) return;
    setOutcome((prev) => (prev?.kind === "sent" ? null : prev));
    setPhotoError(null);
    setCopied(null);
    messageRef.current?.focus();
  }, [open]);

  /** 下書きを変える（メモリにも書く。閉じても残すため） */
  const update = (fn: (d: ContactDraft) => ContactDraft) => {
    setDraftState((prev) => {
      const next = fn(prev);
      saveContactDraft(next);
      return next;
    });
  };

  const addPhotos = async (files: readonly Blob[]) => {
    setPhotoError(null);
    const room = CONTACT_LIMITS.photos - getContactDraft().photos.length;
    if (room <= 0) {
      setPhotoError(`写真は ${CONTACT_LIMITS.photos}枚までです`);
      return;
    }
    if (files.length > room) setPhotoError(`写真は ${CONTACT_LIMITS.photos}枚までです（多い分は付けませんでした）`);
    for (const file of files.slice(0, room)) {
      try {
        const { blob, width, height } = await compressPhoto(file);
        const photo = { id: newId(), blob, url: URL.createObjectURL(blob), width, height };
        // ★写真を足したら、確かめの印は押し直してもらう
        update((d) => ({ ...d, photos: [...d.photos, photo], photosChecked: false }));
      } catch (e) {
        setPhotoError(e instanceof PhotoError ? e.message : "写真を付けられませんでした");
      }
    }
  };

  const removePhoto = (id: string) => {
    update((d) => {
      const target = d.photos.find((p) => p.id === id);
      if (target) URL.revokeObjectURL(target.url);
      const photos = d.photos.filter((p) => p.id !== id);
      return { ...d, photos, photosChecked: photos.length > 0 ? d.photosChecked : false };
    });
  };

  if (!open) return null;

  const photoBytes = draft.photos.reduce((sum, p) => sum + p.blob.size, 0);
  const blockers = contactBlockers({
    message: draft.message,
    name: draft.name,
    photos: draft.photos.length,
    photoBytes,
    photosChecked: draft.photosChecked,
    sending,
  });
  const warning = personalInfoWarning(findPersonalInfo(draft.message));
  const diagnostics = currentDiagnostics();

  const payloadOf = (): ContactPayload => ({
    category: draft.category,
    page: draft.page,
    message: draft.message.trim(),
    name: draft.name.trim(),
    diagnostics,
  });

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("コピーしました。メールやチャットに貼り付けて、開発者へ送ってください");
    } catch {
      setCopied("コピーできませんでした。下の枠の中の文字を選んでコピーしてください");
    }
  };

  /** ★送るのは「送信」を押したときだけ */
  const submit = async () => {
    if (blockers.length > 0) return;
    const payload = payloadOf();
    const body = new FormData();
    body.set("payload", JSON.stringify(payload));
    for (const [i, photo] of draft.photos.entries()) body.append("photo", photo.blob, `写真${i + 1}.jpg`);
    setSending(true);
    setOutcome(null);
    setCopied(null);
    const copyText = contactCopyText(payload, Date.now());
    try {
      const res = await fetch("/api/contact", { method: "POST", body });
      const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
      if (!isJson) {
        // ★未ログインのとき、proxy.ts は JSON ではなく文字列の 401 を返す
        setOutcome({
          kind: "failed",
          message:
            res.status === 401
              ? "Folio のログインが切れています。「文面をコピー」で控えてから、画面を読み込み直してログインし、もう一度送ってください（読み込み直すと書いた内容は消えます）"
              : `送れませんでした（${res.status}）。少し待ってからもう一度押すか、「文面をコピー」で開発者へ直接知らせてください`,
          copyText,
        });
        return;
      }
      const result = (await res.json()) as ContactResponse;
      if (result.ok) {
        clearContactDraft();
        setDraftState(getContactDraft());
        setOutcome({ kind: "sent", message: result.message });
      } else {
        setOutcome({ kind: "failed", message: result.message, copyText });
      }
    } catch {
      setOutcome({
        kind: "failed",
        message: "送れませんでした（ネットにつながっているか確かめてください）。「文面をコピー」で開発者へ直接知らせることもできます",
        copyText,
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <ModalShell
      label="問い合わせ"
      onClose={closeContact}
      panelClassName="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl bg-white shadow-xl"
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
        <h2 className="text-lg font-bold text-slate-900">問い合わせ</h2>
        <button
          type="button"
          onClick={closeContact}
          aria-label="閉じる"
          className="cursor-pointer rounded-md px-2 py-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
        >
          ✕
        </button>
      </div>

      {outcome?.kind === "sent" ? (
        <div className="px-5 py-6">
          <p className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
            {outcome.message}
          </p>
          <p className="mt-2 text-xs text-slate-500">返事が要るときは、開発者から直接連絡します。</p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setOutcome(null)} className={SECONDARY_BUTTON_CLASS}>
              続けて書く
            </button>
            <button type="button" onClick={closeContact} className={PRIMARY_BUTTON_CLASS}>
              閉じる
            </button>
          </div>
        </div>
      ) : (
        <form
          className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
            ★<strong>お客様の氏名・住所・電話番号は書かないでください。</strong>
            写真を付けるときは、お客様の情報が写っていないか確かめてください。
            送った内容は、メール送信のサービス（Resend）を通って開発者の Gmail に届きます。
          </p>

          <fieldset className="mt-4">
            <legend className="text-xs font-medium text-slate-600">種類</legend>
            <div className="mt-1 inline-flex flex-wrap gap-1 rounded-lg bg-slate-200 p-1 shadow-inner">
              {CONTACT_CATEGORIES.map((c) => (
                <label
                  key={c.id}
                  className={
                    draft.category === c.id
                      ? "cursor-pointer rounded-md bg-white px-3 py-1 text-sm font-semibold text-slate-900 shadow-sm"
                      : "cursor-pointer rounded-md px-3 py-1 text-sm font-medium text-slate-600 hover:text-slate-900"
                  }
                >
                  <input
                    type="radio"
                    name="contact-category"
                    value={c.id}
                    checked={draft.category === c.id}
                    onChange={() => update((d) => ({ ...d, category: c.id }))}
                    className="sr-only"
                  />
                  {c.label}
                </label>
              ))}
            </div>
          </fieldset>

          <label className="mt-3 block text-xs font-medium text-slate-600">
            どの画面のことですか
            <select
              value={draft.page}
              onChange={(e) => update((d) => ({ ...d, page: e.target.value }))}
              className={`mt-1 ${INPUT_CLASS}`}
            >
              {CONTACT_PAGES.map((p) => (
                <option key={p.path || "none"} value={p.path}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          <label className="mt-3 block text-xs font-medium text-slate-600">
            内容
            <textarea
              ref={messageRef}
              value={draft.message}
              rows={7}
              placeholder={MESSAGE_PLACEHOLDER}
              onChange={(e) => update((d) => ({ ...d, message: e.target.value }))}
              onPaste={(e) => {
                // 画面の写真を貼り付けたら、添付に入れる（文字の貼り付けはそのまま）
                const images = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
                if (images.length === 0) return;
                e.preventDefault();
                void addPhotos(images);
              }}
              className={`mt-1 ${INPUT_CLASS} leading-relaxed`}
            />
          </label>
          <p className="mt-0.5 text-right text-xs text-slate-400">
            {draft.message.length.toLocaleString()} / {CONTACT_LIMITS.messageChars.toLocaleString()}字
          </p>

          {warning && (
            <div className="mt-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <p>{warning}</p>
              <button
                type="button"
                onClick={() => update((d) => ({ ...d, message: redactContactText(d.message) }))}
                className="mt-1.5 rounded-md border border-amber-400 bg-white px-2.5 py-1 text-xs font-semibold text-amber-900 hover:bg-amber-100"
              >
                伏せ字にする
              </button>
            </div>
          )}

          <div className="mt-3">
            <p className="text-xs font-medium text-slate-600">
              写真（任意・{CONTACT_LIMITS.photos}枚まで）
            </p>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: ドロップの受け口（ボタンでも選べる） */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void addPhotos([...e.dataTransfer.files].filter((f) => f.type.startsWith("image/")));
              }}
              className={`mt-1 rounded-md border border-dashed px-3 py-3 text-xs ${
                dragging ? "border-blue-400 bg-blue-50" : "border-slate-300 bg-slate-50"
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={draft.photos.length >= CONTACT_LIMITS.photos}
                  className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  写真を選ぶ
                </button>
                <span className="text-slate-500">ここにドロップするか、内容の欄に貼り付けても付けられます</span>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    void addPhotos([...(e.target.files ?? [])]);
                    e.target.value = "";
                  }}
                />
              </div>
              {draft.photos.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-2">
                  {draft.photos.map((photo, i) => (
                    <li key={photo.id} className="relative">
                      {/* biome-ignore lint/performance/noImgElement: ブラウザの中で作った写真の下見（next/image は使えない） */}
                      <img
                        src={photo.url}
                        alt={`写真${i + 1}`}
                        className="h-20 w-auto max-w-40 rounded border border-slate-300 bg-white object-contain"
                      />
                      <button
                        type="button"
                        onClick={() => removePhoto(photo.id)}
                        aria-label={`写真${i + 1}を外す`}
                        className="absolute -right-2 -top-2 rounded-full border border-slate-300 bg-white px-1.5 text-xs text-slate-600 shadow hover:bg-slate-100"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {photoError && <p className="mt-1.5 text-red-700">{photoError}</p>}
            </div>
            {draft.photos.length > 0 && (
              <label className="mt-2 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                <input
                  type="checkbox"
                  checked={draft.photosChecked}
                  onChange={(e) => update((d) => ({ ...d, photosChecked: e.target.checked }))}
                  className="mt-0.5"
                />
                <span>
                  写真にお客様の氏名・住所・電話番号が<strong>写っていないことを確かめました</strong>
                  （写っているときは、その部分を切り取ってから付け直してください）
                </span>
              </label>
            )}
          </div>

          <label className="mt-3 block text-xs font-medium text-slate-600">
            お名前（任意。返事が要るときに誰か分かるように）
            <input
              type="text"
              value={draft.name}
              maxLength={CONTACT_LIMITS.nameChars}
              onChange={(e) => update((d) => ({ ...d, name: e.target.value }))}
              className={`mt-1 ${INPUT_CLASS}`}
            />
          </label>

          <MoreDetails size="xs" summary="一緒に送る情報（お客様の情報は含みません）">
            <ul className="list-disc pl-4">
              {diagnosticsLines(diagnostics).map((line) => (
                <li key={line}>{line}</li>
              ))}
              <li>Folio の版と、送った日時</li>
            </ul>
            <p>楽楽精算のログインID・共有フォルダーの名前・取り込んだファイルの名前は送りません。</p>
          </MoreDetails>

          {outcome?.kind === "failed" && (
            <div className="mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
              <p>{outcome.message}</p>
              <button
                type="button"
                onClick={() => void copy(outcome.copyText)}
                className="mt-2 rounded-md border border-red-300 bg-white px-2.5 py-1 text-xs font-semibold text-red-800 hover:bg-red-100"
              >
                文面をコピー
              </button>
              {copied && <p className="mt-1.5 text-xs">{copied}</p>}
              {copied?.startsWith("コピーできません") && (
                <textarea readOnly value={outcome.copyText} rows={6} className={`mt-1.5 ${INPUT_CLASS} text-xs`} />
              )}
              {draft.photos.length > 0 && (
                <p className="mt-1.5 text-xs">写真はコピーできないので、別に付けて送ってください。</p>
              )}
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
            {blockers.length > 0 && !sending && (
              <p className="text-xs text-slate-500">{blockers[0]}</p>
            )}
            <button type="submit" disabled={blockers.length > 0} className={PRIMARY_BUTTON_CLASS}>
              {sending ? "送っています…" : "送信"}
            </button>
          </div>
        </form>
      )}
    </ModalShell>
  );
}
