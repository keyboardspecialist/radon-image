export interface Core {
  memory: WebAssembly.Memory;
  levelCount(size: number, leaf: number): number;
  tileSize(leaf: number, level: number): number;
  detectorBins(tile: number): number;
  childOffset(parent: number, child: number, axis: number): number;
  allocate(bytes: number): number;
  release(pointer: number): void;
  rasterize(pointer: number, size: number, variant: number): void;
}

export async function loadCore(): Promise<Core> {
  const response = await fetch(`${import.meta.env.BASE_URL}core.wasm`);
  if (!response.ok) throw new Error(`Cannot load WebAssembly (${response.status}).`);
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {
    env: { abort: () => { throw new Error('WebAssembly aborted.'); } },
  });
  return instance.exports as unknown as Core;
}

export function makePhantom(core: Core, size: number, variant: number): Uint8ClampedArray {
  const pointer = core.allocate(size * size * 4);
  try {
    core.rasterize(pointer, size, variant);
    return new Uint8ClampedArray(core.memory.buffer, pointer, size * size * 4).slice();
  } finally { core.release(pointer); }
}
