#!/usr/bin/env node
// The preserved engine and prompt; only input/output locations are adapted.
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import engine from "./product-engine.mjs";
import { productPrompt } from "./product-prompt.mjs";
const { values } = parseArgs({ options: { application:{type:"string"}, output:{type:"string"}, seed:{type:"string"}, mode:{type:"string"}, strategy:{type:"string"} } });
if (Object.values(values).length !== 5) throw new Error("Supply application, a new output directory, seed, mode and strategy.");
const root = realpathSync(values.application);
const output = resolve(root, values.output);
if (!output.startsWith(root + sep)) throw new Error("Output must remain inside the application.");
const parent = realpathSync(resolve(output, ".."));
if (parent !== root && !parent.startsWith(root + sep)) throw new Error("Output parent escapes the application.");
const packet = engine.buildBatch(values.seed).find(item => item.conceptMode.id === values.mode);
if (!packet?.validation.valid) throw new Error("The saved product engine rejected the packet.");
const prompt = productPrompt(packet, values.strategy);
mkdirSync(output);
const write = (name, text) => writeFileSync(join(output,name), text, {flag:"wx"});
write("packet.json", JSON.stringify(packet,null,2)+"\n");
write("prompt.txt",prompt);
write("recipe.json",JSON.stringify({procedure:"product-ad",prompt:relative(root,join(output,"prompt.txt")),promptSha256:createHash("sha256").update(prompt).digest("hex"),size:"1760x1440",packet:relative(root,join(output,"packet.json")),strategy:values.strategy,references:[]},null,2)+"\n");
console.log(JSON.stringify({recipe:relative(root,join(output,"recipe.json")),packetSignature:packet.signature,paidRequests:0},null,2));
