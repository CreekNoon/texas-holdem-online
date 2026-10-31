@echo off
REM 启动德州扑克服务器
REM 如果已安装 Node.js 并加入 PATH，直接用: node server.js
REM 否则使用便携版 Node.js
set "NODE=C:\Users\Ray\AppData\Local\Temp\node-v20.18.1-win-x64\node.exe"
if exist "%NODE%" (
    "%NODE%" "%~dp0server.js"
) else (
    node "%~dp0server.js"
)
pause
