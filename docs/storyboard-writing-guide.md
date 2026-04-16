# Storyboard Writing Guide

## Core Concept: Visual Frame != Code Phase

- **Visual Frame**: Each shot/camera angle in the storyboard. Unlimited count.
- **Code Phase**: Actual stage in generated code. **Max 10**.
- Multiple visual frames can map to one code phase (sequential shots within one stage).

## Complexity Budget Table (Required)

Every storyboard MUST include this table:

| Dimension | Budget | Weight | Your Value |
|---|---|---|---|
| Code Phases | soft <=10 | x10 | |
| Control Modes | soft <=2 | x40 | |
| Economic Layers | no hard cap | x20 | |
| Stateful Entities | soft <=8 | x5 | |
| Form Switches | soft <=3 | x15 | |
| **Total** | **<=200 safe / <=250 warn / >250 blocked** | | |

Formula: `(phases*10) + (modes*40) + (econ*20) + (entities*5) + (forms*15)`

## Four Hard Rules

1. **One control mode runs the whole game** — Form switches change visuals and stats only, not control scheme
2. **Merge similar entities** — Drill/CrusherCar/HydraulicCar = 1 entity with 3-level state
3. **Draw economic chain diagram** — ResourceA -> ResourceB -> Consumption. Layer count feeds budget
4. **Tag every frame with phaseId** — Mark which frames share the same code phase

## Frame-to-Phase Mapping Template

| Visual Frame | Code Phase | Notes |
|---|---|---|
| Frame 1: Tutorial | phase_1_tutorial | - |
| Frame 2: First collect | phase_1_tutorial | Same phase, second shot |
| Frame 3: Sell at base | phase_2_sell | New phase |

## What Counts as a Control Mode

- Drag-to-move (joystick/tap): 1 mode
- Click-to-build/upgrade: NOT a separate mode (point interaction)
- Vehicle driving: NOT separate IF using form-switch (same drag-to-move, different stats)
- Tower defense placement: 1 mode (drag-and-drop)
- Swipe/gesture: 1 mode

## Economic Layer Examples

- 1 layer: Mine -> Gold -> Buy buildings
- 2 layers: Chop trees -> Planks -> Gold -> Buy buildings
- 3 layers: Mine ore -> Smelt ingots -> Sell ingots -> Gold -> Buy buildings
