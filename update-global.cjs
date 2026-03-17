const https = require('https');
const http = require('http');

const projectId = 'proj_1772426062293_qmjs';

// 从分镜 PDF 提取的完整全局数据
const globalData = {
  objectRegistry: [
    { name: "Ground", shape: "Ground", scale: "30×30", color: "(0.35,0.25,0.15)", initiallyVisible: true, firstStep: 1 },
    { name: "Player", shape: "Cube", scale: "1×2×1", color: "(0.2,0.4,0.9)", initiallyVisible: true, firstStep: 1 },
    { name: "Base", shape: "Cube", scale: "3×3×3", color: "(0.85,0.7,0.4)", initiallyVisible: true, firstStep: 1 },
    { name: "WoodFence", shape: "Cube", scale: "0.3×1.5×8", color: "(0.6,0.35,0.1)", initiallyVisible: true, firstStep: 1 },
    { name: "PineTree_L", shape: "Cylinder", scale: "0.5×3×0.5", color: "(0.1,0.55,0.1)", initiallyVisible: true, firstStep: 1 },
    { name: "PineTree_R", shape: "Cylinder", scale: "0.5×3×0.5", color: "(0.1,0.55,0.1)", initiallyVisible: true, firstStep: 1 },
    { name: "Generator", shape: "Cube", scale: "1.5×2×1.5", color: "(0.4,0.4,0.45)", initiallyVisible: true, firstStep: 1 },
    { name: "ConveyorBelt", shape: "Cube", scale: "4×0.3×1", color: "(0.5,0.5,0.55)", initiallyVisible: false, firstStep: 1 },
    { name: "Crossbow_L", shape: "Cube", scale: "1×1.5×1", color: "(0.5,0.5,0.55)", initiallyVisible: false, firstStep: 2 },
    { name: "Enemy_A", shape: "Cube", scale: "0.8×1.6×0.8", color: "(0.85,0.15,0.15)", initiallyVisible: false, firstStep: 2 },
    { name: "WoodLog", shape: "Cylinder", scale: "0.3×0.8×0.3", color: "(0.6,0.35,0.1)", initiallyVisible: false, firstStep: 2 },
    { name: "WoodenHouse_L", shape: "Cube", scale: "2.5×2.5×2.5", color: "(0.85,0.7,0.4)", initiallyVisible: false, firstStep: 3 },
    { name: "Worker_L", shape: "Cube", scale: "0.8×1.8×0.8", color: "(0.9,0.6,0.2)", initiallyVisible: false, firstStep: 4 },
    { name: "Crossbow_R", shape: "Cube", scale: "1×1.5×1", color: "(0.5,0.5,0.55)", initiallyVisible: false, firstStep: 6 },
    { name: "WoodenHouse_R", shape: "Cube", scale: "2.5×2.5×2.5", color: "(0.85,0.7,0.4)", initiallyVisible: false, firstStep: 6 },
    { name: "Worker_R", shape: "Cube", scale: "0.8×1.8×0.8", color: "(0.9,0.6,0.2)", initiallyVisible: false, firstStep: 7 },
    { name: "Cannon", shape: "Cube", scale: "1.2×1.8×1.2", color: "(0.5,0.5,0.55)", initiallyVisible: false, firstStep: 7 },
    { name: "Boss", shape: "Cube", scale: "2.5×4×2.5", color: "(0.7,0.1,0.1)", initiallyVisible: false, firstStep: 8 },
    { name: "Castle", shape: "Cube", scale: "5×5×5", color: "(0.6,0.5,0.4)", initiallyVisible: false, firstStep: 10 },
    { name: "StoneWall", shape: "Cube", scale: "0.4×2×10", color: "(0.55,0.55,0.55)", initiallyVisible: false, firstStep: 10 },
  ],
  globalParams: `# === 玩家参数 ===
player.moveSpeed = 5        # 移动速度
player.startGold = 1        # 初始金币

# === 传送带 ===
conveyor.unlockCost = 1     # 解锁费用(金币)
conveyor.spawnInterval = 1  # 木材生成间隔(秒)
conveyor.speed = 1          # 传送速度(米/秒)

# === 弩炮 ===
crossbow.damage = 1         # 攻击力
crossbow.range = 5          # 射程
crossbow.activateCost = 10  # 激活费用(木材)

# === 敌人 ===
enemy.hp = 1                # 血量
enemy.moveSpeed = 3         # 移动速度
enemy.dropGold = 1          # 掉落金币(Phase2), 后期+5
enemy.spawnInterval = 1     # 生成间隔(秒)

# === 建造 ===
woodenHouse.buildCost = 10  # 木屋建造费用(木材)
worker.recruitCost = 10     # 工人招募费用(金币)
worker.moveSpeed = 5        # 工人移速
crossbow_R.buildCost = 100  # 右侧弩炮建造费用(木材)

# === Boss ===
boss.hp = 50                # Boss血量
boss.damage = 5             # Boss对基地攻击力
boss.moveSpeed = 2          # Boss移速(比玩家慢)
base.hp = 50                # 基地血量

# === 升级 ===
base.upgradeCost = 200      # 主城升级费用(金币)
camera.fovIncrease = 10     # 升级后镜头拉远值`,

  globalSettings: {
    gameType: 'slg',
    cameraMode: 'topDown45',
    cameraProjection: 'orthographic',
    cameraFOV: 60,
    cameraBgColor: '(0.6,0.8,1)',
    defaultInput: 'virtualJoystick',
  }
};

// 通过 SSH 调用 ECS 本地 API
const { execSync } = require('child_process');
const body = JSON.stringify(globalData).replace(/'/g, "'\\''");
const cmd = `ssh root@120.55.70.226 "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; curl -s -X PUT -H 'Content-Type: application/json' -d '${body}' http://127.0.0.1:3901/api/projects/${projectId}/blueprint"`;

try {
  const result = execSync(cmd, { encoding: 'utf-8', timeout: 15000 });
  console.log('Result:', result);
} catch (e) {
  console.error('Error:', e.message);
  // Fallback: write to file and scp
  console.log('Trying file-based approach...');
}
