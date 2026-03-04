const http = require('http');
http.get('http://localhost:3901/api/projects/proj_1772461528991_tqa3gq', res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    const p = JSON.parse(d);
    console.log('frames:', (p.storyboardFrames || []).length);
    (p.storyboardFrames || []).slice(0, 3).forEach((f, i) => console.log('  ', i, f.id, f.title));
  });
});
