// Isolated, generated library for reproducible cold/reload/new-tab comparisons.
// No user music, no external network, no persistent user settings are read here.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(process.argv[2] || 'dist');
const port = Number(process.argv[3] || 5403);
const cover = await fs.readFile('/tmp/rhine-v040-startup/cover.jpg');
const albums = Array.from({length:96},(_,i)=>({id:`perf-${i}`,title:`性能样本 ${String(i+1).padStart(3,'0')}`,artist:`测试歌手 ${Math.floor(i/12)+1}`,genreId:`genre-${Math.floor(i/12)}`,coverUrl:`/fixture-cover/${i}.jpg`,year:2026,rawGenres:[],folder:'Generated performance fixture',tracks:[],producers:[],offline:false}));
const library={version:1,albums,genres:Array.from({length:8},(_,i)=>({id:`genre-${i}`,name:`测试分类 ${i+1}`})),roots:[],scan:{running:false},onlineEnabled:false};
const probe=`<script>
(()=>{
const el=document.createElement('output');el.id='startup-review';el.hidden=true;document.body.append(el);
let prev=0,start=0,samples=[],history=[],last=0;
function frame(now){if(document.hidden){prev=0;start=0;samples=[];requestAnimationFrame(frame);return}
if(!start)start=now;if(prev)samples.push(now-prev);prev=now;
if(now-last>1000){const sorted=[...samples].sort((a,b)=>a-b),at=q=>+(sorted[Math.min(sorted.length-1,Math.floor(sorted.length*q))]||0).toFixed(2);
const item={at:+(now/1000).toFixed(2),fps:samples.length?+(1000*samples.length/samples.reduce((a,b)=>a+b,0)).toFixed(1):0,p50:at(.5),p95:at(.95),max:at(1),over50:samples.filter(x=>x>50).length,phase:document.querySelector('.music-app')?.dataset.musicBoot||'loading',quality:document.querySelector('#three-scene')?.dataset.renderQuality,stats:document.querySelector('#three-scene')?.dataset.renderStats,timing:document.querySelector('#three-scene')?.dataset.frameTiming};history.push(item);if(history.length>80)history.splice(50,1);el.dataset.samples=JSON.stringify(history);samples=[];last=now;}
requestAnimationFrame(frame)}requestAnimationFrame(frame);
})();</script>`;
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.woff2':'font/woff2','.glb':'model/gltf-binary','.json':'application/json','.ogg':'audio/ogg','.mp3':'audio/mpeg'};
http.createServer(async(req,res)=>{try{
const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
res.setHeader('Cache-Control','no-store');
if(pathname.startsWith('/fixture-cover/')){res.setHeader('Content-Type','image/jpeg');res.end(cover);return}
if(pathname.startsWith('/api/')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(pathname==='/api/library'?library:pathname==='/api/audio/capabilities'?{decoderAvailable:false,nativeAvailable:false,devices:[]}:{}));return}
const target=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));if(!target.startsWith(root+path.sep)){res.writeHead(403);res.end();return}
let data=await fs.readFile(target);if(target.endsWith('index.html'))data=Buffer.from(data.toString().replace('</body>',probe+'</body>'));
res.setHeader('Content-Type',mime[path.extname(target)]||'application/octet-stream');res.end(data);
}catch{res.writeHead(404);res.end('not found')}}).listen(port,'127.0.0.1',()=>console.log(`Startup review: http://127.0.0.1:${port} — 96 generated 2048px covers; ${root}`));
