export interface RaiseBounds {
  minTo: number;
  maxTo: number;
  pot: number;
  toCall: number;
  streetContribution: number;
  step: number;
}

export type RaisePreset = 'minimum' | 'half-pot' | 'pot' | 'all-in';

export function normalizeRaiseTo(candidate: number, bounds: RaiseBounds): number {
  const capped = Math.min(Math.max(Number.isFinite(candidate) ? candidate : bounds.minTo, bounds.minTo), bounds.maxTo);

  if (capped === bounds.maxTo) {
    return capped;
  }

  const stepped = Math.floor(capped / bounds.step) * bounds.step;
  return Math.max(bounds.minTo, stepped);
}

export function chooseRaisePreset(preset: RaisePreset, bounds: RaiseBounds): number {
  const base = bounds.streetContribution + bounds.toCall;
  const candidate = preset === 'minimum' ? bounds.minTo
    : preset === 'half-pot' ? base + bounds.pot / 2
      : preset === 'pot' ? base + bounds.pot
        : bounds.maxTo;

  return normalizeRaiseTo(candidate, bounds);
}
