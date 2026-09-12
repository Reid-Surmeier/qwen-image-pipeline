#!/usr/bin/env python3
"""Unpaid original/port comparison using existing application-owned evidence.

No source checkout is needed by normal image-pipeline invocation. This explicit
comparison harness reads pinned original code; every output is beside its app.
"""
import argparse
import base64
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from PIL import Image
import numpy as np
from qwen_ui_pipeline.muse_adapter import invoke_muse_kernel, recover_muse_kernel
from qwen_ui_pipeline.muse_recipe import prepare
from qwen_ui_pipeline.muse_assembly_host import assemble, SETTINGS


def digest(raw): return hashlib.sha256(raw).hexdigest()
def load(path): return json.loads(path.read_text())
def original(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('gallery', 'edit', 'composite', 'composite-source', 'report'):
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    results = {'paidCalls':0,'procedures':{}}
    fixture = io.BytesIO(); Image.new('RGB',(1,1),(12,34,56)).save(fixture,'WEBP',lossless=True)
    captured = []
    class Client:
        def __init__(self,*args,**kwargs): pass
        def generate(self, request):
            captured.append(request)
            return {'data':[{'b64_json':base64.b64encode(fixture.getvalue()).decode()}], 'usage':{'cost':0.01}}
    def port_request(app, recipe, scratch):
        recipe_path = scratch/'recipe.json'; recipe_path.write_text(json.dumps(recipe))
        plan = prepare(app,str(recipe_path.relative_to(app)))
        refs = []
        for index,item in enumerate(plan['references']):
            path=app/item['path']; raw=path.read_bytes()
            with Image.open(path) as image: media=Image.MIME[image.format]
            refs.append({'slot':str(index),'application_path':item['path'],'sha256':digest(raw),'payload_destination':f'/input_references/{index}/image_url/url','media_type':media,'bytes_base64':base64.b64encode(raw).decode()})
        result = invoke_muse_kernel({'adapter_protocol_version':'1','operation':'invoke','provider':'openrouter','model':'meta/muse-image','objective':plan['prompt'],'requested_count':1,'parameters':{'size':plan['size']},'references':refs},client=Client())
        recovered = recover_muse_kernel({'adapter_protocol_version':'1','operation':'recover','model':'meta/muse-image','provider_evidence':result['provider_evidence']})
        assert recovered == result
        return captured.pop()

    # Run the original edit wrapper with a fake client and isolated application output HOME.
    app=args.edit.resolve(); source=app/'tools/prototypes/muse_eink_curve/generate.py'
    assert digest(source.read_bytes()) == 'afdc48a8c8bf1ff0008839fa81077955cf58fd6bfa3f89af4b29c3445d9c1d44'
    old=original(source,'original_edit'); scratch=Path(tempfile.mkdtemp(prefix='.muse-request-replay-',dir=app))
    plan_path='docs/prototypes/issue-63-eink-surface-integration/muse/generation-preflight-v7.json'
    shutil.copyfile(app/plan_path,scratch/'preflight.json'); old.ROOT=app; old.HOME=scratch
    with patch.object(old,'OpenRouterImageClient',Client), patch.dict(os.environ,{'OPENROUTER_API_KEY':'unpaid-injected-client'}), patch.object(sys,'argv',['replay','--preflight','preflight.json','--attempt','005']), contextlib.redirect_stdout(io.StringIO()):
        assert old.main()==0
    expected=captured.pop(); actual=port_request(app,{'procedure':'edit','plan':plan_path,'attempt':'005'},scratch)
    assert actual==expected
    results['procedures']['edit']={'exactRequest':True,'orderedReferences':len(actual['input_references']),'promptSha256':digest(actual['prompt'].encode()),'unpaidRecoveryEqual':True}

    app=args.composite.resolve(); source=args.composite_source.resolve()/'tools/ad_composite.py'
    assert digest(source.read_bytes()) == '8a60f623fda4ffd1edf9125088cf4f140ef82f3b1fb96e810a9806aac9f76d80'
    old=original(source,'original_composite'); old.ROOT=app
    spec_path='docs/batches/03/00-skechers-concourse/spec.json'; spec=load(app/spec_path)
    scratch=Path(tempfile.mkdtemp(prefix='.muse-request-replay-',dir=app))
    prior=app/Path(spec_path).parent/'attempts/001/image-01.png'
    for refine in [False,True]:
        prompt=(spec.get('refine_prompt') or old.REFINE) if refine else spec['prompt']+'\n\n'+old.FORBID
        refs=[prior] if refine else [old.resolve_ref(token,(app/spec_path).parent) for token in spec['references']]
        old.run(Client(),prompt,refs,spec['size'],scratch,'replay')
        expected=captured.pop(); recipe={'procedure':'dis-composite','spec':spec_path}
        if refine: recipe['refineFrom']=str(prior.relative_to(app))
        actual=port_request(app,recipe,scratch); assert actual==expected
        if not refine: assert digest(actual['prompt'].encode()) == load(prior.parent/'run.json')['prompt_sha256']
        results['procedures']['refinement' if refine else 'composite']={'exactRequest':True,'orderedReferences':len(actual['input_references']),'promptSha256':digest(actual['prompt'].encode()),'oracle':'original caller; saved initial receipt' if not refine else 'original caller; no saved refinement claimed'}

    app=args.gallery.resolve(); home=app/'docs/prototypes/issue-41-invented-product-gallery'
    # Independent saved packets and prompts, not expected values generated by the new engine.
    node = '''import fs from 'node:fs'; import assert from 'node:assert/strict'; import engine from './procedures/muse/product-engine.mjs'; import {productPrompt} from './procedures/muse/product-prompt.mjs'; const home=process.argv[1], app=process.argv[2]; const packets=JSON.parse(fs.readFileSync(home+'/packets.json'));const plan=JSON.parse(fs.readFileSync(home+'/generation-plan.json'));for(const packet of packets){const {donorStrategies,...saved}=packet; assert.deepEqual(engine.buildBatch(packet.seed).find(p=>p.signature===packet.signature),saved)}for(const attempt of plan.attempts){const packet=packets.find(p=>p.signature===attempt.packetSignature);assert.equal(productPrompt(packet,attempt.strategy),fs.readFileSync(app+'/'+attempt.prompt,'utf8'))}console.log(JSON.stringify({packets:packets.length,prompts:plan.attempts.length}));'''
    product=json.loads(subprocess.check_output(['node','--input-type=module','-e',node,str(home),str(app)],cwd=ROOT,text=True))
    results['procedures']['product']=product
    sys.path.insert(0,str(app/'tools/prototypes/ad_typeset_transfer'))
    source=app/'tools/prototypes/invented-product-gallery/assemble.py'
    assert digest(source.read_bytes()) == 'e4cc8fe65a41b16d3cdbd1c086beec3a563a3d7475f38d439f4453f8696be5c2'
    old=original(source,'original_gallery'); old.ROOT=app
    scratch=Path(tempfile.mkdtemp(prefix='.muse-port-replay-',dir=app)); old.HOME=scratch/'original'; old.HOME.mkdir()
    layouts=load(app/'tools/prototypes/ad_typeset_transfer/layouts.json'); packets=load(home/'packets.json'); plan=load(home/'generation-plan.json')
    for attempt in plan['attempts']:
        target=old.HOME/'attempts'/attempt['id']; target.mkdir(parents=True); shutil.copyfile(home/'attempts'/attempt['id']/'run.json',target/'run.json')
    sources={'kodak':old.load_source(layouts['kodak'])}; clean={'kodak':old.clean_template('kodak',layouts['kodak'],sources['kodak'])}
    left=old.assemble_one(1,packets[0],old.VARIANTS[0],plan['attempts'],layouts,sources,clean)
    donor_home=scratch/'donors'; donor_home.mkdir()
    (donor_home/'packets.json').write_text(json.dumps([packets[0]]))
    (donor_home/'generation-plan.json').write_text(json.dumps(plan))
    shutil.copytree(home/'attempts',donor_home/'attempts',ignore=shutil.ignore_patterns('*.png','*.webp','*.jpg','prompt.txt','submission.json'))
    needed=[donor_home/'packets.json',donor_home/'generation-plan.json',app/'tools/prototypes/ad_typeset_transfer/layouts.json',app/layouts['kodak']['source']]
    for attempt in plan['attempts']:
        run=donor_home/'attempts'/attempt['id']/'run.json'; needed.extend([run,app/load(run)['images'][0]['file']])
    settings={key:getattr(old,key) for key in SETTINGS}; settings['BANNED']={key:sorted(value) for key,value in settings['BANNED'].items()}; settings['VARIANTS']=[old.VARIANTS[0]]
    recipe={'settings':settings,'donorHome':str(donor_home.relative_to(app)),'outputHome':str((scratch/'ported').relative_to(app)),'layouts':'tools/prototypes/ad_typeset_transfer/layouts.json','inputHashes':{str(path.relative_to(app)):digest(path.read_bytes()) for path in needed},'fontHashes':{font:digest(Path(font).read_bytes()) for font in layouts['fonts'].values()}}
    recipe_path=scratch/'assembly-recipe.json';recipe_path.write_text(json.dumps(recipe,indent=2)+'\n')
    right=assemble(app,str(recipe_path.relative_to(app)))['report']['records'][0]
    assert left['outputSha256']==right['outputSha256']=='29ac88a3439e9635a12752669213c9cf60d328ffd457e477e0cfeb70bf869073'
    assert np.array_equal(np.array(Image.open(app/left['output'])),np.array(Image.open(app/right['output'])))
    for key in ('changedPixelsOutsideDeclaredMasks','ocrTokenCoverage','fitResults','accepted','visualVerdict','blindVerdict','bannedSourceTokensFound','losslessRoundTrip'):
        assert left[key]==right[key],key
    results['assembly']={'sourceCommit':'6c1ac2cad9213823183d23823fe30d50b882678d','outputSha256':right['outputSha256'],'equalPixels':True,'changedPixelsOutsideDeclaredMasks':right['changedPixelsOutsideDeclaredMasks'],'ocrTokenCoverage':right['ocrTokenCoverage'],'sourceOutput':str(app/left['output']),'portedOutput':str(app/right['output']),'preview':str(app/right['preview']),'savedRecipe':str(recipe_path),'approval':'unverified'}
    # A changed donor is refused before a new output directory exists.
    recipe['outputHome']=str((scratch/'rejected').relative_to(app));recipe['inputHashes'][right['donor']]='0'*64;recipe_path.write_text(json.dumps(recipe))
    try: assemble(app,str(recipe_path.relative_to(app)))
    except ValueError: pass
    else: raise AssertionError('changed donor accepted')
    assert not (scratch/'rejected').exists()
    results['assembly']['changedDonorRefused']=True
    recipe['outputHome']=str((scratch/'next-assembly').relative_to(app));recipe['inputHashes'][right['donor']]=right['donorSha256'];recipe_path.write_text(json.dumps(recipe,indent=2)+'\n')
    import PIL, cv2
    results['runtime']={'Pillow':PIL.__version__,'numpy':np.__version__,'opencv':cv2.__version__}
    args.report.write_text(json.dumps(results,indent=2)+'\n'); print(json.dumps(results,indent=2))


if __name__=='__main__': main()
