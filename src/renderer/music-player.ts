// 右上の音符のアイコンとポップアップ。設定画面で選んだ音源をループで再生する。起動しただけでは鳴らさない
import { el, setStatus } from './dom';

const AUDIO_URL = 'weather-audio://current/'; // どの URL でも、設定で選んだ音源が返る
const PLAY_FAILED = '音源を再生できません。ファイルが移動や削除されていないか確かめてください。';

export function audioFileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

export function initMusicPlayer(openSettings: () => void) {
  const toggle = el<HTMLButtonElement>('music-toggle');
  const popup = el('music-popup');
  const setup = el<HTMLButtonElement>('music-setup');
  const controls = el('music-controls');
  const playButton = el<HTMLButtonElement>('music-play');
  const volume = el<HTMLInputElement>('music-volume');
  const volumeValue = el('music-volume-value');
  const status = el('music-status');

  const audio = new Audio();
  audio.loop = true;
  audio.preload = 'none';
  window.__weatherNewsDebug.music = audio;
  let file: string | null = null;
  let loads = 0;

  function setOpen(open: boolean): void {
    popup.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  }

  toggle.addEventListener('click', () => setOpen(popup.hidden));
  window.addEventListener(
    'pointerdown',
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest('#music-toggle, #music-popup')) setOpen(false);
    },
    true,
  );
  for (const element of [toggle, popup]) {
    element.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || popup.hidden) return;
      setOpen(false);
      toggle.focus();
    });
  }
  setup.addEventListener('click', () => {
    setOpen(false);
    openSettings();
  });

  function syncPlaying(): void {
    const playing = !audio.paused;
    toggle.classList.toggle('playing', playing);
    playButton.classList.toggle('playing', playing);
    const label = playing ? '一時停止' : '再生';
    playButton.setAttribute('aria-label', label);
    playButton.title = label;
  }
  audio.addEventListener('play', syncPlaying);
  audio.addEventListener('pause', syncPlaying);
  audio.addEventListener('error', () => {
    if (file) setStatus(status, PLAY_FAILED, true);
    audio.pause(); // 読めなくても、再生の指示が残ったままになる
    syncPlaying();
  });

  async function play(): Promise<void> {
    setStatus(status, '');
    if (audio.error) audio.load(); // ファイルを戻したあとに押し直せるようにする
    try {
      await audio.play();
    } catch (err) {
      // 再生の直後に止めると AbortError になる。読めないときの知らせは error のイベントでも出す
      if (!(err instanceof DOMException && err.name === 'AbortError')) setStatus(status, PLAY_FAILED, true);
    }
  }

  playButton.addEventListener('click', () => {
    if (audio.paused) void play();
    else audio.pause();
  });

  function showVolume(): void {
    const position = Number(volume.value) / 100;
    audio.volume = position * position; // 耳の感じ方に合わせ、小さい音量の側を細かく変えられるようにする
    volumeValue.textContent = `${volume.value}%`;
    volume.style.setProperty('--fill', `${volume.value}%`);
  }
  let saving: Promise<unknown> = Promise.resolve();
  volume.addEventListener('input', showVolume);
  volume.addEventListener('change', () => {
    const value = Number(volume.value) / 100;
    saving = saving
      .then(() => window.weatherApi.setAudioVolume(value))
      .catch((err) => console.error('audio volume save failed', err));
  });

  function setFile(next: string | null): void {
    const playing = !audio.paused;
    file = next;
    setStatus(status, '');
    setup.hidden = file !== null;
    controls.hidden = file === null;
    el('music-name').textContent = file ? audioFileName(file) : '';
    audio.pause();
    if (file) {
      audio.src = `${AUDIO_URL}${++loads}`; // 同じ URL だと前の音源が残る
      if (playing) void play();
    } else {
      audio.removeAttribute('src');
      audio.load();
    }
    syncPlaying();
  }

  return {
    apply(settings: AppSettings): void {
      volume.value = String(Math.round((settings.audio_volume ?? 0.5) * 100));
      showVolume();
      const next = settings.audio_file ?? null;
      if (next !== file) setFile(next);
    },
  };
}
