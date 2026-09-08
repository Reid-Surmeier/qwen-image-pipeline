// Real-input smoke check for the throwaway prototype; uses the atlas's installed browser.
import { chromium } from '/home/reidsurmeier/orca/workspaces/Qwen Image pipeline/stargazer/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const out = new URL('./evidence/', import.meta.url);
await fs.mkdir(out, {recursive:true});
const browser = await chromium.launch({headless:true,args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
 const page = await browser.newPage({viewport:{width:1200,height:800}});
 const errors=[];
 page.on('pageerror',e=>errors.push(String(e)));
 page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.goto(process.argv[2] || 'https://windows-wsl.taile06c45.ts.net/image-viewer-prototype-01a08108/');
 await page.waitForFunction(()=>window.imageViewer?.scroll_max>0,{timeout:60000});
 const state=()=>page.evaluate(()=>window.imageViewer);
 const settle=()=>page.waitForTimeout(250);
 const shot=name=>page.screenshot({path:new URL(name+'.png',out).pathname});
 const drag=async(x,y,dx,dy)=>{await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+dx,y+dy,{steps:12});await page.mouse.up();await settle();};
 const initial=await state();await shot('01-initial');
 const sizes=s=>s.cards.map(c=>c.slice(2));
 const check=s=>{
  assert.equal(s.cards.length,7);assert.deepEqual(s.bars_visible,[false,false]);assert.equal(s.horizontal_scroll,0);
  assert.deepEqual(sizes(s),sizes(initial));
  for(const [x,y,w,h] of s.cards){assert(x>=0 && y>=0);assert(x+w<=s.content_size[0]+1);assert(y+h<=s.content_size[1]+1);}
  for(let i=0;i<s.cards.length;i++)for(let j=i+1;j<s.cards.length;j++){
   const [x,y,w,h]=s.cards[i], [a,b,c,d]=s.cards[j];
   assert(x+w<=a || a+c<=x || y+h<=b || b+d<=y,'artwork cards overlap');
  }
 };
 check(initial);
 await page.mouse.move(450,350);await page.mouse.wheel(0,5000);await settle();
 const bottom=await state();assert(bottom.scroll>0);assert.equal(bottom.scroll,Math.floor(bottom.scroll_max));await shot('02-scrolled-bottom');
 await page.mouse.wheel(0,-5000);await settle();assert.equal((await state()).scroll,0);
 await page.mouse.wheel(5000,0);await settle();assert.equal((await state()).horizontal_scroll,0);
 await drag(initial.position[0]+initial.size[0]-10,initial.position[1]+initial.size[1]-10,-530,-160);
 const small=await state();check(small);assert(small.size[0]<initial.size[0]);assert(small.size[1]<initial.size[1]);assert(small.content_size[1]>initial.content_size[1]);await shot('03-resized');
 await page.mouse.move(300,200);await page.mouse.wheel(0,10000);await settle();
 const smallBottom=await state();check(smallBottom);assert.equal(smallBottom.scroll,Math.floor(smallBottom.scroll_max));await shot('03-resized-bottom');
 await drag(small.position[0]+160,small.position[1]+22,100,65);
 const moved=await state();assert(moved.position[0]>small.position[0]);assert(moved.position[1]>small.position[1]);await shot('04-dragged');
 await drag(moved.position[0]+moved.size[0]-10,moved.position[1]+moved.size[1]-10,240,175);
 const expanded=await state();check(expanded);assert(expanded.size[1]>small.size[1]);assert(expanded.scroll<=expanded.scroll_max);await shot('05-expanded');
 await page.setViewportSize({width:600,height:800});await settle();
 const narrow=await state();check(narrow);assert(narrow.position[0]+narrow.size[0]<=600);await shot('06-narrow');
 await page.setViewportSize({width:400,height:800});await settle();
 const phone=await state();check(phone);await shot('07-single-column');
 await page.mouse.move(200,300);await page.mouse.wheel(0,20000);await settle();
 const phoneBottom=await state();check(phoneBottom);assert.equal(phoneBottom.scroll,Math.floor(phoneBottom.scroll_max));await shot('08-single-column-bottom');
 assert.deepEqual(errors,[]);
 await fs.writeFile(new URL('playtest.json',out),JSON.stringify({passed:true,initial,bottom,small,smallBottom,moved,expanded,narrow,phone,phoneBottom,errors},null,2));
 console.log('PASS: seven fixed-size cards wrap without overlap/clipping; hidden bars; vertical scrolling only; drag, resize, desktop and single-column phone; no browser/engine errors.');
} finally {await browser.close();}
