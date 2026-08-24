import { Deck } from './Deck';
import { compareHands, evaluateBest, HandCategory, HandValue } from './HandEvaluator';
import { buildPots } from './SidePot';
import { Card, EngineEvent, EngineSnapshot, PlayerAction, PlayerSnapshot, Street } from './types';

interface PlayerState extends PlayerSnapshot {
  holeCards: Card[];
}

interface CreateSixSeatOptions {
  deck?: Deck;
  random?: () => number;
  stacks?: Partial<Record<string, number>>;
}

const SMALL_BLIND = 20;
const BIG_BLIND = 40;

export class PokerEngine {
  private readonly players: PlayerState[];
  private readonly random: () => number;
  private firstDeck: Deck | null;
  private deck = new Deck();
  private dealerIndex = -1;
  private handId = 0;
  private street: Street = 'settled';
  private actingIndex: number | null = null;
  private currentBet = 0;
  private minimumRaise = BIG_BLIND;
  private pendingPlayerIds = new Set<string>();
  private communityCards: Card[] = [];
  private handEvents: EngineEvent[] = [];

  private constructor(options: CreateSixSeatOptions, players: PlayerState[]) {
    this.firstDeck = options.deck ?? null;
    this.random = options.random ?? Math.random;
    this.players = players;
  }

  public static createSixSeat(options: CreateSixSeatOptions = {}): PokerEngine {
    return new PokerEngine(options, [
      createPlayer('ai-1', 'Nora', options.stacks?.['ai-1']),
      createPlayer('ai-2', 'Miles', options.stacks?.['ai-2']),
      createPlayer('ai-3', 'Aria', options.stacks?.['ai-3']),
      createPlayer('ai-4', 'Leo', options.stacks?.['ai-4']),
      createPlayer('ai-5', 'Sora', options.stacks?.['ai-5']),
      createPlayer('player', '你', options.stacks?.player),
    ]);
  }

  public startHand(): EngineSnapshot {
    if (this.street !== 'settled') {
      throw new Error('Hand is still active');
    }

    if (this.playingPlayers().length < 2) {
      throw new Error('At least two players need chips');
    }

    this.handId += 1;
    this.handEvents = [];
    this.deck = this.firstDeck ?? new Deck(this.random);
    this.firstDeck = null;
    this.dealerIndex = this.nextPlayingIndex(this.dealerIndex);
    this.communityCards = [];
    this.currentBet = 0;
    this.minimumRaise = BIG_BLIND;
    this.street = 'preflop';

    for (const player of this.players) {
      player.folded = player.stack === 0;
      player.allIn = false;
      player.streetContribution = 0;
      player.totalContribution = 0;
      player.holeCards = [];
    }

    const smallBlindIndex = this.nextPlayingIndex(this.dealerIndex);
    const bigBlindIndex = this.nextPlayingIndex(smallBlindIndex);
    this.postForcedBet(smallBlindIndex, SMALL_BLIND);
    this.postForcedBet(bigBlindIndex, BIG_BLIND);

    for (const player of this.players) {
      if (player.folded) {
        continue;
      }

      player.holeCards = [this.deck.draw(), this.deck.draw()];
      this.handEvents.push({
        handId: this.handId,
        type: 'hole-card-dealt',
        playerId: player.id,
        card: player.id === 'player' ? player.holeCards[0] : undefined,
        faceDown: player.id !== 'player',
      });
      this.handEvents.push({
        handId: this.handId,
        type: 'hole-card-dealt',
        playerId: player.id,
        card: player.id === 'player' ? player.holeCards[1] : undefined,
        faceDown: player.id !== 'player',
      });
    }

    this.beginBettingRound('preflop', this.nextPlayingIndex(bigBlindIndex));

    return this.snapshot();
  }

  public act(action: PlayerAction): EngineEvent[] {
    const actor = this.actingPlayer;

    if (!actor || !this.isLegalAction(action)) {
      throw new Error('Illegal action');
    }

    const beforeBet = this.currentBet;
    let contributed = 0;

    if (action.type === 'fold') {
      actor.folded = true;
    } else if (action.type === 'call') {
      contributed = this.contribute(actor, action.amount);
    } else if (action.type === 'raise') {
      contributed = this.contribute(actor, action.to - actor.streetContribution);
      this.currentBet = action.to;
      this.minimumRaise = action.to - beforeBet;
    } else if (action.type === 'all-in') {
      contributed = this.contribute(actor, actor.stack);
      const allInTotal = actor.streetContribution;

      if (allInTotal > this.currentBet) {
        this.currentBet = allInTotal;
        this.minimumRaise = Math.max(this.minimumRaise, allInTotal - beforeBet);
      }
    }

    const events: EngineEvent[] = [{
      handId: this.handId,
      type: 'action-taken',
      playerId: actor.id,
      action,
      amount: contributed,
    }];

    if (action.type === 'raise' || (action.type === 'all-in' && actor.streetContribution > beforeBet)) {
      this.resetPendingAfterRaise(actor.id);
    } else {
      this.pendingPlayerIds.delete(actor.id);
    }

    this.advance(events);
    this.handEvents.push(...events);
    return events;
  }

  public snapshot(): EngineSnapshot {
    return {
      handId: this.handId,
      street: this.street,
      actingPlayerId: this.actingPlayer?.id ?? null,
      pot: this.players.reduce((total, player) => total + player.totalContribution, 0),
      communityCards: [...this.communityCards],
      legalActions: this.legalActions(),
      players: this.players.map(({ holeCards: _holeCards, ...player }) => ({ ...player })),
    };
  }

  public takeEvents(): EngineEvent[] {
    const events = [...this.handEvents];
    this.handEvents = [];
    return events;
  }

  public getHoleCards(playerId: string): Card[] {
    const player = this.players.find((candidate) => candidate.id === playerId);

    if (!player) {
      throw new Error(`Unknown player: ${playerId}`);
    }

    return [...player.holeCards];
  }

  private get actingPlayer(): PlayerState | null {
    return this.actingIndex === null ? null : this.players[this.actingIndex] ?? null;
  }

  private playingPlayers(): PlayerState[] {
    return this.players.filter((player) => player.stack > 0);
  }

  private activePlayers(): PlayerState[] {
    return this.players.filter((player) => !player.folded);
  }

  private eligibleToAct(): PlayerState[] {
    return this.activePlayers().filter((player) => !player.allIn);
  }

  private nextPlayingIndex(fromIndex: number): number {
    for (let offset = 1; offset <= this.players.length; offset += 1) {
      const candidate = (fromIndex + offset + this.players.length) % this.players.length;

      if (this.players[candidate].stack > 0) {
        return candidate;
      }
    }

    throw new Error('No players with chips');
  }

  private nextPendingIndex(fromIndex: number): number | null {
    for (let offset = 0; offset < this.players.length; offset += 1) {
      const candidate = (fromIndex + offset + this.players.length) % this.players.length;

      if (this.pendingPlayerIds.has(this.players[candidate].id)) {
        return candidate;
      }
    }

    return null;
  }

  private postForcedBet(index: number, amount: number): void {
    const player = this.players[index];
    const contributed = this.contribute(player, amount);

    this.currentBet = Math.max(this.currentBet, player.streetContribution);
    this.handEvents.push({ handId: this.handId, type: 'blind-posted', playerId: player.id, amount: contributed });
  }

  private contribute(player: PlayerState, amount: number): number {
    const contributed = Math.min(Math.max(amount, 0), player.stack);
    player.stack -= contributed;
    player.streetContribution += contributed;
    player.totalContribution += contributed;
    player.allIn = player.stack === 0;
    return contributed;
  }

  private beginBettingRound(street: Street, firstActorIndex: number): void {
    this.street = street;

    if (street !== 'preflop') {
      for (const player of this.players) {
        player.streetContribution = 0;
      }
      this.currentBet = 0;
      this.minimumRaise = BIG_BLIND;
    }

    this.pendingPlayerIds = new Set(this.eligibleToAct().map((player) => player.id));
    this.actingIndex = this.nextPendingIndex(firstActorIndex);
  }

  private resetPendingAfterRaise(actorId: string): void {
    this.pendingPlayerIds = new Set(this.eligibleToAct()
      .filter((player) => player.id !== actorId)
      .map((player) => player.id));
  }

  private legalActions(): PlayerAction[] {
    const actor = this.actingPlayer;

    if (!actor || this.street === 'settled') {
      return [];
    }

    const toCall = Math.max(0, this.currentBet - actor.streetContribution);
    const actions: PlayerAction[] = [{ type: 'fold' }];

    if (toCall === 0) {
      actions.push({ type: 'check' });
    } else if (actor.stack >= toCall) {
      actions.push({ type: 'call', amount: toCall });
    }

    const allInTo = actor.streetContribution + actor.stack;
    const minimumRaiseTo = this.currentBet + this.minimumRaise;

    if (allInTo >= minimumRaiseTo && allInTo > this.currentBet) {
      actions.push({ type: 'raise', to: minimumRaiseTo });
    }

    if (actor.stack > 0) {
      actions.push({ type: 'all-in' });
    }

    return actions;
  }

  private isLegalAction(action: PlayerAction): boolean {
    const actor = this.actingPlayer;

    if (!actor) {
      return false;
    }

    const toCall = Math.max(0, this.currentBet - actor.streetContribution);

    if (action.type === 'fold') {
      return true;
    }

    if (action.type === 'check') {
      return toCall === 0;
    }

    if (action.type === 'call') {
      return toCall > 0 && actor.stack >= toCall && action.amount === toCall;
    }

    if (action.type === 'raise') {
      const maximumTo = actor.streetContribution + actor.stack;
      return action.to >= this.currentBet + this.minimumRaise && action.to <= maximumTo;
    }

    return actor.stack > 0;
  }

  private advance(events: EngineEvent[]): void {
    while (true) {
      const active = this.activePlayers();

      if (active.length === 1) {
        this.settleEarly(active[0], events);
        return;
      }

      if (this.pendingPlayerIds.size > 0) {
        const nextIndex = this.nextPendingIndex((this.actingIndex ?? 0) + 1);

        if (nextIndex !== null) {
          this.actingIndex = nextIndex;
          return;
        }
      }

      if (this.street === 'preflop') {
        this.revealCommunity(3, events);
        this.beginBettingRound('flop', this.nextPlayingIndex(this.dealerIndex));
      } else if (this.street === 'flop') {
        this.revealCommunity(1, events);
        this.beginBettingRound('turn', this.nextPlayingIndex(this.dealerIndex));
      } else if (this.street === 'turn') {
        this.revealCommunity(1, events);
        this.beginBettingRound('river', this.nextPlayingIndex(this.dealerIndex));
      } else if (this.street === 'river') {
        this.settleShowdown(events);
        return;
      }

      if (this.pendingPlayerIds.size > 0) {
        return;
      }
    }
  }

  private revealCommunity(count: number, events: EngineEvent[]): void {
    for (let index = 0; index < count; index += 1) {
      const card = this.deck.draw();
      this.communityCards.push(card);
      events.push({ handId: this.handId, type: 'community-card-revealed', card });
    }
  }

  private settleEarly(winner: PlayerState, events: EngineEvent[]): void {
    const amount = this.players.reduce((total, player) => total + player.totalContribution, 0);
    winner.stack += amount;
    this.finishHand();
    events.push({ handId: this.handId, type: 'pot-awarded', playerId: winner.id, amount, handName: '对手弃牌' });
  }

  private settleShowdown(events: EngineEvent[]): void {
    const values = new Map<string, HandValue>();

    for (const player of this.activePlayers()) {
      const value = evaluateBest([...player.holeCards, ...this.communityCards]);
      values.set(player.id, value);
      events.push({
        handId: this.handId,
        type: 'showdown',
        playerId: player.id,
        cards: [...player.holeCards],
        handName: handCategoryName(value.category),
      });
    }

    for (const pot of buildPots(this.players.map((player) => ({
      playerId: player.id,
      amount: player.totalContribution,
      folded: player.folded,
    })))) {
      const eligible = pot.eligiblePlayerIds.filter((playerId) => values.has(playerId));
      const candidates = eligible.length > 0 ? eligible : this.activePlayers().map((player) => player.id);
      let best = values.get(candidates[0])!;

      for (const playerId of candidates.slice(1)) {
        const value = values.get(playerId)!;
        if (compareHands(value, best) > 0) {
          best = value;
        }
      }

      const winners = candidates.filter((playerId) => compareHands(values.get(playerId)!, best) === 0);
      const share = Math.floor(pot.amount / winners.length);
      let remainder = pot.amount % winners.length;

      for (const playerId of winners) {
        const payout = share + (remainder > 0 ? 1 : 0);
        remainder -= 1;
        this.players.find((player) => player.id === playerId)!.stack += payout;
        events.push({ handId: this.handId, type: 'pot-awarded', playerId, amount: payout, handName: handCategoryName(best.category) });
      }
    }

    this.finishHand();
  }

  private finishHand(): void {
    this.street = 'settled';
    this.actingIndex = null;
    this.pendingPlayerIds.clear();
    this.currentBet = 0;

    for (const player of this.players) {
      player.streetContribution = 0;
      player.totalContribution = 0;
    }
  }
}

function createPlayer(id: string, name: string, stack = 5000): PlayerState {
  return {
    id,
    name,
    stack,
    folded: false,
    allIn: false,
    streetContribution: 0,
    totalContribution: 0,
    holeCards: [],
  };
}

function handCategoryName(category: HandCategory): string {
  return ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'][category];
}
