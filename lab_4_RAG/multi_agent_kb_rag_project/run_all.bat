@echo off
REM Run create tables, load data, and embeddings in order. Run from project root.
cd /d "%~dp0"
node .\02_backend\scripts\create_tables.js || goto :err
node .\02_backend\scripts\load_data.js || goto :err
node .\02_backend\scripts\SQL_embeddings.js || goto :err
echo All steps completed successfully
goto :eof
:err
echo ERROR occurred. Check logs above.
pause
