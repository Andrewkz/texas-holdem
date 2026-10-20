import { AudioClip, AudioSource, Node, resources } from 'cc';
import { DEFAULT_GAME_SETTINGS } from './GameSettings';
import { GameSoundEvent, SoundPreferences, resolveSoundPlayback } from './GameSound';

const SOUND_PATHS: Record<GameSoundEvent, string> = {
  'ui-click': 'audio/ui-click', card: 'audio/card', chip: 'audio/chip', settlement: 'audio/settlement',
  check: 'audio/check', fold: 'audio/fold', turn: 'audio/turn', 'turn-warning': 'audio/turn-warning',
};
const GESTURE_EVENTS = ['pointerup', 'touchend', 'mouseup', 'keydown'] as const;

export class GameAudio {
  private readonly source: AudioSource;
  private readonly clips = new Map<GameSoundEvent, AudioClip>();
  private unlocked = typeof document === 'undefined';
  private destroyed = false;
  private warmed = false;
  private readonly onGesture = (event: Event): void => {
    if (event.isTrusted) this.unlockFromGesture();
  };

  public constructor(node: Node, private readonly getSettings: () => boolean | SoundPreferences) {
    this.source = node.addComponent(AudioSource);
    if (typeof document !== 'undefined') {
      for (const event of GESTURE_EVENTS) document.addEventListener(event, this.onGesture, true);
    }
  }

  public async preload(): Promise<void> {
    await Promise.all((Object.keys(SOUND_PATHS) as GameSoundEvent[]).map(async event => {
      try {
        const clip = await loadClip(SOUND_PATHS[event]);
        if (!this.destroyed) this.clips.set(event, clip);
      } catch { /* One unavailable optional sound must not disable the other effects. */ }
    }));
  }

  /** Call only from an actual user gesture. Silent warm-up unlocks Cocos, including DOM settings gestures. */
  public unlockFromGesture(): void {
    if (this.destroyed) return;
    this.unlocked = true;
    const clip = this.clips.get('ui-click');
    if (!this.warmed && clip && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) {
      this.warmed = true;
      this.source.playOneShot(clip, 0);
    }
  }

  public play(event: GameSoundEvent): void {
    if (this.destroyed || !this.unlocked || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
    const preferences = this.getSettings();
    const settings = typeof preferences === 'boolean' ? { ...DEFAULT_GAME_SETTINGS, soundEnabled: preferences } : preferences;
    const playback = resolveSoundPlayback(event, settings);
    const clip = playback && this.clips.get(playback.event);
    if (playback && clip) this.source.playOneShot(clip, playback.volume);
    // Missing clips and browser-blocked events are intentionally never queued for later playback.
  }

  public destroy(): void {
    this.destroyed = true;
    this.clips.clear();
    if (typeof document !== 'undefined') {
      for (const event of GESTURE_EVENTS) document.removeEventListener(event, this.onGesture, true);
    }
  }
}

function loadClip(path: string): Promise<AudioClip> {
  return new Promise((resolve, reject) => {
    resources.load(path, AudioClip, (error, clip) => error ? reject(error) : resolve(clip));
  });
}
