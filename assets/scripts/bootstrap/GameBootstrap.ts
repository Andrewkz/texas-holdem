import {
  _decorator,
  Color,
  Camera,
  director,
  Button,
  BlockInputEvents,
  Component,
  EditBox,
  Graphics,
  Label,
  Node,
  sys,
  tween,
  Tween,
  UIOpacity,
  UITransform,
  Vec3,
  view,
} from 'cc';

import { chooseAiAction } from '../ai/AiController';
import { AiProfile, createAiTableProfiles, DEFAULT_AI_PROFILE, getAiThinkDelay } from '../ai/AiPersonality';
import { createWinProbabilityTask, WinProbabilityTask } from '../ai/WinProbability';
import { PokerEngine } from '../core/PokerEngine';
import { BlindConfig, normalizeBlinds } from '../core/Blinds';
import { BlindSettingsPanel } from '../ui/BlindSettingsPanel';
import { attachPlayerPortrait } from '../ui/PlayerPortrait';
import { attachTableSurface } from '../ui/TableSurface';
import { formatSeatName, formatTableChips, getActionPresentation } from '../ui/TablePresentation';
import { getSeatBetStatus, SeatBetStatus } from '../ui/SeatBetStatus';
import { PokerChipView } from '../ui/PokerChipView';
import { getChipPilePosition, getPotChipPilePosition } from '../ui/PokerChipModel';
import { Card, EngineEvent, EngineSnapshot, PlayerAction, Street } from '../core/types';
import { NetClient } from '../net/NetClient';
import { clearPendingAdmission, deactivateOnlineCredentials, findOnlineCredentials, highEntropyId, listOnlineCredentials, loadOnlineCredentials, OnlineCredentials, PendingAdmission, prepareAdmission, resolveServerUrl, saveOnlineCredentials } from '../net/OnlineCredentials';
import { OnlineCommands } from '../net/OnlineCommands';
import type { CommandResult, CommandType, FinalSettlement, LedgerSnapshot, RecoveryNotice } from '../net/SessionTypes';
import { ConnectionStatus, OnlineSession, TableUpdate } from '../net/OnlineSession';
import { RoomStateMessage, ServerMessage, TableParticipation } from '../net/protocol';
import { parseRoomInvite, createRoomInvite } from '../net/RoomInvite';
import { chooseEntryIntent } from '../net/OnlineEntry';
import { getPokerViewport, PokerViewport } from '../ui/PokerViewport';
import {
  getActionButtonSpecs,
  getPokerSeatLayout,
  POKER_RAISE_MODAL,
  POKER_SHOWDOWN_FEEDBACK,
  POKER_UI,
} from '../ui/PokerUiTheme';
import { AiAvatarPreset, assignAiAvatars } from '../ui/AiAvatar';
import { GameAudio } from '../ui/GameAudio';
import { TurnSoundGate } from '../ui/GameSound';
import { SoundPanel } from '../ui/SoundPanel';
import { BettingPanel, BettingContext } from '../ui/BettingPanel';
import { AnimationSpeed, DEFAULT_GAME_SETTINGS, GameSettings, loadGameSettings, saveGameSettings, scaleDuration } from '../ui/GameSettings';
import { createHomeFlow, HomeFlowState, reduceHomeFlow } from '../ui/HomeFlow';
import { chooseRaisePreset, normalizeRaiseTo, RaiseBounds, RaisePreset } from '../ui/RaiseAmount';
import { SessionGeneration } from '../ui/SessionGeneration';
import { SoloTurnClock } from '../ui/SoloTurnClock';
import { fromSoloBlindEvents, HandPositions } from '../ui/BlindPositions';
import { validateOnlineForm } from '../ui/OnlineForm';
import { acknowledgeAdmission } from '../ui/OnlineAdmission';
import { countLobbyStartPlayers } from '../ui/OnlineLobby';
import { SessionPanels, SessionPanelContext } from '../ui/SessionPanels';
import { createSettlementLink } from '../ui/SettlementLink';
import { copyLink } from '../ui/CopyLink';
import { buildHandResult, HandResult } from '../ui/HandResultModel';
import { HandResultPanel } from '../ui/HandResultPanel';

const { ccclass } = _decorator;

interface CardVisual {
  node: Node;
  front: Node;
  back: Node;
  rank: Label;
  suit: Label;
  home: Vec3;
}

interface SeatVisual {
  id: string;
  node: Node;
  name: Label;
  chips: Label;
  action: Label;
  actionBadge: Node;
  statusTone: string;
  dealer: Label;
  highlight: Node;
  cards: CardVisual[];
  position: Vec3;
  nextCard: number;
  timerNode: Node;
  timerGraphics: Graphics;
  timerLabel: Label;
}

interface ActionVisual {
  node: Node;
  label: Label;
  detail: Label;
  action: PlayerAction | null;
  onPress: (() => void) | null;
}

const BACKGROUND = colorHex(POKER_UI.colors.background);
const PANEL = colorHex(POKER_UI.colors.panel);
const PANEL_RAISED = colorHex(POKER_UI.colors.panelRaised);
const TABLE_GREEN = colorHex(POKER_UI.colors.felt);
const GOLD = colorHex(POKER_UI.colors.gold);
const TEXT = colorHex(POKER_UI.colors.text);
const MUTED = colorHex('#9BAEAC');
const BORDER = colorHex('#34474A');
const PRIMARY = colorHex('#26745A');
const NEUTRAL = colorHex('#2B4548');

@ccclass('GameBootstrap')
export class GameBootstrap extends Component {
  private engine = PokerEngine.createSixSeat();
  private aiProfiles = new Map<string, AiProfile>();
  private flow: HomeFlowState = createHomeFlow();
  private settings: GameSettings = { ...DEFAULT_GAME_SETTINGS };
  private readonly sessions = new SessionGeneration();
  private activeSessionToken = 0;
  private audio!: GameAudio;
  private soundPanel: SoundPanel | null = null;
  private bettingPanel: BettingPanel | null = null;
  private blindSettingsPanel: BlindSettingsPanel | null = null;
  private readonly turnSounds = new TurnSoundGate();
  private readonly settlementSounds = new Set<string>();
  private muteLabel!: Label;
  private tableLayer!: Node;
  private homeLayer!: Node;
  private homeOpacity!: UIOpacity;
  private rulesPanel!: Node;
  private settingsPanel!: Node;
  private returnOverlay!: Node;
  private returnPanel!: Node;
  private settingsSoundLabel!: Label;
  private settingsSpeedLabel!: Label;
  private settingsConfirmLabel!: Label;
  private settingsBlindsLabel!: Label;
  private onlineBlindsLabel!: Label;
  private readonly transientNodes = new Set<Node>();
  private readonly seats = new Map<string, SeatVisual>();
  private handPositions: HandPositions | null = null;
  private readonly seatActions = new Map<string, PlayerAction>();
  private seatActionStreet: Street | null = null;
  private thinkingSeatId: string | null = null;
  private readonly positionBadges = new Map<string, { node: Node; label: Label }>();
  private readonly aiAvatars = assignAiAvatars(
    getPokerSeatLayout().filter(({ id }) => id !== 'player').map(({ id }) => id),
  );
  private readonly communityCards: CardVisual[] = [];
  private readonly actionButtons: ActionVisual[] = [];
  private potLabel!: Label;
  private tableChips!: PokerChipView;
  private streetLabel!: Label;
  private resultLabel!: Label;
  private handResultPanel: HandResultPanel | null = null;
  private lastHandResult: HandResult | null = null;
  private handAwards: Extract<EngineEvent, { type: 'pot-awarded' }>[] = [];
  private soloOpeningStack = 0;
  private soloRestartHandler: (() => void) | null = null;
  private winProbabilityPanel!: Node;
  private winProbabilityLabel!: Label;
  private winProbabilityNote!: Label;
  private winProbabilityKey = '';
  private winProbabilityGeneration = 0;
  private winProbabilityTask: WinProbabilityTask | null = null;
  private winProbabilityTimer: ReturnType<typeof setTimeout> | null = null;
  private turnLabel!: Label;
  private turnTimer!: Node;
  private turnTimerLabel!: Label;
  private turnTimerProgress!: Graphics;
  private turnTimerKey = '';
  private readonly soloTurnClock = new SoloTurnClock();
  private soloActionSequence = 0;
  private soloTimeoutKey = '';
  private soloTurnTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly soloVisibilityHandler = () => {
    if (document.visibilityState === 'visible') this.processSoloTurnTimeout();
  };
  private raiseDetailLabel!: Label;
  private raiseConfirmButton!: Node;
  private onlineCreateButton!: Node;
  private onlineJoinButton!: Node;
  private raiseOverlay!: Node;
  private raisePanel!: Node;
  private raiseAmountLabel!: Label;
  private raiseInput!: EditBox;
  private selectedRaiseTo = 0;
  private busy = false;
  private winnerId: string | null = null;
  private onlineLayer!: Node;
  private onlinePanel!: Node;
  private onlineNicknameInput!: EditBox;
  private onlineServerInput!: EditBox;
  private onlineRoomCodeInput!: EditBox;
  private onlineStatusLabel!: Label;
  private lobbyLayer!: Node;
  private lobbyCodeLabel!: Label;
  private lobbySeatLabels: Label[] = [];
  private lobbyStartButton!: Node;
  private lobbyStatusLabel!: Label;
  private online: OnlineSession | null = null;
  private pendingClient: NetClient | null = null;
  private onlinePlayerId = '';
  private mode: 'solo' | 'online' = 'solo';
  private onlineSnapshot: EngineSnapshot | null = null;
  private connectingOnline = false;
  private entryGeneration = 0;
  private lastOnlineRoom: RoomStateMessage | null = null;
  private activeCredentials: OnlineCredentials | null = null;
  private participation: TableParticipation = 'waiting-next-hand';
  private connectionStatus: ConnectionStatus = 'connecting';
  private readonly motion = new Map<Node, () => void>();
  private readonly delays = new Map<ReturnType<typeof setTimeout>, () => void>();
  private viewport: PokerViewport = getPokerViewport(1280, 720);
  private viewportWidth = 0;
  private readonly boxes = new Map<Node, { width: number; height: number; radius: number; color: Color; stroke?: Color; line: number }>();
  private readonly originalPositions = new Map<Node, Vec3>();
  private readonly originalFonts = new Map<Label, number>();
  private shareDialog: HTMLElement | null = null;
  private keyboardToolbar: HTMLElement | null = null;
  private sessionPanels: SessionPanels | null = null;
  private sessionLedger: LedgerSnapshot | null = null;
  private finalSettlement: FinalSettlement | null = null;
  private commandBusy = false;
  private recoveryText = '';
  private rejoinCandidate: OnlineCredentials | null = null;
  private readonly pendingRejoins = new Map<string, string>();
  private readonly unknownCommands = new Map<string, { command: CommandType; credentials: OnlineCredentials }>();
  private readonly keyboardPositionHandler = () => this.updateKeyboardToolbar();
  private readonly resizeHandler = () => { this.updateKeyboardToolbar(); this.applyViewport(); };
  private readonly focusHandler = (event: FocusEvent) => {
    if (sys.isBrowser && this.viewport.compact && event.target instanceof HTMLInputElement && !event.target.readOnly && ['range','checkbox','button'].indexOf(event.target.type) < 0) { document.body.classList.add('keyboard-open'); this.updateKeyboardToolbar(); }
  };
  private readonly blurHandler = () => { if (sys.isBrowser) { document.body.classList.remove('keyboard-open'); this.keyboardToolbar?.remove(); this.keyboardToolbar=null; requestAnimationFrame(this.resizeHandler); } };

  public onLoad(): void {
    view.setDesignResolutionSize(1280, 720, 4);
    this.settings = loadGameSettings(sys.localStorage);
    this.audio = new GameAudio(this.node, () => this.settings);
    void this.audio.preload().catch(() => undefined);
    this.buildTable();
    void this.tableChips.preload().catch(error => console.warn('筹码素材加载失败', error));
    this.buildHome();
    this.buildOnlineSetup();
    this.buildLobby();
    if (sys.isBrowser) {
      this.soundPanel = new SoundPanel({
        getSettings: () => this.settings,
        onChange: (patch) => this.updateSettings(patch),
        onClose: () => this.closeHomeModal(),
        canConfigureBlinds: () => this.flow.screen === 'settings' && !this.tableLayer.active,
        onBlinds: () => this.openBlindSettings(),
      });
      this.handResultPanel = new HandResultPanel({
        onClose: () => {},
        onInteract: () => this.audio.play('ui-click'),
      });
      this.bettingPanel = new BettingPanel({
        getState: () => this.bettingContext(),
        onConfirm: (action) => { void this.handlePlayerAction(action); },
        onClose: () => { if (this.tableLayer.active) this.render(this.currentSnapshot()); },
        onInteract: () => this.audio.play('ui-click'),
      });
    }
    if (sys.isBrowser) this.sessionPanels = new SessionPanels({
      onRebuy: () => { void this.performSessionCommand('rebuy'); },
      onRequestEnd: () => { void this.performSessionCommand('requestEnd'); },
      onRejoin: () => this.requestOriginalSession(),
      onRetryCommand: (requestId) => { void this.querySessionCommand(requestId); },
      onClose: () => this.closeSessionPanel(),
      onInteract: () => this.audio.play('ui-click'),
    });
    this.onlineLayer.active = false;
    this.lobbyLayer.active = false;
    this.tableLayer.active = false;
    this.renderHome();
    this.captureLayout(this.node);
    this.applyViewport();
    if (sys.isBrowser) {
      window.addEventListener('resize', this.resizeHandler);
      window.addEventListener('orientationchange', this.resizeHandler);
      document.addEventListener('focusin', this.focusHandler);
      document.addEventListener('focusout', this.blurHandler);
      document.addEventListener('visibilitychange', this.soloVisibilityHandler);
      window.visualViewport?.addEventListener('resize', this.resizeHandler);
      window.visualViewport?.addEventListener('scroll', this.keyboardPositionHandler);
      window.addEventListener('scroll', this.keyboardPositionHandler);
    }
    this.startOnlineEntry();
  }

  public onDestroy(): void {
    this.entryGeneration += 1;
    this.sessions.invalidate();
    this.clearSoloRestart();
    this.clearWinProbability();
    this.clearSoloTurnClock();
    this.pendingClient?.close();
    this.online?.dispose();
    this.cancelVisuals();
    this.shareDialog?.remove();
    this.sessionPanels?.destroy();
    this.soundPanel?.destroy();
    this.bettingPanel?.destroy();
    this.handResultPanel?.destroy();
    this.blindSettingsPanel?.destroy();
    this.audio?.destroy();
    this.tableChips?.destroy();
    this.keyboardToolbar?.remove();
    if (sys.isBrowser) {
      window.removeEventListener('resize', this.resizeHandler);
      window.removeEventListener('orientationchange', this.resizeHandler);
      window.visualViewport?.removeEventListener('resize', this.resizeHandler);
      window.visualViewport?.removeEventListener('scroll', this.keyboardPositionHandler);
      window.removeEventListener('scroll', this.keyboardPositionHandler);
      document.removeEventListener('focusin', this.focusHandler);
      document.removeEventListener('focusout', this.blurHandler);
      document.removeEventListener('visibilitychange', this.soloVisibilityHandler);
      document.body.classList.remove('keyboard-open');
    }
  }

  public update(): void {
    this.processSoloTurnTimeout();
    this.bettingPanel?.update();
    this.renderTurnTimer();
    if (this.handResultPanel?.isOpen && (this.mode === 'online' ? this.online?.canAct() : !this.busy && this.engine.snapshot().actingPlayerId === 'player' && this.engine.snapshot().street !== 'settled')) this.handResultPanel.close();
  }

  private bettingContext(): BettingContext {
    const state = this.currentSnapshot();
    const player = state.players.find(p => p.id === 'player');
    const clock = this.mode === 'solo' ? this.soloTurnClock.read() : this.online?.getTurnCountdown();
    return {
      turnCountdown: clock?.playerId === 'player' && clock.handId === state.handId && state.actingPlayerId === 'player' ? clock : null,
      timeoutAction: state.legalActions.some(a => a.type === 'check') ? 'check' : 'fold',
      authorityKey: JSON.stringify([this.mode, this.activeSessionToken, this.activeCredentials?.sessionId, this.lastOnlineRoom?.session.tableEpoch, state.handId, state.street, state.actingPlayerId, state.legalActions, this.mode === 'solo' ? this.soloActionSequence : null]),
      canAct: this.flow.screen === 'playing' && state.actingPlayerId === 'player' && this.sessions.isCurrent(this.activeSessionToken) && (this.mode === 'online' ? Boolean(this.online?.canAct()) : this.soloTurnClock.read()?.seconds !== 0),
      busy: this.busy,
      bounds: this.hasLegalRaise() ? this.getRaiseBounds() : null,
      canAllIn: state.legalActions.some(a => a.type === 'all-in'),
      allInAmount: player?.stack ?? 0,
    };
  }

  private renderTurnTimer(): void {
    if (!this.turnTimer) return;
    const online = this.mode === 'online' && this.connectionStatus === 'connected'
      && this.tableLayer.active && !this.finalSettlement ? this.online?.getTurnCountdown() : null;
    const clock = this.mode === 'solo' ? this.soloTurnClock.read() : online;
    const state = this.mode === 'solo' ? this.engine.snapshot() : this.onlineSnapshot;
    const visible = Boolean(clock && this.tableLayer.active && (this.mode === 'online' || !this.busy) && state?.handId === clock.handId
      && state?.actingPlayerId === clock.playerId && state?.street !== 'settled');
    this.turnTimer.active = false;
    this.turnLabel.node.setPosition(0, this.turnLabel.node.position.y, 0);
    this.turnLabel.node.getComponent(UITransform)!.setContentSize(1100, this.turnLabel.node.getComponent(UITransform)!.height);
    this.seats.forEach(seat => seat.timerNode.active = visible && seat.id === clock?.playerId);
    const canAlert = this.settings.soundEnabled && this.settings.soundVolume > 0 && this.settings.actionAlertsEnabled
      && (!sys.isBrowser || document.visibilityState === 'visible');
    const sound = this.turnSounds.read({
      turnKey: visible && clock ? this.mode === 'solo' ? `solo:${this.activeSessionToken}:${this.soloActionSequence}:${clock.handId}:${clock.deadlineAt}`
        : `${this.activeCredentials?.sessionId}:${this.lastOnlineRoom?.session.tableEpoch}:${clock.handId}:${clock.playerId}:${clock.deadlineAt}` : null,
      isOwnTurn: clock?.playerId === 'player',
      seconds: clock?.seconds ?? 30,
      canAlert: canAlert && visible,
    });
    if (sound) this.audio.play(sound);
    if (!visible || !clock) { this.turnTimerKey = ''; return; }
    const key = `${clock.handId}:${clock.playerId}:${clock.seconds}:${Math.floor(clock.fraction * 200)}:${this.viewportWidth}`;
    if (key === this.turnTimerKey) return;
    this.turnTimerKey = key;
    const seat = this.seats.get(clock.playerId);
    if (!seat) return;
    const scale = sys.isBrowser ? document.querySelector('canvas')!.getBoundingClientRect().height / this.viewport.designHeight : 1;
    const radius = this.viewport.compact ? 33 : 30;
    const color = clock.urgent ? colorHex('#D36A68') : GOLD;
    seat.timerLabel.string = String(clock.seconds);
    seat.timerLabel.color = color;
    seat.timerLabel.fontSize = this.viewport.compact ? Math.ceil(11 / Math.max(scale, 0.25)) : 14;
    const g = seat.timerGraphics;
    g.clear();
    g.strokeColor = BORDER; g.lineWidth = this.viewport.compact ? 3 / Math.max(scale, 0.25) : 3;
    g.circle(0, 0, radius); g.stroke();
    if (clock.fraction > 0) { g.strokeColor = color; g.arc(0, 0, radius, Math.PI / 2, Math.PI / 2 - Math.PI * 2 * clock.fraction, false); g.stroke(); }
  }

  private clearSoloTurnClock(): void {
    if (this.soloTurnTimeout !== null) clearTimeout(this.soloTurnTimeout);
    this.soloTurnTimeout = null;
    this.soloTimeoutKey = '';
    this.soloTurnClock.clear();
  }

  private syncSoloTurnClock(state: EngineSnapshot): void {
    if (this.mode !== 'solo' || !this.sessions.isCurrent(this.activeSessionToken) || !this.tableLayer.active || this.busy
      || ['playing', 'return-confirmation'].indexOf(this.flow.screen) < 0 || state.actingPlayerId !== 'player'
      || state.street === 'settled' || state.street === 'showdown') {
      this.clearSoloTurnClock(); return;
    }
    const key = `${this.activeSessionToken}:${state.handId}:${this.soloActionSequence}`;
    this.soloTurnClock.sync(key, state.handId, state.legalActions);
    if (key !== this.soloTimeoutKey) {
      if (this.soloTurnTimeout !== null) clearTimeout(this.soloTurnTimeout);
      this.soloTimeoutKey = key;
      const clock = this.soloTurnClock.read()!;
      const token = this.activeSessionToken;
      this.soloTurnTimeout = setTimeout(() => {
        if (key !== this.soloTimeoutKey || !this.sessions.isCurrent(token)) return;
        this.soloTurnTimeout = null;
        this.processSoloTurnTimeout();
      }, Math.max(0, clock.deadlineAt - Date.now()));
    }
  }

  private processSoloTurnTimeout(): void {
    if (this.mode !== 'solo') return;
    this.syncSoloTurnClock(this.engine.snapshot());
    const action = this.soloTurnClock.takeExpiredAction();
    if (action) void this.handlePlayerAction(action);
  }

  private buildTable(): void {
    this.tableLayer = new Node('table-layer');
    this.node.addChild(this.tableLayer);
    this.tableLayer.addComponent(UITransform).setContentSize(POKER_UI.canvas.width, POKER_UI.canvas.height);
    this.createRounded('background', this.tableLayer, 0, 0, POKER_UI.canvas.width, POKER_UI.canvas.height, 0, BACKGROUND);
    this.createRounded('top-bar', this.tableLayer, 0, 323, 1180, 62, POKER_UI.radii.panel, colorHex('#142125'), colorHex('#30413D'), 1);
    this.createLabel(this.tableLayer, 'POKER CLUB', -525, 323, 21, GOLD);
    this.streetLabel = this.createLabel(this.tableLayer, '盲注 20 / 40 · 翻牌前', -100, 323, 16, colorHex('#C3D1CA'));
    this.createLabel(this.tableLayer, '虚拟筹码', 288, 323, 14, MUTED).node.name = 'virtual-chips-label';

    this.createTableFelt();
    this.createDeckMarker();
    const potPanel = this.createRounded('pot-panel', this.tableLayer, 0, 92, 220, 40, 12, colorHex('#102D27'), colorHex('#9A865B'), 1);
    this.potLabel = this.createLabel(potPanel, '总底池 0', 0, 0, 22, GOLD);
    this.potLabel.node.getComponent(UITransform)!.setContentSize(208, 34);
    this.potLabel.overflow = Label.Overflow.SHRINK;

    this.tableChips = new PokerChipView(this.tableLayer);

    [-112, -56, 0, 56, 112].forEach((x, index) => {
      const slot = this.createRounded(`community-slot-${index}`, this.tableLayer, x, 8, 52, 68, POKER_UI.radii.card, colorHex('#15382F'), colorHex('#486557'), 1);
      const number = this.createLabel(slot, `0${index + 1}`, 0, 0, 13, colorHex('#6B8C7D'));
      number.node.getComponent(UITransform)!.setContentSize(46, 30);
      number.overflow = Label.Overflow.SHRINK;
      const card = this.createCard(this.tableLayer, new Vec3(x, 8, 0));
      card.node.active = false;
      this.communityCards[index] = card;
    });

    this.createSeats();
    this.winProbabilityPanel = this.createRounded('win-probability-panel', this.tableLayer, 270, -210, 300, 76, 12, PANEL_RAISED, BORDER, 1);
    this.winProbabilityLabel = this.createLabel(this.winProbabilityPanel, '', 0, 13, 16, GOLD);
    this.winProbabilityLabel.node.name = 'win-probability-value';
    this.winProbabilityNote = this.createLabel(this.winProbabilityPanel, '', 0, -16, 12, MUTED);
    this.winProbabilityNote.node.name = 'win-probability-note';
    for (const label of [this.winProbabilityLabel, this.winProbabilityNote]) {
      label.node.getComponent(UITransform)!.setContentSize(280, 30);
      label.overflow = Label.Overflow.SHRINK;
    }
    this.winProbabilityPanel.active = false;
    this.createActionBar();
    this.seats.forEach(seat => seat.node.setSiblingIndex(this.tableLayer.children.length - 1));
    this.winProbabilityPanel.setSiblingIndex(this.tableLayer.children.length - 1);
    const positionLayer = new Node('position-badge-layer');
    this.tableLayer.addChild(positionLayer);
    positionLayer.addComponent(UITransform).setContentSize(1280, 720);
    this.seats.forEach((_seat, id) => {
      const node = this.createRounded(`position-badge-${id}`, positionLayer, 0, 0, 118, 32, 10, PANEL_RAISED, GOLD, 1);
      const label = this.createLabel(node, '', 0, 0, 15, TEXT);
      label.node.name = 'position-badge-text';
      label.overflow = Label.Overflow.SHRINK;
      node.active = false;
      this.positionBadges.set(id, { node, label });
    });
    this.createReturnHomeControl();
    this.createRaisePanel();
    this.returnOverlay.setSiblingIndex(this.tableLayer.children.length - 1);
    this.resultLabel = this.createLabel(this.tableLayer, '', 0, -62, 19, GOLD);
    this.resultLabel.node.active = false;
    this.resultLabel.node.setSiblingIndex(this.raiseOverlay.getSiblingIndex());
  }

  private createTableFelt(): void {
    const rim = new Node('table-rim');
    this.tableLayer.addChild(rim);
    rim.addComponent(UITransform).setContentSize(1040, 480);
    const rimGraphics = rim.addComponent(Graphics);
    rimGraphics.fillColor = colorHex('#242725');
    rimGraphics.ellipse(0, 4, 520, 240);
    rimGraphics.fill();
    rimGraphics.fillColor = colorHex('#514B3D');
    rimGraphics.ellipse(0, 4, 507, 227);
    rimGraphics.fill();
    rimGraphics.strokeColor = colorHex('#86785A');
    rimGraphics.lineWidth = 1.5;
    rimGraphics.ellipse(0, 4, 500, 220);
    rimGraphics.stroke();

    const felt = new Node('felt');
    this.tableLayer.addChild(felt);
    felt.addComponent(UITransform).setContentSize(970, 420);
    const feltGraphics = felt.addComponent(Graphics);
    feltGraphics.fillColor = TABLE_GREEN;
    feltGraphics.ellipse(0, 4, 485, 210);
    feltGraphics.fill();
    attachTableSurface(felt);
    feltGraphics.strokeColor = colorHex('#71846B');
    feltGraphics.lineWidth = 1;
    feltGraphics.ellipse(0, 4, 446, 178);
    feltGraphics.stroke();
  }

  private createDeckMarker(): void {
    const marker = this.createRounded('deck', this.tableLayer, 0, 152, 48, 66, POKER_UI.radii.card, PANEL_RAISED, GOLD, 1);
    this.createLabel(marker, '♠', 0, 0, 26, MUTED);
    marker.active = false;
  }

  private createSeats(): void {
    for (const { id, x, y, name } of getPokerSeatLayout()) {
      const isPlayer = id === 'player';
      const node = this.createRounded(
        `seat-${id}`,
        this.tableLayer,
        x,
        y,
        220,
        84,
        POKER_UI.radii.seat,
        PANEL,
        BORDER,
        1,
      );
      const opacity = node.addComponent(UIOpacity);
      opacity.opacity = 255;
      const highlight = this.createRounded('seat-highlight', node, 0, 0, 216, 80, 14, new Color(0, 0, 0, 0), GOLD, 2);
      highlight.active = isPlayer;
      const avatar = this.createRounded('seat-avatar', node, -77, 0, 52, 52, 26, PANEL_RAISED);
      const portraitIndex = isPlayer ? 6 : Number(id.slice(-1));
      attachPlayerPortrait(avatar, portraitIndex);
      const nameLabel = this.createLabel(node, name, 26, 23, 14, MUTED);
      const chips = this.createLabel(node, '5,000', 26, 0, 19, TEXT);
      const actionBadge = this.createRounded('seat-action-status', node, 26, -26, 150, 26, 6, colorHex('#22363A'), colorHex('#536968'), 1);
      const action = this.createLabel(actionBadge, '待行动', 0, 0, 14, TEXT); action.isBold = true;
      for (const label of [nameLabel, chips, action]) {
        label.node.getComponent(UITransform)!.setContentSize(144, 26);
        label.overflow = Label.Overflow.SHRINK;
      }
      action.node.getComponent(UITransform)!.setContentSize(140, 24);
      const dealer = this.createLabel(node, '', 66, 20, 11, GOLD);
      const cardY = isPlayer ? y + 90 : y - 84;
      const cards = [
        this.createCard(this.tableLayer, new Vec3(x - 29, cardY, 0)),
        this.createCard(this.tableLayer, new Vec3(x + 29, cardY, 0)),
      ];
      cards.forEach((card) => card.node.active = false);
      const timerNode = new Node('avatar-countdown'); node.addChild(timerNode);
      timerNode.setPosition(-77, 0, 0); timerNode.addComponent(UITransform).setContentSize(68, 68);
      const timerGraphics = timerNode.addComponent(Graphics);
      const timerCapsule = this.createRounded('countdown-number', timerNode, 0, -30, 38, 24, 10, PANEL, GOLD, 1);
      const timerLabel = this.createLabel(timerCapsule, '', 0, 0, 14, GOLD);
      timerLabel.node.getComponent(UITransform)!.setContentSize(36, 24); timerNode.active = false;
      if (!isPlayer) { const initial = this.createLabel(avatar, '', 0, 0, 12, MUTED); initial.node.name = 'online-initial'; initial.node.active = false; }
      this.seats.set(id, { id, node, name: nameLabel, chips, action, actionBadge, statusTone: '', dealer, highlight, cards, position: new Vec3(x, y, 0), nextCard: 0, timerNode, timerGraphics, timerLabel });
    }
  }

  private drawAiAvatar(parent: Node, avatar: AiAvatarPreset): void {
    const portrait = new Node(`portrait-${avatar.id}`);
    parent.addChild(portrait);
    portrait.addComponent(UITransform).setContentSize(32, 32);
    const graphics = portrait.addComponent(Graphics);

    graphics.fillColor = colorHex(avatar.background);
    graphics.circle(0, 0, 15);
    graphics.fill();

    graphics.fillColor = colorHex(avatar.shirt);
    graphics.circle(0, -13, 11);
    graphics.fill();

    graphics.fillColor = colorHex(avatar.hair);
    graphics.circle(0, 5, 9);
    graphics.fill();

    graphics.fillColor = colorHex(avatar.skin);
    graphics.circle(0, 3, 7.5);
    graphics.fill();

    graphics.fillColor = colorHex(avatar.hair);
    graphics.rect(-7, 7, 14, 3.5);
    graphics.fill();

    graphics.fillColor = BACKGROUND;
    graphics.circle(-2.7, 3, 0.8);
    graphics.circle(2.7, 3, 0.8);
    graphics.fill();
  }

  private createActionBar(): void {
    // Reserve a separate status line above the four stable action positions.
    const actionBarY = -316;
    this.createRounded('action-bar', this.tableLayer, 0, -306, 1180, 84, POKER_UI.radii.panel, colorHex('#132226'), colorHex('#2B403A'), 1);
    this.turnLabel = this.createLabel(this.tableLayer, '正在准备牌局…', 0, -278, 14, MUTED);
    this.turnLabel.overflow = Label.Overflow.SHRINK;
    this.turnTimer = this.createRounded('turn-timer', this.tableLayer, 414, -276, 240, 36, 10, PANEL_RAISED);
    this.turnTimerLabel = this.createLabel(this.turnTimer, '', 0, 3, 17, GOLD);
    this.turnTimerLabel.node.name = 'turn-timer-label';
    this.turnTimerLabel.node.getComponent(UITransform)!.setContentSize(224, 26);
    this.turnTimerLabel.overflow = Label.Overflow.SHRINK;
    const timerProgress = new Node('turn-timer-progress');
    this.turnTimer.addChild(timerProgress);
    timerProgress.addComponent(UITransform).setContentSize(208, 4);
    this.turnTimerProgress = timerProgress.addComponent(Graphics);
    this.turnTimer.active = false;
    const actionSpecs = getActionButtonSpecs();

    [-405, -135, 135, 405].forEach((x, index) => {
      const node = this.createRounded(
        `action-${index}`,
        this.tableLayer,
        x,
        actionBarY,
        252,
        58,
        11,
        colorHex(actionSpecs[index].color),
        colorHex(index === 2 ? '#E9D4A4' : index === 3 ? '#89684C' : '#3C5550'),
        1,
      );
      const label = this.createLabel(node, ['弃牌', '过牌 / 跟注', '加注', '全压'][index], 0, 11, 16, TEXT);
      const detail = this.createLabel(node, '等待行动', 0, -13, 12, TEXT);
      label.node.getComponent(UITransform)!.setContentSize(230, 25);
      detail.node.getComponent(UITransform)!.setContentSize(230, 23);
      label.overflow = detail.overflow = Label.Overflow.SHRINK;
      this.addButtonFeedback(node);
      const button: ActionVisual = { node, label, detail, action: null, onPress: null };
      node.on(Button.EventType.CLICK, () => {
        this.audio.play('ui-click');
        if (button.onPress) {
          button.onPress();
        } else if (button.action) {
          void this.handlePlayerAction(button.action);
        }
      });
      this.setButtonEnabled(node, false);
      this.actionButtons.push(button);
    });
  }

  private createRaisePanel(): void {
    this.raiseOverlay = this.createRounded('raise-overlay', this.tableLayer, 0, 0, POKER_UI.canvas.width, POKER_UI.canvas.height, 0, new Color(4, 13, 28, 184));
    this.raiseOverlay.addComponent(UIOpacity);
    this.raiseOverlay.addComponent(BlockInputEvents);
    this.raiseOverlay.active = false;

    this.raisePanel = this.createRounded(
      'raise-panel',
      this.tableLayer,
      0,
      POKER_RAISE_MODAL.y,
      POKER_RAISE_MODAL.width,
      POKER_RAISE_MODAL.height,
      POKER_UI.radii.panel,
      PANEL_RAISED,
      GOLD,
      1,
    );
    this.raisePanel.addComponent(UIOpacity);
    this.raisePanel.addComponent(BlockInputEvents);
    this.createLabel(this.raisePanel, '自定义加注', 0, 146, 24, GOLD);
    this.createLabel(this.raisePanel, '本轮总下注额（含已下注筹码）', 0, 111, 14, MUTED);
    this.raiseAmountLabel = this.createLabel(this.raisePanel, '加注至 0', -114, 62, 24, TEXT);
    this.raiseInput = this.createInput(this.raisePanel, 'raise-input', 146, 62, 200, '输入总额');
    this.raiseInput.inputMode = EditBox.InputMode.NUMERIC;
    this.raiseInput.maxLength = 10;
    this.raiseInput.node.on('editing-did-ended', () => {
      if (this.hasLegalRaise()) this.setRaiseAmount(Number(this.raiseInput.string));
    }, this);
    this.raiseDetailLabel = this.createLabel(this.raisePanel, '', 0, 19, 14, MUTED);
    this.createTextButton(this.raisePanel, 'raise-less', '−20', -242, -32, 72, NEUTRAL, () => this.adjustRaiseAmount(-this.getRaiseBounds().step), 42);
    this.createTextButton(this.raisePanel, 'raise-more', '+20', -160, -32, 72, NEUTRAL, () => this.adjustRaiseAmount(this.getRaiseBounds().step), 42);
    this.createTextButton(this.raisePanel, 'raise-minimum', '最小', -60, -32, 82, PRIMARY, () => this.applyRaisePreset('minimum'), 42);
    this.createTextButton(this.raisePanel, 'raise-half-pot', '半池', 32, -32, 82, PRIMARY, () => this.applyRaisePreset('half-pot'), 42);
    this.createTextButton(this.raisePanel, 'raise-pot', '满池', 124, -32, 82, PRIMARY, () => this.applyRaisePreset('pot'), 42);
    this.createTextButton(this.raisePanel, 'raise-all-in', '全压', 216, -32, 82, colorHex('#9E773E'), () => this.applyRaisePreset('all-in'), 42);
    this.createTextButton(this.raisePanel, 'raise-cancel', '取消', -144, -118, 240, rgb(39, 59, 80), () => this.closeRaisePanel(), 46);
    this.raiseConfirmButton = this.createTextButton(this.raisePanel, 'raise-confirm', '确认加注', 126, -118, 264, PRIMARY, () => void this.confirmRaise(), 46);
    this.raisePanel.active = false;
  }

  private buildHome(): void {
    this.homeLayer = new Node('home-layer');
    this.node.addChild(this.homeLayer);
    this.homeLayer.addComponent(UITransform).setContentSize(POKER_UI.canvas.width, POKER_UI.canvas.height);
    this.homeOpacity = this.homeLayer.addComponent(UIOpacity);

    this.createRounded('home-background', this.homeLayer, 0, 0, POKER_UI.canvas.width, POKER_UI.canvas.height, 0, BACKGROUND);
    const motif = new Node('home-felt-motif');
    this.homeLayer.addChild(motif); motif.active = false;
    motif.addComponent(UITransform).setContentSize(820, 420);
    const motifGraphics = motif.addComponent(Graphics);
    motifGraphics.fillColor = colorHex('#123029');
    motifGraphics.ellipse(0, -22, 410, 210);
    motifGraphics.fill();
    motifGraphics.strokeColor = BORDER;
    motifGraphics.lineWidth = 3;
    motifGraphics.ellipse(0, -22, 382, 184);
    motifGraphics.stroke();

    this.createLabel(this.homeLayer, 'POKER CLUB', -436, 292, 22, GOLD);
    this.createLabel(this.homeLayer, '六人德州扑克 · 虚拟筹码', 412, 292, 14, MUTED);
    this.createRounded('home-divider', this.homeLayer, 0, 254, 1120, 1, 0, BORDER);
    const hero = new Node('home-hero');
    this.homeLayer.addChild(hero);
    this.createLabel(hero, '每一手，都是新机会', -270, 142, 34, TEXT);
    this.createLabel(hero, '读懂牌局，打出你的节奏。', -270, 90, 17, MUTED);
    const cardA = this.createCard(hero, new Vec3(-312, -38, 0));
    this.showCard(cardA, { rank: 14, suit: 'S' }, true);
    cardA.node.setScale(1.85, 1.85, 1);
    cardA.node.angle = 12;
    const cardK = this.createCard(hero, new Vec3(-216, -47, 0));
    this.showCard(cardK, { rank: 13, suit: 'H' }, true);
    cardK.node.setScale(1.85, 1.85, 1);
    cardK.node.angle = -12;
    this.createLabel(hero, '小盲 20 / 大盲 40 · 初始筹码 5,000', -270, -164, 14, MUTED);
    this.createTextButton(hero, 'home-resume', '返回原场 / 查看结算', -270, -224, 344, NEUTRAL, () => this.requestOriginalSession(), 44);
    const play = this.createRounded('home-play-panel', hero, 286, -4, 424, 364, 0, BACKGROUND);
    this.createLabel(play, '选择你的牌桌', 0, 132, 24, TEXT);
    this.createTextButton(play, 'home-start', '单机游戏', 0, -44, 344, PANEL_RAISED, () => this.requestStart(), 54);
    this.createLabel(play, '与 5 位 AI 练习，随时开局', 0, -90, 13, MUTED);
    this.createTextButton(play, 'home-online', '联机对战', 0, 62, 344, PRIMARY, () => this.openOnlineSetup(), 54);
    this.createLabel(play, '邀请朋友，加入同一张牌桌', 0, 16, 13, MUTED);
    this.createTextButton(play, 'home-rules', '游戏规则', -90, -140, 164, PANEL_RAISED, () => this.openHomeModal('rules'), 40);
    this.createTextButton(play, 'home-settings', '设置', 90, -140, 164, PANEL_RAISED, () => this.openHomeModal('settings'), 40);
    this.createLabel(this.homeLayer, '仅使用虚拟筹码 · 不涉及真实货币', 0, -292, 13, MUTED);

    this.rulesPanel = this.createRulesModal();
    this.settingsPanel = this.createSettingsModal();
    this.rulesPanel.active = false;
    this.settingsPanel.active = false;
  }

  private createRulesModal(): Node {
    const layer = this.createModalLayer('rules-layer');
    const panel = this.createRounded('rules-panel', layer, 0, 0, 720, 510, POKER_UI.radii.panel, PANEL_RAISED, GOLD, 1);
    this.createLabel(panel, '游戏规则', 0, 214, 25, GOLD);
    this.createParagraph(
      panel,
      '目标：使用两张手牌与五张公共牌组成最佳五张牌。\n\n行动：弃牌、过牌、跟注、自定义加注或全压。\n\n流程：翻牌前 → 翻牌圈 → 转牌圈 → 河牌圈 → 摊牌。\n\n牌型：皇家同花顺、同花顺、四条、葫芦、同花、顺子、三条、两对、一对、高牌。\n\n盲注：默认 20 / 40，开局前可配置；全压可能形成边池。\n\n本游戏仅使用虚拟筹码，不涉及真实货币。',
      0,
      8,
      620,
      330,
      16,
      TEXT,
    );
    this.createTextButton(panel, 'rules-close', '关闭', 0, -214, 180, NEUTRAL, () => this.closeHomeModal(), 42);
    return layer;
  }

  private createSettingsModal(): Node {
    const layer = this.createModalLayer('settings-layer');
    const panel = this.createRounded('settings-panel', layer, 0, 0, 620, 480, POKER_UI.radii.panel, PANEL_RAISED, GOLD, 1);
    this.createLabel(panel, '设置', 0, 196, 25, GOLD);

    const soundButton = this.createTextButton(panel, 'settings-sound', '', 0, 112, 360, PRIMARY, () => {
      this.updateSettings({ soundEnabled: !this.settings.soundEnabled });
    }, 44);
    this.settingsSoundLabel = soundButton.children[0].getComponent(Label)!;

    const speedButton = this.createTextButton(panel, 'settings-speed', '', 0, 48, 360, NEUTRAL, () => {
      this.cycleAnimationSpeed();
    }, 44);
    this.settingsSpeedLabel = speedButton.children[0].getComponent(Label)!;

    const confirmButton = this.createTextButton(panel, 'settings-confirm', '', 0, -16, 360, colorHex('#9E773E'), () => {
      this.updateSettings({ confirmReset: !this.settings.confirmReset });
    }, 44);
    this.settingsConfirmLabel = confirmButton.children[0].getComponent(Label)!;

    this.settingsBlindsLabel = this.createTextButton(panel, 'settings-blinds', '', 0, -80, 360, NEUTRAL, () => this.openBlindSettings(), 44).children[0].getComponent(Label)!;
    this.createLabel(panel, '设置会自动保存在本机', 0, -140, 13, MUTED);
    this.createTextButton(panel, 'settings-close', '完成', 0, -190, 180, PRIMARY, () => this.closeHomeModal(), 42);
    return layer;
  }

  private createModalLayer(name: string): Node {
    const layer = new Node(name);
    this.homeLayer.addChild(layer);
    layer.addComponent(UITransform).setContentSize(POKER_UI.canvas.width, POKER_UI.canvas.height);
    this.createRounded(`${name}-overlay`, layer, 0, 0, POKER_UI.canvas.width, POKER_UI.canvas.height, 0, new Color(4, 13, 28, 210)).addComponent(BlockInputEvents);
    return layer;
  }

  private buildOnlineSetup(): void {
    this.onlineLayer = this.createModalLayer('online-layer');
    this.onlinePanel = this.createRounded('online-panel', this.onlineLayer, 0, 0, 620, 510, POKER_UI.radii.panel, PANEL_RAISED, GOLD, 1);
    this.createLabel(this.onlinePanel, '联机对战', 0, 190, 25, GOLD);

    this.createLabel(this.onlinePanel, '昵称', -238, 138, 15, TEXT);
    this.onlineNicknameInput = this.createInput(this.onlinePanel, 'online-nickname', 42, 138, 360, '输入昵称（1-12 字）');
    this.createLabel(this.onlinePanel, '服务器', -238, 82, 15, TEXT);
    this.onlineServerInput = this.createInput(this.onlinePanel, 'online-server', 42, 82, 360, 'ws:// 或 wss:// 地址');
    this.createLabel(this.onlinePanel, '房间码', -238, 26, 15, TEXT);
    this.onlineRoomCodeInput = this.createInput(this.onlinePanel, 'online-room-code', 42, 26, 360, '加入时填写 4 位房间码');

    this.onlineServerInput.maxLength = 2048;
    this.onlineNicknameInput.maxLength = 12;
    this.onlineRoomCodeInput.maxLength = 4;
    this.onlineStatusLabel = this.createParagraph(this.onlinePanel, '', 0, -28, 540, 44, 14, rgb(228, 120, 120));
    this.onlineStatusLabel.horizontalAlign = Label.HorizontalAlign.CENTER;
    this.onlineCreateButton = this.createTextButton(this.onlinePanel, 'online-create', '创建房间', -130, -88, 200, PRIMARY, () => void this.connectOnline('create'), 44);
    this.onlineJoinButton = this.createTextButton(this.onlinePanel, 'online-join', '加入房间', 130, -88, 200, NEUTRAL, () => void this.connectOnline('join'), 44);
    this.onlineBlindsLabel = this.createTextButton(this.onlinePanel, 'online-blinds', '', 0, -146, 360, NEUTRAL, () => this.openBlindSettings(), 44).children[0].getComponent(Label)!;
    this.createTextButton(this.onlinePanel, 'online-back', '返回', 0, -210, 180, colorHex('#3C3032'), () => this.closeOnlineSetup(), 42);
  }

  private createInput(parent: Node, name: string, x: number, y: number, width: number, placeholder: string): EditBox {
    const frame = this.createRounded(name, parent, x, y, width, 38, 8, rgb(14, 31, 52));
    const inputNode = new Node(`${name}-control`);
    // Configure labels and mode before EditBox.__preload creates its native input.
    inputNode.active = false;
    inputNode.parent = frame;
    inputNode.addComponent(UITransform).setContentSize(width - 24, 38);
    const inputLabel = this.createLabel(inputNode, '', 0, 0, 16, TEXT);
    const input = inputNode.addComponent(EditBox);
    inputLabel.node.getComponent(UITransform)!.setContentSize(width - 24, 38);
    inputLabel.node.getComponent(UITransform)!.setAnchorPoint(0, 1);
    inputLabel.overflow = Label.Overflow.CLAMP;
    inputLabel.horizontalAlign = Label.HorizontalAlign.LEFT;
    const hint = this.createLabel(inputNode, placeholder, 0, 0, 14, MUTED);
    hint.node.getComponent(UITransform)!.setContentSize(width - 24, 38);
    hint.node.getComponent(UITransform)!.setAnchorPoint(0, 1);
    hint.overflow = Label.Overflow.CLAMP;
    hint.horizontalAlign = Label.HorizontalAlign.LEFT;
    input.textLabel = inputLabel;
    input.placeholderLabel = hint;
    input.placeholder = placeholder;
    input.inputMode = EditBox.InputMode.SINGLE_LINE;
    inputLabel.verticalAlign = Label.VerticalAlign.CENTER;
    hint.verticalAlign = Label.VerticalAlign.CENTER;
    const focus = this.createRounded('input-focus', frame, 0, 0, width, 38, 8, new Color(0, 0, 0, 0), GOLD, 1);
    focus.active = false;
    inputNode.on('editing-did-began', () => { focus.active = true; });
    inputNode.on('editing-did-ended', () => { focus.active = false; });
    inputNode.active = true;
    return input;
  }

  private buildLobby(): void {
    this.lobbyLayer = new Node('lobby-layer'); this.node.addChild(this.lobbyLayer);
    this.lobbyLayer.addComponent(UITransform).setContentSize(1280, 720);
    this.createRounded('lobby-background', this.lobbyLayer, 0, 0, 1280, 720, 0, BACKGROUND).addComponent(BlockInputEvents);
    const panel = this.createRounded('lobby-panel', this.lobbyLayer, 0, 0, 1120, 520, 0, BACKGROUND);
    this.createLabel(panel, '好友牌桌', -390, 175, 32, TEXT).node.name = 'lobby-title';
    this.createLabel(panel, '房间码', -390, 116, 14, MUTED).node.name = 'lobby-room-caption';
    this.lobbyCodeLabel = this.createLabel(panel, '----', -390, 56, 64, GOLD);
    this.lobbyCodeLabel.node.getComponent(UITransform)!.setContentSize(440, 100);
    this.createLabel(panel, '20 / 40 盲注 · 初始 5,000', -350, -20, 14, MUTED).node.name = 'lobby-rules';
    this.createTextButton(panel, 'lobby-invite', '邀请好友', -410, -190, 220, NEUTRAL, () => void this.shareInvite(), 44);
    this.createTextButton(panel, 'lobby-ledger', '本场账本', -160, -190, 220, NEUTRAL, () => this.showSessionLedger(), 44);
    for (let i = 0; i < 6; i++) {
      const row = this.createRounded(`lobby-seat-${i}`, panel, i % 2 ? 410 : 150, 100 - Math.floor(i / 2) * 76, 228, 48, 8, PANEL);
      const label = this.createLabel(row, '空位', 0, 0, 16, MUTED);
      label.node.getComponent(UITransform)!.setContentSize(208, 42); label.overflow = Label.Overflow.SHRINK;
      this.lobbySeatLabels.push(label);
    }
    this.lobbyStatusLabel = this.createLabel(panel, '', -300, -90, 14, MUTED);
    this.lobbyStatusLabel.node.getComponent(UITransform)!.setContentSize(440, 78); this.lobbyStatusLabel.overflow = Label.Overflow.SHRINK;
    this.lobbyStartButton = this.createTextButton(panel, 'lobby-start', '开始牌局', 280, -190, 480, PRIMARY, () => this.online?.sendStartGame(), 44);
    this.createTextButton(panel, 'lobby-leave', '离开房间', 450, 210, 160, PANEL_RAISED, () => this.leaveOnline(), 44);
  }

  private createReturnHomeControl(): void {
    const mute = this.createTextButton(this.tableLayer, 'table-mute', '声音 开', 150, 323, 120, NEUTRAL, () => this.updateSettings({ soundEnabled: !this.settings.soundEnabled }), 44);
    this.muteLabel = mute.children[0].getComponent(Label)!;
    this.muteLabel.string = this.settings.soundEnabled ? '声音 开' : '已静音';
    const historyButton = this.createTextButton(this.tableLayer, 'table-last-hand', '上手结果', -340, 323, 126, NEUTRAL, () => this.showLastHand(), 44);
    this.setButtonEnabled(historyButton, false);
    this.createTextButton(this.tableLayer, 'table-ledger', '本场账本', 286, 323, 126, NEUTRAL, () => this.showSessionLedger(), 36);
    this.createTextButton(this.tableLayer, 'table-invite', '邀请', 414, 323, 92, NEUTRAL, () => void this.shareInvite(), 36);
    this.createTextButton(this.tableLayer, 'return-home', '返回首页', 528, 323, 104, colorHex('#3C3032'), () => this.requestReturn(), 36);

    this.returnOverlay = new Node('return-home-layer');
    this.tableLayer.addChild(this.returnOverlay);
    this.returnOverlay.addComponent(UITransform).setContentSize(POKER_UI.canvas.width, POKER_UI.canvas.height);
    this.createRounded('return-home-overlay', this.returnOverlay, 0, 0, POKER_UI.canvas.width, POKER_UI.canvas.height, 0, new Color(4, 13, 28, 210)).addComponent(BlockInputEvents);
    this.returnPanel = this.createRounded('return-home-panel', this.returnOverlay, 0, 0, 520, 250, POKER_UI.radii.panel, PANEL_RAISED, GOLD, 1);
    this.createLabel(this.returnPanel, '返回首页？', 0, 72, 24, GOLD);
    this.createParagraph(this.returnPanel, '当前牌局将结束，未完成的 AI 行动不会继续。', 0, 18, 430, 58, 15, TEXT);
    this.createTextButton(this.returnPanel, 'return-cancel', '继续牌局', -105, -70, 180, NEUTRAL, () => this.cancelReturn(), 42);
    this.createTextButton(this.returnPanel, 'return-confirm', '确认返回', 105, -70, 180, colorHex('#3C3032'), () => this.confirmReturn(), 42);
    this.returnOverlay.active = false;
  }

  private requestStart(): void {
    const next = reduceHomeFlow(this.flow, { type: 'request-start' });
    if (next === this.flow) {
      return;
    }

    this.flow = next;
    tween(this.homeOpacity)
      .to(this.duration(0.18), { opacity: 0 }, { easing: 'quadIn' })
      .call(() => {
        if (this.flow.screen !== 'starting') {
          return;
        }
        this.homeLayer.active = false;
        this.homeOpacity.opacity = 255;
        this.tableLayer.active = true;
        this.mode = 'solo';
        this.findNode('table-ledger')!.active = false; this.findNode('table-invite')!.active = false; this.findNode('virtual-chips-label')!.active = false;
        this.busy = false;
        this.onlineSnapshot = null;
        this.restoreSoloSeats();
        this.clearHandHistory();
        this.engine = PokerEngine.createSixSeat({ blinds: normalizeBlinds(this.settings.blinds) });
        this.aiProfiles = createAiTableProfiles(getPokerSeatLayout().filter(s => s.id !== 'player').map(s => s.id), Math.random);
        this.activeSessionToken = this.sessions.begin();
        this.flow = reduceHomeFlow(this.flow, { type: 'complete-start' });
        void this.startHand(this.activeSessionToken);
      })
      .start();
  }

  private openHomeModal(screen: 'rules' | 'settings'): void {
    this.flow = reduceHomeFlow(this.flow, { type: screen === 'rules' ? 'open-rules' : 'open-settings' });
    this.renderHome();
    if (screen === 'settings' && this.soundPanel) { this.settingsPanel.active = false; this.soundPanel.open(); }
  }

  private closeHomeModal(): void {
    if (this.soundPanel?.isOpen) { this.soundPanel.close(); return; }
    this.flow = reduceHomeFlow(this.flow, { type: 'close-modal' });
    this.renderHome();
  }

  private startOnlineEntry(): void {
    if (!sys.isBrowser) return;
    const invite = parseRoomInvite(window.location.search);
    try {
      const target = resolveServerUrl(sys.localStorage, window.location.search, window.location.origin);
      const intent = chooseEntryIntent(invite, loadOnlineCredentials(sys.localStorage), target);
      if (intent.kind === 'setup') return;
      this.openOnlineSetup();
      if (intent.kind === 'invalid' || intent.kind === 'legacy-unavailable') this.onlineStatusLabel.string = intent.message;
      else if (intent.kind === 'lookup') {
        this.onlineRoomCodeInput.string = intent.roomCode;
        void this.connectOnline('lookup');
      } else if (intent.kind === 'resume') {
        this.flow = { screen: 'online-restoring', sessionActive: false };
        this.renderHome();
        void this.connectOnline('resume', intent.credentials);
      } else if (intent.kind === 'rejoin') this.showLeftIdentity(intent.credentials);
    } catch (error) {
      this.openOnlineSetup();
      this.onlineStatusLabel.string = error instanceof Error ? error.message : '邀请无效';
    }
  }

  private openOnlineSetup(): void {
    this.flow = reduceHomeFlow(this.flow, { type: 'open-online' });
    const stored = loadOnlineCredentials(sys.localStorage);
    this.onlineNicknameInput.string = stored?.nickname ?? '';
    try { this.onlineServerInput.string = resolveServerUrl(sys.localStorage, sys.isBrowser ? window.location.search : '', sys.isBrowser ? window.location.origin : undefined); }
    catch { this.onlineServerInput.string = ''; }
    const invite = parseRoomInvite(sys.isBrowser ? window.location.search : '');
    this.onlineRoomCodeInput.string = invite.kind === 'valid' ? invite.roomCode : stored?.roomCode ?? '';
    this.onlineStatusLabel.string = invite.kind === 'invalid' ? invite.message : '';
    this.renderOnlineConnecting();
    this.renderHome();
  }

  private closeOnlineSetup(): void {
    this.entryGeneration += 1;
    const pending = this.pendingClient;
    this.pendingClient = null;
    this.connectingOnline = false;
    pending?.close();
    this.flow = reduceHomeFlow(this.flow, { type: 'close-online' });
    this.renderOnlineConnecting();
    this.renderHome();
  }

  private async connectOnline(mode: 'create' | 'join' | 'resume' | 'rejoin' | 'lookup', restore?: OnlineCredentials): Promise<void> {
    if (this.connectingOnline) return;
    let nickname = restore?.nickname ?? this.onlineNicknameInput.string.trim();
    const serverUrl = restore?.serverUrl ?? this.onlineServerInput.string.trim();
    const roomCode = restore?.roomCode ?? this.onlineRoomCodeInput.string.trim().toUpperCase();
    if (mode === 'create' || mode === 'join' || mode === 'lookup') {
      const error = validateOnlineForm({ nickname: mode === 'lookup' ? '访客' : nickname, serverUrl, roomCode }, mode === 'create' ? 'create' : 'join', sys.isBrowser && window.location.protocol === 'https:');
      if (error) { this.onlineStatusLabel.string = error; return; }
    }
    if ((mode === 'resume' || mode === 'rejoin') && (!restore?.sessionId || !restore.playerId)) {
      this.onlineStatusLabel.string = '旧版联机身份无法恢复，请明确创建或加入新版本场。'; return;
    }
    const generation = ++this.entryGeneration;
    if (!restore || restore.sessionId !== this.activeCredentials?.sessionId) { this.sessionLedger = null; this.lastOnlineRoom = null; this.sessionPanels?.destroy(); }
    this.finalSettlement = null; this.recoveryText = '';
    this.connectingOnline = true;
    this.onlineStatusLabel.string = mode === 'resume' ? '正在恢复原座位…' : mode === 'rejoin' ? '正在返回原场…' : '正在确认房间与本场身份…';
    this.renderOnlineConnecting();
    const client = new NetClient(serverUrl);
    this.pendingClient = client;
    const current = () => generation === this.entryGeneration && this.pendingClient === client;
    let admissionAttempt: PendingAdmission | null = null;
    client.onMessage = (message) => {
      if (!current()) return;
      // Attach synchronously: ledger/private-hand messages may follow joined in the same turn.
      if (message.type === 'joined') this.attachOnline(client, message, nickname, serverUrl);
      else if (message.type === 'commandResult') {
        if (message.result.command === 'rejoin' && message.result.status === 'rejected') this.pendingRejoins.forEach((id, key) => { if (id === message.result.requestId) this.pendingRejoins.delete(key); });
        this.handleCommandResult(message.result);
      }
      else if (message.type === 'error') this.onlineStatusLabel.string = message.message;
    };
    try {
      await client.connect();
      if (!current()) { client.close(); return; }
      let targetSessionId: string | undefined;
      if (mode === 'join' || mode === 'lookup') {
        const lookup = await client.lookupRoom(roomCode);
        if (!current()) { client.close(); return; }
        targetSessionId = lookup.sessionId;
        const proof = findOnlineCredentials(sys.localStorage, serverUrl, lookup.sessionId);
        if (proof) {
          nickname = proof.nickname;
          if (proof.autoResume === false) {
            this.pendingClient = null; this.connectingOnline = false; client.close();
            this.showLeftIdentity(proof); this.renderOnlineConnecting(); return;
          }
          restore = proof; mode = 'resume';
        } else if (mode === 'lookup') {
          this.pendingClient = null; this.connectingOnline = false; client.close();
          this.onlineStatusLabel.string = '已确认房间，请输入昵称后加入。'; this.renderOnlineConnecting(); return;
        }
      }
      const admission = client.waitForAdmission();
      if (mode === 'resume') client.send({ type: 'reconnect', sessionId: restore!.sessionId!, token: restore!.token });
      else if (mode === 'rejoin') {
        const key = JSON.stringify([restore!.serverUrl, restore!.sessionId]);
        const requestId = this.pendingRejoins.get(key) ?? highEntropyId();
        this.pendingRejoins.set(key, requestId);
        this.unknownCommands.set(requestId, { command: 'rejoin', credentials: restore! });
        client.send({ type: 'rejoin', sessionId: restore!.sessionId!, token: restore!.token, requestId });
      }
      else {
        // Persist the high-entropy proof and request before any admission transmission.
        const pending = prepareAdmission(sys.localStorage, serverUrl, nickname, mode === 'join' ? { roomCode, sessionId: targetSessionId! } : undefined, mode === 'create' ? normalizeBlinds(this.settings.blinds) : undefined);
        admissionAttempt = pending;
        client.send(pending.message);
      }
      const result = await admission;
      if (result.type === 'joined') return;
      if (!current()) { client.close(); return; }
      this.pendingClient = null; this.connectingOnline = false; client.close();
      if (result.type === 'sessionEnded') {
        acknowledgeAdmission(sys.localStorage, admissionAttempt, result);
        this.activeCredentials = restore ?? findOnlineCredentials(sys.localStorage, serverUrl, result.settlement.sessionId);
        this.handleSessionEnded(result.settlement);
      } else if (restore) this.showLeftIdentity({ ...restore, playerId: result.playerId });
      this.renderOnlineConnecting();
    } catch (error) {
      if (generation !== this.entryGeneration) return;
      if (this.pendingClient === client) this.pendingClient = null;
      client.onMessage = null; client.onClose = null; client.close();
      this.connectingOnline = false;
      const reason = error instanceof Error ? error.message : '连接失败，请重试';
      if (mode === 'resume' || mode === 'rejoin') {
        this.flow = reduceHomeFlow(this.flow, { type: 'restore-failed' });
        if (restore) this.showLeftIdentity(restore, `原身份未能入座：${reason}`, mode === 'rejoin');
      }
      this.onlineStatusLabel.string = reason;
      this.renderOnlineConnecting(); this.renderHome();
    }
  }

  private attachOnline(client: NetClient, message: Extract<ServerMessage, { type: 'joined' }>, nickname: string, serverUrl: string): void {
    this.connectingOnline = false;
    this.pendingClient = null;
    this.onlinePlayerId = message.playerId;
    this.activeCredentials = { sessionId: message.sessionId, playerId: message.playerId, autoResume: true, roomCode: message.roomCode, token: message.token, nickname, serverUrl };
    saveOnlineCredentials(sys.localStorage, this.activeCredentials);
    if (message.requestId) { clearPendingAdmission(sys.localStorage, message.requestId); this.unknownCommands.delete(message.requestId); this.pendingRejoins.delete(JSON.stringify([serverUrl, message.sessionId])); }
    this.sessionPanels?.destroy(); this.sessionLedger = null; this.finalSettlement = null; this.recoveryText = ''; this.rejoinCandidate = null;
    this.mode = 'online'; this.connectionStatus = 'restoring';
    this.online = new OnlineSession(client, {
      playerId: message.playerId, credentials: this.activeCredentials,
      handlers: {
        onTableUpdate: (update) => this.applyTableUpdate(update),
        onRoomState: (room) => this.renderLobby(room),
        onSessionLost: (text) => this.handleSessionLost(text),
        onError: (text) => this.handleOnlineError(text),
        onInvalidate: () => this.invalidateOnlineView(),
        onConnectionStatus: (status) => this.handleConnectionStatus(status),
        onLedger: (ledger) => this.handleLedger(ledger),
        onCommandResult: (result) => this.handleCommandResult(result),
        onRecoveryNotice: (notice) => this.handleRecoveryNotice(notice),
        onSessionEnded: (settlement) => this.handleSessionEnded(settlement),
      },
    });
    this.flow = reduceHomeFlow(this.flow, { type: 'entered-lobby' });
    this.online.primeRoom(message.room);
    this.renderOnlineConnecting(); this.renderLobby(message.room); this.renderHome();
  }

  private handleOnlineError(text: string): void {
    if (this.flow.screen === 'online-lobby') this.lobbyStatusLabel.string = text;
    else if (this.flow.screen === 'online-setup' || this.flow.screen === 'online-restoring') this.onlineStatusLabel.string = text;
    else {
      this.renderActionButtons([]);
      this.turnLabel.string = text;
    }
  }

  private handleConnectionStatus(status: ConnectionStatus): void {
    if (status !== 'connected') this.bettingPanel?.close(false);
    this.connectionStatus = status;
    if (status !== 'connected') this.renderActionButtons([]);
    this.refreshSessionPanel();
    const text = status === 'reconnecting' ? '正在重连… 座位最多保留 3 分钟' : status === 'restoring' ? '正在恢复牌桌…' : '';
    if (text) {
      this.turnLabel.string = text;
      this.lobbyStatusLabel.string = text;
    }
    if (status === 'connected' && this.onlineSnapshot && this.flow.screen === 'playing') this.render(this.onlineSnapshot);
    if (this.flow.screen === 'online-lobby' && this.lastOnlineRoom) this.renderLobby(this.lastOnlineRoom);
  }

  private invalidateOnlineView(): void {
    this.sessions.invalidate();
    this.activeSessionToken = this.sessions.begin();
    this.cancelVisuals();
    this.busy = true;
    this.onlineSnapshot = null;
    this.resetVisuals();
    this.raisePanel.active = false; this.raiseOverlay.active = false;
    this.renderActionButtons([]);
  }

  private renderLobby(room: RoomStateMessage): void {
    if (this.finalSettlement) return;
    this.lastOnlineRoom = room;
    const blinds = normalizeBlinds(room.blinds);
    this.findNode('lobby-rules')!.getComponent(Label)!.string = `${blinds.smallBlind} / ${blinds.bigBlind} 盲注 · 初始 5,000`;
    this.refreshSessionPanel();
    this.lobbyCodeLabel.string = room.code;
    this.lobbySeatLabels.forEach((label, index) => {
      const seat = room.seats[index];
      label.string = seat ? `${seat.nickname}${seat.playerId === room.hostId ? ' · 房主' : ''}${seat.connected ? '' : ' · 离线'}` : '空位';
      label.color = seat ? TEXT : MUTED;
    });
    const isHost = room.hostId === this.onlinePlayerId;
    this.lobbyStartButton.active = isHost && room.phase === 'lobby';
    const connected = countLobbyStartPlayers(room, this.sessionLedger);
    this.setButtonEnabled(this.lobbyStartButton, connected >= 2 && this.connectionStatus === 'connected' && room.session.lifecycle === 'active' && !this.commandBusy);
    this.lobbyStatusLabel.string = this.connectionStatus !== 'connected'
      ? this.connectionStatus === 'reconnecting' ? '正在重连… 座位最多保留 3 分钟' : '正在恢复牌桌…'
      : room.phase === 'playing' ? '牌局进行中…' : isHost ? `在线 ${connected} 人 · 至少 2 人可开始` : room.hostId ? '等待房主开始…' : '等待在线玩家接任房主…';
    if (this.recoveryText) this.lobbyStatusLabel.string = this.recoveryText;
    else if (room.session.lifecycle === 'ending-after-hand') this.lobbyStatusLabel.string = '本手结算后结束本场。';
    if (room.phase === 'lobby' && (this.flow.screen === 'playing' || this.flow.screen === 'return-confirmation')) {
      this.invalidateOnlineView();
      this.busy = false;
      this.returnOverlay.active = false;
      this.flow = reduceHomeFlow(this.flow, { type: 'online-back-to-lobby' });
      this.tableLayer.active = false;
      this.homeLayer.active = true;
      this.renderHome();
    }
    if (this.mode === 'online' && this.flow.screen === 'playing') {
      this.applyOnlineSeats();
      if (this.onlineSnapshot) this.render(this.onlineSnapshot);
    }
  }

  private async leaveOnline(): Promise<void> {
    const online = this.online, proof = this.activeCredentials;
    if (!online || !proof || this.commandBusy) return;
    const generation = this.entryGeneration;
    const ledgerBeforeLeave = this.sessionLedger;
    const requestId = highEntropyId();
    this.commandBusy = true;
    this.unknownCommands.set(requestId, { command: 'leaveRoom', credentials: proof });
    deactivateOnlineCredentials(sys.localStorage, proof);
    this.rejoinCandidate = { ...proof, autoResume: false };
    this.activeCredentials = this.rejoinCandidate;
    this.returnOverlay.active = false;
    this.raisePanel.active = false; this.raiseOverlay.active = false;
    this.refreshSessionPanel();
    const result = await online.sendLeave(requestId);
    if (generation !== this.entryGeneration) return;
    this.commandBusy = false;
    if (this.online === online) this.online = null;
    // A synchronous final broadcast can precede the leave receipt. Keep that result.
    if (this.finalSettlement) return;
    this.invalidateOnlineView(); this.busy = false; this.mode = 'solo';
    this.flow = { screen: 'online-left', sessionActive: false };
    this.homeLayer.active = true; this.tableLayer.active = false;
    this.renderHome();
    this.sessionPanels?.renderLeaveResult(result, this.sessionLedger !== ledgerBeforeLeave ? this.sessionLedger : null, this.lastOnlineRoom ? this.sessionPanelContext() : null);
    this.handleCommandResult(result);
  }

  private sessionPanelContext(): SessionPanelContext {
    return {
      playerId: this.onlinePlayerId, hostId: this.lastOnlineRoom?.hostId ?? '',
      session: this.lastOnlineRoom!.session,
      connected: this.mode === 'online' && this.connectionStatus === 'connected', busy: this.commandBusy || Array.from(this.unknownCommands.values()).some(pending => pending.credentials.sessionId === this.activeCredentials?.sessionId),
      canRejoin: !this.commandBusy && !this.finalSettlement && Boolean(this.rejoinCandidate),
    };
  }

  private handleLedger(ledger: LedgerSnapshot): void {
    if (this.finalSettlement || ledger.sessionId !== this.activeCredentials?.sessionId) return;
    this.sessionLedger = ledger; this.refreshSessionPanel();
    if (this.lastOnlineRoom && this.flow.screen === 'online-lobby') this.renderLobby(this.lastOnlineRoom);
  }

  private refreshSessionPanel(): void {
    if (this.sessionLedger && this.lastOnlineRoom && !this.finalSettlement) this.sessionPanels?.updateLedger(this.sessionLedger, this.sessionPanelContext());
  }

  private showSessionLedger(): void {
    if (this.finalSettlement) { this.showFinalSettlement(); return; }
    if (this.sessionLedger && this.lastOnlineRoom) this.sessionPanels?.renderLedger(this.sessionLedger, this.sessionPanelContext());
    else this.handleOnlineError('正在等待服务器账本，请稍后重试。');
  }

  private async performSessionCommand(command: 'rebuy' | 'requestEnd'): Promise<void> {
    const online = this.online, proof = this.activeCredentials;
    if (!online || !proof || this.commandBusy || this.connectionStatus !== 'connected' || this.finalSettlement) return;
    this.commandBusy = true;
    const requestId = highEntropyId();
    this.unknownCommands.set(requestId, { command, credentials: proof });
    this.refreshSessionPanel();
    const result = await (command === 'rebuy' ? online.rebuy(requestId) : online.requestEnd(requestId));
    this.commandBusy = false;
    if (this.online !== online || this.finalSettlement) return;
    this.refreshSessionPanel(); this.handleCommandResult(result);
  }

  private handleCommandResult(result: CommandResult): void {
    if (result.sessionId !== this.activeCredentials?.sessionId || this.finalSettlement) return;
    if (result.command === 'rejoin' && result.status === 'rejected') this.pendingRejoins.forEach((id, key) => { if (id === result.requestId) this.pendingRejoins.delete(key); });
    if (result.code !== 'confirmation-unknown') this.unknownCommands.delete(result.requestId);
    this.sessionPanels?.showCommandResult(result);
    if (result.code === 'confirmation-unknown') this.sessionPanels?.showUnknownCommand(result.requestId);
  }

  private async querySessionCommand(requestId: string): Promise<void> {
    const pending = this.unknownCommands.get(requestId);
    if (!pending || this.commandBusy || this.finalSettlement) return;
    this.commandBusy = true; this.refreshSessionPanel();
    let client: NetClient | null = null;
    let commands: OnlineCommands | null = null;
    const generation = this.entryGeneration;
    let result: CommandResult | null = null;
    try {
      if (this.online && pending.command !== 'leaveRoom' && this.connectionStatus === 'connected') result = await this.online.queryCommand(requestId);
      else {
        // Proof-only status lookup: this socket never claims a seat or sends reconnect.
        client = new NetClient(pending.credentials.serverUrl); await client.connect();
        if (generation !== this.entryGeneration) return;
        commands = new OnlineCommands(client, pending.credentials.sessionId!, { token: pending.credentials.token });
        result = await commands.query(requestId, pending.command);
      }
    } catch (error) { this.handleOnlineError(error instanceof Error ? error.message : '查询失败，请重试原请求'); }
    finally { commands?.dispose(); client?.close(); this.commandBusy = false; this.refreshSessionPanel(); if (result && generation === this.entryGeneration && !this.finalSettlement) this.handleCommandResult(result); }
  }

  private showLeftIdentity(proof: OnlineCredentials, text = '你已离开座位；本场权益以服务器最近结算为准。', departed = true): void {
    if (departed) deactivateOnlineCredentials(sys.localStorage, proof);
    this.activeCredentials = { ...proof, autoResume: departed ? false : proof.autoResume }; this.rejoinCandidate = this.activeCredentials;
    this.onlinePlayerId = proof.playerId ?? ''; this.mode = 'solo';
    this.flow = { screen: 'online-left', sessionActive: false };
    this.homeLayer.active = true; this.tableLayer.active = false; this.renderHome();
    // No ledger is fabricated from the initial buy-in or the current hand's temporary stack.
    this.sessionPanels?.renderLeft(text);
  }

  private requestOriginalSession(): void {
    if (this.connectingOnline || this.commandBusy) return;
    if (this.flow.screen === 'online-left' && this.rejoinCandidate) {
      const proof = this.rejoinCandidate;
      const pendingLeave = Array.from(this.unknownCommands.entries()).find(entry => entry[1].command === 'leaveRoom' && entry[1].credentials.sessionId === proof.sessionId);
      if (pendingLeave) { this.sessionPanels?.showUnknownCommand(pendingLeave[0]); return; }
      this.sessionPanels?.close(false);
      this.flow = reduceHomeFlow(this.flow, { type: 'request-rejoin' }); this.renderHome();
      void this.connectOnline(proof.autoResume === false ? 'rejoin' : 'resume', proof); return;
    }
    let endpoint: string;
    try { endpoint = resolveServerUrl(sys.localStorage, sys.isBrowser ? window.location.search : '', sys.isBrowser ? window.location.origin : undefined); }
    catch { return; }
    const proofs = listOnlineCredentials(sys.localStorage, endpoint);
    if (!proofs.length) return;
    const select = (index: number) => {
      const proof = proofs[index]; if (!proof) return;
      this.sessionPanels?.close(false);
      this.flow = { screen: 'online-restoring', sessionActive: false }; this.renderHome();
      void this.connectOnline(proof.autoResume === false ? 'rejoin' : 'resume', proof);
    };
    this.sessionPanels?.renderSavedSessions(proofs.map(proof => ({ nickname: proof.nickname, roomCode: proof.roomCode })), select);
  }

  private closeSessionPanel(): void {
    if (this.flow.screen === 'online-left' || this.flow.screen === 'online-settlement') {
      this.flow = reduceHomeFlow(this.flow, { type: 'close-session-result' });
      this.mode = 'solo'; this.homeLayer.active = true; this.tableLayer.active = false; this.renderHome();
    }
  }

  private handleRecoveryNotice(notice: RecoveryNotice): void {
    this.invalidateOnlineView(); this.raiseOverlay.active = false; this.raisePanel.active = false; this.returnOverlay.active = false;
    this.recoveryText = `未完成的第 ${notice.rolledBackHandId} 手已回退，已恢复最近完整结算。`;
    this.lobbyStatusLabel.string = this.recoveryText; this.turnLabel.string = this.recoveryText;
    this.sessionPanels?.showNotice(this.recoveryText);
  }

  private handleSessionEnded(settlement: FinalSettlement): void {
    if (this.finalSettlement?.sessionId === settlement.sessionId) return;
    this.invalidateOnlineView(); this.online?.dispose(); this.online = null;
    this.raiseOverlay.active = false; this.raisePanel.active = false; this.returnOverlay.active = false; this.shareDialog?.remove(); this.shareDialog = null;
    this.finalSettlement = settlement; this.commandBusy = false; this.busy = false;
    if (this.activeCredentials) deactivateOnlineCredentials(sys.localStorage, this.activeCredentials);
    this.rejoinCandidate = this.activeCredentials ? { ...this.activeCredentials, autoResume: false } : null;
    this.flow = { screen: 'online-settlement', sessionActive: false };
    this.mode = 'solo'; this.homeLayer.active = true; this.tableLayer.active = false;
    this.renderHome(); this.showFinalSettlement();
  }

  private showFinalSettlement(): void {
    if (!this.finalSettlement || !sys.isBrowser) return;
    let url = '';
    try { url = createSettlementLink(window.location.href, this.finalSettlement.shareId, this.activeCredentials!.serverUrl); }
    catch { /* Settlement stays readable even on a custom backend without a matching public page. */ }
    this.sessionPanels?.renderEnded(this.finalSettlement, url);
  }

  private applyTableUpdate(update: TableUpdate): Promise<void> { return this.runTableUpdate(update); }

  private async runTableUpdate(update: TableUpdate): Promise<void> {
    if (!update.isCurrent()) return;
    if (this.flow.screen === 'online-lobby') this.enterOnlineTable();
    if ((this.flow.screen !== 'playing' && this.flow.screen !== 'return-confirmation') || this.mode !== 'online') return;
    const token = this.activeSessionToken;
    this.participation = update.participation;
    this.applyOnlineSeats();
    if (update.newHand) this.resetVisuals();
    if (update.handPositions !== undefined) {
      this.handPositions = update.handPositions;
      this.renderPositionBadges();
    }
    this.busy = true;
    this.renderActionButtons([]);
    await this.playEvents(update.events, token);
    if (!update.isCurrent() || !this.sessions.isCurrent(token)) return;
    if (update.snapshot) this.onlineSnapshot = update.snapshot;
    this.busy = false;
    if (this.onlineSnapshot) {
      this.render(this.onlineSnapshot);
      if (this.onlineSnapshot.street === 'settled') this.rememberHandResult(this.onlineSnapshot);
    }
  }

  private enterOnlineTable(): void {
    this.mode = 'online';
    this.flow = reduceHomeFlow(this.flow, { type: 'online-game-start' });
    this.findNode('table-ledger')!.active = true; this.findNode('table-invite')!.active = true; this.findNode('virtual-chips-label')!.active = false;
    this.homeLayer.active = false;
    this.lobbyLayer.active = false;
    this.tableLayer.active = true;
    this.activeSessionToken = this.sessions.begin();
    this.clearHandHistory();
    this.resetVisuals();
  }

  private applyOnlineSeats(): void {
    const names = this.online?.seatNames() ?? new Map<string, string>();
    this.seats.forEach((seat, id) => {
      seat.node.active = names.has(id);
      if (names.has(id)) seat.name.string = names.get(id)!;
      const avatar = seat.node.getChildByName('seat-avatar');
      if (avatar && id !== 'player') {
        avatar.children.forEach(child => child.active = child.name !== 'online-initial');
        const initial = avatar.getChildByName('online-initial')?.getComponent(Label);
        if (initial) initial.string = (names.get(id) ?? '友').slice(0, 1);
      }
      if (id === 'player') { const avatar=seat.node.getChildByName('seat-avatar')?.children[0]?.getComponent(Label); if(avatar)avatar.string=this.participation==='waiting-next-hand'?'客':'你'; }
    });
  }

  private async shareInvite(): Promise<void> {
    if (!this.activeCredentials || !sys.isBrowser) return;
    try {
      const link = createRoomInvite(window.location.href, this.activeCredentials.roomCode, this.activeCredentials.serverUrl);
      this.showShareDialog(link);
    } catch (error) { this.handleOnlineError(error instanceof Error ? error.message : '无法生成邀请'); }
  }

  private showShareDialog(link: string): void {
    this.shareDialog?.remove();
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = document.createElement('div'); overlay.className = 'poker-share-overlay';
    const panel = document.createElement('div'); panel.className = 'poker-share-panel'; panel.tabIndex = -1;
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', '邀请好友');
    const title = document.createElement('h2'); title.textContent = '邀请好友';
    const hint = document.createElement('p'); hint.textContent = '复制链接发给好友，好友输入昵称后即可加入。';
    const field = document.createElement('input'); field.value = link; field.readOnly = true; field.setAttribute('aria-label', '邀请链接');
    field.onclick = () => field.select();
    const status = document.createElement('p'); status.textContent = '仅分享房间入口，不包含你的登录凭证。'; status.setAttribute('role', 'status');
    const copy = document.createElement('button'); copy.textContent = '复制链接'; copy.dataset.action = 'invite-copy';
    copy.onclick = async () => {
      copy.disabled = true;
      const result = await copyLink(link, field);
      if (this.shareDialog !== overlay) return;
      status.textContent = result === 'copied' ? '已复制链接，可以发给好友' : '浏览器未允许自动复制，请手动复制已选中的完整链接';
      copy.disabled = false;
    };
    const closeDialog = () => {
      if (this.shareDialog !== overlay) return;
      // Keep the release event off the canvas after dismissing a native overlay.
      overlay.replaceChildren();
      this.shareDialog = null;
      setTimeout(() => { overlay.remove(); if (previousFocus?.isConnected) previousFocus.focus(); else document.querySelector<HTMLCanvasElement>('canvas')?.focus(); }, 300);
    };
    const close = document.createElement('button'); close.textContent = '关闭'; close.dataset.action = 'invite-close'; close.onclick = closeDialog;
    panel.append(title, hint, field, status, copy);
    if (typeof navigator.share === 'function') {
      const share = document.createElement('button'); share.textContent = '系统分享'; share.dataset.action = 'invite-share';
      share.onclick = async () => { try { await navigator.share({ title: '一起玩德州扑克', url: link }); } catch { if (this.shareDialog === overlay) status.textContent = '可继续使用复制链接'; } };
      panel.appendChild(share);
    }
    panel.appendChild(close);
    ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'click'].forEach(type => overlay.addEventListener(type, event => event.stopPropagation()));
    overlay.onkeydown = event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); closeDialog(); }
      if (event.key === 'Tab') {
        const controls = panel.querySelectorAll<HTMLElement>('button:not(:disabled), input');
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    overlay.appendChild(panel); document.body.appendChild(overlay); this.shareDialog = overlay; panel.focus({ preventScroll: true });
  }

  private restoreSoloSeats(): void {
    for (const { id, name } of getPokerSeatLayout()) {
      const seat = this.seats.get(id)!;
      seat.node.active = true;
      seat.name.string = name;
      if (id !== 'player') seat.node.getChildByName('seat-avatar')?.children.forEach(child => child.active = child.name !== 'online-initial');
      if (id === 'player') { const label=seat.node.getChildByName('seat-avatar')?.children[0]?.getComponent(Label); if(label)label.string='你'; }
    }
  }

  private handleSessionLost(text: string): void {
    this.online?.dispose();
    this.online = null;
    this.invalidateOnlineView();
    this.busy = false;
    this.mode = 'solo';
    this.tableLayer.active = false;
    this.returnOverlay.active = false;
    this.homeLayer.active = true;
    this.flow = { screen: 'online-setup', sessionActive: false };
    this.sessionPanels?.close(false);
    this.onlineStatusLabel.string = text;
    this.connectingOnline = false;
    this.renderOnlineConnecting();
    this.renderHome();
  }

  private renderHome(): void {
    this.rulesPanel.active = this.flow.screen === 'rules';
    this.settingsPanel.active = this.flow.screen === 'settings' && !this.soundPanel?.isOpen;
    this.settingsSoundLabel.string = `音效 · ${this.settings.soundEnabled ? '开启' : '关闭'}`;
    this.settingsSpeedLabel.string = `动画速度 · ${this.settings.animationSpeed}×`;
    this.settingsConfirmLabel.string = `返回确认 · ${this.settings.confirmReset ? '开启' : '关闭'}`;
    const blinds = normalizeBlinds(this.settings.blinds);
    this.settingsBlindsLabel.string = `盲注 · ${blinds.smallBlind} / ${blinds.bigBlind}`;
    this.onlineBlindsLabel.string = `建房盲注 · ${blinds.smallBlind} / ${blinds.bigBlind}`;
    this.onlineLayer.active = this.flow.screen === 'online-setup' || this.flow.screen === 'online-restoring';
    this.lobbyLayer.active = this.flow.screen === 'online-lobby';
    const resume = this.findNode('home-resume');
    if (resume) {
      try { const endpoint = resolveServerUrl(sys.localStorage, sys.isBrowser ? window.location.search : '', sys.isBrowser ? window.location.origin : undefined); resume.active = listOnlineCredentials(sys.localStorage, endpoint).length > 0; }
      catch { resume.active = false; }
    }
  }

  private updateSettings(patch: Partial<GameSettings>): void {
    this.settings = { ...this.settings, ...patch };
    saveGameSettings(sys.localStorage, this.settings);
    if (this.muteLabel) this.muteLabel.string = this.settings.soundEnabled ? '声音 开' : '已静音';
    this.renderHome();
  }

  private cycleAnimationSpeed(): void {
    const speeds: AnimationSpeed[] = [0.75, 1, 1.25];
    const current = speeds.indexOf(this.settings.animationSpeed);
    this.updateSettings({ animationSpeed: speeds[(current + 1) % speeds.length] });
  }

  private openBlindSettings(): void {
    if (this.connectingOnline || (this.flow.screen !== 'settings' && this.flow.screen !== 'online-setup')) return;
    if (!this.blindSettingsPanel) this.blindSettingsPanel = new BlindSettingsPanel({
      onConfirm: (blinds) => {
        if (!this.connectingOnline && (this.flow.screen === 'settings' || this.flow.screen === 'online-setup')) {
          this.updateSettings({ blinds: normalizeBlinds(blinds) });
          this.soundPanel?.refresh();
        }
      },
      onClose: () => this.audio.play('ui-click'),
    });
    this.blindSettingsPanel.open(normalizeBlinds(this.settings.blinds));
  }

  private requestReturn(): void {
    if (this.commandBusy || this.bettingPanel?.isOpen || this.soundPanel?.isOpen) return;
    const paragraph = this.returnPanel.children.find(node => node.name === 'paragraph')?.getComponent(Label);
    if (paragraph) paragraph.string = this.mode === 'online' ? '离开座位后保留本场身份；当前手权益将在完整结算后归属，可从首页明确返回原场。' : '当前牌局将结束，未完成的 AI 行动不会继续。';
    this.flow = reduceHomeFlow(this.flow, { type: 'request-return', confirmReset: this.settings.confirmReset });
    if (this.flow.screen === 'return-confirmation') {
      this.returnOverlay.active = true;
    } else if (this.flow.screen === 'home') {
      this.completeReturnHome();
    }
  }

  private cancelReturn(): void {
    this.flow = reduceHomeFlow(this.flow, { type: 'cancel-return' });
    this.returnOverlay.active = false;
    if (this.mode === 'solo' && !this.busy && this.engine.snapshot().street === 'settled' && this.engine.snapshot().players.find(p => p.id === 'player')?.stack > 0) void this.startHand(this.activeSessionToken);
  }

  private confirmReturn(): void {
    this.flow = reduceHomeFlow(this.flow, { type: 'confirm-return' });
    this.completeReturnHome();
  }

  private completeReturnHome(): void {
    if (this.mode === 'online') { void this.leaveOnline(); return; }
    this.clearHandHistory();
    this.sessions.invalidate();
    this.activeSessionToken = 0;
    this.unscheduleAllCallbacks();
    this.cancelVisuals();
    this.transientNodes.forEach((node) => node.destroy());
    this.transientNodes.clear();
    this.busy = false;
    this.returnOverlay.active = false;
    this.raiseOverlay.active = false;
    this.raisePanel.active = false;
    this.renderActionButtons([]);
    this.resetVisuals();
    this.tableLayer.active = false;
    this.homeLayer.active = true;
    this.homeOpacity.opacity = 255;
    this.mode = 'solo';
    this.busy = false;
    this.onlineSnapshot = null;
    this.restoreSoloSeats();
    this.engine = PokerEngine.createSixSeat({ blinds: normalizeBlinds(this.settings.blinds) });
        this.aiProfiles = createAiTableProfiles(getPokerSeatLayout().filter(s => s.id !== 'player').map(s => s.id), Math.random);
    this.flow = createHomeFlow();
    this.renderHome();
  }

  private createTextButton(parent: Node, name: string, text: string, x: number, y: number, width: number, color: Color, onPress: () => void, height = 34): Node {
    const button = this.createRounded(name, parent, x, y, width, Math.max(44,height), 8, color);
    this.createLabel(button, text, 0, 0, 15, TEXT);
    this.addButtonFeedback(button);
    button.on(Button.EventType.CLICK, () => {
      this.audio.play('ui-click');
      onPress();
    }, this);
    return button;
  }

  private addButtonFeedback(node: Node): void {
    const button = node.addComponent(Button);
    button.transition = Button.Transition.NONE;
    const opacity = node.addComponent(UIOpacity);
    const feedback = (value: number) => {
      if (button.interactable) opacity.opacity = value;
    };
    node.on(Node.EventType.MOUSE_ENTER, () => feedback(225));
    node.on(Node.EventType.MOUSE_LEAVE, () => feedback(255));
    node.on(Node.EventType.TOUCH_START, () => feedback(185));
    node.on(Node.EventType.TOUCH_END, () => feedback(255));
    node.on(Node.EventType.TOUCH_CANCEL, () => feedback(255));
  }

  private setButtonEnabled(node: Node, enabled: boolean): void {
    node.getComponent(Button)!.interactable = enabled;
    node.getComponent(UIOpacity)!.opacity = enabled ? 255 : 85;
  }

  private renderOnlineConnecting(): void {
    this.setButtonEnabled(this.onlineCreateButton, !this.connectingOnline);
    this.setButtonEnabled(this.onlineJoinButton, !this.connectingOnline);
    this.onlineCreateButton.children[0].getComponent(Label)!.string = this.connectingOnline ? '连接中…' : '创建房间';
    this.onlineJoinButton.children[0].getComponent(Label)!.string = this.connectingOnline ? '请稍候…' : '加入房间';
    this.onlineNicknameInput.enabled = !this.connectingOnline;
    this.onlineServerInput.enabled = !this.connectingOnline;
    this.onlineRoomCodeInput.enabled = !this.connectingOnline;
    this.setButtonEnabled(this.findNode('online-blinds')!, !this.connectingOnline);
  }

  private async startHand(token: number): Promise<void> {
    if (this.busy || !this.sessions.isCurrent(token)) {
      return;
    }

    this.busy = true;
    this.renderActionButtons([]);
    this.turnLabel.string = '正在发牌…';
    this.resetVisuals();
    this.soloOpeningStack = this.engine.snapshot().players.find(p => p.id === 'player')?.stack ?? 0;
    this.engine.startHand();
    this.soloActionSequence += 1;
    const events = this.engine.takeEvents();
    const state = this.engine.snapshot();
    this.handPositions = fromSoloBlindEvents(state.handId, state.players.map(p => p.id), events, state.dealerPlayerId);
    this.renderPositionBadges();
    await this.playEvents(events, token);
    if (!this.sessions.isCurrent(token)) {
      return;
    }
    this.busy = false;
    this.render(this.engine.snapshot());
    await this.runAiTurns(token);
  }

  private async handlePlayerAction(action: PlayerAction): Promise<void> {
    const token = this.activeSessionToken;
    if (this.busy || !this.sessions.isCurrent(token) || this.currentSnapshot().actingPlayerId !== 'player') {
      return;
    }

    if (this.mode === 'online') {
      if (!this.online?.canAct()) return;
      this.online.sendAction(action);
      this.renderActionButtons([]);
      this.turnLabel.string = '已提交行动，等待服务器确认…';
      return;
    }

    this.syncSoloTurnClock(this.engine.snapshot());
    action = this.soloTurnClock.takeExpiredAction() ?? action;
    this.busy = true;
    this.clearSoloTurnClock();
    this.bettingPanel?.close(false);
    this.raisePanel.active = false;
    this.raiseOverlay.active = false;
    this.renderActionButtons([]);
    this.turnLabel.string = '正在处理你的行动…';
    const events = this.engine.act(action);
    this.soloActionSequence += 1;
    await this.playEvents(events, token);
    if (!this.sessions.isCurrent(token)) {
      return;
    }
    this.busy = false;
    this.render(this.engine.snapshot());
    await this.runAiTurns(token);
  }

  private async runAiTurns(token: number): Promise<void> {
    while (this.sessions.isCurrent(token) && this.engine.snapshot().street !== 'settled' && this.engine.snapshot().actingPlayerId !== 'player') {
      const snapshot = this.engine.snapshot();
      const actorId = snapshot.actingPlayerId!;
      const actor = snapshot.players.find((player) => player.id === actorId)!;
      const legalActions = snapshot.legalActions;
      const toCall = Math.max(0, ...snapshot.players.map(p => p.streetContribution)) - actor.streetContribution;
      const profile = this.aiProfiles.get(actorId) ?? DEFAULT_AI_PROFILE;
      const dealerIndex = snapshot.players.findIndex(p => p.id === snapshot.dealerPlayerId);
      const order = snapshot.players.slice(dealerIndex + 1).concat(snapshot.players.slice(0, dealerIndex + 1)).filter(p => !p.folded);
      const position = Math.max(0, order.findIndex(p => p.id === actorId)) / Math.max(1, order.length - 1);
      this.busy = true;
      this.setSeatAction(actorId, '思考中…');
      this.render(this.engine.snapshot());
      await this.wait(getAiThinkDelay({ street: snapshot.street, toCall, pot: snapshot.pot, stack: actor.stack, legalActions }, profile, Math.random));
      if (!this.sessions.isCurrent(token)) {
        return;
      }
      const action = chooseAiAction({
        holeCards: this.engine.getHoleCards(actorId),
        communityCards: snapshot.communityCards,
        street: snapshot.street,
        pot: snapshot.pot,
        toCall,
        stack: actor.stack,
        streetContribution: actor.streetContribution,
        playersInHand: snapshot.players.filter(p => !p.folded).length,
        position, profile,
        bigBlind: normalizeBlinds(snapshot.blinds).bigBlind,
        legalActions,
        random: Math.random,
      });
      const events = this.engine.act(action);
      this.soloActionSequence += 1;
      await this.playEvents(events, token);
      if (!this.sessions.isCurrent(token)) {
        return;
      }
      this.busy = false;
      this.render(this.engine.snapshot());
    }

    if (this.sessions.isCurrent(token) && this.engine.snapshot().street === 'settled') {
      const settled = this.engine.snapshot();
      this.rememberHandResult(settled);
      const player = settled.players.find(({ id }) => id === 'player')!;
      if (player.stack === 0) {
        this.resultLabel.string = '筹码耗尽 · 点击这里重开现金桌';
        this.resultLabel.node.active = true;
        this.clearSoloRestart();
        this.soloRestartHandler = () => {
          if (!this.sessions.isCurrent(token) || this.mode !== 'solo' || this.engine.snapshot().players.find(p => p.id === 'player')?.stack !== 0) return;
          this.clearSoloRestart();
          this.clearHandHistory();
          this.engine = PokerEngine.createSixSeat({ blinds: normalizeBlinds(this.settings.blinds) });
          this.aiProfiles = createAiTableProfiles(getPokerSeatLayout().filter(s => s.id !== 'player').map(s => s.id), Math.random);
          void this.startHand(token);
        };
        this.resultLabel.node.on(Node.EventType.TOUCH_END, this.soloRestartHandler, this, true);
        return;
      }

      if (this.flow.screen === 'playing') void this.startHand(token);
    }
  }

  private async playEvents(events: readonly EngineEvent[], token: number): Promise<void> {
    for (const event of events) {
      if (!this.sessions.isCurrent(token)) {
        return;
      }
      if (event.type === 'hole-card-dealt') {
        await this.dealHoleCard(event, token);
      } else if (event.type === 'community-card-revealed') {
        this.seatActions.clear(); this.thinkingSeatId = null;
        await this.revealCommunityCard(event.card, token);
      } else if (event.type === 'action-taken') {
        this.seatActions.set(event.playerId, event.action);
        if (this.thinkingSeatId === event.playerId) this.thinkingSeatId = null;
        this.setSeatAction(event.playerId, getSeatBetStatus(this.currentSnapshot().players.find(p => p.id === event.playerId)!, event.action).text);
        if (event.action.type === 'check' || event.action.type === 'fold') this.audio.play(event.action.type);
        else if (event.amount > 0) { this.audio.play('chip'); const seat = this.seats.get(event.playerId)!; const target = getChipPilePosition(event.playerId, seat.position, this.viewport.compact); await this.animateChip(seat.position, new Vec3(target.x, target.y, 0), token); }
      } else if (event.type === 'showdown') {
        const seat = this.seats.get(event.playerId)!;
        event.cards.forEach((card, index) => this.showCard(seat.cards[index], card, true));
        this.setSeatAction(event.playerId, event.handName);
      } else if (event.type === 'pot-awarded') {
        const soundKey = `${this.mode}:${token}:${event.handId}`;
        if (!this.settlementSounds.has(soundKey)) {
          this.settlementSounds.add(soundKey); this.audio.play('settlement');
          if (this.settlementSounds.size > 100) this.settlementSounds.delete(this.settlementSounds.values().next().value);
        }
        this.highlightWinner(event.playerId);
        this.handAwards.push(event);
        const names = this.mode === 'online' ? this.online?.seatNames() : new Map(getPokerSeatLayout().map(p => [p.id, p.name]));
        const summary = buildHandResult(event.handId, this.handAwards.filter(a => a.handId === event.handId), Array.from(names ?? new Map<string, string>()).map(([id, name]) => ({ id, name: id === 'player' && this.mode === 'online' ? this.activeCredentials?.nickname ?? name : name })), 'player');
        this.resultLabel.string = summary.winners.length > 1 ? `${summary.winners.length} 位玩家分得底池 · 点击「上手结果」查看` : `${summary.winners[0]?.name ?? '玩家'} 获得 ${summary.totalAwarded.toLocaleString()} · ${event.handName}`;
        this.resultLabel.node.active = true;
        const potPoint = getPotChipPilePosition(this.viewport.compact, this.viewport.designHeight < 620);
        await this.animateChip(new Vec3(potPoint.x, potPoint.y, 0), this.seats.get(event.playerId)!.position, token);
      }
      if (!this.sessions.isCurrent(token)) {
        return;
      }
    }
  }

  private async dealHoleCard(event: Extract<EngineEvent, { type: 'hole-card-dealt' }>, token: number): Promise<void> {
    if (!this.sessions.isCurrent(token)) {
      return;
    }
    const seat = this.seats.get(event.playerId)!;
    const card = seat.cards[seat.nextCard];
    if (!card) return;
    seat.nextCard += 1;
    this.showCard(card, event.card, !event.faceDown);
    card.node.active = true;
    card.node.setPosition(0, 152, 0);
    this.audio.play('card');
    await this.move(card.node, card.home, 0.16);
  }

  private async revealCommunityCard(card: Card, token: number): Promise<void> {
    if (!this.sessions.isCurrent(token)) {
      return;
    }
    const target = this.communityCards.find((visual) => !visual.node.active)!;
    this.showCard(target, card, true);
    target.node.active = true;
    target.node.setPosition(0, 152, 0);
    this.audio.play('card');
    await this.move(target.node, target.home, 0.2);
  }

  private render(state: EngineSnapshot): void {
    if (this.seatActionStreet !== state.street) { this.seatActions.clear(); this.thinkingSeatId = null; this.seatActionStreet = state.street; }
    this.renderPositionBadges();
    this.syncSoloTurnClock(state);
    this.refreshWinProbability(state);
    this.potLabel.string = `总底池 · ${state.pot.toLocaleString()}`;
    this.setButtonEnabled(this.findNode('table-last-hand')!, Boolean(this.lastHandResult));
    this.renderChipPiles(state);
    const blinds = this.tableBlinds(state);
    this.streetLabel.string = `第 ${state.handId} 手 · ${streetText(state.street)} · ${blinds.smallBlind} / ${blinds.bigBlind}`;
    const actorId = state.actingPlayerId ?? '';
    const actorName = this.mode === 'online' ? this.online?.seatNames().get(actorId)
      : getPokerSeatLayout().find(seat => seat.id === actorId)?.name;
    this.turnLabel.string = state.street === 'settled'
      ? this.mode === 'solo' && state.players.find((player) => player.id === 'player')?.stack === 0
        ? '筹码耗尽 · 点击结果提示重新开始' : '本手已结算 · 即将开始下一手'
      : state.actingPlayerId === 'player' && !this.busy ? '轮到你了 · 请选择行动'
        : actorName ? `等待 ${actorName} 行动…` : '正在整理牌桌…';
    this.turnLabel.color = state.actingPlayerId === 'player' && !this.busy ? GOLD : MUTED;
    if (this.mode === 'online' && this.participation === 'waiting-next-hand') this.turnLabel.string = `${this.activeCredentials?.nickname ?? '你'} · 已入座，下一手加入`;
    if (this.mode === 'online' && this.lastOnlineRoom?.session.lifecycle === 'ending-after-hand') {
      this.turnLabel.string = state.street === 'settled' ? '本手已结清 · 正在结束本场' : `${this.turnLabel.string} · 本手后结束`;
    }
    if (this.mode === 'online' && this.connectionStatus !== 'connected') this.turnLabel.string = this.connectionStatus === 'reconnecting' ? '正在重连…' : '正在恢复牌桌…';
    if (this.raisePanel.active && !this.hasLegalRaise()) {
      this.raisePanel.active = false;
      this.raiseOverlay.active = false;
    }

    for (const player of state.players) {
      const seat = this.seats.get(player.id);
      if (!seat) continue;
      const name = this.mode === 'online' ? (this.online?.seatNames().get(player.id) ?? player.name) : (getPokerSeatLayout().find(s => s.id === player.id)?.name ?? player.name);
      seat.name.string = formatSeatName(name, this.viewport.compact && player.id !== 'player' ? 6 : 9).display;
      const amount = formatTableChips(player.stack, this.viewport.compact);
      seat.chips.string = amount.full;
      this.paintSeatStatus(seat, getSeatBetStatus(player, this.seatActions.get(player.id) ?? null, this.thinkingSeatId === player.id));
      const opacity = seat.node.getComponent(UIOpacity)!;
      opacity.opacity = 255;
      seat.highlight.active = state.actingPlayerId === player.id || this.winnerId === player.id;
      seat.chips.color = player.folded ? MUTED : state.actingPlayerId === player.id || this.winnerId === player.id ? GOLD : TEXT;
      seat.cards.forEach((card) => {
        const cardOpacity = card.node.getComponent(UIOpacity) ?? card.node.addComponent(UIOpacity);
        cardOpacity.opacity = player.folded ? 100 : 255;
      });
      seat.node.scale = this.winnerId === player.id
        ? new Vec3(POKER_SHOWDOWN_FEEDBACK.winnerScale, POKER_SHOWDOWN_FEEDBACK.winnerScale, 1)
        : state.actingPlayerId === player.id ? new Vec3(1.02, 1.02, 1) : Vec3.ONE;
      seat.dealer.string = '';
    }

    this.renderActionButtons(state.actingPlayerId === 'player' && !this.busy && (this.mode !== 'online' || this.online?.canAct()) ? state.legalActions : []);
  }

  private renderChipPiles(state: EngineSnapshot): void {
    const scale = sys.isBrowser ? document.querySelector('canvas')!.getBoundingClientRect().height / this.viewport.designHeight : 1;
    this.tableChips?.render(state, new Map(Array.from(this.seats).map(([id, seat]) => [id, { x: seat.position.x, y: seat.position.y }])), this.viewport.compact, scale);
  }

  private renderPositionBadges(): void {
    const scale = sys.isBrowser ? Math.max(0.25, document.querySelector('canvas')!.getBoundingClientRect().height / this.viewport.designHeight) : 1;
    this.positionBadges.forEach((badge, id) => {
      const seat = this.seats.get(id)!;
      const roles = this.handPositions;
      const small = roles?.smallBlindPlayerId === id;
      const big = roles?.bigBlindPlayerId === id;
      const dealer = roles?.dealerPlayerId === id;
      badge.node.active = this.tableLayer.active && seat.node.active && Boolean(small || big || dealer);
      if (!badge.node.active) return;
      badge.label.string = small ? dealer ? '庄家 / 小盲' : '小盲 SB' : big ? '大盲 BB' : '庄家 D';
      const fill = colorHex(small ? '#245E64' : big ? '#82502F' : '#51442B');
      const ink = colorHex(small ? '#C4F4F0' : big ? '#FFE0B1' : '#F4D894');
      const box = this.boxes.get(badge.node)!;
      box.color = fill; box.stroke = ink;
      const width = small && dealer ? (this.viewport.compact ? 196 : 156) : (this.viewport.compact ? 138 : 118);
      const height = this.viewport.compact ? 34 : 32;
      this.resizeBox(badge.node, width, height);
      badge.label.color = ink;
      badge.label.fontSize = this.viewport.compact ? Math.ceil(12 / scale) : 15;
      badge.label.lineHeight = badge.label.fontSize + 3;
      badge.label.node.getComponent(UITransform)!.setContentSize(width - 12, height - 4);
      let x = seat.position.x;
      let y = seat.position.y;
      if (id === 'ai-1') x += (this.viewport.compact ? 128 : 122) + width / 2;
      else if (id === 'player') x -= (this.viewport.compact ? 128 : 122) + width / 2;
      else if (this.viewport.compact && (id === 'ai-4' || id === 'ai-5')) y -= 68;
      else y += 68;
      badge.node.setPosition(x, y, 0);
    });
  }

  private clearWinProbability(): void {
    this.winProbabilityGeneration += 1;
    if (this.winProbabilityTimer !== null) clearTimeout(this.winProbabilityTimer);
    this.winProbabilityTimer = null;
    this.winProbabilityTask?.cancel();
    this.winProbabilityTask = null;
    this.winProbabilityKey = '';
    if (this.winProbabilityPanel) this.winProbabilityPanel.active = false;
  }

  private refreshWinProbability(state: EngineSnapshot): void {
    const player = state.players.find(p => p.id === 'player');
    if (this.mode !== 'solo' || !this.tableLayer.active || state.street === 'settled' || !player || player.folded) {
      this.clearWinProbability();
      return;
    }
    // Only the human's own cards and public state are passed to the estimator.
    const holeCards = this.engine.getHoleCards('player');
    const opponentCount = state.players.filter(p => p.id !== 'player' && !p.folded).length;
    if (holeCards.length !== 2 || opponentCount < 1) { this.clearWinProbability(); return; }
    const key = `${this.activeSessionToken}:${state.handId}:${holeCards.map(c => `${c.suit}${c.rank}`).join(',')}:${state.communityCards.map(c => `${c.suit}${c.rank}`).join(',')}:${opponentCount}`;
    if (key === this.winProbabilityKey) return;
    this.clearWinProbability();
    this.winProbabilityKey = key;
    this.winProbabilityPanel.active = true;
    this.winProbabilityLabel.string = '胜率估算中…';
    this.winProbabilityNote.string = `随机未知牌估算 · ${opponentCount}名对手`;
    const generation = this.winProbabilityGeneration;
    const token = this.activeSessionToken;
    const task = createWinProbabilityTask({ holeCards, communityCards: state.communityCards, opponentCount }, { samples: 1000 });
    this.winProbabilityTask = task;
    const step = () => {
      this.winProbabilityTimer = null;
      if (generation !== this.winProbabilityGeneration || !this.sessions.isCurrent(token) || this.mode !== 'solo') return;
      const result = task.step(8);
      if (result.done) {
        this.winProbabilityLabel.string = `胜出约 ${Math.round(result.winProbability * 100)}% · 平局约 ${Math.round(result.tieProbability * 100)}%`;
        this.winProbabilityTask = null;
      } else this.winProbabilityTimer = setTimeout(step, 0);
    };
    this.winProbabilityTimer = setTimeout(step, 0);
  }

  private renderActionButtons(actions: readonly PlayerAction[]): void {
    const ordered = [
      actions.find((action) => action.type === 'fold'),
      actions.find((action) => action.type === 'check') ?? actions.find((action) => action.type === 'call'),
      actions.find((action) => action.type === 'raise'),
      actions.find((action) => action.type === 'all-in'),
    ];

    this.actionButtons.forEach((button, index) => {
      const action = ordered[index] ?? null;
      button.action = action;
      button.onPress = action?.type === 'raise' ? () => this.openRaisePanel() : action?.type === 'all-in' && this.bettingPanel ? () => { this.bettingPanel!.openAllIn(); } : null;
      button.node.active = !this.raisePanel.active;
      this.setButtonEnabled(button.node, action !== null);
      const presentation = getActionPresentation(action, stateStack(this.currentSnapshot()));
      button.label.string = action ? presentation.title : ['弃牌', '过牌 / 跟注', '加注', '全压'][index];
      button.detail.string = action ? presentation.detail : '等待行动';
      button.label.color = index === 2 ? colorHex('#15251F') : TEXT;
      button.detail.color = index === 2 ? colorHex('#23392D') : index === 3 ? colorHex('#E7C8A7') : colorHex('#D2DFD8');
    });
  }

  private openRaisePanel(): void {
    if (this.mode === 'solo' && this.soloTurnClock.read()?.seconds === 0) { this.processSoloTurnTimeout(); return; }
    if (this.bettingPanel) { this.bettingPanel.openRaise(); return; }
    if (!this.hasLegalRaise() || this.busy) return;
    const bounds = this.getRaiseBounds();
    this.findNode('raise-less')!.children[0].getComponent(Label)!.string = `−${bounds.step}`;
    this.findNode('raise-more')!.children[0].getComponent(Label)!.string = `+${bounds.step}`;
    this.raiseOverlay.active = true;
    const overlayOpacity = this.raiseOverlay.getComponent(UIOpacity)!;
    overlayOpacity.opacity = 0;
    tween(overlayOpacity).to(this.duration(0.14), { opacity: 255 }, { easing: 'quadOut' }).start();

    this.raisePanel.active = true;
    const panelOpacity = this.raisePanel.getComponent(UIOpacity)!;
    panelOpacity.opacity = 0;
    this.raisePanel.setPosition(0, POKER_RAISE_MODAL.y - 16, 0);
    this.raisePanel.setScale(0.97, 0.97, 1);
    tween(this.raisePanel)
      .to(this.duration(0.16), { position: new Vec3(0, POKER_RAISE_MODAL.y, 0), scale: Vec3.ONE }, { easing: 'quadOut' })
      .start();
    tween(panelOpacity).to(this.duration(0.16), { opacity: 255 }, { easing: 'quadOut' }).start();
    this.setRaiseAmount(bounds.minTo);
    this.renderActionButtons([]);
  }

  private closeRaisePanel(): void {
    this.hideRaisePanel(() => this.render(this.currentSnapshot()));
  }

  private hideRaisePanel(afterClose?: () => void): void {
    if (!this.raisePanel.active) {
      afterClose?.();
      return;
    }

    const token = this.activeSessionToken;
    const panelOpacity = this.raisePanel.getComponent(UIOpacity)!;
    const overlayOpacity = this.raiseOverlay.getComponent(UIOpacity)!;
    tween(this.raisePanel)
      .to(this.duration(0.12), { position: new Vec3(0, POKER_RAISE_MODAL.y - 10, 0), scale: new Vec3(0.98, 0.98, 1) }, { easing: 'quadIn' })
      .call(() => {
        if (!this.sessions.isCurrent(token)) return;
        this.raisePanel.active = false;
        this.raisePanel.setPosition(0, POKER_RAISE_MODAL.y, 0);
        this.raisePanel.setScale(Vec3.ONE);
        panelOpacity.opacity = 255;
        afterClose?.();
      })
      .start();
    tween(overlayOpacity)
      .to(this.duration(0.12), { opacity: 0 }, { easing: 'quadIn' })
      .call(() => {
        if (!this.sessions.isCurrent(token)) return;
        this.raiseOverlay.active = false;
        overlayOpacity.opacity = 255;
      })
      .start();
  }

  private adjustRaiseAmount(delta: number): void {
    if (!this.hasLegalRaise()) return;
    this.setRaiseAmount(Number(this.raiseInput.string) + delta);
  }

  private applyRaisePreset(preset: RaisePreset): void {
    if (!this.hasLegalRaise()) return;
    this.setRaiseAmount(chooseRaisePreset(preset, this.getRaiseBounds()));
  }

  private setRaiseAmount(candidate: number): void {
    this.selectedRaiseTo = normalizeRaiseTo(candidate, this.getRaiseBounds());
    this.raiseAmountLabel.string = `加注至 ${this.selectedRaiseTo}`;
    this.raiseInput.string = String(this.selectedRaiseTo);
    const bounds = this.getRaiseBounds();
    const extra = this.selectedRaiseTo - bounds.streetContribution;
    this.raiseDetailLabel.string = `可加注 ${bounds.minTo.toLocaleString()}–${bounds.maxTo.toLocaleString()} · 本次投入 ${extra.toLocaleString()}`;
    this.raiseConfirmButton.children[0].getComponent(Label)!.string = `确认加注至 ${this.selectedRaiseTo.toLocaleString()}`;
  }

  private currentSnapshot(): EngineSnapshot {
    if (this.mode === 'online' && this.onlineSnapshot) {
      return this.onlineSnapshot;
    }

    return this.engine.snapshot();
  }

  private tableBlinds(state: EngineSnapshot = this.currentSnapshot()): BlindConfig {
    return normalizeBlinds(state.blinds ?? (this.mode === 'online' ? this.lastOnlineRoom?.blinds : undefined));
  }

  private hasLegalRaise(): boolean {
    const state = this.currentSnapshot();
    return (this.mode !== 'online' || this.online?.canAct()) && state.actingPlayerId === 'player' && state.legalActions.some((action) => action.type === 'raise');
  }

  private getRaiseBounds(): RaiseBounds {
    const state = this.currentSnapshot();
    const player = state.players.find(({ id }) => id === 'player')!;
    const minimum = state.legalActions.find((action) => action.type === 'raise');

    if (!minimum || minimum.type !== 'raise') {
      throw new Error('No legal raise is available');
    }

    return {
      minTo: minimum.to,
      maxTo: player.streetContribution + player.stack,
      pot: state.pot,
      toCall: state.legalActions.find((action) => action.type === 'call')?.amount ?? 0,
      streetContribution: player.streetContribution,
      step: Math.max(1, Math.floor(this.tableBlinds(state).bigBlind / 2)),
    };
  }

  private async confirmRaise(): Promise<void> {
    // 联机模式下等待加注面板期间，服务器可能已超时自动弃牌/结算，快照不再合法
    if (!this.hasLegalRaise() || this.busy) {
      this.hideRaisePanel();
      return;
    }

    const to = normalizeRaiseTo(Number(this.raiseInput.string), this.getRaiseBounds());
    this.hideRaisePanel();
    await this.handlePlayerAction({ type: 'raise', to });
  }

  private rememberHandResult(state: EngineSnapshot): void {
    const awards = this.handAwards.filter(a => a.handId === state.handId);
    if (!awards.length || this.lastHandResult?.handId === state.handId) return;
    const names = this.mode === 'online' ? this.online?.seatNames() : new Map(getPokerSeatLayout().map(p => [p.id, p.name]));
    const players = state.players.map(p => ({ id: p.id, name: p.id === 'player' && this.mode === 'online' ? this.activeCredentials?.nickname ?? names?.get(p.id) ?? p.name : names?.get(p.id) ?? p.name }));
    const ownStack = state.players.find(p => p.id === 'player')?.stack;
    this.lastHandResult = buildHandResult(state.handId, awards, players, 'player', this.mode === 'solo' && ownStack !== undefined ? ownStack - this.soloOpeningStack : undefined);
    this.setButtonEnabled(this.findNode('table-last-hand')!, true);
  }

  private showLastHand(): void {
    if (!this.lastHandResult || this.flow.screen !== 'playing') return;
    // Never open a history modal on top of an active decision or buy more decision time.
    if (this.currentSnapshot().actingPlayerId === 'player' && this.currentSnapshot().street !== 'settled') {
      this.turnLabel.string = '请先完成当前行动，再查看上手结果';
      return;
    }
    this.handResultPanel?.show(this.lastHandResult, { canSkip: false });
  }

  private clearHandHistory(): void {
    this.lastHandResult = null;
    this.handAwards = [];
    this.handResultPanel?.close();
    this.setButtonEnabled(this.findNode('table-last-hand')!, false);
  }

  private clearSoloRestart(): void {
    if (this.soloRestartHandler) this.resultLabel.node.off(Node.EventType.TOUCH_END, this.soloRestartHandler, this, true);
    this.soloRestartHandler = null;
  }

  private resetVisuals(): void {
    this.handResultPanel?.close();
    this.handAwards = [];
    this.seatActions.clear(); this.thinkingSeatId = null; this.seatActionStreet = null;
    this.handPositions = null;
    this.positionBadges.forEach(badge => badge.node.active = false);
    this.clearSoloTurnClock();
    this.clearSoloRestart();
    this.clearWinProbability();
    this.bettingPanel?.close(false);
    this.tableChips?.clear();
    this.resultLabel.node.active = false;
    this.raisePanel.active = false;
    this.raiseOverlay.active = false;
    this.communityCards.forEach((card) => card.node.active = false);
    this.winnerId = null;
    this.seats.forEach((seat) => {
      seat.nextCard = 0;
      seat.cards.forEach((card) => { const opacity = card.node.getComponent(UIOpacity); if (opacity) opacity.opacity = 255; });
      this.paintSeatStatus(seat, { text: '待行动', tone: 'waiting', committed: 0 });
      seat.highlight.active = seat.id === 'player';
      seat.cards.forEach((card) => card.node.active = false);
    });
  }

  private highlightWinner(id: string): void {
    this.winnerId = id;
    this.seats.forEach((seat) => {
      seat.highlight.active = seat.id === 'player' || seat.id === id;
    });
    const seat = this.seats.get(id)!;
    tween(seat.node)
      .to(this.duration(0.14), { scale: new Vec3(POKER_SHOWDOWN_FEEDBACK.winnerScale, POKER_SHOWDOWN_FEEDBACK.winnerScale, 1) }, { easing: 'quadOut' })
      .start();
  }

  private setSeatAction(id: string, text: string): void {
    const seat = this.seats.get(id)!;
    const player = this.currentSnapshot().players.find(p => p.id === id);
    if (!player) return;
    if (text === '思考中…') this.thinkingSeatId = id;
    const status = getSeatBetStatus(player, this.seatActions.get(id) ?? null, this.thinkingSeatId === id);
    this.paintSeatStatus(seat, { ...status, text: player.folded || player.allIn ? status.text : text });
  }

  private paintSeatStatus(seat: SeatVisual, status: SeatBetStatus): void {
    const palette: Record<SeatBetStatus['tone'], [string, string, string]> = {
      fold: ['#303E44', '#E2E8EB', '#87999F'],
      'all-in': ['#783D2B', '#FFE2CB', '#F0A078'],
      raise: ['#6A4E20', '#FFE5A6', '#E0B75D'],
      call: ['#205A4B', '#C4F5D9', '#61B68B'],
      check: ['#274B60', '#CCEAFB', '#6A9DB8'],
      thinking: ['#245764', '#D1F5F7', '#75BDCC'],
      bet: ['#52472C', '#F8E2AA', '#AC945D'],
      waiting: ['#22363A', '#B8CAC8', '#4B6669'],
    };
    const [fill, ink, border] = palette[status.tone];
    seat.action.string = status.text; seat.action.color = colorHex(ink);
    if (seat.statusTone === status.tone) return;
    seat.statusTone = status.tone;
    const box = this.boxes.get(seat.actionBadge)!;
    box.color = colorHex(fill); box.stroke = colorHex(border);
    const size = seat.actionBadge.getComponent(UITransform)!;
    this.resizeBox(seat.actionBadge, size.width, size.height);
  }

  private showCard(visual: CardVisual, card: Card | undefined, faceUp: boolean): void {
    visual.front.active = faceUp && card !== undefined;
    visual.back.active = !visual.front.active;
    if (!card) {
      return;
    }

    visual.rank.string = rankText(card.rank);
    visual.suit.string = suitText(card.suit);
    const red = card.suit === 'H' || card.suit === 'D';
    visual.rank.color = red ? colorHex('#AC4D4E') : colorHex('#192A30');
    visual.suit.color = visual.rank.color;
  }

  private createCard(parent: Node, home: Vec3): CardVisual {
    const node = this.createRounded('card', parent, home.x, home.y, 52, 68, POKER_UI.radii.card, colorHex('#F2EFE7'), colorHex('#CFD0C7'), 1);
    const front = new Node('front');
    node.addChild(front);
    const rank = this.createLabel(front, '', -13, 15, 17, colorHex('#192A30'));
    const suit = this.createLabel(front, '', 0, -5, 24, colorHex('#192A30'));
    const back = this.createRounded('back', node, 0, 0, 50, 66, 5, PANEL_RAISED, GOLD, 1);
    this.createLabel(back, '♠', 0, 0, 22, MUTED);
    return { node, front, back, rank, suit, home };
  }

  private createRounded(
    name: string,
    parent: Node,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
    color: Color,
    strokeColor?: Color,
    strokeWidth = 0,
  ): Node {
    const node = new Node(name);
    parent.addChild(node);
    const transform = node.addComponent(UITransform);
    transform.setContentSize(width, height);
    transform.setAnchorPoint(0.5, 0.5);
    node.setPosition(x, y, 0);
    if (['rules-panel', 'settings-panel', 'online-panel', 'lobby-panel', 'return-home-panel'].indexOf(name) !== -1) node.addComponent(BlockInputEvents);
    this.boxes.set(node, { width, height, radius, color, stroke: strokeColor, line: strokeWidth });
    const graphics = node.addComponent(Graphics);
    graphics.fillColor = color;
    graphics.roundRect(-width / 2, -height / 2, width, height, radius);
    graphics.fill();
    if (strokeColor && strokeWidth > 0) {
      graphics.strokeColor = strokeColor;
      graphics.lineWidth = strokeWidth;
      graphics.roundRect(-width / 2, -height / 2, width, height, radius);
      graphics.stroke();
    }
    return node;
  }

  private createLabel(parent: Node, text: string, x: number, y: number, size: number, color: Color): Label {
    const node = new Node('label');
    parent.addChild(node);
    const transform = node.addComponent(UITransform);
    transform.setContentSize(260, Math.max(30, size * 2));
    transform.setAnchorPoint(0.5, 0.5);
    node.setPosition(x, y, 0);
    const label = node.addComponent(Label);
    label.string = text;
    label.fontSize = size;
    label.lineHeight = size + 7;
    label.color = color;
    label.horizontalAlign = Label.HorizontalAlign.CENTER;
    label.verticalAlign = Label.VerticalAlign.CENTER;
    return label;
  }

  private createParagraph(parent: Node, text: string, x: number, y: number, width: number, height: number, size: number, color: Color): Label {
    const node = new Node('paragraph');
    parent.addChild(node);
    const transform = node.addComponent(UITransform);
    transform.setContentSize(width, height);
    transform.setAnchorPoint(0.5, 0.5);
    node.setPosition(x, y, 0);
    const label = node.addComponent(Label);
    label.string = text;
    label.fontSize = size;
    label.lineHeight = size + 8;
    label.color = color;
    label.overflow = Label.Overflow.CLAMP;
    label.horizontalAlign = Label.HorizontalAlign.LEFT;
    label.verticalAlign = Label.VerticalAlign.TOP;
    return label;
  }

  private async animateChip(from: Vec3, to: Vec3, token: number, duration = POKER_SHOWDOWN_FEEDBACK.chipDuration): Promise<void> {
    if (!this.sessions.isCurrent(token)) {
      return;
    }
    const chip = this.tableChips.createMovingChip(this.tableLayer);
    chip.setPosition(from);
    this.transientNodes.add(chip);
    await this.move(chip, to, duration);
    if (chip.isValid) {
      chip.destroy();
    }
    this.boxes.delete(chip);
    this.transientNodes.delete(chip);
  }

  private updateKeyboardToolbar(): void {
    if (!sys.isBrowser || !this.isValid || !this.viewport.compact) return;
    const active=document.activeElement;
    if (!(active instanceof HTMLInputElement) || active.readOnly || ['range','checkbox','button'].indexOf(active.type) >= 0) return;
    if (!this.keyboardToolbar) {
      const bar=document.createElement('div');bar.className='poker-keyboard-toolbar';
      const button=document.createElement('button');button.textContent='收起键盘，继续操作';
      button.onpointerdown=(event)=>event.preventDefault();
      button.onclick=()=>{ const input=document.activeElement;if(input instanceof HTMLInputElement)input.blur(); };
      bar.appendChild(button);document.body.appendChild(bar);this.keyboardToolbar=bar;
    }
    const visual=window.visualViewport;
    this.keyboardToolbar.style.top=`${window.scrollY+(visual?.offsetTop??0)+(visual?.height??window.innerHeight)-56}px`;
    this.keyboardToolbar.style.left=`${window.scrollX+(visual?.offsetLeft??0)+12}px`;
    this.keyboardToolbar.style.width=`${Math.max(0,(visual?.width??window.innerWidth)-24)}px`;
  }

  private captureLayout(node: Node): void {
    this.originalPositions.set(node, node.position.clone());
    const label = node.getComponent(Label);
    if (label) this.originalFonts.set(label, label.fontSize);
    node.children.forEach((child) => this.captureLayout(child));
  }

  private findNode(name: string, root: Node = this.node): Node | null {
    if (root.name === name) return root;
    for (const child of root.children) { const found = this.findNode(name, child); if (found) return found; }
    return null;
  }

  private resizeBox(node: Node | null, width: number, height: number): void {
    if (!node || !node.isValid) return;
    const box = this.boxes.get(node);
    if (!box) return;
    node.getComponent(UITransform)!.setContentSize(width, height);
    const g = node.getComponent(Graphics)!;
    g.clear(); g.fillColor = box.color;
    const radius = Math.min(box.radius, height / 2, width / 2);
    g.roundRect(-width / 2, -height / 2, width, height, radius); g.fill();
    if (box.stroke && box.line > 0) {
      g.strokeColor = box.stroke; g.lineWidth = box.line;
      g.roundRect(-width / 2, -height / 2, width, height, radius); g.stroke();
    }
  }

  private place(name: string, x: number, y: number): void { this.findNode(name)?.setPosition(x, y, 0); }

  private applyViewport(): void {
    if (!sys.isBrowser || !this.isValid || !this.homeLayer?.isValid || !this.originalPositions.size) return;
    const active = document.activeElement;
    const shell = document.querySelector<HTMLElement>('.game-shell');
    const bodyStyle = getComputedStyle(document.body);
    const width = Math.min(1280, window.innerWidth - parseFloat(bodyStyle.paddingLeft || '0') - parseFloat(bodyStyle.paddingRight || '0'));
    const height = window.innerHeight - parseFloat(bodyStyle.paddingTop || '0') - parseFloat(bodyStyle.paddingBottom || '0');
    const editing = active instanceof HTMLInputElement && !active.readOnly && ['range','checkbox','button'].indexOf(active.type) < 0 && active.offsetParent !== null;
    // Keep editing stable for keyboard height changes, but reflow on rotation or inset width changes.
    if (editing && Math.abs(width - this.viewportWidth) < 1) return;
    const v = getPokerViewport(width, height);
    this.viewport = v;
    this.viewportWidth = width;
    document.documentElement.style.setProperty('--poker-ratio', String(v.designWidth / v.designHeight));
    if (shell) shell.style.width = `${Math.min(width, height * v.designWidth / v.designHeight)}px`;
    view.setDesignResolutionSize(v.designWidth, v.designHeight, 4);
    this.originalPositions.forEach((pos, node) => { if (node.isValid) node.setPosition(pos); });
    this.boxes.forEach((box, node) => { if (!node.isValid) { this.boxes.delete(node); return; } this.resizeBox(node, box.width, box.height); });
    this.originalFonts.forEach((size, label) => { label.fontSize = size; label.lineHeight = size + 7; });
    for (const layer of [this.tableLayer, this.homeLayer, this.returnOverlay, this.rulesPanel, this.settingsPanel, this.onlineLayer, this.lobbyLayer]) {
      layer.getComponent(UITransform)?.setContentSize(1280, v.designHeight);
    }
    this.boxes.forEach((box, node) => {
      if (box.width === 1280 && box.height === 720) this.resizeBox(node, 1280, v.designHeight);
    });
    const scale = Math.min(width / v.designWidth, height / v.designHeight, 1);
    const h = v.designHeight;
    if (v.compact) {
      const minFont = Math.ceil(12 / scale);
      this.originalFonts.forEach((size, label) => { label.fontSize = Math.max(size, minFont); label.lineHeight = label.fontSize + 4; });
      const a = v.actionHeight;
      this.findNode('table-rim')?.setScale(1,Math.min(1,(h-150)/480),1);
      this.findNode('felt')?.setScale(1,Math.min(1,(h-150)/480),1);
      this.place('top-bar', 0, h / 2 - 32);
      const tableLabels = this.tableLayer.children.filter((n) => n.name === 'label');
      tableLabels.slice(0,2).forEach((n) => n.setPosition(n.position.x, h / 2 - 32, 0));
      this.place('virtual-chips-label', 288, h / 2 - 32); this.findNode('virtual-chips-label')!.active = false;
      this.place('table-last-hand', -340, h / 2 - 32); this.resizeBox(this.findNode('table-last-hand'), 126, a);
      this.place('table-mute', 150, h / 2 - 32); this.resizeBox(this.findNode('table-mute'), 120, a);
      this.place('return-home', 528, h / 2 - 32); this.resizeBox(this.findNode('return-home'), 104, a);
      this.place('table-ledger', 286, h / 2 - 32); this.resizeBox(this.findNode('table-ledger'), 126, a);
      this.place('table-invite', 414, h / 2 - 32); this.resizeBox(this.findNode('table-invite'), 92, a);
      this.place('deck', 0, h / 2 - 160);
      this.place('pot-panel', h < 620 ? -210 : 0, h < 620 ? -34 : 86); this.resizeBox(this.findNode('pot-panel'), 240, 42);
      this.potLabel.fontSize = Math.ceil(16 / scale); this.potLabel.lineHeight = this.potLabel.fontSize + 3;
      const communityY = h > 620 ? 36 : 30;
      this.communityCards.forEach((card,i) => { card.home.set((i-2)*56,communityY,0); if (!this.motion.has(card.node)) card.node.setPosition(card.home); });
      this.tableLayer.children.filter(n=>n.name.indexOf('community-slot-')===0).forEach((node)=>node.setPosition(node.position.x,communityY,0));
      const buttonY = -h / 2 + 12 + a / 2;
      const statusY = buttonY + a / 2 + 22;
      this.resizeBox(this.findNode('action-bar'), 1180, a + 36);
      this.place('action-bar', 0, buttonY + 12);
      this.turnLabel.node.setPosition(0, statusY, 0);
      this.turnLabel.fontSize = Math.ceil(13 / scale);
      this.streetLabel.node.setPosition(-100, h / 2 - 32, 0); this.streetLabel.fontSize = Math.ceil(11 / scale);
      this.turnTimer.setPosition(414, statusY + 9 / scale, 0);
      this.resizeBox(this.turnTimer, 240, 30 / scale);
      this.turnTimerLabel.fontSize = Math.ceil(16 / scale);
      this.turnTimerLabel.node.getComponent(UITransform)!.setContentSize(224, 24 / scale);
      this.actionButtons.forEach((button) => {
        button.node.setPosition(button.node.position.x, buttonY, 0);
        this.resizeBox(button.node, 252, a);
        button.label.fontSize = Math.ceil(13 / scale);
        button.label.lineHeight = button.label.fontSize + 2;
        button.label.node.setPosition(0, a * 0.22, 0);
        button.label.node.getComponent(UITransform)!.setContentSize(228, a * 0.44);
        button.detail.fontSize = Math.ceil(12 / scale);
        button.detail.lineHeight = button.detail.fontSize + 2;
        button.detail.node.setPosition(0, -a * 0.24, 0);
        button.detail.node.getComponent(UITransform)!.setContentSize(228, a * 0.42);
      });
      const points: Record<string, [number,number]> = {
        'ai-1': [0, h / 2 - 121], 'ai-2': [-430, h / 2 - 168], 'ai-3': [430, h / 2 - 168],
        'ai-4': [500, statusY + 112], 'ai-5': [-500, statusY + 112], 'player': [0, statusY + 56],
      };
      this.seats.forEach((seat,id) => {
        const [x,y] = points[id]; seat.node.setPosition(x,y,0); seat.position.set(x,y,0);
        this.resizeBox(seat.node, 232, 84);
        this.resizeBox(seat.highlight, 228, 80);
        seat.name.fontSize = Math.ceil(12 / scale); seat.name.lineHeight = seat.name.fontSize + 2;
        seat.chips.fontSize = Math.ceil(14 / scale); seat.chips.lineHeight = seat.chips.fontSize + 2;
        seat.name.node.setPosition(26, 27, 0); seat.chips.node.setPosition(26, 1, 0);
        seat.action.fontSize = Math.ceil(12 / scale); seat.action.lineHeight = seat.action.fontSize + 2;
        seat.actionBadge.setPosition(26, -28, 0); this.resizeBox(seat.actionBadge, 154, 30);
        seat.action.node.getComponent(UITransform)!.setContentSize(144, 28);
        for (const label of [seat.name, seat.chips]) label.node.getComponent(UITransform)!.setContentSize(144, 25);
        const low = id === 'ai-4' || id === 'ai-5';
        const cardX = low ? x + (x > 0 ? 50 : -50) : x;
        seat.cards.forEach((card,i) => { card.home.set(cardX + (i ? 29 : -29), y + (id === 'player' ? 84 : id === 'ai-1' && h < 620 ? -76 : low ? 84 : -84),0); const cardScale=id==='ai-1'&&h<620?0.7:1; card.node.setScale(cardScale,cardScale,1); });
      });
      this.winProbabilityPanel.setPosition(280, points.player[1] - 6, 0);
      this.resizeBox(this.winProbabilityPanel, 300, 60);
      this.winProbabilityLabel.fontSize = Math.ceil(12 / scale);
      this.winProbabilityLabel.lineHeight = this.winProbabilityLabel.fontSize + 3;
      this.winProbabilityNote.fontSize = Math.ceil(10 / scale);
      this.winProbabilityNote.lineHeight = this.winProbabilityNote.fontSize + 3;
      const readableCards = [...this.communityCards];
      this.seats.forEach(seat=>readableCards.push(...seat.cards));
      readableCards.forEach(card=>{
        const cardScale=card.node.scale.x;
        const rankCss=cardScale<1?12:14;
        card.rank.fontSize=Math.ceil(rankCss/(scale*cardScale));card.rank.lineHeight=card.rank.fontSize+2;
        card.suit.fontSize=Math.ceil((rankCss+4)/(scale*cardScale));card.suit.lineHeight=card.suit.fontSize+2;
        card.rank.node.setPosition(-13,17,0);card.suit.node.setPosition(0,-15,0);
      });
      // Keep form controls reachable at the actual CSS target size.
      this.layoutCompactForms(a, h, scale);
      // Home entry controls use available height rather than a scaled fixed card.
      const play = this.findNode('home-play-panel');
      const ph = h - 150;
      this.resizeBox(play, 424, ph); play?.setPosition(286, -26, 0);
      if (play) {
        const labels = play.children.filter((n) => n.name === 'label');
        labels[0]?.setPosition(0, ph / 2 - 32, 0);
        labels[1]?.setPosition(0, ph / 2 - a * 2 - 130, 0);
        labels[2]?.setPosition(0, ph / 2 - a - 82, 0);
      }
      this.place('home-resume', -330, -h / 2 + a / 2 + 76); this.resizeBox(this.findNode('home-resume'), 440, a);
      this.place('home-start', 0, ph / 2 - a * 1.5 - 108); this.resizeBox(this.findNode('home-start'),344,a);
      this.place('home-online', 0, ph / 2 - a / 2 - 60); this.resizeBox(this.findNode('home-online'),344,a);
      this.place('home-rules', -90, -ph / 2 + a / 2 + 14); this.resizeBox(this.findNode('home-rules'),164,a);
      this.place('home-settings', 90, -ph / 2 + a / 2 + 14); this.resizeBox(this.findNode('home-settings'),164,a);
      const homeLabels = this.homeLayer.children.filter((n) => n.name === 'label');
      homeLabels.slice(0,2).forEach((n)=>n.setPosition(n.position.x,h/2-28,0));
      homeLabels[2]?.setPosition(0,-h/2+22,0);
      this.place('home-divider',0,h/2-60);
      const hero = this.findNode('home-hero');
      if (hero) {
        hero.children.filter((n)=>n.name==='label').forEach((n,i)=>{ n.setPosition(-310, [h/2-144,h/2-190,-h/2+a+100][i],0); const l=n.getComponent(Label)!; l.horizontalAlign=Label.HorizontalAlign.LEFT; n.getComponent(UITransform)!.setContentSize(520,n.getComponent(UITransform)!.height); });
        hero.children.filter(n => n.name === 'card').forEach(n => n.setPosition(n.position.x, 5, 0));
      }
      this.resultLabel.node.setPosition(0, -8, 0);
    } else {
      this.findNode('table-rim')?.setScale(Vec3.ONE);this.findNode('felt')?.setScale(Vec3.ONE);
      this.seats.forEach((seat,id) => {
        const point = getPokerSeatLayout().find((p)=>p.id===id)!;
        seat.position.set(point.x,point.y,0);
        seat.cards.forEach((card,i)=>{card.home.set(point.x+(i?29:-29),point.y+(id==='player'?90:-84),0);card.node.setScale(Vec3.ONE);});
      });
    }
    if (!v.compact) this.communityCards.forEach((card,i)=>{ card.home.set((i-2)*56,8,0); if (!this.motion.has(card.node)) card.node.setPosition(card.home); });
    this.seats.forEach((seat)=>seat.cards.forEach((card)=>{ if (!this.motion.has(card.node)) card.node.setPosition(card.home); }));
    if (width > height) this.boxes.forEach((box,node)=>{ if(node.isValid && node.getComponent(Button)) { const size=node.getComponent(UITransform)!;this.resizeBox(node,size.width,Math.max(size.height,v.actionHeight)); } });
    const canvas = document.querySelector<HTMLCanvasElement>('#GameCanvas');
    if (canvas) {
      director.root?.resize(canvas.width, canvas.height);
      this.node.getChildByName('Camera')?.getComponent(Camera)?.camera?.resize(canvas.width, canvas.height);
    }
    if (editing && v.compact) {
      // Cocos applies native text styles at editing start; keep the focused input readable after rotation.
      if (active instanceof HTMLInputElement) {
        const fontSize = Math.ceil(16 / scale);
        active.style.fontSize = `${fontSize}px`;
        active.style.lineHeight = `${fontSize + 4}px`;
      }
      document.body.classList.add('keyboard-open');
      this.updateKeyboardToolbar();
    } else if (!v.compact) {
      document.body.classList.remove('keyboard-open');
      this.keyboardToolbar?.remove();
      this.keyboardToolbar = null;
    }
    this.renderPositionBadges();
    if (this.tableLayer.active && (this.mode === 'solo' || this.onlineSnapshot)) this.render(this.currentSnapshot());
  }

  private layoutCompactForms(action: number, height: number, scale: number): void {
    const online = this.onlinePanel;
    const ph = Math.min(height - 18, 710);
    this.resizeBox(online, 900, ph);
    const labels = online.children.filter((n)=>n.name==='label'); labels[0]?.setPosition(0, ph/2-30,0);
    const gap = action + 8;
    const first = ph/2 - 66 - action/2;
    ['online-nickname','online-server','online-room-code'].forEach((name,i)=>{
      const y=first-i*gap; this.place(name, 75, y); this.resizeBox(this.findNode(name), 620, action);
      const input=this.findNode(`${name}-control`); input?.getComponent(UITransform)?.setContentSize(596,action);
      labels[i+1]?.setPosition(-350,y,0);
    });
    const blindY = first - 3 * gap;
    this.place('online-blinds', 0, blindY); this.resizeBox(this.findNode('online-blinds'), 620, action);
    this.onlineStatusLabel.node.setPosition(0, blindY-action/2-20,0);
    this.onlineStatusLabel.fontSize = Math.ceil(11 / scale);
    this.onlineStatusLabel.lineHeight = this.onlineStatusLabel.fontSize + 3;
    this.onlineStatusLabel.node.getComponent(UITransform)!.setContentSize(820,32);
    const buttonsY=-ph/2+action*1.5+22;
    this.place('online-create',-220,buttonsY); this.resizeBox(this.onlineCreateButton,400,action);
    this.place('online-join',220,buttonsY); this.resizeBox(this.onlineJoinButton,400,action);
    this.place('online-back',0,-ph/2+action/2+8); this.resizeBox(this.findNode('online-back'),250,action);
    const lobbyHeight = height - 70;
    this.resizeBox(this.findNode('lobby-panel'), 1160, lobbyHeight);
    this.place('lobby-title', -390, lobbyHeight / 2 - 40);
    this.place('lobby-room-caption', -390, lobbyHeight / 2 - 100);
    this.lobbyCodeLabel.node.setPosition(-390, lobbyHeight / 2 - 155, 0);
    this.place('lobby-rules', -350, lobbyHeight / 2 - 225);
    this.place('lobby-leave', 470, lobbyHeight / 2 - 40); this.resizeBox(this.findNode('lobby-leave'),180,action);
    this.lobbySeatLabels.forEach((label, i) => {
      this.place(`lobby-seat-${i}`, i % 2 ? 410 : 150, lobbyHeight / 2 - 110 - Math.floor(i / 2) * 80);
      this.resizeBox(this.findNode(`lobby-seat-${i}`), 240, 54);
      label.fontSize = Math.ceil(14 / scale); label.node.getComponent(UITransform)?.setContentSize(220, 48);
    });
    this.lobbyStatusLabel.node.setPosition(-300, lobbyHeight / 2 - 292, 0);
    this.lobbyStatusLabel.node.getComponent(UITransform)?.setContentSize(480, 72);
    this.place('lobby-invite', -410, -lobbyHeight / 2 + action / 2 + 18); this.resizeBox(this.findNode('lobby-invite'),220,action);
    this.place('lobby-ledger', -160, -lobbyHeight / 2 + action / 2 + 18); this.resizeBox(this.findNode('lobby-ledger'),220,action);
    this.place('lobby-start', 280, -lobbyHeight / 2 + action / 2 + 18); this.resizeBox(this.lobbyStartButton,480,action);
    const raiseHeight=Math.min(height-18,600);
    this.resizeBox(this.raisePanel,900,raiseHeight);
    this.raisePanel.setPosition(0,0,0);
    const raiseLabels=this.raisePanel.children.filter((n)=>n.name==='label');
    raiseLabels[0]?.setPosition(0,raiseHeight/2-28,0);
    raiseLabels[1]?.setPosition(0,raiseHeight/2-64,0);
    this.raiseAmountLabel.node.setPosition(-200,raiseHeight/2-110,0);
    this.place('raise-input',210,raiseHeight/2-110); this.resizeBox(this.findNode('raise-input'),330,action);
    this.raiseInput.node.getComponent(UITransform)!.setContentSize(306,action);
    this.raiseDetailLabel.node.setPosition(0,raiseHeight/2-162,0);
    const presets=['raise-less','raise-more','raise-minimum','raise-half-pot','raise-pot','raise-all-in'];
    presets.forEach((name,i)=>{ this.place(name,(i-2.5)*142,-12);this.resizeBox(this.findNode(name),132,action); });
    this.place('raise-cancel',-215,-raiseHeight/2+action/2+16);this.resizeBox(this.findNode('raise-cancel'),390,action);
    this.place('raise-confirm',215,-raiseHeight/2+action/2+16);this.resizeBox(this.raiseConfirmButton,390,action);
    for (const input of [this.onlineNicknameInput,this.onlineServerInput,this.onlineRoomCodeInput,this.raiseInput]) {
      if (input.textLabel) { input.textLabel.fontSize=Math.ceil(16/scale);input.textLabel.lineHeight=input.textLabel.fontSize+4; }
      if (input.placeholderLabel) { input.placeholderLabel.fontSize=Math.ceil(14/scale);input.placeholderLabel.lineHeight=input.placeholderLabel.fontSize+4; }
    }
    // Existing return and settings panels retain their simple rows with larger targets.
    for (const name of ['return-cancel','return-confirm','settings-sound','settings-speed','settings-confirm','settings-blinds','settings-close','rules-close','lobby-start','lobby-leave','lobby-invite','lobby-ledger','home-resume']) {
      const n=this.findNode(name); if(n) this.resizeBox(n,n.getComponent(UITransform)!.width,action);
    }
    this.resizeBox(this.returnPanel,760,Math.min(height-30,400));
    const returnLabels=this.returnPanel.children.filter((n)=>n.name==='label');
    returnLabels[0]?.setPosition(0,142,0);
    const returnText=this.returnPanel.children.find((n)=>n.name==='paragraph');
    returnText?.setPosition(0,32,0);returnText?.getComponent(UITransform)?.setContentSize(680,110);
    const settings=this.findNode('settings-panel');
    const settingsHeight=Math.min(height-30,action*5+142);
    this.resizeBox(settings,760,settingsHeight);
    settings?.children.filter((n)=>n.name==='label')[0]?.setPosition(0,settingsHeight/2-32,0);
    ['settings-sound','settings-speed','settings-confirm','settings-blinds'].forEach((name,i)=>this.place(name,0,settingsHeight/2-70-action/2-i*(action+12)));
    this.place('settings-close',0,-settingsHeight/2+action/2+14);
    settings?.children.filter((n)=>n.name==='label')[1]?.setPosition(0,-settingsHeight/2+action+38,0);
    const rules=this.findNode('rules-panel');
    const rulesHeight=height-22;this.resizeBox(rules,1040,rulesHeight);
    rules?.children.filter((n)=>n.name==='label')[0]?.setPosition(0,rulesHeight/2-32,0);
    const rulesText=rules?.children.find((n)=>n.name==='paragraph');
    rulesText?.setPosition(0,4,0);rulesText?.getComponent(UITransform)?.setContentSize(940,rulesHeight-155);
    this.place('rules-close',0,-rulesHeight/2+action/2+12);
  }

  private cancelVisuals(): void {
    if (this.raisePanel) {
      Tween.stopAllByTarget(this.raisePanel);
      const p = this.raisePanel.getComponent(UIOpacity); if (p) Tween.stopAllByTarget(p);
      const o = this.raiseOverlay.getComponent(UIOpacity); if (o) Tween.stopAllByTarget(o);
      this.raisePanel.setPosition(0, POKER_RAISE_MODAL.y, 0); this.raisePanel.setScale(Vec3.ONE);
      if (p) p.opacity = 255; if (o) o.opacity = 255;
    }
    this.seats.forEach((seat) => { Tween.stopAllByTarget(seat.node); seat.node.setScale(Vec3.ONE); });
    this.motion.forEach((resolve, node) => { Tween.stopAllByTarget(node); resolve(); });
    this.motion.clear();
    this.delays.forEach((resolve, timer) => { clearTimeout(timer); resolve(); });
    this.delays.clear();
    this.transientNodes.forEach((node) => { if (node.isValid) node.destroy(); this.boxes.delete(node); });
    this.transientNodes.clear();
  }

  private move(node: Node, target: Vec3, duration: number): Promise<void> {
    return new Promise((resolve) => {
      this.motion.set(node, resolve);
      tween(node).to(this.duration(duration), { position: target }, { easing: 'quadOut' }).call(() => { this.motion.delete(node); resolve(); }).start();
    });
  }

  private wait(seconds: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.delays.delete(timer); resolve(); }, this.duration(seconds) * 1000);
      this.delays.set(timer, resolve);
    });
  }

  private duration(baseDuration: number): number {
    return scaleDuration(baseDuration, this.settings.animationSpeed);
  }
}

function rgb(red: number, green: number, blue: number): Color {
  return new Color(red, green, blue, 255);
}

function colorHex(hex: string): Color {
  const value = hex.replace('#', '');
  return rgb(Number.parseInt(value.slice(0, 2), 16), Number.parseInt(value.slice(2, 4), 16), Number.parseInt(value.slice(4, 6), 16));
}

function actionText(action: PlayerAction): string {
  return action.type === 'fold' ? '弃牌' : action.type === 'check' ? '过牌' : action.type === 'call' ? '跟注' : action.type === 'raise' ? '加注' : '全压';
}

function rankText(rank: number): string {
  return rank === 14 ? 'A' : rank === 13 ? 'K' : rank === 12 ? 'Q' : rank === 11 ? 'J' : rank === 10 ? '10' : String(rank);
}

function suitText(suit: Card['suit']): string {
  return { S: '♠', H: '♥', D: '♦', C: '♣' }[suit];
}

function streetText(street: Street): string {
  return { preflop: '翻牌前', flop: '翻牌圈', turn: '转牌圈', river: '河牌圈', showdown: '摊牌', settled: '结算' }[street];
}

function stateStack(state: EngineSnapshot): number { return state.players.find(p => p.id === 'player')?.stack ?? 0; }
