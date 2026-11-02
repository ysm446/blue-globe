// 音源のシークで届く Range ヘッダーの解釈。1 区間だけ受け付け、それ以外は null (ファイル全体を返す)
export interface ByteRange {
  start: number;
  end: number; // この位置を含む
}

export function parseByteRange(header: string | null, size: number): ByteRange | null {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || size <= 0) return null;
  const [, first, last] = match;
  if (first === '') {
    if (last === '') return null;
    const length = Number(last); // bytes=-500 は末尾の 500 バイト
    return length > 0 ? { start: Math.max(size - length, 0), end: size - 1 } : null;
  }
  const start = Number(first);
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  return start <= end ? { start, end } : null;
}
