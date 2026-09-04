(() => {
  'use strict';

  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
  const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':'&quot;',"'":'&#39;'}[ch]));
  const modeLabel=mode=>({quick:'Halaman aktif',multipage:'Beberapa/Semua halaman',crawl:'Jelajah URL'}[mode]||'Halaman aktif');
  const acquisitionLabel=method=>({dom:'Halaman Web / DOM','network-json':'HAR / Network'}[method]||method||'Halaman Web / DOM');
  const paginationLabel=type=>({none:'Tidak ada',next:'Tombol berikutnya',loadMore:'Muat lebih banyak',scroll:'Scroll otomatis',urlPattern:'Pola URL',links:'Ikuti link'}[type]||type||'Tidak ada');
  const phaseForType=type=>({
    MULAI:'setup',PROJECT:'setup',RENCANA:'setup',
    BROWSER:'browser',KEAMANAN:'guard',GUARD:'guard',WARNING:'guard',
    ROUTER:'navigate',CRAWLER:'navigate',NAVIGASI:'navigate',
    SCRAPER:'extract',DOM:'extract',STRUKTUR:'extract',FIELD:'extract',
    VALIDASI:'validate',DATA:'data',KEANDALAN:'data',
    HASIL:'output',OBSERVABILITY:'output',VISUAL:'output'
  }[String(type||'').toUpperCase()]||'setup');
  const stageNodeIds={
    project:{
      starting:['PROJECT_START','ACQUISITION_ROUTE'],loading:['PAGE_BROWSER','NETWORK_INPUT'],'access-guard':['ACCESS_GUARD'],
      crawling:['PAGE_BROWSER'],discovering:['DISCOVERY'],expanding:['FIELD_EXTRACTOR'],extracting:['FIELD_EXTRACTOR','SITE_ADAPTER'],
      normalizing:['VALIDATION','NORMALIZE'],deduplicating:['DEDUP','POTENTIAL_DUPLICATES'],checkpoint:['CHECKPOINT','DATASET'],
      pagination:['NAVIGATION'],'pagination-confirmed':['NAVIGATION','PAGE_BROWSER'],'pagination-recovery':['NAVIGATION','CHECKPOINT'],'pagination-recovered':['NAVIGATION','PAGE_BROWSER'],'pagination-end':['NAVIGATION'],scrolling:['NAVIGATION'],replaying:['NAVIGATION','PAGE_BROWSER'],
      exporting:['EXPORT'],done:['DATASET','EXPORT']
    },
    system:{
      starting:['SYS_START','SYS_MODE'],loading:['SYS_BROWSER','SYS_CAPTURE','SYS_NETWORK'],'access-guard':['SYS_ACCESS'],
      crawling:['SYS_BROWSER'],discovering:['SYS_BROWSER'],expanding:['SYS_EXTRACT'],extracting:['SYS_EXTRACT','SYS_NETWORK'],
      normalizing:['SYS_VALIDATE','SYS_NORMALIZE'],deduplicating:['SYS_DEDUP'],checkpoint:['SYS_CHECKPOINT','SYS_DATASET'],
      pagination:['SYS_NAV'],'pagination-confirmed':['SYS_NAV','SYS_BROWSER'],'pagination-recovery':['SYS_NAV','SYS_CHECKPOINT'],'pagination-recovered':['SYS_NAV','SYS_BROWSER'],'pagination-end':['SYS_NAV'],scrolling:['SYS_NAV'],replaying:['SYS_NAV','SYS_BROWSER'],
      exporting:['SYS_EXPORT'],done:['SYS_DATASET','SYS_EXPORT']
    }
  };

  function idsForStage(kind,stage,nodes){
    const ids=stageNodeIds[kind]?.[stage]||[];
    const expanded=[];
    for(const id of ids){
      if(id==='@FIELDS') expanded.push(...nodes.filter(n=>/^FIELD_\d+$/.test(n.id)).map(n=>n.id));
      else expanded.push(id);
    }
    return expanded;
  }

  function applyRuntime(graph,runtime={},kind='project'){
    const stage=String(runtime.stage||'idle');
    const effectiveStage=['retry','error','partial'].includes(stage)?String(runtime.failureStage||runtime.lastOperationalStage||'loading'):stage;
    const started=Boolean(runtime.started||runtime.running||!['idle',''].includes(stage));
    const completedStages=new Set(Array.isArray(runtime.completedStages)?runtime.completedStages:[]);
    if(stage==='done')completedStages.add(effectiveStage);
    const completeIds=new Set();
    for(const completed of completedStages)for(const id of idsForStage(kind,completed,graph.nodes))completeIds.add(id);
    const activeIdList=idsForStage(kind,effectiveStage,graph.nodes);
    const activeIds=new Set(activeIdList);
    if(stage==='done')activeIds.clear();
    for(const n of graph.nodes){
      n.phase=n.phase||phaseForType(n.type);
      n.configStatus=n.status||'neutral';
      if(!started)n.runtimeStatus='pending';
      else if(activeIds.has(n.id))n.runtimeStatus=stage==='error'?'error':stage==='partial'?'warning':'active';
      else if(completeIds.has(n.id))n.runtimeStatus='complete';
      else n.runtimeStatus='pending';
      n.runtimeLabel={active:'Sedang berjalan',complete:'Selesai',error:'Gagal',warning:'Perlu perhatian',pending:n.configStatus==='warn'?'Perlu disiapkan':n.configStatus==='bad'?'Diblokir':n.configStatus==='good'?'Siap':'Menunggu'}[n.runtimeStatus];
    }
    const byId=new Map(graph.nodes.map(n=>[n.id,n]));
    for(const e of graph.edges){
      const from=byId.get(e.from),to=byId.get(e.to);
      e.phase=to?.phase||from?.phase||'setup';
      if(to?.runtimeStatus==='error'||from?.runtimeStatus==='error')e.runtimeStatus='error';
      else if(to?.runtimeStatus==='warning')e.runtimeStatus='warning';
      else if(to?.runtimeStatus==='active'||(from?.runtimeStatus==='active'&&e.kind==='loop'))e.runtimeStatus='active';
      else if(from?.runtimeStatus==='complete'&&to?.runtimeStatus==='complete')e.runtimeStatus='complete';
      else e.runtimeStatus='pending';
    }
    const nodeById=new Map(graph.nodes.map(n=>[n.id,n]));
    const primaryActiveNode=activeIdList.map(id=>nodeById.get(id)).find(Boolean)||graph.nodes.find(n=>['active','warning','error'].includes(n.runtimeStatus));
    graph.runtime={stage,started,kind,primaryActiveId:primaryActiveNode?.id||''};
    return graph;
  }

  function node(id,title,subtitle,x,y,options={}){
    return {
      id,title,subtitle,x,y,w:options.w||285,h:options.h||110,
      type:options.type||'PROSES',status:options.status||'neutral',
      meta:options.meta||[],technical:options.technical||[],description:options.description||subtitle||'',
      simpleTitle:options.simpleTitle||title,phase:options.phase||phaseForType(options.type||'PROSES'),
      action:options.action||'',actionLabel:options.actionLabel||'',directAction:Boolean(options.directAction)
    };
  }
  function edge(from,to,label='',options={}){return {from,to,label,kind:options.kind||'normal',dashed:Boolean(options.dashed)};}

  function projectGraph(project={},runtime={}){
    const nodes=[]; const edges=[];
    const rows=Number(runtime.rows||0),dupes=Number(runtime.duplicates||0),possible=Number(runtime.possibleDuplicates||0),warnings=Number(runtime.validationWarnings||0);
    const method=String(project.acquisition?.method||'network-json')==='dom'?'dom':'network-json';
    const site=String(project.siteProfile||'auto');
    const siteLabel=({tiket:'Tiket',agoda:'Agoda',trip:'Trip',traveloka:'Traveloka',booking:'Booking'}[site]||'Pilih website');
    const objectName=project.reviewSubject||project.source?.objectName||'Target belum diberi nama';
    const startUrl=project.startUrl||project.source?.sourceUrl||runtime.currentUrl||'Belum ada URL';
    const mode=project.mode||'quick';
    const fields=Array.isArray(project.fields)?project.fields:[];
    const itemSelector=project.itemSelector||'';
    const add=(...args)=>{const n=node(...args);nodes.push(n);return n.id;};
    const link=(a,b,l='',o={})=>edges.push(edge(a,b,l,o));

    add('PROJECT_START','Target Penelitian',objectName,90,120,{type:'MULAI',status:objectName?'good':'warn',meta:[['Objek',objectName],['Website',siteLabel]],technical:[['Node ID','PROJECT_START'],['Project schema',String(project.version||22)]]});
    add('ACQUISITION_ROUTE','Metode Akuisisi',acquisitionLabel(method),420,120,{type:'ROUTER',status:'good',meta:[['Metode',acquisitionLabel(method)],['Website',siteLabel]],technical:[['Node ID','ACQUISITION_ROUTE'],['Rule',method==='network-json'?'Traveloka · Tiket · Agoda · Trip · Booking':'Tiket · Agoda · Trip']]});
    link('PROJECT_START','ACQUISITION_ROUTE');

    if(method==='network-json'){
      const adapterBySite={
        traveloka:{endpoint:'getReviews',label:'Traveloka getReviews',primaryKey:'reviewId'},
        tiket:{endpoint:'verticalReview/internalReview',label:'Tiket internalReview',primaryKey:'submitId'},
        agoda:{endpoint:'ReviewComments',label:'Agoda ReviewComments',primaryKey:'hotelReviewId'},
        trip:{endpoint:'getHotelCommentInfo',label:'Trip getHotelCommentInfo',primaryKey:'id'},
        booking:{endpoint:'dml/graphql ReviewList',label:'Booking ReviewList',primaryKey:'reviewUrl'}
      };
      const adapter=adapterBySite[site]||{endpoint:'endpoint review',label:'Adapter HAR',primaryKey:'ID sumber'};
      add('NETWORK_INPUT','HAR / Network',`Membaca HAR Chrome/Edge dan memvalidasi endpoint review.`,760,120,{type:'BROWSER',status:'good',meta:[['Website',siteLabel],['Input','HAR / Network'],['Source URL',project.source?.sourceUrl||startUrl]],technical:[['Node ID','NETWORK_INPUT'],['Expected endpoint',adapter.endpoint]]});
      add('SITE_ADAPTER',`Parse ${adapter.endpoint}`,`Ambil response ${siteLabel} dan ubah review menjadi record native.`,1080,120,{type:'SCRAPER',status:'good',meta:[['Adapter',adapter.label],['Record',String(rows)]],technical:[['Node ID','SITE_ADAPTER'],['DOM','Tidak digunakan']]});
      add('VALIDATION','Validasi Sumber','Periksa response, field inti, provenance, pagination, dan coverage HAR.',1400,120,{type:'VALIDASI',status:warnings?'warn':'good',meta:[['Peringatan',String(warnings)],['Prinsip','Hanya response yang terekam di HAR diproses']],technical:[['Node ID','VALIDATION'],['Source type','har-network']]});
      add('NORMALIZE','Normalisasi Review','Utamakan teks Bahasa Indonesia bila tersedia; rapikan tanggal, rating, dan metadata tanpa mengarang nilai.',1720,120,{type:'DATA',status:'good',technical:[['Node ID','NORMALIZE']]});
      add('DEDUP','Pemeriksaan Duplikat',`Gunakan ${adapter.primaryKey} sebagai identitas sumber bila tersedia; kemiripan hanya menjadi Potensi Duplikat.`,2040,120,{type:'DATA',status:'good',meta:[['Duplikat Pasti',String(dupes)],['Potensi Duplikat',String(possible)]],technical:[['Node ID','DEDUP'],['Primary key',adapter.primaryKey]]});
      if(possible>0){
        add('POTENTIAL_DUPLICATES','Potensi Duplikat',`${possible.toLocaleString('id-ID')} review perlu diperiksa. Klik untuk membuka visualisasi audit.`,2040,390,{type:'VISUAL',status:'warn',meta:[['Jumlah',String(possible)],['Keputusan','Tetap dipertahankan']],technical:[['Node ID','POTENTIAL_DUPLICATES']],action:'duplicates-map',actionLabel:'Lihat Potensi Duplikat',directAction:true});
        link('DEDUP','POTENTIAL_DUPLICATES','audit',{dashed:true});
      }
      add('CHECKPOINT','Simpan Progress','Simpan state run dan record yang sudah aman.',2360,120,{type:'KEANDALAN',status:'good',meta:[['Hasil',String(rows)]],technical:[['Node ID','CHECKPOINT']]});
      add('DATASET','Dataset',`${rows} hasil`,2680,120,{type:'HASIL',status:rows?'good':'neutral',meta:[['Metode','HAR / Network'],['Website',siteLabel]],technical:[['Node ID','DATASET']]});
      add('EXPORT','Ekspor','CSV · Excel · JSON · Paket Lengkap',3000,120,{type:'HASIL',status:'neutral',technical:[['Node ID','EXPORT']]});
      ['ACQUISITION_ROUTE','NETWORK_INPUT','SITE_ADAPTER','VALIDATION','NORMALIZE','DEDUP','CHECKPOINT','DATASET'].forEach((from,i)=>link(from,['NETWORK_INPUT','SITE_ADAPTER','VALIDATION','NORMALIZE','DEDUP','CHECKPOINT','DATASET','EXPORT'][i]));
      return applyRuntime({nodes,edges,title:`Alur Proses · ${siteLabel} HAR/Network`,layoutKey:'project-xhr'},runtime,'project');
    }

    add('SITE_ADAPTER','Website DOM',siteLabel,760,120,{type:'PROJECT',status:['tiket','agoda','trip'].includes(site)?'good':'warn',meta:[['Didukung','Tiket · Agoda · Trip'],['Traveloka/Booking','HAR/Network saja']],technical:[['Node ID','SITE_ADAPTER']]});
    add('ACCESS_GUARD','Pemeriksaan Akses','Pastikan halaman asli dapat dibaca dan bukan challenge/block page.',1080,120,{type:'KEAMANAN',status:runtime.accessStatus==='restricted'?'bad':'good',meta:[['Status',runtime.accessStatus==='restricted'?'Akses dibatasi':'Siap']],technical:[['Node ID','ACCESS_GUARD']]});
    add('PAGE_BROWSER','Buka Halaman','Browser memuat halaman dan menjaga sesi situs.',1400,120,{type:'BROWSER',status:'good',meta:[['URL',runtime.currentUrl||startUrl]],technical:[['Node ID','PAGE_BROWSER']]});
    add('DOM_ANALYZER','Baca Struktur DOM',itemSelector?'Batas record sudah ditemukan.':'Menunggu struktur record.',1720,120,{type:'DOM',status:itemSelector?'good':'warn',meta:[['Container',itemSelector||'Belum ada']],technical:[['Node ID','DOM_ANALYZER']]});
    add('FIELD_EXTRACTOR','Ekstraksi Field',`${fields.length} field dikonfigurasi`,2040,120,{type:'SCRAPER',status:fields.length?'good':'warn',meta:[['Field',String(fields.length)]],technical:[['Node ID','FIELD_EXTRACTOR']]});
    add('VALIDATION','Validasi Record','Periksa field kosong, drift selector, cardinality, dan tipe nilai.',2360,120,{type:'VALIDASI',status:warnings?'warn':'good',meta:[['Peringatan',String(warnings)]],technical:[['Node ID','VALIDATION']]});
    add('NORMALIZE','Normalisasi','Rapikan nilai sambil mempertahankan provenance.',2680,120,{type:'DATA',status:'good',technical:[['Node ID','NORMALIZE']]});
    add('DEDUP','Pemeriksaan Duplikat','Pisahkan Duplikat Pasti dan tandai Potensi Duplikat tanpa menghapusnya.',3000,120,{type:'DATA',status:'good',meta:[['Duplikat Pasti',String(dupes)],['Potensi Duplikat',String(possible)]],technical:[['Node ID','DEDUP']]});
    if(possible>0){
      add('POTENTIAL_DUPLICATES','Potensi Duplikat',`${possible.toLocaleString('id-ID')} review perlu diperiksa. Klik untuk membuka visualisasi audit.`,3000,420,{type:'VISUAL',status:'warn',meta:[['Jumlah',String(possible)],['Keputusan','Tetap dipertahankan']],technical:[['Node ID','POTENTIAL_DUPLICATES']],action:'duplicates-map',actionLabel:'Lihat Potensi Duplikat',directAction:true});
      link('DEDUP','POTENTIAL_DUPLICATES','audit',{dashed:true});
    }
    if(mode==='crawl'){
      add('DISCOVERY','Temukan Halaman','Cari tautan baru yang masih berada di cakupan crawl.',3320,20,{type:'CRAWLER',status:'good',meta:[['Maks. URL',String(project.crawl?.maxUrls||100)],['Kedalaman',String(project.crawl?.maxDepth||2)]],technical:[['Node ID','DISCOVERY']]});
      link('DEDUP','DISCOVERY','temukan URL'); link('DISCOVERY','PAGE_BROWSER','URL berikutnya',{dashed:true,kind:'loop'});
    }else if(mode==='multipage'||project.pagination?.type!=='none'){
      add('NAVIGATION','Navigasi Halaman',paginationLabel(project.pagination?.type||'none'),3320,20,{type:'NAVIGASI',status:project.pagination?.type&&project.pagination.type!=='none'?'good':'warn',meta:[['Batas',String(project.pagination?.maxPages||1)]],technical:[['Node ID','NAVIGATION']]});
      link('VALIDATION','NAVIGATION','lanjut halaman'); link('NAVIGATION','PAGE_BROWSER','halaman berikutnya',{dashed:true,kind:'loop'});
    }
    add('CHECKPOINT','Simpan Progress','Setiap tahap aman disimpan agar dapat dicoba lagi dari checkpoint.',3320,170,{type:'KEANDALAN',status:'good',meta:[['Hasil',String(rows)]],technical:[['Node ID','CHECKPOINT']]});
    add('DATASET','Dataset',`${rows} hasil`,3640,170,{type:'HASIL',status:rows?'good':'neutral',meta:[['Metode','DOM'],['Website',siteLabel]],technical:[['Node ID','DATASET']]});
    add('EXPORT','Ekspor','CSV · Excel · JSON · Paket Lengkap',3960,170,{type:'HASIL',status:'neutral',technical:[['Node ID','EXPORT']]});
    link('ACQUISITION_ROUTE','SITE_ADAPTER');link('SITE_ADAPTER','ACCESS_GUARD');link('ACCESS_GUARD','PAGE_BROWSER');link('PAGE_BROWSER','DOM_ANALYZER');link('DOM_ANALYZER','FIELD_EXTRACTOR');link('FIELD_EXTRACTOR','VALIDATION');link('VALIDATION','NORMALIZE');link('NORMALIZE','DEDUP');link('DEDUP','CHECKPOINT');link('CHECKPOINT','DATASET');link('DATASET','EXPORT');
    return applyRuntime({nodes,edges,title:`Alur Proses · ${siteLabel} DOM`,layoutKey:'project-dom'},runtime,'project');
  }

  function systemGraph(runtime={}){
    const nodes=[]; const edges=[]; const add=(...args)=>{const n=node(...args);nodes.push(n);return n.id;};const link=(a,b,l='',o={})=>edges.push(edge(a,b,l,o));
    add('SYS_START','Target Penelitian','Objek yang ingin dikumpulkan review-nya.',80,170,{type:'MULAI',status:'good',technical:[['Node ID','SYS_START']]});
    add('SYS_MODE','Metode Akuisisi','Pilih HAR / Network atau Halaman Web / DOM.',400,170,{type:'ROUTER',status:'good',meta:[['HAR/Network','Traveloka · Tiket · Agoda · Trip · Booking'],['DOM','Tiket · Agoda · Trip']],technical:[['Node ID','SYS_MODE']]});link('SYS_START','SYS_MODE');

    add('SYS_DOM_SITES','Tiket · Agoda · Trip','Website yang didukung melalui Halaman Web / DOM.',740,40,{type:'PROJECT',status:'good',technical:[['Node ID','SYS_DOM_SITES']]});link('SYS_MODE','SYS_DOM_SITES','DOM');
    add('SYS_BROWSER','Browser','Muat halaman dan pertahankan sesi website.',1060,40,{type:'BROWSER',status:'good',technical:[['Node ID','SYS_BROWSER']]});link('SYS_DOM_SITES','SYS_BROWSER');
    add('SYS_ACCESS','Pemeriksaan Akses','Deteksi challenge, block page, atau halaman yang tidak valid.',1380,40,{type:'KEAMANAN',status:'good',technical:[['Node ID','SYS_ACCESS']]});link('SYS_BROWSER','SYS_ACCESS');
    add('SYS_DOM','Struktur DOM','Temukan batas record dan selector field yang dipilih.',1700,40,{type:'DOM',status:'good',technical:[['Node ID','SYS_DOM']]});link('SYS_ACCESS','SYS_DOM');

    add('SYS_XHR_SITE','Traveloka · Tiket · Agoda · Trip · Booking','Website yang didukung melalui HAR / Network.',740,300,{type:'PROJECT',status:'good',technical:[['Node ID','SYS_XHR_SITE']]});link('SYS_MODE','SYS_XHR_SITE','HAR / Network');
    add('SYS_CAPTURE','HAR / Network','Baca HAR with content dari Chrome/Edge.',1060,300,{type:'BROWSER',status:'good',technical:[['Node ID','SYS_CAPTURE'],['Input','HAR with content']]});link('SYS_XHR_SITE','SYS_CAPTURE');
    add('SYS_NETWORK','Deteksi & Parse Adapter','Baca endpoint, provenance, pagination, provider, dan coverage HAR.',1380,300,{type:'SCRAPER',status:'good',technical:[['Node ID','SYS_NETWORK']]});link('SYS_CAPTURE','SYS_NETWORK');

    add('SYS_EXTRACT','Ekstraksi Native','DOM selector atau adapter HAR menghasilkan record sumber.',2020,170,{type:'SCRAPER',status:'good',technical:[['Node ID','SYS_EXTRACT']]});link('SYS_DOM','SYS_EXTRACT');link('SYS_NETWORK','SYS_EXTRACT');
    add('SYS_VALIDATE','Validasi','Periksa kelengkapan, tipe, provenance, dan anomali.',2340,170,{type:'VALIDASI',status:'good',technical:[['Node ID','SYS_VALIDATE']]});link('SYS_EXTRACT','SYS_VALIDATE');
    add('SYS_NORMALIZE','Normalisasi','Rapikan nilai tanpa menebak data yang tidak tersedia.',2660,170,{type:'DATA',status:'good',technical:[['Node ID','SYS_NORMALIZE']]});link('SYS_VALIDATE','SYS_NORMALIZE');
    add('SYS_DEDUP','Pemeriksaan Duplikat','Pisahkan Duplikat Pasti dan Potensi Duplikat.',2980,170,{type:'DATA',status:'good',technical:[['Node ID','SYS_DEDUP']]});link('SYS_NORMALIZE','SYS_DEDUP');
    add('SYS_NAV','Navigasi DOM','Khusus DOM multi-halaman: next/load more/scroll.',2660,20,{type:'NAVIGASI',status:'neutral',technical:[['Node ID','SYS_NAV']]});link('SYS_VALIDATE','SYS_NAV','jika DOM multi-page');link('SYS_NAV','SYS_BROWSER','halaman berikutnya',{dashed:true,kind:'loop'});
    add('SYS_CHECKPOINT','Checkpoint & Recovery','Progress disimpan; kegagalan mempertahankan data yang sudah aman.',3300,170,{type:'KEANDALAN',status:'good',technical:[['Node ID','SYS_CHECKPOINT']]});link('SYS_DEDUP','SYS_CHECKPOINT');
    add('SYS_DATASET','Dataset','Data Asli · Hasil Cleaning · Audit Duplikat · provenance.',3620,170,{type:'HASIL',status:'good',technical:[['Node ID','SYS_DATASET']]});link('SYS_CHECKPOINT','SYS_DATASET');
    add('SYS_EXPORT','Output','CSV · Excel · JSON · Paket Lengkap · Riwayat.',3940,170,{type:'HASIL',status:'good',technical:[['Node ID','SYS_EXPORT']]});link('SYS_DATASET','SYS_EXPORT');
    return applyRuntime({nodes,edges,title:'Cara Kerja MyDataset · HAR / Network + DOM',layoutKey:'system-v4-dual'},runtime,'system');
  }

  function createController(elements){
    const viewport=elements.viewport,stage=elements.stage,nodesRoot=elements.nodesRoot,edgesSvg=elements.edgesSvg,inspector=elements.inspector,inspectorBody=elements.inspectorBody,minimap=elements.minimap;
    let graph={nodes:[],edges:[],layoutKey:'default'};
    let transform={x:20,y:20,scale:0.65};
    let panning=false,last={x:0,y:0},selected=null,showTechnical=false,spaceHeld=false,viewMode='overview';
    let nodeDrag=null,suppressNodeClick='',lastRoutes=[],routeFrame=null;
    // v5 invalidates the old square Peta Proyek layout. Project and system maps
    // now share the same authored-column layout strategy, so stale v4 coordinates
    // must not override the new arrangement.
    const STORAGE_KEY='petikdata.flow.node-layout.v6';
    let savedLayout={};
    try{savedLayout=JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}')||{};}catch{savedLayout={};}

    const layoutKey=()=>String(graph.layoutKey||graph.title||'default');
    const storageId=id=>`${layoutKey()}::${id}`;
    function persistLayout(){try{localStorage.setItem(STORAGE_KEY,JSON.stringify(savedLayout));}catch{}}
    function applySavedPosition(n){
      n._autoX=Number(n.x)||0;n._autoY=Number(n.y)||0;
      const pos=savedLayout[storageId(n.id)];
      n._hasSavedPosition=Boolean(pos&&Number.isFinite(Number(pos.x))&&Number.isFinite(Number(pos.y)));
      if(n._hasSavedPosition){n.x=Number(pos.x);n.y=Number(pos.y);}
    }
    function saveNodePosition(n){savedLayout[storageId(n.id)]={x:Math.round(n.x),y:Math.round(n.y)};persistLayout();}

    function applyTransform(){stage.style.transform=`translate(${transform.x}px,${transform.y}px) scale(${transform.scale})`;stage.style.transformOrigin='0 0';if(elements.zoomLabel)elements.zoomLabel.textContent=`${Math.round(transform.scale*100)}%`;}
    function updateViewModeControls(){
      const focus=viewMode==='focus';
      viewport.classList.toggle('flow-focus-mode',focus);
      stage.classList.toggle('auto-follow',focus);
      if(elements.followButton){
        elements.followButton.dataset.follow=String(focus);
        elements.followButton.classList.toggle('active',focus);
        elements.followButton.setAttribute('aria-pressed',String(focus));
      }
      if(elements.overviewButton){
        elements.overviewButton.classList.toggle('active',!focus);
        elements.overviewButton.setAttribute('aria-pressed',String(!focus));
      }
    }
    function setViewMode(value,{reframe=true}={}){
      viewMode=value==='focus'?'focus':'overview';
      updateViewModeControls();
      if(reframe){if(viewMode==='focus')focusActive(true);else fitOverview();}
      return viewMode;
    }
    function setFollow(value,options){return setViewMode(value?'focus':'overview',options)==='focus';}
    function releaseAutoFollow(){if(viewMode==='focus'){viewMode='overview';updateViewModeControls();}return viewMode;}
    function focusActive(force=false){
      if(!force&&viewMode!=='focus')return false;
      const primary=graph.nodes.find(n=>n.id===graph.runtime?.primaryActiveId)
        ||graph.nodes.find(n=>n.runtimeStatus==='active'||n.runtimeStatus==='warning'||n.runtimeStatus==='error');
      if(!primary)return false;
      const minX=primary.x,minY=primary.y,maxX=primary.x+primary.w,maxY=primary.y+primary.h;
      const rect=viewport.getBoundingClientRect(),width=Math.max(320,rect.width||viewport.clientWidth||800),height=Math.max(240,rect.height||viewport.clientHeight||600);
      const scale=clamp(Math.min((width-180)/Math.max(1,maxX-minX),(height-180)/Math.max(1,maxY-minY)),.72,1.12);
      transform.scale=scale;
      transform.x=width/2-((minX+maxX)/2)*scale;
      transform.y=height/2-((minY+maxY)/2)*scale;
      applyTransform();
      return true;
    }
    function nodeCenter(n){return {x:n.x+n.w/2,y:n.y+n.h/2};}
    const roundPoint=p=>({x:Math.round(Number(p.x)||0),y:Math.round(Number(p.y)||0)});
    const uniqueNumbers=values=>[...new Set(values.map(value=>Math.round(Number(value))).filter(Number.isFinite))];
    function sidePlan(a,b,e){
      if(e.kind==='loop')return{startSide:'bottom',endSide:'bottom',axis:'loop'};
      const ac=nodeCenter(a),bc=nodeCenter(b),dx=bc.x-ac.x,dy=bc.y-ac.y;
      if(Math.abs(dx)>=Math.abs(dy))return dx>=0
        ?{startSide:'right',endSide:'left',axis:'x'}
        :{startSide:'left',endSide:'right',axis:'x'};
      return dy>=0
        ?{startSide:'bottom',endSide:'top',axis:'y'}
        :{startSide:'top',endSide:'bottom',axis:'y'};
    }
    function portPoint(n,side,index,count){
      const ratio=(index+1)/(count+1),pad=28;
      if(side==='left'||side==='right'){
        const span=Math.max(8,n.h-pad*2);
        return{x:side==='left'?n.x:n.x+n.w,y:n.y+pad+span*ratio};
      }
      const span=Math.max(8,n.w-pad*2);
      return{x:n.x+pad+span*ratio,y:side==='top'?n.y:n.y+n.h};
    }
    function buildEdgeEntries(byId){
      const entries=graph.edges.map((e,index)=>({e,index,key:`${e.from}->${e.to}:${index}`,a:byId.get(e.from),b:byId.get(e.to)})).filter(x=>x.a&&x.b);
      const groups=new Map();
      const add=(entry,role,node,side,other)=>{const key=`${node.id}:${side}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push({entry,role,node,side,other});};
      for(const entry of entries){entry.plan=sidePlan(entry.a,entry.b,entry.e);add(entry,'start',entry.a,entry.plan.startSide,entry.b);add(entry,'end',entry.b,entry.plan.endSide,entry.a);}
      for(const list of groups.values()){
        const vertical=list[0].side==='left'||list[0].side==='right';
        list.sort((p,q)=>{const pc=nodeCenter(p.other),qc=nodeCenter(q.other);return(vertical?pc.y-qc.y:pc.x-qc.x)||(p.entry.index-q.entry.index);});
        list.forEach((token,index)=>{token.entry[token.role]=roundPoint(portPoint(token.node,token.side,index,list.length));token.entry[`${token.role}PortIndex`]=index;token.entry[`${token.role}PortCount`]=list.length;});
      }
      return entries;
    }
    function simplifyPoints(points){
      const out=[];
      for(const raw of points){const p=roundPoint(raw);const last=out[out.length-1];if(last&&last.x===p.x&&last.y===p.y)continue;out.push(p);}
      for(let i=out.length-2;i>0;i--){const a=out[i-1],b=out[i],c=out[i+1];if((a.x===b.x&&b.x===c.x)||(a.y===b.y&&b.y===c.y))out.splice(i,1);}
      return out;
    }
    function routeSegments(points){const list=[];for(let i=1;i<points.length;i++)list.push({a:points[i-1],b:points[i]});return list;}
    function segmentHitsNode(segment,ignoreIds=new Set(),pad=26){
      const {a,b}=segment,minX=Math.min(a.x,b.x),maxX=Math.max(a.x,b.x),minY=Math.min(a.y,b.y),maxY=Math.max(a.y,b.y);
      const hits=[];
      for(const n of graph.nodes){
        if(ignoreIds.has(n.id))continue;
        const l=n.x-pad,r=n.x+n.w+pad,t=n.y-pad,bottom=n.y+n.h+pad;
        if(Math.abs(a.x-b.x)<1){if(a.x>=l&&a.x<=r&&maxY>=t&&minY<=bottom)hits.push(n);}
        else if(Math.abs(a.y-b.y)<1&&a.y>=t&&a.y<=bottom&&maxX>=l&&minX<=r)hits.push(n);
      }
      return hits;
    }
    function segmentRelation(first,second){
      const av=Math.abs(first.a.x-first.b.x)<1,bv=Math.abs(second.a.x-second.b.x)<1;
      if(av===bv){
        const same=av?Math.abs(first.a.x-second.a.x)<1:Math.abs(first.a.y-second.a.y)<1;
        if(!same)return{overlap:0,crossing:false,near:0};
        const a1=av?Math.min(first.a.y,first.b.y):Math.min(first.a.x,first.b.x),a2=av?Math.max(first.a.y,first.b.y):Math.max(first.a.x,first.b.x);
        const b1=av?Math.min(second.a.y,second.b.y):Math.min(second.a.x,second.b.x),b2=av?Math.max(second.a.y,second.b.y):Math.max(second.a.x,second.b.x);
        return{overlap:Math.max(0,Math.min(a2,b2)-Math.max(a1,b1)),crossing:false,near:0};
      }
      const vertical=av?first:second,horizontal=av?second:first;
      const x=vertical.a.x,y=horizontal.a.y;
      const crosses=x>=Math.min(horizontal.a.x,horizontal.b.x)&&x<=Math.max(horizontal.a.x,horizontal.b.x)&&y>=Math.min(vertical.a.y,vertical.b.y)&&y<=Math.max(vertical.a.y,vertical.b.y);
      if(!crosses)return{overlap:0,crossing:false,near:0};
      const endpoint=[vertical.a,vertical.b,horizontal.a,horizontal.b].some(p=>Math.abs(p.x-x)<1&&Math.abs(p.y-y)<1);
      return{overlap:0,crossing:!endpoint,near:0,point:!endpoint?{x,y}:null};
    }
    function outwardPenalty(points,plan){
      if(points.length<2||plan.axis==='loop')return 0;
      const first=points[1],start=points[0],beforeEnd=points[points.length-2],end=points[points.length-1];
      const leaves={right:first.x>start.x,left:first.x<start.x,bottom:first.y>start.y,top:first.y<start.y}[plan.startSide];
      const approaches={left:beforeEnd.x<end.x,right:beforeEnd.x>end.x,top:beforeEnd.y<end.y,bottom:beforeEnd.y>end.y}[plan.endSide];
      return(leaves?0:1800)+(approaches?0:1800);
    }
    function pathScore(points,entry,reserved){
      const segments=routeSegments(points),ignore=new Set([entry.a.id,entry.b.id]);let score=outwardPenalty(points,entry.plan)+(points.length-2)*14;
      for(const segment of segments){
        const length=Math.abs(segment.a.x-segment.b.x)+Math.abs(segment.a.y-segment.b.y);score+=length*.015;
        score+=segmentHitsNode(segment,ignore).length*100000;
        for(const existing of reserved){
          const relation=segmentRelation(segment,existing.segment);
          if(relation.overlap>3)score+=40000+relation.overlap*24;
          if(relation.crossing)score+=4200;
          const sv=Math.abs(segment.a.x-segment.b.x)<1,ev=Math.abs(existing.segment.a.x-existing.segment.b.x)<1;
          if(sv===ev){
            const distance=sv?Math.abs(segment.a.x-existing.segment.a.x):Math.abs(segment.a.y-existing.segment.a.y);
            if(distance>0&&distance<22)score+=(22-distance)*8;
          }
        }
      }
      return score;
    }
    function routePath(points,radius=10){
      if(points.length<2)return'';let d=`M ${points[0].x} ${points[0].y}`;
      for(let i=1;i<points.length;i++){
        const current=points[i];
        if(i===points.length-1){d+=` L ${current.x} ${current.y}`;continue;}
        const previous=points[i-1],next=points[i+1];
        const incoming=Math.abs(current.x-previous.x)+Math.abs(current.y-previous.y),outgoing=Math.abs(next.x-current.x)+Math.abs(next.y-current.y),r=Math.min(radius,incoming/2,outgoing/2);
        const before={x:current.x+(previous.x-current.x)*(r/incoming),y:current.y+(previous.y-current.y)*(r/incoming)};
        const after={x:current.x+(next.x-current.x)*(r/outgoing),y:current.y+(next.y-current.y)*(r/outgoing)};
        d+=` L ${Math.round(before.x)} ${Math.round(before.y)} Q ${current.x} ${current.y} ${Math.round(after.x)} ${Math.round(after.y)}`;
      }
      return d;
    }
    function labelPoint(points){
      const segments=routeSegments(points);let best=null,bestScore=-1;
      for(const segment of segments){const horizontal=segment.a.y===segment.b.y,length=Math.abs(segment.a.x-segment.b.x)+Math.abs(segment.a.y-segment.b.y),score=length+(horizontal?500:0);if(score>bestScore){best=segment;bestScore=score;}}
      if(!best)return{x:points[0]?.x||0,y:(points[0]?.y||0)-8};
      return best.a.y===best.b.y?{x:(best.a.x+best.b.x)/2,y:best.a.y-8}:{x:best.a.x+9,y:(best.a.y+best.b.y)/2};
    }
    function routedEdge(entry,reserved,loopIndex=0){
      const {start,end,plan}=entry;
      const minX=Math.min(...graph.nodes.map(n=>n.x)),minY=Math.min(...graph.nodes.map(n=>n.y));
      const maxX=Math.max(...graph.nodes.map(n=>n.x+n.w)),maxY=Math.max(...graph.nodes.map(n=>n.y+n.h));
      const candidates=[];
      const add=points=>{const clean=simplifyPoints(points);if(clean.length>1)candidates.push(clean);};
      if(plan.axis==='loop'){
        const topStart={x:start.x,y:entry.a.y},topEnd={x:end.x,y:entry.b.y};
        const bottomLane=maxY+70+loopIndex*44,topLane=Math.max(4,minY-42-loopIndex*18);
        add([start,{x:start.x,y:bottomLane},{x:end.x,y:bottomLane},end]);
        add([topStart,{x:topStart.x,y:topLane},{x:topEnd.x,y:topLane},topEnd]);
        for(const sourceX of [entry.a.x-30,entry.a.x+entry.a.w+30])for(const targetX of [entry.b.x-30,entry.b.x+entry.b.w+30]){
          add([start,{x:sourceX,y:start.y},{x:sourceX,y:bottomLane},{x:targetX,y:bottomLane},{x:targetX,y:end.y},end]);
          add([topStart,{x:sourceX,y:topStart.y},{x:sourceX,y:topLane},{x:targetX,y:topLane},{x:targetX,y:topEnd.y},topEnd]);
        }
        const leftStart={x:entry.a.x,y:nodeCenter(entry.a).y},leftEnd={x:entry.b.x,y:nodeCenter(entry.b).y},leftLane=Math.max(6,minX-68-loopIndex*34);
        add([leftStart,{x:leftLane,y:leftStart.y},{x:leftLane,y:leftEnd.y},leftEnd]);
        const rightStart={x:entry.a.x+entry.a.w,y:nodeCenter(entry.a).y},rightEnd={x:entry.b.x+entry.b.w,y:nodeCenter(entry.b).y},rightLane=maxX+68+loopIndex*34;
        add([rightStart,{x:rightLane,y:rightStart.y},{x:rightLane,y:rightEnd.y},rightEnd]);
      }else if(plan.axis==='x'){
        const mid=(start.x+end.x)/2;
        const xBases=[mid,minX-38,maxX+38,...graph.nodes.flatMap(n=>[n.x-30,n.x+n.w+30])];
        const lanes=uniqueNumbers([...xBases,...Array.from({length:11},(_,i)=>mid+(i%2?1:-1)*Math.ceil((i+1)/2)*48)]);
        for(const lane of lanes)add([start,{x:lane,y:start.y},{x:lane,y:end.y},end]);
        const yBases=[minY-34,maxY+34,...graph.nodes.flatMap(n=>[n.y-28,n.y+n.h+28])];
        const yLanes=uniqueNumbers(yBases);
        for(const distance of [22,30,38,46,54,62,70,78]){
          const startOut={x:start.x+(plan.startSide==='right'?distance:-distance),y:start.y},endOut={x:end.x+(plan.endSide==='right'?distance:-distance),y:end.y};
          for(const lane of yLanes)add([start,startOut,{x:startOut.x,y:lane},{x:endOut.x,y:lane},endOut,end]);
        }
      }else{
        const mid=(start.y+end.y)/2;
        const yBases=[mid,minY-34,maxY+34,...graph.nodes.flatMap(n=>[n.y-28,n.y+n.h+28])];
        const lanes=uniqueNumbers([...yBases,...Array.from({length:11},(_,i)=>mid+(i%2?1:-1)*Math.ceil((i+1)/2)*48)]);
        for(const lane of lanes)add([start,{x:start.x,y:lane},{x:end.x,y:lane},end]);
        const xBases=[minX-38,maxX+38,...graph.nodes.flatMap(n=>[n.x-30,n.x+n.w+30])];
        const xLanes=uniqueNumbers(xBases);
        for(const distance of [22,30,38,46,54,62,70,78]){
          const startOut={x:start.x,y:start.y+(plan.startSide==='bottom'?distance:-distance)},endOut={x:end.x,y:end.y+(plan.endSide==='bottom'?distance:-distance)};
          for(const lane of xLanes)add([start,startOut,{x:lane,y:startOut.y},{x:lane,y:endOut.y},endOut,end]);
        }
      }
      let best=candidates[0]||[start,end],bestScore=Infinity;
      for(const points of candidates){const score=pathScore(points,entry,reserved);if(score<bestScore){best=points;bestScore=score;}}
      return{d:routePath(best),points:best,segments:routeSegments(best),label:labelPoint(best),score:bestScore,start:best[0],end:best[best.length-1]};
    }
    function updateStageBounds(){
      const maxX=Math.max(1200,...graph.nodes.map(n=>n.x+n.w+180));
      const loopCount=graph.edges.filter(e=>e.kind==='loop').length;
      const maxY=Math.max(900,...graph.nodes.map(n=>n.y+n.h+180+loopCount*56));
      stage.style.width=`${maxX}px`;stage.style.height=`${maxY}px`;
      edgesSvg.setAttribute('viewBox',`0 0 ${maxX} ${maxY}`);edgesSvg.setAttribute('width',String(maxX));edgesSvg.setAttribute('height',String(maxY));
    }
    function drawEdges(){
      edgesSvg.innerHTML='';
      const byId=new Map(graph.nodes.map(n=>[n.id,n])),entries=buildEdgeEntries(byId),reserved=[];lastRoutes=[];
      const span=entry=>{const a=nodeCenter(entry.a),b=nodeCenter(entry.b);return Math.abs(a.x-b.x)+Math.abs(a.y-b.y);};
      const ordered=[...entries.filter(x=>x.e.kind!=='loop').sort((a,b)=>span(b)-span(a)||a.index-b.index),...entries.filter(x=>x.e.kind==='loop')];let loopIndex=0;
      for(const entry of ordered){
        const e=entry.e,route=routedEdge(entry,reserved,e.kind==='loop'?loopIndex++:0);
        lastRoutes.push({key:entry.key,edge:{...e},points:route.points.map(roundPoint),score:route.score});
        for(const segment of route.segments)reserved.push({segment,edgeKey:entry.key,from:e.from,to:e.to});
        const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',route.d);path.setAttribute('class',`flow-edge phase-${e.phase||'setup'} runtime-${e.runtimeStatus||'pending'} ${e.dashed?'dashed':''} ${e.kind||''}`);path.setAttribute('data-edge-from',e.from);path.setAttribute('data-edge-to',e.to);path.setAttribute('data-route-points',JSON.stringify(route.points));edgesSvg.appendChild(path);
        if(e.label){const text=document.createElementNS('http://www.w3.org/2000/svg','text');text.setAttribute('x',String(route.label.x));text.setAttribute('y',String(route.label.y));text.setAttribute('class','flow-edge-label');text.textContent=e.label;edgesSvg.appendChild(text);}
      }
      drawCrossingBridges();
    }
    function drawCrossingBridges(){
      const routes=lastRoutes.map(route=>({...route,segments:routeSegments(route.points)})),seen=new Set();
      for(let laterIndex=1;laterIndex<routes.length;laterIndex++){
        const later=routes[laterIndex];
        for(let earlierIndex=0;earlierIndex<laterIndex;earlierIndex++)for(const earlierSegment of routes[earlierIndex].segments)for(const laterSegment of later.segments){
          const relation=segmentRelation(earlierSegment,laterSegment);if(!relation.crossing||!relation.point)continue;
          const {x,y}=relation.point,key=`${later.key}:${x}:${y}`;if(seen.has(key))continue;seen.add(key);
          const gap=document.createElementNS('http://www.w3.org/2000/svg','circle');gap.setAttribute('cx',String(x));gap.setAttribute('cy',String(y));gap.setAttribute('r','7');gap.setAttribute('class','flow-edge-jump-gap');edgesSvg.appendChild(gap);
          const vertical=laterSegment.a.x===laterSegment.b.x;
          const jump=document.createElementNS('http://www.w3.org/2000/svg','path');jump.setAttribute('d',vertical?`M ${x} ${y-8} Q ${x+7} ${y} ${x} ${y+8}`:`M ${x-8} ${y} Q ${x} ${y-7} ${x+8} ${y}`);jump.setAttribute('class',`flow-edge flow-edge-jump phase-${later.edge.phase||'setup'} runtime-${later.edge.runtimeStatus||'pending'} ${later.edge.dashed?'dashed':''} ${later.edge.kind||''}`);edgesSvg.appendChild(jump);
        }
      }
    }
    function renderMinimap(){
      if(!minimap)return;const maxX=Math.max(1,...graph.nodes.map(n=>n.x+n.w)),maxY=Math.max(1,...graph.nodes.map(n=>n.y+n.h));minimap.innerHTML='';
      for(const n of graph.nodes){const d=document.createElement('i');d.className=`phase-${n.phase||'setup'} runtime-${n.runtimeStatus||'pending'}`;d.style.left=`${Math.max(0,n.x)/maxX*100}%`;d.style.top=`${Math.max(0,n.y)/maxY*100}%`;d.style.width=`${Math.max(2,n.w/maxX*100)}%`;d.style.height=`${Math.max(2,n.h/maxY*100)}%`;minimap.appendChild(d);}
    }
    function getRouteStats(){
      let nodeHits=0,overlaps=0,crossings=0;
      const expanded=lastRoutes.map(route=>({...route,segments:routeSegments(route.points)}));
      for(const route of expanded){const ignore=new Set([route.edge.from,route.edge.to]);for(const segment of route.segments)nodeHits+=segmentHitsNode(segment,ignore).length;}
      for(let i=0;i<expanded.length;i++)for(let j=i+1;j<expanded.length;j++)for(const first of expanded[i].segments)for(const second of expanded[j].segments){const relation=segmentRelation(first,second);if(relation.overlap>3)overlaps+=1;if(relation.crossing)crossings+=1;}
      return{routes:expanded.length,nodeHits,overlaps,crossings};
    }
    function refreshGeometry(){
      let resized=false;
      for(const el of nodesRoot.querySelectorAll('.flow-node')){
        const n=graph.nodes.find(x=>x.id===el.dataset.nodeId);if(!n)continue;
        const nextHeight=Math.max(Number(n.h)||0,el.offsetHeight||el.scrollHeight||0);
        if(nextHeight>Number(n.h||0)+1){n.h=nextHeight;resized=true;}
      }
      if(resized&&hasNodeOverlap(44)){
        autoArrangeGraph();
        for(const n of graph.nodes){const el=nodesRoot.querySelector(`[data-node-id="${n.id}"]`);if(el){el.style.left=`${n.x}px`;el.style.top=`${n.y}px`;}}
      }
      updateStageBounds();drawEdges();renderMinimap();
    }
    function scheduleRouteRedraw(){
      if(routeFrame!=null)return;
      routeFrame=requestAnimationFrame(()=>{routeFrame=null;drawEdges();renderMinimap();});
    }
    function beginNodeDrag(ev,n,el){
      if(ev.button!==0||spaceHeld)return;
      ev.preventDefault();ev.stopPropagation();
      releaseAutoFollow();
      nodeDrag={id:n.id,pointerId:ev.pointerId,startX:ev.clientX,startY:ev.clientY,originX:n.x,originY:n.y,moved:false,el};
      el.classList.add('node-dragging');try{el.setPointerCapture?.(ev.pointerId);}catch{}
    }
    function moveNodeDrag(ev){
      if(!nodeDrag||ev.pointerId!==nodeDrag.pointerId)return;
      ev.preventDefault();ev.stopPropagation();
      const n=graph.nodes.find(x=>x.id===nodeDrag.id);if(!n)return;
      const dx=(ev.clientX-nodeDrag.startX)/Math.max(.05,transform.scale),dy=(ev.clientY-nodeDrag.startY)/Math.max(.05,transform.scale);
      if(Math.abs(dx)>2||Math.abs(dy)>2)nodeDrag.moved=true;
      n.x=nodeDrag.originX+dx;n.y=nodeDrag.originY+dy;
      // Instead of a hard left/top barrier, grow the coordinate space and shift
      // the graph. The pointer keeps its screen position while new room appears.
      const shiftX=n.x<90?90-n.x:0,shiftY=n.y<90?90-n.y:0;
      if(shiftX||shiftY){
        for(const item of graph.nodes){item.x+=shiftX;item.y+=shiftY;const itemEl=nodesRoot.querySelector(`[data-node-id="${item.id}"]`);if(itemEl){itemEl.style.left=`${item.x}px`;itemEl.style.top=`${item.y}px`;}}
        nodeDrag.originX+=shiftX;nodeDrag.originY+=shiftY;
        transform.x-=shiftX*transform.scale;transform.y-=shiftY*transform.scale;applyTransform();
      }
      nodeDrag.el.style.left=`${n.x}px`;nodeDrag.el.style.top=`${n.y}px`;scheduleRouteRedraw();
    }
    function finishNodeDrag(ev){
      if(!nodeDrag||ev.pointerId!==nodeDrag.pointerId)return;
      const n=graph.nodes.find(x=>x.id===nodeDrag.id);const moved=nodeDrag.moved;const el=nodeDrag.el;
      try{el.releasePointerCapture?.(ev.pointerId);}catch{}el.classList.remove('node-dragging');
      if(n&&moved){if(routeFrame!=null){cancelAnimationFrame(routeFrame);routeFrame=null;}saveNodePosition(n);suppressNodeClick=n.id;updateStageBounds();drawEdges();renderMinimap();}
      nodeDrag=null;
    }
    function renderNodes(){
      nodesRoot.innerHTML='';
      for(const n of graph.nodes){
        const el=document.createElement('button');el.type='button';el.className=`flow-node phase-${n.phase||'setup'} runtime-${n.runtimeStatus||'pending'} ${graph.runtime?.primaryActiveId===n.id?'runtime-focus-primary':''} ${showTechnical?'technical':''} ${n.action?'has-action':''}`;if(selected===n.id)el.classList.add('selected');el.dataset.nodeId=n.id;el.dataset.phase=n.phase||'setup';el.dataset.runtimeStatus=n.runtimeStatus||'pending';el.style.left=`${n.x}px`;el.style.top=`${n.y}px`;el.style.width=`${n.w}px`;el.style.minHeight=`${n.h}px`;
        const meta=(n.meta||[]).slice(0,4).map(([k,v])=>`<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
        const tech=(n.technical||[]).slice(0,4).map(([k,v])=>`<div><span>${esc(k)}</span><code>${esc(v)}</code></div>`).join('');
        el.innerHTML=`<div class="node-head"><div><span class="node-type">${esc(n.type)}</span><h3>${esc(n.title)}</h3></div><span class="node-status ${esc(n.runtimeStatus||'pending')} ${esc(n.configStatus||'neutral')}"></span></div><span class="node-runtime-label">${esc(n.runtimeLabel||'Menunggu')}</span><p>${esc(n.subtitle||'')}</p><div class="node-meta">${meta}</div><div class="node-meta technical-only">${tech}</div>${n.action?`<span class="node-action-hint">${esc(n.actionLabel||'Buka')} →</span>`:''}<span class="node-drag-hint">Seret untuk memindahkan</span>`;
        el.addEventListener('pointerdown',ev=>beginNodeDrag(ev,n,el));
        el.addEventListener('pointermove',moveNodeDrag);el.addEventListener('pointerup',finishNodeDrag);el.addEventListener('pointercancel',finishNodeDrag);
        el.addEventListener('click',ev=>{ev.stopPropagation();if(suppressNodeClick===n.id){suppressNodeClick='';return;}if(n.action&&n.directAction){window.dispatchEvent(new CustomEvent('mydataset:flow-action',{detail:{action:n.action,nodeId:n.id}}));return;}selected=n.id;renderNodes();refreshGeometry();showInspector(n);});
        nodesRoot.appendChild(el);
      }
      requestAnimationFrame(refreshGeometry);
    }
    function showInspector(n){
      inspector.classList.remove('hidden');
      const block=(title,rows)=>rows?.length?`<div class="inspector-block"><span>${esc(title)}</span>${rows.map(([k,v])=>`<div class="inspector-row"><b>${esc(k)}</b><code>${esc(v)}</code></div>`).join('')}</div>`:'';
      inspectorBody.innerHTML=`<div><span class="eyebrow">${esc(n.type)}</span><h2>${esc(n.title)}</h2><p>${esc(n.description||n.subtitle||'')}</p></div><div class="inspector-block"><span>Status proses</span><b>${esc(n.runtimeLabel||'Menunggu')}</b><code>fase ${esc(n.phase||'setup')}</code></div>${block('Penjelasan mudah',n.meta)}${n.action?`<button type="button" class="inspector-action" data-flow-action="${esc(n.action)}">${esc(n.actionLabel||'Buka')}</button>`:''}${block('Detail HTML / teknis',n.technical)}<div class="inspector-block"><span>ID node pada canvas</span><code>${esc(n.id)}</code></div><div class="inspector-block"><span>Posisi node</span><code>x ${Math.round(n.x)} · y ${Math.round(n.y)}</code></div>`;
      inspectorBody.querySelector('[data-flow-action]')?.addEventListener('click',()=>window.dispatchEvent(new CustomEvent('mydataset:flow-action',{detail:{action:n.action,nodeId:n.id}})));
    }
    function prepareNodeGeometry(){
      const degree=new Map(graph.nodes.map(n=>[n.id,{incoming:0,outgoing:0}]));
      for(const e of graph.edges){if(degree.has(e.from))degree.get(e.from).outgoing+=1;if(degree.has(e.to))degree.get(e.to).incoming+=1;}
      for(const n of graph.nodes){
        const d=degree.get(n.id)||{incoming:0,outgoing:0};const ports=Math.max(d.incoming,d.outgoing);
        const contentRows=Math.min(4,(n.meta||[]).length)+(showTechnical?Math.min(4,(n.technical||[]).length):0);
        const contentHeight=126+contentRows*23;
        n.h=Math.max(Number(n.h)||110,contentHeight,ports>3?86+ports*27:0);
      }
    }
    function topologySignature(value){return `${(value.nodes||[]).map(n=>n.id).join('|')}::${(value.edges||[]).map((e,i)=>`${i}:${e.from}>${e.to}`).join('|')}`;}
    function render(next){
      graph=next||{nodes:[],edges:[],layoutKey:'default'};prepareNodeGeometry();for(const n of graph.nodes)applySavedPosition(n);
      const savedCount=graph.nodes.filter(n=>n._hasSavedPosition).length;
      if(graph.nodes.length&&(savedCount!==graph.nodes.length||hasNodeOverlap(44)))autoArrangeGraph();
      updateStageBounds();renderNodes();drawEdges();renderMinimap();applyTransform();updateViewModeControls();if(viewMode==='focus')requestAnimationFrame(()=>focusActive());
    }
    function updateRuntime(next){
      if(!next||topologySignature(next)!==topologySignature(graph)){render(next);return false;}
      const previous=new Map(graph.nodes.map(n=>[n.id,n]));
      graph=next;
      for(const n of graph.nodes){const old=previous.get(n.id);if(old){n.x=old.x;n.y=old.y;n.w=old.w;n.h=old.h;n._autoX=old._autoX;n._autoY=old._autoY;n._hasSavedPosition=old._hasSavedPosition;}}
      for(const n of graph.nodes){
        const el=nodesRoot.querySelector(`[data-node-id="${n.id}"]`);if(!el)continue;
        el.className=`flow-node phase-${n.phase||'setup'} runtime-${n.runtimeStatus||'pending'} ${graph.runtime?.primaryActiveId===n.id?'runtime-focus-primary ':''}${showTechnical?'technical':''}${selected===n.id?' selected':''}`;
        el.dataset.phase=n.phase||'setup';el.dataset.runtimeStatus=n.runtimeStatus||'pending';
        const dot=el.querySelector('.node-status');if(dot)dot.className=`node-status ${n.runtimeStatus||'pending'} ${n.configStatus||'neutral'}`;
        const label=el.querySelector('.node-runtime-label');if(label)label.textContent=n.runtimeLabel||'Menunggu';
      }
      const nextEdges=[...(graph.edges||[])];
      for(const path of edgesSvg.querySelectorAll('path[data-edge-from]')){
        const index=nextEdges.findIndex(e=>e.from===path.dataset.edgeFrom&&e.to===path.dataset.edgeTo);if(index<0)continue;
        const e=nextEdges.splice(index,1)[0];path.setAttribute('class',`flow-edge phase-${e.phase||'setup'} runtime-${e.runtimeStatus||'pending'} ${e.dashed?'dashed':''} ${e.kind||''}`);
      }
      renderMinimap();updateViewModeControls();if(viewMode==='focus')focusActive();return true;
    }
    function zoom(delta,origin=null){releaseAutoFollow();const old=transform.scale;const next=clamp(old*delta,.22,2.2);if(origin){const rect=viewport.getBoundingClientRect();const px=origin.x-rect.left,py=origin.y-rect.top;const sx=(px-transform.x)/old,sy=(py-transform.y)/old;transform.x=px-sx*next;transform.y=py-sy*next;}transform.scale=next;applyTransform();}
    function fitOverview(){if(!graph.nodes.length)return;refreshGeometry();const routePoints=lastRoutes.flatMap(route=>route.points||[]),minX=Math.min(...graph.nodes.map(n=>n.x),...routePoints.map(p=>p.x)),minY=Math.min(...graph.nodes.map(n=>n.y),...routePoints.map(p=>p.y)),maxX=Math.max(...graph.nodes.map(n=>n.x+n.w),...routePoints.map(p=>p.x)),maxY=Math.max(...graph.nodes.map(n=>n.y+n.h),...routePoints.map(p=>p.y));const rect=viewport.getBoundingClientRect();const scale=clamp(Math.min((rect.width-80)/Math.max(1,maxX-minX),(rect.height-80)/Math.max(1,maxY-minY)),.22,1.15);transform.scale=scale;transform.x=40-minX*scale;transform.y=40-minY*scale;applyTransform();}
    function fit(){viewMode='overview';updateViewModeControls();fitOverview();}
    function search(q){releaseAutoFollow();const term=String(q||'').trim().toLowerCase();let first=null;for(const el of nodesRoot.querySelectorAll('.flow-node')){const n=graph.nodes.find(x=>x.id===el.dataset.nodeId);const hay=[n?.id,n?.title,n?.subtitle,...(n?.meta||[]).flat(),...(n?.technical||[]).flat()].join(' ').toLowerCase();const hit=term&&hay.includes(term);el.classList.toggle('search-hit',Boolean(hit));if(hit&&!first)first=n;}if(first){const rect=viewport.getBoundingClientRect();transform.x=rect.width/2-(first.x+first.w/2)*transform.scale;transform.y=rect.height/2-(first.y+first.h/2)*transform.scale;applyTransform();}}
    function setTechnical(value){showTechnical=Boolean(value);renderNodes();drawEdges();}
    function hasNodeOverlap(padding=0){
      for(let i=0;i<graph.nodes.length;i++)for(let j=i+1;j<graph.nodes.length;j++){
        const a=graph.nodes[i],b=graph.nodes[j];
        if(a.x<a.x+a.w&&a.x+a.w+padding>b.x&&b.x+b.w+padding>a.x&&a.y+a.h+padding>b.y&&b.y+b.h+padding>a.y)return true;
      }
      return false;
    }
    function topologicalOrder(){
      const byId=new Map(graph.nodes.map(n=>[n.id,n]));
      const incoming=new Map(graph.nodes.map(n=>[n.id,0]));
      const outgoing=new Map(graph.nodes.map(n=>[n.id,[]]));
      for(const e of graph.edges){if(e.kind==='loop'||!byId.has(e.from)||!byId.has(e.to))continue;incoming.set(e.to,(incoming.get(e.to)||0)+1);outgoing.get(e.from).push(e.to);}
      const rank=n=>[Number(n._autoY??n.y)||0,Number(n._autoX??n.x)||0,n.id];
      const compare=(a,b)=>{const ar=rank(byId.get(a)),br=rank(byId.get(b));return ar[0]-br[0]||ar[1]-br[1]||String(ar[2]).localeCompare(String(br[2]));};
      const queue=graph.nodes.filter(n=>(incoming.get(n.id)||0)===0).map(n=>n.id).sort(compare),ordered=[];
      while(queue.length){const id=queue.shift();ordered.push(byId.get(id));for(const next of outgoing.get(id)||[]){incoming.set(next,incoming.get(next)-1);if(incoming.get(next)===0){queue.push(next);queue.sort(compare);}}}
      const seen=new Set(ordered.map(n=>n.id));
      return ordered.concat(graph.nodes.filter(n=>!seen.has(n.id)).sort((a,b)=>compare(a.id,b.id)));
    }
    function autoArrangeAuthoredColumns(){
      const columnGap=150,rowGap=96;
      const sorted=[...graph.nodes].sort((a,b)=>(Number(a._autoX??a.x)-Number(b._autoX??b.x))||(Number(a._autoY??a.y)-Number(b._autoY??b.y)));
      const columns=[];
      for(const n of sorted){
        const baseX=Number.isFinite(Number(n._autoX))?Number(n._autoX):Number(n.x)||0;
        let col=columns.find(item=>Math.abs(item.baseX-baseX)<185);
        if(!col){col={baseX,nodes:[]};columns.push(col);}
        col.nodes.push(n);
      }
      columns.sort((a,b)=>a.baseX-b.baseX);let previousRight=90;
      for(const col of columns){
        const maxW=Math.max(...col.nodes.map(n=>Number(n.w)||285));
        const x=Math.max(90,col.baseX,previousRight+(previousRight>90?columnGap:0));
        col.nodes.sort((a,b)=>(Number(a._autoY??a.y)-Number(b._autoY??b.y)));let cursor=90;
        for(const n of col.nodes){const desired=Math.max(90,Number(n._autoY??n.y)||90);n.x=x;n.y=Math.max(desired,cursor);cursor=n.y+(Number(n.h)||110)+rowGap;}
        previousRight=x+maxW;
      }
      for(const n of graph.nodes)saveNodePosition(n);
    }
    function autoArrangeGraph(){
      if(!graph.nodes.length)return;
      // Peta Proyek and Cara Kerja Sistem intentionally use one layout model.
      // The authored x/y coordinates define process columns and branches; this
      // routine only expands those columns enough to prevent node overlap.
      autoArrangeAuthoredColumns();
    }
    function resetLayout(){
      const prefix=`${layoutKey()}::`;for(const key of Object.keys(savedLayout))if(key.startsWith(prefix))delete savedLayout[key];persistLayout();
      for(const n of graph.nodes){if(Number.isFinite(n._autoX))n.x=n._autoX;if(Number.isFinite(n._autoY))n.y=n._autoY;}
      autoArrangeGraph();renderNodes();
      requestAnimationFrame(()=>{refreshGeometry();fit();});
    }

    const clearTextSelection=()=>{try{const sel=window.getSelection?.();if(sel&&sel.rangeCount)sel.removeAllRanges();}catch{}};
    const startPan=e=>{
      const insideInspector=Boolean(e.target.closest?.('.flow-inspector'));const insideNode=Boolean(e.target.closest?.('.flow-node'));const middle=e.button===1;
      if(insideInspector)return false;if(!middle&&e.button!==0)return false;if(insideNode&&!spaceHeld&&!middle)return false;
      e.preventDefault();e.stopPropagation();releaseAutoFollow();clearTextSelection();panning=true;last={x:e.clientX,y:e.clientY};try{viewport.setPointerCapture?.(e.pointerId);}catch{}viewport.classList.add('panning');return true;
    };
    viewport.addEventListener('wheel',e=>{if(e.ctrlKey||e.metaKey||Math.abs(e.deltaY)>0){e.preventDefault();zoom(e.deltaY<0?1.12:.89,{x:e.clientX,y:e.clientY});}},{passive:false});
    viewport.addEventListener('pointerdown',e=>{startPan(e);});
    viewport.addEventListener('pointermove',e=>{if(!panning)return;e.preventDefault();clearTextSelection();transform.x+=e.clientX-last.x;transform.y+=e.clientY-last.y;last={x:e.clientX,y:e.clientY};applyTransform();});
    const stopPan=e=>{if(panning){try{viewport.releasePointerCapture?.(e?.pointerId);}catch{}}panning=false;viewport.classList.remove('panning');};
    viewport.addEventListener('pointerup',stopPan);viewport.addEventListener('pointercancel',stopPan);viewport.addEventListener('lostpointercapture',stopPan);
    viewport.addEventListener('contextmenu',e=>{if(panning||nodeDrag)e.preventDefault();});viewport.addEventListener('dragstart',e=>e.preventDefault());viewport.addEventListener('selectstart',e=>{if(!e.target.closest?.('.flow-inspector'))e.preventDefault();});
    viewport.addEventListener('dblclick',e=>{if(!e.target.closest('.flow-node')){e.preventDefault();zoom(1.2,{x:e.clientX,y:e.clientY});}});
    viewport.addEventListener('click',e=>{if(e.target===viewport||e.target===stage){selected=null;renderNodes();inspector.classList.add('hidden');}});
    viewport.addEventListener('keydown',e=>{if(e.code==='Space'&&!e.repeat){spaceHeld=true;viewport.classList.add('space-pan');e.preventDefault();}});viewport.addEventListener('keyup',e=>{if(e.code==='Space'){spaceHeld=false;viewport.classList.remove('space-pan');}});viewport.addEventListener('blur',()=>{spaceHeld=false;viewport.classList.remove('space-pan');stopPan();});

    updateViewModeControls();
    return {render,updateRuntime,zoomIn:()=>zoom(1.15),zoomOut:()=>zoom(.87),fit,focusActive,setFollow,setViewMode,getViewMode:()=>viewMode,isFollowing:()=>viewMode==='focus',getTransform:()=>({...transform}),search,setTechnical,resetLayout,getGraph:()=>graph,getRoutes:()=>lastRoutes.map(route=>({...route,points:route.points.map(point=>({...point}))})),getRouteStats};
  }

  window.CrawlLoomFlowCanvas={projectGraph,systemGraph,createController,modeLabel,paginationLabel};
  window.MyDatasetFlowCanvas=window.CrawlLoomFlowCanvas;
  window.PetikDataFlowCanvas=window.CrawlLoomFlowCanvas; // legacy alias
})();
