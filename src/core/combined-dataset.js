const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { toCsv } = require('./csv');
const { buildXlsx } = require('./xlsx');
const { standardizeRows, applyConditionalRatingNormalization, ratingScaleProfile, RATING_NORMALIZED_MAX } = require('./canonical-review');
const { projectDirectoryName, scanRuns } = require('./run-store');
const { internalPath, relativeWorkspaceRef, resolveWorkspaceRef } = require('./workspace-layout');

const COMBINED_COLUMNS = Object.freeze([
  'review_id','canonical_object','source_object_name','review_subject','review_provider',
  'review_title','review_text','review_positive_text','review_negative_text','review_date',
  'rating_score','rating_max','rating_label',
  'reviewer_name','reviewer_country','reviewer_status','travel_type','room_type','stay_start_date','stay_end_date','stay_detail',
  'source_site','source_url','acquisition_method','session_id','run_id'
]);
function combinedColumnsForRows(rows=[]){
  const hasNormalized=(Array.isArray(rows)?rows:[]).some(row=>Object.prototype.hasOwnProperty.call(row||{},'rating_normalized'));
  if(!hasNormalized)return[...COMBINED_COLUMNS];
  const columns=[];for(const key of COMBINED_COLUMNS){columns.push(key);if(key==='rating_max')columns.push('rating_normalized');}
  return columns;
}
function ensureDir(dir){fs.mkdirSync(dir,{recursive:true});return dir;}
function readJson(filePath){try{return JSON.parse(fs.readFileSync(filePath,'utf8'));}catch{return null;}}
function readJsonl(filePath){if(!fs.existsSync(filePath))return[];const rows=[];for(const line of fs.readFileSync(filePath,'utf8').split(/\r?\n/)){if(!line.trim())continue;try{rows.push(JSON.parse(line));}catch{}}return rows;}
function writeJsonl(filePath,rows){ensureDir(path.dirname(filePath));fs.writeFileSync(filePath,rows.map(row=>JSON.stringify(row)).join('\n')+(rows.length?'\n':''),'utf8');}
function normalizePath(value=''){const resolved=path.resolve(String(value||''));return process.platform==='win32'?resolved.toLowerCase():resolved;}
function runContext(runDir){
  const state=readJson(path.join(runDir,'state.json'))||{};
  const project=readJson(path.join(runDir,'project.snapshot.json'))||{};
  const networkManifest=readJson(path.join(runDir,'network-import-manifest.json'))||{};
  const acquisitionMethod=(networkManifest.importType==='har-network'||networkManifest.acquisitionSource==='har')?'har-network':(networkManifest.importType==='network-response'?'network-json':String(project.acquisition?.method||state.acquisitionMethod||'dom'));
  return {state,project,sessionId:String(state.sessionId||state.runId||path.basename(runDir)),runId:String(state.runId||path.basename(runDir)),objectName:String(project.reviewSubject||project.source?.objectName||state.objectName||project.name||state.projectName||''),siteName:String(project.source?.siteName||state.siteName||project.siteProfile||state.siteProfile||''),siteProfile:String(project.siteProfile||state.siteProfile||''),sourceUrl:String(project.source?.sourceUrl||state.sourceUrl||state.currentUrl||''),acquisitionMethod};
}
function orderedCombined(row={},columns=COMBINED_COLUMNS){return Object.fromEntries(columns.map(key=>[key,row[key]??'']));}
function sourceIdentityKey(row={}){
  const site=String(row.source_site||'').trim().toUpperCase();
  const subject=String(row.canonical_object||row.review_subject||row._objectName||'').normalize('NFKC').replace(/\s+/g,' ').trim().toLocaleLowerCase('id-ID');
  const id=String(row.review_id||'').trim();
  if(!site||!id)return'';
  return `id|${site}|${subject||'unknown-object'}|${id}`;
}
function semanticCandidateKey(row={}){
  const subject=String(row.canonical_object||row.review_subject||'').normalize('NFKC').replace(/\s+/g,' ').trim().toLocaleLowerCase('id-ID');
  const text=String(row.review_text||'').normalize('NFKC').replace(/\s+/g,' ').trim().toLocaleLowerCase('id-ID');
  if(text.length<8)return'';
  const reviewer=String(row.reviewer_name||'').normalize('NFKC').replace(/\s+/g,' ').trim().toLocaleLowerCase('id-ID');
  const rating=String(row.rating_score||'').trim().replace(',','.');
  const date=String(row.review_date||'').trim();
  if(!(reviewer||date)||!rating||!subject)return'';
  // Kandidat semantik sengaja lintas website. Exact duplicate tetap mensyaratkan
  // source_site + review_id; kemiripan lintas sumber hanya masuk audit.
  const payload=[subject,text,reviewer,rating,date].join('|');
  return `semantic|${crypto.createHash('sha256').update(payload).digest('hex')}`;
}
// Backward export name used by older tests/modules. Exact identity only.
function semanticKey(row={}){return sourceIdentityKey(row)||semanticCandidateKey(row);}

const OBJECT_GENERIC_TOKENS = new Set([
  'hotel','hotels','resort','resorts','villa','villas','serviced','service',
  'residence','residences','apartment','apartments','suite','suites','inn',
  'guesthouse','homestay','the','and','dan','by'
]);

function normalizedObjectTokens(value=''){
  const normalized=String(value||'')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g,'')
    .replace(/city\s*hall/ig,'city hall')
    .toLocaleLowerCase('id-ID')
    .replace(/&/g,' and ')
    .replace(/[^a-z0-9]+/g,' ')
    .replace(/\s+/g,' ')
    .trim();
  return normalized.split(' ').filter(token=>token && !OBJECT_GENERIC_TOKENS.has(token));
}

function objectNameSimilarity(a='',b=''){
  const aa=new Set(normalizedObjectTokens(a));const bb=new Set(normalizedObjectTokens(b));
  if(!aa.size||!bb.size)return 0;
  let intersection=0;for(const token of aa)if(bb.has(token))intersection+=1;
  const union=new Set([...aa,...bb]).size;
  const jaccard=union?intersection/union:0;
  const containment=intersection/Math.min(aa.size,bb.size);
  return Math.max(jaccard, intersection>=2?containment*0.9:0);
}

function prettyCanonicalObject(value=''){
  return String(value||'').replace(/city\s*hall/ig,'City Hall').replace(/\s+/g,' ').trim();
}

function resolveCanonicalObjects(rows=[]){
  const names=[...new Set((Array.isArray(rows)?rows:[]).map(row=>String(row.source_object_name||row.review_subject||'').trim()).filter(Boolean))];
  const parent=names.map((_,i)=>i);
  const find=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
  const unite=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent[b]=a;};
  for(let i=0;i<names.length;i+=1)for(let j=i+1;j<names.length;j+=1){
    const sim=objectNameSimilarity(names[i],names[j]);
    if(sim>=0.55)unite(i,j);
  }
  const groups=new Map();
  names.forEach((name,index)=>{const root=find(index);if(!groups.has(root))groups.set(root,[]);groups.get(root).push(name);});
  const mapping=new Map();const clusters=[];
  for(const members of groups.values()){
    const scored=[...members].sort((a,b)=>{
      const at=normalizedObjectTokens(a).length,bt=normalizedObjectTokens(b).length;
      if(at!==bt)return at-bt;
      return a.length-b.length||a.localeCompare(b);
    });
    const canonical=prettyCanonicalObject(scored[0]||members[0]||'');
    members.forEach(name=>mapping.set(name,canonical));
    clusters.push({canonical,members:[...members].sort((a,b)=>a.localeCompare(b)),size:members.length});
  }
  return{mapping,clusters};
}

function cleanCanonicalOverride(value=''){
  return prettyCanonicalObject(String(value||'').normalize('NFKC').replace(/\s+/g,' ').trim());
}

function baseCanonicalOverrides(workspaceDir,baseDatasetDir){
  if(!baseDatasetDir)return{};
  try{
    const{manifest}=resolveCombinedDatasetDirectory(workspaceDir,baseDatasetDir);
    const out={};
    for(const item of Array.isArray(manifest?.sessions)?manifest.sessions:[]){
      const sessionId=String(item?.sessionId||'').trim();
      const canonical=cleanCanonicalOverride(item?.canonicalObject||'');
      if(sessionId&&canonical)out[sessionId]=canonical;
    }
    return out;
  }catch{return{};}
}

function finalObjectIdentityFromSessions(sessions=[],autoIdentity={clusters:[]}){
  const groups=new Map();
  for(const session of Array.isArray(sessions)?sessions:[]){
    const canonical=cleanCanonicalOverride(session?.canonicalObject||session?.objectName||'')||'Tanpa objek';
    const sourceName=String(session?.sourceObjectName||session?.objectName||'').trim();
    if(!groups.has(canonical))groups.set(canonical,{canonical,members:new Set(),sessionIds:[],manual:false});
    const group=groups.get(canonical);
    if(sourceName)group.members.add(sourceName);
    if(session?.sessionId)group.sessionIds.push(String(session.sessionId));
    if(session?.canonicalObjectSource==='manual')group.manual=true;
  }
  return{
    clusters:[...groups.values()].map(group=>({
      canonical:group.canonical,
      members:[...group.members].sort((a,b)=>a.localeCompare(b)),
      sessionIds:[...group.sessionIds],
      size:group.members.size,
      source:group.manual?'manual-or-mixed':'auto'
    })).sort((a,b)=>a.canonical.localeCompare(b.canonical)),
    autoClusters:Array.isArray(autoIdentity?.clusters)?autoIdentity.clusters:[]
  };
}

function sourceCandidateAudits(runDir,ctx){
  const rows=readJsonl(path.join(runDir,'duplicates-data.jsonl'));
  const candidates=rows.filter(row=>String(row?._dedupeStatus||'')==='possible_duplicate');
  return candidates.map(row=>({
    ...standardizeRows([row],{reviewSubject:ctx.objectName,objectName:ctx.objectName,siteName:ctx.siteName,siteProfile:ctx.siteProfile,sourceUrl:ctx.sourceUrl,acquisitionMethod:ctx.acquisitionMethod,sessionId:ctx.sessionId,runId:ctx.runId})[0],
    _auditScope:'source_session',
    _dedupeStatus:'possible_duplicate_source_session',
    _dedupeMethod:String(row?._dedupeMethod||'semantic-review'),
    _dedupeFingerprint:String(row?._dedupeFingerprint||''),
    _duplicateOf:String(row?._duplicateOf||''),
    _originalPage:row?._originalPage??'',
    _duplicatePage:row?._duplicatePage??'',
    _identityField:row?._identityField??'',
    _sourceSessionId:ctx.sessionId,
    _sourceRunId:ctx.runId,
    _originalRecord:row?._originalRecord||null
  }));
}

function compositionOf(rows=[]){
  const bySource=new Map();const byObject=new Map();
  for(const row of rows){const source=String(row.source_site||'UNKNOWN').trim().toUpperCase()||'UNKNOWN';const object=String(row.canonical_object||row.review_subject||'Tanpa objek').trim()||'Tanpa objek';bySource.set(source,(bySource.get(source)||0)+1);const objectKey=`${source}|${object}`;byObject.set(objectKey,{source,object,count:(byObject.get(objectKey)?.count||0)+1});}
  const withText=rows.reduce((count,row)=>count+(String(row.review_text||'').trim()?1:0),0);
  return{bySource:[...bySource.entries()].map(([source,count])=>({source,count})).sort((a,b)=>b.count-a.count||a.source.localeCompare(b.source)),byObject:[...byObject.values()].sort((a,b)=>b.count-a.count||a.object.localeCompare(b.object)),total:rows.length,withText,withoutText:rows.length-withText};
}
function versionToken(now=new Date()){const p=v=>String(v).padStart(2,'0');return`${now.getFullYear()}-${p(now.getMonth()+1)}-${p(now.getDate())}_${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`;}
function combinedRoot(workspaceDir){return ensureDir(path.join(workspaceDir,'Dataset Gabungan'));}
function legacyCombinedRoot(workspaceDir){return path.join(workspaceDir,'Combined Datasets');}
function isDefaultCombinedName(name=''){return projectDirectoryName(String(name||'').trim()||'Dataset Gabungan').toLocaleLowerCase('id-ID')===projectDirectoryName('Dataset Gabungan').toLocaleLowerCase('id-ID');}
function combinedParentDirectory(workspaceDir,name='Dataset Gabungan'){
  const root=combinedRoot(workspaceDir);
  return isDefaultCombinedName(name)?root:ensureDir(path.join(root,projectDirectoryName(name)));
}
function availableCombinedVersionDirectory(workspaceDir,name,now=new Date()){
  const parent=combinedParentDirectory(workspaceDir,name);
  const base=versionToken(now);let target=path.join(parent,base);if(!fs.existsSync(target))return target;
  for(let i=2;i<10000;i+=1){target=path.join(parent,`${base}_${i}`);if(!fs.existsSync(target))return target;}
  throw new Error('Tidak dapat membuat versi Dataset Gabungan yang unik.');
}
function validateRunDir(workspaceDir,runDir){const target=path.resolve(String(runDir||''));const allowed=[internalPath(workspaceDir,'Projects'),internalPath(workspaceDir,'Runs'),path.join(workspaceDir,'Projects'),path.join(workspaceDir,'Runs')].map(normalizePath);const normalized=normalizePath(target);if(!allowed.some(root=>normalized===root||normalized.startsWith(root+path.sep)))throw new Error('Sesi berada di luar penyimpanan MyDataset.');if(!fs.existsSync(path.join(target,'state.json'))||!fs.existsSync(path.join(target,'data.jsonl')))throw new Error(`Sesi tidak valid: ${path.basename(target)}`);return target;}
function resolveCombinedDatasetDirectory(workspaceDir,directory){
  const target=path.resolve(String(directory||''));const normalized=normalizePath(target);
  const roots=[combinedRoot(workspaceDir),legacyCombinedRoot(workspaceDir)].map(normalizePath);
  if(!roots.some(root=>normalized===root||normalized.startsWith(root+path.sep)))throw new Error('Dataset gabungan berada di luar workspace MyDataset.');
  const manifest=readJson(path.join(target,'manifest.json'));if(!manifest||manifest.type!=='combined-clean-dataset')throw new Error('Dataset gabungan tidak valid.');return{target,manifest};
}
function resolveBaseSessions(workspaceDir,baseDatasetDir){
  if(!baseDatasetDir)return[];
  const{manifest}=resolveCombinedDatasetDirectory(workspaceDir,baseDatasetDir);
  if(!Array.isArray(manifest.sessions))throw new Error('Dataset gabungan lama tidak memiliki manifest sesi yang valid.');
  const knownRuns=scanRuns(workspaceDir,{limit:Number.MAX_SAFE_INTEGER});
  return manifest.sessions.map(item=>{
    if(item.runRef){const resolved=resolveWorkspaceRef(workspaceDir,item.runRef);if(fs.existsSync(resolved))return resolved;}
    if(item.runDir&&fs.existsSync(item.runDir))return item.runDir; // manifest v0.98 dan lebih lama
    // sessionId adalah identitas utama. runId hanya nama folder berbasis waktu dan
    // dapat sama pada dua proyek yang dibuat dalam detik yang sama. Jangan memakai
    // OR fallback bila sessionId tersedia karena dapat menghubungkan dataset ke sesi lain.
    const match=item.sessionId
      ? knownRuns.find(run=>String(run.sessionId||'')===String(item.sessionId))
      : (item.runId ? knownRuns.find(run=>String(run.runId||'')===String(item.runId)) : null);
    return match?.runDir||'';
  }).filter(Boolean);
}
function createCombinedDataset(workspaceDir,payload={}){
  const name=projectDirectoryName(String(payload.name||'Dataset Gabungan').trim()||'Dataset Gabungan');
  const requested=[...resolveBaseSessions(workspaceDir,payload.baseDatasetDir),...(Array.isArray(payload.runDirs)?payload.runDirs:[])];const runDirs=[];const seenRuns=new Set();
  for(const value of requested){const target=validateRunDir(workspaceDir,value);const key=normalizePath(target);if(!seenRuns.has(key)){seenRuns.add(key);runDirs.push(target);}}
  if(runDirs.length<1)throw new Error('Pilih minimal satu sesi untuk dataset gabungan.');

  const all=[];const sessions=[];const sourceAuditCandidates=[];
  for(const runDir of runDirs){
    const ctx=runContext(runDir);const nativeRows=readJsonl(path.join(runDir,'data.jsonl'));
    const standardRows=standardizeRows(nativeRows,{reviewSubject:ctx.objectName,objectName:ctx.objectName,siteName:ctx.siteName,siteProfile:ctx.siteProfile,sourceUrl:ctx.sourceUrl,acquisitionMethod:ctx.acquisitionMethod,sessionId:ctx.sessionId,runId:ctx.runId});
    const enriched=standardRows.map((row,index)=>orderedCombined({...row,source_site:String(row.source_site||ctx.siteName||ctx.siteProfile||'').trim().toUpperCase(),source_url:String(nativeRows[index]?._sourceUrl||row.source_url||ctx.sourceUrl||''),acquisition_method:ctx.acquisitionMethod,session_id:ctx.sessionId,run_id:ctx.runId}));
    all.push(...enriched);
    sourceAuditCandidates.push(...sourceCandidateAudits(runDir,ctx));
    sessions.push({sessionId:ctx.sessionId,runId:ctx.runId,objectName:ctx.objectName,siteName:ctx.siteName,acquisitionMethod:ctx.acquisitionMethod,sourceUrl:ctx.sourceUrl,cleanCount:enriched.length,candidateDuplicates:Number(ctx.state?.possibleDuplicates||0)});
  }

  // Auto-matching is a suggestion only. Manual per-session overrides are applied
  // afterward so similarly named branches are never merged solely by fuzzy text.
  const autoObjectIdentity=resolveCanonicalObjects(all);
  const inheritedOverrides=baseCanonicalOverrides(workspaceDir,payload.baseDatasetDir);
  const requestedOverrides=payload.canonicalOverrides&&typeof payload.canonicalOverrides==='object'?payload.canonicalOverrides:{};
  const canonicalOverrides={...inheritedOverrides,...requestedOverrides};
  const canonicalBySession=new Map();
  for(const session of sessions){
    const sourceName=String(session.objectName||'').trim();
    const manual=cleanCanonicalOverride(canonicalOverrides[session.sessionId]||canonicalOverrides[session.runId]||'');
    const automatic=autoObjectIdentity.mapping.get(sourceName)||sourceName;
    session.sourceObjectName=sourceName;
    session.canonicalObject=manual||automatic;
    session.canonicalObjectSource=manual?'manual':'auto';
    canonicalBySession.set(String(session.sessionId||''),session.canonicalObject);
  }
  for(const row of all){
    const sourceName=String(row.source_object_name||row.review_subject||'').trim();
    row.source_object_name=sourceName;
    row.canonical_object=canonicalBySession.get(String(row.session_id||''))||autoObjectIdentity.mapping.get(sourceName)||String(row.canonical_object||sourceName);
  }
  for(const row of sourceAuditCandidates){
    const sourceName=String(row.source_object_name||row.review_subject||'').trim();
    row.source_object_name=sourceName;
    row.canonical_object=canonicalBySession.get(String(row.session_id||row._sourceSessionId||''))||autoObjectIdentity.mapping.get(sourceName)||String(row.canonical_object||sourceName);
  }
  const objectIdentity=finalObjectIdentityFromSessions(sessions,autoObjectIdentity);

  // Exact duplicate: same source + same source review ID. Semantic matches are retained.
  const clean=[];const audits=[];const exactIndex=new Map();const semanticIndex=new Map();let exactDuplicates=0;let candidateDuplicates=0;
  for(const row of all){
    const exactKey=sourceIdentityKey(row);
    if(exactKey&&exactIndex.has(exactKey)){
      const original=exactIndex.get(exactKey);
      if(String(original.session_id||'')!==String(row.session_id||'')){
        audits.push({...row,_dedupeStatus:'exact_duplicate_cross_session',_dedupeMethod:'source-id',_duplicateOfSessionId:original.session_id,_duplicateOfRunId:original.run_id,_dedupeKey:exactKey,_originalRecord:original});exactDuplicates+=1;continue;
      }
    }
    const candidateKey=semanticCandidateKey(row);const candidateOriginal=candidateKey?semanticIndex.get(candidateKey):null;
    if(candidateOriginal&&String(candidateOriginal.session_id||'')!==String(row.session_id||'')){
      audits.push({...row,_dedupeStatus:'possible_duplicate_cross_session',_dedupeMethod:'semantic-review',_duplicateOfSessionId:candidateOriginal.session_id,_duplicateOfRunId:candidateOriginal.run_id,_dedupeKey:candidateKey,_originalRecord:candidateOriginal});candidateDuplicates+=1;
    }
    clean.push(row);if(exactKey&&!exactIndex.has(exactKey))exactIndex.set(exactKey,row);if(candidateKey&&!semanticIndex.has(candidateKey))semanticIndex.set(candidateKey,row);
  }

  // Normalisasi rating adalah fitur merge, bukan fitur single-run. Ia hanya
  // diaktifkan bila dataset gabungan benar-benar mengandung lebih dari satu
  // rating_max (mis. 5 dan 10). rating_score/rating_max asli tetap utuh.
  const ratingProfile=ratingScaleProfile(clean,RATING_NORMALIZED_MAX);
  const normalizedCleanResult=applyConditionalRatingNormalization(clean,{profile:ratingProfile});
  const finalClean=normalizedCleanResult.rows;
  const allAudits=[...sourceAuditCandidates,...audits];
  const finalAudits=allAudits.map(row=>{
    const normalized=applyConditionalRatingNormalization([row],{profile:ratingProfile}).rows[0];
    if(row?._originalRecord&&typeof row._originalRecord==='object'){
      normalized._originalRecord=applyConditionalRatingNormalization([row._originalRecord],{profile:ratingProfile}).rows[0];
    }
    return normalized;
  });
  const combinedColumns=combinedColumnsForRows(finalClean);
  const orderedClean=finalClean.map(row=>orderedCombined(row,combinedColumns));

  const datasetDir=ensureDir(availableCombinedVersionDirectory(workspaceDir,name));
  const sourceDir=ensureDir(path.join(datasetDir,'01-Sumber'));const resultDir=ensureDir(path.join(datasetDir,'02-Hasil'));const auditDir=ensureDir(path.join(datasetDir,'03-Audit'));
  const textRows=orderedClean.filter(row=>String(row.review_text||'').trim());
  writeJsonl(path.join(resultDir,'dataset-gabungan.jsonl'),orderedClean);fs.writeFileSync(path.join(resultDir,'dataset-gabungan.csv'),toCsv(orderedClean),'utf8');
  fs.writeFileSync(path.join(resultDir,'dataset-gabungan-teks.csv'),toCsv(textRows),'utf8');fs.writeFileSync(path.join(resultDir,'dataset-gabungan.xlsx'),buildXlsx(orderedClean,{headers:combinedColumns}));
  if(finalAudits.length){writeJsonl(path.join(auditDir,'audit-duplikat.jsonl'),finalAudits);fs.writeFileSync(path.join(auditDir,'audit-duplikat.csv'),toCsv(finalAudits),'utf8');}
  const composition={input:compositionOf(all),clean:compositionOf(orderedClean)};
  const reportedIntraSessionCandidates=sessions.reduce((sum,item)=>sum+Number(item.candidateDuplicates||0),0);
  const sourceCandidateAuditRows=sourceAuditCandidates.length;
  const intraSessionCandidateDuplicates=Math.max(reportedIntraSessionCandidates,sourceCandidateAuditRows);
  const duplicateSummary={
    sourceSessionCandidateDuplicates:intraSessionCandidateDuplicates,
    sourceSessionCandidateAuditRows:sourceCandidateAuditRows,
    crossSessionExactDuplicates:exactDuplicates,
    crossSessionCandidateDuplicates:candidateDuplicates,
    totalCandidateDuplicates:intraSessionCandidateDuplicates+candidateDuplicates,
    combinedAuditRows:finalAudits.length
  };
  fs.writeFileSync(path.join(sourceDir,'komposisi-dataset.json'),JSON.stringify({name,sessions,composition,objectIdentity:{clusters:objectIdentity.clusters,autoClusters:objectIdentity.autoClusters},duplicateSummary,ratingNormalization:{enabled:ratingProfile.enabled,targetMax:ratingProfile.targetMax,sourceMaxima:ratingProfile.sourceMaxima}},null,2),'utf8');
  const manifest={schemaVersion:7,type:'combined-clean-dataset',name,createdAt:new Date().toISOString(),previousDatasetRef:payload.baseDatasetDir?relativeWorkspaceRef(workspaceDir,path.resolve(payload.baseDatasetDir)):null,sessions,counts:{sessions:sessions.length,input:all.length,clean:orderedClean.length,duplicates:exactDuplicates,exactDuplicates,candidateDuplicates,crossSessionExactDuplicates:exactDuplicates,crossSessionCandidateDuplicates:candidateDuplicates,intraSessionCandidateDuplicates,sourceSessionCandidateAuditRows:sourceCandidateAuditRows,totalCandidateDuplicates:intraSessionCandidateDuplicates+candidateDuplicates,auditRows:finalAudits.length,text:textRows.length,withoutText:orderedClean.length-textRows.length},composition,objectIdentity:{clusters:objectIdentity.clusters,autoClusters:objectIdentity.autoClusters},duplicateSummary,ratingNormalization:{enabled:ratingProfile.enabled,targetMax:ratingProfile.targetMax,sourceMaxima:ratingProfile.sourceMaxima},folders:{source:'01-Sumber',result:'02-Hasil',audit:'03-Audit'},files:{cleanCsv:'02-Hasil/dataset-gabungan.csv',cleanJsonl:'02-Hasil/dataset-gabungan.jsonl',textCsv:'02-Hasil/dataset-gabungan-teks.csv',xlsx:'02-Hasil/dataset-gabungan.xlsx',duplicatesCsv:finalAudits.length?'03-Audit/audit-duplikat.csv':null,duplicatesJsonl:finalAudits.length?'03-Audit/audit-duplikat.jsonl':null,composition:'01-Sumber/komposisi-dataset.json'}};
  fs.writeFileSync(path.join(datasetDir,'manifest.json'),JSON.stringify(manifest,null,2),'utf8');
  return{directory:datasetDir,manifest,rows:orderedClean.slice(0,300)};
}
function listFromRoot(root,out){
  if(!fs.existsSync(root))return;
  for(const entry of fs.readdirSync(root,{withFileTypes:true})){
    if(!entry.isDirectory())continue;
    const first=path.join(root,entry.name);
    const directManifest=readJson(path.join(first,'manifest.json'));
    if(directManifest?.type==='combined-clean-dataset'){out.push({...directManifest,directory:first});continue;}
    for(const version of fs.readdirSync(first,{withFileTypes:true})){
      if(!version.isDirectory())continue;
      const directory=path.join(first,version.name);
      const manifest=readJson(path.join(directory,'manifest.json'));
      if(manifest?.type==='combined-clean-dataset')out.push({...manifest,directory});
    }
  }
}
function listCombinedDatasets(workspaceDir,{limit=50}={}){const out=[];listFromRoot(combinedRoot(workspaceDir),out);listFromRoot(legacyCombinedRoot(workspaceDir),out);return out.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).slice(0,limit);}
function pruneCombinedParents(workspaceDir,target){
  const root=path.resolve(combinedRoot(workspaceDir));let current=path.dirname(path.resolve(target));
  while(current!==root&&current.startsWith(root+path.sep)){
    try{if(!fs.existsSync(current)||fs.readdirSync(current).length)break;fs.rmdirSync(current);}catch{break;}
    current=path.dirname(current);
  }
}
function deleteCombinedDataset(workspaceDir,directory){
  const{target}=resolveCombinedDatasetDirectory(workspaceDir,directory);
  if(!fs.existsSync(target))return{deleted:0,missing:true};
  fs.rmSync(target,{recursive:true,force:false,maxRetries:2,retryDelay:100});
  pruneCombinedParents(workspaceDir,target);
  return{deleted:1,missing:false};
}
function clearCombinedDatasets(workspaceDir){
  const datasets=listCombinedDatasets(workspaceDir,{limit:Number.MAX_SAFE_INTEGER});let deleted=0;const seen=new Set();
  for(const dataset of datasets){const key=normalizePath(dataset.directory);if(seen.has(key))continue;seen.add(key);try{deleted+=deleteCombinedDataset(workspaceDir,dataset.directory).deleted||0;}catch{}}
  return{deleted};
}
function readCombinedDataset(workspaceDir,directory,limit=300,dataset='clean'){
  const{target,manifest}=resolveCombinedDatasetDirectory(workspaceDir,directory);const selected=dataset==='duplicates'?'duplicates':'clean';
  const fileName=selected==='duplicates'?(manifest.files?.duplicatesJsonl||'audit-duplikat-gabungan.jsonl'):(manifest.files?.cleanJsonl||'data-bersih-gabungan.jsonl');
  const storedRows=readJsonl(path.join(target,fileName));
  // Apply the current conditional-normalization contract when opening legacy
  // combined datasets too. The stored historical file is not mutated; only the
  // active view/export is upgraded in memory.
  const normalized=applyConditionalRatingNormalization(storedRows);
  const rows=normalized.rows;
  const requested=Number(limit);const visible=Number.isFinite(requested)&&requested<=0?rows:rows.slice(0,Math.max(1,requested||300));
  const baseManifest=manifest.composition?manifest:{...manifest,composition:{...(manifest.composition||{}),[selected]:compositionOf(rows)}};
  const effectiveManifest={...baseManifest,ratingNormalization:{enabled:normalized.profile.enabled,targetMax:normalized.profile.targetMax,sourceMaxima:normalized.profile.sourceMaxima}};
  return{manifest:effectiveManifest,dataset:selected,rows:visible};
}
module.exports={COMBINED_COLUMNS,combinedColumnsForRows,combinedRoot,createCombinedDataset,listCombinedDatasets,readCombinedDataset,resolveCombinedDatasetDirectory,deleteCombinedDataset,clearCombinedDatasets,semanticKey,sourceIdentityKey,semanticCandidateKey,objectNameSimilarity,resolveCanonicalObjects};
