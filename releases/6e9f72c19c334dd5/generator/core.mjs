import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const TABLE = JSON.parse(readFileSync(new URL('./marching-table.json', import.meta.url), 'utf8'));
export const VERSION = 'moya-cave-portable-1';
export const CORNERS = [[0,0,0],[1,0,0],[1,0,1],[0,0,1],[0,1,0],[1,1,0],[1,1,1],[0,1,1]];
const EDGES = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function check(ok, message) { if (!ok) throw new Error(message); }
const clamp = x => Math.max(0, Math.min(1, x));
const lerp = (a,b,t) => a + (b-a)*t;
const smooth = x => { x=clamp(x); return x*x*(3-2*x); };
const idPattern = /^[0-9a-f]{32}$/;
const finite = n => typeof n === 'number' && Number.isFinite(n);
const unit = n => finite(n) && n >= 0 && n <= 1;
const vector = v => v && ['x','y','z'].every(k => finite(v[k]) && Math.abs(v[k]) <= 100000);

export function dailySeed(date) {
  check(/^\d{4}-\d{2}-\d{2}$/.test(date), 'date must be YYYY-MM-DD in JST');
  const d = new Date(date + 'T00:00:00Z');
  check(Number.isFinite(d.valueOf()) && d.toISOString().slice(0,10) === date, 'invalid calendar date');
  return Math.imul(Number(date.replaceAll('-','')) ^ 1234567, 123);
}

// Separate deterministic streams; no dependency on process time or Math.random.
export function randomStream(seed, domain) {
  let state = seed >>> 0;
  for (const c of domain) state = Math.imul(state ^ c.charCodeAt(0), 16777619) >>> 0;
  if (!state) state = 0x6d2b79f5;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

// 2D gradient Perlin noise with quintic interpolation, deliberately not Unity Mathf.PerlinNoise parity.
export function createNoise(seed) {
  const rng = randomStream(seed, 'density-permutation');
  const p = Array.from({length:256},(_,i)=>i);
  for(let i=255;i>0;i--) { const j=Math.floor(rng()*(i+1)); [p[i],p[j]]=[p[j],p[i]]; }
  const gradients = [[1,0],[-1,0],[0,1],[0,-1],[Math.SQRT1_2,Math.SQRT1_2],[-Math.SQRT1_2,Math.SQRT1_2],[Math.SQRT1_2,-Math.SQRT1_2],[-Math.SQRT1_2,-Math.SQRT1_2]];
  const fade = t => 6*t**5 - 15*t**4 + 10*t**3;
  return (x,y) => {
    const ix=Math.floor(x), iy=Math.floor(y), fx=x-ix, fy=y-iy;
    const dot=(dx,dy)=> { const g=gradients[p[(p[(ix+dx)&255]+iy+dy)&255]&7]; return g[0]*(fx-dx)+g[1]*(fy-dy); };
    return clamp(0.5 + 0.5*lerp(lerp(dot(0,0),dot(1,0),fade(fx)),lerp(dot(0,1),dot(1,1),fade(fx)),fade(fy)));
  };
}

export function validateConfig(envelope) {
  check(envelope && /^[0-9a-f]{64}$/.test(envelope.configHash), 'missing configHash');
  const c=envelope.configuration;
  check(c?.formatVersion===1 && c.generatorVersion==='moya-cave-v1', 'unsupported configuration version');
  check(vector(c.origin), 'invalid origin');
  check(['chunksX','chunksY','chunksZ','resolution'].every(k=>Number.isSafeInteger(c[k]) && c[k]>0), 'invalid grid counts');
  check(c.resolution<=16 && finite(c.chunkPhysicalSize) && c.chunkPhysicalSize>0 && c.chunkPhysicalSize<=1000, 'unsupported grid dimensions');
  check(c.chunksX*c.chunksY*c.chunksZ*c.resolution**3<=2000000, 'generation cell budget exceeded');
  check(finite(c.isoLevel) && finite(c.maxDepth) && c.maxDepth<0, 'invalid terrain thresholds');
  check(finite(c.minLayerThickness) && c.minLayerThickness>0 && finite(c.maxLayerThickness) && c.maxLayerThickness>=c.minLayerThickness, 'invalid layer thickness');
  check(Array.isArray(c.chunks) && c.chunks.length===c.chunksX*c.chunksY*c.chunksZ, 'chunk count mismatch');
  check(Array.isArray(c.biomes) && c.biomes.length>0 && c.biomes.length<=32 && Array.isArray(c.rules), 'invalid biome/rule lists');
  const unique = (rows,label) => {
    const seen=new Set(); for(const row of rows) { check(idPattern.test(row.id) && !seen.has(row.id), 'invalid/duplicate '+label+' ID'); seen.add(row.id); } return seen;
  };
  unique(c.chunks,'chunk'); unique(c.biomes,'biome'); const ruleIds=unique(c.rules,'rule');
  const positions=new Set();
  for(const chunk of c.chunks) {
    check(vector(chunk.worldPosition), 'invalid chunk coordinate');
    const key=['x','y','z'].map(k=>chunk.worldPosition[k]).join(',');
    check(!positions.has(key), 'duplicate chunk position'); positions.add(key);
  }
  // Complete, contiguous cuboid, aligned to a single rational lattice.
  for(const [axis,count] of [['x',c.chunksX],['y',c.chunksY],['z',c.chunksZ]]) {
    const values=[...new Set(c.chunks.map(ch=>ch.worldPosition[axis]))].sort((a,b)=>a-b);
    check(values.length===count, 'grid axis count mismatch: '+axis);
    for(let i=1;i<values.length;i++) check(Math.abs(values[i]-values[i-1]-c.chunkPhysicalSize)<1e-6, 'non-contiguous grid: '+axis);
  }
  for(const b of c.biomes) {
    check(finite(b.startDepth)&&finite(b.endDepth)&&b.startDepth>b.endDepth, 'invalid biome depth');
    check(finite(b.mainPathRadius)&&b.mainPathRadius>0&&finite(b.bigRoomBaseMin)&&b.bigRoomBaseMin>=0&&finite(b.bigRoomBaseMax)&&b.bigRoomBaseMax>=b.bigRoomBaseMin, 'invalid biome shape');
    check(unit(b.branchThreshold)&&unit(b.o2StationChance), 'invalid biome probability');
    check(Array.isArray(b.ruleIds)&&b.ruleIds.every(id=>ruleIds.has(id))&&new Set(b.ruleIds).size===b.ruleIds.length, 'missing/duplicate biome rule');
  }
  for(const r of c.rules) {
    check(Array.isArray(r.prefabIds)&&r.prefabIds.length>0&&r.prefabIds.every(id=>idPattern.test(id)), 'invalid prefab IDs');
    check([0,1,2].includes(r.placementType)&&unit(r.baseChance), 'invalid spawn rule');
    for(const pair of [['minCenterDistRatio','maxCenterDistRatio'],['minDepthRatio','maxDepthRatio']]) check(unit(r[pair[0]])&&unit(r[pair[1]])&&r[pair[0]]<=r[pair[1]], 'invalid rule range');
    check(finite(r.minScale)&&r.minScale>0&&finite(r.maxScale)&&r.maxScale>=r.minScale&&finite(r.clusterRadius)&&r.clusterRadius>=0&&finite(r.randomRotationVariation), 'invalid placement dimensions');
    check(Number.isSafeInteger(r.minClusterSize)&&r.minClusterSize>=1&&Number.isSafeInteger(r.maxClusterSize)&&r.maxClusterSize>=r.minClusterSize, 'invalid cluster count');
  }
  return c;
}

export function generateLayers(c,seed) {
  const rng=randomStream(seed,'biome-layers');
  const templates=[...c.biomes].sort((a,b)=>a.id.localeCompare(b.id,'en'));
  const layers=[];
  let y=0, steps=0;
  while(y>c.maxDepth) {
    check(++steps<=10000, 'biome generation did not converge');
    const choices=templates.filter(b=>y<=b.startDepth && y>b.endDepth);
    check(choices.length>0, 'no biome allowed at depth '+y);
    const b=choices[Math.floor(rng()*choices.length)];
    const end=Math.max(c.maxDepth,b.endDepth,y-lerp(c.minLayerThickness,c.maxLayerThickness,rng()));
    check(end<y,'biome generation made no progress');
    const last=layers.at(-1);
    if(last?.biomeId===b.id) last.endDepth=end;
    else layers.push({biomeId:b.id,startDepth:y,endDepth:end});
    y=end;
  }
  return layers;
}

export function densityFunction(c,seed,layers) {
  const noise=createNoise(seed), offsetRng=randomStream(seed,'terrain-offset');
  const offset=offsetRng()*10000;
  const biomeMap=new Map(c.biomes.map(b=>[b.id,b]));
  const layerIndex=y=> { const i=layers.findIndex(l=>y<=l.startDepth&&y>=l.endDepth); return i<0?(y>0?0:layers.length-1):i; };
  const sample=(wx,y,wz)=> {
    const b=biomeMap.get(layers[layerIndex(y)].biomeId), s=offset;
    // Paths are relative to manager XZ; exported manager origin is currently zero.
    const x=wx-c.origin.x,z=wz-c.origin.z;
    const ratio=clamp((y-(c.origin.y-c.chunksY*c.chunkPhysicalSize))/(c.chunksY*c.chunkPhysicalSize));
    const sx=x+(noise(x*.015,y*.015+s)-.5)*40;
    const sz=z+(noise(y*.015-s,z*.015)-.5)*40;
    const seg=Math.floor(y/30), t=smooth((y/30-seg-.8)*5);
    const shiftX=lerp((noise(seg*.5,s)-.5)*50,(noise((seg+1)*.5,s)-.5)*50,t);
    const shiftZ=lerp((noise(s,seg*.5)-.5)*50,(noise(s,(seg+1)*.5)-.5)*50,t);
    const center=Math.hypot(x,z);
    const bias=ratio>.96?22-center:ratio<.02?-50-(1-ratio/.02)**2*80+30-center*.5:0;
    const yc=y*.012+s*.123, br=noise(y*.005,s)*120, roomMode=smooth((noise(y*.012,s*.5)-.45)*4);
    const dist1=Math.hypot(sx-((noise(yc+br,s*.5)-.5)*70+shiftX),sz-((noise(s*.8,yc+br+100)-.5)*70+shiftZ));
    const branch=noise(y*.04,s*9.9);
    const dist2=Math.hypot(sx-((noise(yc*1.4,s+10)-.5)*60+shiftX),sz-((noise(s+15,yc*1.4)-.5)*60+shiftZ));
    const dist3=Math.hypot(sx-((noise(yc*.8,s+20)-.5)*50+shiftX),sz-((noise(s+25,yc*.8+100)-.5)*50+shiftZ));
    const jump=Math.floor(y/40);
    const room=noise(sx*.015+(noise(jump*.7,s)-.5)*200,sz*.015+(noise(s,jump*.7)-.5)*200);
    const big=room>.7&&noise(y*.04,s*2)>.35?lerp(b.bigRoomBaseMin,b.bigRoomBaseMax,roomMode):0;
    const detail=((noise(sx*.08,sz*.08)+noise(sz*.08,y*.08)+noise(y*.08,sx*.08))/3-.5)*14;
    const paths=Math.max(lerp(b.mainPathRadius,4,roomMode)-dist1,(branch>b.branchThreshold?8:-20)-dist2,(branch>b.branchThreshold+.1?5:-20)-dist3);
    let hollow=Math.max(paths,big)+bias;
    if(center>88) hollow=Math.min(hollow,(88-center)*20);
    return .5-(hollow+detail);
  };
  return {sample,layerIndex,generationOffset:offset};
}

// Values/positions use the project's corner convention (Y and Z differ from many published tables).
export function marchCell(positions,values,iso) {
  let cube=0; for(let i=0;i<8;i++) if(values[i]>iso) cube|=1<<i;
  const row=TABLE.slice(cube*16,cube*16+16), edges=new Map(), triangles=[];
  for(let i=0;i<16&&row[i]>=0;i+=3) {
    const triangle=[];
    for(const edge of row.slice(i,i+3)) {
      if(!edges.has(edge)) {
        let [a,b]=EDGES[edge];
        // Canonical interpolation direction removes opposite-edge rounding differences.
        if(positions[a].join(',')>positions[b].join(',')) [a,b]=[b,a];
        const t=values[a]===values[b] ? 0.5 : clamp((iso-values[a])/(values[b]-values[a]));
        edges.set(edge,positions[a].map((p,k)=>lerp(p,positions[b][k],t)));
      }
      triangle.push(edges.get(edge));
    }
    const [a,b,d]=triangle, u=b.map((p,k)=>p-a[k]), v=d.map((p,k)=>p-a[k]);
    const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]], length=Math.hypot(...n);
    if(length>1e-12) triangles.push({vertices:triangle,normal:n.map(p=>p/length),slot:i/3});
  }
  return triangles;
}

export function generate(envelope,{date,seed=dailySeed(date),sourceHash=hash(JSON.stringify(envelope))}={}) {
  dailySeed(date);
  check(Number.isInteger(seed)&&seed>=-2147483648&&seed<=2147483647,'seed must be int32');
  const c=validateConfig(envelope), layers=generateLayers(c,seed), field=densityFunction(c,seed,layers);
  const r=c.resolution, size=c.chunkPhysicalSize, axes=['x','y','z'];
  const min=axes.map(k=>Math.min(...c.chunks.map(ch=>ch.worldPosition[k])));
  const latticePosition=(coords)=>coords.map((g,k)=>min[k]+(g*size)/r);
  const cache=new Map();
  const sample=coords=> { const key=coords.join(','); if(!cache.has(key)) cache.set(key,field.sample(...latticePosition(coords))); return cache.get(key); };
  const chunks=[], buffers=[]; let byteOffset=0, verticesTotal=0,candidatesTotal=0,emptyChunks=0;
  for(const chunk of [...c.chunks].sort((a,b)=>a.id.localeCompare(b.id,'en'))) {
    const origin=axes.map(k=>chunk.worldPosition[k]), base=origin.map((p,k)=>Math.round((p-min[k])/size)*r);
    const verts=[], candidates=[];
    // Half-open ownership prevents duplicate air/oxygen candidates on shared chunk faces.
    for(let z=0;z<r;z++) for(let y=0;y<r;y++) for(let x=0;x<r;x++) {
      const xyz=[x,y,z], g=xyz.map((p,k)=>p+base[k]), world=latticePosition(g), d=sample(g);
      if(x%2===0&&y%2===0&&z%2===0) {
        const flags=(d<.45?2:0)|(d>.1&&d<.4?8:0);
        if(flags) candidates.push({id:0x80000000+(x+r*(y+r*z)),flags,layer:field.layerIndex(world[1]),p:world.map((p,k)=>p-origin[k]),n:[0,0,0],density:d});
      }
      const grid=CORNERS.map(corner=>corner.map((v,k)=>v+g[k]));
      const tris=marchCell(grid.map(latticePosition),grid.map(sample),c.isoLevel);
      for(const tri of tris) {
        const local=tri.vertices.map(v=>v.map((p,k)=>Math.fround(p-origin[k])));
        verts.push(...local.flat());
        const center=[0,1,2].map(k=>(local[0][k]+local[1][k]+local[2][k])/3);
        candidates.push({id:(x+r*(y+r*z))*5+tri.slot,flags:1|(tri.normal[1]>.6?4:0),layer:field.layerIndex(center[1]+origin[1]),p:center,n:tri.normal,density:c.isoLevel});
      }
    }
    const mesh=Buffer.alloc(verts.length*4);
    verts.forEach((v,i)=>mesh.writeFloatLE(v,i*4));
    const candidateBuffer=Buffer.alloc(candidates.length*40);
    candidates.forEach((v,i)=> {
      const b=i*40; candidateBuffer.writeUInt32LE(v.id,b); candidateBuffer.writeUInt32LE(v.flags,b+4); candidateBuffer.writeUInt32LE(v.layer,b+8);
      [...v.p,...v.n,v.density].forEach((n,k)=>candidateBuffer.writeFloatLE(n,b+12+k*4));
    });
    const vertexCount=verts.length/3;
    chunks.push({id:chunk.id,worldPosition:chunk.worldPosition,vertexCount,vertexByteOffset:byteOffset,candidateCount:candidates.length,candidateByteOffset:byteOffset+mesh.length});
    buffers.push(mesh,candidateBuffer); byteOffset+=mesh.length+candidateBuffer.length;
    verticesTotal+=vertexCount; candidatesTotal+=candidates.length; if(!vertexCount) emptyChunks++;
    check(byteOffset<99000000,'payload exceeds the 100 MB download budget');
  }
  const payload=Buffer.concat(buffers);
  const header={formatVersion:1,generatorVersion:VERSION,configurationGeneratorVersion:c.generatorVersion,
    configHash:envelope.configHash,sourceConfigSha256:sourceHash,contentDateJst:date,seed,generationOffset:field.generationOffset,
    byteOrder:'little-endian',vertexRecordBytes:12,candidateRecordBytes:40,chunkPhysicalSize:size,resolution:r,
    candidatePolicy:'triangle-wall-floor;half-open-even-grid-air-oxygen;no-placement-randomness',
    biomeLayers:layers,biomeTemplates:c.biomes,spawnRules:c.rules,chunkCount:chunks.length,chunks,
    vertexCount:verticesTotal,candidateCount:candidatesTotal,emptyChunks,payloadByteLength:payload.length,payloadSha256:hash(payload)};
  header.packageId=hash(JSON.stringify(header));
  const json=Buffer.from(JSON.stringify(header),'utf8'), start=Math.ceil((12+json.length)/4)*4;
  const prefix=Buffer.alloc(start); prefix.write('MOYACAV1',0,'ascii'); prefix.writeUInt32LE(json.length,8); json.copy(prefix,12);
  const bytes=Buffer.concat([prefix,payload]); check(bytes.length<=100000000,'package exceeds 100 MB');
  return {bytes,header,stats:{bytes:bytes.length,vertices:verticesTotal,triangles:verticesTotal/3,candidates:candidatesTotal,emptyChunks,densitySamples:cache.size}};
}
