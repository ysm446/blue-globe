// MCP サーバー (メインプロセス) から届いたツールの処理を、画面の操作に橋渡しする
import type { HighlightSpec } from './highlights';
import type { TourScene } from './tour';
import type { TourPanel } from './tour-panel';
import { localHourToDate } from './tour-time';

type Remote = {
  getView(): Record<string, unknown>;
  flyTo(options: { lat: number; lon: number; altitudeKm?: number; heading?: number; tilt?: number; orbit?: number }): unknown;
  highlight(spec: HighlightSpec, append: boolean): Promise<unknown>;
  clearHighlights(): void;
  frameHighlights(options: { heading?: number; tilt?: number; orbit?: number }): unknown;
  caption(text: string, seconds?: number): void;
  clearCaption(): void;
  playTour(scenes: TourScene[], title?: string): void;
  stopTour(): void;
  setTourTime(at: Date | null): void;
  setMapLines(visible: boolean): void;
  setView(view: GlobeView): void;
};

type Args = Record<string, unknown>;

export function initMcpBridge(remote: Remote, setMode: (mode: MapMode) => void, tours: TourPanel): void {
  const handlers: Record<string, (args: Args) => unknown> = {
    get_view: () => remote.getView(),
    fly_to: (a) => {
      const result = remote.flyTo({
        lat: a.lat as number,
        lon: a.lon as number,
        altitudeKm: a.altitude_km as number | undefined,
        heading: a.heading as number | undefined,
        tilt: a.tilt as number | undefined,
        orbit: a.orbit as number | undefined,
      });
      if (typeof result === 'string') throw new Error(result);
      return { flying: true, target: result };
    },
    highlight: async (a) => {
      const info = await remote.highlight(a.spec as HighlightSpec, Boolean(a.append));
      if (!info) throw new Error('見つかりませんでした。名前を英語や別名で試すか、座標で指定してください');
      return info;
    },
    frame_highlights: (a) => {
      const view = remote.frameHighlights({ heading: a.heading as number | undefined, tilt: a.tilt as number | undefined, orbit: a.orbit as number | undefined });
      if (!view) throw new Error('寄せるハイライトがないか、今の視点では使えません (風速モード、太陽系)');
      return { flying: true, target: view };
    },
    clear_highlights: () => {
      remote.clearHighlights();
      return 'ok';
    },
    show_caption: (a) => {
      remote.caption(String(a.text ?? ''), a.seconds as number | undefined);
      return 'ok';
    },
    clear_caption: () => {
      remote.clearCaption();
      return 'ok';
    },
    play_tour: async (a) => {
      const scenes = a.scenes as TourScene[];
      const title = typeof a.title === 'string' ? a.title : undefined;
      remote.playTour(scenes, title);
      const started = `ツアーを始めました (${scenes.length} 場面)。見る人が字幕をクリックすると次へ進みます`;
      if (!a.save) return started;
      try {
        const saved = await tours.saveCurrent(title);
        return `${started}。「${saved.title}」としてツアーのパネルに保存しました`;
      } catch (error) {
        return `${started}。保存はできませんでした (${error instanceof Error ? error.message : String(error)})`;
      }
    },
    stop_tour: () => {
      remote.stopTour();
      return 'ok';
    },
    set_time: (a) => {
      let target: Date | null = null;
      if (typeof a.iso === 'string') target = new Date(a.iso);
      else if (typeof a.hour === 'number') target = localHourToDate(a.hour, (remote.getView().center as { lon: number }).lon);
      if (target && Number.isNaN(target.getTime())) throw new Error('日時を読み取れません');
      remote.setTourTime(target);
      // 太陽は 2.5 秒かけて動くので、行き先の時刻を返す
      return target ? { time: target.toISOString() } : { time: 'live' };
    },
    set_mode: (a) => {
      setMode(a.mode as MapMode);
      return 'ok';
    },
    set_view: (a) => {
      remote.setView(a.view as GlobeView);
      return 'ok';
    },
    set_map_lines: (a) => {
      remote.setMapLines(Boolean(a.visible));
      return 'ok';
    },
  };

  window.weatherApi.onMcpCall(async (id, tool, args) => {
    const handler = handlers[tool];
    try {
      if (!handler) throw new Error(`unknown tool: ${tool}`);
      const value = await handler(args);
      window.weatherApi.mcpReply(id, true, JSON.parse(JSON.stringify(value ?? null)));
    } catch (error) {
      window.weatherApi.mcpReply(id, false, error instanceof Error ? error.message : String(error));
    }
  });
}
