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
 await page.mouse.move(450,350);await page.mouse.wheel(0,5000);await settle();
 const bottom=await state();assert(bottom.scroll>0);assert.equal(bottom.scroll,Math.floor(bottom.scroll_max));await shot('02-scrolled-bottom');
 await page.mouse.wheel(0,-5000);await settle();assert.equal((await state()).scroll,0);
 // Drag the visible native scrollbar thumb to the end of its track.
 const barX=initial.position[0]+initial.size[0]-11;
 await drag(barX,100,0,410);assert((await state()).scroll>0);
 await drag(initial.position[0]+initial.size[0]-10,initial.position[1]+initial.size[1]-10,-130,-160);
 const small=await state();assert(small.size[0]<initial.size[0]);assert(small.size[1]<initial.size[1]);assert.deepEqual(small.content_size,initial.content_size);await shot('03-resized');
 await drag(small.position[0]+160,small.position[1]+22,100,65);
 const moved=await state();assert(moved.position[0]>small.position[0]);assert(moved.position[1]>small.position[1]);await shot('04-dragged');
 await drag(moved.position[0]+moved.size[0]-10,moved.position[1]+moved.size[1]-10,240,175);
 const expanded=await state();assert(expanded.size[1]>small.size[1]);assert.deepEqual(expanded.content_size,initial.content_size);assert(expanded.scroll<=expanded.scroll_max);await shot('05-expanded');
 await page.setViewportSize({width:600,height:800});await settle();
 const narrow=await state();assert(narrow.position[0]+narrow.size[0]<=600);await shot('06-narrow');
 assert.deepEqual(errors,[]);
 await fs.writeFile(new URL('playtest.json',out),JSON.stringify({passed:true,initial,bottom,small,moved,expanded,narrow,errors},null,2));
 console.log('PASS: wheel stops, scrollbar drag, resize without artwork stretch, title drag, expansion and narrow viewport; no browser/engine errors.');
} finally {await browser.close();}
