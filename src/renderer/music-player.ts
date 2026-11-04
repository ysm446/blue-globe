// 右上の音楽のボタン。押すと再生と停止が切り替わり、アイコンも変わる (止まっているときは音符、鳴っているときはスピーカー)。
// ボタンにカーソルを合わせる (キーボードではフォーカスする) と、下に縦の音量バーが出る。
// 設定画面で選んだ音源をループで再生する。起動しただけでは鳴らさない
import { el, setStatus } from './dom';

const AUDIO_URL = 'weather-audio://current/'; // どの URL でも、設定で選んだ音源が返る
const PLAY_FAILED = '音源を再生できません。ファイルが移動や削除されていないか確かめてください。';
const HIDE_DELAY_MS = 250; // ボタンから音量バーへカーソルを移す間に消えないようにする
const ERROR_SHOW_MS = 4000; // カーソルが乗っていないときに、再生できない知らせを見せておく時間
const POPUP_GAP = 6; // ボタンと音量バーの間 (px)

export function audioFileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

export function initMusicPlayer(openSettings: () => void) {
  const toggle = el<HTMLButtonElement>('music-toggle');
  const popup = el('music-popup');
  const volume = el<HTMLInputElement>('music-volume');
  const status = el('music-status');

  const audio = new Audio();
  audio.loop = true;
  audio.preload = 'none';
  window.__weatherNewsDebug.music = audio;
  let file: string | null = null;
  let loads = 0;
  let hideTimer = 0;

  // 音源を選んでいないときは、出しても動かすものがないので出さない
  function showPopup(): void {
    window.clearTimeout(hideTimer);
    if (!file && !status.textContent) return;
    popup.hidden = false;
    const button = toggle.getBoundingClientRect();
    popup.style.top = `${button.bottom + POPUP_GAP}px`;
    // 知らせで広がったときも画面の右端からはみ出さないようにする
    const left = Math.min(button.left + button.width / 2 - popup.offsetWidth / 2, window.innerWidth - popup.offsetWidth - 8);
    popup.style.left = `${left}px`;
  }

  function hidePopupSoon(delay = HIDE_DELAY_MS): void {
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      // カーソルが乗っている間と、キーボードで操作している間は出したままにする。
      // マウスで押したボタンにフォーカスが残っても、離れたら消す
      if (toggle.matches(':hover') || popup.matches(':hover')) return;
      const focused = document.activeElement;
      const usingKeyboard = focused?.matches(':focus-visible') && (focused === toggle || popup.contains(focused));
      if (usingKeyboard) return;
      popup.hidden = true;
      setStatus(status, ''); // 知らせは一度見せたら消す
    }, HIDE_DELAY_MS);
  }

  for (const element of [toggle, popup]) {
    element.addEventListener('pointerenter', showPopup);
    element.addEventListener('pointerleave', () => hidePopupSoon());
    element.addEventListener('focusin', showPopup);
    element.addEventListener('focusout', () => hidePopupSoon());
    element.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || popup.hidden) return;
      popup.hidden = true;
      toggle.focus();
    });
  }

  function syncPlaying(): void {
    const playing = !audio.paused;
    toggle.classList.toggle('playing', playing);
    toggle.setAttribute('aria-pressed', String(playing));
    const label = !file ? '音楽 (設定で音源を選ぶ)' : `${playing ? '音楽を止める' : '音楽を再生'}: ${audioFileName(file)}`;
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
  }
  audio.addEventListener('play', syncPlaying);
  audio.addEventListener('pause', syncPlaying);
  audio.addEventListener('error', () => {
    if (file) showError();
    audio.pause(); // 読めなくても、再生の指示が残ったままになる
    syncPlaying();
  });

  // 知らせは音量バーの下に出す。カーソルが離れると消える
  function showError(): void {
    setStatus(status, PLAY_FAILED, true);
    showPopup();
    hidePopupSoon(ERROR_SHOW_MS);
  }

  async function play(): Promise<void> {
    setStatus(status, '');
    if (audio.error) audio.load(); // ファイルを戻したあとに押し直せるようにする
    try {
      await audio.play();
    } catch (err) {
      // 再生の直後に止めると AbortError になる。読めないときの知らせは error のイベントでも出す
      if (!(err instanceof DOMException && err.name === 'AbortError')) showError();
    }
  }

  toggle.addEventListener('click', () => {
    if (!file) openSettings();
    else if (audio.paused) void play();
    else audio.pause();
  });

  function showVolume(): void {
    const position = Number(volume.value) / 100;
    audio.volume = position * position; // 耳の感じ方に合わせ、小さい音量の側を細かく変えられるようにする
    volume.setAttribute('aria-valuetext', `${volume.value}%`);
    volume.title = `音量 ${volume.value}%`;
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
    if (!file) popup.hidden = true;
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
