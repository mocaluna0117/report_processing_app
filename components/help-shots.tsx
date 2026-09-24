import type { HelpSection } from "@/lib/help";
import { SHOT_SCALE, helpShotSrc } from "@/lib/help-shots";
import { HELP_SHOT_GEOMETRY } from "@/lib/help-shots.generated";

/**
 * 画面の写真。印は**飾り（aria-hidden）**で、意味は下の番号付きの説明が持つ。
 * 押せる印にすると「押しても何も起きない」罠になるので、押せるようにしない。
 *
 * ★写真は next/image を使わず、素の <img src="/help/…"> で出す。
 *   proxy.ts の matcher は /_next/image と /_next/static を認証の対象外にしているので、
 *   next/image や静的インポートで出すと、社内画面の写真が Folio のログインの外に置かれる。
 *   （tests/help.test.ts が、この決まりが戻されていないか見張っている）
 */
const MARKER_CLASS =
  "absolute z-10 inline-flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center " +
  "rounded-full bg-blue-600 text-xs font-semibold text-white shadow ring-2 ring-white";

export function HelpShots({ section }: { section: HelpSection }) {
  const shots = section.shots.filter((shot) => HELP_SHOT_GEOMETRY[shot.id]);
  if (shots.length === 0) return null;
  return (
    <>
      <h4 className="mt-6 text-base font-semibold text-slate-900">画面の写真</h4>
      {shots.map((shot) => {
        const geometry = HELP_SHOT_GEOMETRY[shot.id];
        return (
          <figure key={shot.id} className="mt-2">
            <div
              className="relative overflow-hidden rounded-md border border-slate-200 bg-white"
              style={{ maxWidth: `${Math.round(geometry.width / SHOT_SCALE)}px` }}
            >
              <img
                src={helpShotSrc(shot)}
                alt={shot.alt}
                width={geometry.width}
                height={geometry.height}
                loading="lazy"
                decoding="async"
                className="block h-auto w-full"
              />
              {geometry.hotspots.map((at, i) => (
                <span
                  key={shot.hotspots[i]?.text ?? i}
                  aria-hidden
                  className={MARKER_CLASS}
                  style={{ left: `${at.x}%`, top: `${at.y}%` }}
                >
                  {i + 1}
                </span>
              ))}
            </div>
            <figcaption className="mt-1.5 text-sm leading-relaxed text-slate-600">
              {shot.caption}
              <a
                href={helpShotSrc(shot)}
                target="_blank"
                rel="noreferrer"
                className="ml-2 text-xs font-medium text-blue-700 underline hover:text-blue-900"
              >
                大きく見る
              </a>
              {shot.hotspots.length > 0 && (
                <ol className="mt-1 list-decimal space-y-1 pl-5 text-slate-700">
                  {shot.hotspots.map((hotspot) => (
                    <li key={hotspot.text}>{hotspot.text}</li>
                  ))}
                </ol>
              )}
            </figcaption>
          </figure>
        );
      })}
    </>
  );
}
