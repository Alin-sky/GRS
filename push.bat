@echo off
title GRS Git Sync
cd /d "%~dp0"

echo ========================================
echo   GRS Git Sync - Pull and Push
echo ========================================
echo.

echo [1/3] Fetching remote updates...
git fetch origin
if %errorlevel% neq 0 goto :error
echo [OK] Fetch complete
echo.

echo [2/3] Merging remote changes...
git merge origin/main --no-edit --ff-only
if %errorlevel% neq 0 goto :error
echo [OK] Merge complete
echo.

echo [3/3] Pushing to GitHub...
git push origin main
if %errorlevel% neq 0 goto :error
echo [OK] Push complete

echo.
echo ========================================
echo   [OK] All done!
echo ========================================
pause
exit /b 0

:error
echo.
echo ========================================
echo   [FAIL] Operation failed
echo ========================================
pause
exit /b 1
