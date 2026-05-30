// Load /tmp/pathc-build.html via file:// in playwright, screenshot, dump overlay state
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 750, height: 1334 } });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', msg => logs.push('[' + msg.type() + '] ' + msg.text().slice(0,300)));
  page.on('pageerror', e => logs.push('[err] ' + String(e).slice(0,300)));

  const url = 'file:///tmp/pathc-build.html';
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  } catch (e) { console.log('goto-warn:', e.message.slice(0,200)); }
  await page.waitForTimeout(35000);

  const probe = await page.evaluate(() => {
    const out = {};
    try { out.fontsCheck = document.fonts.check('16px DefaultFont'); } catch(e) {}
    const m = window.__bpTextMirrors;
    if (!m) { out.mirrorMap = 'missing'; return out; }
    out.mirrorCount = m.size;
    let hidden_noElement=0, hidden_noText=0, hidden_disabled=0, hidden_noCorners=0, visible=0;
    const samples = [];
    m.forEach((rec, inst) => {
      try {
        const handle = inst.handle, entity = handle && handle.entity;
        const element = entity && entity.element;
        if (!element || !rec.lastText) { hidden_noElement++; return; }
        if (entity.enabled === false || element.enabled === false) {
          hidden_disabled++;
          if (samples.length < 5) samples.push({ kind: 'disabled', text: rec.lastText.slice(0,30), entityName: entity.name, parentEnabled: entity.parent ? entity.parent.enabled : null });
          return;
        }
        const c = element.canvasCorners || element.screenCorners;
        if (!c || c.length < 4) {
          hidden_noCorners++;
          if (samples.length < 5) {
            // Inspect cachedRect, screen, anchoredPosition, getPos
            let pos = null, worldPos = null, rect = null, screen = null;
            try { pos = entity.getLocalPosition(); pos = pos ? [pos.x, pos.y, pos.z] : null; } catch(e) {}
            try { worldPos = entity.getPosition(); worldPos = worldPos ? [worldPos.x, worldPos.y, worldPos.z] : null; } catch(e) {}
            try { rect = element.cachedRect; rect = rect ? [rect.x, rect.y, rect.width||rect.z, rect.height||rect.w] : null; } catch(e) {}
            try { var s = element.screen; if (s) screen = { entityName: s.entity ? s.entity.name : '?', screenSpace: s.screen && s.screen.screenSpace, refRes: s.screen && s.screen.referenceResolution ? [s.screen.referenceResolution.x, s.screen.referenceResolution.y] : null }; } catch(e) {}
            samples.push({
              kind: 'noCorners', text: rec.lastText.slice(0,30), entityName: entity.name,
              pos: pos, worldPos: worldPos, cachedRect: rect, screen: screen,
              anchoredPos: element._anchoredPosition ? [element._anchoredPosition.x, element._anchoredPosition.y] : null,
              fontSize: element.fontSize
            });
          }
          return;
        }
        visible++;
        if (samples.length < 8) samples.push({
          kind: 'visible', text: rec.lastText.slice(0,30), entityName: entity.name,
          corners: c.slice(0,4).map(p => [p.x, p.y].map(v => Math.round(v))),
          fontSize: element.fontSize
        });
      } catch(e) { hidden_noElement++; }
    });
    out.stats = { hidden_noElement, hidden_noText, hidden_disabled, hidden_noCorners, visible };
    out.samples = samples;
    // Probe a single element comprehensively
    try {
      m.forEach((rec, inst) => {
        if (out.elementProbe) return;
        const handle = inst.handle, entity = handle && handle.entity;
        const element = entity && entity.element;
        if (!element || !rec.lastText) return;
        const proto = Object.getPrototypeOf(element);
        const protoKeys = proto ? Object.getOwnPropertyNames(proto).filter(k => /corner|screen|world|pos|rect|canvas/i.test(k)) : [];
        const ent = {};
        try { ent.parent = entity.parent ? entity.parent.name : null; } catch(e) {}
        try { ent.parentParent = entity.parent && entity.parent.parent ? entity.parent.parent.name : null; } catch(e) {}
        try { ent.local = entity.getLocalPosition(); ent.local = ent.local ? [ent.local.x, ent.local.y, ent.local.z] : null; } catch(e) {}
        try { ent.world = entity.getPosition(); ent.world = ent.world ? [ent.world.x, ent.world.y, ent.world.z] : null; } catch(e) {}
        try { ent.scale = entity.getLocalScale(); ent.scale = ent.scale ? [ent.scale.x, ent.scale.y, ent.scale.z] : null; } catch(e) {}
        let canvasCornersTried = null;
        try {
          if (typeof element.canvasCorners !== 'undefined') canvasCornersTried = element.canvasCorners;
          else { const desc = Object.getOwnPropertyDescriptor(proto, 'canvasCorners'); if (desc && desc.get) canvasCornersTried = desc.get.call(element); }
        } catch(e) { canvasCornersTried = String(e).slice(0,80); }
        out.elementProbe = {
          text: rec.lastText.slice(0, 40),
          protoMethods: protoKeys.slice(0, 30),
          entity: ent,
          cachedRect: element.cachedRect,
          screenComp: element.screen ? { entityName: element.screen.name } : null,
          tryCanvasCornersDirect: canvasCornersTried ? (Array.isArray(canvasCornersTried) ? 'len=' + canvasCornersTried.length : typeof canvasCornersTried) : 'falsy'
        };
      });
    } catch(e) { out.probeErr = String(e).slice(0,200); }
    return out;
  });
  console.log('=== probe ===');
  console.log(JSON.stringify(probe, null, 2));

  await page.screenshot({ path: '/tmp/preview-shots/pathc-verify.png', fullPage: false, timeout: 60000 });
  console.log('saved /tmp/preview-shots/pathc-verify.png');

  console.log('--- font logs ---');
  for (const l of logs.filter(l => /font|overlay|DefaultFont/i.test(l)).slice(-15)) console.log(l);

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
