@echo off
chcp 65001 >nul
title 追光平台 - 网站服务
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo [错误] 未检测到 Node.js
  echo 请先安装 Node.js 20 以上版本: https://nodejs.org/
  pause
  exit /b 1
)
if not exist node_modules (
  echo 首次运行，正在安装依赖约1分钟...
  call npm install --registry=https://registry.npmmirror.com
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重试
    pause
    exit /b 1
  )
)
echo.
echo ========================================
echo   网站启动成功
echo   本地访问: http://localhost:3001
echo   超管账号: admin / admin123456
echo   请保持此窗口打开, 然后双击 start-tunnel.bat
echo ========================================
echo.
npm run start
pause
