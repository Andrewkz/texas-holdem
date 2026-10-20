import { Mask, Node, resources, Sprite, SpriteFrame, UITransform } from 'cc';

/** A portrait shares its seat's lifetime and has no access to game state. */
export function attachPlayerPortrait(parent: Node, index: number): void {
  const crop = new Node('player-portrait');
  parent.addChild(crop);
  crop.addComponent(UITransform).setContentSize(52, 52);
  crop.addComponent(Mask).type = Mask.Type.GRAPHICS_ELLIPSE;
  const picture = new Node('portrait-image');
  crop.addChild(picture);
  picture.addComponent(UITransform).setContentSize(52, 52);
  const sprite = picture.addComponent(Sprite);
  sprite.sizeMode = Sprite.SizeMode.CUSTOM;
  resources.load(`portraits/avatar-${index}/spriteFrame`, SpriteFrame, (error, frame) => {
    if (!parent.isValid || !sprite.isValid) return;
    if (!error && frame) sprite.spriteFrame = frame;
  });
}
