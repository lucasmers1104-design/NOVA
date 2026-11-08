// Renders NOVA Companion's icons into assets/: NOVA's star (assets/brand/nova-icon.svg)
// with two signal arcs reaching out from it. Plain Node, no image library.
//   node scripts/make-icon.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const SIZE = 1024;
const SAMPLES = 4; // per axis, for smooth edges

// ---------------------------------------------------------------------------
// Shapes (in 1024 × 1024 icon space)
// ---------------------------------------------------------------------------

/** Flattens the brand star's quadratic curves into a polygon. */
function star(cx, cy, r, pinch) {
  const tips = [
    [0, -r],
    [r, 0],
    [0, r],
    [-r, 0],
  ];
  const points = [];
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = tips[i];
    const [bx, by] = tips[(i + 1) % 4];
    // The control point sits near the centre, between the two tips (pinch = how close).
    const qx = (ax + bx) * pinch;
    const qy = (ay + by) * pinch;
    for (let t = 0; t < 1; t += 1 / 48) {
      const u = 1 - t;
      points.push([cx + u * u * ax + 2 * u * t * qx + t * t * bx, cy + u * u * ay + 2 * u * t * qy + t * t * by]);
    }
  }
  return points;
}

function insidePolygon(points, x, y) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function bounds(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** An arc stroke with round caps; angles in radians, 0 = right, growing clockwise (y down). */
function arc(cx, cy, radius, width, from, to) {
  const ends = [from, to].map((a) => [cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
  const half = width / 2;
  return {
    box: [cx - radius - half, cy - radius - half, cx + radius + half, cy + radius + half],
    inside(x, y) {
      const dx = x - cx;
      const dy = y - cy;
      const angle = Math.atan2(dy, dx);
      if (Math.abs(Math.hypot(dx, dy) - radius) <= half && angle >= from && angle <= to) return true;
      return ends.some(([ex, ey]) => Math.hypot(x - ex, y - ey) <= half);
    },
  };
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function gradient(stops, t) {
  t = Math.min(1, Math.max(0, t));
  for (let i = 1; i < stops.length; i++) {
    const [p0, c0] = stops[i - 1];
    const [p1, c1] = stops[i];
    if (t <= p1) return mix(hex(c0), hex(c1), (t - p0) / (p1 - p0));
  }
  return hex(stops.at(-1)[1]);
}

// ---------------------------------------------------------------------------
// The picture
// ---------------------------------------------------------------------------

/** Everything but the tile, scaled by `s` around the centre (the adaptive icon needs room). */
function scene(s) {
  const at = (v) => 512 + (v - 512) * s;
  const starCx = at(468);
  const starCy = at(470);
  const starR = 300 * s;
  const body = star(starCx, starCy, starR, 0.085);
  const sparkle = star(at(770), at(236), 62 * s, 0.08);
  const arcs = [
    arc(starCx, starCy, 372 * s, 40 * s, 0.2, 1.37),
    arc(starCx, starCy, 470 * s, 40 * s, 0.32, 1.25),
  ];
  return { s, at, starCx, starCy, starR, body, bodyBox: bounds(body), sparkle, sparkleBox: bounds(sparkle), arcs };
}

function render({ tile, scale, mono }) {
  const sc = scene(scale);
  const pixels = new Float64Array(SIZE * SIZE * 4); // premultiplied RGBA, 0..1

  const over = (i, rgb, alpha) => {
    if (alpha <= 0) return;
    const keep = 1 - alpha;
    pixels[i] = rgb[0] / 255 * alpha + pixels[i] * keep;
    pixels[i + 1] = rgb[1] / 255 * alpha + pixels[i + 1] * keep;
    pixels[i + 2] = rgb[2] / 255 * alpha + pixels[i + 2] * keep;
    pixels[i + 3] = alpha + pixels[i + 3] * keep;
  };

  const coverage = (box, inside, x, y) => {
    if (x + 1 < box[0] || x > box[2] || y + 1 < box[1] || y > box[3]) return 0;
    let hits = 0;
    for (let sy = 0; sy < SAMPLES; sy++) {
      for (let sx = 0; sx < SAMPLES; sx++) {
        if (inside(x + (sx + 0.5) / SAMPLES, y + (sy + 0.5) / SAMPLES)) hits++;
      }
    }
    return hits / (SAMPLES * SAMPLES);
  };

  const white = [255, 255, 255];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      if (tile) {
        // NOVA's tile: deep navy, lighter top-left, a faint violet light behind the star.
        over(i, gradient([[0, "#1C2238"], [1, "#07080F"]], (x + y) / (2 * SIZE)), 1);
      }
      if (!mono) {
        const d = Math.hypot(x - sc.starCx, y - sc.starCy) / (420 * sc.s);
        if (d < 1) over(i, hex("#8B5CF6"), 0.5 * (1 - d) ** 2);
        const d2 = Math.hypot(x - sc.at(760), y - sc.at(760)) / (380 * sc.s);
        if (d2 < 1) over(i, hex("#22D3EE"), 0.16 * (1 - d2) ** 2);
      }
      sc.arcs.forEach((a, n) => {
        const c = coverage(a.box, a.inside, x, y);
        if (c) over(i, mono ? white : gradient([[0, "#67E8F9"], [1, "#22D3EE"]], (y - sc.starCy) / (470 * sc.s)), c * (n === 0 ? 0.95 : 0.55));
      });
      const body = coverage(sc.bodyBox, (px, py) => insidePolygon(sc.body, px, py), x, y);
      if (body) {
        const [x0, y0, x1, y1] = sc.bodyBox;
        const t = ((x - x0) / (x1 - x0) * 0.5 + (y - y0) / (y1 - y0) * 0.5 - 0.1) / 0.8;
        over(i, mono ? white : gradient([[0, "#DDD6FE"], [0.45, "#8B5CF6"], [1, "#22D3EE"]], t), body);
      }
      const spark = coverage(sc.sparkleBox, (px, py) => insidePolygon(sc.sparkle, px, py), x, y);
      if (spark) over(i, mono ? white : hex("#EEEBFF"), spark * (mono ? 1 : 0.92));
    }
  }
  return pixels;
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, crc]);
}

function png(pixels) {
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0;
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const a = pixels[i + 3];
      const o = y * (SIZE * 4 + 1) + 1 + x * 4;
      for (let c = 0; c < 3; c++) raw[o + c] = Math.round(a ? (pixels[i + c] / a) * 255 : 0);
      raw[o + 3] = Math.round(a * 255);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const out = new URL("../assets/", import.meta.url);
mkdirSync(out, { recursive: true });
// Full icon (iOS, older Android, the store): the whole tile.
writeFileSync(new URL("icon.png", out), png(render({ tile: true, scale: 0.92, mono: false })));
// Android adaptive icon: the foreground has to fit the 66 % safe circle; the tile colour comes from app.json.
writeFileSync(new URL("adaptive-icon.png", out), png(render({ tile: false, scale: 0.62, mono: false })));
// Android 13 themed icons: a single-colour silhouette.
writeFileSync(new URL("monochrome-icon.png", out), png(render({ tile: false, scale: 0.62, mono: true })));
console.log("assets/icon.png, adaptive-icon.png, monochrome-icon.png");
