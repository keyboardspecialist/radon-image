// Geometry and source rasterization run in WebAssembly. The projection itself
// intentionally lives in fragment shaders, not on the CPU or in compute shaders.
export function levelCount(size: i32, leaf: i32): i32 {
  if (size <= 0 || leaf <= 0 || leaf > size || (size & (size - 1)) != 0 || (leaf & (leaf - 1)) != 0) return 0;
  let count = 1;
  while (leaf < size) { leaf *= 2; count++; }
  return count;
}

export function tileSize(leaf: i32, level: i32): i32 { return leaf << level; }

// One-pixel detector spacing, plus a two-pixel interpolation guard on both ends.
export function detectorBins(tile: i32): i32 {
  return (i32(Math.ceil(Math.SQRT2 * f64(tile))) + 5) & ~1;
}

export function childOffset(parentSize: i32, child: i32, axis: i32): f32 {
  const bit = axis == 0 ? child & 1 : (child >> 1) & 1;
  return f32(parentSize) * (bit == 0 ? -0.25 : 0.25);
}

export function allocate(bytes: i32): usize { return heap.alloc(bytes); }
export function release(pointer: usize): void { heap.free(pointer); }

function ellipse(x: f64, y: f64, a: f64, b: f64, cx: f64, cy: f64, angle: f64): bool {
  const c = Math.cos(angle), s = Math.sin(angle);
  const dx = x - cx, dy = y - cy;
  const u = (dx * c + dy * s) / a, v = (-dx * s + dy * c) / b;
  return u * u + v * v <= 1;
}

function phantom(x: f64, y: f64, variant: i32): f64 {
  if (variant == 1) {
    let value = 0.0;
    if (ellipse(x, y, 0.76, 0.76, 0, 0, 0) && !ellipse(x, y, 0.65, 0.65, 0, 0, 0)) value = 0.55;
    if (ellipse(x, y, 0.17, 0.17, -0.30, -0.24, 0)) value = 1.0;
    if (ellipse(x, y, 0.26, 0.12, 0.29, 0.24, -0.6)) value = 0.7;
    if (Math.abs(x + 0.12) < 0.045 && Math.abs(y - 0.25) < 0.25) value = 0.85;
    return value;
  }
  // Modified Shepp–Logan phantom. Coordinates use a downward image y-axis.
  let v = 0.0;
  if (ellipse(x, y, 0.69, 0.92, 0, 0, 0)) v += 1.0;
  if (ellipse(x, y, 0.6624, 0.874, 0, 0.0184, 0)) v -= 0.8;
  if (ellipse(x, y, 0.11, 0.31, 0.22, 0, 0.314159)) v -= 0.2;
  if (ellipse(x, y, 0.16, 0.41, -0.22, 0, -0.314159)) v -= 0.2;
  if (ellipse(x, y, 0.21, 0.25, 0, -0.35, 0)) v += 0.1;
  if (ellipse(x, y, 0.046, 0.046, 0, -0.1, 0)) v += 0.1;
  if (ellipse(x, y, 0.046, 0.046, 0, 0.1, 0)) v += 0.1;
  if (ellipse(x, y, 0.046, 0.023, -0.08, 0.605, 0)) v += 0.1;
  if (ellipse(x, y, 0.023, 0.023, 0, 0.606, 0)) v += 0.1;
  if (ellipse(x, y, 0.023, 0.046, 0.06, 0.605, 0)) v += 0.1;
  return Math.max(0.0, Math.min(1.0, v));
}

export function rasterize(pointer: usize, size: i32, variant: i32): void {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let value = 0.0;
      for (let sy = 0; sy < 2; sy++) {
        for (let sx = 0; sx < 2; sx++) {
          value += phantom((f64(x) + 0.25 + f64(sx) * 0.5) / f64(size) * 2 - 1,
            (f64(y) + 0.25 + f64(sy) * 0.5) / f64(size) * 2 - 1, variant);
        }
      }
      const byte = u8(Math.round(value * 63.75));
      const p = pointer + usize((y * size + x) * 4);
      store<u8>(p, byte); store<u8>(p + 1, byte); store<u8>(p + 2, byte); store<u8>(p + 3, 255);
    }
  }
}
