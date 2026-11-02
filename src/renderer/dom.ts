// 画面の部品で共有する小さな関数
export function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

export function errorMessage(err: unknown): string {
  // ipcRenderer.invoke は "Error invoking remote method 'x': Error: 本文" の形で返す
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function setStatus(target: HTMLElement, message: string, isError = false): void {
  target.textContent = message;
  target.classList.toggle('error', isError);
}

// timeZone を省くとパソコンのタイムゾーンで表す
export function formatDateTime(date: Date, timeZone?: string): string {
  return date.toLocaleString('ja-JP', {
    timeZone,
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
