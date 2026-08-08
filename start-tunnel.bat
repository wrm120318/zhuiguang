@echo off
chcp 65001 >nul
title 追光平台 - Cloudflare Tunnel
cd /d "%~dp0"
where cloudflared >nul 2>&1
if errorlevel 1 (
  if exist cloudflared.exe (
    echo 使用本目录的 cloudflared.exe
    goto :run
  )
  echo [错误] 未检测到 cloudflared
  echo 请下载 cloudflared.exe 放到本目录:
  echo https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
  echo 下载后重命名为 cloudflared.exe 放在此文件夹
  pause
  exit /b 1
)
:run
echo.
echo ========================================
echo   正在连接 Cloudflare Tunnel...
echo   连接成功后访问: https://xkzg.dpdns.org
echo   请保持此窗口打开
echo ========================================
echo.
cloudflared tunnel --no-autoupdate --protocol http2 run --token eyJhIjoiODNhMGJmNWE1ZmVjOGJjOGM1MmM1ZGUxOTk1YzdkNTgiLCJ0IjoiMTQxNzgwYmEtNDdiMS00MDBmLWExNWItYTczZDkyN2FkNmNhIiwicyI6Ik9HRTBZMkk1TWpZdE5tVXlNeTAwTWpVekxXSTRORGN0WldNNFpHRmxOakJrWmpKa01HVmhZbUZrWVdVdE1HSmxNUzAwWXpaaExUa3dOelV0WkRVeU1EZzJORE14WWprMSJ9
pause
