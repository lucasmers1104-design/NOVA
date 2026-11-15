// Where the island sits along the top edge, for dragging it on Island Studio's stage.
// The stage is the top of a screen at its real size (only narrower), so the numbers
// here are the real island's: SIDE_GAP as in island.rs, the offset in real px.

import { type IslandAnchor, LIMITS } from "../types";

/** Gap to the side for the left and right anchors (island.rs `SIDE_GAP`). */
export const SIDE_GAP = 24;
/** Closer than this to an anchor's place (px), the island snaps onto it. */
export const SNAP = 30;

const ANCHORS: readonly IslandAnchor[] = ["left", "center", "right"];

/** The pill's center when it rests at an anchor without an offset. */
export function restCenter(anchor: IslandAnchor, stageWidth: number, pillWidth: number): number {
  if (anchor === "left") return SIDE_GAP + pillWidth / 2;
  if (anchor === "right") return stageWidth - SIDE_GAP - pillWidth / 2;
  return stageWidth / 2;
}

function nearest(center: number, stageWidth: number, pillWidth: number): { anchor: IslandAnchor; distance: number } {
  return ANCHORS.map((anchor) => ({ anchor, distance: center - restCenter(anchor, stageWidth, pillWidth) })).reduce((best, next) => (Math.abs(next.distance) < Math.abs(best.distance) ? next : best));
}

/** While dragging: the center the pill should show, pulled onto an anchor that is close. */
export function magnet(center: number, stageWidth: number, pillWidth: number): { center: number; anchor: IslandAnchor | null } {
  const { anchor, distance } = nearest(center, stageWidth, pillWidth);
  return Math.abs(distance) <= SNAP ? { center: restCenter(anchor, stageWidth, pillWidth), anchor } : { center, anchor: null };
}

/** After letting go: the anchor it belongs to now and how far it is shifted from it. */
export function settle(center: number, stageWidth: number, pillWidth: number): { anchor: IslandAnchor; offset: number } {
  const { anchor, distance } = nearest(center, stageWidth, pillWidth);
  const offset = Math.abs(distance) <= SNAP ? 0 : Math.round(distance);
  return { anchor, offset: Math.min(LIMITS.offset.max, Math.max(LIMITS.offset.min, offset)) };
}

/** Keeps the whole pill on the stage. */
export function clampCenter(center: number, stageWidth: number, pillWidth: number): number {
  return Math.min(Math.max(center, pillWidth / 2), Math.max(pillWidth / 2, stageWidth - pillWidth / 2));
}
