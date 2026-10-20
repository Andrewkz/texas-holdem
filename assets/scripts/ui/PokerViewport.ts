export interface PokerViewport {
  designWidth: number;
  designHeight: number;
  actionHeight: number;
  compact: boolean;
}

/** Dimensions are CSS pixels after outer safe-area and page insets. */
export function getPokerViewport(width: number, height: number): PokerViewport {
  const w = Number.isFinite(width) && width > 0 ? width : 1280;
  const h = Number.isFinite(height) && height > 0 ? height : 720;
  const compact = w < 1100 && w > h;
  const designHeight = compact ? Math.max(560, Math.min(900, 1280 * h / w)) : 720;
  const scale = Math.min(w / 1280, h / designHeight, 1);
  return { designWidth: 1280, designHeight, actionHeight: w > h ? Math.max(44, Math.ceil(44 / scale)) : 44, compact };
}
