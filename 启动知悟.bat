@echo off
chcp 65001 >nul
title 知悟 — 个人 AI 学习平台
cd /d "%~dp0"

if not exist "client\dist\index.html" (
  echo 首次启动，正在构建前端界面...
  call npm run build
)

echo.
echo ====================================================
echo   正在启动「知悟」个人 AI 学习平台...
echo   桌面端与安卓手机端共用端口 3001
echo   请保持本窗口运行，关闭窗口即停止服务
echo ====================================================
echo.

start "" http://localhost:3001
npm run start
pause
