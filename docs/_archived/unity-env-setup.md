# Unity + Luna Worker 环境配置指南

> 在新 Windows Server 上部署完整的 Luna 构建 Worker 环境
> 最后验证: 2026-02-18, Worker 42.121.160.107, E2E 全流程通过

---

## 0. 架构概览

```
[Blueprint Editor (ECS)]
  │  创建项目 → 编辑蓝图 → 提交任务
  │
  ▼  /api/worker/poll
[Worker (Windows Server)]
  ├── 1. SVN update（拉取最新代码）
  ├── 2. AI 编码（Claude Sonnet 4.5 → Unity C#）
  │     └── 编译-修复-重试循环（MAX 3 次）
  ├── 3. 预处理（worker-patch.js: scenes/luna.json/.export-assets）
  ├── 4. Luna 构建（jake pipeline, 4 stages, ~25-30s）
  ├── 5. HTML 渠道转换（stage4/develop → 单文件 AppLovin HTML）
  ├── 6. 上传产物（zip + 渠道 HTML）
  │
  ▼  status=reviewing
[Blueprint Editor (ECS)]
  ├── SSE 推送通知 → 前端 Toast + 浏览器 Notification
  ├── WebGL 预览（多文件版本）
  └── channels/ 目录（单文件 AppLovin HTML）
```

**关键约束**: Luna 构建需要 Unity Editor **以 GUI 模式运行**，不支持纯 batchmode。

---

## 1. 软件清单

| 软件 | 版本 | 安装方式 | 备注 |
|------|------|---------|------|
| Unity Hub | 最新 | https://unity.com/download | |
| Unity Editor | **2022.3.14f1c1** | Hub 安装，勾选 WebGL | 中国版 |
| Node.js | **v24+** | https://nodejs.org (MSI) | |
| SVN (SlikSvn) | 1.14+ | https://sliksvn.com/download/ | |
| .NET 4.8.1 DevPack | 4.8.1 | https://dotnet.microsoft.com | |
| VC++ Redistributable **x86** | 最新 | `https://aka.ms/vs/17/release/vc_redist.x86.exe` | **fontbm 是 32 位** |
| VC++ Redistributable x64 | 最新 | `https://aka.ms/vs/17/release/vc_redist.x64.exe` | |
| MSBuild | VS BuildTools 2022 | 安装 VS Build Tools | 路径见下方 |
| OpenSSH Server | 系统自带 | Windows Settings | 远程管理用 |

**Worker npm 依赖**:
```bash
cd C:\worker && npm install brotli html-minifier
```

---

## 2. 目录规划

```
D:\Luna\                          # Luna SDK 6.4.0
├── pipeline\                     # jake.js + Jakefile.js
│   ├── .auth_credentials.user    # 认证（机器绑定，需重新生成）
│   └── .auth_response.user
├── tools\                        # 构建工具链（完整列表见下方）
├── engine\                       # Luna 运行时
├── scripts\                      # Unity Package（manifest.json 引用）
├── config.json
├── luna.json
├── Assets → D:\work\<project>\Client\Assets      # symlink
├── Library → D:\work\<project>\Client\Library     # symlink
├── Packages → D:\work\<project>\Client\Packages   # symlink
└── ProjectSettings → D:\work\<project>\Client\ProjectSettings  # symlink

D:\work\<project>\                # SVN 工作目录
└── Client\
    ├── Assets\
    ├── Packages\manifest.json    # Luna 包路径需指向 D:\Luna\scripts
    ├── luna.json                 # 需要 scenes 配置
    └── LunaTemp\                 # 构建产物（每次构建前清除）

C:\worker\                        # Worker 脚本
├── worker-client.js              # v4 主任务处理（poll→SVN→AI→build→convert→upload）
├── worker-coder.js               # v3 AI 编码 agent（Claude API + 编译修复循环）
├── worker-bridge-build.js        # Luna 构建模块（spawn jake pipeline）
├── worker-patch.js               # 预构建修复（detectScenes/fixLunaJson/generateExportAssets）
├── worker-html-converter.js      # HTML 渠道转换（stage4 → 单文件 AppLovin HTML）
├── html-templates\               # 转换模板
│   ├── index.template.html       # Luna 运行时模板（~119KB）
│   └── decompressScript.js       # Brotli 解压运行时（~122KB）
├── ecosystem.config.js           # PM2 配置（备用）
├── launch-unity-auto.ps1         # Unity 启动 + 弹窗自动关闭
├── auto-dismiss-unity.ps1        # Win32 API 自动点击管理员弹窗
├── package.json                  # npm deps: brotli, html-minifier
└── logs\                         # 运行日志
```

---

## 3. Luna SDK tools 完整列表

所有工具必须存在于 `D:\Luna\tools\` 下：

| 目录 | 用途 | 必需 | 备注 |
|------|------|------|------|
| `fontbm/` | 字体 bitmap 生成 | ✅ | **32 位程序，需 x86 VC++ Runtime** |
| `msbuild-mono-custom/` | C# 编译 | ✅ | |
| `SyntaxTransformer/` | 语法转换 | ✅ | |
| `ILSpyRunner/` | IL 反编译 | ✅ | |
| `brotli/` | 压缩 | ✅ | |
| `pngcrush/` | PNG 优化 | ✅ | |
| `pngquant/` | PNG 量化 | ✅ | |
| `libwebp/` | WebP 转换 | ✅ | |
| `diagnostics/` | 诊断工具 | ✅ | |
| `imagemagick/` | 图片处理 | ✅ | |
| `ffmpeg/` | 音频处理 | ✅ | |
| `node/` | 内置 Node | ⚠️ | 系统已装 Node v24+ 可跳过 |

**快速同步命令**（从已有机器复制）：
```powershell
scp -r user@source-machine:/path/to/6.4.0/tools/* D:\Luna\tools\
```

---

## 4. 安装步骤

### 4.1 基础软件安装

```powershell
# 1. Node.js v24+ (MSI 安装)
node -v  # v24.13.0+

# 2. SVN
svn --version

# 3. VC++ Redistributable (关键! x86 + x64 都要装)
curl -sL -o vc_redist.x86.exe https://aka.ms/vs/17/release/vc_redist.x86.exe
curl -sL -o vc_redist.x64.exe https://aka.ms/vs/17/release/vc_redist.x64.exe
.\vc_redist.x86.exe /install /quiet /norestart
.\vc_redist.x64.exe /install /quiet /norestart

# 4. .NET 4.8.1 Developer Pack + v4.7 symlink:
mklink /D "C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETFramework\v4.7" "C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETFramework\v4.8.1"
```

### 4.2 Unity 安装 + License

```powershell
# 安装 Unity Hub → 通过 Hub 安装 Editor 2022.3.14f1 (勾选 WebGL)
& "C:\Program Files\Unity\Hub\Editor\2022.3.14f1\Editor\Unity.exe" `
  -quit -batchmode -nographics `
  -username 17810396401@163.com -password hcwx1234A
```

### 4.3 Luna SDK 部署

```powershell
# 1. 从已有机器复制 SDK
scp -r user@source:C:\Users\S\Desktop\6.4.0\* D:\Luna\

# 2. 认证 Luna 账号
cd D:\Luna\pipeline
$env:USER_EMAIL = "chenyueming"
$env:USER_TOKEN = "2285"
node jake.js -f Jakefile.js account:authorize
```

### 4.4 项目 SVN Checkout

```powershell
svn checkout svn://47.101.191.213:3690/test0213 D:\work\test-luna `
  --username openclaw --password openclaw --non-interactive --trust-server-cert
```

### 4.5 创建符号链接

```cmd
mklink /D D:\Luna\Assets D:\work\test-luna\Client\Assets
mklink /D D:\Luna\Library D:\work\test-luna\Client\Library
mklink /D D:\Luna\Packages D:\work\test-luna\Client\Packages
mklink /D D:\Luna\ProjectSettings D:\work\test-luna\Client\ProjectSettings
copy D:\work\test-luna\Client\luna.json D:\Luna\luna.json
```

### 4.6 修改 Packages/manifest.json

```json
{ "uk.lunalabs.luna": "file:D:/Luna/scripts" }
```

---

## 5. Unity GUI 启动（Windows Server 特殊处理）

### 5.1 问题
Luna Stage1 (`unity:export`) 需要 Unity Editor **GUI 模式**，需要活跃桌面会话。

### 5.2 方案：RDP + Scheduled Task

```powershell
# 1. 配置自动登录
$regPath = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
Set-ItemProperty -Path $regPath -Name 'AutoAdminLogon' -Value '1'
Set-ItemProperty -Path $regPath -Name 'DefaultUserName' -Value 'Administrator'
Set-ItemProperty -Path $regPath -Name 'DefaultPassword' -Value '<password>'

# 2. RDP 连接建立桌面会话
mstsc /v:<worker-ip>

# 3. Interactive Scheduled Task
schtasks /create /tn "UnityBridge" /tr "powershell -NoProfile -ExecutionPolicy Bypass -File C:\worker\launch-unity-auto.ps1" /sc onlogon /f /it
schtasks /run /tn "UnityBridge"
```

### 5.3 管理员弹窗自动关闭
`auto-dismiss-unity.ps1` 使用 Win32 API 自动点击 "I wish to continue" 按钮。

**注意**: PowerShell `Start-Process -ArgumentList` 用**数组格式**：
```powershell
$args = @('-projectPath', 'D:\work\test-luna\Client', '-ignoreCompilerErrors')
Start-Process -FilePath $unityExe -ArgumentList $args
```

### 5.4 验证
```powershell
curl -s http://localhost:18801/status
# {"ok":true,"playing":false,"paused":false,"compiling":false,"port":18801}
```

---

## 6. 构建流程

### 6.1 jake pipeline

```powershell
$env:PROJECT_PATH = "D:\work\test-luna\Client"
cd D:\Luna\pipeline
node --max-old-space-size=8192 jake.js -f Jakefile.js --quiet project:build
```

**4 个 Stage:**
1. **Stage1** `unity:export` — Unity 导出 assets（Luna IPC）
2. **Stage2** — Assets 后处理 + 打包
3. **Stage3** — C# 代码编译（C# → JS）+ 打包
4. **Stage4** — 目标平台打包 (develop/release)

**产物**: `<project>/Client/LunaTemp/stage4/develop/`

### 6.2 构建耗时

| 场景 | 耗时 | 备注 |
|------|------|------|
| 首次构建（无缓存）| ~3-5 分钟 | |
| 后续构建（有缓存）| ~25-30 秒 | |

---

## 6.3 SVN Commit 流程（审核通过后）

当用户在前端确认审核通过（`commit_needed`），Worker 执行：

1. **清理缓存目录** — 删除 `Client/` 下的 `Library`, `Temp`, `LunaTemp`, `obj`, `Logs`, `UserSettings`, `.vs`
   - 先 `svn revert` 取消追踪，再 `fs.rmSync` 物理删除
   - 确保不会将构建缓存提交到 SVN
2. **`svn add --force .`** — 添加新文件
3. **二次检查** — 再次 revert 残留的缓存目录（防止 add 误收）
4. **`svn commit`** — 提交，提取 revision 号
5. **回调通知** — POST `/api/projects/:id/committed` 通知服务端

---

## 7. AI 编码模块 (worker-coder.js v4)

### 7.1 概述
基于公司标准 SLG 模板工程，通过 LLM 根据蓝图生成/改造 Unity C# 代码。AI 会先读取现有工程代码，遵循已有架构和命名规范进行编码。

### 7.2 工程上下文感知
- 自动扫描 SVN 工程的 `Assets/Program`、`Assets/Scripts`、`Assets/Plugins` 目录
- 收集文件树概览 + 关键源文件内容（≤30KB）作为 LLM 上下文
- LLM 被要求：遵循现有代码风格、复用已有类、不重复造轮子

### 7.3 编译-修复循环（持续修复直到通过）
1. LLM 基于蓝图 + 现有工程上下文生成 C# 代码 → 写入 `Assets/Scripts/`
2. 运行 `project:build` 编译检查
3. 从 `LunaTemp/diagnostics-*.json` 提取编译错误（CS0101/CS0246 等）
4. 如果失败，将错误 + 当前代码 + 工程文件列表发给 LLM 修复
5. **持续重试直到通过**（上限 10 轮）
6. **防死循环**：相同错误连续出现 3 次 → 自动触发全量重新生成（附带错误上下文，要求换完全不同的写法）

### 7.4 Luna 制作规范（系统提示，基于团队多年经验）
**禁用清单：**
- ❌ 泛型写法、C# 7.0+ 语法（元组、模式匹配等）
- ❌ TileMap, New InputSystem, Terrain, CharacterController
- ❌ Vector3Int, System.Math, SendMessage, 多线程
- ❌ Animation 组件（用 Animator）、烘焙阴影、Custom RenderTexture
- ❌ SceneManager, Resources.Load, async/await, LINQ
- ❌ String.Format, Regex（Luna 内存泄漏重灾区）
- ❌ GameObject.Find（用单例或预注册引用）
- ❌ Animator 状态机连 Exit 节点（导致动画 bug）
- ❌ `Application.OpenURL` → ✅ `Luna.Unity.Playable.InstallFullGame()`

**必须遵守：**
- ✅ 调 `Luna.Unity.LifeCycle.GameEnded()` 结束游戏
- ✅ DOTween 链式调用分行写（避免 JS 转译 bug）
- ✅ 按钮事件在 Awake/Start 中 AddListener，不动态赋值
- ✅ 音频：iOS 预播放空音频、≤30 秒、首次播放前不调 Stop
- ✅ Mute 处理：实现 `Luna.Unity.LifeCycle.OnMute/OnUnmute`
- ✅ 自动扫描已有类名避免 CS0101 冲突

### 7.4 API 配置
```javascript
const API_BASE = 'https://crs.mindrix.app/api';  // Anthropic Messages 格式
const MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = 16384;
```

---

## 8. HTML 渠道转换 (worker-html-converter.js)

### 8.1 概述
将 Luna 构建的多文件输出（`stage4/develop/`）转换为**单文件 HTML**，可直接投放到广告网络。

### 8.2 转换流程
1. 读取 HTML 模板（`index.template.html`，含 Luna 运行时 ~119KB）
2. 注入 Brotli 解压脚本（`decompressScript.js`）
3. 内联 `cache/210/` 下的 `blobs.js`, `jsons.js`, `scripts.js`
4. 图片/视频 → base64 内联到 HTML
5. 注入 fetch/XHR/Image 拦截器（让内联资源对运行时透明）
6. 从 `luna.json` 读取场景配置 + 商店链接
7. 按渠道注入 SDK 脚本
8. html-minifier 压缩

### 8.3 支持渠道
| 渠道 | 输出格式 | SDK |
|------|---------|-----|
| AppLovin (unity) | 单文件 HTML | mraid |
| ironSource | 单文件 HTML | mraid/dapi |
| Facebook | 单文件 HTML | FbPlayableAd |
| TikTok | 单文件 HTML | playable-sdk |
| Google | 单文件 HTML | ExitApi |
| Mintegral | 单文件 HTML | gameStart/gameEnd |
| Snapchat | 单文件 HTML | ScPlayableAd |
| Moloco | 单文件 HTML | FbPlayableAd |

### 8.4 参考实现来源
提取自 `playable-tools-v2`（Electron 桌面工具）：
- `electron/onePlaygroundCore/v4.js` — 单文件打包核心
- `electron/onePlaygroundCore/channelScripts.js` — 渠道 SDK 脚本
- `electron/onePlaygroundCore/injection.js` — 资源拦截器

### 8.5 CLI 用法
```bash
node worker-html-converter.js <stage4/develop/path> [outputDir] [channels]
# 例：node worker-html-converter.js D:\work\test-luna\Client\LunaTemp\stage4\develop .\output appLovin
```

### 8.6 产物大小参考
| 内容 | 大小 |
|------|------|
| 多文件 zip（stage4/develop）| ~3.8 MB |
| 单文件 AppLovin HTML | ~725 KB |

---

## 9. Worker 服务化

### 9.1 Windows schtasks（推荐）
PM2 在 Windows SSH 下 daemon 随 session 死，改用 schtasks：

```cmd
schtasks /create /tn "WorkerClient" /tr "cmd /c cd /d C:\worker && node worker-client.js >> C:\worker\logs\worker.log 2>&1" /sc onstart /f /ru Administrator /rp "<password>" /rl highest
schtasks /run /tn "WorkerClient"
```

### 9.2 PM2（备用，需 RDP 会话内启动）
```bash
cd C:\worker
pm2 start ecosystem.config.js  # fork mode, 500M max
pm2 save --force
```

---

## 10. ECS 服务端 (Blueprint Editor)

### 10.1 部署信息
- **服务器**: 120.55.70.226 (阿里云 ECS, 4核8GB)
- **代码**: `/opt/blueprint-editor/server.cjs`
- **PM2**: `blueprint-editor`, port 3901
- **URL**: `https://playcools.top/blueprintEditor`
- **前端**: React 19 + @xyflow/react（`/opt/blueprint-editor/dist/`）

### 10.2 API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/projects` | 项目列表 |
| POST | `/api/projects` | 创建项目 |
| PUT | `/api/projects/:id/blueprint` | 保存蓝图 |
| POST | `/api/projects/:id/submit` | 提交任务 |
| GET | `/api/worker/poll?workerId=X` | Worker 拉取任务 |
| POST | `/api/tasks/:id/status` | Worker 上报状态 |
| GET | `/api/tasks/:id/blueprint` | 获取蓝图 JSON |
| POST | `/api/tasks/:id/upload-build` | 上传构建 zip |
| POST | `/api/tasks/:id/upload-html` | 上传渠道 HTML（X-Filename header）|
| POST | `/api/worker/heartbeat` | Worker 心跳 |
| GET | `/api/workers` | Worker 列表 |
| GET | `/api/events` | SSE 推送（project_status / build_ready）|
| GET | `/api/dashboard` | 仪表盘 |

### 10.3 数据目录
```
/opt/blueprint-editor/server-data/
├── projects/           # 项目 JSON
└── webgl/              # WebGL 预览
    └── <taskId>/
        ├── index.html  # 多文件预览入口
        ├── assets/
        ├── cache/
        └── channels/   # 单文件渠道 HTML
            └── <taskId>_appLovin.html
```

### 10.4 前端通知
- SSE 端点 `/api/events`，推送 `build_ready` / `project_status` 事件
- 前端自动 Toast 通知 + 浏览器 Notification
- 注入脚本在 `dist/index.html`（`__bpNotifyInit`）

---

## 11. config.json 关键配置

```json
{
  "unity.scripts.msbuildWin64": "C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/MSBuild/Current/Bin/MSBuild.exe",
  "fonts.fontbmWin64": "tools/fontbm/win64/fontbm.exe",
  "textures.convertWin64": "tools/imagemagick/win64/ImageMagick-7.1.1-29-portable-Q8-x64/magick.exe",
  "textures.pngcrushWin64": "tools/pngcrush/win64/pngcrush.exe",
  "textures.pngquantWin64": "tools/pngquant/win64/pngquant.exe",
  "textures.cwebpWin64": "tools/libwebp/win64/cwebp.exe",
  "sounds.ffmpegWin64": "tools/ffmpeg/win64/ffmpeg.exe"
}
```

---

## 12. 已知构建修复

| # | 问题 | 修复 |
|---|------|------|
| 1 | .NET v4.7 缺失 | `mklink /D v4.7 → v4.8.1` |
| 2 | TMPro 版本 | 锁定 `3.0.6` |
| 3 | TMPro Luna 不兼容 | `#if !UNITY_LUNA` 保护 |
| 4 | 泛型 GetBuiltinResource | 改非泛型版本 |
| 5 | 构建缓存冲突 | 每次删 `LunaTemp/`；commit 阶段自动清理所有缓存目录 |
| 6 | fontbm 32 位 CRT | 安装 x86 VC++ Redistributable |
| 7 | API-ms-win-crt DLL | 同上 |
| 8 | AI 生成代码类名冲突 | worker-coder.js 自动扫描已有类名 |
| 9 | Application.OpenURL | AI 提示改用 `Luna.Unity.Playable.InstallFullGame()` |

---

## 13. 网络端口

| 端口 | 用途 | 备注 |
|------|------|------|
| 18801 | Unity HTTP Bridge | UnityBridge.cs [InitializeOnLoad] |
| 3389 | RDP | Unity GUI 需要 |
| 22 | SSH | 远程管理 |
| 3901 | Blueprint Editor | ECS 上 |

---

## 14. 完整 E2E 流程（实测数据）

### 测试项目
- 蓝图：3 场景（开场→游戏→CTA）+ 2 条转场
- 项目 ID: `proj_1771329013378_palhlp`

### 流程耗时
| 步骤 | 耗时 | 说明 |
|------|------|------|
| SVN update | ~1s | r39 |
| AI 编码（生成 3-4 脚本）| ~50s | Claude Sonnet 4.5 |
| 编译检查 #1 | ~25s | 失败，2 errors |
| AI 自动修复 | ~8s | 1 文件修正 |
| 编译检查 #2 | ~28s | 通过 ✅ |
| Luna 构建（4 stages）| ~28s | 缓存后 |
| HTML 渠道转换 | ~3s | AppLovin 单文件 725KB |
| 上传 zip (3.8MB) | ~27s | 到 ECS |
| 上传渠道 HTML | ~2s | |
| **总计** | **~3 分钟** | |

### 产物
- WebGL 预览: `https://playcools.top/blueprintEditor/webgl/<taskId>/index.html`
- AppLovin HTML: `channels/<taskId>_appLovin.html` (725KB 单文件)

---

## 15. 新机器快速部署清单

```
[ ] 1. 安装 Node.js v24+ (MSI)
[ ] 2. 安装 SVN (SlikSvn)
[ ] 3. 安装 VC++ Redistributable x86 + x64
[ ] 4. 安装 .NET 4.8.1 Developer Pack + v4.7 symlink
[ ] 5. 安装 Unity Hub + Editor 2022.3.14f1 (WebGL Support)
[ ] 6. 激活 Unity License (batchmode)
[ ] 7. 部署 Luna SDK 到 D:\Luna\ (含完整 tools/)
[ ] 8. 认证 Luna 账号 (account:authorize)
[ ] 9. SVN checkout 项目
[ ] 10. 创建 Luna SDK ↔ 项目符号链接
[ ] 11. 修改 manifest.json Luna 包路径
[ ] 12. 部署 Worker 脚本到 C:\worker\ + npm install
[ ] 13. 部署 html-templates/（模板 + 解压脚本）
[ ] 14. 配置自动登录 + RDP 桌面会话
[ ] 15. 创建 UnityBridge scheduled task (/it)
[ ] 16. 首次启动 Unity GUI + 登录 Luna 账号
[ ] 17. 创建 WorkerClient scheduled task
[ ] 18. 验证 HTTP Bridge: curl http://localhost:18801/status
[ ] 19. 验证 Worker: 提交测试蓝图 → 检查 status=reviewing
[ ] 20. 确认 E2E 全流程通过 ✅
```

---

## 16. 常见问题

### Q: fontbm.exe 返回 -1073741515
**A**: 缺少 32 位 VC++ Runtime。安装 `vc_redist.x86.exe`。

### Q: Stage4 报 "Startup scene does not set"
**A**: `worker-patch.js` 的 `fixLunaJson()` 自动修复。

### Q: Unity 进程在但 Bridge 不响应
**A**: Unity 必须 GUI 模式运行。通过 RDP + schtasks /it 启动。

### Q: PM2 在 SSH 下不稳定
**A**: PM2 daemon 随 SSH session 死。改用 `schtasks /sc onstart`。

### Q: AI 生成代码编译失败
**A**: worker-coder.js 自动从 `diagnostics-*.json` 提取错误，LLM 修复，最多重试 3 次。

### Q: HTML 转换后文件太大
**A**: 主要是图片 base64 内联。可在 Luna 项目中优化图片资源。

---

## 17. Worker 机器参考配置

### Worker A (42.121.160.107)
- OS: Windows Server 2025 (10.0.26100)
- CPU: 8 核, RAM: 16 GB
- SSH: Administrator / Soyoo2026!Ecs
- Unity: `C:\Program Files\Unity\Hub\Editor\2022.3.14f1\Editor\Unity.exe`
- Luna: `D:\Luna`, Worker: `C:\worker\`, Work dir: `D:\work\test-luna`
- 构建速度: ~28s/次（缓存后）
- E2E 总耗时: ~3 分钟
- 部署日期: 2026-02-17, 最后验证: 2026-02-18
