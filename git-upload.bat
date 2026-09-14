@echo off
title GRS Git Upload
cd /d "%~dp0"
REM ============================================================
REM  git-upload.bat - one-click upload to GitHub
REM  ASCII-only + CRLF on purpose (see scripts\ensure-node.bat header).
REM ============================================================

echo ========================================
echo   GRS Git Upload - push to GitHub
echo ========================================
echo.

echo [1/4] Staging changes...
git add -A -- ":!nul"
if errorlevel 1 goto :error
echo [OK] Staged
echo.

echo [2/4] Sensitive file check...
git diff --cached --name-only | findstr /i /c:"config" /c:"sensitive_words" /c:".env" >nul
if errorlevel 1 goto :nosensitive
echo.
echo [WARN] Sensitive files are staged:
echo   config\default.json / sensitive_words.json / .env
echo   These may contain API keys, passwords or word lists.
echo   Please check .gitignore before continuing.
echo   You may ignore this warning if it is a false positive.
echo.
:nosensitive

git diff --cached --quiet
if not errorlevel 1 goto :nocommit

echo [3/4] Committing...
git commit -m "sync: %date% %time%"
if errorlevel 1 goto :error
echo [OK] Committed
echo.

echo [4/4] Pushing to GitHub...
git push origin main
if errorlevel 1 goto :pushfail
goto :pushdone

:pushfail
echo.
echo [WARN] Normal push failed. Common causes:
echo   1. No network - check your proxy (can the browser open github.com?)
echo   2. Remote history diverged from local (first sync, or remote changed)
echo.
set "FORCE="
set /p FORCE=Force push to overwrite remote? Type y to confirm, Enter to skip:
if /i not "%FORCE%"=="y" goto :error
echo.
echo Force pushing (local state wins)...
git push -f origin main
if errorlevel 1 goto :error

:pushdone
echo [OK] Pushed

echo.
echo ========================================
echo   [OK] Done. Uploaded to GitHub.
echo ========================================
echo.
exit /b 0

:nocommit
echo.
echo   Nothing to commit.
echo   To pull remote updates: git pull origin main
echo.
exit /b 0

:error
echo.
echo ========================================
echo   [FAIL] Operation failed. See the errors above.
echo ========================================
echo.
exit /b 1
