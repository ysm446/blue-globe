// 設定画面
import { F_NUMBERS, focalLengthForFov, nearestFNumber, verticalFov } from './camera-lens';
import { el, errorMessage, setStatus } from './dom';
import { audioFileName } from './music-player';
import { isFontInstalled, UI_FONTS } from './ui-font';

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

function formatGlobeSize(meters: number): string {
  if (meters < 1) return `${Math.round(meters * 100)} cm`;
  return `${meters < 10 ? meters.toFixed(1) : Math.round(meters)} m`;
}

function percentSlider(id: string) {
  return graphicsSlider(
    id,
    (position) => position / 100,
    (value) => Math.round(value * 100),
    (value) => `${Math.round(value * 100)}%`,
  );
}

const HELP_DELAY_MS = 350; // すぐ出ると、スライダーへ向かう途中で次々に出て目障り
const HELP_GAP = 6;

// 項目の説明のポップアップ。data-help を持つラベルにマウスを乗せるか、中の入力にフォーカスすると、
// その下に出す。設定画面は最前面の層にあるので、ポップアップも設定画面の中に置く
function initHelpPopup(dialog: HTMLDialogElement): void {
  const popup = document.createElement('div');
  popup.className = 'settings-tip';
  popup.setAttribute('role', 'tooltip');
  popup.hidden = true;
  dialog.append(popup);
  let timer = 0;
  let shownFor: HTMLElement | null = null;

  function show(label: HTMLElement): void {
    popup.textContent = label.dataset.help ?? '';
    popup.hidden = false;
    shownFor = label;
    // 画面の下にはみ出すなら、ラベルの上に出す
    const anchor = label.getBoundingClientRect();
    const box = popup.getBoundingClientRect();
    const dialogBox = dialog.getBoundingClientRect();
    const left = Math.min(Math.max(anchor.left, dialogBox.left + 8), dialogBox.right - box.width - 8);
    const below = anchor.bottom + HELP_GAP;
    const top = below + box.height <= dialogBox.bottom - 8 ? below : anchor.top - HELP_GAP - box.height;
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
  }

  function hide(): void {
    window.clearTimeout(timer);
    timer = 0;
    popup.hidden = true;
    shownFor = null;
  }

  // ラベルの中の要素か、for で結ばれた入力 (スライダーや選択) からラベルを探す
  function labelOf(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    const inside = target.closest<HTMLElement>('[data-help]');
    if (inside) return inside;
    return target.id ? dialog.querySelector<HTMLElement>(`label[for="${target.id}"][data-help]`) : null;
  }

  dialog.addEventListener('mouseover', (event) => {
    const label = labelOf(event.target);
    if (!label || label === shownFor) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => show(label), HELP_DELAY_MS);
  });
  dialog.addEventListener('mouseout', (event) => {
    const label = labelOf(event.target);
    if (label && !label.contains(event.relatedTarget as Node | null)) hide();
  });
  // キーボードで項目に移ったときも出す
  dialog.addEventListener('focusin', (event) => {
    const label = labelOf(event.target);
    if (label) show(label);
  });
  dialog.addEventListener('focusout', hide);
  // タブを切り替えるとラベルが隠れるので消す。チェックボックスを押したときも消えるが、また乗せ直せば出る
  dialog.addEventListener('click', hide);
  dialog.addEventListener('scroll', hide, true);
  dialog.addEventListener('close', hide);
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

  initHelpPopup(dialog);

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
      ? `設定中の場所: ${[location.admin1, location.name].filter(Boolean).join(' ')}`
      : '天気を表示する場所を検索して選んでください。';
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
    cloud_resolution: el<HTMLSelectElement>('cloud-resolution'),
  };
  // 値が文字列の選択
  const choices = {
    ui_font: el<HTMLSelectElement>('ui-font'),
    cruise_mode: el<HTMLSelectElement>('cruise-mode'),
  };
  // 入っていないフォントは候補から外す。外したものが保存されていても、文字は游ゴシック UI で出る
  for (const option of Array.from(choices.ui_font.options)) {
    option.hidden = !isFontInstalled(UI_FONTS[option.value as UiFont]);
  }
  const toggles = {
    bloom: el<HTMLInputElement>('bloom-toggle'),
    auto_exposure: el<HTMLInputElement>('exposure-toggle'),
    show_fps: el<HTMLInputElement>('fps-toggle'),
    show_map_lines: el<HTMLInputElement>('map-lines-toggle'),
    show_city_labels: el<HTMLInputElement>('city-labels-toggle'),
    show_country_labels: el<HTMLInputElement>('country-labels-toggle'),
    show_planet_labels: el<HTMLInputElement>('planet-labels-toggle'),
    show_constellations: el<HTMLInputElement>('constellations-toggle'),
    star_twinkle: el<HTMLInputElement>('twinkle-toggle'),
    region_detail: el<HTMLInputElement>('region-detail-toggle'),
    region_relief: el<HTMLInputElement>('region-relief-toggle'),
    volume_clouds: el<HTMLInputElement>('volume-clouds-toggle'),
    moonlight: el<HTMLInputElement>('moonlight-toggle'),
    cruise_bank: el<HTMLInputElement>('cruise-bank-toggle'),
    lens_flare: el<HTMLInputElement>('lens-flare-toggle'),
    wireframe: el<HTMLInputElement>('wireframe-toggle'),
    mcp_server: el<HTMLInputElement>('mcp-server-toggle'),
    depth_of_field: el<HTMLInputElement>('depth-of-field-toggle'),
    show_hourly_panel: el<HTMLInputElement>('hourly-panel-toggle'),
    show_weekly_panel: el<HTMLInputElement>('weekly-panel-toggle'),
    show_details_panel: el<HTMLInputElement>('details-panel-toggle'),
    show_camera_panel: el<HTMLInputElement>('camera-panel-toggle'),
  };
  const sliders = {
    // 対数にして、1 目盛りごとに同じ比率で変わるようにする
    star_brightness: graphicsSlider('star-brightness', (position) => 2 ** position, Math.log2, (value) => `×${value.toFixed(2)}`),
    space_tint: percentSlider('space-tint'),
    cloud_shadow: percentSlider('cloud-shadow'),
    cloud_edge_detail: percentSlider('cloud-edge-detail'),
    cloud_edge_sharpness: percentSlider('cloud-edge-sharpness'),
    cloud_puffiness: percentSlider('cloud-puffiness'),
    cloud_height: percentSlider('cloud-height'),
    region_bloom: percentSlider('region-bloom'),
    city_glow: percentSlider('city-glow'),
    glint_strength: percentSlider('glint-strength'),
    border_opacity: percentSlider('border-opacity'),
    // 0.25 刻み
    terrain_shading: graphicsSlider('terrain-shading', (position) => position / 4, (value) => Math.round(value * 4), (value) =>
      value === 0 ? 'なし' : `×${value.toFixed(value * 2 === Math.round(value * 2) ? 1 : 2)}`,
    ),
    focal_length: graphicsSlider('focal-length', (position) => position, (value) => value, (value) => `${Number.isInteger(value) ? value : value.toFixed(1)}mm`),
    exposure_compensation: graphicsSlider('exposure-compensation', (position) => position, (value) => value, (value) => `${value > 0 ? '+' : ''}${value} EV`),
    f_number: graphicsSlider('f-number', (position) => F_NUMBERS[position], nearestFNumber, (value) => `F${value}`),
    // 対数にして、10 目盛りで 10 倍にする
    globe_size: graphicsSlider('globe-size', (position) => 10 ** (position / 10), (value) => Math.round(10 * Math.log10(value)), formatGlobeSize),
  };

  // 縦の画角のスライダー。設定には持たず、焦点距離と今の窓の形から求めて連動させる
  const fovSlider = graphicsSlider('field-of-view', (position) => position, (value) => value, (value) => `${value.toFixed(1)}°`);
  const focalInput = sliders.focal_length.input;
  const windowAspect = (): number => window.innerWidth / window.innerHeight;
  const roundTenth = (value: number): number => Math.round(value * 10) / 10;

  function showFov(): void {
    const aspect = windowAspect();
    // 端の値から求めた焦点距離が範囲の外へ出ないよう、内側へ丸める
    fovSlider.input.min = String(Math.ceil(verticalFov(Number(focalInput.max), aspect) * 10) / 10);
    fovSlider.input.max = String(Math.floor(verticalFov(Number(focalInput.min), aspect) * 10) / 10);
    fovSlider.write(roundTenth(verticalFov(sliders.focal_length.read(), aspect)));
  }

  focalInput.addEventListener('input', showFov);
  fovSlider.input.addEventListener('input', () => {
    const focal = roundTenth(focalLengthForFov(fovSlider.read(), windowAspect()));
    sliders.focal_length.write(Math.min(Math.max(focal, Number(focalInput.min)), Number(focalInput.max)));
    showFov(); // 焦点距離を丸めた分だけ画角も変わるので、実際の値を出す
    onGraphicsChange(readGraphics());
    syncResetButtons();
  });
  fovSlider.input.addEventListener('change', commitGraphics);
  window.addEventListener('resize', () => {
    if (dialog.open) showFov();
  });

  function readGraphics(): GraphicsSettings {
    const graphics = {} as GraphicsSettings;
    for (const key of keysOf(selects)) graphics[key] = Number(selects[key].value);
    for (const key of keysOf(toggles)) graphics[key] = toggles[key].checked;
    for (const key of keysOf(sliders)) graphics[key] = sliders[key].read();
    graphics.ui_font = choices.ui_font.value as UiFont;
    graphics.cruise_mode = choices.cruise_mode.value as CruiseMode;
    return graphics;
  }

  // チェックを外すと (3 番目が true のものは、チェックを入れると) 効かなくなるスライダーは、押せないようにする
  const dependentSliders: Array<[HTMLInputElement, HTMLInputElement, boolean?]> = [
    [toggles.bloom, sliders.region_bloom.input],
    [toggles.region_relief, sliders.terrain_shading.input, true], // 焼き込まれた陰影と二重にしない
  ];

  function syncDependentSliders(): void {
    for (const [toggle, slider, whenUnchecked] of dependentSliders) slider.disabled = whenUnchecked ? toggle.checked : !toggle.checked;
  }
  for (const [toggle] of dependentSliders) toggle.addEventListener('change', syncDependentSliders);

  function showGraphics(graphics: GraphicsSettings): void {
    for (const key of keysOf(selects)) selects[key].value = String(graphics[key]);
    for (const key of keysOf(toggles)) toggles[key].checked = graphics[key];
    for (const key of keysOf(sliders)) sliders[key].write(graphics[key]);
    for (const key of keysOf(choices)) choices[key].value = graphics[key];
    syncDependentSliders();
    showFov();
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
    ...Object.values(choices),
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
      button.disabled =
        !graphicsDefaults ||
        current[key] === graphicsDefaults[key] ||
        Math.abs(Number(current[key]) - Number(graphicsDefaults[key])) < 1e-6;
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
