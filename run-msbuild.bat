@echo off
D:\Luna\pipeline\templates\LunaCompiler\.msbuild\MSBuild.exe D:\Luna\pipeline\templates\LunaCompiler\Scripts\Scripts.csproj /t:Rebuild /p:Configuration=Release 2>&1 | findstr /i "error CS"
