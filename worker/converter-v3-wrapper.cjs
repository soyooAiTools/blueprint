// Wrapper: expose convertV3() for worker-client.js
// Delegates to converter-v3.cjs logic inline (no child_process needed)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function convertV3(stage4Dir, outputDir, options = {}) {
  const { stripModules = [], outputName = 'playable_v3' } = options;
  
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  // 1. Read iframe.html
  let html = fs.readFileSync(path.join(stage4Dir, 'iframe.html'), 'utf8');

  // 2. Collect non-JS files for fileDict
  function walkFiles(dir) {
    const result = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) result.push(...walkFiles(full));
      else result.push(full);
    }
    return result;
  }

  const allFiles = walkFiles(stage4Dir);
  const fileDict = {};

  for (const fp of allFiles) {
    const rel = path.relative(stage4Dir, fp).replace(/\\/g, '/');
    const ext = path.extname(fp).toLowerCase();
    if (['.html', '.css'].includes(ext)) continue;
    if (ext === '.js') continue;
    
    if (['.json'].includes(ext)) {
      fileDict[rel] = { t: 'j', d: fs.readFileSync(fp, 'utf8') };
    } else if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) {
      const mime = ext === '.jpg' ? 'image/jpeg' : `image/${ext.slice(1)}`;
      fileDict[rel] = { t: 'i', d: fs.readFileSync(fp).toString('base64'), m: mime };
    } else if (['.blob', '.bin', '.dat'].includes(ext)) {
      fileDict[rel] = { t: 'b', d: fs.readFileSync(fp).toString('base64') };
    }
  }

  // 3. Build interceptor
  const interceptor = `<script>
window.DEVELOP=true;window.TRACE=false;window.TESTS=false;window.DEBUG=false;window.FORCE_STABLE_RANDOM_SEED=false;
window.MODULE_physics3d=true;window.MODULE_physics2d=true;window.MODULE_particle_system=true;
window.MODULE_reflection=true;window.MODULE_prefabs=true;window.MODULE_mecanim=true;
(function(){
var __fd = ${JSON.stringify(fileDict).replace(/<(\/?)script/gi, '\\x3c$1script')};
function b2ab(b){var s=atob(b),a=new Uint8Array(s.length);for(var i=0;i<s.length;i++)a[i]=s.charCodeAt(i);return a.buffer}
function findEntry(url){
  var fn=url;if(!fn)return null;
  if(fn.startsWith('./'))fn=fn.slice(2);
  if(fn.startsWith('/'))fn=fn.slice(1);
  fn=fn.replace(/\\\\/g,'/');
  if(__fd[fn])return __fd[fn];
  var parts=['assets','js','engine','favicon'];
  for(var p=0;p<parts.length;p++){var idx=fn.indexOf(parts[p]+'/');if(idx>-1){var k=fn.slice(idx);if(__fd[k])return __fd[k]}}
  return null;
}
var _xhrOpen=XMLHttpRequest.prototype.open,_xhrSend=XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open=function(m,url){this.__url=url;this.__orig=arguments;_xhrOpen.apply(this,arguments)};
XMLHttpRequest.prototype.send=function(){
  var url=this.__url;
  if(url&&(url.startsWith('http://')||url.startsWith('https://')||url.startsWith('blob:')||url.startsWith('data:')))return _xhrSend.apply(this,arguments);
  var item=findEntry(url);
  if(!item){return _xhrSend.apply(this,arguments)}
  var self=this;
  setTimeout(function(){
    var data;
    if(item.t==='j'){
      if(self.responseType==='json')try{data=JSON.parse(item.d)}catch(e){data=item.d}
      else if(self.responseType==='arraybuffer'){var enc=new TextEncoder();data=enc.encode(item.d).buffer}
      else data=item.d;
    }else if(item.t==='b'||item.t==='i'){
      data=b2ab(item.d);
    }
    Object.defineProperty(self,'readyState',{get:function(){return 4}});
    Object.defineProperty(self,'status',{get:function(){return 200}});
    Object.defineProperty(self,'response',{get:function(){return data}});
    if(typeof data==='string')Object.defineProperty(self,'responseText',{get:function(){return data}});
    if(self.onreadystatechange)self.onreadystatechange();
    if(self.onload)self.onload();
  },0);
};
var _fetch=window.fetch;
window.fetch=function(url,opts){
  if(url&&typeof url==='string'&&(url.startsWith('http://')||url.startsWith('https://')||url.startsWith('blob:')||url.startsWith('data:')))return _fetch.apply(this,arguments);
  var item=findEntry(typeof url==='string'?url:'');
  if(!item)return _fetch.apply(this,arguments);
  var data=item.d;
  return Promise.resolve({ok:true,status:200,headers:new Headers(),
    text:function(){return Promise.resolve(data)},
    json:function(){return Promise.resolve(typeof data==='string'?JSON.parse(data):data)},
    arrayBuffer:function(){return Promise.resolve(item.t==='j'?new TextEncoder().encode(data).buffer:b2ab(data))}
  });
};
var _imgSet=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src')||Object.getOwnPropertyDescriptor(Image.prototype,'src');
if(_imgSet&&_imgSet.set){
  Object.defineProperty(HTMLImageElement.prototype,'src',{
    get:_imgSet.get,
    set:function(v){
      if(!v||v.startsWith('http')||v.startsWith('blob:')||v.startsWith('data:')){_imgSet.set.call(this,v);return}
      var item=findEntry(v);
      if(item&&item.t==='i'){_imgSet.set.call(this,'data:'+item.m+';base64,'+item.d)}
      else{_imgSet.set.call(this,v)}
    },enumerable:true,configurable:true
  });
}
})();
<\/script>`;

  // 4. Inject interceptor after <body>
  html = html.replace('<body>', '<body>' + interceptor);

  // 5. Replace external script src with inline content
  let strippedSize = 0;
  html = html.replace(/<script\s+src="([^"]+)"(?:\s+defer="defer")?(?:\s+type="text\/javascript")?><\/script>/g, (match, src) => {
    const normalizedSrc = src.replace(/\\/g, '/');
    const basename = path.basename(normalizedSrc, '.js');
    
    // Strip unwanted modules
    if (stripModules.some(mod => basename.toLowerCase().includes(mod.toLowerCase()))) {
      const fp = path.join(stage4Dir, normalizedSrc);
      if (fs.existsSync(fp)) strippedSize += fs.statSync(fp).size;
      return `<script>/* STRIPPED: ${normalizedSrc} */\n<\/script>`;
    }
    
    const fp = path.join(stage4Dir, normalizedSrc);
    if (fs.existsSync(fp)) {
      let content = fs.readFileSync(fp, 'utf8');
      content = content.replace(/<(\/?)script/gi, '\\x3c$1script');
      return `<script>/* ${normalizedSrc} */\n${content}\n<\/script>`;
    }
    return match;
  });

  // 6. Write output
  const outPath = path.join(outputDir, `${outputName}.html`);
  fs.writeFileSync(outPath, html);

  const rawSize = fs.statSync(outPath).size;
  const gzSize = zlib.gzipSync(fs.readFileSync(outPath)).length;
  const rawMB = (rawSize / 1024 / 1024).toFixed(2);
  const gzipMB = (gzSize / 1024 / 1024).toFixed(2);

  return { outPath, rawSize, gzSize, rawMB, gzipMB, strippedSize };
}

module.exports = { convertV3 };
