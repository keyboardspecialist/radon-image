import type { Core } from './wasm';
import { packAtlas } from './atlas';
import { leafShader, mergeShader, displayShader, filterShader, backprojectShader, reconstructionDisplayShader, projectionLinesShader } from './shaders';

export type OutputView = 'reconstruction' | 'sinogram';

export interface LineStyle {
  enabled: boolean;
  directions: number;
  rays: number;
  width: number;
}

export interface Level {
  index: number;
  tile: number;
  grid: number;
  bins: number;
  columns: number;
  width: number;
  height: number;
  texture: GPUTexture;
}

export interface Result {
  levels: Level[];
  milliseconds: number;
  bytes: number;
  angles: number;
  size: number;
  reconstruction: GPUTexture;
  filtered: GPUTexture;
}

export class Renderer {
  private device!: GPUDevice;
  private contexts = new Map<HTMLCanvasElement, GPUCanvasContext>();
  private leafPipeline!: GPURenderPipeline;
  private mergePipeline!: GPURenderPipeline;
  private viewPipeline!: GPURenderPipeline;
  private filterPipeline!: GPURenderPipeline;
  private backprojectPipeline!: GPURenderPipeline;
  private reconstructionViewPipeline!: GPURenderPipeline;
  private linesPipeline!: GPURenderPipeline;
  private linesExportPipeline!: GPURenderPipeline;
  private linesUniform!: GPUBuffer;
  private viewUniform!: GPUBuffer;
  private result?: Result;
  private onLost: (message: string) => void;
  adapterName = 'WebGPU';

  constructor(private canvas: HTMLCanvasElement, onLost: (message: string) => void) {
    this.onLost = onLost;
  }

  async initialize(): Promise<void> {
    if (!navigator.gpu) throw new Error('WebGPU is not available. Open this page in a current Chrome or Edge browser on localhost or HTTPS.');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter found. Enable hardware acceleration or try a different WebGPU-capable browser.');
    this.adapterName = adapter.info.description || adapter.info.device || adapter.info.vendor || 'WebGPU adapter';
    this.device = await adapter.requestDevice();
    void this.device.lost.then(info => this.onLost(`GPU device lost: ${info.message || info.reason}. Reload the page to reconnect.`));
    this.device.addEventListener('uncapturederror', event => this.onLost(event.error.message));
    this.attachCanvas(this.canvas);
    const format = navigator.gpu.getPreferredCanvasFormat();
    const projectionLayout = this.device.createPipelineLayout({ bindGroupLayouts: [this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      ],
    })] });
    const create = async (label: string, code: string, entry: string, target: GPUTextureFormat, layout = projectionLayout) => {
      const module = this.device.createShaderModule({ label, code });
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter(message => message.type === 'error');
      if (errors.length) throw new Error(`${label}: ${errors.map(e => `${e.lineNum}: ${e.message}`).join('\n')}`);
      return this.device.createRenderPipelineAsync({
        label, layout,
        vertex: { module, entryPoint: 'fullscreen' },
        fragment: { module, entryPoint: entry, targets: [{ format: target }] },
        primitive: { topology: 'triangle-list' },
      });
    };
    [this.leafPipeline, this.mergePipeline, this.viewPipeline, this.filterPipeline, this.backprojectPipeline, this.reconstructionViewPipeline, this.linesPipeline, this.linesExportPipeline] = await Promise.all([
      create('Leaf ray integrals', leafShader, 'project', 'r32float'),
      create('2×2 shifted projection merge', mergeShader, 'merge', 'r32float'),
      create('Sinogram presentation', displayShader, 'display', format),
      create('Ram–Lak detector filter', filterShader, 'rampFilter', 'r32float'),
      create('Filtered backprojection', backprojectShader, 'backproject', 'r32float'),
      create('Reconstructed image presentation', reconstructionDisplayShader, 'display', format),
      create('Coarse-ray density backprojection', projectionLinesShader, 'display', format),
      create('Coarse-ray PNG export', projectionLinesShader, 'display', 'rgba8unorm'),
    ]);
    this.viewUniform = this.device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.linesUniform = this.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  // Multiple views share the same device, transform pyramid, and inverse.
  attachCanvas(canvas: HTMLCanvasElement): void {
    if (this.contexts.has(canvas)) return;
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('Cannot create a WebGPU canvas.');
    context.configure({ device: this.device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'opaque' });
    this.contexts.set(canvas, context);
  }

  async transform(core: Core, pixels: Uint8ClampedArray, size: number, leaf: number, angles: number): Promise<Result> {
    const device = this.device;
    const count = core.levelCount(size, leaf);
    if (!count || !Number.isInteger(angles) || angles < 1 || pixels.length !== size * size * 4) {
      throw new Error('Expected a power-of-two image and leaf size, positive integer angle count, and matching RGBA data.');
    }
    const geometry = Array.from({ length: count }, (_, index) => {
      const tile = core.tileSize(leaf, index);
      const grid = size / tile;
      const bins = core.detectorBins(tile);
      return { index, tile, grid, bins, ...packAtlas(grid, bins, angles, device.limits.maxTextureDimension2D) };
    });
    device.pushErrorScope('validation');
    const source = device.createTexture({
      label: 'Grayscale source', size: [size, size], format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const levels: Level[] = [];
    const uniforms: GPUBuffer[] = [];
    let filtered: GPUTexture | undefined;
    let reconstruction: GPUTexture | undefined;
    let accepted = false;
    let scopePopped = false;
    try {
      device.queue.writeTexture({ texture: source }, pixels as Uint8ClampedArray<ArrayBuffer>, { bytesPerRow: size * 4 }, [size, size]);
      const encoder = device.createCommandEncoder({ label: 'Hierarchical Radon pyramid' });
      for (const g of geometry) {
        const texture = device.createTexture({
          label: `L${g.index}: ${g.grid}×${g.grid} local sinograms`, size: [g.width, g.height], format: 'r32float',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
        });
        const level = { ...g, texture };
        levels.push(level);
        const previous = levels[g.index - 1];
        const data = new Float32Array(24);
        data.set([g.tile, g.grid, g.bins, angles, g.columns, previous?.bins ?? 0, previous?.columns ?? 0, 0]);
        for (let child = 0; child < 4; child++) {
          data[8 + child * 4] = core.childOffset(g.tile, child, 0);
          data[9 + child * 4] = core.childOffset(g.tile, child, 1);
        }
        const uniform = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        uniforms.push(uniform);
        device.queue.writeBuffer(uniform, 0, data);
        const pipeline = previous ? this.mergePipeline : this.leafPipeline;
        const bindGroup = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: (previous?.texture ?? source).createView() }],
        });
        const pass = encoder.beginRenderPass({
          label: `Radon L${g.index}`, colorAttachments: [{
            view: texture.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store',
          }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.end();
      }
      const root = levels[levels.length - 1];
      filtered = device.createTexture({
        label: 'Ram–Lak filtered root sinogram', size: [root.bins, angles], format: 'r32float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      reconstruction = device.createTexture({
        label: 'Image reconstructed from root projections', size: [size, size], format: 'r32float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      const inverseUniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      uniforms.push(inverseUniform);
      device.queue.writeBuffer(inverseUniform, 0, new Float32Array([size, root.bins, angles, 0]));
      for (const [pipeline, input, output] of [
        [this.filterPipeline, root.texture, filtered],
        [this.backprojectPipeline, filtered, reconstruction],
      ] as const) {
        const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: inverseUniform } }, { binding: 1, resource: input.createView() },
        ] });
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: output.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
        pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.draw(3); pass.end();
      }
      const start = performance.now();
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
      const milliseconds = performance.now() - start;
      const error = await device.popErrorScope();
      scopePopped = true;
      if (error) throw new Error(error.message);
      const result = { levels, reconstruction, filtered, milliseconds, bytes: levels.reduce((sum, level) => sum + level.width * level.height * 4, (size * size + root.bins * angles) * 4), angles, size };
      this.result?.levels.forEach(level => level.texture.destroy());
      this.result?.reconstruction.destroy();
      this.result?.filtered.destroy();
      this.result = result;
      accepted = true;
      return result;
    } finally {
      if (!scopePopped) await device.popErrorScope();
      source.destroy();
      uniforms.forEach(uniform => uniform.destroy());
      if (!accepted) { levels.forEach(level => level.texture.destroy()); reconstruction?.destroy(); filtered?.destroy(); }
    }
  }

  draw(levelIndex: number, gain: number, color: boolean, view: OutputView = 'sinogram', lines?: LineStyle, canvas = this.canvas): void {
    if (!this.result) return;
    const context = this.contexts.get(canvas);
    if (!context) throw new Error('Attach the output canvas before drawing.');
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const level = this.result.levels[levelIndex];
    if (!level) return;
    this.device.queue.writeBuffer(this.viewUniform, 0, new Float32Array([
      width, height, level.grid, level.bins, this.result.angles, level.tile, gain, color ? 1 : 0, level.columns, 0, 0, 0,
    ]));
    const styled = view === 'reconstruction' && lines?.enabled;
    const pipeline = styled ? this.linesPipeline : view === 'reconstruction' ? this.reconstructionViewPipeline : this.viewPipeline;
    const texture = styled ? this.result.filtered : view === 'reconstruction' ? this.result.reconstruction : level.texture;
    if (styled) {
      this.device.queue.writeBuffer(this.linesUniform, 0, this.lineParameters(this.result, lines, width, height));
    }
    const bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: styled ? this.linesUniform : this.viewUniform } },
        { binding: 1, resource: texture.createView() },
      ],
    });
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{
      view: context.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store',
    }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  // Read back raw, unnormalized float32 integrals, not the display colormap.
  async readLevel(index: number): Promise<Float32Array> {
    const level = this.result?.levels[index];
    if (!level) throw new Error('Run a transform first.');
    return this.readTexture(level.texture, level.width, level.height);
  }

  async readReconstruction(): Promise<Float32Array> {
    if (!this.result) throw new Error('Run a transform first.');
    return this.readTexture(this.result.reconstruction, this.result.size, this.result.size);
  }

  private lineParameters(result: Result, lines: LineStyle, width: number, height: number): Float32Array<ArrayBuffer> {
    const root = result.levels[result.levels.length - 1];
    return new Float32Array([
      width, height, result.size, root.bins, result.angles,
      Math.max(1, Math.min(result.angles, Math.round(lines.directions))),
      Math.max(8, Math.min(128, Math.round(lines.rays))), Math.max(0.1, Math.min(1, lines.width)),
    ]);
  }

  // Render the same ray-density shader at source resolution, not a screenshot
  // of the CSS-sized preview. Dedicated resources freeze this frame while music
  // continues to redraw with different uniforms on the visible canvas.
  async readCoarseReconstruction(lines: LineStyle): Promise<Uint8ClampedArray<ArrayBuffer>> {
    if (!this.result) throw new Error('Run a transform first.');
    const result = this.result, size = result.size;
    const bytesPerRow = Math.ceil(size * 4 / 256) * 256;
    const texture = this.device.createTexture({
      label: 'Coarse-ray export snapshot', size: [size, size], format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const uniform = this.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const buffer = this.device.createBuffer({ size: bytesPerRow * size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      this.device.queue.writeBuffer(uniform, 0, this.lineParameters(result, lines, size, size));
      const bindGroup = this.device.createBindGroup({ layout: this.linesExportPipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: result.filtered.createView() },
      ] });
      const encoder = this.device.createCommandEncoder({ label: 'Export coarse-ray PNG pixels' });
      const pass = encoder.beginRenderPass({ colorAttachments: [{
        view: texture.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store',
      }] });
      pass.setPipeline(this.linesExportPipeline); pass.setBindGroup(0, bindGroup); pass.draw(3); pass.end();
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [size, size]);
      this.device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const padded = new Uint8Array(buffer.getMappedRange());
      const pixels = new Uint8ClampedArray(size * size * 4);
      for (let y = 0; y < size; y++) pixels.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + size * 4), y * size * 4);
      buffer.unmap();
      return pixels;
    } finally { buffer.destroy(); uniform.destroy(); texture.destroy(); }
  }

  private async readTexture(texture: GPUTexture, width: number, height: number): Promise<Float32Array> {
    const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
    const buffer = this.device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = this.device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [width, height]);
      this.device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const padded = new Float32Array(buffer.getMappedRange());
      const output = new Float32Array(width * height);
      for (let y = 0; y < height; y++) output.set(padded.subarray(y * bytesPerRow / 4, y * bytesPerRow / 4 + width), y * width);
      buffer.unmap();
      return output;
    } finally { buffer.destroy(); }
  }
}
