import { AudioClip, AudioSource, Node, resources } from 'cc';

import { GameSoundEvent, resolveGameSound } from './GameSound';

const SOUND_PATHS: Record<GameSoundEvent, string> = {
  'ui-click': 'audio/ui-click',
  card: 'audio/card',
  chip: 'audio/chip',
  settlement: 'audio/settlement',
};

export class GameAudio {
  private readonly source: AudioSource;
  private readonly clips = new Map<GameSoundEvent, AudioClip>();

  public constructor(node: Node, private readonly isSoundEnabled: () => boolean) {
    this.source = node.addComponent(AudioSource);
  }

  public async preload(): Promise<void> {
    await Promise.all((Object.keys(SOUND_PATHS) as GameSoundEvent[]).map(async (event) => {
      const clip = await loadClip(SOUND_PATHS[event]);
      this.clips.set(event, clip);
    }));
  }

  public play(event: GameSoundEvent): void {
    const resolved = resolveGameSound(event, this.isSoundEnabled());
    if (!resolved) {
      return;
    }

    const clip = this.clips.get(resolved);
    if (clip) {
      this.source.playOneShot(clip, resolved === 'settlement' ? 0.8 : 0.55);
    }
  }
}

function loadClip(path: string): Promise<AudioClip> {
  return new Promise((resolve, reject) => {
    resources.load(path, AudioClip, (error, clip) => {
      if (error) {
        reject(error);
      } else {
        resolve(clip);
      }
    });
  });
}
