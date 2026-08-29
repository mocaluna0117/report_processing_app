// コールセンターの受付メモ (自由文) から「アフター受付内容」を作る。
// 定期点検の不具合一覧とは入力の形が違うので、プロンプトとルールベースを分けている。
import { formatPhenomena } from "@/lib/summarize/format";
import { stripRequests } from "@/lib/summarize/rule-based";

/** 受付メモの長さ上限 (これを超える分は切り捨てる) */
export const INQUIRY_TEXT_MAX = 4000;

export function buildInquiryPrompt(redactedText: string): string {
  return [
    "あなたは住宅アフターメンテナンス受付の記録係です。",
    "以下はコールセンターがお客様から受け付けた修理依頼のメモです。",
    "管理表の「アフター受付内容」欄に載せるため、**不具合の事象を1件ずつ短くまとめた配列**を作ってください。",
    "",
    "条件:",
    "- phenomena には**不具合の事象(どこの何がどうなっているか)だけ**を入れる。場所・部位・症状を具体的に含める",
    "- **1つの要素に1つの事象**。場所や症状が異なるものは必ず別の要素に分ける",
    "- 各要素は句点で終わらせず、体言止めまたは簡潔な叙述にする (例: 「1階洋室天井のクロスに凹凸」)",
    "- お客様の要望は入れない (例: 補修をご希望、見積もりをご希望、早めに来てほしい)",
    "- 弊社の対応方針・訪問日程・折り返しの約束は入れない (例: 明日連絡、担当より折り返し、業者手配)",
    "- 挨拶・受付者の所感・お客様の連絡可能時間は入れない",
    "- 個人名・住所・電話番号は入れない",
    "- 不具合の事象が1件も無ければ空配列を返す",
    "",
    '良い例: ["浴室の換気扇から異音", "2階洋室の窓が閉まりにくい"]',
    '悪い例: ["換気扇から異音がするので早めに見に来てほしいとのこと。明日折り返し予定。"] (要望と対応方針が含まれており不可)',
    "",
    "## 受付メモ",
    redactedText,
  ].join("\n");
}

/** 事象として扱わない文 (受付の段取り・挨拶など) */
const NOISE_SENTENCE =
  /(折り返し|訪問|日程|都合|在宅|連絡先|電話番号|入電|架電|受付|担当|手配|よろしく|お世話|ご希望|希望され|とのこと$|お伝え|案内)/;

/** 事象らしさの下限 (短すぎる断片は捨てる) */
const MIN_SENTENCE_LENGTH = 5;
/** 1事象の長さ上限 */
const MAX_SENTENCE_LENGTH = 80;

/**
 * Gemini が使えないときの受付メモの要約 (文を分けて、段取りの文を落とすだけ)。
 * 事象が取れなければ空文字を返し、画面で手入力してもらう
 * (定期点検の「不具合の指摘なし」は、問い合わせを受けている時点で誤りになるため使わない)。
 */
export function ruleBasedInquirySummary(text: string): string {
  const items = text
    .split(/[\n。；;]+/)
    .map((line) => stripRequests(line.trim()))
    .map((line) => line.replace(/^[-・*\s]+/, "").trim())
    .filter((line) => line.length >= MIN_SENTENCE_LENGTH && !NOISE_SENTENCE.test(line))
    .map((line) => (line.length > MAX_SENTENCE_LENGTH ? `${line.slice(0, MAX_SENTENCE_LENGTH)}…` : line));
  return formatPhenomena(items, [], { emptyText: "" });
}
