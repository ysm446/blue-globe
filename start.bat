@echo off
setlocal
cd /d "%~dp0"

rem Clear leftover env var (set when launched from VSCode etc.)
set ELECTRON_RUN_AS_NODE=

if not exist .venv\Scripts\python.exe (
    echo [start] .venv not found. Creating it...
    call :create_venv
    if errorlevel 1 goto :error
)

rem Packages are installed separately, so an interrupted first run is completed on the next run
if not exist .venv\Scripts\uvicorn.exe (
    echo [start] Python packages not found. Installing...
    .venv\Scripts\python -m pip install -r server\requirements.txt
    if errorlevel 1 goto :error
)

rem 依存の追加後やインストールが途中で止まった場合も、不足を補う
set "dependencies_updated="
call npm ls --depth=0 >nul 2>&1
if errorlevel 1 (
    echo [start] Node packages are missing or outdated. Running npm install...
    call npm install
    if errorlevel 1 goto :error
    set "dependencies_updated=1"
)

rem Rebuild when the build output is missing or older than the source (e.g. after git pull)
if defined dependencies_updated goto :build
node scripts\needs-build.mjs
if not errorlevel 1 goto :start

:build
echo [start] Running npm run build...
call npm run build
if errorlevel 1 goto :error

:start
call npm start
if errorlevel 1 goto :error
exit /b 0

:error
echo.
echo [start] An error occurred.
pause
exit /b 1

rem Prefer Python 3.13 (the version the app is developed with), then any Python 3 via the launcher, then python on PATH
:create_venv
py -3.13 -m venv .venv 2>nul && exit /b 0
py -3 -m venv .venv 2>nul && exit /b 0
python -m venv .venv && exit /b 0
echo [start] Python 3 was not found. Install Python 3.13 from https://www.python.org/ and run again.
exit /b 1
