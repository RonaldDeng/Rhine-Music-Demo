@echo off
rem Rhine Music Demo - Windows launcher. Double-click to start the local player.
rem Keep this file ASCII-friendly: paths with spaces, parentheses or Chinese characters are expanded only on single lines.
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if errorlevel 1 exit /b 1

set "NODE_EXE="
if exist "%~dp0runtime\node.exe" set "NODE_EXE=%~dp0runtime\node.exe"
if not defined NODE_EXE for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE_EXE=%LocalAppData%\Programs\nodejs\node.exe"

if defined NODE_EXE goto run
echo.
echo 没有找到 Node.js。请先安装 Node.js 22.12 或更新的 LTS 版本，再双击此文件。
echo 下载地址：https://nodejs.org/
echo.
pause
exit /b 1

:run
"%NODE_EXE%" scripts\launch-music.mjs
set "LAUNCHER_STATUS=%ERRORLEVEL%"
if "%LAUNCHER_STATUS%"=="0" exit /b 0
echo.
echo 启动未完成。请保留上面的错误信息。
pause
exit /b %LAUNCHER_STATUS%
