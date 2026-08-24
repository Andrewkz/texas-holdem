import { Card, RANKS, SUITS } from './types';

export class Deck {
  private readonly cards: Card[];

  public constructor(private readonly random: () => number = Math.random) {
    this.cards = [];

    for (const suit of SUITS) {
      for (const rank of RANKS) {
        this.cards.push({ suit, rank });
      }
    }

    for (let index = this.cards.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(this.random() * (index + 1));
      [this.cards[index], this.cards[swapIndex]] = [this.cards[swapIndex], this.cards[index]];
    }
  }

  public draw(): Card {
    const card = this.cards.pop();

    if (!card) {
      throw new Error('Deck is empty');
    }

    return card;
  }
}
