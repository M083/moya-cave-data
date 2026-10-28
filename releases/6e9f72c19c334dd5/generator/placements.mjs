import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {decode,checkSeams} from './package.mjs';
import {hash,check,randomStream,validateConfig} from './core.mjs';

const clamp=x=>Math.max(0,Math.min(1,x));
function rotation(n,angle,align) {
  let q=[0,0,0,1];
  if(align) {
    q=n[1]<-.999999?[1,0,0,0]:[n[2],0,-n[0],1+n[1]];
    const len=Math.hypot(...q); q=q.map(v=>v/len);
  }
  const s=Math.sin(angle/2),c=Math.cos(angle/2),[x,y,z,w]=q;
  return [x*c-z*s,y*c+w*s,z*c+x*s,w*c-y*s];
}

// Stateless draws per candidate/rule isolate additions from other rules' random streams.
export function optimize(bytes,envelope) {
  const c=validateConfig(envelope),{header:old,payload}=decode(bytes);
  check(old.formatVersion===1&&old.configHash===envelope.configHash,'expected matching v1 input');
  const h=structuredClone(old), prefabs=[...new Set(c.rules.flatMap(r=>r.prefabIds))].sort();
  const rules=[...c.rules].sort((a,b)=>a.id.localeCompare(b.id,'en'));
  const ruleMap=new Map(rules.map((r,i)=>[r.id,{r,i}])), biomeMap=new Map(c.biomes.map(b=>[b.id,b]));
  const buffers=[]; let offset=0,count=0,objects=0,oxygen=0,cappedChunks=0;
  for(const ch of h.chunks) {
    const mesh=payload.subarray(ch.vertexByteOffset,ch.vertexByteOffset+ch.vertexCount*12), records=[];
    let spawned=0,capped=false;
    for(let i=0;i<ch.candidateCount;i++) {
      const p=ch.candidateByteOffset+i*40,id=payload.readUInt32LE(p),flags=payload.readUInt32LE(p+4),layer=payload.readUInt32LE(p+8);
      const pos=[0,1,2].map(k=>payload.readFloatLE(p+12+k*4)), n=[0,1,2].map(k=>payload.readFloatLE(p+24+k*4));
      const world=pos.map((v,k)=>v+ch.worldPosition[['x','y','z'][k]]);
      const biome=biomeMap.get(h.biomeLayers[layer].biomeId);
      const dist=clamp(Math.hypot(world[0]-c.origin.x,world[2]-c.origin.z)/88);
      const depth=1-clamp((world[1]-(c.origin.y-c.chunksY*c.chunkPhysicalSize))/(c.chunksY*c.chunkPhysicalSize));
      // Keep the existing fixed oxygen probability during this performance comparison.
      if(flags&8) {
        const rng=randomStream(h.seed,`oxygen:${ch.id}:${id}`);
        if(rng()<.1) {
          records.push({prefab:-1,id,rule:-1,member:0,p:pos.map(v=>v+rng()*c.chunkPhysicalSize/c.resolution),q:[0,0,0,1],scale:1}); oxygen++;
        }
      }
      // Existing FinalizeMesh does not instantiate decoration on empty chunks.
      if(!ch.vertexCount) continue;
      for(const ruleId of [...biome.ruleIds].sort()) {
        const {r,i:rule}=ruleMap.get(ruleId);
        if(!(flags&[1,2,4][r.placementType])||dist<r.minCenterDistRatio||dist>r.maxCenterDistRatio||depth<r.minDepthRatio||depth>r.maxDepthRatio) continue;
        const rng=randomStream(h.seed,`placement:${ch.id}:${id}:${r.id}`);
        if(rng()>=r.baseChance) continue;
        const prefab=prefabs.indexOf(r.prefabIds[Math.floor(rng()*r.prefabIds.length)]);
        const members=r.isCluster?r.minClusterSize+Math.floor(rng()*(r.maxClusterSize-r.minClusterSize+1)):1;
        for(let member=0;member<members;member++) {
          if(spawned>=150) { capped=true; break; }
          let local=[...pos];
          if(r.isCluster&&member>0) {
            let v; do { v=[rng()*2-1,rng()*2-1,rng()*2-1]; } while(Math.hypot(...v)>1);
            if(r.placementType!==1) { const dot=v.reduce((sum,a,k)=>sum+a*n[k],0); v=v.map((a,k)=>a-dot*n[k]); }
            local=local.map((a,k)=>a+v[k]*r.clusterRadius);
          }
          records.push({prefab,id,rule,member,p:local,q:rotation(n,rng()*r.randomRotationVariation*Math.PI/180,r.alignToNormal&&r.placementType!==1),scale:r.minScale+rng()*(r.maxScale-r.minScale)});
          spawned++; objects++;
        }
      }
    }
    if(capped) cappedChunks++;
    const data=Buffer.alloc(records.length*64);
    records.forEach((r,i)=>{
      const p=i*64;data.writeInt32LE(r.prefab,p);data.writeUInt32LE(r.id,p+4);data.writeInt32LE(r.rule,p+8);data.writeUInt32LE(r.member,p+12);
      [...r.p,...r.q,r.scale].forEach((v,k)=>data.writeFloatLE(v,p+16+k*4));
      const identity=['moya-placement-id-1',h.generatorVersion,ch.id,r.id,r.rule<0?'oxygen':rules[r.rule].id,r.member].join('|');
      Buffer.from(hash(identity).slice(0,32),'hex').copy(data,p+48);
    });
    ch.vertexByteOffset=offset; ch.candidateByteOffset=offset+mesh.length; ch.candidateCount=records.length;
    buffers.push(mesh,data); offset+=mesh.length+data.length; count+=records.length;
  }
  const resultPayload=Buffer.concat(buffers);
  Object.assign(h,{formatVersion:2,candidateRecordBytes:64,candidateCount:count,placementVersion:'moya-placement-2',collectionEpoch:`daily-1:${h.contentDateJst}:${h.generatorVersion}:${h.seed}`,prefabIds:prefabs,spawnRules:rules,candidatePolicy:'final-placement-records;per-candidate-rule-rng;cap150;oxygen-fixed-0.1',sourcePackageId:old.packageId,payloadByteLength:resultPayload.length,payloadSha256:hash(resultPayload)});
  delete h.packageId; h.packageId=hash(JSON.stringify(h));
  const json=Buffer.from(JSON.stringify(h)),prefix=Buffer.alloc(Math.ceil((12+json.length)/4)*4);
  prefix.write('MOYACAV2');prefix.writeUInt32LE(json.length,8);json.copy(prefix,12);
  const result=Buffer.concat([prefix,resultPayload]);
  return {bytes:result,stats:{bytes:result.length,placements:count,objects,oxygen,cappedChunks,sha256:hash(result)}};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const result=optimize(readFileSync(process.argv[2]),JSON.parse(readFileSync(process.argv[3],'utf8')));
  check(checkSeams(decode(result.bytes)).mismatchedFaces===0,'seam mismatch');
  writeFileSync(process.argv[4],result.bytes);
  writeFileSync(process.argv[4]+'.report.json',JSON.stringify(result.stats,null,2)+'\n');
  console.log(JSON.stringify(result.stats,null,2));
}
