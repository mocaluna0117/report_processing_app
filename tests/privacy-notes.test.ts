import { describe, expect, it } from "vitest";
import {
  AFTER_SAVE_NOTE,
  AFTER_SHARED_SAVE_NOTE,
  INSPECTION_SAVE_NOTE,
  LEARNING_SEND_NOTE,
  SAVE_PAUSED_TEXT,
  type SafetyNote,
} from "@/lib/privacy-notes";

// 画面に出す文章量を減らす作業（2026-09-21）で、安全に関わる説明まで一緒に消えないようにするためのテスト。
// 画面（React）のテスト基盤が無いので、文言そのものをここで固定する。

const notes: [string, SafetyNote][] = [
  ["定期点検", INSPECTION_SAVE_NOTE],
  ["アフターメンテナンス", AFTER_SAVE_NOTE],
  ["アフターメンテナンス（共有フォルダーあり）", AFTER_SHARED_SAVE_NOTE],
];

describe.each(notes)("%s の保存の説明", (_label, note) => {
  it("★画面に常に出るのは1文だけ（80字以内）", () => {
    expect(note.summary.split("。").filter((s) => s.trim() !== "")).toHaveLength(1);
    expect(note.summary.length).toBeLessThanOrEqual(80);
  });

  it("その1文だけで「どこに保存されるか」が分かる", () => {
    expect(note.summary).toContain("このブラウザ");
    expect(note.summary).toContain("サーバーには送りません");
  });

  it("★「くわしく」に、外へ送るものと APIキーが無いときの動きが必ず残っている", () => {
    const details = note.details.join("");
    expect(details).toContain("Gemini API");
    expect(details).toContain("APIキーが未設定");
  });

  it("「くわしく」も長くなりすぎない（合計400字以内）", () => {
    expect(note.details.join("").length).toBeLessThanOrEqual(400);
    expect(note.details.length).toBeGreaterThan(0);
  });
});

describe("送るものを畳んで隠さない", () => {
  it("★定期点検は施主名の漢字を送る（「伏せ字だけ」と書いてはいけない）", () => {
    const details = INSPECTION_SAVE_NOTE.details.join("");
    expect(details).toContain("施主名の漢字");
    expect(details).toContain("点検シート画像");
    expect(details).toContain("不具合テキスト");
    expect(INSPECTION_SAVE_NOTE.summary).not.toContain("伏せ字");
  });

  it("アフターは伏せ字にした受付内容だけを送る", () => {
    const details = AFTER_SAVE_NOTE.details.join("");
    expect(details).toContain("伏せ字");
    expect(details).toContain("受付内容");
  });

  it("消えないものの説明を残す（取り込み直し・別の画面の消去）", () => {
    expect(INSPECTION_SAVE_NOTE.details.join("")).toContain("取り消せません");
    expect(AFTER_SAVE_NOTE.details.join("")).toContain("消えません");
  });
});

describe("共有フォルダーを登録しているとき", () => {
  it("★1文だけで「共有フォルダーにも置く」と分かる", () => {
    expect(AFTER_SHARED_SAVE_NOTE.summary).toContain("共有フォルダー");
    // ★folio のサーバーへは共有しても何も送らないので、この約束は変えない
    expect(AFTER_SHARED_SAVE_NOTE.summary).toContain("サーバーには送りません");
  });

  it("★置くものと置かないものを、どちらも書く", () => {
    const details = AFTER_SHARED_SAVE_NOTE.details.join("");
    expect(details).toContain("手直し");
    expect(details).toContain("学習した書き方");
    expect(details).toContain("置きません");
    expect(details).toContain("受付一覧");
    // ★顧客データ一式（氏名・住所・電話番号）が共有フォルダーに載ることを隠さない
    expect(details).toContain("顧客データ一式");
    expect(details).toContain("氏名・住所・電話番号を含みます");
  });

  it("★誰が見られるかを書く（アプリが守るのではなくフォルダーの権限が守る）", () => {
    expect(AFTER_SHARED_SAVE_NOTE.details.join("")).toContain("フォルダーの権限どおり");
  });

  it("★消したときに相手からも消えることを書く", () => {
    expect(AFTER_SHARED_SAVE_NOTE.details.join("")).toContain("相手の端末からも消えます");
  });

  it("共有フォルダーを登録していないときの文は今までどおり", () => {
    expect(AFTER_SAVE_NOTE.summary).toContain("このブラウザの中だけ");
    expect(AFTER_SAVE_NOTE.summary).not.toContain("共有フォルダー");
  });

  it("定期点検の「くわしく」にも、学習が共有フォルダーへ出ることが載っている", () => {
    expect(INSPECTION_SAVE_NOTE.details.join("")).toContain("共有フォルダー");
  });
});

describe("共通の文", () => {
  it("保存を止めているときの文は1文", () => {
    expect(SAVE_PAUSED_TEXT.split("。").filter((s) => s.trim() !== "")).toHaveLength(1);
    expect(SAVE_PAUSED_TEXT).toContain("保存を停止");
  });

  it("学習した書き方のダイアログにも、送るものの説明が残っている", () => {
    expect(LEARNING_SEND_NOTE).toContain("伏せ字");
    expect(LEARNING_SEND_NOTE).toContain("APIキーが未設定");
  });
});
