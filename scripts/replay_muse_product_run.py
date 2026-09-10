"""Exercise the installed product path with existing donor evidence and no provider calls."""
import json,sys,tempfile,shutil,base64,subprocess
from pathlib import Path
r=Path(__file__).resolve().parents[1];sys.path.insert(0,str(r))
import argparse
parser=argparse.ArgumentParser(description='Unpaid central product replay with an injected recorded donor; outputs stay beside the application.')
parser.add_argument('--gallery',type=Path,required=True)
parser.add_argument('--report',type=Path,required=True)
args=parser.parse_args()
from qwen_ui_pipeline.muse_adapter import invoke_muse_kernel
source=args.gallery.resolve()
app=Path(tempfile.mkdtemp(prefix='.muse-central-smoke-',dir=source)); print(app,flush=True)
cli=str(r/'bin/image-pipeline')
def call(*args): return json.loads(subprocess.check_output([cli,*args],text=True))
product=call('product','--application',str(app),'--output','product-work','--seed','3','--mode','anti-solution','--strategy','catalog-pair')
prepared=call('prepare','--application',str(app),'--recipe',product['recipe'],'--unit-cost','0.01','--budget','0.01')
planned=call('image','--application',str(app),'--objective',prepared['objective']);assert planned['_tag']=='Planned'
no_key=subprocess.run([cli,'image','--application',str(app),'--objective',prepared['objective'],'--execute'],env={'PATH':'/usr/bin:/bin'},capture_output=True)
assert no_key.returncode==2 and not (app/'artifacts/image-generation/runs').exists()
old_home=source/'docs/prototypes/issue-41-invented-product-gallery';run=json.loads((old_home/'attempts/001/run.json').read_text());raw=(source/run['images'][0]['file']).read_bytes()
class Client:
 def generate(self,request):
  assert request['prompt']==(old_home/'attempts/001/prompt.txt').read_text()
  assert 'input_references' not in request
  return {'data':[{'b64_json':base64.b64encode(raw).decode()}],'usage':{'cost':0.01}}
fixture=invoke_muse_kernel({'adapter_protocol_version':'1','operation':'invoke','provider':'openrouter','model':'meta/muse-image','objective':(app/'product-work/prompt.txt').read_text(),'requested_count':1,'parameters':{'size':'1760x1440'},'references':[]},client=Client())
(app/'injected-recorded-response.json').write_text(json.dumps(fixture))
node='''import fs from 'node:fs';const [tool,app,objective]=process.argv.slice(1);const {Effect}=await import(tool+'/node_modules/effect/dist/index.js');const c=await import(tool+'/modules/conductor/index.js');const g=await import(tool+'/modules/generation/index.js');const rr=await import(tool+'/modules/run-record/index.js');const refs=await import(tool+'/modules/reference-planning/index.js');const identity=await Effect.runPromise(c.filePlanningIdentity(tool));const files=await Effect.runPromise(c.fileApplicationFiles(app));const planned=await Effect.runPromise(c.plan({objectivePath:objective}).pipe(Effect.provideService(c.ApplicationFiles,files),Effect.provideService(c.PlanningIdentity,identity),Effect.provideService(c.MediaInspector,refs.pythonImageInspector(tool))));if(planned._tag!=='Planned')throw Error(JSON.stringify(planned));const fixture=JSON.parse(fs.readFileSync(app+'/injected-recorded-response.json'));let calls=0;const adapter=g.inheritedQwenAdapter({exchange:()=>Effect.sync(()=>{calls++;return Buffer.from(JSON.stringify(fixture))})});const layer=await Effect.runPromise(rr.fileRunRecordLayer(app));const result=await Effect.runPromise(c.advance({run:planned.run}).pipe(Effect.provideService(c.ApplicationFiles,files),Effect.provideService(c.PlanningIdentity,identity),Effect.provideService(g.GenerationAdapter,adapter),Effect.provide(layer),Effect.provideService(rr.RunRecordClock,{now:()=>Effect.succeed(new Date().toISOString())})));if(result._tag!=='HumanDecisionRequired'||calls!==1)throw Error(JSON.stringify(result));console.log(JSON.stringify({runId:result.runId,paidCalls:0,fixtureExchanges:calls}));'''
executed=json.loads(subprocess.check_output(['node','--input-type=module','-e',node,str((r/'.tool-current').resolve()),str(app),prepared['objective']],text=True))
exported=call('export-donor','--application',str(app),'--run',executed['runId'],'--recipe',product['recipe'],'--output','donors')
proof=json.loads((r/'docs/research/issue-91-source-replay.json').read_text());recipe=json.loads(Path(proof['assembly']['savedRecipe']).read_text());layouts=json.loads((source/recipe['layouts']).read_text())
for rel in [recipe['layouts'],layouts['kodak']['source']]:
 dest=app/rel;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source/rel,dest)
import hashlib
recipe.update(donorHome='donors',outputHome='assembled',inputHashes={**exported['inputHashes'],**{rel:hashlib.sha256((app/rel).read_bytes()).hexdigest() for rel in [recipe['layouts'],layouts['kodak']['source']]}})
(app/'assembly-recipe.json').write_text(json.dumps(recipe))
assembled=call('assemble','--application',str(app),'--recipe','assembly-recipe.json')
record=json.loads(Path(assembled['fullRecord']).read_text())['records'][0];assert record['outputSha256']==proof['assembly']['outputSha256'];assert record['accepted'] is False
# Reopening the existing recorded run needs no credential and must not attempt dispatch.
report=call('image','--application',str(app),'--objective',prepared['objective'],'--execute','--run',executed['runId'])
assert report['cost']=='0.010000';assert report['result'][0]['path'].startswith(str(app));assert report['checks']['visualReview']=='unverified'
result={'application':str(app),'paidCalls':0,'injectedRecordedResponse':True,'runId':executed['runId'],'pipeline':['product','prepare','plan','advance with recorded response','export-donor','assemble','resume without key'],'outputSha256':record['outputSha256'],'checks':assembled['checks'],'compactReport':report,'savedAssemblyRecipe':str(app/'assembly-recipe.json')}
args.report.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
