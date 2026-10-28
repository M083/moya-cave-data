import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {todayUtc,addDays,slotPath,dayNumber} from './calendar.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const root=dirname(fileURLToPath(import.meta.url));
const args=process.argv.slice(2),opts={};
for(let i=0;i<args.length;i+=2) {
  if(!['--date','--out','--past','--ahead'].includes(args[i])||args[i+1]===undefined||opts[args[i]]!==undefined) throw new Error('Invalid options');
  opts[args[i]]=args[i+1];
}
const date=opts['--date']??todayUtc(),past=Number(opts['--past']??2),ahead=Number(opts['--ahead']??7);
dayNumber(date);
if(!Number.isInteger(past)||!Number.isInteger(ahead)||past<0||ahead<0||past+ahead>=32) throw new Error('Window must fit within 32 slots');
const out=resolve(opts['--out']??join(root,'site'));
const releases=JSON.parse(readFileSync(join(root,'releases.json'),'utf8'));
if(!Array.isArray(releases)||!releases.length||new Set(releases).size!==releases.length) throw new Error('Invalid release list');
const manifest={formatVersion:1,dateUtc:date,dateBasis:'UTC',slotCount:32,packages:[]};
let totalBytes=0;
for(const id of releases) {
  if(!/^[0-9a-f]{16}$/.test(id)) throw new Error('Invalid release ID');
  const base=join(root,'releases',id),release=JSON.parse(readFileSync(join(base,'release.json'),'utf8'));
  const files=['core.mjs','placements.mjs','package.mjs','marching-table.json'];
  const fingerprint=hash(Buffer.concat(files.flatMap(name=>[Buffer.from(name+'\0'),readFileSync(join(base,'generator',name))])));
  const config=readFileSync(join(base,'terrain-config.json')),envelope=JSON.parse(config);
  if(release.releaseId!==id||release.generatorFingerprint!==fingerprint||release.configSha256!==hash(config)||release.configHash!==envelope.configHash||hash(hash(config)+'|'+fingerprint).slice(0,16)!==id) throw new Error('Modified immutable release '+id);
  const {generate}=await import(pathToFileURL(join(base,'generator/core.mjs')));
  const {optimize}=await import(pathToFileURL(join(base,'generator/placements.mjs')));
  const {decode,checkSeams}=await import(pathToFileURL(join(base,'generator/package.mjs')));
  for(let delta=-past;delta<=ahead;delta++) {
    const contentDate=addDays(date,delta),relative=slotPath(id,contentDate),dest=join(out,relative);
    const generated=generate(envelope,{date:contentDate,sourceHash:hash(config)});
    const optimized=optimize(generated.bytes,envelope);
    const decoded=decode(optimized.bytes);
    if(checkSeams(decoded).mismatchedFaces!==0) throw new Error('Mesh seam mismatch');
    if(existsSync(dest)) {
      const existing=readFileSync(dest),previous=decode(existing);
      if(previous.header.contentDateJst===contentDate&&!existing.equals(optimized.bytes)) throw new Error('Refusing same-day package replacement');
    }
    totalBytes+=optimized.bytes.length;
    if(totalBytes>900000000) throw new Error('Publishing exceeds 900 MB budget; retire old releases explicitly');
    mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,optimized.bytes);
    const info={releaseId:id,configHash:envelope.configHash,date:contentDate,seed:decoded.header.seed,path:relative,bytes:optimized.bytes.length,sha256:hash(optimized.bytes)};
    manifest.packages.push(info);console.log(JSON.stringify(info));
  }
}
writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
writeFileSync(join(out,'.nojekyll'),'');
writeFileSync(join(out,'index.html'),`<!doctype html><meta charset="utf-8"><title>Daily cave data</title><h1>Daily cave data</h1><p>Prepared for ${date} UTC. ${manifest.packages.length} packages.</p><p><a href="manifest.json">Package manifest</a></p>`);
console.log(JSON.stringify({site:out,packages:manifest.packages.length,totalBytes}));
