// Form-switch state is fully handled by skeleton-generator.cjs:
//   - struct FormDef + FormDef[] _forms
//   - int _currentFormIndex
//   - void SwitchForm(int)
//   - GetCollectPower / GetCollectRange / GetCarryCapacity getters
// This template previously emitted shadow variables (currentFormIndex,
// <formId>Unlocked) plus comment-only update bodies that no other code
// consumed. They've been removed to stop polluting the C# output and to
// surface a single source of truth for form state.

function generateUpgradeVariables(/* schema */) {
  return '';
}

function generateUpgradeUpdate(/* schema */) {
  return '';
}

module.exports = {
  generateUpgradeUpdate: generateUpgradeUpdate,
  generateUpgradeVariables: generateUpgradeVariables
};
