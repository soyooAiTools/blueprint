function escapeCsString(value) {
  return String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function resourceIdExpr(value) {
  var id = String(value == null ? '' : value).trim();
  if (!id) return '""';
  if (/^gold$/i.test(id)) return 'GFM_ResourceIds.Gold';
  if (/^rocketdebris$/i.test(id)) return 'GFM_ResourceIds.RocketDebris';
  return 'GFM_ResourceIds.Normalize("' + escapeCsString(id) + '")';
}

module.exports = {
  escapeCsString: escapeCsString,
  resourceIdExpr: resourceIdExpr,
};
