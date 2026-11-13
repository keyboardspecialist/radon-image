export const vertex = /* wgsl */ `
@vertex fn fullscreen(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(p[index], 0, 1);
}`;

// Uniforms have the same layout in both projection passes. The four child
// translations are supplied by the WebAssembly geometry module.
const parameters = /* wgsl */ `
struct Params {
  tile: f32, grid: f32, bins: f32, angles: f32,
  columns: f32, previousBins: f32, previousColumns: f32, padding: f32,
  offsets: array<vec4f, 4>,
}
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var input: texture_2d<f32>;
`;

export const leafShader = vertex + parameters + /* wgsl */ `
fn readSource(q: vec2f, origin: vec2f) -> f32 {
  // Clamp the reconstruction to this leaf: interpolation must not borrow image
  // energy from neighboring tiles before their projections are merged.
  let pixel = q - vec2f(0.5);
  let base = floor(pixel);
  let f = fract(pixel);
  let lo = vec2i(origin);
  let hi = lo + vec2i(i32(p.tile) - 1);
  let a = textureLoad(input, clamp(vec2i(base), lo, hi), 0).r;
  let b = textureLoad(input, clamp(vec2i(base) + vec2i(1, 0), lo, hi), 0).r;
  let c = textureLoad(input, clamp(vec2i(base) + vec2i(0, 1), lo, hi), 0).r;
  let d = textureLoad(input, clamp(vec2i(base) + vec2i(1, 1), lo, hi), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

@fragment fn project(@builtin(position) position: vec4f) -> @location(0) f32 {
  let pixel = floor(position.xy);
  let atlasCell = floor(pixel / vec2f(p.bins, p.angles));
  let index = i32(atlasCell.y * p.columns + atlasCell.x);
  if (index >= i32(p.grid * p.grid)) { return 0.0; }
  let cell = vec2f(f32(index % i32(p.grid)), f32(index / i32(p.grid)));
  let local = pixel - atlasCell * vec2f(p.bins, p.angles);
  let theta = local.y * 3.141592653589793 / p.angles;
  let normal = vec2f(cos(theta), sin(theta));
  let tangent = vec2f(-normal.y, normal.x);
  let s = local.x - (p.bins - 1.0) * 0.5;
  let rayOrigin = normal * s;
  let half = p.tile * 0.5;
  var near = -1e10;
  var far = 1e10;
  for (var axis = 0u; axis < 2u; axis++) {
    if (abs(tangent[axis]) < 0.000001) {
      if (abs(rayOrigin[axis]) >= half) { return 0.0; }
    } else {
      let a = (-half - rayOrigin[axis]) / tangent[axis];
      let b = (half - rayOrigin[axis]) / tangent[axis];
      near = max(near, min(a, b));
      far = min(far, max(a, b));
    }
  }
  if (far <= near) { return 0.0; }
  // Midpoint quadrature, at most half a source pixel per step.
  let steps = u32(ceil((far - near) * 2.0));
  let dt = (far - near) / f32(steps);
  let origin = cell * p.tile;
  var sum = 0.0;
  for (var i = 0u; i < steps; i++) {
    let t = near + (f32(i) + 0.5) * dt;
    sum += readSource(origin + vec2f(half) + rayOrigin + tangent * t, origin);
  }
  return sum * dt;
}`;

export const mergeShader = vertex + parameters + /* wgsl */ `
fn readBin(cell: vec2i, bin: i32, angle: i32) -> f32 {
  if (bin < 0 || bin >= i32(p.previousBins)) { return 0.0; }
  let index = cell.y * i32(p.grid * 2.0) + cell.x;
  let atlasCell = vec2i(index % i32(p.previousColumns), index / i32(p.previousColumns));
  return textureLoad(input, atlasCell * vec2i(i32(p.previousBins), i32(p.angles)) + vec2i(bin, angle), 0).r;
}

@fragment fn merge(@builtin(position) position: vec4f) -> @location(0) f32 {
  let pixel = vec2i(position.xy);
  let atlasCell = pixel / vec2i(i32(p.bins), i32(p.angles));
  let index = atlasCell.y * i32(p.columns) + atlasCell.x;
  if (index >= i32(p.grid * p.grid)) { return 0.0; }
  let cell = vec2i(index % i32(p.grid), index / i32(p.grid));
  let local = pixel - atlasCell * vec2i(i32(p.bins), i32(p.angles));
  let theta = f32(local.y) * 3.141592653589793 / p.angles;
  let normal = vec2f(cos(theta), sin(theta));
  let s = f32(local.x) - (p.bins - 1.0) * 0.5;
  var sum = 0.0;
  for (var child = 0u; child < 4u; child++) {
    let childCell = cell * 2 + vec2i(i32(child & 1u), i32(child >> 1u));
    let detector = s - dot(p.offsets[child].xy, normal) + (p.previousBins - 1.0) * 0.5;
    let lo = i32(floor(detector));
    sum += mix(readBin(childCell, lo, local.y), readBin(childCell, lo + 1, local.y), fract(detector));
  }
  return sum;
}`;

const inverseParameters = /* wgsl */ `
struct Inverse { size: f32, bins: f32, angles: f32, padding: f32 }
@group(0) @binding(0) var<uniform> p: Inverse;
@group(0) @binding(1) var input: texture_2d<f32>;
fn readProjection(bin: i32, angle: i32) -> f32 {
  if (bin < 0 || bin >= i32(p.bins)) { return 0.0; }
  return textureLoad(input, vec2i(bin, angle), 0).r;
}
`;

// Discrete Ram–Lak convolution, zero extended (not a circular convolution).
// Detector spacing is one source pixel: h[0] = 1/4, h[odd] = -1/(pi*k)^2.
export const filterShader = vertex + inverseParameters + /* wgsl */ `
@fragment fn rampFilter(@builtin(position) position: vec4f) -> @location(0) f32 {
  let bin = i32(position.x);
  let angle = i32(position.y);
  var sum = 0.25 * readProjection(bin, angle);
  for (var k = 1; k < i32(p.bins); k += 2) {
    let weight = -1.0 / (9.869604401089358 * f32(k * k));
    sum += weight * (readProjection(bin - k, angle) + readProjection(bin + k, angle));
  }
  return sum;
}`;

// No source-image binding: the inverse only has access to filtered projections.
export const backprojectShader = vertex + inverseParameters + /* wgsl */ `
@fragment fn backproject(@builtin(position) position: vec4f) -> @location(0) f32 {
  let point = position.xy - vec2f(p.size * 0.5);
  var sum = 0.0;
  for (var angle = 0; angle < i32(p.angles); angle++) {
    let theta = f32(angle) * 3.141592653589793 / p.angles;
    let detector = dot(point, vec2f(cos(theta), sin(theta))) + (p.bins - 1.0) * 0.5;
    let lo = i32(floor(detector));
    sum += mix(readProjection(lo, angle), readProjection(lo + 1, angle), fract(detector));
  }
  return sum * 3.141592653589793 / p.angles;
}`;

export const reconstructionDisplayShader = vertex + /* wgsl */ `
struct View { width: f32, height: f32, grid: f32, bins: f32, angles: f32, tile: f32, gain: f32, color: f32 }
@group(0) @binding(0) var<uniform> v: View;
@group(0) @binding(1) var image: texture_2d<f32>;
@fragment fn display(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let dimensions = vec2f(v.width, v.height);
  let side = min(v.width, v.height);
  let uv = (position.xy - (dimensions - vec2f(side)) * 0.5) / side;
  if (any(uv < vec2f(0)) || any(uv >= vec2f(1))) { return vec4f(0.035, 0.05, 0.055, 1); }
  let size = vec2i(textureDimensions(image));
  let pixel = uv * vec2f(size) - vec2f(0.5);
  let base = vec2i(floor(pixel));
  let f = fract(pixel);
  let a = textureLoad(image, clamp(base, vec2i(0), size - 1), 0).r;
  let b = textureLoad(image, clamp(base + vec2i(1, 0), vec2i(0), size - 1), 0).r;
  let c = textureLoad(image, clamp(base + vec2i(0, 1), vec2i(0), size - 1), 0).r;
  let d = textureLoad(image, clamp(base + vec2i(1, 1), vec2i(0), size - 1), 0).r;
  // Unit intensity is white, matching the source. Never min/max normalize the
  // reconstruction: that would hide gain errors and amplify a black input.
  let value = clamp(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), 0.0, 1.0);
  return vec4f(vec3f(value), 1);
}`;

// Coarse backprojection, not an overlay. This shader has NO reconstructed-image
// binding: every visible value is accumulated from finite-width projection rays.
export const projectionLinesShader = vertex + /* wgsl */ `
struct Lines {
  width: f32, height: f32, size: f32, bins: f32,
  angles: f32, directions: f32, rays: f32, rayWidth: f32,
}
@group(0) @binding(0) var<uniform> v: Lines;
@group(0) @binding(1) var projections: texture_2d<f32>;

@fragment fn display(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let dimensions = vec2f(v.width, v.height);
  let side = min(v.width, v.height);
  let uv = (position.xy - (dimensions - vec2f(side)) * 0.5) / side;
  if (any(uv < vec2f(0)) || any(uv >= vec2f(1))) { return vec4f(0.035, 0.05, 0.055, 1); }
  let point = (uv - vec2f(0.5)) * v.size;
  let pitch = max(1.0, v.size / v.rays);
  let beamWidth = pitch * v.rayWidth;
  let aa = min(beamWidth * 0.45, v.size / side * 0.65);
  let directions = i32(min(v.directions, v.angles));
  var density = 0.0;
  for (var i = 0; i < directions; i++) {
    let angle = i32(floor((f32(i) + 0.5) * v.angles / f32(directions)));
    let theta = f32(angle) * 3.141592653589793 / v.angles;
    let detector = dot(point, vec2f(cos(theta), sin(theta))) + (v.bins - 1.0) * 0.5;
    // Deterministically stagger detector groups, without rotating or varying a
    // ray along its length. A ray is one constant coefficient across the image.
    let phase = fract(f32(i) * 0.61803398875) * pitch;
    let start = floor((detector - phase) / pitch) * pitch + phase;
    let center = start + pitch * 0.5;
    let coverage = 1.0 - smoothstep(beamWidth * 0.5 - aa, beamWidth * 0.5 + aa, abs(detector - center));
    if (coverage > 0.0) {
      // Box-average fine detector bins into a genuinely coarse projection ray.
      // Partial-bin weights avoid aliasing when pitch is not an integer.
      var coefficient = 0.0;
      for (var bin = i32(floor(start + 0.5)); bin < i32(ceil(start + pitch + 0.5)); bin++) {
        if (bin >= 0 && bin < i32(v.bins)) {
          let weight = max(0.0, min(start + pitch, f32(bin) + 0.5) - max(start, f32(bin) - 0.5));
          coefficient += textureLoad(projections, vec2i(bin, angle), 0).r * weight;
        }
      }
      density += coefficient / pitch * coverage;
    }
  }
  // Positive/negative filtered rays add/subtract density, as in FBP. Normalize
  // for angular spacing and beam duty cycle, then expose the accumulated result.
  density *= 3.141592653589793 / f32(directions) / v.rayWidth;
  let value = 1.0 - exp(-max(density, 0.0) * 2.2);
  return vec4f(vec3f(value), 1);
}`;

export const displayShader = vertex + /* wgsl */ `
struct View {
  width: f32, height: f32, grid: f32, bins: f32,
  angles: f32, tile: f32, gain: f32, color: f32,
  columns: f32, padding0: f32, padding1: f32, padding2: f32,
}
@group(0) @binding(0) var<uniform> v: View;
@group(0) @binding(1) var image: texture_2d<f32>;

fn palette(t: f32) -> vec3f {
  let c0 = vec3f(0.025, 0.055, 0.075);
  let c1 = vec3f(0.045, 0.30, 0.32);
  let c2 = vec3f(0.20, 0.68, 0.51);
  let c3 = vec3f(0.78, 0.94, 0.49);
  let c4 = vec3f(1.0, 0.97, 0.80);
  if (t < 0.25) { return mix(c0, c1, t * 4); }
  if (t < 0.5) { return mix(c1, c2, (t - 0.25) * 4); }
  if (t < 0.75) { return mix(c2, c3, (t - 0.5) * 4); }
  return mix(c3, c4, (t - 0.75) * 4);
}

@fragment fn display(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = position.xy / vec2f(v.width, v.height);
  let tileUV = uv * v.grid;
  let cell = min(vec2i(floor(tileUV)), vec2i(i32(v.grid) - 1));
  let local = fract(tileUV);
  let gap = select(0.0, 0.018, v.grid > 1.0);
  if (local.x < gap || local.y < gap || local.x > 1.0 - gap || local.y > 1.0 - gap) {
    return vec4f(0.04, 0.065, 0.075, 1);
  }
  let q = clamp((local - gap) / (1.0 - 2.0 * gap), vec2f(0), vec2f(0.99999));
  // Presentation transposes storage: angle horizontally, detector vertically.
  let index = cell.y * i32(v.grid) + cell.x;
  let atlasCell = vec2i(index % i32(v.columns), index / i32(v.columns));
  let texel = atlasCell * vec2i(i32(v.bins), i32(v.angles)) + vec2i(i32(q.y * v.bins), i32(q.x * v.angles));
  let raw = textureLoad(image, texel, 0).r / v.tile;
  let t = pow(clamp(raw * v.gain, 0.0, 1.0), 0.8);
  let rgb = select(vec3f(t), palette(t), v.color > 0.5);
  return vec4f(rgb, 1);
}`;
