(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.MyDatasetAcquisitionPolicy=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const METHODS=Object.freeze({
    DOM:'dom',
    XHR:'network-json'
  });
  const METHOD_DEFS=Object.freeze({
    [METHODS.DOM]:{label:'Halaman Web / DOM',shortLabel:'DOM',sites:['tiket','agoda','trip']},
    [METHODS.XHR]:{label:'HAR / Network',shortLabel:'HAR/Network',sites:['traveloka','tiket','agoda','trip','booking']}
  });
  const SITE_DEFS=Object.freeze({
    tiket:{label:'Tiket',method:METHODS.XHR,methods:[METHODS.XHR,METHODS.DOM]},
    agoda:{label:'Agoda',method:METHODS.XHR,methods:[METHODS.XHR,METHODS.DOM]},
    trip:{label:'Trip',method:METHODS.XHR,methods:[METHODS.XHR,METHODS.DOM]},
    traveloka:{label:'Traveloka',method:METHODS.XHR,methods:[METHODS.XHR]},
    booking:{label:'Booking',method:METHODS.XHR,methods:[METHODS.XHR]}
  });
  function normalizedMethod(value){
    const raw=String(value||'').toLowerCase();
    if(raw==='xhr-json'||raw==='xhr'||raw==='network'||raw==='network-json'||raw==='har'||raw==='har-network')return METHODS.XHR;
    if(raw==='dom'||raw==='snapshot')return METHODS.DOM;
    if(raw==='auto'||!raw)return METHODS.XHR;
    return METHOD_DEFS[raw]?raw:METHODS.XHR;
  }
  function normalizedSite(value,{url=''}={}){
    let raw=String(value||'').toLowerCase().trim();
    if(raw==='xhr-json')return 'traveloka';
    if(SITE_DEFS[raw])return raw;
    const hay=String(url||'').toLowerCase();
    if(/traveloka\./.test(hay))return 'traveloka';
    if(/agoda\./.test(hay))return 'agoda';
    if(/tiket\./.test(hay))return 'tiket';
    if(/trip\.com|tripcdn\./.test(hay))return 'trip';
    if(/booking\.com/.test(hay))return 'booking';
    return '';
  }
  function methodForSite(site){return SITE_DEFS[normalizedSite(site)]?.method||METHODS.XHR;}
  function methodsForSite(site){
    const def=SITE_DEFS[normalizedSite(site)];
    return def?[...(def.methods||[def.method])]:[];
  }
  function allowedSites(method){return [...(METHOD_DEFS[normalizedMethod(method)]?.sites||[])];}
  function isCombinationAllowed(method,site){
    const m=normalizedMethod(method);const s=normalizedSite(site);
    return Boolean(s&&METHOD_DEFS[m]?.sites.includes(s));
  }
  function firstSiteForMethod(method){return allowedSites(method)[0]||'';}
  function migrateProject(project={}){
    const next={...project,acquisition:{...(project.acquisition||{})}};
    const originalSite=String(project.siteProfile||'').toLowerCase();
    const url=project.startUrl||project.source?.sourceUrl||project.source?.actualUrl||'';
    let site=normalizedSite(originalSite,{url});
    let method=normalizedMethod(project.acquisition?.method);
    const migration=[];
    if(originalSite==='xhr-json')migration.push('Profil lama XHR/JSON dipetakan ke Traveloka.');
    if(site&&!isCombinationAllowed(method,site)){
      method=methodForSite(site);
      migration.push(`Metode disesuaikan untuk ${SITE_DEFS[site].label}.`);
    }
    if(!site){
      // HAR/Network mendeteksi Traveloka, Tiket, Agoda, Trip, atau Booking dari endpoint review.
      if(originalSite&&originalSite!=='auto'&&originalSite!=='generic')migration.push('Website lama tidak dikenali; pilih kembali website yang sesuai.');
    }
    next.siteProfile=site;
    next.acquisition.method=method;
    if(method===METHODS.XHR){
      next.acquisition.scope='all';
      next.mode='quick';
      next.pagination={...(project.pagination||{}),type:'none',maxPages:1};
    }
    return {project:next,migration};
  }
  function validateProject(project={}){
    const method=normalizedMethod(project.acquisition?.method);
    const site=normalizedSite(project.siteProfile,{url:project.startUrl||project.source?.sourceUrl||''});
    if(!site)return {ok:false,code:'SITE_REQUIRED',message:'Pilih website yang akan diambil datanya.'};
    if(!isCombinationAllowed(method,site)){
      const methods=methodsForSite(site);
      const labels=methods.map(value=>METHOD_DEFS[value]?.label||value);
      const expected=methodForSite(site);
      return {ok:false,code:'UNSUPPORTED_SITE_METHOD',message:`${SITE_DEFS[site]?.label||site} didukung melalui ${labels.join(' atau ')}.`,method,site,expectedMethod:expected,supportedMethods:methods};
    }
    return {ok:true,method,site};
  }
  function labelForMethod(method){return METHOD_DEFS[normalizedMethod(method)]?.label||String(method||'');}
  function labelForSite(site){return SITE_DEFS[normalizedSite(site)]?.label||String(site||'');}
  return Object.freeze({METHODS,METHOD_DEFS,SITE_DEFS,normalizedMethod,normalizedSite,methodForSite,methodsForSite,allowedSites,isCombinationAllowed,firstSiteForMethod,migrateProject,validateProject,labelForMethod,labelForSite});
});
