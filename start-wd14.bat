@echo off
cd /d "%~dp0"
echo ==========================================
echo   WD14 Tagger Service (anime image tagging)
echo   Port: 9898
echo ==========================================
echo.
"<Python虚拟环境>\Scripts\python.exe" wd14\wd14_service.py
pause
