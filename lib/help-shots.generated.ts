// scripts/help-shots が書き出すファイル。手で編集しない。
// 撮り直すには `npm run help:shots`（端末の Chrome を使う）。
import type { HelpShotGeometry } from "@/lib/help-shots-geometry";

export const HELP_SHOT_GEOMETRY: Readonly<Record<string, HelpShotGeometry>> = {
  "inspection-drop": {
    width: 2496,
    height: 550,
    hotspots: [{ x: 3.3, y: 12 }, { x: 50, y: 54.8 }, { x: 50, y: 78.7 }],
  },
  "inspection-pairs": {
    width: 2496,
    height: 444,
    hotspots: [{ x: 2.6, y: 64.4 }, { x: 48.5, y: 64.4 }, { x: 92.9, y: 11.7 }],
  },
  "inspection-results": {
    width: 2496,
    height: 1061,
    hotspots: [{ x: 77.4, y: 5.1 }, { x: 30.2, y: 41.3 }, { x: 82.2, y: 35.4 }],
  },
  "after-import": {
    width: 2496,
    height: 604,
    hotspots: [{ x: 50, y: 69.3 }, { x: 3.3, y: 10.9 }],
  },
  "after-shared": {
    width: 1344,
    height: 610,
    hotspots: [{ x: 12.2, y: 9.2 }, { x: 17.1, y: 71.8 }, { x: 50, y: 59.7 }],
  },
  "after-intake": {
    width: 2496,
    height: 1625,
    hotspots: [{ x: 25, y: 8.4 }, { x: 50, y: 77.5 }, { x: 6.4, y: 94.7 }],
  },
  "after-cases": {
    width: 2496,
    height: 1041,
    hotspots: [{ x: 30.2, y: 37.3 }, { x: 82.3, y: 5.2 }, { x: 89.1, y: 32.3 }],
  },
  "tenmatsu-folder": {
    width: 2496,
    height: 728,
    hotspots: [{ x: 74.9, y: 19.8 }, { x: 90.3, y: 76.1 }],
  },
  "tenmatsu-login": {
    width: 1024,
    height: 706,
    hotspots: [{ x: 50, y: 45.9 }, { x: 50, y: 64.6 }, { x: 86.8, y: 77.9 }],
  },
  "tenmatsu-list": {
    width: 2496,
    height: 830,
    hotspots: [{ x: 25.1, y: 57.6 }, { x: 25.1, y: 47.2 }, { x: 74.8, y: 47.2 }],
  },
  "senketsu-run": {
    width: 2496,
    height: 552,
    hotspots: [{ x: 14.3, y: 38.8 }, { x: 74.9, y: 38.8 }, { x: 90.7, y: 38.8 }],
  },
  "senketsu-list": {
    width: 2496,
    height: 658,
    hotspots: [{ x: 25.6, y: 27.4 }, { x: 83.1, y: 59.6 }, { x: 7.9, y: 27.4 }],
  },
  "natsuin-run": {
    width: 2496,
    height: 608,
    hotspots: [{ x: 51.5, y: 35.2 }, { x: 50, y: 54.9 }],
  },
  "natsuin-list": {
    width: 2496,
    height: 718,
    hotspots: [{ x: 28.9, y: 54.6 }, { x: 84.1, y: 54.6 }, { x: 93.1, y: 86.9 }],
  },
};
