'use strict';

const $ = id => document.getElementById(id);
const core = globalThis.MyDatasetCaptureCore;
const exporter = globalThis.MyDatasetCaptureExport;
const state = { capturing:false, records:[], seen:new Set(), sourceUrl:'', pageTitle:'', platform:'', diagnosticRecords:[] };

function profile() { return core.profileForPlatform(state.platform); }
function setStatus(text) { $('statusText').textContent = String(text || 'Siap'); }
function setCaptureUi() {
  const supported = Boolean(profile());
  $('captureBtn').disabled = !supported;
  $('scanBtn').disabled = !supported;
  $('captureBtn').textContent = state.capturing ? 'Hentikan Capture' : 'Mulai Capture';
  $('captureBadge').textContent = state.capturing ? 'Capture aktif' : (supported ? 'Siap' : 'Tidak didukung');
  $('captureBadge').classList.toggle('active', state.capturing);
  $('captureBadge').classList.toggle('idle', !state.capturing);
  $('unsupportedNotice').classList.toggle('hidden', supported);
}
function addRecord(record) {
  if (!record || state.seen.has(record.fingerprint)) return false;
  state.seen.add(record.fingerprint); state.records.push(record); return true;
}
function addDiagnosticRecord(record) {
  if (!record) return false;
  const key=String(record.fingerprint || `${record.method||''}|${record.url||''}|${record.startedDateTime||''}`);
  if (state.diagnosticRecords.some(item => String(item.fingerprint || `${item.method||''}|${item.url||''}|${item.startedDateTime||''}`)===key)) return false;
  state.diagnosticRecords.push(record); return true;
}
async function requestToRecord(request, fromScan=false, filter='') {
  const result = await core.requestRecord(request, { filter, successOnly:$('successOnly').checked, fromScan });
  return result.record || null;
}
async function captureRequest(request,{fromScan=false}={}) {
  const p=profile(); if(!p) return false;
  const url=String(request?.request?.url||'');
  if (p.matchesPrimary(url)) {
    const record=await requestToRecord(request,fromScan,p.primaryFilter);
    if (!record || !addRecord(record)) return false;
    render(); setStatus(`${state.records.length} response`); return true;
  }
  if (p.matchesDiagnostic(url)) {
    const record=await requestToRecord(request,fromScan,core.endpointLeaf(url));
    if (!record) return false;
    const added=addDiagnosticRecord(record); if(added) render(); return added;
  }
  return false;
}
function captureMeta(mode) {
  const p=profile();
  return { sourceUrl:state.sourceUrl, pageTitle:state.pageTitle, platform:p?.label||'', platformId:p?.id||'', filter:p?.primaryFilter||'', inspectedTabId:chrome.devtools.inspectedWindow.tabId, captureMode:mode, diagnosticRecords:state.diagnosticRecords };
}
function render() {
  const artifacts=exporter.buildCaptureArtifacts(state.records,captureMeta('devtools-panel'));
  const stats=artifacts.stats;
  $('responseCount').textContent=stats.responseCount.toLocaleString('id-ID');
  $('rawReviewCount').textContent=stats.rawReviewCount.toLocaleString('id-ID');
  $('uniqueReviewCount').textContent=stats.uniqueReviewCount.toLocaleString('id-ID');
  $('duplicateReviewCount').textContent=stats.duplicateReviewCount.toLocaleString('id-ID');
  $('paginationState').textContent=stats.lastHasNext==null?'-':(stats.endpointPaginationComplete?'Selesai':'Belum selesai');
  $('savePackageBtn').disabled=state.records.length===0;
  $('saveJsonBtn').disabled=state.records.length===0;
  $('emptyState').classList.toggle('hidden',state.records.length>0);
  $('resultTable').classList.toggle('hidden',state.records.length===0);
  const tbody=$('resultTable').querySelector('tbody'); tbody.innerHTML='';
  const width=Math.max(4,String(Math.max(1,state.records.length)).length);
  state.records.forEach((item,index)=>{
    const per=stats.perRecord[index]||{}; const tr=document.createElement('tr');
    const time=(()=>{try{return new Date(item.capturedAt).toLocaleTimeString('id-ID')}catch{return''}})();
    const rawName=`${artifacts.endpoint}-${String(index+1).padStart(width,'0')}.json`;
    const values=[`${index+1}\n${rawName}`,time,`${item.method||'GET'} ${item.url||''}`,String(item.status||''),Number(per.rawReviewCount||0).toLocaleString('id-ID'),Number(per.uniqueNewReviewCount||0).toLocaleString('id-ID'),Number(per.duplicateReviewCount||0).toLocaleString('id-ID'),per.hasNext==null?'-':(per.hasNext?'lanjut':'akhir')];
    values.forEach((value,i)=>{const td=document.createElement('td');td.textContent=value;if(i===2)td.className='url';tr.appendChild(td)}); tbody.appendChild(tr);
  });
  setCaptureUi();
}
function refreshInspectedSource() {
  setStatus('Membaca halaman…');
  chrome.devtools.inspectedWindow.eval('({url: location.href, title: document.title || ""})',(result,exceptionInfo)=>{
    if(exceptionInfo?.isException||!result){setStatus('Halaman tidak dapat dibaca');return;}
    state.sourceUrl=String(result.url||''); state.pageTitle=String(result.title||''); state.platform=core.detectPlatform(state.sourceUrl);
    const p=profile(); $('sourceUrl').value=state.sourceUrl; $('pageTitle').textContent=state.pageTitle||'Tanpa judul'; $('sourceHost').textContent=exporter.safeHost(state.sourceUrl); $('platformName').value=p?.label||'Tidak didukung'; $('endpointName').value=p?.primaryFilter||'-';
    setStatus(p?'Siap':'Platform belum didukung'); setCaptureUi();
  });
}
async function scanCurrentHar() {
  const p=profile(); if(!p) return setStatus('Platform belum didukung.');
  $('scanBtn').disabled=true; setStatus('Memindai Network…');
  try {
    const scan=await core.scanCurrentHar({filter:p.primaryFilter,successOnly:$('successOnly').checked});
    state.diagnosticRecords=[];
    if(p.id==='traveloka') {
      const family=await core.scanCurrentHar({filter:'getReview',successOnly:$('successOnly').checked});
      const aggregate=await core.scanCurrentHar({filter:'getAvailableReviewWithAggregate',successOnly:$('successOnly').checked});
      for(const record of [...(family.records||[]),...(aggregate.records||[])]) if(p.matchesDiagnostic(record.url)) addDiagnosticRecord(record);
    }
    let added=0; for(const record of scan.records||[]) if(p.matchesPrimary(record.url)&&addRecord(record)) added+=1;
    render(); setStatus(added?`${added} response baru ditemukan`:'Tidak ada response baru');
  } catch(error){setStatus(`Gagal memindai: ${error?.message||error}`)} finally{$('scanBtn').disabled=false;setCaptureUi()}
}
function clearRecords(){state.records=[];state.seen.clear();state.diagnosticRecords=[];render();setStatus('Dikosongkan')}
function downloadBlob(blob,fileName){const u=URL.createObjectURL(blob);const a=document.createElement('a');a.href=u;a.download=fileName;a.style.display='none';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),30000)}
async function savePackage(){if(!state.records.length)return;setStatus('Membuat paket capture…');try{const meta={...captureMeta('devtools-panel'),capturedAt:new Date().toISOString()};const artifacts=exporter.buildCaptureArtifacts(state.records,meta);downloadBlob(exporter.zipBlob(artifacts.entries),`MyDataset-Capture-${exporter.safeFilePart(meta.platform||exporter.safeHost(meta.sourceUrl))}-${exporter.localStamp()}.zip`);setStatus(`Paket tersimpan · ${artifacts.stats.uniqueReviewCount.toLocaleString('id-ID')} review unik`)}catch(e){setStatus(`Gagal menyimpan: ${e?.message||e}`)}finally{render()}}
async function saveJson(){if(!state.records.length)return;setStatus('Membuat JSON Capture…');try{const meta={...captureMeta('devtools-panel'),capturedAt:new Date().toISOString()};const artifacts=exporter.buildCaptureArtifacts(state.records,meta);downloadBlob(new Blob([JSON.stringify(artifacts.aggregate,null,2)],{type:'application/json;charset=utf-8'}),`MyDataset-Capture-${exporter.safeFilePart(meta.platform||exporter.safeHost(meta.sourceUrl))}-${artifacts.endpoint}-${exporter.localStamp()}.json`);setStatus(`JSON tersimpan · ${artifacts.stats.uniqueReviewCount.toLocaleString('id-ID')} review unik`)}catch(e){setStatus(`Gagal menyimpan: ${e?.message||e}`)}finally{render()}}

$('captureBtn').addEventListener('click',async()=>{if(!state.capturing){state.capturing=true;setCaptureUi();setStatus('Menunggu request…');return;}state.capturing=false;setCaptureUi();setStatus('Menyinkronkan Network…');await scanCurrentHar();if(state.records.length)setStatus(`Capture selesai · ${state.records.length} response`)});
$('scanBtn').addEventListener('click',scanCurrentHar); $('clearBtn').addEventListener('click',clearRecords); $('refreshSourceBtn').addEventListener('click',refreshInspectedSource); $('savePackageBtn').addEventListener('click',savePackage); $('saveJsonBtn').addEventListener('click',saveJson);
chrome.devtools.network.onRequestFinished.addListener(request=>{if(state.capturing)captureRequest(request).catch(()=>{})});
refreshInspectedSource(); render();
