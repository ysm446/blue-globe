"""runtime/llama.cpp の llama-server を必要なときだけ起動して使う。

要約が必要な文は少なく、結果もキャッシュするので、一定時間使わなければ止めて VRAM を返す。
他のアプリが起動した llama-server には触れないよう、空きポートで自前のプロセスだけを管理する。
"""
import re
import socket
import subprocess
import threading
import time
from pathlib import Path

import httpx

from .config import LLAMA_SERVER, LOG_DIR

IDLE_SECONDS = 300
START_TIMEOUT_SECONDS = 180
CHAT_TIMEOUT_SECONDS = 60
EXCLUDED_NAME_PARTS = ("mmproj", "embedding", "embed-")
SHARD_RE = re.compile(r"-(\d{5})-of-\d{5}\.gguf$", re.IGNORECASE)


class LlmError(Exception):
    pass


def list_models(models_dir: str) -> list[dict]:
    """フォルダ内の GGUF のうち、チャットに使えるものを返す。"""
    root = Path(models_dir)
    if not root.is_dir():
        raise LlmError(f"モデルフォルダが見つかりません: {models_dir}")
    models = []
    for path in root.rglob("*.gguf"):
        name = path.name.lower()
        if any(part in name for part in EXCLUDED_NAME_PARTS):
            continue
        shard = SHARD_RE.search(path.name)
        if shard and int(shard.group(1)) != 1:
            continue
        models.append(
            {
                "path": str(path.relative_to(root)),
                "name": path.stem,
                "size_gb": round(path.stat().st_size / 2**30, 1),
            }
        )
    return sorted(models, key=lambda m: m["path"].lower())


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class LlamaServer:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._process: subprocess.Popen | None = None
        self._model: Path | None = None
        self._port = 0
        self._idle_timer: threading.Timer | None = None

    def chat(self, model: Path, system: str, user: str) -> str:
        with self._lock:
            self._cancel_idle_timer()
            self._ensure_started(model)
            try:
                response = httpx.post(
                    f"http://127.0.0.1:{self._port}/v1/chat/completions",
                    json={
                        "temperature": 0,
                        "max_tokens": 600,
                        "chat_template_kwargs": {"enable_thinking": False},
                        "messages": [
                            {"role": "system", "content": system},
                            {"role": "user", "content": user},
                        ],
                    },
                    timeout=CHAT_TIMEOUT_SECONDS,
                )
                response.raise_for_status()
                return (response.json()["choices"][0]["message"].get("content") or "").strip()
            except (httpx.HTTPError, KeyError, IndexError, ValueError) as e:
                raise LlmError(f"LLM の応答を取得できませんでした: {e}") from e
            finally:
                self._idle_timer = threading.Timer(IDLE_SECONDS, self.stop)
                self._idle_timer.daemon = True
                self._idle_timer.start()

    def stop(self) -> None:
        with self._lock:
            self._cancel_idle_timer()
            self._stop_process()

    def _cancel_idle_timer(self) -> None:
        if self._idle_timer:
            self._idle_timer.cancel()
            self._idle_timer = None

    def _stop_process(self) -> None:
        if self._process is None:
            return
        self._process.terminate()
        try:
            self._process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self._process.kill()
            self._process.wait(timeout=10)
        self._process = None
        self._model = None

    def _ensure_started(self, model: Path) -> None:
        if self._process and self._process.poll() is None and self._model == model:
            return
        self._stop_process()
        if not LLAMA_SERVER.exists():
            raise LlmError(f"llama-server が見つかりません: {LLAMA_SERVER}")
        if not model.is_file():
            raise LlmError(f"モデルが見つかりません: {model}")

        LOG_DIR.mkdir(parents=True, exist_ok=True)
        port = _free_port()
        with open(LOG_DIR / "llama-server.log", "wb") as log:
            process = subprocess.Popen(
                [
                    str(LLAMA_SERVER),
                    "-m", str(model),
                    "--host", "127.0.0.1",
                    "--port", str(port),
                    "-ngl", "99",
                    "-c", "4096",
                    "-np", "1",
                    "--jinja",
                ],
                stdout=log,
                stderr=subprocess.STDOUT,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
        self._process, self._model, self._port = process, model, port
        self._wait_until_ready()

    def _wait_until_ready(self) -> None:
        deadline = time.monotonic() + START_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            if self._process.poll() is not None:
                self._process = None
                raise LlmError("llama-server が起動直後に終了しました。data/logs/llama-server.log を確認してください")
            try:
                if httpx.get(f"http://127.0.0.1:{self._port}/health", timeout=2).status_code == 200:
                    return
            except httpx.HTTPError:
                pass
            time.sleep(0.25)
        self._stop_process()
        raise LlmError("llama-server の起動がタイムアウトしました")
