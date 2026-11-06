// 地域ビューの高解像度の地表、街明かり、水域。視点のまわりのタイルを 1 枚の大きな画像に並べ、順に読み込む。
// 置き場所は列と行の余りで決まるので (tile-window.ts)、範囲が動いても残るタイルは読み直さない。
// 置き場所を別のタイルに使い回すときは、届くまでの間、その場所の元の (低解像度の) 画像を写しておく。
// 前のタイルが残っていると、縮小画像 (ミップマップ) で隣のタイルの縁に別の場所の色が混ざって見えるため
import * as THREE from 'three';
import {
  nextTileWindow,
  TILE_COLS,
  TILE_DEGREES,
  TILE_PIXELS,
  tilesInWindow,
  WINDOW_TILES,
  type TileWindow,
  type WindowTile,
} from './tile-window';

const ATLAS_PIXELS = WINDOW_TILES * TILE_PIXELS;
const MAX_LOADING = 8;
const UPLOADS_PER_FRAME = 2; // 1 枚約 1MB。まとめて送って描画が止まらないようにする
const MIPMAP_INTERVAL_SECONDS = 0.25; // 全体の作り直しは重いので、毎回は行わない
const FADE_SECONDS = 0.5;
const RETRY_SECONDS = 30;
const LAYERS: EarthTileLayer[] = ['day', 'night', 'water'];
const MASK_CHANNEL: Record<EarthTileLayer, number> = { day: 0, night: 1, water: 2 };
const MASK_STRIDE = 4;

type TileState = 'queued' | 'loading' | 'decoded' | 'uploaded' | 'shown' | 'failed';

interface TileEntry extends WindowTile {
  layer: EarthTileLayer;
  state: TileState;
  bitmap: ImageBitmap | null;
  opacity: number;
  retryAt: number;
}

export interface RegionDetailProgress {
  shown: number;
  total: number;
  failed: number;
}

export type TileLoader = (layer: EarthTileLayer, col: number, row: number) => Promise<Uint8Array | null>;

// 元の画像 (正距円筒図法。下の行が南極になるよう上下を入れ替えて送ってある)
export type BaseTextures = Record<EarthTileLayer, THREE.Texture>;

export class RegionDetail {
  readonly atlases: Record<EarthTileLayer, THREE.DataTexture>;
  readonly mask: THREE.DataTexture; // タイルごとの見え具合。R が昼、G が夜、B が水域
  readonly center = new THREE.Vector2();
  private readonly maskData = new Uint8Array(WINDOW_TILES * WINDOW_TILES * MASK_STRIDE);
  private readonly gl: WebGL2RenderingContext;
  private readonly entries = new Map<string, TileEntry>();
  private uploads: TileEntry[] = [];
  private fills: TileEntry[] = []; // 元の画像を写す置き場所
  private base: BaseTextures | null = null;
  private readonly readFramebuffer: WebGLFramebuffer;
  private readonly drawFramebuffer: WebGLFramebuffer;
  private order: TileEntry[] = [];
  private window: TileWindow | null = null;
  private loading = 0;
  private clock = 0;
  private lastMipmap = 0;
  private readonly mipmapsStale: Record<EarthTileLayer, boolean> = { day: false, night: false, water: false };
  private disposed = false;

  static isSupported(renderer: THREE.WebGLRenderer): boolean {
    return renderer.capabilities.maxTextureSize >= ATLAS_PIXELS;
  }

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly loadTile: TileLoader,
  ) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.readFramebuffer = this.gl.createFramebuffer() as WebGLFramebuffer;
    this.drawFramebuffer = this.gl.createFramebuffer() as WebGLFramebuffer;
    this.atlases = {
      day: this.createAtlas(THREE.RGBAFormat),
      night: this.createAtlas(THREE.RedFormat), // 描画に使うのは 1 色だけなので、メモリを 4 分の 1 にする
      water: this.createAtlas(THREE.RedFormat),
    };
    this.atlases.day.colorSpace = THREE.SRGBColorSpace;
    for (const layer of LAYERS) renderer.initTexture(this.atlases[layer]);

    this.mask = new THREE.DataTexture(this.maskData, WINDOW_TILES, WINDOW_TILES, THREE.RGBAFormat);
    this.mask.minFilter = THREE.LinearFilter;
    this.mask.magFilter = THREE.LinearFilter;
    this.mask.wrapS = THREE.RepeatWrapping;
    this.mask.wrapT = THREE.RepeatWrapping;
    this.mask.needsUpdate = true;
  }

  // 領域だけ確保し、中身はタイルが届くたびに送る
  private createAtlas(format: THREE.PixelFormat): THREE.DataTexture {
    const texture = new THREE.DataTexture(null, ATLAS_PIXELS, ATLAS_PIXELS, format);
    texture.source.dataReady = false;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    texture.needsUpdate = true;
    return texture;
  }

  // 元の画像が読み込まれていないうちに作ったときは、読み込まれてから渡す
  setBase(base: BaseTextures): void {
    this.base = base;
    for (const layer of LAYERS) this.renderer.initTexture(base[layer]);
    // 読み込まれる前に置き場所を決めたタイルの分も写す
    for (const entry of this.order) if (entry.state !== 'shown' && !this.fills.includes(entry)) this.fills.push(entry);
  }

  setView(lat: number, lon: number): void {
    const next = nextTileWindow(this.window, lat, lon);
    if (next === this.window) return;
    this.window = next;
    this.center.set(next.col, next.row);

    // 同じタイルが同じ置き場所に残るものはそのまま使い、残りは置き換える
    const previous = new Map(this.entries);
    this.entries.clear();
    this.order = [];
    for (const tile of tilesInWindow(next)) {
      for (const layer of LAYERS) {
        const key = `${layer}:${tile.slotX}:${tile.slotY}`;
        const old = previous.get(key);
        const kept = old && old.col === tile.col && old.row === tile.row;
        const entry: TileEntry = kept ? old : { ...tile, layer, state: 'queued', bitmap: null, opacity: 0, retryAt: 0 };
        if (!kept) this.fills.push(entry);
        entry.distance = tile.distance;
        previous.delete(key);
        this.entries.set(key, entry);
        this.order.push(entry);
      }
    }
    // 残っているのは範囲から外れたタイル
    for (const old of previous.values()) {
      old.bitmap?.close();
      old.bitmap = null;
    }
    this.uploads = this.uploads.filter((entry) => entry.bitmap !== null);
    const current = new Set(this.order);
    this.fills = this.fills.filter((entry) => current.has(entry));
    this.maskData.fill(0);
    // 読み直し中 (reload) のタイルも、届くまでは前の画像を見せる
    for (const entry of this.order) {
      if (entry.opacity > 0) this.writeMask(entry);
    }
    this.mask.needsUpdate = true;
  }

  // 同じ範囲のタイルを、取得する画像を替えて読み直す (地形の陰影の切り替え)。
  // 届くまでは今の画像を見せたままにし、届いたものから置き換える。見え具合は引き継ぐので、フェードはしない
  reload(layer: EarthTileLayer): void {
    const replaced = new Set<TileEntry>();
    for (const [key, entry] of this.entries) {
      if (entry.layer !== layer) continue;
      entry.bitmap?.close();
      const next: TileEntry = { ...entry, state: 'queued', bitmap: null, retryAt: 0 };
      this.entries.set(key, next);
      this.order[this.order.indexOf(entry)] = next;
      // 元の画像をまだ写していない置き場所は、新しい方で写す
      const fill = this.fills.indexOf(entry);
      if (fill >= 0) this.fills[fill] = next;
      replaced.add(entry);
    }
    // 読み込み中の古いタイルは、届いても entries と一致しないので捨てられる
    this.uploads = this.uploads.filter((entry) => !replaced.has(entry));
  }

  private writeMask(entry: TileEntry): void {
    const index = (entry.slotY * WINDOW_TILES + entry.slotX) * MASK_STRIDE + MASK_CHANNEL[entry.layer];
    this.maskData[index] = Math.round(entry.opacity * 255);
  }

  private startLoading(): void {
    for (const entry of this.order) {
      if (this.loading >= MAX_LOADING) return;
      const ready = entry.state === 'queued' || (entry.state === 'failed' && this.clock >= entry.retryAt);
      if (ready) void this.load(entry);
    }
  }

  private async load(entry: TileEntry): Promise<void> {
    entry.state = 'loading';
    this.loading++;
    let bitmap: ImageBitmap | null = null;
    try {
      const bytes = await this.loadTile(entry.layer, entry.col, entry.row);
      if (bytes) {
        // 形式は中身から判定される。水域の PNG は透明が陸で、不透明な部分の R が約 0.66
        const blob = new Blob([bytes as Uint8Array<ArrayBuffer>]);
        bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      }
    } catch (err) {
      console.error('tile decode failed', entry.layer, entry.col, entry.row, err);
    }
    this.loading--;
    // 待っている間に範囲が動いて、別のタイルに置き換わっていることがある
    const current = this.entries.get(`${entry.layer}:${entry.slotX}:${entry.slotY}`) === entry;
    if (this.disposed || !current) {
      bitmap?.close();
      return;
    }
    if (!bitmap) {
      entry.state = 'failed';
      entry.retryAt = this.clock + RETRY_SECONDS;
      return;
    }
    entry.bitmap = bitmap;
    entry.state = 'decoded';
    this.uploads.push(entry);
  }

  private bind(layer: EarthTileLayer): void {
    // 一部分だけ送る処理は Three.js にないので、確保済みのテクスチャへ直接書き込む
    const handle = this.renderer.properties.get(this.atlases[layer]) as { __webglTexture: WebGLTexture };
    this.renderer.state.bindTexture(this.gl.TEXTURE_2D, handle.__webglTexture);
  }

  private upload(entry: TileEntry): void {
    const { gl } = this;
    this.bind(entry.layer);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      entry.slotX * TILE_PIXELS,
      entry.slotY * TILE_PIXELS,
      entry.layer === 'day' ? gl.RGBA : gl.RED,
      gl.UNSIGNED_BYTE,
      entry.bitmap as ImageBitmap,
    );
    this.renderer.state.unbindTexture();
    entry.bitmap?.close();
    entry.bitmap = null;
    entry.state = 'uploaded';
    this.mipmapsStale[entry.layer] = true;
  }

  // 置き場所へ、そのタイルの範囲の元の画像を拡大して写す。GPU の中での複写なので軽い
  private fillFromBase(): void {
    if (!this.base || this.fills.length === 0) return;
    const { gl, renderer } = this;
    const scissor = renderer.getScissorTest();
    renderer.setScissorTest(false); // 複写は切り抜きの影響を受ける
    renderer.state.bindFramebuffer(gl.READ_FRAMEBUFFER, this.readFramebuffer);
    renderer.state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.drawFramebuffer);
    for (const layer of LAYERS) {
      const entries = this.fills.filter((entry) => entry.layer === layer);
      if (entries.length === 0) continue;
      const source = this.base[layer];
      const handle = (texture: THREE.Texture): WebGLTexture =>
        (renderer.properties.get(texture) as { __webglTexture: WebGLTexture }).__webglTexture;
      gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, handle(source), 0);
      gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, handle(this.atlases[layer]), 0);
      const { width, height } = source.image as { width: number; height: number };
      for (const entry of entries) {
        // 元の画像は下が南。置き場所は上 (小さい y) が北なので、上下を入れ替えて写す
        const x0 = Math.round((entry.col / TILE_COLS) * width);
        const x1 = Math.round(((entry.col + 1) / TILE_COLS) * width);
        const north = Math.round(((180 - entry.row * TILE_DEGREES) / 180) * height);
        const south = Math.round(((180 - (entry.row + 1) * TILE_DEGREES) / 180) * height);
        const left = entry.slotX * TILE_PIXELS;
        const top = entry.slotY * TILE_PIXELS;
        gl.blitFramebuffer(x0, south, x1, north, left, top + TILE_PIXELS, left + TILE_PIXELS, top, gl.COLOR_BUFFER_BIT, gl.LINEAR);
      }
      this.mipmapsStale[layer] = true;
    }
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
    gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
    renderer.state.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    renderer.state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    renderer.setScissorTest(scissor);
    this.fills = [];
  }

  private rebuildMipmaps(): void {
    const { gl } = this;
    for (const layer of LAYERS) {
      if (!this.mipmapsStale[layer]) continue;
      this.bind(layer);
      gl.generateMipmap(gl.TEXTURE_2D);
      this.renderer.state.unbindTexture();
      this.mipmapsStale[layer] = false;
      // 縮小画像ができてから見せる。先に見せると遠くのタイルが黒くなる
      for (const entry of this.order) {
        if (entry.layer === layer && entry.state === 'uploaded') entry.state = 'shown';
      }
    }
    this.lastMipmap = this.clock;
  }

  update(dt: number): void {
    this.clock += dt;
    this.startLoading();
    // 同じフレームに届いたタイルより先に写す (届いたタイルを元の画像で上書きしない)
    this.fillFromBase();

    for (let i = 0; i < UPLOADS_PER_FRAME; i++) {
      const entry = this.uploads.shift();
      if (!entry) break;
      this.upload(entry);
    }
    const stale = LAYERS.some((layer) => this.mipmapsStale[layer]);
    if (stale &&(this.uploads.length === 0 || this.clock - this.lastMipmap >= MIPMAP_INTERVAL_SECONDS)) {
      this.rebuildMipmaps();
    }

    let changed = false;
    for (const entry of this.order) {
      if (entry.state !== 'shown' || entry.opacity >= 1) continue;
      entry.opacity = Math.min(1, entry.opacity + dt / FADE_SECONDS);
      this.writeMask(entry);
      changed = true;
    }
    if (changed) this.mask.needsUpdate = true;
  }

  get progress(): RegionDetailProgress {
    let shown = 0;
    let failed = 0;
    for (const entry of this.order) {
      if (entry.state === 'shown') shown++;
      if (entry.state === 'failed') failed++;
    }
    return { shown, total: this.order.length, failed };
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.order) entry.bitmap?.close();
    for (const layer of LAYERS) this.atlases[layer].dispose();
    this.mask.dispose();
    this.gl.deleteFramebuffer(this.readFramebuffer);
    this.gl.deleteFramebuffer(this.drawFramebuffer);
  }
}
