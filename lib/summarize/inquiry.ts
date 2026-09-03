// コールセンターの受付メモ (自由文) から「アフター受付内容」を作る。
// 定期点検の不具合一覧とは入力の形が違うので、プロンプトとルールベースを分けている。
import { exampleOutputLines } from "@/lib/summarize/examples";
import { formatPhenomena } from "@/lib/summarize/format";
import { stripRequests } from "@/lib/summarize/rule-based";
import type { InquiryExampleInput } from "@/lib/summarize/types";

/** 受付メモの長さ上限 (これを超える分は切り捨てる) */
export const INQUIRY_TEXT_MAX = 4000;

/**
 * 利用者が手直しした過去の受付内容を、文体の手本としてプロンプトに並べる。
 * 出力は phenomena / requests に分けず箇条書きにする
 * (保存した本文からはどちらだったか分からないため。番号付けはサーバー側で行う)。
 */
function exampleSection(examples: readonly InquiryExampleInput[]): string[] {
  if (examples.length === 0) return [];
  const lines = [
    "## 過去の受付例 (書き方の手本)",
    "以下は、この受付担当者が過去の受付メモから実際に作った「アフター受付内容」です。",
    "文体・語尾・1要素にまとめる粒度・用語の選び方を、これらの例に合わせてください。",
    "上の条件の書き方 (体言止めなど) と例の書き方が食い違う場合は、例の書き方を優先します。",
    "ただし「個人情報・対応方針・訪問日程・折り返しの約束・挨拶を入れない」は例より優先して守ります。",
    "例に書かれている内容を今回の受付メモへ持ち込まないこと (出力は今回の受付メモに書かれていることだけ)。",
  ];
  examples.forEach((example, i) => {
    lines.push(
      "",
      `### 例${i + 1}`,
      "受付メモ:",
      example.input,
      "アフター受付内容:",
      ...exampleOutputLines(example.output).map((item) => `- ${item}`),
    );
  });
  lines.push("");
  return lines;
}

export function buildInquiryPrompt(
  redactedText: string,
  examples: readonly InquiryExampleInput[] = [],
): string {
  return [
    "あなたは住宅アフターメンテナンス受付の記録係です。",
    "以下はコールセンターがお客様から受け付けた依頼のメモです。",
    "管理表の「アフター受付内容」欄に載せるため、内容を1件ずつ短くまとめた配列を作ってください。",
    "",
    "条件:",
    "- phenomena には**不具合の事象(どこの何がどうなっているか)**を入れる。場所・部位・症状を具体的に含める",
    "- requests には**不具合ではない依頼**(設備の追加・交換の希望、説明の依頼など)を入れる",
    "- **1つの要素に1つの内容**。場所や症状が異なるものは必ず別の要素に分ける",
    "- 各要素は句点で終わらせず、体言止めまたは簡潔な叙述にする (例: 「1階洋室天井のクロスに凹凸」)",
    "- 弊社の対応方針・訪問日程・折り返しの約束は入れない (例: 明日連絡、担当より折り返し、業者手配)",
    "- 挨拶・受付者の所感・お客様の連絡可能時間は入れない",
    "- 個人名・住所・電話番号は入れない",
    "- 該当が無い配列は空にする (両方空にするのは、メモに依頼内容が書かれていない場合だけ)",
    "",
    '良い例: {"phenomena": ["浴室の換気扇から異音", "2階洋室の窓が閉まりにくい"], "requests": []}',
    '良い例: {"phenomena": [], "requests": ["網戸の追加をご希望"]}',
    '悪い例: {"phenomena": ["換気扇から異音がするので早めに見に来てほしいとのこと。明日折り返し予定。"], "requests": []} (要望と対応方針が混ざっており不可)',
    "",
    ...exampleSection(examples),
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

const truncate = (line: string) =>
  line.length > MAX_SENTENCE_LENGTH ? `${line.slice(0, MAX_SENTENCE_LENGTH)}…` : line;

/**
 * Gemini が使えないときの受付メモの要約 (文を分けて、段取りの文を落とすだけ)。
 * 段取りの文しか無くて全部落ちてしまう場合は、落とす前の文をそのまま残す
 * (空欄で登録されるより、元の文が残っていた方が直しやすい)。
 */
export function ruleBasedInquirySummary(text: string): string {
  const sentences = text
    .split(/[\n。；;]+/)
    .map((line) => line.replace(/^[-・*\s]+/, "").trim())
    .filter((line) => line.length >= MIN_SENTENCE_LENGTH);
  const items = sentences
    .map((line) => stripRequests(line))
    .filter((line) => line.length >= MIN_SENTENCE_LENGTH && !NOISE_SENTENCE.test(line))
    .map(truncate);
  return formatPhenomena(items.length > 0 ? items : sentences.map(truncate), [], {
    emptyText: "",
  });
}
