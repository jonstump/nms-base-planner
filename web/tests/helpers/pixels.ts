import { PNG } from "pngjs";

/*
 * Reading pixels out of a Playwright screenshot.
 *
 * Governing: SPEC-0005 REQ "Component Styling Discipline"
 *
 * The selection-ring requirement is about paint order, and paint order is
 * only observable in the output. `getComputedStyle` reports what each element
 * was told to be, not which one ended up on top; `elementFromPoint` does not
 * see pseudo-elements at all. Sampling the rendered image is the only way to
 * ask the browser which colour actually landed at a coordinate.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** `#rrggbb` — the form the token file writes. */
export function hexToRgb(hex: string): Rgb {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!match?.[1]) {
    throw new Error(`expected a 6-digit hex colour, got ${hex}`);
  }
  const value = Number.parseInt(match[1], 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

export function pixelAt(png: PNG, x: number, y: number): Rgb {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) {
    throw new Error(
      `(${String(x)}, ${String(y)}) is outside the ${String(png.width)}x${String(png.height)} image`,
    );
  }
  const offset = (png.width * y + x) << 2;
  return {
    r: png.data[offset] ?? 0,
    g: png.data[offset + 1] ?? 0,
    b: png.data[offset + 2] ?? 0,
  };
}

/*
 * Subpixel antialiasing puts a blended value at the edge of a 2px border, so
 * an exact match would fail on a correct render. 24 per channel is wide
 * enough to absorb that and far narrower than the distance between the two
 * colours this suite ever has to tell apart: --ok #8ec07c against --input-bg
 * #45403d is 73 apart on the closest channel.
 */
const TOLERANCE = 24;

export function isColour(pixel: Rgb, target: Rgb): boolean {
  return (
    Math.abs(pixel.r - target.r) <= TOLERANCE &&
    Math.abs(pixel.g - target.g) <= TOLERANCE &&
    Math.abs(pixel.b - target.b) <= TOLERANCE
  );
}

/**
 * Scan a vertical run of pixels for `target`.
 *
 * A run rather than a single sample because a 2px border's exact offset
 * depends on where the layout rounded, and a test that hard-codes one y
 * fails for a reason that has nothing to do with the requirement.
 */
export function columnContains(
  png: PNG,
  x: number,
  yFrom: number,
  yTo: number,
  target: Rgb,
): boolean {
  for (let y = yFrom; y < yTo; y += 1) {
    if (isColour(pixelAt(png, x, y), target)) return true;
  }
  return false;
}

export function readPng(buffer: Buffer): PNG {
  return PNG.sync.read(buffer);
}

/** Every distinct colour in a vertical run, for a failure message worth reading. */
export function describeColumn(png: PNG, x: number, yFrom: number, yTo: number): string {
  const seen: string[] = [];
  for (let y = yFrom; y < yTo; y += 1) {
    const { r, g, b } = pixelAt(png, x, y);
    const entry = `y=${String(y)} rgb(${String(r)}, ${String(g)}, ${String(b)})`;
    seen.push(entry);
  }
  return seen.join("; ");
}
