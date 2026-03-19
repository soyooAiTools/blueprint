/**
 * PlayCheck DOM Input v1 — 基于 DOM 合成事件的 Luna 输入控制
 * 
 * 核心思路：不 hook 任何 Unity API，通过 DOM 事件走 Luna 完整输入管线
 *   - Luna 的 mouse→touch 转换器监听 window 级 mousedown/mousemove/mouseup
 *   - 合成 MouseEvent dispatch 到 canvas，Luna 自动处理坐标转换
 *   - 通过 Unity JS API 读取 GameObject 世界坐标做精确导航
 * 
 * 坐标系：
 *   World  — Unity 世界坐标 (transform.position)
 *   Screen — Unity 屏幕坐标 (Camera.WorldToScreenPoint, Y=0 在底部)
 *   DOM    — 浏览器像素坐标 (clientX/clientY, Y=0 在顶部)
 * 
 * 转换链：World → Screen → DOM → dispatchEvent
 * 反向链：DOM event → Luna mouse→touch → Unity Input → Camera → World
 */
(function () {
  'use strict';

  // ==================== 配置 ====================
  const FRAME_MS = 16;        // ~60fps，每帧间隔
  const DRAG_STEPS = 20;      // 拖拽默认步数
  const CLICK_HOLD_MS = 50;   // 点击按住时长

  // ==================== 状态 ====================
  let _canvas = null;
  let _ready = false;

  // ==================== 初始化 ====================

  function init() {
    _canvas = document.getElementById('application-canvas');
    if (!_canvas) {
      console.warn('[PlayCheck] canvas not found');
      return false;
    }
    if (!window.UnityEngine || !window.UnityEngine.Camera) {
      console.warn('[PlayCheck] UnityEngine not loaded');
      return false;
    }
    _ready = true;
    console.log('[PlayCheck] DOM Input ready ✓');
    return true;
  }

  function waitReady(timeoutMs) {
    timeoutMs = timeoutMs || 15000;
    return new Promise(function (resolve, reject) {
      if (init()) return resolve();
      var start = Date.now();
      var iv = setInterval(function () {
        if (init()) { clearInterval(iv); resolve(); }
        else if (Date.now() - start > timeoutMs) {
          clearInterval(iv);
          reject(new Error('[PlayCheck] timeout waiting for engine'));
        }
      }, 200);
    });
  }

  // ==================== 坐标转换 ====================

  /**
   * 获取 canvas 的 DOM rect 和缩放比
   * Unity 屏幕坐标基于 canvas 的逻辑像素大小
   * DOM 坐标基于 canvas 的 CSS 布局大小
   */
  function getCanvasMetrics() {
    var rect = _canvas.getBoundingClientRect();
    // canvas 的渲染分辨率
    var renderW = _canvas.width;
    var renderH = _canvas.height;
    // canvas 的 CSS 显示大小
    var cssW = rect.width;
    var cssH = rect.height;
    return {
      rect: rect,
      renderW: renderW,
      renderH: renderH,
      cssW: cssW,
      cssH: cssH,
      // Unity Screen 坐标 → DOM clientX/Y 的缩放比
      scaleX: cssW / renderW,
      scaleY: cssH / renderH,
      offsetX: rect.left,
      offsetY: rect.top
    };
  }

  /**
   * Unity 屏幕坐标 → DOM client 坐标
   * Unity: (0,0)=左下, (W,H)=右上
   * DOM:   (0,0)=左上, (W,H)=右下
   */
  function screenToDOM(screenX, screenY) {
    var m = getCanvasMetrics();
    return {
      clientX: m.offsetX + screenX * m.scaleX,
      clientY: m.offsetY + (m.renderH - screenY) * m.scaleY
    };
  }

  /**
   * DOM client 坐标 → Unity 屏幕坐标
   */
  function domToScreen(clientX, clientY) {
    var m = getCanvasMetrics();
    return {
      x: (clientX - m.offsetX) / m.scaleX,
      y: m.renderH - (clientY - m.offsetY) / m.scaleY
    };
  }

  /**
   * 世界坐标 → DOM client 坐标
   */
  function worldToDOM(worldX, worldY, worldZ) {
    var cam = UnityEngine.Camera.main;
    if (!cam) throw new Error('[PlayCheck] Camera.main not found');
    var V3 = UnityEngine.Vector3;
    var sp = cam.WorldToScreenPoint(new V3(worldX, worldY, worldZ || 0));
    return screenToDOM(sp.x, sp.y);
  }

  /**
   * DOM client 坐标 → 世界坐标（在 z=0 平面）
   */
  function domToWorld(clientX, clientY) {
    var cam = UnityEngine.Camera.main;
    if (!cam) throw new Error('[PlayCheck] Camera.main not found');
    var sc = domToScreen(clientX, clientY);
    var V3 = UnityEngine.Vector3;
    var wp = cam.ScreenToWorldPoint(new V3(sc.x, sc.y, cam.nearClipPlane));
    return { x: wp.x, y: wp.y, z: wp.z };
  }

  // ==================== 场景查询 ====================

  /**
   * 获取 GameObject 的世界坐标
   */
  function getObjectPosition(nameOrPath) {
    var go = UnityEngine.GameObject.Find(nameOrPath);
    if (!go) return null;
    var p = go.transform.position;
    return { x: p.x, y: p.y, z: p.z, gameObject: go };
  }

  /**
   * 获取 GameObject 在 DOM 上的像素位置
   */
  function getObjectDOMPosition(nameOrPath) {
    var info = getObjectPosition(nameOrPath);
    if (!info) return null;
    var dom = worldToDOM(info.x, info.y, info.z);
    return { worldX: info.x, worldY: info.y, worldZ: info.z, clientX: dom.clientX, clientY: dom.clientY };
  }

  /**
   * 获取相机信息
   */
  function getCameraInfo() {
    var cam = UnityEngine.Camera.main;
    if (!cam) return null;
    var p = cam.transform.position;
    return {
      position: { x: p.x, y: p.y, z: p.z },
      orthographic: cam.orthographic,
      orthographicSize: cam.orthographicSize,
      fieldOfView: cam.fieldOfView,
      nearClip: cam.nearClipPlane,
      farClip: cam.farClipPlane
    };
  }

  /**
   * 列出场景中所有 root GameObject
   */
  function listRootObjects() {
    var results = [];
    try {
      var scene = UnityEngine.SceneManagement.SceneManager.GetActiveScene();
      // Luna 可能没实现 GetRootGameObjects，用 FindObjectsOfType 兜底
      var allGO = UnityEngine.Object.FindObjectsOfType$1
        ? UnityEngine.Object.FindObjectsOfType$1(UnityEngine.GameObject)
        : [];
      for (var i = 0; i < Math.min(allGO.length, 100); i++) {
        var g = allGO[i];
        var p = g.transform.position;
        results.push({
          name: g.name,
          active: g.activeSelf,
          x: p.x, y: p.y, z: p.z,
          childCount: g.transform.childCount
        });
      }
    } catch (e) {
      results.push({ error: e.message });
    }
    return results;
  }

  // ==================== DOM 事件派发 ====================

  function dispatchMouse(type, clientX, clientY, button) {
    var evt = new MouseEvent(type, {
      clientX: clientX,
      clientY: clientY,
      screenX: clientX,
      screenY: clientY,
      button: button || 0,
      which: (button || 0) + 1,
      bubbles: true,
      cancelable: true
    });
    _canvas.dispatchEvent(evt);
  }

  function dispatchTouch(type, touches, changedTouches) {
    function makeTouch(t) {
      return new Touch({
        identifier: t.id || 0,
        target: _canvas,
        clientX: t.clientX,
        clientY: t.clientY,
        screenX: t.clientX,
        screenY: t.clientY,
        pageX: t.clientX,
        pageY: t.clientY
      });
    }
    var ts = touches.map(makeTouch);
    var cts = (changedTouches || touches).map(makeTouch);
    _canvas.dispatchEvent(new TouchEvent(type, {
      touches: ts,
      targetTouches: ts,
      changedTouches: cts,
      bubbles: true,
      cancelable: true
    }));
  }

  // ==================== 操作 API ====================

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /**
   * 在 DOM 坐标上点击
   */
  async function clickAt(clientX, clientY) {
    dispatchMouse('mousedown', clientX, clientY);
    await sleep(CLICK_HOLD_MS);
    dispatchMouse('mouseup', clientX, clientY);
  }

  /**
   * 点击世界坐标对应的屏幕位��
   */
  async function clickWorld(worldX, worldY, worldZ) {
    var dom = worldToDOM(worldX, worldY, worldZ || 0);
    await clickAt(dom.clientX, dom.clientY);
  }

  /**
   * 点击 GameObject
   */
  async function clickObject(nameOrPath) {
    var pos = getObjectDOMPosition(nameOrPath);
    if (!pos) throw new Error('[PlayCheck] Object not found: ' + nameOrPath);
    await clickAt(pos.clientX, pos.clientY);
  }

  /**
   * DOM 坐标之间拖拽
   */
  async function dragDOM(fromX, fromY, toX, toY, steps, durationMs) {
    steps = steps || DRAG_STEPS;
    durationMs = durationMs || steps * FRAME_MS;
    var stepMs = durationMs / steps;

    dispatchMouse('mousedown', fromX, fromY);
    await sleep(stepMs);

    for (var i = 1; i <= steps; i++) {
      var t = i / steps;
      var x = fromX + (toX - fromX) * t;
      var y = fromY + (toY - fromY) * t;
      dispatchMouse('mousemove', x, y);
      await sleep(stepMs);
    }

    dispatchMouse('mouseup', toX, toY);
  }

  /**
   * 世界坐标之间拖拽
   */
  async function dragWorld(fromWX, fromWY, toWX, toWY, steps) {
    var from = worldToDOM(fromWX, fromWY, 0);
    var to = worldToDOM(toWX, toWY, 0);
    await dragDOM(from.clientX, from.clientY, to.clientX, to.clientY, steps);
  }

  /**
   * 从一个 GameObject 拖到另一个
   */
  async function dragObject(fromName, toName, steps) {
    var from = getObjectDOMPosition(fromName);
    var to = getObjectDOMPosition(toName);
    if (!from) throw new Error('[PlayCheck] Object not found: ' + fromName);
    if (!to) throw new Error('[PlayCheck] Object not found: ' + toName);
    await dragDOM(from.clientX, from.clientY, to.clientX, to.clientY, steps);
  }

  /**
   * 滑动（归一化坐标 0-1）
   */
  async function swipe(direction, startNormX, startNormY, distance) {
    startNormX = startNormX || 0.5;
    startNormY = startNormY || 0.5;
    distance = distance || 0.3;
    var m = getCanvasMetrics();
    var sx = m.offsetX + startNormX * m.cssW;
    var sy = m.offsetY + startNormY * m.cssH;
    var dx = 0, dy = 0;
    switch (direction) {
      case 'left':  dx = -distance * m.cssW; break;
      case 'right': dx = distance * m.cssW; break;
      case 'up':    dy = -distance * m.cssH; break;
      case 'down':  dy = distance * m.cssH; break;
    }
    await dragDOM(sx, sy, sx + dx, sy + dy);
  }

  /**
   * 长按
   */
  async function longPress(clientX, clientY, durationMs) {
    durationMs = durationMs || 1000;
    dispatchMouse('mousedown', clientX, clientY);
    await sleep(durationMs);
    dispatchMouse('mouseup', clientX, clientY);
  }

  // ==================== 高级导航 ====================

  /**
   * 从当前位置导航到目标 — 核心方法
   * 
   * 思路：读取 player 和 target 的世界坐标，计算需要的 DOM 事件
   * 支持多种游戏操控模式：
   *   - 'click':   点击目标位置（游戏自己寻路）
   *   - 'drag':    从 player 拖到 target
   *   - 'joystick': 在摇杆区域拖拽方向
   * 
   * @param {string} playerName  - 玩家 GameObject 名称
   * @param {string} targetName  - 目标 GameObject 名称（或 {x,y,z} 世界坐标）
   * @param {object} options     - { mode, joystickCenter, maxSteps, threshold }
   */
  async function navigateTo(playerName, target, options) {
    options = options || {};
    var mode = options.mode || 'click';
    var maxSteps = options.maxSteps || 50;
    var threshold = options.threshold || 0.5;  // 世界单位距离阈值

    // 解析目标
    var targetPos;
    if (typeof target === 'string') {
      var tInfo = getObjectPosition(target);
      if (!tInfo) throw new Error('[PlayCheck] Target not found: ' + target);
      targetPos = { x: tInfo.x, y: tInfo.y, z: tInfo.z };
    } else {
      targetPos = { x: target.x, y: target.y, z: target.z || 0 };
    }

    for (var step = 0; step < maxSteps; step++) {
      // 读取当前玩家位置
      var playerPos = getObjectPosition(playerName);
      if (!playerPos) throw new Error('[PlayCheck] Player not found: ' + playerName);

      // 计算距离
      var dx = targetPos.x - playerPos.x;
      var dy = targetPos.y - playerPos.y;
      var dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < threshold) {
        return { success: true, steps: step, finalDist: dist, playerPos: playerPos, targetPos: targetPos };
      }

      if (mode === 'click') {
        // 直接点击目标位置
        var tDom = worldToDOM(targetPos.x, targetPos.y, targetPos.z);
        await clickAt(tDom.clientX, tDom.clientY);
        await sleep(200);

      } else if (mode === 'drag') {
        // 从玩家拖到目标
        var pDom = worldToDOM(playerPos.x, playerPos.y, playerPos.z);
        var tDom2 = worldToDOM(targetPos.x, targetPos.y, targetPos.z);
        await dragDOM(pDom.clientX, pDom.clientY, tDom2.clientX, tDom2.clientY, 15);
        await sleep(300);

      } else if (mode === 'joystick') {
        // 在摇杆区域按方向拖拽
        var jc = options.joystickCenter || { clientX: 80, clientY: getCanvasMetrics().rect.bottom - 80 };
        var angle = Math.atan2(dy, dx);
        var jRadius = options.joystickRadius || 40;
        var jx = jc.clientX + Math.cos(angle) * jRadius;
        var jy = jc.clientY - Math.sin(angle) * jRadius;  // DOM Y 反向
        await dragDOM(jc.clientX, jc.clientY, jx, jy, 10, 300);
        await sleep(200);
      }
    }

    var finalPlayer = getObjectPosition(playerName);
    var finalDist = Math.sqrt(
      Math.pow(targetPos.x - finalPlayer.x, 2) +
      Math.pow(targetPos.y - finalPlayer.y, 2)
    );
    return { success: false, steps: maxSteps, finalDist: finalDist, playerPos: finalPlayer, targetPos: targetPos };
  }

  /**
   * 批量执行操作序列（给 AI Agent 用）
   */
  async function exec(actions) {
    var results = [];
    for (var i = 0; i < actions.length; i++) {
      var a = actions[i];
      var r = { action: a.type, index: i };
      try {
        switch (a.type) {
          case 'click':
            if (a.object) await clickObject(a.object);
            else if (a.worldX !== undefined) await clickWorld(a.worldX, a.worldY, a.worldZ);
            else await clickAt(a.clientX, a.clientY);
            r.ok = true;
            break;

          case 'drag':
            if (a.fromObject && a.toObject) await dragObject(a.fromObject, a.toObject, a.steps);
            else if (a.fromWorldX !== undefined) await dragWorld(a.fromWorldX, a.fromWorldY, a.toWorldX, a.toWorldY, a.steps);
            else await dragDOM(a.fromX, a.fromY, a.toX, a.toY, a.steps);
            r.ok = true;
            break;

          case 'swipe':
            await swipe(a.direction, a.startX, a.startY, a.distance);
            r.ok = true;
            break;

          case 'navigate':
            r.result = await navigateTo(a.player, a.target, a);
            r.ok = r.result.success;
            break;

          case 'wait':
            await sleep(a.ms || 1000);
            r.ok = true;
            break;

          case 'query':
            r.result = a.object ? getObjectDOMPosition(a.object) : getCameraInfo();
            r.ok = !!r.result;
            break;

          default:
            r.ok = false;
            r.error = 'Unknown action: ' + a.type;
        }
      } catch (e) {
        r.ok = false;
        r.error = e.message;
      }
      results.push(r);
    }
    return results;
  }

  // ==================== 暴露 API ====================

  window.__playcheck = {
    // 初始化
    waitReady: waitReady,

    // 坐标转换
    screenToDOM: screenToDOM,
    domToScreen: domToScreen,
    worldToDOM: worldToDOM,
    domToWorld: domToWorld,

    // 场景查询
    getObjectPosition: getObjectPosition,
    getObjectDOMPosition: getObjectDOMPosition,
    getCameraInfo: getCameraInfo,
    listRootObjects: listRootObjects,

    // 基础操作（DOM 坐标）
    clickAt: clickAt,
    dragDOM: dragDOM,
    longPress: longPress,
    swipe: swipe,

    // 世界坐标操作
    clickWorld: clickWorld,
    clickObject: clickObject,
    dragWorld: dragWorld,
    dragObject: dragObject,

    // 高级导航
    navigateTo: navigateTo,

    // 批量执行
    exec: exec,

    // 版本
    version: '1.0.0',
    method: 'dom-event'  // 区别于 hook 方案
  };

  console.log('[PlayCheck] DOM Input v1.0.0 loaded');
})();
