// 1 フレームの処理時間の計測。描画命令は GPU が後から実行するので、JS の実行時間だけでは GPU の重さが分からない。
// GPU の時間は WebGL のタイマーで測る。結果は数フレーム遅れて届く
const MAX_PENDING_QUERIES = 8; // 結果が届かないときに溜め続けない

export class GpuTimer {
  private readonly gl: WebGL2RenderingContext;
  private readonly timeElapsed: number | null = null;
  private readonly disjoint: number = 0;
  private readonly pending: WebGLQuery[] = [];
  private active = false;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    const extension = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (extension) {
      this.timeElapsed = extension.TIME_ELAPSED_EXT;
      this.disjoint = extension.GPU_DISJOINT_EXT;
    }
  }

  begin(): void {
    if (this.timeElapsed === null || this.pending.length >= MAX_PENDING_QUERIES) return;
    const query = this.gl.createQuery();
    if (!query) return;
    this.gl.beginQuery(this.timeElapsed, query);
    this.pending.push(query);
    this.active = true;
  }

  end(): void {
    if (!this.active || this.timeElapsed === null) return;
    this.gl.endQuery(this.timeElapsed);
    this.active = false;
  }

  // 届いた結果を古い順に ms で返す。GPU の時刻が飛んだ間の結果は信用できないので捨てる
  collect(): number[] {
    const { gl } = this;
    const results: number[] = [];
    const lost = gl.getParameter(this.disjoint) as boolean;
    while (this.pending.length > 0) {
      const query = this.pending[0];
      if (this.active && this.pending.length === 1) break; // 計測中のものはまだ読めない
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
      if (!lost) results.push((gl.getQueryParameter(query, gl.QUERY_RESULT) as number) / 1e6);
      gl.deleteQuery(query);
      this.pending.shift();
    }
    return results;
  }
}

// gpuMs は測れていないときに null
export function formatFrameStats(fps: number, cpuMs: number, gpuMs: number | null): string {
  const head = `${Math.round(fps)} FPS`;
  if (gpuMs === null) return `${head} ${cpuMs.toFixed(1)} ms (CPU)`;
  return `${head} ${(cpuMs + gpuMs).toFixed(1)} ms (CPU ${cpuMs.toFixed(1)} / GPU ${gpuMs.toFixed(1)})`;
}
