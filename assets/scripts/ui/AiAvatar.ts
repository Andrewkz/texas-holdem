export interface AiAvatarPreset {
  id: string;
  background: string;
  skin: string;
  hair: string;
  shirt: string;
}

export type AvatarRandomSource = () => number;

export const AI_AVATAR_PRESETS: readonly AiAvatarPreset[] = [
  { id: 'harbor-cap', background: '#286075', skin: '#F1C29D', hair: '#21314D', shirt: '#D67455' },
  { id: 'violet-wave', background: '#47436F', skin: '#D79970', hair: '#1C1D35', shirt: '#8B5CB3' },
  { id: 'forest-curl', background: '#24574C', skin: '#9D6248', hair: '#182521', shirt: '#4AA38B' },
  { id: 'gold-bob', background: '#754C2E', skin: '#F0BB8E', hair: '#D8B44E', shirt: '#C4773E' },
  { id: 'plum-beanie', background: '#4E365D', skin: '#754930', hair: '#251C31', shirt: '#BA6B83' },
  { id: 'coral-sidepart', background: '#6B3E46', skin: '#E5A477', hair: '#3A2631', shirt: '#DD6F6F' },
  { id: 'blue-buzz', background: '#284D72', skin: '#B87556', hair: '#1B2D48', shirt: '#4C8FC4' },
  { id: 'mint-ponytail', background: '#27645B', skin: '#E8B690', hair: '#263132', shirt: '#71C5A5' },
  { id: 'ruby-coil', background: '#693842', skin: '#8F573F', hair: '#3A2026', shirt: '#D05A6F' },
  { id: 'slate-crop', background: '#3F586E', skin: '#E5B58C', hair: '#24323F', shirt: '#8AA7C3' },
];

export function assignAiAvatars(
  aiSeatIds: readonly string[],
  random: AvatarRandomSource = Math.random,
): Map<string, AiAvatarPreset> {
  if (aiSeatIds.length > AI_AVATAR_PRESETS.length) {
    throw new RangeError(`Cannot assign ${aiSeatIds.length} AI seats from ${AI_AVATAR_PRESETS.length} avatars`);
  }

  const shuffled = [...AI_AVATAR_PRESETS];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const targetIndex = Math.min(index, Math.max(0, Math.floor(random() * (index + 1))));
    [shuffled[index], shuffled[targetIndex]] = [shuffled[targetIndex], shuffled[index]];
  }

  return new Map(aiSeatIds.map((id, index) => [id, shuffled[index]]));
}
