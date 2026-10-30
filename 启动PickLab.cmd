@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo 未找到 Node.js。请先安装 Node.js 20 或更新版本，然后重新双击此文件。
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 (
  echo Node.js 版本过旧。请安装 Node.js 20 或更新版本。
  pause
  exit /b 1
)
echo 正在启动 PickLab。浏览器会自动打开；关闭此窗口即可停止服务。
if not defined PICKLAB_OPEN_BROWSER set "PICKLAB_OPEN_BROWSER=1"
node server.js
echo.
echo PickLab 已停止。如果上方显示错误，请检查后重试。
pause
