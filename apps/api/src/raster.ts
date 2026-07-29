import { GLYPH_H, GLYPH_W, glyphFor, textWidth } from './font.js';

export class Raster {
  readonly data: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8Array(width * height * 4);
  }

  clear(color: number, alpha = 1): void {
    this.rect(0, 0, this.width, this.height, color, alpha);
  }

  blend(x: number, y: number, r: number, g: number, b: number, a: number): void {
    if (a <= 0 || x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    const data = this.data;
    if (a >= 1) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
      return;
    }
    const inv = 1 - a;
    data[i] = data[i]! * inv + r * a;
    data[i + 1] = data[i + 1]! * inv + g * a;
    data[i + 2] = data[i + 2]! * inv + b * a;
    data[i + 3] = Math.max(data[i + 3]!, Math.round(a * 255));
  }

  additive(x: number, y: number, r: number, g: number, b: number, a: number): void {
    if (a <= 0 || x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    const data = this.data;
    data[i] = Math.min(255, data[i]! + r * a);
    data[i + 1] = Math.min(255, data[i + 1]! + g * a);
    data[i + 2] = Math.min(255, data[i + 2]! + b * a);
    data[i + 3] = 255;
  }

  rect(x: number, y: number, w: number, h: number, color: number, alpha = 1): void {
    const [r, g, b] = unpack(color);
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) this.blend(px, py, r, g, b, alpha);
    }
  }

  verticalGradient(
    x: number,
    y: number,
    w: number,
    h: number,
    top: number,
    bottom: number,
    topAlpha = 1,
    bottomAlpha = 1,
  ): void {
    const [tr, tg, tb] = unpack(top);
    const [br, bg, bb] = unpack(bottom);
    const y0 = Math.max(0, Math.round(y));
    const y1 = Math.min(this.height, Math.round(y + h));
    const x0 = Math.max(0, Math.round(x));
    const x1 = Math.min(this.width, Math.round(x + w));
    for (let py = y0; py < y1; py++) {
      const t = h > 1 ? (py - y) / h : 0;
      const r = tr + (br - tr) * t;
      const g = tg + (bg - tg) * t;
      const b = tb + (bb - tb) * t;
      const a = topAlpha + (bottomAlpha - topAlpha) * t;
      for (let px = x0; px < x1; px++) this.blend(px, py, r, g, b, a);
    }
  }

  glow(cx: number, cy: number, radius: number, color: number, intensity: number): void {
    const [r, g, b] = unpack(color);
    const x0 = Math.max(0, Math.floor(cx - radius));
    const x1 = Math.min(this.width, Math.ceil(cx + radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(this.height, Math.ceil(cy + radius));
    const r2 = radius * radius;
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const dx = px - cx;
        const dy = py - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const falloff = 1 - Math.sqrt(d2) / radius;
        this.additive(px, py, r, g, b, falloff * falloff * intensity);
      }
    }
  }

  text(
    value: string,
    x: number,
    y: number,
    scale: number,
    color: number,
    alpha = 1,
    tracking = 1,
  ): number {
    const [r, g, b] = unpack(color);
    let cursor = Math.round(x);
    for (const char of value) {
      const glyph = glyphFor(char);
      for (let gx = 0; gx < GLYPH_W; gx++) {
        const column = glyph[gx]!;
        if (column === 0) continue;
        for (let gy = 0; gy < GLYPH_H; gy++) {
          if ((column & (1 << gy)) === 0) continue;
          const px = cursor + gx * scale;
          const py = Math.round(y) + gy * scale;
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) this.blend(px + sx, py + sy, r, g, b, alpha);
          }
        }
      }
      cursor += (GLYPH_W + tracking) * scale;
    }
    return cursor;
  }

  textRight(
    value: string,
    right: number,
    y: number,
    scale: number,
    color: number,
    alpha = 1,
    tracking = 1,
  ): void {
    this.text(value, right - textWidth(value, scale, tracking), y, scale, color, alpha, tracking);
  }
}

export function unpack(color: number): [number, number, number] {
  return [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
}

export function mixColor(a: number, b: number, t: number): number {
  const [ar, ag, ab] = unpack(a);
  const [br, bg, bb] = unpack(b);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}
