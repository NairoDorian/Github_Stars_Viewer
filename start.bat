@echo off
rem Starts the Stars Viewer server and opens it in your browser. Keep this window open while using the app.
cd /d "%~dp0"
node server.js --open
if errorlevel 1 pause
