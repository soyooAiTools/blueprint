@echo off
"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe" "D:\Luna\pipeline\templates\LunaCompiler\Scripts\Scripts.csproj" /t:Rebuild /v:minimal 2>&1
echo EXIT_CODE=%ERRORLEVEL%
