#!/usr/bin/env node

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var worker = require('../worker/worker-playableagent.js');
var playableAgentSrc = fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker-playableagent.js'), 'utf8');

assert.strictEqual(
  worker.blueprintNeedsManualJoystickProbe({
    plans: {
      cuaPlan: {
        steps: [{ strategy: 'joystick_move', objective: 'move_to IceBlock' }]
      }
    }
  }, {}),
  true,
  'joystick/move_to plans must require the manual joystick probe'
);

assert.strictEqual(
  worker.blueprintNeedsManualJoystickProbe({}, {
    coveredSignals: ['intro:player_position_changed']
  }),
  true,
  'player_position_changed signal coverage must require the manual joystick probe'
);

var stuck = worker.evaluateManualJoystickProbeResult({
  samples: [
    {
      runtimePlayer: { x: 0, y: 0.9, z: 1 },
      joy: { h: 0, v: 0 }
    },
    {
      runtimePlayer: { x: 0, y: 0.9, z: 1 },
      joy: { h: 0.7, v: 0.7 }
    }
  ]
});

assert.strictEqual(stuck.passed, false, 'responding joystick with stationary player must fail');
assert.ok(stuck.reason.indexOf('player position did not change') >= 0);
assert.ok(stuck.maxInput > 0.9);
assert.strictEqual(stuck.maxPlayerDistance, 0);

var moved = worker.evaluateManualJoystickProbeResult({
  samples: [
    {
      runtimePlayer: { x: 0, y: 0.9, z: 1 },
      joy: { h: 0, v: 0 }
    },
    {
      runtimePlayer: { x: 0.25, y: 0.9, z: 1.2 },
      joy: { h: 0.7, v: 0.7 }
    }
  ]
});

assert.strictEqual(moved.passed, true, 'manual joystick probe should pass when input and player position both change');
assert.ok(moved.maxPlayerDistance > 0.05);

var touchMaskedByMouse = worker.evaluateManualJoystickProbeResult({
  samples: [
    {
      label: 'before',
      runtimePlayer: { x: 0, y: 0.9, z: 1 },
      joy: { h: 0, v: 0 }
    },
    {
      label: 'during-mouse-hold',
      runtimePlayer: { x: 0.25, y: 0.9, z: 1.2 },
      joy: { h: 0.7, v: 0.7 }
    },
    {
      label: 'before-touch',
      runtimePlayer: { x: 0.25, y: 0.9, z: 1.2 },
      joy: { h: 0, v: 0 }
    },
    {
      label: 'during-touch-hold',
      runtimePlayer: { x: 0.25, y: 0.9, z: 1.2 },
      joy: { h: 0, v: 0 }
    }
  ]
});
assert.strictEqual(touchMaskedByMouse.passed, false, 'mouse movement must not mask a broken touch-only joystick path');
assert.ok(touchMaskedByMouse.reason.indexOf('touch-only') >= 0);

var touchOk = worker.evaluateManualJoystickProbeResult({
  samples: [
    {
      label: 'before',
      runtimePlayer: { x: 0, y: 0.9, z: 1 },
      joy: { h: 0, v: 0 }
    },
    {
      label: 'during-mouse-hold',
      runtimePlayer: { x: 0.25, y: 0.9, z: 1.2 },
      joy: { h: 0.7, v: 0.7 }
    },
    {
      label: 'before-touch',
      runtimePlayer: { x: 0.25, y: 0.9, z: 1.2 },
      joy: { h: 0, v: 0 }
    },
    {
      label: 'during-touch-hold',
      runtimePlayer: { x: 0.55, y: 0.9, z: 1.5 },
      joy: { h: 0.7, v: 0.7 }
    }
  ]
});
assert.strictEqual(touchOk.passed, true, 'touch-only joystick path should pass when touch input and player movement both change');

var visualOk = worker.evaluateStoryboardVisualAuditResult({
  phaseAudits: [
    { phase: 'phase1', labels: [
      { visible: true, entity: 'Player', entityRect: { x: 1 }, centerDx: 0.2, topGap: 8.1 }
    ] }
  ],
	  movementAudits: [
	    {
	      direction: 'up',
	      screenDx: 0.3,
	      screenDy: -18,
	      maxGuidanceLinePlayerDelta: 0.01,
	      maxAbsStepPx: 3.2,
	      labelDirectionChecks: [{ dEntityY: -2.5, dLabelBottom: -2.4 }]
	    }
	  ],
	  clickAudits: [{ maxDisplacementPx: 0.2 }],
	  targetMarkerAudits: [{ phase: 'phase1', visible: true, targetName: 'IceBlock' }]
	});
assert.strictEqual(visualOk.passed, true, 'well-anchored labels and smooth motion should pass storyboard visual audit');

var visualBadLabel = worker.evaluateStoryboardVisualAuditResult({
  phaseAudits: [
    { phase: 'phase2', labels: [
      { visible: true, entity: 'UpgradeStation', entityRect: { x: 1 }, centerDx: 28, topGap: -35 }
    ] }
  ]
});
assert.strictEqual(visualBadLabel.passed, false, 'far-away visible labels must fail storyboard visual audit');
assert.ok(visualBadLabel.reason.indexOf('storyboard-label') >= 0);

var visualBadMotion = worker.evaluateStoryboardVisualAuditResult({
	  movementAudits: [
	    {
	      direction: 'down',
	      screenDx: 0.5,
	      screenDy: 18,
	      maxAbsStepPx: 12,
	      labelDirectionChecks: [{ dEntityY: 2.5, dLabelBottom: -2.4 }]
	    }
  ]
});
	assert.strictEqual(visualBadMotion.passed, false, 'jumpy motion and opposite-direction label movement must fail storyboard visual audit');
	assert.ok(visualBadMotion.reason.indexOf('storyboard-motion') >= 0 || visualBadMotion.reason.indexOf('storyboard-label-motion') >= 0);

	var visualBadDirection = worker.evaluateStoryboardVisualAuditResult({
	  movementAudits: [
	    {
	      direction: 'up',
	      screenDx: 0.2,
	      screenDy: 18,
	      maxAbsStepPx: 3,
	      labelDirectionChecks: [{ dEntityY: 2.5, dLabelBottom: 2.4 }]
	    }
	  ]
	});
	assert.strictEqual(visualBadDirection.passed, false, 'up drag that moves player down on screen must fail storyboard visual audit');
	assert.ok(visualBadDirection.reason.indexOf('storyboard-direction') >= 0);

	var visualBadClick = worker.evaluateStoryboardVisualAuditResult({
	  movementAudits: [
	    {
	      direction: 'right',
	      screenDx: 18,
	      screenDy: 0.2,
	      maxAbsStepPx: 3,
	      labelDirectionChecks: [{ dEntityY: 0.1, dLabelBottom: 0.1 }]
	    }
	  ],
	  clickAudits: [{ maxDisplacementPx: 4.5 }]
	});
	assert.strictEqual(visualBadClick.passed, false, 'click without drag that moves player must fail storyboard visual audit');
	assert.ok(visualBadClick.reason.indexOf('storyboard-click-zero') >= 0);

	var visualBadGuidanceLine = worker.evaluateStoryboardVisualAuditResult({
	  movementAudits: [
	    {
	      direction: 'right',
	      screenDx: 18,
	      screenDy: 0.2,
	      maxGuidanceLinePlayerDelta: 0.2,
	      maxAbsStepPx: 3,
	      labelDirectionChecks: [{ dEntityY: 0.1, dLabelBottom: 0.1 }]
	    }
	  ]
	});
	assert.strictEqual(visualBadGuidanceLine.passed, false, 'guidance line not anchored to visible player must fail storyboard visual audit');
	assert.ok(visualBadGuidanceLine.reason.indexOf('storyboard-guidance-line') >= 0);

	var visualBadLayer = worker.evaluateStoryboardVisualAuditResult({
	  visualLayerAudits: [
	    {
	      phase: 'phase1',
	      visibleNonOverlaySurfaceCount: 2,
	      visibleNonOverlaySurfaces: [
	        { name: 'GFM_Player', path: 'Root/GFM_Player' },
	        { name: '__SourceTargetRing', path: 'Root/__SourceTargetRing' }
	      ]
	    }
	  ]
	});
	assert.strictEqual(visualBadLayer.passed, false, 'legacy non-overlay renderers must fail storyboard visual audit');
	assert.ok(visualBadLayer.reason.indexOf('storyboard-visual-layer') >= 0);

	var visualBadPhysics = worker.evaluateStoryboardVisualAuditResult({
	  visualLayerAudits: [
	    {
	      phase: 'phase1',
	      activeLegacyPhysicsCount: 2,
	      activeLegacyPhysics: [
	        { name: '__Pool_Cube_Blue_01', path: 'Root/__LunaPool/__Pool_Cube_Blue_01' },
	        { name: '__SourceGround', path: 'Root/__SourceGround' }
	      ]
	    }
	  ]
	});
	assert.strictEqual(visualBadPhysics.passed, false, 'hidden legacy colliders must fail storyboard runtime audit');
	assert.ok(visualBadPhysics.reason.indexOf('storyboard-legacy-physics') >= 0);

	var visualBadEntitySet = worker.evaluateStoryboardVisualAuditResult({
	  phaseAudits: [
	    {
	      phase: 'phase1',
	      expectedVisibleEntities: ['Player', 'IceBlock', 'Astronaut', 'GoldUI'],
	      actualVisibleEntities: ['Player', 'Astronaut', 'MysteryCube', 'GoldUI'],
	      labels: []
	    }
	  ]
	});
	assert.strictEqual(visualBadEntitySet.passed, false, 'visible entity set drift must fail storyboard visual audit');
	assert.ok(visualBadEntitySet.reason.indexOf('storyboard-entity-visibility') >= 0);

	var visualBadTargetMarker = worker.evaluateStoryboardVisualAuditResult({
	  targetMarkerAudits: [
	    { phase: 'phase1', visible: false, targetName: '', reason: 'state-unavailable' }
	  ]
	});
	assert.strictEqual(visualBadTargetMarker.passed, false, 'missing visible destination marker must fail storyboard visual audit');
	assert.ok(visualBadTargetMarker.reason.indexOf('storyboard-target-marker') >= 0);

assert.strictEqual(
  worker.shouldRunStoryboardVideoAudit({}),
  true,
  'storyboard video audit should be on by default'
);
assert.strictEqual(
  worker.shouldRunStoryboardVideoAudit({ BLUEPRINT_SKIP_STORYBOARD_VIDEO_AUDIT: '1' }),
  false,
  'explicit skip should disable storyboard video audit'
);
assert.strictEqual(
  worker.shouldRunStoryboardVideoAudit({ BLUEPRINT_VOLC_VIDEO_AUDIT: '0' }),
  false,
  'global Volcengine video audit off switch should disable storyboard video audit'
);

assert.ok(
  playableAgentSrc.indexOf("await emitDomPointer('mousemove', x, y, 1)") >= 0 &&
    playableAgentSrc.indexOf('await page.waitForTimeout(35)') >= 0 &&
    playableAgentSrc.indexOf('for (let hold = 0; hold < 10; hold++)') >= 0,
  'dom-pointer video audit must keep pointer input active over time instead of dispatching all moves in one burst'
);

console.log('playableagent manual joystick probe tests passed');
