@echo off
rem Opens START.html in Chrome or Edge as an app window.
rem (Web Serial, which talks to the Arduino, only works in Chrome/Edge.)
set "PAGE=%~dp0START.html"
set "URL=file:///%PAGE:\=/%"
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if exist "%CHROME%" (
  start "" "%CHROME%" --app="%URL%" --start-maximized
) else (
  start "" msedge --app="%URL%" --start-maximized
)
