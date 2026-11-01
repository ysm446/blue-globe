// 地域ビューの高解像度の地表と街明かり。視点のまわりのタイルを 1 枚の大きな画像に並べ、順に読み込む。
// 置き場所は列と行の余りで決まるので (tile-window.ts)、範囲が動いても残るタイルは読み直さない
import * as THREE from 'three';
import {
  nextTileWindow,
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
const LAYERS: EarthTileLayer[] = ['day', 'night'];
const MASK_CHANNEL: Record<EarthTileLayer, number> = { day: 0, night: 1 };

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

export class RegionDetail {
  readonly day: THREE.DataTexture;
  readonly night: THREE.DataTexture;
  readonly mask: THREE.DataTexture; // タイルごとの見え具合。R が昼、G が夜
  readonly center = new THREE.Vector2();
  private readonly maskData = new Uint8Array(WINDOW_TILES * WINDOW_TILES * 2);
  private readonly gl: WebGL2RenderingContext;
  private readonly entries = new Map<string, TileEntry>();
  private uploads: TileEntry[] = [];
  private order: TileEntry[] = [];
  private window: TileWindow | null = null;
  private loading = 0;
  private clock = 0;
  private lastMipmap = 0;
  private readonly mipmapsStale: Record<EarthTileLayer, boolean> = { day: false, night: false };
  private disposed = false;

  static isSupported(renderer: THREE.WebGLRenderer): boolean {
    return renderer.capabilities.maxTextureSize >= ATLAS_PIXELS;
  }

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly loadTile: TileLoader,
  ) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.day = this.createAtlas(THREE.RGBAFormat);
    this.day.colorSpace = THREE.SRGBColorSpace;
    this.night = this.createAtlas(THREE.RedFormat); // 描画に使うのは 1 色だけなので、メモリを 4 分の 1 にする
    renderer.initTexture(this.day);
    renderer.initTexture(this.night);

    this.mask = new THREE.DataTexture(this.maskData, WINDOW_TILES, WINDOW_TILES, THREE.RGFormat);
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
        const entry: TileEntry =
          old && old.col === tile.col && old.row === tile.row
            ? old
            : { ...tile, layer, state: 'queued', bitmap: null, opacity: 0, retryAt: 0 };
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
    this.maskData.fill(0);
    for (const entry of this.order) {
      if (entry.state === 'shown') this.writeMask(entry);
    }
    this.mask.needsUpdate = true;
  }

  private writeMask(entry: TileEntry): void {
    const index = (entry.slotY * WINDOW_TILES + entry.slotX) * 2 + MASK_CHANNEL[entry.layer];
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
        const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' });
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
    const texture = layer === 'day' ? this.day : this.night;
    // 一部分だけ送る処理は Three.js にないので、確保済みのテクスチャへ直接書き込む
    const handle = this.renderer.properties.get(texture) as { __webglTexture: WebGLTexture };
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

    for (let i = 0; i < UPLOADS_PER_FRAME; i++) {
      const entry = this.uploads.shift();
      if (!entry) break;
      this.upload(entry);
    }
    const stale = this.mipmapsStale.day || this.mipmapsStale.night;
    if (stale && (this.uploads.length === 0 || this.clock - this.lastMipmap >= MIPMAP_INTERVAL_SECONDS)) {
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
    this.day.dispose();
    this.night.dispose();
    this.mask.dispose();
  }
}
