import { describe, expect, it, vi } from 'vitest';

import { AI_AVATAR_PRESETS, assignAiAvatars } from '../../assets/scripts/ui/AiAvatar';

const AI_SEAT_IDS = ['ai-1', 'ai-2', 'ai-3', 'ai-4', 'ai-5'];

describe('AI avatars', () => {
  it('provides exactly ten visually distinct portrait presets', () => {
    expect(AI_AVATAR_PRESETS).toHaveLength(10);
    expect(new Set(AI_AVATAR_PRESETS.map(({ id }) => id))).toHaveLength(10);
    expect(new Set(AI_AVATAR_PRESETS.map(({ background, hair }) => `${background}:${hair}`))).toHaveLength(10);
  });

  it('assigns five different catalogue portraits to the five AI seats', () => {
    const assignments = assignAiAvatars(AI_SEAT_IDS, () => 0.42);

    expect([...assignments.keys()]).toEqual(AI_SEAT_IDS);
    expect(new Set([...assignments.values()].map(({ id }) => id))).toHaveLength(5);
    expect([...assignments.values()].every((avatar) => AI_AVATAR_PRESETS.includes(avatar))).toBe(true);
  });

  it('repeats the same assignment for the same injected startup random source', () => {
    const random = vi.fn(() => 0.2);

    const firstStartup = assignAiAvatars(AI_SEAT_IDS, random);
    const secondStartup = assignAiAvatars(AI_SEAT_IDS, () => 0.2);

    expect([...firstStartup.entries()]).toEqual([...secondStartup.entries()]);
    expect(random).toHaveBeenCalled();
  });
});
