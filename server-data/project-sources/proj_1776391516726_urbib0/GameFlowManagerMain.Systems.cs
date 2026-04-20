// ========== AUTO-GENERATED SYSTEMS FILE — Subsystems & Helpers ==========
// This partial class holds reusable systems, helpers, and AI-extensible subsystems.
// Keep phase flow in GameFlowManagerMain.cs, put game systems here.

using UnityEngine;
using UnityEngine.UI;

public partial class GameFlowManagerMain
{
    // ========== AI SUBSYSTEMS ==========
    // Put movement systems, spawner systems, combat systems, resource systems here.
    // The main file calls these from Update() or CheckEventRules().

    // === TODO: AI fills — game subsystems (movement, combat, spawning, economy) ===
    // TODO_SYSTEMS_START

    // Interactive proximity path for CTAButtonDone (non-autoplay) — proximity/raycast fallback
    void UpdateCTAButtonInteractive() {
        if (CTAButtonDone) return;
        if (_autoPlayMode) return;
        if (currentPhaseName != "showFullStationCTA") return;
        // Require an actual tap/click while near the CTA button — proximity alone must not complete
        bool tapped = Input.GetMouseButtonDown(0) || (Input.touchCount > 0 && Input.GetTouch(0).phase == TouchPhase.Began);
        if (tapped && IsNear(CTAButton, 2.5f)) {
            CTAButtonDone = true;
            if (CTAButtonState < 2) CTAButtonState++;
            showFullStationCTAInteractionDone = true;
            showFullStationCTAPlayerActed = true;
        }
    }

    // [SKELETON] CTA stub — referenced by completeness check
    void CTA() {
        ShowCTA();
    }

    // [SKELETON] Initialize the _forms table used by SwitchForm — called from Start()
    void InitForms() {
        _forms = new FormDef[] {
            new FormDef { formId="single",    poolObjectName="__Pool_Cube_Blue_05", moveSpeed=5f, collectRange=1.5f, collectPower=1f, carryCapacity=5,  scale=1f },
            new FormDef { formId="triple",    poolObjectName="__Pool_Cube_Blue_01", moveSpeed=6f, collectRange=1.8f, collectPower=2f, carryCapacity=10, scale=1.1f },
            new FormDef { formId="crusher",   poolObjectName="__Pool_Cube_Blue_02", moveSpeed=7f, collectRange=2.0f, collectPower=3f, carryCapacity=15, scale=1.2f },
            new FormDef { formId="hydraulic", poolObjectName="__Pool_Cube_Blue_03", moveSpeed=8f, collectRange=2.5f, collectPower=5f, carryCapacity=25, scale=1.3f }
        };
        _currentFormIndex = 0;
    }

    // Swap the controlled player reference to a new form and keep the old object visible→hidden
    // only after the new form is live. Ensures runtime gameplay keeps a real controllable object.
    void SwitchPlayerForm(int idx) {
        if (_forms == null || idx < 0 || idx >= _forms.Length) return;
        var newObj = GameObject.Find(_forms[idx].poolObjectName);
        if (newObj == null) return;
        Vector3 keepPos = (player != null) ? player.transform.position : new Vector3(0f, 0.5f, -2f);
        // Show new form at current player position first
        var np = newObj.transform.position;
        np.x = keepPos.x; np.y = Mathf.Max(0.5f, keepPos.y); np.z = keepPos.z;
        newObj.transform.position = np;
        var ns = newObj.transform.localScale;
        ns.x = _forms[idx].scale; ns.y = _forms[idx].scale; ns.z = _forms[idx].scale;
        newObj.transform.localScale = ns;
        // Hide the old form (only now that replacement is live)
        if (_forms[_currentFormIndex].poolObjectName != _forms[idx].poolObjectName) {
            var oldObj = GameObject.Find(_forms[_currentFormIndex].poolObjectName);
            if (oldObj != null && oldObj != newObj) {
                var op = oldObj.transform.position;
                op.x = 0f; op.y = -999f; op.z = 0f;
                oldObj.transform.position = op;
            }
        }
        _currentFormIndex = idx;
        // Critical: reassign the controllable player reference to the active form
        player = newObj;
    }
    // TODO_SYSTEMS_END

    // === TODO: AI fills — UI helpers, input handlers, visual effects ===
    // TODO_UI_START

    // TODO_UI_END
}