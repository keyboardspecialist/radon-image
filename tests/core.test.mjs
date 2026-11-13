import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { instance } = await WebAssembly.instantiate(await readFile(new URL('../public/core.wasm', import.meta.url)), {
  env: { abort() { throw new Error('WASM abort'); } },
});
const core = instance.exports;

test('pyramid reaches exactly one root via 2×2 reductions', () => {
  for (const size of [128, 256, 512]) {
    for (const leaf of [2, 4, 8, 16, 32]) {
      const count = core.levelCount(size, leaf);
      assert.equal(core.tileSize(leaf, count - 1), size);
      let children = (size / leaf) ** 2;
      for (let i = 1; i < count; i++) {
        const parents = (size / core.tileSize(leaf, i)) ** 2;
        assert.equal(children, parents * 4);
        children = parents;
      }
      assert.equal(children, 1);
    }
  }
});

test('invalid geometry cannot hang the WASM planner', () => {
  for (const [size, leaf] of [[0, 8], [256, 0], [256, -8], [255, 16], [128, 256], [256, 12]]) {
    assert.equal(core.levelCount(size, leaf), 0);
  }
});

test('detectors cover diagonal support with interpolation guard bins', () => {
  for (const tile of [2, 4, 8, 16, 32, 64, 128, 256, 512]) {
    const bins = core.detectorBins(tile);
    assert.equal(bins % 2, 0);
    assert.ok((bins - 1) / 2 > Math.SQRT2 * tile / 2 + 1);
  }
});

test('child translations use the correct quadrant centers and sum to zero', () => {
  assert.deepEqual(Array.from({ length: 4 }, (_, child) => [core.childOffset(32, child, 0), core.childOffset(32, child, 1)]), [
    [-8, -8], [8, -8], [-8, 8], [8, 8],
  ]);
});

test('WASM phantom is deterministic, antialiased grayscale with opaque alpha', () => {
  const size = 128, bytes = size * size * 4;
  const pointer = core.allocate(bytes);
  core.rasterize(pointer, size, 0);
  const first = new Uint8Array(core.memory.buffer, pointer, bytes).slice();
  assert.equal(first[0], 0);
  assert.ok(first.some((value, index) => index % 4 !== 3 && value > 0 && value < 255));
  for (let i = 0; i < bytes; i += 4) {
    assert.equal(first[i], first[i + 1]);
    assert.equal(first[i], first[i + 2]);
    assert.equal(first[i + 3], 255);
  }
  core.rasterize(pointer, size, 0);
  assert.deepEqual(first, new Uint8Array(core.memory.buffer, pointer, bytes));
  core.rasterize(pointer, size, 1);
  assert.notDeepEqual(first, new Uint8Array(core.memory.buffer, pointer, bytes));
  core.release(pointer);
});

test('raw allocations are reclaimed across repeated source updates', () => {
  const pointers = new Set();
  for (let i = 0; i < 40; i++) {
    const pointer = core.allocate(512 * 512 * 4);
    pointers.add(pointer);
    core.release(pointer);
  }
  assert.ok(pointers.size < 40, 'allocator should reuse released buffers');
});
