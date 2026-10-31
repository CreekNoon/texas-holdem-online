@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM ===== 配置 =====
set "APP_DIR=%~dp0"
set "PORT=3000"

REM Node.js 路径（便携版）
set "NODE_EXE=C:\Users\Ray\AppData\Local\Temp\node-v20.18.1-win-x64\node.exe"
if not exist "%NODE_EXE%" (
    REM 尝试系统 node
    where node >nul 2>nul
    if %errorlevel%==0 (
        set "NODE_EXE=node"
    ) else (
        echo [错误] 未找到 Node.js，请先安装或修改脚本中的 NODE_EXE 路径
        pause
        exit /b 1
    )
)

REM cpolar 路径
set "CPOLAR_EXE=%APP_DIR%tools\cpolar.exe"
set "CPOLAR_CONFIG=%APP_DIR%.cpolar\cpolar.yml"
if not exist "%CPOLAR_EXE%" (
    echo [错误] 未找到 cpolar.exe，请确认 tools\cpolar.exe 存在
    pause
    exit /b 1
)

echo ============================================
echo    德州扑克 · 公网联机启动
echo ============================================
echo.

REM 检查是否已配置 authtoken
if not exist "%CPOLAR_CONFIG%" (
    echo [首次使用] 需要配置 cpolar 认证令牌
    echo.
    echo 请按以下步骤获取 authtoken:
    echo   1. 访问 https://dashboard.cpolar.com/signup 注册账号
    echo   2. 登录后访问 https://dashboard.cpolar.com/auth
    echo   3. 复制你的 Authtoken
    echo.
    set /p AUTHTOKEN=请粘贴你的 cpolar Authtoken: 
    if "!AUTHTOKEN!"=="" (
        echo [错误] 未输入令牌
        pause
        exit /b 1
    )
    echo 正在保存令牌...
    "%CPOLAR_EXE%" authtoken !AUTHTOKEN! -config="%CPOLAR_CONFIG%"
    if errorlevel 1 (
        echo [错误] 令牌保存失败
        pause
        exit /b 1
    )
    echo 令牌保存成功！
    echo.
)

REM 启动扑克服务器
echo [1/2] 启动扑克服务器 (端口 %PORT%)...
start "PokerServer" /min "%NODE_EXE%" "%APP_DIR%server.js"
timeout /t 2 /nobreak >nul

REM 检查服务器是否启动
netstat -ano | findstr ":%PORT%" | findstr "LISTENING" >nul
if errorlevel 1 (
    echo [警告] 服务器可能未成功启动，请检查端口是否被占用
) else (
    echo       服务器已启动: http://localhost:%PORT%
)

REM 启动 cpolar 隧道
echo.
echo [2/2] 启动 cpolar 内网穿透...
echo       正在连接 cpolar 服务器，请稍候...
echo.
echo ============================================
echo   公网地址将在下方显示（https://xxxx.vip.cpolar.cn）
echo   将该地址分享给朋友即可联机游戏
echo ============================================
echo.
"%CPOLAR_EXE%" http %PORT% -config="%CPOLAR_CONFIG%" -region=cn_vip

echo.
echo 隧道已关闭。
pause
