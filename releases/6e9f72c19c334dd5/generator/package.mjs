import { check, hash, VERSION } from './core.mjs';

// Reference decoder. All offsets are relative to the start of the binary payload.
export function decode(bytes) {
  check(bytes.length>=12 && bytes.length<=100000000,'invalid package length');
  const magic=bytes.subarray(0,8).toString('ascii');
  check(['MOYACAV1','MOYACAV2'].includes(magic),'invalid magic');
  const length=bytes.readUInt32LE(8), start=Math.ceil((12+length)/4)*4;
  check(length>0 && length<=4000000 && start<=bytes.length,'invalid header length');
  const h=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(12,12+length)));
  check([1,2].includes(h.formatVersion) && magic==='MOYACAV'+h.formatVersion && h.generatorVersion===VERSION && h.byteOrder==='little-endian','unsupported package version');
  const optimized=h.formatVersion===2, recordBytes=optimized?h.candidateRecordBytes:40;
  const {packageId,...identity}=h;
  check(packageId===hash(JSON.stringify(identity)),'header hash mismatch');
  check(h.vertexRecordBytes===12 && h.candidateRecordBytes===recordBytes,'unsupported record size');
  if(optimized) check(((h.placementVersion==='moya-placement-1'&&recordBytes===48)||(h.placementVersion==='moya-placement-2'&&recordBytes===64&&typeof h.collectionEpoch==='string'&&h.collectionEpoch.length>0))&&Array.isArray(h.prefabIds),'unsupported placement version');
  const payload=bytes.subarray(start);
  check(payload.length===h.payloadByteLength && hash(payload)===h.payloadSha256,'payload integrity failure');
  check(Array.isArray(h.chunks) && h.chunks.length===h.chunkCount,'invalid chunk count');
  let offset=0,vertices=0,candidates=0;
  const ids=new Set(),placementIds=new Set();
  for(const c of h.chunks) {
    check(/^[0-9a-f]{32}$/.test(c.id)&&!ids.has(c.id),'duplicate/invalid chunk ID'); ids.add(c.id);
    check(['x','y','z'].every(k=>Number.isFinite(c.worldPosition[k])),'invalid position');
    check(Number.isSafeInteger(c.vertexCount)&&c.vertexCount>=0&&c.vertexCount%3===0&&c.vertexCount<=61440,'invalid vertex count');
    check(Number.isSafeInteger(c.candidateCount)&&c.candidateCount>=0,'invalid candidate count');
    check(c.vertexByteOffset===offset,'invalid vertex offset'); offset+=c.vertexCount*12;
    check(c.candidateByteOffset===offset,'invalid candidate offset'); offset+=c.candidateCount*recordBytes;
    check(offset<=payload.length,'record out of bounds');
    for(let i=0;i<c.vertexCount*3;i++) {
      const v=payload.readFloatLE(c.vertexByteOffset+i*4);
      check(Number.isFinite(v)&&v>=-0.00001&&v<=h.chunkPhysicalSize+0.00001,'invalid vertex');
    }
    const candidateIds=new Set();
    for(let i=0;i<c.candidateCount;i++) {
      if(optimized) {
        const p=c.candidateByteOffset+i*recordBytes, prefab=payload.readInt32LE(p),rule=payload.readInt32LE(p+8);
        if(recordBytes===64) { const id=payload.subarray(p+48,p+64).toString('hex'); check(!placementIds.has(id),'duplicate stable placement ID'); placementIds.add(id); }
        check(prefab>=-1&&prefab<h.prefabIds.length&&rule>=-1&&rule<h.spawnRules.length&&(prefab===-1)===(rule===-1),'invalid placement reference');
        const key=[payload.readUInt32LE(p+4),rule,payload.readUInt32LE(p+12)].join(':');
        check(!candidateIds.has(key),'duplicate placement identity');candidateIds.add(key);
        for(let k=0;k<8;k++) check(Number.isFinite(payload.readFloatLE(p+16+k*4)),'invalid placement number');
        check(payload.readFloatLE(p+44)>0,'invalid scale');
        check(Math.abs(Math.hypot(...[0,1,2,3].map(k=>payload.readFloatLE(p+28+k*4)))-1)<.00001,'invalid rotation');
        continue;
      }
      const p=c.candidateByteOffset+i*40,id=payload.readUInt32LE(p),flags=payload.readUInt32LE(p+4),layer=payload.readUInt32LE(p+8);
      check(!candidateIds.has(id),'duplicate candidate ID'); candidateIds.add(id);
      check(flags>0&&(flags&~15)===0&&layer<h.biomeLayers.length,'invalid candidate metadata');
      for(let k=0;k<7;k++) check(Number.isFinite(payload.readFloatLE(p+12+k*4)),'invalid candidate number');
    }
    vertices+=c.vertexCount; candidates+=c.candidateCount;
  }
  check(offset===payload.length&&vertices===h.vertexCount&&candidates===h.candidateCount,'package totals mismatch');
  return {header:h,payload};
}

// Compare shared-face triangle edges after Float32 serialization, not just scalar samples.
export function checkSeams({header:h,payload}) {
  const axes=['x','y','z'], size=h.chunkPhysicalSize, key=c=>axes.map(k=>c.worldPosition[k]).join(',');
  const byPosition=new Map(h.chunks.map(c=>[key(c),c]));
  const face=(c,axis,side)=> {
    const edges=[];
    for(let i=0;i<c.vertexCount;i+=3) {
      const points=[0,1,2].map(j=>[0,1,2].map(k=>payload.readFloatLE(c.vertexByteOffset+(i+j)*12+k*4)));
      for(let e=0;e<3;e++) {
        const a=points[e],b=points[(e+1)%3];
        if(Math.abs(a[axis]-side)>1e-6||Math.abs(b[axis]-side)>1e-6) continue;
        // Quantize only tangential coordinates; shared chunks have identical tangential origins.
        const point=v=>v.filter((_,k)=>k!==axis).map(n=>Math.round(n*100000)).join(',');
        edges.push([point(a),point(b)].sort().join(':'));
      }
    }
    return edges.sort();
  };
  let checkedFaces=0,mismatchedFaces=0;
  const examples=[];
  for(const c of h.chunks) for(let axis=0;axis<3;axis++) {
    const next={worldPosition:{...c.worldPosition}}; next.worldPosition[axes[axis]]+=size;
    const other=byPosition.get(key(next)); if(!other) continue;
    checkedFaces++;
    const a=face(c,axis,size),b=face(other,axis,0);
    if(JSON.stringify(a)!==JSON.stringify(b)) { mismatchedFaces++; if(examples.length<5) examples.push({chunk:c.id,neighbor:other.id,axis:axes[axis],edges:[a.length,b.length]}); }
  }
  return {checkedFaces,mismatchedFaces,examples};
}
