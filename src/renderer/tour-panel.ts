// 右上のツアーのパネル。保存したツアーの一覧から再生と削除ができ、再生中のツアーを名前を付けて保存できる
import { el, errorMessage } from './dom';
import type { TourPlayer } from './tour';
import { defaultTourTitle, newTourId, TOUR_TITLE_MAX } from './tour-library';

const DELETE_CONFIRM_MS = 3000; // ゴミ箱を 1 回押してから、もう 1 回押せば消える間
const STATUS_MS = 4000;

const PLAY_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg>';
const STOP_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect fill="currentColor" x="6" y="6" width="12" height="12" rx="1.5"/></svg>';
const TRASH_ICON =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';

export interface TourPanel {
  // 再生中のツアーを保存する (MCP の play_tour の save から)。名前を省くとツアーの名前か既定の名前
  saveCurrent(title?: string): Promise<SavedTour>;
}

export function initTourPanel(player: TourPlayer): TourPanel {
  const list = el<HTMLUListElement>('tour-list');
  const empty = el('tour-empty');
  const form = el<HTMLFormElement>('tour-save');
  const titleInput = el<HTMLInputElement>('tour-save-title');
  const status = el('tour-status');
  titleInput.maxLength = TOUR_TITLE_MAX;

  let tours: SavedTour[] = [];
  let pendingDelete: { id: string; timer: number } | null = null;
  let statusTimer = 0;
  let formFor: unknown = null; // 名前の欄に既定の名前を入れたツアー (別のツアーが始まったら入れ直す)
  let saving: Promise<unknown> = Promise.resolve(); // 保存と削除は順番に行う

  function showStatus(text: string, warn = false): void {
    status.textContent = text;
    status.classList.toggle('warn', warn);
    window.clearTimeout(statusTimer);
    if (text) statusTimer = window.setTimeout(() => showStatus(''), STATUS_MS);
  }

  function render(): void {
    const playing = player.current;
    list.replaceChildren(
      ...tours.map((tour) => {
        const item = document.createElement('li');
        item.className = 'tour-item';
        const isPlaying = playing?.savedId === tour.id;
        if (isPlaying) item.setAttribute('aria-current', 'true');

        const play = document.createElement('button');
        play.type = 'button';
        play.className = 'tour-play';
        play.title = isPlaying ? 'ツアーを終える' : 'ツアーを再生';
        play.innerHTML = isPlaying ? STOP_ICON : PLAY_ICON;
        const name = document.createElement('span');
        name.className = 'tour-name';
        name.textContent = tour.title;
        const count = document.createElement('span');
        count.className = 'tour-count';
        count.textContent = `${tour.scenes.length} 場面`;
        play.append(name, count);
        play.addEventListener('click', () => {
          play.blur(); // フォーカスが残ると、Esc や WASD が効かないことがある
          if (isPlaying) player.stop();
          else player.start(tour.scenes, { title: tour.title, savedId: tour.id });
        });

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'tour-delete';
        const confirming = pendingDelete?.id === tour.id;
        remove.classList.toggle('confirm', confirming);
        remove.title = confirming ? 'もう一度押すと削除します' : '削除';
        remove.setAttribute('aria-label', `${tour.title}を削除`);
        remove.innerHTML = TRASH_ICON;
        remove.addEventListener('click', () => {
          remove.blur();
          onDelete(tour);
        });

        item.append(play, remove);
        return item;
      }),
    );
    // 保存していないツアーを再生している間だけ、名前の欄と保存のボタンを出す (そのときは空の案内は要らない)
    const unsaved = playing !== null && playing.savedId === null;
    empty.hidden = tours.length > 0 || unsaved;
    if (unsaved && formFor !== playing.scenes) titleInput.value = defaultTourTitle(playing.title, playing.scenes);
    formFor = unsaved ? playing.scenes : null;
    form.hidden = !unsaved;
  }

  // 誤って消さないよう、1 回目は印を変えるだけにして、続けてもう 1 回押したら消す
  function onDelete(tour: SavedTour): void {
    if (pendingDelete?.id !== tour.id) {
      if (pendingDelete) window.clearTimeout(pendingDelete.timer);
      pendingDelete = {
        id: tour.id,
        timer: window.setTimeout(() => {
          pendingDelete = null;
          render();
        }, DELETE_CONFIRM_MS),
      };
      render();
      return;
    }
    window.clearTimeout(pendingDelete.timer);
    pendingDelete = null;
    if (player.current?.savedId === tour.id) player.stop();
    tours = tours.filter((t) => t.id !== tour.id);
    render();
    saving = saving
      .then(() => window.weatherApi.deleteTour(tour.id))
      .then((saved) => {
        tours = saved;
        render();
        showStatus(`「${tour.title}」を削除しました`);
      })
      .catch((err) => {
        console.error('tour delete failed', err);
        showStatus(`削除できませんでした: ${errorMessage(err)}`, true);
        void reload();
      });
  }

  async function saveCurrent(title?: string): Promise<SavedTour> {
    const playing = player.current;
    if (!playing) throw new Error('再生中のツアーがありません');
    const tour: SavedTour = {
      id: playing.savedId ?? newTourId(),
      title: defaultTourTitle(title ?? playing.title, playing.scenes),
      scenes: playing.scenes,
      saved_at: new Date().toISOString(),
    };
    const done = saving.then(() => window.weatherApi.saveTour(tour));
    saving = done.catch(() => undefined);
    tours = await done;
    player.markSaved(tour.id, tour.title);
    render();
    showStatus(`「${tour.title}」を保存しました`);
    return tour;
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    titleInput.blur();
    saveCurrent(titleInput.value).catch((err) => {
      console.error('tour save failed', err);
      showStatus(`保存できませんでした: ${errorMessage(err)}`, true);
    });
  });

  async function reload(): Promise<void> {
    try {
      tours = await window.weatherApi.listTours();
    } catch (err) {
      console.error('tour list failed', err);
      showStatus('保存したツアーを読み込めませんでした', true);
    }
    render();
  }

  player.onChange(render);
  void reload();
  return { saveCurrent };
}
