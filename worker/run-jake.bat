@echo off
cd /D D:\work\test-luna
echo [%date% %time%] Starting jake... > D:\worker-repo\worker\jake-output.log
node D:\Luna\pipeline\jake.js -f D:\Luna\pipeline\Jakefile.js develop --trace >> D:\worker-repo\worker\jake-output.log 2>&1
echo [%date% %time%] Jake exit code: %errorlevel% >> D:\worker-repo\worker\jake-output.log
if exist D:\work\test-luna\LunaTemp\stage4\develop\iframe.html (
  echo [%date% %time%] iframe.html EXISTS >> D:\worker-repo\worker\jake-output.log
  copy D:\work\test-luna\LunaTemp\stage4\develop\iframe.html D:\work\test-luna\LunaTemp\stage1\iframe-cache.html
  echo [%date% %time%] Cached iframe.html to stage1 >> D:\worker-repo\worker\jake-output.log
) else (
  echo [%date% %time%] iframe.html NOT FOUND >> D:\worker-repo\worker\jake-output.log
)
