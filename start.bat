@echo off
setlocal
cd /d "%~dp0"

rem Clear leftover env var (set when launched from VSCode etc.)
set ELECTRON_RUN_AS_NODE=

if not exist .venv\Scripts\python.exe (
    echo [start] .venv not found. Creating it...
    py -3.13 -m venv .venv
    if errorlevel 1 goto :error
    .venv\Scripts\python -m pip install -r server\requirements.txt
    if errorlevel 1 goto :error
)

if not exist node_modules (
    echo [start] node_modules not found. Running npm install...
    call npm install
    if errorlevel 1 goto :error
)

if not exist dist\main.js (
    echo [start] Build output not found. Running npm run build...
    call npm run build
    if errorlevel 1 goto :error
)

call npm start
if errorlevel 1 goto :error
exit /b 0

:error
echo.
echo [start] An error occurred.
pause
exit /b 1
