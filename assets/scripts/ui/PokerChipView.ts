import { Color, Graphics, Label, Node, resources, Sprite, SpriteFrame, UITransform } from 'cc';
import type { EngineSnapshot } from '../core/types';
import { ChipProportion, ChipScale, createChipScale, getChipPilePosition, getChipProportion, getPokerChipPiles, getPotChipPilePosition, MAX_CHIP_VISUALS } from './PokerChipModel';

type Point = { x: number; y: number };
interface Pile { node: Node; images: Array<{ node: Node; sprite: Sprite }>; label: Label; labelPlate: Graphics; meter: Graphics; proportion: ChipProportion }

/** Fixed-size sprite pools: the authoritative numbers never come from image count. */
export class PokerChipView {
  private single: SpriteFrame | null = null;
  private readonly piles = new Map<string, Pile>();
  private latest: { snapshot: EngineSnapshot; seats: Map<string, Point>; compact: boolean; scale: number } | null = null;
  public ready = false;
  private readonly layer: Node;
  private disposed = false;
  public constructor(private readonly parent: Node) {
    this.layer = new Node('table-chip-layer'); parent.addChild(this.layer);
    this.layer.addComponent(UITransform).setContentSize(1280, 720);
  }

  public async preload(): Promise<void> {
    const frame = await new Promise<SpriteFrame>((resolve, reject) => {
      resources.load('chips/chip-single/spriteFrame', SpriteFrame, (error, frame) => error ? reject(error) : resolve(frame));
    });
    if (this.disposed || !this.parent.isValid) return;
    this.single = frame;
    this.ready = true;
    if (this.latest) this.render(this.latest.snapshot, this.latest.seats, this.latest.compact, this.latest.scale);
  }

  public render(snapshot: EngineSnapshot, seats: Map<string, Point>, compact: boolean, scale: number): void {
    if (this.disposed) return;
    this.latest = { snapshot, seats, compact, scale };
    this.piles.forEach(pile => pile.node.active = false);
    if (!this.ready || !this.parent.isValid) return;
    const model = getPokerChipPiles(snapshot);
    const chipScale = createChipScale([model.pot, ...model.wagers.filter(wager => seats.has(wager.playerId)).map(wager => wager.amount)]);
    const shortTable = (this.parent.getComponent(UITransform)?.height ?? 720) < 620;
    this.show('collected-pot', model.pot, getPotChipPilePosition(compact, shortTable), true, compact, scale, chipScale);
    for (const wager of model.wagers) {
      const seat = seats.get(wager.playerId);
      if (seat) this.show(wager.playerId, wager.amount, getChipPilePosition(wager.playerId, seat, compact), true, compact, scale, chipScale);
    }
  }

  public clear(): void { this.latest = null; this.piles.forEach(p => p.node.active = false); }
  public destroy(): void { this.disposed = true; this.clear(); this.layer.destroy(); this.piles.clear(); }

  public createMovingChip(parent: Node): Node {
    const node = new Node('moving-real-chip'); this.layer.addChild(node);
    node.addComponent(UITransform).setContentSize(36, 24);
    const sprite = node.addComponent(Sprite); sprite.sizeMode = Sprite.SizeMode.CUSTOM; sprite.spriteFrame = this.single;
    return node;
  }

  private show(key: string, amount: number, position: Point, withLabel: boolean, compact: boolean, scale: number, chipScale: ChipScale): void {
    let pile = this.piles.get(key);
    if (!pile) {
      const node = new Node(`table-chips-${key}`); this.layer.addChild(node);
      node.addComponent(UITransform).setContentSize(90, 52);
      const images: Pile['images'] = [];
      for (let i = 0; i < MAX_CHIP_VISUALS; i++) {
        const chip = new Node(`real-chip-${i}`); node.addChild(chip); chip.addComponent(UITransform);
        const sprite = chip.addComponent(Sprite); sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        images.push({ node: chip, sprite });
      }
      const plateNode = new Node('wager-amount-badge'); node.addChild(plateNode); plateNode.addComponent(UITransform); const labelPlate = plateNode.addComponent(Graphics);
      const labelNode = new Node('wager-amount'); node.addChild(labelNode);
      labelNode.addComponent(UITransform).setContentSize(108, 36);
      const label = labelNode.addComponent(Label); label.color = new Color(229, 208, 160); label.overflow = Label.Overflow.SHRINK;
      label.horizontalAlign = Label.HorizontalAlign.LEFT; label.verticalAlign = Label.VerticalAlign.CENTER;
      const meterNode = new Node('chip-amount-proportion'); node.addChild(meterNode);
      meterNode.addComponent(UITransform).setContentSize(4, 24);
      const meter = meterNode.addComponent(Graphics);
      pile = { node, images, label, labelPlate, meter, proportion: getChipProportion(amount, chipScale) }; this.piles.set(key, pile);
    }
    const pixelScale = compact ? Math.max(scale, 0.25) : 1;
    const proportion = getChipProportion(amount, chipScale);
    pile.proportion = proportion;
    const frame = this.single!;
    const size = 24 / pixelScale;
    pile.node.active = true; pile.node.setPosition(position.x, position.y, 0);
    pile.images.forEach((image, i) => {
      image.node.active = i < proportion.visibleCount;
      image.sprite.spriteFrame = frame;
      const fraction = i < proportion.whole ? 1 : proportion.fraction;
      image.sprite.color = new Color(255, 255, 255, Math.round(fraction * 255));
      image.node.getComponent(UITransform)!.setContentSize(size, size * frame.rect.height / frame.rect.width);
      image.node.setPosition(0, i * 0.9 / pixelScale, 0);
    });
    pile.label.node.active = withLabel;
    pile.label.string = key === 'collected-pot' ? `已收 ${amount.toLocaleString()}` : amount.toLocaleString();
    pile.label.fontSize = Math.ceil((key === 'collected-pot' ? 12 : pile.label.string.length > 6 ? 12.5 : 14) / pixelScale); pile.label.isBold = key !== 'collected-pot';
    pile.label.color = key === 'collected-pot' ? new Color(229, 208, 160) : new Color(255, 232, 178); pile.label.lineHeight = Math.ceil(18 / pixelScale);
    const amountWidth = Math.min(58, Math.max(28, pile.label.string.length * 9));
    pile.label.node.getComponent(UITransform)!.setContentSize(amountWidth / pixelScale, 22 / pixelScale);
    const direction = key === 'ai-3' || key === 'ai-4' ? -1 : 1;
    const meter = pile.meter;
    const meterHeight = 24 / pixelScale;
    const meterWidth = 2 / pixelScale;
    const meterX = direction * 16 / pixelScale;
    const meterY = -8 / pixelScale;
    meter.node.setPosition(meterX + meterWidth / 2, meterY + meterHeight / 2, 0);
    meter.node.getComponent(UITransform)!.setContentSize(meterWidth, meterHeight);
    meter.clear();
    meter.fillColor = new Color(66, 85, 75, 150);
    meter.rect(-meterWidth / 2, -meterHeight / 2, meterWidth, meterHeight); meter.fill();
    meter.fillColor = new Color(214, 181, 117);
    meter.rect(-meterWidth / 2, -meterHeight / 2, meterWidth, meterHeight * proportion.ratio); meter.fill();
    pile.label.horizontalAlign = direction === -1 ? Label.HorizontalAlign.RIGHT : Label.HorizontalAlign.LEFT;
    pile.label.node.setPosition(direction * (size / 2 + 10 / pixelScale + amountWidth / (2 * pixelScale)), 0, 0);
    const plate = pile.labelPlate; plate.node.active = key !== 'collected-pot';
    plate.node.setPosition(pile.label.node.position);
    const plateW = (amountWidth + 6) / pixelScale, plateH = 24 / pixelScale;
    plate.node.getComponent(UITransform)!.setContentSize(plateW, plateH);
    plate.clear(); plate.fillColor = new Color(16, 35, 32, 245); plate.strokeColor = new Color(182, 151, 87); plate.lineWidth = 1 / pixelScale;
    plate.roundRect(-plateW / 2, -plateH / 2, plateW, plateH, 5 / pixelScale); plate.fill(); plate.stroke();
    if (key === 'collected-pot') {
      pile.label.horizontalAlign = Label.HorizontalAlign.CENTER;
      const shortTable = (this.parent.getComponent(UITransform)?.height ?? 720) < 620;
      pile.label.node.setPosition(shortTable ? 60 / pixelScale : 0, 29 / pixelScale, 0);
      pile.label.node.getComponent(UITransform)!.setContentSize(90 / pixelScale, 22 / pixelScale);
      pile.meter.node.active = amount > 0;
    }
  }
}
