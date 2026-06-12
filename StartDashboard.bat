@echo off
title LocalShareX Control Dashboard
echo.
echo =======================================================
echo   LocalShareX Control Dashboard
echo =======================================================
echo.
echo  Starting control server...
echo  Please keep this window open while using the application.
echo.
node dashboard.js
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Failed to start dashboard. Make sure Node.js is installed.
    echo.
    pause
)
