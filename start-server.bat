@echo off
title ArcadeNexus Multiplayer Platform
cls
echo ========================================================
echo  ArcadeNexus Multiplayer Platform
echo  Local Co-Op Streaming & Virtual Joystick Relay
echo ========================================================
echo.
cd /d "%~dp0"
node server.js
pause

