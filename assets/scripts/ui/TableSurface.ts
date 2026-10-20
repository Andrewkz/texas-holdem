import { Color, Graphics, Mask, Node, resources, Sprite, SpriteFrame, UIOpacity, UITransform } from 'cc';

/** Decorative felt only: fixed layers, no input handlers or game-state access. */
export function attachTableSurface(parent: Node, width = 970, height = 420): void {
  if (!parent.isValid || parent.getChildByName('table-surface')) return;

  const surface = new Node('table-surface');
  parent.addChild(surface);
  surface.setPosition(0, 4, 0);
  surface.addComponent(UITransform).setContentSize(width, height);
  surface.addComponent(Mask).type = Mask.Type.GRAPHICS_ELLIPSE;

  const image = new Node('felt-texture');
  surface.addChild(image);
  image.addComponent(UITransform).setContentSize(width, height);
  image.addComponent(UIOpacity).opacity = 150;
  const sprite = image.addComponent(Sprite);
  sprite.sizeMode = Sprite.SizeMode.CUSTOM;
  resources.load('table/felt-texture/spriteFrame', SpriteFrame, (error, frame) => {
    if (!parent.isValid || !image.isValid || !sprite.isValid) return;
    if (!error && frame) sprite.spriteFrame = frame;
  });

  const shade = new Node('felt-edge-shading');
  surface.addChild(shade);
  shade.addComponent(UITransform).setContentSize(width, height);
  const shading = shade.addComponent(Graphics);
  const radiusX = width / 2;
  const radiusY = height / 2;
  // Overlapping translucent strokes soften the edge without a per-frame effect.
  for (const [lineWidth, alpha] of [[64, 12], [36, 16], [16, 22]]) {
    shading.lineWidth = lineWidth;
    shading.strokeColor = new Color(3, 20, 17, alpha);
    shading.ellipse(0, 0, radiusX, radiusY);
    shading.stroke();
  }

  const seam = new Node('felt-stitching');
  surface.addChild(seam);
  seam.addComponent(UITransform).setContentSize(width, height);
  const stitches = seam.addComponent(Graphics);
  stitches.lineWidth = 1;
  stitches.strokeColor = new Color(161, 177, 144, 38);
  const seamX = radiusX - 31;
  const seamY = radiusY - 24;
  stitches.ellipse(0, 0, seamX - 3, seamY - 3);
  stitches.stroke();
  stitches.strokeColor = new Color(192, 183, 135, 58);
  const dashCount = 96;
  for (let dash = 0; dash < dashCount; dash += 1) {
    const start = dash / dashCount * Math.PI * 2;
    const end = (dash + 0.38) / dashCount * Math.PI * 2;
    stitches.moveTo(Math.cos(start) * seamX, Math.sin(start) * seamY);
    stitches.lineTo(Math.cos(end) * seamX, Math.sin(end) * seamY);
  }
  stitches.stroke();
}
