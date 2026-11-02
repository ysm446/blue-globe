// 設定画面
import { el, errorMessage, setStatus } from './dom';
import { audioFileName } from './music-player';

const RESET_ICON =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>';

const keysOf = <T extends object>(object: T): Array<keyof T> => Object.keys(object) as Array<keyof T>;

// スライダーの目盛りの位置と設定の値を変換する。つまみを動かすと値の表示と、つまみの左側の色を合わせる
function graphicsSlider(
  id: string,
  toValue: (position: number) => number,
  toPosition: (value: number) => number,
  label: (value: number) => string,
) {
  const input = el<HTMLInputElement>(id);
  const output = el(`${id}-value`);
  const read = (): number => toValue(Number(input.value));
  const show = (): void => {
    output.textContent = label(read());
    const [min, max] = [Number(input.min), Number(input.max)];
    input.style.setProperty('--fill', `${((Number(input.value) - min) / (max - min)) * 100}%`);
  };
  const write = (value: number): void => {
    input.value = String(toPosition(value));
    show();
  };
  return { input, read, show, write };
}

function percentSlider(id: string) {
  return graphicsSlider(
    id,
    (position) => position / 100,
    (value) => Math.round(value * 100),
    (value) => `${Math.round(value * 100)}%`,
  );
}

export function initSettingsDialog(
  onLocationChange: (settings: AppSettings) => void,
  onGraphicsChange: (graphics: GraphicsSettings) => void,
  onAudioChange: (settings: AppSettings) => void,
) {
  const dialog = el<HTMLDialogElement>('settings');
  const locationStatus = el('location-status');
  const results = el<HTMLUListElement>('location-results');
  let settings: AppSettings = { location: null };

  // 開いていたタブは、次に開いたときもそのままにする
  const tabs = Array.from(dialog.querySelectorAll<HTMLButtonElement>('[role="tab"]'));

  function selectTab(selected: HTMLButtonElement): void {
    for (const tab of tabs) {
      const active = tab === selected;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      el(tab.getAttribute('aria-controls') as string).hidden = !active;
    }
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', (event) => {
      const index = tabs.indexOf(tab);
      const nextIndex: Record<string, number> = {
        ArrowLeft: (index - 1 + tabs.length) % tabs.length,
        ArrowRight: (index + 1) % tabs.length,
        Home: 0,
        End: tabs.length - 1,
      };
      if (!Object.hasOwn(nextIndex, event.key)) return;
      event.preventDefault();
      const next = tabs[nextIndex[event.key]];
      selectTab(next);
      next.focus();
    });
  }
  selectTab(tabs[0]);

  function showCurrentLocation(): void {
    const { location } = settings;
    el('current-location').textContent = location
      ? `現在の地点: ${[location.admin1, location.name].filter(Boolean).join(' ')}`
      : '天気を表示する地点を検索して選んでください。';
  }

  async function save(next: AppSettings): Promise<boolean> {
    try {
      settings = await window.weatherApi.saveSettings(next);
      return true;
    } catch (err) {
      setStatus(locationStatus, errorMessage(err), true);
      return false;
    }
  }

  el<HTMLFormElement>('location-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const query = el<HTMLInputElement>('location-query').value.trim();
    if (!query) return;
    results.replaceChildren();
    setStatus(locationStatus, '検索しています…');
    try {
      const rows = await window.weatherApi.searchLocations(query);
      setStatus(locationStatus, rows.length ? '' : '見つかりませんでした。別の表記でお試しください。');
      for (const row of rows) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = row.name;
        const detail = document.createElement('small');
        detail.textContent = [row.admin1, row.country].filter(Boolean).join('・');
        button.append(detail);
        button.addEventListener('click', async () => {
          if (await save({ ...settings, location: row })) {
            results.replaceChildren();
            el<HTMLInputElement>('location-query').value = '';
            showCurrentLocation();
            dialog.close();
            onLocationChange(settings);
          }
        });
        const item = document.createElement('li');
        item.append(button);
        results.append(item);
      }
    } catch (err) {
      setStatus(locationStatus, errorMessage(err), true);
    }
  });

  function showAudioFile(): void {
    const file = settings.audio_file ?? null;
    el('audio-file-name').textContent = file ? `現在の音源: ${audioFileName(file)}` : '音源は選ばれていません。';
    el<HTMLButtonElement>('audio-clear').disabled = !file;
  }

  async function changeAudioFile(change: () => Promise<AppSettings | null>): Promise<void> {
    const status = el('audio-status');
    try {
      const saved = await change();
      setStatus(status, '');
      if (!saved) return; // ダイアログをキャンセルした
      settings = saved;
      showAudioFile();
      onAudioChange(saved);
    } catch (err) {
      setStatus(status, errorMessage(err), true);
    }
  }
  el('audio-choose').addEventListener('click', () => void changeAudioFile(window.weatherApi.chooseAudioFile));
  el('audio-clear').addEventListener('click', () => void changeAudioFile(window.weatherApi.clearAudioFile));

  const selects = {
    fps_limit: el<HTMLSelectElement>('fps-limit'),
    render_scale: el<HTMLSelectElement>('render-scale'),
  };
  const toggles = {
    bloom: el<HTMLInputElement>('bloom-toggle'),
    auto_exposure: el<HTMLInputElement>('exposure-toggle'),
    show_fps: el<HTMLInputElement>('fps-toggle'),
    show_map_lines: el<HTMLInputElement>('map-lines-toggle'),
    show_city_labels: el<HTMLInputElement>('city-labels-toggle'),
    region_detail: el<HTMLInputElement>('region-detail-toggle'),
    volume_clouds: el<HTMLInputElement>('volume-clouds-toggle'),
  };
  const sliders = {
    // 対数にして、1 目盛りごとに同じ比率で変わるようにする
    star_brightness: graphicsSlider('star-brightness', (position) => 2 ** position, Math.log2, (value) => `×${value.toFixed(2)}`),
    cloud_shadow: percentSlider('cloud-shadow'),
    region_bloom: percentSlider('region-bloom'),
    glint_strength: percentSlider('glint-strength'),
  };

  function readGraphics(): GraphicsSettings {
    const graphics = {} as GraphicsSettings;
    for (const key of keysOf(selects)) graphics[key] = Number(selects[key].value);
    for (const key of keysOf(toggles)) graphics[key] = toggles[key].checked;
    for (const key of keysOf(sliders)) graphics[key] = sliders[key].read();
    return graphics;
  }

  function showGraphics(graphics: GraphicsSettings): void {
    for (const key of keysOf(selects)) selects[key].value = String(graphics[key]);
    for (const key of keysOf(toggles)) toggles[key].checked = graphics[key];
    for (const key of keysOf(sliders)) sliders[key].write(graphics[key]);
  }

  // 変更はすぐ画面に反映し、そのあと保存する。保存は順番に行い、最後の操作が必ず残るようにする
  let graphicsSave: Promise<unknown> = Promise.resolve();
  function commitGraphics(): void {
    const graphics = readGraphics();
    onGraphicsChange(graphics);
    syncResetButtons();
    const status = el('graphics-status');
    graphicsSave = graphicsSave
      .then(() => window.weatherApi.setGraphics(graphics))
      .then((saved) => {
        settings = saved;
        setStatus(status, '');
      })
      .catch((err) => setStatus(status, errorMessage(err), true));
  }
  // スライダーは動かしている間も画面に反映し、離したときに保存する
  for (const slider of Object.values(sliders)) {
    slider.input.addEventListener('input', () => {
      slider.show();
      onGraphicsChange(readGraphics());
      syncResetButtons();
    });
  }
  for (const control of [
    ...Object.values(selects),
    ...Object.values(toggles),
    ...Object.values(sliders).map((slider) => slider.input),
  ]) {
    control.addEventListener('change', commitGraphics);
  }

  // 既定値はサーバーの設定を元にする。取得できない間はボタンを押せないままにする
  let graphicsDefaults: GraphicsSettings | null = null;
  const resetButtons = Array.from(dialog.querySelectorAll<HTMLButtonElement>('[data-reset]'));
  const sectionResetButtons = Array.from(dialog.querySelectorAll<HTMLButtonElement>('[data-reset-section]'));

  const resetKey = (button: HTMLButtonElement): keyof GraphicsSettings =>
    button.dataset.reset as keyof GraphicsSettings;
  const rowsOfSection = (button: HTMLButtonElement): HTMLButtonElement[] =>
    resetButtons.filter((row) => row.closest('section') === button.closest('section'));

  function syncResetButtons(): void {
    const current = readGraphics();
    for (const button of resetButtons) {
      const key = resetKey(button);
      // スライダーは目盛りに丸められるので、わずかな差は同じ値として扱う
      button.disabled = !graphicsDefaults || Math.abs(Number(current[key]) - Number(graphicsDefaults[key])) < 1e-6;
    }
    for (const button of sectionResetButtons) {
      button.disabled = rowsOfSection(button).every((row) => row.disabled);
    }
  }

  function resetGraphics(rows: HTMLButtonElement[]): void {
    if (!graphicsDefaults) return;
    const defaults = graphicsDefaults;
    const entries = rows.map((row) => [resetKey(row), defaults[resetKey(row)]]);
    showGraphics({ ...readGraphics(), ...Object.fromEntries(entries) });
    commitGraphics();
  }

  for (const button of resetButtons) button.innerHTML = RESET_ICON;
  for (const button of sectionResetButtons) button.insertAdjacentHTML('afterbegin', RESET_ICON);
  for (const button of resetButtons) button.addEventListener('click', () => resetGraphics([button]));
  for (const button of sectionResetButtons) {
    button.addEventListener('click', () => resetGraphics(rowsOfSection(button)));
  }

  // tabId を渡すと、そのタブを開く
  async function open(tabId?: string): Promise<void> {
    settings = await window.weatherApi.getSettings();
    showCurrentLocation();
    showAudioFile();
    const wanted = tabs.find((tab) => tab.id === tabId);
    if (wanted) selectTab(wanted);
    if (settings.graphics) showGraphics(settings.graphics);
    if (!settings.location) selectTab(tabs[0]); // 地点が未設定のときは、最初にそれを選んでもらう
    if (!graphicsDefaults) {
      graphicsDefaults = await window.weatherApi.getGraphicsDefaults().catch((err) => {
        console.error('graphics defaults load failed', err);
        return null;
      });
    }
    syncResetButtons();
    dialog.showModal();
  }

  return { open };
}
