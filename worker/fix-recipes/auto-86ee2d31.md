# auto-86ee2d31
## Diagnosis
This is a field-diff-only `fidelity-source-diff` block: the fingerprint has one phase1 blocking field diff, many advisory diffs, and no pixel-gate failure. That points to verifier extraction noise rather than real visual drift. The WebGL extractor is falling back to PlayCanvas scene-tree visibility when Luna already exposes authoritative runtime entity state.

## Root Cause
engine/stages/lib/field-diff.cjs:849

## Fix
In `WEBGL_PAGE_EXTRACTOR`, normalize Luna runtime state before scene-tree fallback and accept both wrapped camelCase and snake_case entity state shapes.

Add after `gs` is read:

    function normalizeGameState(raw) {
      if (!raw || typeof raw !== 'object') return null;
      if (raw.entityStates || raw.entity_states) return raw;
      if (raw.state && typeof raw.state === 'object') return normalizeGameState(raw.state);
      if (raw.gameState && typeof raw.gameState === 'object') return normalizeGameState(raw.gameState);
      if (raw.current && typeof raw.current === 'object') return normalizeGameState(raw.current);
      return raw;
    }

    function getEntityStates(raw) {
      const normalized = normalizeGameState(raw);
      if (!normalized || typeof normalized !== 'object') return null;
      if (normalized.entityStates && typeof normalized.entityStates === 'object') return normalized.entityStates;
      if (normalized.entity_states && typeof normalized.entity_states === 'object') return normalized.entity_states;
      return null;
    }

Then use the normalized state:

    const normalizedGs = normalizeGameState(gs);
    if (normalizedGs) gs = normalizedGs;

    const visible = {};
    const stateHidden = {};
    const entityStatesObj = getEntityStates(gs);
    if (entityStatesObj) {
      const keys = Object.keys(entityStatesObj);
      for (let i = 0; i < keys.length; i++) {
        const st = entityStatesObj[keys[i]];
        if (st && st.visible !== false) visible[keys[i]] = true;
        else stateHidden[keys[i]] = true;
      }
      if (visible.player && !visible.Player) visible.Player = true;
      if (stateHidden.player && !stateHidden.Player) stateHidden.Player = true;
    }

Guard PlayCanvas tree/storyboard overlay visibility with `!entityStatesObj`, and choose authoritative output first:

    if (entityStatesObj) {
      out.visibleEntities = Object.keys(visible);
      out.visibleSource = 'entity_states';
    } else if (Object.keys(storyboardEntities).length > 0) {
      out.visibleEntities = Object.keys(storyboardEntities);
      out.visibleSource = 'storyboard-overlay';
    } else {
      out.visibleEntities = Object.keys(visible);
      out.visibleSource = 'tree';
    }

## Verification
cd /opt/blueprint-editor && node -e "const assert=require('assert'); const fd=require('./engine/stages/lib/field-diff.cjs'); global.window={__gameState:{state:{entityStates:{player:{visible:true},Tower:{visible:true},Hidden:{visible:false}}}}}; global.document={querySelector:()=>null,querySelectorAll:()=>[],getElementById:()=>null}; const out=fd.WEBGL_PAGE_EXTRACTOR({phaseId:'phase1'}); assert.strictEqual(out.visibleSource,'entity_states'); assert.ok(out.visibleEntities.includes('Player')); assert.ok(out.visibleEntities.includes('Tower')); assert.ok(!out.visibleEntities.includes('Hidden'));"