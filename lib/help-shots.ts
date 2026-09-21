/**
 * 「使い方」ページに載せる画面の写真。**文言だけ**をここに書く（人が書く分）。
 *
 * ★画像の大きさと、番号の印の位置は scripts/help-shots が実測して
 *   lib/help-shots.generated.ts に書き出す。撮り直すと座標が自動で追いかけるので、
 *   「画面を直したのに印が古い場所を指している」が起きない。
 * ★印の文には①②と書かない（番号は画面が順に振る）。
 * ★写真はすべて**架空のデータ**で撮る。実在の氏名・住所・伝票№・社員番号は写さない
 *   （公開リポジトリなので、一度入れると履歴から消せない）。
 */

/** 画像の上に重ねる印1つ分（文言だけ。位置は generated 側） */
export interface HelpShotHotspot {
  text: string;
}

export interface HelpShot {
  /** 節の中で一意。画像のファイル名にもなる（/help/<id>.webp） */
  id: string;
  /** 何をしている場面か（写真の下に出す1行） */
  caption: string;
  /** 画像に何が写っているか（読み上げ用。印の文とは別に、これだけで通じるように書く） */
  alt: string;
  hotspots: readonly HelpShotHotspot[];
}

/** 撮影時の倍率。表示幅は width / SHOT_SCALE（原寸より大きく引き伸ばさない） */
export const SHOT_SCALE = 2;

/** 画像の置き場。★next/image は使わない（app/help/page.tsx のコメントを見ること） */
export const helpShotSrc = (shot: Pick<HelpShot, "id">): string => `/help/${shot.id}.webp`;

/** 節の id → その節に出す写真 */
export const HELP_SHOTS: Readonly<Record<string, readonly HelpShot[]>> = {
  "help-inspection": [],
  "help-after": [],
  "help-tenmatsu": [],
  "help-senketsu": [],
  "help-natsuin": [],
};
