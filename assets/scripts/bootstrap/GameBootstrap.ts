import {
  _decorator,
  Color,
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
import { PokerEngine } from '../core/PokerEngine';
import { Card, EngineEvent, PlayerAction, PlayerSnapshot, Street } from '../core/types';
import {
  getActionButtonSpecs,
  getPokerSeatLayout,
  POKER_RAISE_MODAL,
  POKER_SHOWDOWN_FEEDBACK,
  POKER_UI,
} from '../ui/PokerUiTheme';
import { AiAvatarPreset, assignAiAvatars } from '../ui/AiAvatar';
import { GameAudio } from '../ui/GameAudio';
import { AnimationSpeed, DEFAULT_GAME_SETTINGS, GameSettings, loadGameSettings, saveGameSettings, scaleDuration } from '../ui/GameSettings';
import { createHomeFlow, HomeFlowState, reduceHomeFlow } from '../ui/HomeFlow';
import { chooseRaisePreset, normalizeRaiseTo, RaiseBounds, RaisePreset } from '../ui/RaiseAmount';
import { SessionGeneration } from '../ui/SessionGeneration';

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
  chips: Label;
  action: Label;
  dealer: Label;
  highlight: Node;
  cards: CardVisual[];
  position: Vec3;
  nextCard: number;
}

interface ActionVisual {
  node: Node;
  label: Label;
  action: PlayerAction | null;
  onPress: (() => void) | null;
}

const BACKGROUND = colorHex(POKER_UI.colors.background);
const PANEL = colorHex(POKER_UI.colors.panel);
const PANEL_RAISED = colorHex(POKER_UI.colors.panelRaised);
const TABLE_GREEN = colorHex(POKER_UI.colors.felt);
const GOLD = colorHex(POKER_UI.colors.gold);
const TEXT = colorHex(POKER_UI.colors.text);

@ccclass('GameBootstrap')
export class GameBootstrap extends Component {
  private engine = PokerEngine.createSixSeat();
  private flow: HomeFlowState = createHomeFlow();
  private settings: GameSettings = { ...DEFAULT_GAME_SETTINGS };
  private readonly sessions = new SessionGeneration();
  private activeSessionToken = 0;
  private audio!: GameAudio;
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
  private readonly transientNodes = new Set<Node>();
  private readonly seats = new Map<string, SeatVisual>();
  private readonly aiAvatars = assignAiAvatars(
    getPokerSeatLayout().filter(({ id }) => id !== 'player').map(({ id }) => id),
  );
  private readonly communityCards: CardVisual[] = [];
  private readonly actionButtons: ActionVisual[] = [];
  private potLabel!: Label;
  private streetLabel!: Label;
  private resultLabel!: Label;
  private raiseOverlay!: Node;
  private raisePanel!: Node;
  private raiseAmountLabel!: Label;
  private raiseInput!: EditBox;
  private selectedRaiseTo = 0;
  private busy = false;
  private winnerId: string | null = null;

  public onLoad(): void {
    view.setDesignResolutionSize(1280, 720, 4);
    this.settings = loadGameSettings(sys.localStorage);
    this.audio = new GameAudio(this.node, () => this.settings.soundEnabled);
    void this.audio.preload().catch(() => undefined);
    this.buildTable();
    this.buildHome();
    this.tableLayer.active = false;
    this.renderHome();
  }

  private buildTable(): void {
    this.tableLayer = new Node('table-layer');
    this.node.addChild(this.tableLayer);
    this.tableLayer.addComponent(UITransform).setContentSize(POKER_UI.canvas.width, POKER_UI.canvas.height);
    this.createRounded('background', this.tableLayer, 0, 0, POKER_UI.canvas.width, POKER_UI.canvas.height, 0, BACKGROUND);
    this.createRounded('top-bar', this.tableLayer, 0, 323, 1180, 62, POKER_UI.radii.panel, PANEL);
    this.createLabel(this.tableLayer, 'POKER CLUB', -525, 323, 23, GOLD);
    this.streetLabel = this.createLabel(this.tableLayer, '盲注 20 / 40 · 翻牌前', 0, 323, 18, TEXT);
    this.createLabel(this.tableLayer, '六人现金桌 · 虚拟筹码', 410, 323, 14, rgb(165, 190, 213));

    this.createTableFelt();
    this.createDeckMarker();
    const potPanel = this.createRounded('pot-panel', this.tableLayer, 0, 92, 146, 40, 18, PANEL_RAISED, GOLD, 1);
    this.potLabel = this.createLabel(potPanel, '底池 0', 0, 0, 18, GOLD);

    [-112, -56, 0, 56, 112].forEach((x, index) => {
      this.createRounded(`community-slot-${index}`, this.tableLayer, x, 8, 52, 68, POKER_UI.radii.card, PANEL_RAISED, rgb(55, 111, 104), 1);
      const card = this.createCard(this.tableLayer, new Vec3(x, 8, 0));
      card.node.active = false;
      this.communityCards[index] = card;
    });

    this.createSeats();
    this.createActionBar();
    this.createRaisePanel();
    this.createReturnHomeControl();
    this.resultLabel = this.createLabel(this.tableLayer, '', 0, 216, 25, GOLD);
    this.resultLabel.node.active = false;
  }

  private createTableFelt(): void {
    const rim = new Node('table-rim');
    this.tableLayer.addChild(rim);
    rim.addComponent(UITransform).setContentSize(1040, 480);
    const rimGraphics = rim.addComponent(Graphics);
    rimGraphics.fillColor = rgb(48, 80, 84);
    rimGraphics.ellipse(0, 4, 520, 240);
    rimGraphics.fill();
    rimGraphics.strokeColor = GOLD;
    rimGraphics.lineWidth = 4;
    rimGraphics.ellipse(0, 4, 500, 220);
    rimGraphics.stroke();

    const felt = new Node('felt');
    this.tableLayer.addChild(felt);
    felt.addComponent(UITransform).setContentSize(970, 420);
    const feltGraphics = felt.addComponent(Graphics);
    feltGraphics.fillColor = TABLE_GREEN;
    feltGraphics.ellipse(0, 4, 485, 210);
    feltGraphics.fill();
    feltGraphics.strokeColor = rgb(103, 203, 160);
    feltGraphics.lineWidth = 2;
    feltGraphics.ellipse(0, 4, 446, 178);
    feltGraphics.stroke();
  }

  private createDeckMarker(): void {
    const marker = this.createRounded('deck', this.tableLayer, 0, 152, 48, 66, POKER_UI.radii.card, rgb(26, 54, 111), GOLD, 1);
    this.createLabel(marker, '♠', 0, 0, 26, rgb(203, 230, 255));
  }

  private createSeats(): void {
    for (const { id, x, y, name } of getPokerSeatLayout()) {
      const isPlayer = id === 'player';
      const node = this.createRounded(
        `seat-${id}`,
        this.tableLayer,
        x,
        y,
        178,
        68,
        POKER_UI.radii.seat,
        rgb(25, 66, 76),
        rgb(48, 93, 110),
        1,
      );
      const opacity = node.addComponent(UIOpacity);
      opacity.opacity = 255;
      const highlight = this.createRounded('seat-highlight', node, 0, 0, 172, 62, 14, new Color(0, 0, 0, 0), GOLD, 2);
      highlight.active = isPlayer;
      const avatar = this.createRounded('seat-avatar', node, -66, 0, 32, 32, 16, rgb(44, 88, 110));
      if (isPlayer) {
        this.createLabel(avatar, '你', 0, 0, 11, TEXT);
      } else {
        this.drawAiAvatar(avatar, this.aiAvatars.get(id)!);
      }
      this.createLabel(node, name, 8, 16, 15, TEXT);
      const chips = this.createLabel(node, '5,000', 8, -5, 14, rgb(183, 244, 216));
      const action = this.createLabel(node, '', 8, -27, 12, GOLD);
      const dealer = this.createLabel(node, '', 66, 20, 11, GOLD);
      const cardY = isPlayer ? y + 82 : y - 70;
      const cards = [
        this.createCard(this.tableLayer, new Vec3(x - 29, cardY, 0)),
        this.createCard(this.tableLayer, new Vec3(x + 29, cardY, 0)),
      ];
      cards.forEach((card) => card.node.active = false);
      this.seats.set(id, { id, node, chips, action, dealer, highlight, cards, position: new Vec3(x, y, 0), nextCard: 0 });
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
    // Keep every action fully visible inside Cocos' preview viewport, whose toolbar
    // otherwise crops the lowest part of the 1280 × 720 design canvas.
    const actionBarY = -292;
    this.createRounded('action-bar', this.tableLayer, 0, actionBarY, 1180, 62, POKER_UI.radii.panel, PANEL);
    const actionSpecs = getActionButtonSpecs();

    [-405, -135, 135, 405].forEach((x, index) => {
      const node = this.createRounded(
        `action-${index}`,
        this.tableLayer,
        x,
        actionBarY,
        252,
        44,
        11,
        colorHex(actionSpecs[index].color),
      );
      const label = this.createLabel(node, '', 0, 0, 16, TEXT);
      const button: ActionVisual = { node, label, action: null, onPress: null };
      node.on(Node.EventType.TOUCH_END, () => {
        this.audio.play('ui-click');
        if (button.onPress) {
          button.onPress();
        } else if (button.action) {
          void this.handlePlayerAction(button.action);
        }
      });
      node.active = false;
      this.actionButtons.push(button);
    });
  }

  private createRaisePanel(): void {
    this.raiseOverlay = this.createRounded('raise-overlay', this.tableLayer, 0, 0, POKER_UI.canvas.width, POKER_UI.canvas.height, 0, new Color(4, 13, 28, 184));
    this.raiseOverlay.addComponent(UIOpacity);
    this.raiseOverlay.on(Node.EventType.TOUCH_END, () => undefined, this);
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
    this.createLabel(this.raisePanel, '自定义加注', 0, 74, 20, GOLD);
    this.raiseAmountLabel = this.createLabel(this.raisePanel, '加注至 0', -132, 36, 18, TEXT);

    const inputFrame = this.createRounded('raise-input', this.raisePanel, 118, 36, 152, 36, 8, rgb(14, 31, 52));
    const inputNode = new Node('raise-input-control');
    inputNode.parent = inputFrame;
    inputNode.addComponent(UITransform).setContentSize(152, 36);
    const inputLabel = this.createLabel(inputNode, '', 0, 0, 18, TEXT);
    this.raiseInput = inputNode.addComponent(EditBox);
    this.raiseInput.inputMode = EditBox.InputMode.NUMERIC;
    this.raiseInput.placeholder = '输入总额';
    this.raiseInput.textLabel = inputLabel;
    inputNode.on('editing-did-ended', () => this.setRaiseAmount(Number(this.raiseInput.string)), this);

    this.createTextButton(this.raisePanel, 'raise-less', '−20', -242, 0, 72, rgb(47, 95, 142), () => this.adjustRaiseAmount(-20));
    this.createTextButton(this.raisePanel, 'raise-more', '+20', -160, 0, 72, rgb(47, 95, 142), () => this.adjustRaiseAmount(20));
    this.createTextButton(this.raisePanel, 'raise-minimum', '最小', -60, 0, 82, rgb(31, 116, 92), () => this.applyRaisePreset('minimum'));
    this.createTextButton(this.raisePanel, 'raise-half-pot', '半池', 32, 0, 82, rgb(31, 116, 92), () => this.applyRaisePreset('half-pot'));
    this.createTextButton(this.raisePanel, 'raise-pot', '满池', 124, 0, 82, rgb(31, 116, 92), () => this.applyRaisePreset('pot'));
    this.createTextButton(this.raisePanel, 'raise-all-in', '全压', 216, 0, 82, rgb(151, 91, 37), () => this.applyRaisePreset('all-in'));
    this.createTextButton(this.raisePanel, 'raise-cancel', '取消', -98, -60, 136, rgb(117, 61, 70), () => this.closeRaisePanel());
    this.createTextButton(this.raisePanel, 'raise-confirm', '确认加注', 98, -60, 166, rgb(28, 132, 92), () => void this.confirmRaise());
    this.raisePanel.active = false;
  }

  private buildHome(): void {
    this.homeLayer = new Node('home-layer');
    this.node.addChild(this.homeLayer);
    this.homeLayer.addComponent(UITransform).setContentSize(POKER_UI.canvas.width, POKER_UI.canvas.height);
    this.homeOpacity = this.homeLayer.addComponent(UIOpacity);

    this.createRounded('home-background', this.homeLayer, 0, 0, POKER_UI.canvas.width, POKER_UI.canvas.height, 0, BACKGROUND);
    const motif = new Node('home-felt-motif');
    this.homeLayer.addChild(motif);
    motif.addComponent(UITransform).setContentSize(820, 420);
    const motifGraphics = motif.addComponent(Graphics);
    motifGraphics.fillColor = rgb(24, 85, 72);
    motifGraphics.ellipse(0, -22, 410, 210);
    motifGraphics.fill();
    motifGraphics.strokeColor = GOLD;
    motifGraphics.lineWidth = 3;
    motifGraphics.ellipse(0, -22, 382, 184);
    motifGraphics.stroke();

    const hero = this.createRounded('home-hero', this.homeLayer, 0, 12, 540, 430, 26, new Color(10, 28, 50, 238), rgb(49, 93, 114), 1);
    this.createLabel(hero, 'POKER CLUB', 0, 142, 38, GOLD);
    this.createLabel(hero, '六人德州扑克 · 虚拟筹码', 0, 98, 17, rgb(185, 211, 229));
    this.createLabel(hero, '♠  ♥  ♣  ♦', 0, 54, 24, TEXT);
    this.createTextButton(hero, 'home-start', '开始游戏', 0, -12, 320, rgb(28, 132, 92), () => this.requestStart(), 52);
    this.createTextButton(hero, 'home-rules', '游戏规则', -88, -86, 156, rgb(47, 95, 142), () => this.openHomeModal('rules'), 42);
    this.createTextButton(hero, 'home-settings', '设置', 88, -86, 156, rgb(151, 91, 37), () => this.openHomeModal('settings'), 42);
    this.createLabel(hero, '20 / 40 盲注 · 随机 AI 对手', 0, -152, 13, rgb(139, 166, 190));

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
      '目标：使用两张手牌与五张公共牌组成最佳五张牌。\n\n行动：弃牌、过牌、跟注、自定义加注或全压。\n\n流程：翻牌前 → 翻牌圈 → 转牌圈 → 河牌圈 → 摊牌。\n\n牌型：皇家同花顺、同花顺、四条、葫芦、同花、顺子、三条、两对、一对、高牌。\n\n盲注：小盲 20 / 大盲 40；全压可能形成边池。\n\n本游戏仅使用虚拟筹码，不涉及真实货币。',
      0,
      8,
      620,
      330,
      16,
      TEXT,
    );
    this.createTextButton(panel, 'rules-close', '关闭', 0, -214, 180, rgb(47, 95, 142), () => this.closeHomeModal(), 42);
    return layer;
  }

  private createSettingsModal(): Node {
    const layer = this.createModalLayer('settings-layer');
    const panel = this.createRounded('settings-panel', layer, 0, 0, 620, 420, POKER_UI.radii.panel, PANEL_RAISED, GOLD, 1);
    this.createLabel(panel, '设置', 0, 166, 25, GOLD);

    const soundButton = this.createTextButton(panel, 'settings-sound', '', 0, 92, 360, rgb(31, 116, 92), () => {
      this.updateSettings({ soundEnabled: !this.settings.soundEnabled });
    }, 44);
    this.settingsSoundLabel = soundButton.children[0].getComponent(Label)!;

    const speedButton = this.createTextButton(panel, 'settings-speed', '', 0, 28, 360, rgb(47, 95, 142), () => {
      this.cycleAnimationSpeed();
    }, 44);
    this.settingsSpeedLabel = speedButton.children[0].getComponent(Label)!;

    const confirmButton = this.createTextButton(panel, 'settings-confirm', '', 0, -36, 360, rgb(151, 91, 37), () => {
      this.updateSettings({ confirmReset: !this.settings.confirmReset });
    }, 44);
    this.settingsConfirmLabel = confirmButton.children[0].getComponent(Label)!;

    this.createLabel(panel, '设置会自动保存在本机', 0, -100, 13, rgb(139, 166, 190));
    this.createTextButton(panel, 'settings-close', '完成', 0, -160, 180, rgb(28, 132, 92), () => this.closeHomeModal(), 42);
    return layer;
  }

  private createModalLayer(name: string): Node {
    const layer = new Node(name);
    this.homeLayer.addChild(layer);
    layer.addComponent(UITransform).setContentSize(POKER_UI.canvas.width, POKER_UI.canvas.height);
    this.createRounded(`${name}-overlay`, layer, 0, 0, POKER_UI.canvas.width, POKER_UI.canvas.height, 0, new Color(4, 13, 28, 210));
    return layer;
  }

  private createReturnHomeControl(): void {
    this.createTextButton(this.tableLayer, 'return-home', '返回首页', 528, 323, 104, rgb(117, 61, 70), () => this.requestReturn(), 36);

    this.returnOverlay = new Node('return-home-layer');
    this.tableLayer.addChild(this.returnOverlay);
    this.returnOverlay.addComponent(UITransform).setContentSize(POKER_UI.canvas.width, POKER_UI.canvas.height);
    this.createRounded('return-home-overlay', this.returnOverlay, 0, 0, POKER_UI.canvas.width, POKER_UI.canvas.height, 0, new Color(4, 13, 28, 210));
    this.returnPanel = this.createRounded('return-home-panel', this.returnOverlay, 0, 0, 520, 250, POKER_UI.radii.panel, PANEL_RAISED, GOLD, 1);
    this.createLabel(this.returnPanel, '返回首页？', 0, 72, 24, GOLD);
    this.createParagraph(this.returnPanel, '当前牌局将结束，未完成的 AI 行动不会继续。', 0, 18, 430, 58, 15, TEXT);
    this.createTextButton(this.returnPanel, 'return-cancel', '继续牌局', -105, -70, 180, rgb(47, 95, 142), () => this.cancelReturn(), 42);
    this.createTextButton(this.returnPanel, 'return-confirm', '确认返回', 105, -70, 180, rgb(117, 61, 70), () => this.confirmReturn(), 42);
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
        this.engine = PokerEngine.createSixSeat();
        this.activeSessionToken = this.sessions.begin();
        this.flow = reduceHomeFlow(this.flow, { type: 'complete-start' });
        void this.startHand(this.activeSessionToken);
      })
      .start();
  }

  private openHomeModal(screen: 'rules' | 'settings'): void {
    this.flow = reduceHomeFlow(this.flow, { type: screen === 'rules' ? 'open-rules' : 'open-settings' });
    this.renderHome();
  }

  private closeHomeModal(): void {
    this.flow = reduceHomeFlow(this.flow, { type: 'close-modal' });
    this.renderHome();
  }

  private renderHome(): void {
    this.rulesPanel.active = this.flow.screen === 'rules';
    this.settingsPanel.active = this.flow.screen === 'settings';
    this.settingsSoundLabel.string = `音效 · ${this.settings.soundEnabled ? '开启' : '关闭'}`;
    this.settingsSpeedLabel.string = `动画速度 · ${this.settings.animationSpeed}×`;
    this.settingsConfirmLabel.string = `返回确认 · ${this.settings.confirmReset ? '开启' : '关闭'}`;
  }

  private updateSettings(patch: Partial<GameSettings>): void {
    this.settings = { ...this.settings, ...patch };
    saveGameSettings(sys.localStorage, this.settings);
    this.renderHome();
  }

  private cycleAnimationSpeed(): void {
    const speeds: AnimationSpeed[] = [0.75, 1, 1.25];
    const current = speeds.indexOf(this.settings.animationSpeed);
    this.updateSettings({ animationSpeed: speeds[(current + 1) % speeds.length] });
  }

  private requestReturn(): void {
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
  }

  private confirmReturn(): void {
    this.flow = reduceHomeFlow(this.flow, { type: 'confirm-return' });
    this.completeReturnHome();
  }

  private completeReturnHome(): void {
    this.sessions.invalidate();
    this.activeSessionToken = 0;
    this.unscheduleAllCallbacks();
    Tween.stopAll();
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
    this.engine = PokerEngine.createSixSeat();
    this.flow = createHomeFlow();
    this.renderHome();
  }

  private createTextButton(parent: Node, name: string, text: string, x: number, y: number, width: number, color: Color, onPress: () => void, height = 34): Node {
    const button = this.createRounded(name, parent, x, y, width, height, 8, color);
    this.createLabel(button, text, 0, 0, 15, TEXT);
    button.on(Node.EventType.TOUCH_END, () => {
      this.audio.play('ui-click');
      onPress();
    }, this);
    return button;
  }

  private async startHand(token: number): Promise<void> {
    if (this.busy || !this.sessions.isCurrent(token)) {
      return;
    }

    this.busy = true;
    this.resetVisuals();
    this.engine.startHand();
    await this.playEvents(this.engine.takeEvents(), token);
    if (!this.sessions.isCurrent(token)) {
      return;
    }
    this.busy = false;
    this.render();
    await this.runAiTurns(token);
  }

  private async handlePlayerAction(action: PlayerAction): Promise<void> {
    const token = this.activeSessionToken;
    if (this.busy || !this.sessions.isCurrent(token) || this.engine.snapshot().actingPlayerId !== 'player') {
      return;
    }

    this.busy = true;
    const events = this.engine.act(action);
    await this.playEvents(events, token);
    if (!this.sessions.isCurrent(token)) {
      return;
    }
    this.busy = false;
    this.render();
    await this.runAiTurns(token);
  }

  private async runAiTurns(token: number): Promise<void> {
    while (this.sessions.isCurrent(token) && this.engine.snapshot().street !== 'settled' && this.engine.snapshot().actingPlayerId !== 'player') {
      const snapshot = this.engine.snapshot();
      const actorId = snapshot.actingPlayerId!;
      const actor = snapshot.players.find((player) => player.id === actorId)!;
      const legalActions = snapshot.legalActions;
      const toCall = legalActions.find((action) => action.type === 'call')?.amount ?? 0;
      this.busy = true;
      this.setSeatAction(actorId, '思考中…');
      this.render();
      await this.wait(0.55 + Math.random() * 0.35);
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
        legalActions,
        random: Math.random,
      });
      const events = this.engine.act(action);
      await this.playEvents(events, token);
      if (!this.sessions.isCurrent(token)) {
        return;
      }
      this.busy = false;
      this.render();
    }

    if (this.sessions.isCurrent(token) && this.engine.snapshot().street === 'settled') {
      const player = this.engine.snapshot().players.find(({ id }) => id === 'player')!;
      if (player.stack === 0) {
        this.resultLabel.string = '筹码耗尽 · 点击这里重开现金桌';
        this.resultLabel.node.active = true;
        this.resultLabel.node.on(Node.EventType.TOUCH_END, () => {
          this.engine = PokerEngine.createSixSeat();
          void this.startHand(token);
        }, this, true);
        return;
      }

      await this.wait(1.8);
      if (this.sessions.isCurrent(token)) {
        void this.startHand(token);
      }
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
        await this.revealCommunityCard(event.card, token);
      } else if (event.type === 'action-taken') {
        this.setSeatAction(event.playerId, actionText(event.action));
        await this.animateChip(new Vec3(this.seats.get(event.playerId)!.position.x, this.seats.get(event.playerId)!.position.y, 0), new Vec3(0, 62, 0), token);
      } else if (event.type === 'showdown') {
        const seat = this.seats.get(event.playerId)!;
        event.cards.forEach((card, index) => this.showCard(seat.cards[index], card, true));
        this.setSeatAction(event.playerId, event.handName);
      } else if (event.type === 'pot-awarded') {
        this.audio.play('settlement');
        this.highlightWinner(event.playerId);
        this.resultLabel.string = `${this.seats.get(event.playerId)!.id === 'player' ? '你' : 'AI'} 赢得 ${event.amount} · ${event.handName}`;
        this.resultLabel.node.active = true;
        await this.animateChip(new Vec3(0, 62, 0), this.seats.get(event.playerId)!.position, token);
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

  private render(): void {
    const state = this.engine.snapshot();
    this.potLabel.string = `底池 ${state.pot.toLocaleString()}`;
    this.streetLabel.string = `盲注 20 / 40 · ${streetText(state.street)}`;

    for (const player of state.players) {
      const seat = this.seats.get(player.id)!;
      seat.chips.string = player.stack.toLocaleString();
      const opacity = seat.node.getComponent(UIOpacity)!;
      opacity.opacity = player.folded ? 105 : 255;
      seat.node.scale = this.winnerId === player.id
        ? new Vec3(POKER_SHOWDOWN_FEEDBACK.winnerScale, POKER_SHOWDOWN_FEEDBACK.winnerScale, 1)
        : state.actingPlayerId === player.id ? new Vec3(1.08, 1.08, 1) : Vec3.ONE;
      seat.dealer.string = player.id === state.players[0].id ? 'D' : player.streetContribution === 20 ? 'SB' : player.streetContribution === 40 ? 'BB' : '';
    }

    this.renderActionButtons(state.actingPlayerId === 'player' && !this.busy ? state.legalActions : []);
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
      button.onPress = action?.type === 'raise' ? () => this.openRaisePanel() : null;
      button.node.active = action !== null && !this.raisePanel.active;
      if (action) {
        button.label.string = action.type === 'call' ? `跟注 ${action.amount}` : action.type === 'raise' ? '自定义加注' : actionText(action);
      }
    });
  }

  private openRaisePanel(): void {
    const bounds = this.getRaiseBounds();
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
    this.hideRaisePanel(() => this.render());
  }

  private hideRaisePanel(afterClose?: () => void): void {
    if (!this.raisePanel.active) {
      afterClose?.();
      return;
    }

    const panelOpacity = this.raisePanel.getComponent(UIOpacity)!;
    const overlayOpacity = this.raiseOverlay.getComponent(UIOpacity)!;
    tween(this.raisePanel)
      .to(this.duration(0.12), { position: new Vec3(0, POKER_RAISE_MODAL.y - 10, 0), scale: new Vec3(0.98, 0.98, 1) }, { easing: 'quadIn' })
      .call(() => {
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
        this.raiseOverlay.active = false;
        overlayOpacity.opacity = 255;
      })
      .start();
  }

  private adjustRaiseAmount(delta: number): void {
    this.setRaiseAmount(this.selectedRaiseTo + delta);
  }

  private applyRaisePreset(preset: RaisePreset): void {
    this.setRaiseAmount(chooseRaisePreset(preset, this.getRaiseBounds()));
  }

  private setRaiseAmount(candidate: number): void {
    this.selectedRaiseTo = normalizeRaiseTo(candidate, this.getRaiseBounds());
    this.raiseAmountLabel.string = `加注至 ${this.selectedRaiseTo}`;
    this.raiseInput.string = String(this.selectedRaiseTo);
  }

  private getRaiseBounds(): RaiseBounds {
    const state = this.engine.snapshot();
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
      step: 20,
    };
  }

  private async confirmRaise(): Promise<void> {
    const to = normalizeRaiseTo(Number(this.raiseInput.string), this.getRaiseBounds());
    this.hideRaisePanel();
    await this.handlePlayerAction({ type: 'raise', to });
  }

  private resetVisuals(): void {
    this.resultLabel.node.active = false;
    this.raisePanel.active = false;
    this.raiseOverlay.active = false;
    this.communityCards.forEach((card) => card.node.active = false);
    this.winnerId = null;
    this.seats.forEach((seat) => {
      seat.nextCard = 0;
      seat.action.string = '';
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
    this.seats.get(id)!.action.string = text;
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
    visual.rank.color = red ? rgb(228, 67, 84) : rgb(25, 43, 64);
    visual.suit.color = visual.rank.color;
  }

  private createCard(parent: Node, home: Vec3): CardVisual {
    const node = this.createRounded('card', parent, home.x, home.y, 52, 68, POKER_UI.radii.card, rgb(250, 253, 255), rgb(221, 230, 237), 1);
    const front = new Node('front');
    node.addChild(front);
    const rank = this.createLabel(front, '', -13, 15, 17, rgb(25, 43, 64));
    const suit = this.createLabel(front, '', 0, -5, 24, rgb(25, 43, 64));
    const back = this.createRounded('back', node, 0, 0, 50, 66, 5, rgb(26, 54, 111), GOLD, 1);
    this.createLabel(back, '♠', 0, 0, 22, rgb(203, 230, 255));
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
    const chip = this.createRounded('chip', this.tableLayer, from.x, from.y, 26, 26, 13, GOLD);
    this.transientNodes.add(chip);
    this.createLabel(chip, '●', 0, 0, 14, rgb(122, 75, 24));
    this.audio.play('chip');
    await this.move(chip, to, duration);
    if (chip.isValid) {
      chip.destroy();
    }
    this.transientNodes.delete(chip);
  }

  private move(node: Node, target: Vec3, duration: number): Promise<void> {
    return new Promise((resolve) => tween(node).to(this.duration(duration), { position: target }, { easing: 'quadOut' }).call(() => resolve()).start());
  }

  private wait(seconds: number): Promise<void> {
    return new Promise((resolve) => this.scheduleOnce(resolve, this.duration(seconds)));
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
