@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js 18 ou superior nao encontrado.
  echo     Instale em https://nodejs.org/ e tente novamente.
  exit /b 1
)
node "%~dp0wheels.mjs" %*
exit /b %errorlevel%
