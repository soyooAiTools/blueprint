/**
 * Normalize blueprint/project entity + phase payloads so all code paths can
 * safely rely on both top-level arrays and blueprint nested arrays.
 */

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function cloneJson(value, fallback) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (e) {
    return fallback;
  }
}

function hasItems(value) {
  return Array.isArray(value) && value.length > 0;
}

function deriveEntitiesFromNodes(nodes) {
  return toArray(nodes)
    .filter(function(node) { return node && node.type === 'entityNode'; })
    .map(function(node) {
      var data = cloneJson(node.data || {}, {});
      if (!data.name) data.name = node.id || '';
      if (!data.label && data.showLabel) data.label = data.showLabel;
      if (!data.template) data.template = 'Static';
      if (!data.visual || typeof data.visual !== 'object') data.visual = {};
      if (!data.spawn || typeof data.spawn !== 'object') data.spawn = {};
      if (!data.trigger || typeof data.trigger !== 'object') data.trigger = {};
      if (!Array.isArray(data.actions)) data.actions = [];
      if (!data.behavior || typeof data.behavior !== 'object') data.behavior = {};
      return data;
    })
    .filter(function(entity) { return !!entity.name; });
}

function derivePhasesFromNodes(nodes) {
  return toArray(nodes)
    .filter(function(node) { return node && node.type === 'phaseNode'; })
    .map(function(node, index) {
      var data = cloneJson(node.data || {}, {});
      if (data.id === undefined || data.id === null || data.id === '') data.id = index + 1;
      if (!data.name) data.name = 'Phase ' + (index + 1);
      if (!Array.isArray(data.activate)) data.activate = [];
      if (!data.endCondition) data.endCondition = '';
      if (!data.guide) data.guide = '';
      if (!data.camera || typeof data.camera !== 'object') data.camera = {};
      return data;
    });
}

function normalizeProjectBlueprint(project) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) return project;

  project.blueprint = project.blueprint && typeof project.blueprint === 'object' && !Array.isArray(project.blueprint)
    ? project.blueprint
    : {};
  var blueprint = project.blueprint;

  blueprint.nodes = toArray(blueprint.nodes);
  blueprint.edges = toArray(blueprint.edges);
  if (!blueprint.projectName && project.name) blueprint.projectName = project.name;

  var derivedEntities = deriveEntitiesFromNodes(blueprint.nodes);
  var derivedPhases = derivePhasesFromNodes(blueprint.nodes);

  var canonicalEntities = hasItems(blueprint.entities)
    ? blueprint.entities
    : hasItems(project.entities)
      ? project.entities
      : derivedEntities;
  var canonicalPhases = hasItems(blueprint.phases)
    ? blueprint.phases
    : hasItems(project.phases)
      ? project.phases
      : derivedPhases;

  blueprint.entities = cloneJson(toArray(canonicalEntities), []);
  project.entities = cloneJson(toArray(canonicalEntities), []);
  blueprint.phases = cloneJson(toArray(canonicalPhases), []);
  project.phases = cloneJson(toArray(canonicalPhases), []);

  if ((!blueprint.globalSettings || typeof blueprint.globalSettings !== 'object' || Array.isArray(blueprint.globalSettings)) &&
      project.globalSettings && typeof project.globalSettings === 'object' && !Array.isArray(project.globalSettings)) {
    blueprint.globalSettings = cloneJson(project.globalSettings, {});
  } else if ((!project.globalSettings || typeof project.globalSettings !== 'object' || Array.isArray(project.globalSettings)) &&
      blueprint.globalSettings && typeof blueprint.globalSettings === 'object' && !Array.isArray(blueprint.globalSettings)) {
    project.globalSettings = cloneJson(blueprint.globalSettings, {});
  }

  return project;
}

module.exports = {
  deriveEntitiesFromNodes: deriveEntitiesFromNodes,
  derivePhasesFromNodes: derivePhasesFromNodes,
  normalizeProjectBlueprint: normalizeProjectBlueprint,
};
