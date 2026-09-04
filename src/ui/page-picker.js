(function (root) {
  'use strict';

  function pickerRuntime(config) {
    return new Promise((resolve, reject) => {
      try {
        const pickConfig = typeof config === 'string' ? { target: config } : (config || {});
        const target = pickConfig.target || 'field';
        const itemSelector = pickConfig.itemSelector || '';
        const STATE_KEY = '__crawlLoomOverlayPickerV18';
        const old = window[STATE_KEY] || window.__crawlLoomOverlayPickerV17 || window.__crawlLoomOverlayPickerV16 || window.__crawlLoomOverlayPickerV15 || window.__crawlLoomOverlayPickerV14;
        if (old?.cleanup) {
          try { old.cleanup('replaced'); } catch {}
        }

        const semanticWords = [
          'review','comment','feedback','rating','score','guest','user','author','name','date','time',
          'product','hotel','item','card','row','result','listing','content','body','title','price','room',
          'traveler','traveller','country','location','pagination','next','more'
        ];

        const containerWords = ['review','comment','product','hotel','item','card','row','result','listing','entry','record'];

        function cssEscape(value) {
          if (window.CSS?.escape) return CSS.escape(String(value));
          return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
        }
        function quoteAttr(value) {
          return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        }
        function safeCount(selector) {
          try { return document.querySelectorAll(selector).length; } catch { return 0; }
        }
        function jsonIdentityFromAttribute(root) {
          if(!root) return null;
          const wanted=new Map([
            ['writingid','review_id'],['reviewid','review_id'],['review_id','review_id'],['submitid','review_id'],['submit_id','review_id'],
            ['commentid','review_id'],['comment_id','review_id'],['itemid','item_id'],
            ['item_id','item_id'],['recordid','record_id'],['record_id','record_id'],
            ['productid','product_id'],['product_id','product_id']
          ]);
          const walk=(obj,path=[],depth=0)=>{
            if(obj==null||depth>6) return null;
            if(Array.isArray(obj)){for(let i=0;i<Math.min(obj.length,20);i++){const hit=walk(obj[i],[...path,String(i)],depth+1);if(hit)return hit;}return null;}
            if(typeof obj!=='object') return null;
            for(const [key,value] of Object.entries(obj)){
              const normalized=String(key).toLowerCase().replace(/[^a-z0-9_]/g,'');
              if(wanted.has(normalized)&&(typeof value==='string'||typeof value==='number')) return {path:[...path,key].join('.'),value,suggestedName:wanted.get(normalized)};
            }
            for(const [key,value] of Object.entries(obj)){if(value&&typeof value==='object'){const hit=walk(value,[...path,key],depth+1);if(hit)return hit;}}
            return null;
          };
          for(const attr of [...root.attributes]){
            const raw=String(attr.value||'').trim();
            if(raw.length<2||raw.length>25000||(!raw.startsWith('{')&&!raw.startsWith('['))) continue;
            try{const hit=walk(JSON.parse(raw));if(hit)return {mode:'containerJsonAttribute',attribute:attr.name,jsonPath:hit.path,value:hit.value,suggestedName:hit.suggestedName};}catch{}
          }
          return null;
        }
        function directIdentityFromRoot(root){
          if(!root) return null;
          const direct=[['data-review-id','review_id'],['data-comment-id','review_id'],['data-writing-id','review_id'],['data-submit-id','review_id'],['data-item-id','item_id'],['data-record-id','record_id'],['data-product-id','product_id']];
          for(const [attr,suggestedName] of direct){const value=root.getAttribute(attr);if(value!=null&&String(value)!=='')return {mode:'containerAttribute',attribute:attr,jsonPath:'',value,suggestedName};}
          return jsonIdentityFromAttribute(root);
        }
        function identityValue(root, identity){
          if(!root||!identity) return null;
          if(identity.mode==='containerAttribute') return root.getAttribute(identity.attribute||'');
          if(identity.mode==='containerJsonAttribute'){
            try{const obj=JSON.parse(root.getAttribute(identity.attribute||'')||'null');return String(identity.jsonPath||'').split('.').filter(Boolean).reduce((cur,key)=>cur==null?null:cur[key],obj);}catch{return null;}
          }
          return null;
        }
        function rootVisualScore(root, preferredEl=null) {
          if(!root || !root.isConnected) return -100000;
          let score=0;
          if(preferredEl && root.contains(preferredEl)) score+=100000;
          try{
            let cur=root,hidden=false,ariaHidden=false;
            for(let depth=0;cur&&cur.nodeType===1&&depth<18;depth+=1,cur=cur.parentElement){
              const style=getComputedStyle(cur);
              if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity||1)===0){hidden=true;break;}
              if(cur.getAttribute?.('aria-hidden')==='true') ariaHidden=true;
            }
            score+=hidden?-12000:1000;
            if(ariaHidden) score-=2500;
            const rect=root.getBoundingClientRect();
            const hasBox=rect.width>1&&rect.height>1;
            score+=hasBox?700:-1800;
            if(hasBox){
              const viewportHit=rect.bottom>0&&rect.right>0&&rect.top<(innerHeight||0)&&rect.left<(innerWidth||0);
              if(viewportHit) score+=650;
              const area=Math.max(1,rect.width*rect.height);
              score+=Math.min(220,Math.log2(area+1)*12);
            }
            const text=cleanText(root,5000);
            if(text.length>=8) score+=Math.min(240,text.length*.08);
            if(root.matches?.('[inert], [aria-hidden="true"]')) score-=2000;
          }catch{}
          return score;
        }
        function canonicalRoots(rawRoots, identity, preferredEl=null) {
          if(!identity) return rawRoots;
          const groups=new Map(), passthrough=[];
          rawRoots.forEach((root,index)=>{
            const value=identityValue(root,identity);
            if(value==null||String(value)===''){passthrough.push({index,root});return;}
            const key=String(value);
            if(!groups.has(key)) groups.set(key,{index,candidates:[]});
            groups.get(key).candidates.push(root);
          });
          const chosen=[...passthrough];
          for(const group of groups.values()){
            const ranked=group.candidates.map(root=>({root,score:rootVisualScore(root,preferredEl)})).sort((a,b)=>b.score-a.score);
            if(ranked[0]) chosen.push({index:group.index,root:ranked[0].root});
          }
          chosen.sort((a,b)=>a.index-b.index);
          return chosen.map(x=>x.root);
        }
        function logicalRootInfo(selector, preferredEl=null) {
          let rawRoots=[];
          try { rawRoots=[...document.querySelectorAll(selector)]; } catch { return {roots:[],rawCount:0,logicalCount:0,keyAttribute:null,identity:null}; }
          // Modern travel sites commonly keep both desktop and mobile review trees in
          // the DOM. Only evaluate the rendered tree; otherwise a correct field appears
          // twice per logical record and the dialog reports an artificial ambiguity.
          const renderedRoots=rawRoots.filter(root=>rootVisualScore(root,preferredEl)>-5000);
          if(renderedRoots.length) rawRoots=renderedRoots;
          const preferred=['data-review-id','data-comment-id','data-writing-id','data-submit-id','data-item-id','data-product-id','data-result-id','data-record-id','data-id','data-key','id'];
          let best=null;
          for (const attr of preferred) {
            const values=rawRoots.map(r=>r.getAttribute(attr)).filter(v=>v!=null && String(v)!=='');
            if (!values.length) continue;
            const coverage=values.length/Math.max(1,rawRoots.length);
            const unique=[...new Set(values.map(String))];
            if (coverage<0.8 || unique.length<2) continue;
            const duplicateSavings=values.length-unique.length;
            let score=(attr.startsWith('data-')?70:10)+coverage*40+Math.min(unique.length,100)+(duplicateSavings>0?120+duplicateSavings*3:0);
            if (!best || score>best.score) best={identity:{mode:'containerAttribute',attribute:attr,jsonPath:'',suggestedName:/review|comment|writing/i.test(attr)?'review_id':'item_id'},score};
          }
          const detected=rawRoots.map(directIdentityFromRoot).filter(Boolean);
          if(detected.length){
            const groups=new Map();
            for(const d of detected){const k=[d.mode,d.attribute,d.jsonPath||'',d.suggestedName||''].join('|');groups.set(k,(groups.get(k)||0)+1);}
            const [key,coverageCount]=[...groups.entries()].sort((a,b)=>b[1]-a[1])[0]||[];
            if(key&&coverageCount/Math.max(1,rawRoots.length)>=0.6){const [mode,attribute,jsonPath,suggestedName]=key.split('|');const identity={mode,attribute,jsonPath,suggestedName:suggestedName||'review_id'};const vals=rawRoots.map(r=>identityValue(r,identity)).filter(v=>v!=null&&String(v)!=='');const unique=new Set(vals.map(String));if(unique.size>=2){const score=260+(coverageCount/rawRoots.length)*100+Math.min(unique.size,100);if(!best||score>best.score)best={identity,score};}}
          }
          if (!best) return {roots:rawRoots,rawCount:rawRoots.length,logicalCount:rawRoots.length,keyAttribute:null,identity:null};
          const logical=canonicalRoots(rawRoots,best.identity,preferredEl);
          return {roots:logical,rawCount:rawRoots.length,logicalCount:logical.length,keyAttribute:best.identity.mode==='containerAttribute'?best.identity.attribute:null,identity:best.identity};
        }
        function siblingPositionSelector(el) {
          const parent=el.parentElement;
          if (!parent) return el.tagName.toLowerCase();
          const same=[...parent.children].filter(x=>x.tagName===el.tagName);
          if (same.length<=1) return el.tagName.toLowerCase();
          const idx=same.indexOf(el)+1;
          if (idx===same.length) return `${el.tagName.toLowerCase()}:last-of-type`;
          return `${el.tagName.toLowerCase()}:nth-of-type(${idx})`;
        }
        // Opaque CSS classes are common on Trip.com. Build a class-independent path
        // from one logical record to the exact field that was clicked. The selector is
        // still validated against every record before it can be saved, so positional
        // paths are used only when the repeated DOM structure actually agrees.
        function positionalRelativeSelector(el, root) {
          if(!el||!root||el===root||!root.contains(el)) return '';
          const parts=[];let cur=el;
          while(cur&&cur!==root){
            const parent=cur.parentElement;if(!parent)return '';
            const tag=cur.tagName.toLowerCase();
            const same=[...parent.children].filter(node=>node.tagName===cur.tagName);
            const index=same.indexOf(cur);
            if(index<0)return '';
            parts.unshift(same.length>1?`${tag}:nth-of-type(${index+1})`:tag);
            cur=parent;
          }
          return cur===root&&parts.length?`:scope > ${parts.join(' > ')}`:'';
        }
        function semanticAncestorSelector(el, root) {
          let cur=el.parentElement;
          while (cur && cur!==root) {
            for (const attr of ['data-info-type','data-testid','data-element-name','data-selenium','aria-label']) {
              const value=cur.getAttribute(attr);
              if (value && String(value).length<120) return `[${attr}="${quoteAttr(value)}"]`;
            }
            const cls=stableClasses(cur).find(c=>/review|comment|rating|score|status|author|guest|user|date|title|room|stay|traveler|traveller/i.test(c));
            if (cls) return `.${cssEscape(cls)}`;
            cur=cur.parentElement;
          }
          return null;
        }
        function classQuality(value) {
          const cls = String(value || '');
          if (!cls || cls.length > 100) return -30;
          const low = cls.toLowerCase();
          if (/^(active|selected|hover|focus|open|show|hidden|disabled)$/.test(low)) return -30;
          if (/^(css|jsx)-[a-z0-9_-]+$/i.test(cls)) return -20;
          if (/^sc-[a-z0-9_-]+$/i.test(cls)) return -18;
          if (/^r-[a-z0-9_-]+$/i.test(cls)) return -18;
          const hasSemantic = semanticWords.some(word => low.includes(word));
          if (!hasSemantic && cls.length >= 16 && /[A-Z]/.test(cls) && /[a-z]/.test(cls) && /[0-9_]/.test(cls)) return -18;
          let score = 2;
          if (semanticWords.some(word => low.includes(word))) score += 16;
          if (/styled|typography|wrapper|container/i.test(cls)) score += 1;
          if (/[a-z]{3,}/i.test(cls)) score += 2;
          if ((cls.match(/\d/g) || []).length > 8) score -= 7;
          return score;
        }
        function stableClasses(el) {
          return [...(el.classList || [])]
            .map(cls => ({ cls, score: classQuality(cls) }))
            .filter(item => item.score > -10)
            .sort((a,b) => b.score - a.score || a.cls.length - b.cls.length)
            .map(item => item.cls);
        }
        function selectorCandidates(el) {
          const tag = el.tagName.toLowerCase();
          const out = [];
          const preferredAttrs = [
            'data-element-name','data-testid','data-test','data-qa','data-selenium','data-cy',
            'itemprop','name','aria-label','role'
          ];
          if (el.id) out.push({selector:`#${cssEscape(el.id)}`,kind:'id',strength:40});
          for (const attr of preferredAttrs) {
            const value = el.getAttribute(attr);
            if (!value || String(value).length > 140) continue;
            out.push({selector:`${tag}[${attr}="${quoteAttr(value)}"]`,kind:attr,strength:attr.startsWith('data-')?40:29});
            if (attr !== 'role') out.push({selector:`[${attr}="${quoteAttr(value)}"]`,kind:attr,strength:36});
          }
          const classes = stableClasses(el).slice(0,5);
          for (const cls of classes) {
            const q=classQuality(cls);
            out.push({selector:`.${cssEscape(cls)}`,kind:'class',strength:13+q});
            out.push({selector:`${tag}.${cssEscape(cls)}`,kind:'class',strength:15+q});
          }
          if (classes.length >= 2) {
            const pair=classes.slice(0,2).map(cssEscape).join('.');
            out.push({selector:`${tag}.${pair}`,kind:'classes',strength:26+classQuality(classes[0])+classQuality(classes[1])});
          }
          out.push({selector:tag,kind:'tag',strength:0});
          const seen=new Set();
          return out.filter(x=>{
            if (!x.selector || seen.has(x.selector)) return false;
            seen.add(x.selector);
            return safeCount(x.selector)>0;
          });
        }
        function bestReusable(el, preferRepeated) {
          let best=null;
          for (const c of selectorCandidates(el)) {
            const count=safeCount(c.selector);
            let score=c.strength-c.selector.length*0.05;
            if (preferRepeated) {
              // A repeated container must describe a pattern, not an instance ID.
              // Duplicate IDs in hidden SPA trees must not make an ID look reusable.
              if (c.kind==='id') score-=260;
              if (count>=2 && count<=80) score+=105;
              else if (count<=250 && count>80) score+=45;
              else if (count===1) score-=30;
              else score-=70;
            } else {
              if (count===1) score+=60;
              else if (count<=20) score+=25;
              else if (count<=200) score+=5;
              else score-=30;
            }
            if (!best || score>best.score) best={...c,count,score};
          }
          return best;
        }
        function buildUniqueSelector(el) {
          if (el.id) return `#${cssEscape(el.id)}`;
          const direct=bestReusable(el,false);
          if (direct?.count===1) return direct.selector;
          const path=[];
          let current=el;
          while (current && current.nodeType===1 && current!==document.documentElement) {
            let part=current.tagName.toLowerCase();
            let strong=false;
            for (const attr of ['data-testid','data-element-name','data-test','data-qa','data-selenium','itemprop','aria-label']) {
              const value=current.getAttribute(attr);
              if (value && String(value).length<120) {
                part+=`[${attr}="${quoteAttr(value)}"]`;
                strong=true;
                break;
              }
            }
            if (!strong) {
              const cls=stableClasses(current)[0];
              if (cls) part+=`.${cssEscape(cls)}`;
            }
            const parent=current.parentElement;
            if (parent) {
              const siblings=[...parent.children].filter(x=>x.tagName===current.tagName);
              if (siblings.length>1) part+=`:nth-of-type(${siblings.indexOf(current)+1})`;
            }
            path.unshift(part);
            const selector=path.join(' > ');
            if (safeCount(selector)===1) return selector;
            current=parent;
          }
          return path.join(' > ');
        }
        function buildXPath(el) {
          if (el.id) return `//*[@id="${String(el.id).replace(/"/g,'\\"')}"]`;
          const parts=[];
          let current=el;
          while (current && current.nodeType===1) {
            const tag=current.tagName.toLowerCase();
            const siblings=current.parentNode ? [...current.parentNode.children].filter(x=>x.tagName===current.tagName) : [];
            const index=siblings.length>1 ? `[${siblings.indexOf(current)+1}]` : '';
            parts.unshift(`${tag}${index}`);
            current=current.parentElement;
          }
          return '/'+parts.join('/');
        }
        function cleanText(el, max=280) {
          return String(el.innerText || el.textContent || '').trim().replace(/\s+/g,' ').slice(0,max);
        }
        function directText(el, max=180) {
          const text=[...(el?.childNodes||[])].filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent||'').join(' ').trim().replace(/\s+/g,' ');
          return text.slice(0,max);
        }
        function agodaRatingPart(el) {
          if(!el || !(el instanceof Element)) return null;
          const left=el.closest?.('.Review-comment-left');
          if(!left) return null;
          const group=el.closest?.('.Review-comment-score, p');
          if(!group || !left.contains(group)) return null;
          const parts=[...group.children].filter(node=>String(node.tagName||'').toLowerCase()==='span'&&cleanText(node,80));
          if(parts.length<2) return null;
          const carrier=parts.find(node=>node===el||node.contains(el))||null;
          if(!carrier) return null;
          const index=parts.indexOf(carrier);
          if(index<0||index>1) return null;
          return {group,carrier,index,role:index===0?'rating_score':'rating_label'};
        }
        function visibleLeafText(el, max=140) {
          if(!el || !(el instanceof Element)) return '';
          return String(el.innerText || el.textContent || '').replace(/\u00a0/g,' ').trim().replace(/\s+/g,' ').slice(0,max);
        }
        function refineFieldElement(raw, x, y) {
          if(!raw || !(raw instanceof Element)) return raw;
          if(['IMG','INPUT','TEXTAREA','SELECT','OPTION','BUTTON'].includes(raw.tagName)) return raw;
          // Agoda kadang menaruh pointer-event pada wrapper typography, sementara angka
          // dan kategori rating berada pada dua span terpisah (bahkan dapat bersarang).
          // Pilih span visual yang benar agar "10,0" dan "Spektakuler" tidak dibaca
          // sebagai satu blok atau sebagai class typography yang tidak stabil.
          const agodaGroup=raw.closest?.('.Review-comment-left .Review-comment-score, .Review-comment-left p');
          if(agodaGroup){
            const parts=[...agodaGroup.children].filter(node=>String(node.tagName||'').toLowerCase()==='span'&&cleanText(node,80));
            const ranked=parts.map(node=>{
              const rect=node.getBoundingClientRect();
              const dx=x<rect.left?rect.left-x:x>rect.right?x-rect.right:0;
              const dy=y<rect.top?rect.top-y:y>rect.bottom?y-rect.bottom:0;
              return {node,distance:Math.hypot(dx,dy),area:Math.max(1,rect.width*rect.height)};
            }).filter(item=>item.node.getBoundingClientRect().width>0&&item.node.getBoundingClientRect().height>0)
              .sort((a,b)=>a.distance-b.distance||a.area-b.area);
            if(ranked[0]&&ranked[0].distance<=42)return ranked[0].node;
          }
          const rawRect=raw.getBoundingClientRect();
          const rawIsLarge=rawRect.width>180||rawRect.height>70||raw.querySelectorAll('*').length>5;
          const list=[raw,...raw.querySelectorAll('*')].slice(0,3000);
          const candidates=[];
          const distToRect=(rect)=>{
            const dx=x<rect.left?rect.left-x:x>rect.right?x-rect.right:0;
            const dy=y<rect.top?rect.top-y:y>rect.bottom?y-rect.bottom:0;
            return Math.hypot(dx,dy);
          };
          for(const el of list){
            if(!(el instanceof Element) || ['SCRIPT','STYLE','NOSCRIPT','SVG','PATH'].includes(el.tagName)) continue;
            const rect=el.getBoundingClientRect();
            if(rect.width<=0||rect.height<=0) continue;
            const distance=distToRect(rect);
            const containsPoint=distance===0;
            // When a SPA places pointer-events on the card rather than the text, accept the
            // nearest semantic/text leaf within a small radius instead of returning the card.
            if(!containsPoint && (!rawIsLarge || distance>42)) continue;
            const st=getComputedStyle(el); if(st.display==='none'||st.visibility==='hidden'||Number(st.opacity||1)===0) continue;
            const full=cleanText(el,320), own=directText(el,220);
            const attrHint=['data-testid','data-info-type','data-element-name','data-selenium','aria-label','itemprop'].some(a=>el.getAttribute(a));
            const classHint=[...(el.classList||[])].some(c=>/(review|comment|rating|score|author|guest|customer|user|name|date|country|room|travell|stay|title|text)/i.test(c));
            if(!full && el.tagName!=='A' && el.tagName!=='IMG') continue;
            const area=Math.max(1,rect.width*rect.height);
            let depth=0,cur=el;while(cur&&cur!==raw){depth++;cur=cur.parentElement;}
            let score=depth*34 + Math.min(260,140000/area) - distance*12;
            if(own) score+=230;
            if(full.length>0&&full.length<=140) score+=105;
            else if(full.length>320) score-=240;
            if(attrHint) score+=90;if(classHint) score+=95;
            if(el.getAttribute('data-testid')==='review-card') score-=520;
            if(/review[_-]?card(?:__|$)/i.test([...(el.classList||[])].join(' '))) score-=420;
            score-=Math.min(100,el.querySelectorAll('*').length*2.5);
            candidates.push({el,score,area,full,distance});
          }
          candidates.sort((a,b)=>b.score-a.score||a.distance-b.distance||a.area-b.area);
          return candidates[0]?.el || raw;
        }
        function refinePaginationElement(raw) {
          if(!raw || !(raw instanceof Element)) return raw;
          // elementFromPoint normally returns the deepest SVG/path/span below the cursor.
          // Store the actual navigation control instead, otherwise a reusable typography
          // selector can accidentally match every page number on the page.
          const semanticControl=raw.closest?.([
            '[data-testid="chevron-right-pagination"]',
            '[data-testid*="pagination-next" i]',
            '[data-testid*="next-pagination" i]',
            '[data-testid*="pagination-right" i]',
            '[data-element-name*="paginator-next" i]',
            '[data-element-name*="pagination-next" i]',
            '[aria-label*="next" i]',
            '[aria-label*="berikut" i]',
            '[aria-label*="selanjut" i]',
            '[title*="next" i]',
            '[title*="berikut" i]',
            'a[rel="next"]'
          ].join(','));
          if(semanticControl) return semanticControl;
          const interactive=raw.closest?.('button,a,[role="button"],[role="link"]');
          if(interactive) return interactive;
          let current=raw;
          for(let depth=0;current&&current!==document.body&&depth<7;depth+=1,current=current.parentElement){
            const hint=[
              current.getAttribute?.('data-testid'),current.getAttribute?.('data-element-name'),
              current.getAttribute?.('aria-label'),current.getAttribute?.('title'),
              ...(current.classList||[])
            ].filter(Boolean).join(' ');
            if(/paginat|paginator/i.test(hint)) return current;
          }
          return raw;
        }
        function attrsObject(el) {
          const result={};
          for (const attr of [...el.attributes].slice(0,35)) result[attr.name]=String(attr.value);
          return result;
        }
        function semanticMarkerInfo(el, root) {
          let cur=el;
          for(let depth=0;cur&&cur!==root&&depth<4;depth+=1,cur=cur.parentElement){
            const nodes=[cur,...cur.querySelectorAll(':scope > i, :scope > svg, :scope > [data-testid], :scope > [data-info-type], :scope > [data-element-name]')];
            for(const node of nodes){
              if(!node) continue;
              for(const attr of ['data-testid','data-info-type','data-element-name','data-selenium','aria-label']){
                const value=node.getAttribute?.(attr);
                if(value && /(language|country|room|business|travell|guest|calendar|date|message|review|rating|score|author|user|name)/i.test(value)){
                  return {signature:`${attr}=${value}`,selector:`[${attr}="${quoteAttr(value)}"]`,carrier:cur,raw:String(value)};
                }
              }
              for(const cls of [...(node.classList||[])]){
                if(/^(?:ic_languages|ic_roomline|ic_business2)$/i.test(cls) || /(?:calendar|message|language|country|roomline|business2|travell|rating|score)/i.test(cls)){
                  return {signature:`class=${cls}`,selector:`.${cssEscape(cls)}`,carrier:cur,raw:cls};
                }
              }
            }
          }
          return null;
        }
        function semanticSignature(el, root) {
          if(!el) return '';
          for(const attr of ['data-testid','data-info-type','data-element-name','data-selenium','aria-label']){
            const value=el.getAttribute?.(attr); if(value) return `${attr}=${value}`;
          }
          return semanticMarkerInfo(el.parentElement||el,root)?.signature || '';
        }
        function tripReviewerNameCandidate(el, root, text='') {
          if(!el||!root) return false;
          const value=String(text||cleanText(el,100)).replace(/\s+/g,' ').trim();
          if(!value||value.length>70||/^(?:\d+(?:[.,]\d+)?|\/?(?:5|10)|\d+\s+(?:ulasan|reviews?|comments?|komentar))$/i.test(value)) return false;
          if(/\b(?:member\s+tingkat|member\s+level|membership\s+level|loyalty\s+(?:level|status)|tier|badge)\b/i.test(value)) return false;
          const marker=root.querySelector?.('.ic_languages,[class*="ic_languages"],.ic_roomline,[class*="ic_roomline"],[data-info-type="room-type"],[data-info-type="group-name"],[data-info-type="stay-detail"]');
          if(!marker) return false;
          try{if(!(el.compareDocumentPosition(marker)&Node.DOCUMENT_POSITION_FOLLOWING))return false;}catch{return false;}
          const avatars=[...root.querySelectorAll('img,[class*="avatar" i],[class*="user-image" i],[class*="userImage" i]')].filter(node=>{try{const b=node.getBoundingClientRect();return b.width>12&&b.height>12;}catch{return false;}});
          if(!avatars.length) return false;
          try{
            const eb=el.getBoundingClientRect(), mb=marker.getBoundingClientRect();
            if(eb.width<=0||eb.height<=0||eb.top>mb.top+12) return false;
            return avatars.some(node=>{const ab=node.getBoundingClientRect();const dy=Math.abs((eb.top+eb.bottom-ab.top-ab.bottom)/2);const dx=Math.abs(eb.left-ab.right);return dy<=95&&dx<=220;});
          }catch{return false;}
        }
        function semanticRole(el, root) {
          const testid=(el.getAttribute?.('data-testid')||'').toLowerCase();
          const infoCarrier=el.closest?.('[data-info-type]');
          const infoType=String(infoCarrier?.getAttribute?.('data-info-type')||'').toLowerCase();
          const text=cleanText(el,180);
          const tripHost=/(?:^|\.)(?:trip|ctrip)\.com$/i.test(String(location.hostname||''));
          const tripMonth='(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
          const tripBareStayMonth=tripHost&&new RegExp('^'+tripMonth+'\\s+\\d{4}$','i').test(text);
          const tripStayDetail=tripHost&&(tripBareStayMonth||new RegExp('^(?:menginap(?:\\s+pada)?|stayed?(?:\\s+(?:in|during))?|stay(?:\\s+(?:in|during))?)\\s+'+tripMonth+'\\s+\\d{4}$','i').test(text));
          const tripFullReviewDate=tripHost&&(new RegExp('^\\d{1,2}\\s+'+tripMonth+'\\s+\\d{4}$','i').test(text)||/^(?:reviewed|posted|diulas|ditulis|dikirim)\s+(?:(?:a|an|one|satu|\d+)\s+)?(?:minute(?:\(s\)|s)?|hour(?:\(s\)|s)?|day(?:\(s\)|s)?|week(?:\(s\)|s)?|month(?:\(s\)|s)?|year(?:\(s\)|s)?|menit|jam|hari|minggu|pekan|bulan|tahun)\s+(?:ago|lalu)$/i.test(text)||/^(?:reviewed|posted)\s+(?:on\s+)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4}$/i.test(text));
          const tripTranslationResidual=tripHost?text.replace(/(?:teks\s+asli|original\s+text|laporkan\s+masalah\s+terjemahan|report\s+translation\s+issue|diterjemahkan\s+oleh\s+ai|translated\s+by\s+ai|terj[ea]mahan\s+disediakan\s+oleh\s+google|translation\s+provided\s+by\s+google)/giu,' ').replace(/[|·•\s]+/g,' ').trim():text;
          if(tripHost&&tripTranslationResidual!==text&&tripTranslationResidual.length<2)return'';
          const classTokens=Array.from(el.classList||[],value=>String(value).toLowerCase());
          const hasClass=pattern=>classTokens.some(value=>pattern.test(value));
          if(/\b(?:member\s+tingkat|member\s+level|membership\s+level|loyalty\s+(?:level|status)|tier|badge)\b/i.test(text)&&text.length<=120) return '';
          if(tripReviewerNameCandidate(el,root,text)) return 'reviewer_name';
          if(testid==='review-title') return 'review_title';
          if(testid==='review-comment'||testid==='review-text') return 'review_text';
          if(testid==='tvat-ratingscore') return 'rating_score';
          if(testid==='rating') return 'rating_score';
          if(testid==='product-name') return 'product_name';
          if(testid==='price') return 'price';
          if(testid==='description') return 'description';
          if(testid==='stock') return 'stock';
          if(infoType==='reviewer-name'){
            if(el.closest?.('strong')) return 'reviewer_name';
            if(String(el.tagName||'').toLowerCase()==='span') return 'reviewer_country';
            return 'reviewer_name';
          }
          if(infoType==='group-name') return 'traveler_type';
          if(infoType==='room-type') return 'room_type';
          if(infoType==='stay-detail') return 'stay_detail';
          if(tripStayDetail) return 'stay_detail';
          if(tripFullReviewDate) return 'review_date';
          if(el.closest?.('.Review-statusBar-left')&&/^diulas\s+pada\b/i.test(text)) return 'review_date';
          if(/^\/\s*(?:5|10)(?:[.,]0+)?$/.test(text)) return 'rating_max';
          const agodaRating=agodaRatingPart(el);
          if(agodaRating)return agodaRating.role;
          if(el.closest?.('cite') || hasClass(/review(?:item)?[-_].*(?:user|guest|customer).*(?:name|author)|reviewitem-username|reviewer[-_]?name|author[-_]?name|customer[_-]?name/i)) return 'reviewer_name';
          if(hasClass(/traveler[_-]?type|traveller[_-]?type|trip[_-]?type/i)) return 'traveler_type';
          if((!tripHost&&hasClass(/reviewitem-userreviewtime|review[-_].*(?:date|time)|reviewcard.*date|posted[-_]?date/i)) || /^diulas\s+pada\s+\d{1,2}\s+(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)\s+\d{4}$/i.test(text) || /^\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}$/i.test(text) || /^(?:reviewed|posted|diulas|ditulis|dikirim)\s+(?:(?:a|an|one|satu|\d+)\s+)?(?:minute(?:\(s\)|s)?|hour(?:\(s\)|s)?|day(?:\(s\)|s)?|week(?:\(s\)|s)?|month(?:\(s\)|s)?|year(?:\(s\)|s)?|menit|jam|hari|minggu|pekan|bulan|tahun)\s+(?:ago|lalu)$/i.test(text) || /^(?:(?:reviewed|posted)\s+(?:on\s+)?)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4}$/i.test(text)) return 'review_date';
          if(hasClass(/rating.*label|scorelabel|commentlevel|rating.*level/i)) return 'rating_label';
          if(hasClass(/rating.*score|score.*rating|review[-_]?comment[-_]?score|scorevalue|review[_-]?card[_-]?user[_-]?review/i) || (/^\d+(?:[.,]\d+)?$/.test(text) && /^\d+(?:[.,]\d+)?\s*\/\s*(?:5|10)$/.test(String(el.parentElement?.innerText||el.parentElement?.textContent||'').trim().replace(/\s+/g,' ')))) return 'rating_score';
          if(hasClass(/reviewitem-content|review[-_].*(?:content|text|copy|body)|comment[-_].*(?:content|text|body)|review[_-]?card[_-]?comment|readmorecomments.*comment|reviewcopy|review-copy/i)) return 'review_text';
          if(hasClass(/product[-_]?name|product[-_]?title|item[-_]?name/i)) return 'product_name';
          if(hasClass(/(?:^|[-_])price(?:$|[-_])|product[-_]?price/i)) return 'price';
          if(hasClass(/(?:^|[-_])description(?:$|[-_])|product[-_]?description/i)) return 'description';
          if(hasClass(/(?:^|[-_])stock(?:$|[-_])|availability/i)) return 'stock';
          if(String(el.tagName||'').toLowerCase()==='a'&&hasClass(/detail[-_]?link|product[-_]?link/i)) return 'url';
          if(!tripHost&&/^(?:\d{1,2}\s+)?(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|okt|nov|dec|des)\s+\d{4}$/i.test(text)) return 'review_date';
          if(/^\s*\d+\s+(?:ulasan|review|reviews|komentar|comments?)\s*$/i.test(text)) return 'review_count';
          const marker=semanticMarkerInfo(el.parentElement||el,root);
          const raw=String(marker?.raw||'').toLowerCase();
          if(/ic_languages|language|country/.test(raw)) return 'reviewer_country';
          if(/ic_roomline|roomline|room/.test(raw)) return 'room_type';
          if(/ic_business2|business2|travell|guest.*type/.test(raw)) return 'traveler_type';
          if(/calendar|stay|date/.test(raw)) return 'stay_detail';
          if(/message/.test(raw)) return 'review_count';
          const metadataAggregate=/\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|desember)\s+\d{4}\s*(?:[•·|–—-]\s*)?\d+(?:[.,]\d+)?\s*\/\s*(?:5|10)(?:[.,]0+)?\s*$/i.test(text)&&(/\b(?:perjalanan\s+bisnis|business\s+trip|pasangan|couple|keluarga|family|solo|sendiri|teman|friends?|rombongan|group|liburan|leisure)\b/i.test(text)||(!/[.!?](?:\s|$)/.test(text)&&text.length<=180));
          if(metadataAggregate)return '';
          const textBlocks=[...el.children].filter(child=>String(child.innerText||child.textContent||'').trim().replace(/\s+/g,' ').length>=20).length;
          if(text.length>=55&&text.length<=5000&&textBlocks<=6)return 'review_text';
          return '';
        }
        function cssModuleFamily(cls) {
          const raw=String(cls||'');
          if(!raw.includes('__')) return '';
          const base=raw.split('__')[0];
          const tail=base.split('_').pop()||'';
          if(tail.length<5 || !/(review|rating|score|user|guest|author|country|room|travell|date|time|content|comment|title|label|count)/i.test(tail)) return '';
          return `${tail}__`;
        }
        function travelokaRepeatedArticleSelector(article) {
          if(!article || !article.matches?.('[data-testid="review-list-container"] article')) return '';
          const list=article.closest('[data-testid="review-list-container"]');
          const globalSelector='[data-testid="review-list-container"] article';
          const globalCount=safeCount(globalSelector);
          const localCount=list?.querySelectorAll('article').length||0;
          // Traveloka may render desktop and mobile review trees simultaneously. Scope
          // the selector to the tree containing the selected record when both exist.
          if(list&&localCount>=2&&globalCount>localCount){
            const localSelector=`${buildUniqueSelector(list)} article`;
            const count=safeCount(localSelector);
            if(count>=2&&count<=250)return localSelector;
          }
          if(globalCount>=2&&globalCount<=250)return globalSelector;
          return '';
        }
        // Candidate-only semantic detection. This function must describe `el` itself.
        // Previously it called closest(), so a leaf field could be scored using the
        // selector/count of an ancestor record while its geometry/descendants still came
        // from the leaf. That mismatch caused cross-site recovery regressions.
        function semanticRepeatedContainerSelector(el) {
          if(!el || !(el instanceof Element)) return '';
          const tag=el.tagName.toLowerCase();
          if(el.matches?.('div[data-element-name="review-comment"][data-review-comment-type="comment"]')){
            const selector='div[data-element-name="review-comment"][data-review-comment-type="comment"]';
            const count=safeCount(selector); if(count>=2&&count<=250)return selector;
          }
          if(el.matches?.('[data-testid="review-list-container"] article')){
            const selector=travelokaRepeatedArticleSelector(el); if(selector)return selector;
          }
          if(el.matches?.('article.product-card[data-product-id]')){
            const selector='article.product-card[data-product-id]'; const count=safeCount(selector); if(count>=2&&count<=250)return selector;
          }
          // Prefer explicit semantic hooks supplied by the site. These are far safer than
          // a generic DIV/class count when field-first selection reaches the record node.
          for(const attr of ['data-testid','data-test','data-qa','data-element-name','data-selenium','role','aria-label']){
            const value=String(el.getAttribute(attr)||'').trim();
            if(!value || value.length>140) continue;
            if(!/(?:^|[-_\s])(review|comment|feedback|result|listing|item|card|row|entry)(?:[-_\s]|$)/i.test(value)) continue;
            const selector=`${tag}[${attr}="${quoteAttr(value)}"]`;
            const count=safeCount(selector);
            if(count>=2&&count<=250) return selector;
          }
          // CSS modules often keep a stable semantic prefix while changing only the hash.
          for(const cls of [...(el.classList||[])]){
            const m=String(cls).match(/^(.{3,80}?(?:review[_-]?card|comment[_-]?card|review[_-]?item|reviewcard|result[_-]?item|listing[_-]?item))__[^\s]+$/i);
            if(!m) continue;
            const family=m[1]+'__';
            const selector=`${tag}[class*="${quoteAttr(family)}"]`;
            const count=safeCount(selector);
            if(count>=2&&count<=250) return selector;
          }
          return '';
        }
        // Ancestor recovery is intentionally separate from candidate scoring. It is used
        // only when repairing a previously stored container from the clicked field.
        function semanticAncestorRepeatedContainerSelector(el) {
          if(!el || !(el instanceof Element)) return '';
          const agodaRoot=el.closest?.('div[data-element-name="review-comment"][data-review-comment-type="comment"]');
          if(agodaRoot){const selector=semanticRepeatedContainerSelector(agodaRoot);if(selector)return selector;}
          const travelokaArticle=el.closest?.('[data-testid="review-list-container"] article');
          if(travelokaArticle){const selector=travelokaRepeatedArticleSelector(travelokaArticle);if(selector)return selector;}
          const demoProduct=el.closest?.('article.product-card[data-product-id]');
          if(demoProduct){const selector=semanticRepeatedContainerSelector(demoProduct);if(selector)return selector;}
          let current=el.parentElement;
          for(let depth=0;current&&current!==document.body&&depth<10;depth+=1,current=current.parentElement){
            const selector=semanticRepeatedContainerSelector(current);
            if(selector)return selector;
          }
          return '';
        }
        function structuralRepeatedSelector(el) {
          if(!el||!el.parentElement) return '';
          const tag=el.tagName.toLowerCase();
          const siblings=[...el.parentElement.children].filter(x=>x.tagName===el.tagName);
          if(siblings.length<2||siblings.length>250) return '';
          const rawClasses=[...(el.classList||[])].filter(c=>c&&c.length<100&&!/^(active|selected|hover|focus|open|show|hidden|disabled)$/i.test(c));
          for(const cls of rawClasses){
            const same=siblings.filter(x=>x.classList?.contains(cls)).length;
            if(same<2) continue;
            const selector=`${tag}.${cssEscape(cls)}`;
            const count=safeCount(selector);
            if(count>=2&&count<=250) return selector;
          }
          return '';
        }
        function identityRepeatedSelector(el){
          const identity=directIdentityFromRoot(el);
          if(!identity) return '';
          const tag=el.tagName.toLowerCase();
          if(identity.mode==='containerAttribute'){
            const selector=`${tag}[${identity.attribute}]`;
            const count=safeCount(selector); if(count>=2&&count<=250)return selector;
          }
          if(identity.mode==='containerJsonAttribute'){
            const raw=String(el.getAttribute(identity.attribute)||'');
            const token=/htl_t_online_cmt_list_card_exposure/i.test(raw)?'htl_t_online_cmt_list_card_exposure':(identity.jsonPath?.split('.').pop()||'writingid');
            const selector=`${tag}[${identity.attribute}*="${quoteAttr(token)}"]`;
            const count=safeCount(selector); if(count>=2&&count<=250)return selector;
          }
          return '';
        }
        function contextualRepeatedSelector(el) {
          const tag=el.tagName.toLowerCase();
          if (!['article','li','tr'].includes(tag)) return '';
          let parent=el.parentElement;
          for(let depth=0;parent&&parent!==document.body&&depth<7;depth+=1,parent=parent.parentElement){
            for(const attr of ['data-testid','data-element-name','data-selenium','aria-label']){
              const value=parent.getAttribute(attr);
              if(!value || String(value).length>120) continue;
              const blob=String(value).toLowerCase();
              if(!/(review|comment|list|result|items|cards)/.test(blob)) continue;
              const selector=`[${attr}="${quoteAttr(value)}"] ${tag}`;
              const count=safeCount(selector);
              if(count>=2&&count<=250) return selector;
            }
          }
          return '';
        }
        function findContainerIdentity(root) { return directIdentityFromRoot(root); }
        function candidateLabel(el, selector) {
          const tag=el.tagName.toLowerCase();
          for (const attr of ['data-element-name','data-testid','data-selenium','aria-label','role']) {
            const value=el.getAttribute(attr);
            if (value) return `${tag} · ${attr}=${String(value).slice(0,52)}`;
          }
          const semanticClass=stableClasses(el).find(c=>classQuality(c)>=12);
          if (semanticClass) return `${tag} · ${semanticClass.slice(0,60)}`;
          return `${tag} · ${selector.slice(0,65)}`;
        }
        function containerCandidates(clicked,maxDepth=12) {
          const list=[]; const seen=new Set(); let el=clicked; let depth=0;
          const vw=window.innerWidth||1200, vh=window.innerHeight||800;
          while (el && el.nodeType===1 && el!==document.body && depth<=maxDepth) {
            const reusable=bestReusable(el,true);
            const identitySelector=identityRepeatedSelector(el);
            const semanticContainer=semanticRepeatedContainerSelector(el);
            const contextual=contextualRepeatedSelector(el);
            const structural=structuralRepeatedSelector(el);
            const selector=identitySelector || semanticContainer || contextual || structural || reusable?.selector || buildUniqueSelector(el);
            const logical=logicalRootInfo(selector,clicked);
            const count=logical.rawCount, logicalCount=logical.logicalCount;
            if (!seen.has(selector)) {
              seen.add(selector);
              const descendants=el.querySelectorAll('*').length, directChildren=el.children.length, text=cleanText(el,180);
              const rect=el.getBoundingClientRect();
              const areaRatio=Math.min(1,Math.max(0,(rect.width*rect.height)/Math.max(1,vw*vh)));
              const semanticBlob=[selector,...stableClasses(el),el.getAttribute('data-element-name'),el.getAttribute('data-testid'),el.getAttribute('role'),el.getAttribute('aria-label')].filter(Boolean).join(' ').toLowerCase();
              const identity=logical.identity || findContainerIdentity(el);
              let score=(reusable?.score||0);
              if(identitySelector) score+=300;
              else if(semanticContainer) score+=380;
              else if(contextual) score+=150;
              else if(structural) score+=105;
              if(identity) score+=180;
              if (logicalCount>=2 && logicalCount<=60) score+=250;
              else if (logicalCount>60 && logicalCount<=250) score+=70;
              else if (logicalCount===1) score-=220;
              else if (logicalCount>250) score-=160;
              if (count>logicalCount && identity) score+=50;
              if (descendants>=3&&descendants<=120) score+=35;
              if (descendants>=8&&descendants<=120) score+=20;
              if (directChildren>=2&&directChildren<=20) score+=14;
              if (text.length>=35) score+=14;
              if (areaRatio>0.003 && areaRatio<0.45) score+=18;
              if (containerWords.some(w=>semanticBlob.includes(w))) score+=45;
              if ((el.getAttribute('data-element-name')||'').toLowerCase().includes('review-comment')) score+=65;
              if (/^h[1-6]$/.test(el.tagName.toLowerCase()) || ['span','strong','em','small','p'].includes(el.tagName.toLowerCase())) score-=descendants===0?100:45;
              if (descendants===0) score-=60;
              if (logicalCount===1 && descendants>120) score-=180;
              if (logicalCount===1 && areaRatio>0.55) score-=220;
              // Dalam mode field-first, elemen yang diklik adalah FIELD, bukan batas record.
              // Kandidat container harus berupa ancestor yang benar-benar membungkus field.
              if (target==='field' && depth===0 && !semanticContainer && !identitySelector) score-=700;
              if (target==='field' && depth===0 && semanticContainer) score+=180;
              if (target==='field' && depth>0 && identity) score+=120;
              score-=depth*1.2;
              list.push({selector,count,logicalCount,keyAttribute:logical.keyAttribute,identity,semanticRecord:Boolean(semanticContainer||identitySelector),score:Math.round(score*10)/10,depth,tag:el.tagName.toLowerCase(),label:candidateLabel(el,selector),textSample:text,descendants,directChildren,width:Math.round(rect.width||0),height:Math.round(rect.height||0),panelLike:logicalCount===1&&(descendants>120||areaRatio>0.55)});
            }
            el=el.parentElement; depth+=1;
          }
          list.sort((a,b)=>b.score-a.score);
          const viable=list.find(x=>(x.logicalCount||x.count)>=2 && (x.logicalCount||x.count)<=250 && x.descendants>=2);
          return list.slice(0,10).map(x=>({...x,recommended:Boolean(viable && x.selector===viable.selector)}));
        }
        function sanitizeFieldName(value) {
          return String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'').slice(0,45)||'field';
        }
        function suggestFieldName(el) {
          let currentRoot=null;
          try { currentRoot=itemSelector ? el.closest(itemSelector) : null; } catch {}
          const role=semanticRole(el,currentRoot);
          if(role) return role;
          const attrPairs=['data-element-name','data-testid','data-test','data-qa','data-selenium','itemprop','name','aria-label','title'].map(name=>[name,el.getAttribute(name)]).filter(([,v])=>v);
          const ancestorHints=[];let parent=el.parentElement;
          for(let depth=0;parent&&depth<3;depth+=1,parent=parent.parentElement){ancestorHints.push(...stableClasses(parent).slice(0,3));for(const name of ['data-element-name','data-testid','data-selenium','aria-label']){const value=parent.getAttribute(name);if(value)ancestorHints.push(value);}}
          const hint=`${attrPairs.map(([,v])=>v).join(' ')} ${stableClasses(el).slice(0,4).join(' ')} ${ancestorHints.join(' ')}`.toLowerCase();
          const text=cleanText(el,300);
          if(/^\/\s*(?:5|10)(?:[.,]0+)?$/.test(text)) return 'rating_max';
          // Reviewer-name heuristic for sites whose visible username has opaque/generated classes.
          // A short text immediately followed by a membership/loyalty line is usually the
          // reviewer name, while clicking the membership value itself does not satisfy this rule.
          const nextText=el.nextElementSibling?cleanText(el.nextElementSibling,100):'';
          if(text.length>0&&text.length<=70&&/(?:member\s+tingkat|member\s+level|loyalty\s+(?:level|status))/i.test(nextText))return 'reviewer_name';
          const infoParent=el.closest?.('[data-info-type]');const infoType=(infoParent?.getAttribute('data-info-type')||'').toLowerCase();
          if(infoType==='reviewer-name'){if(el.tagName.toLowerCase()==='strong')return 'reviewer_name';if(el.tagName.toLowerCase()==='span'){const spans=[...infoParent.querySelectorAll(':scope > span')];if(spans.length&&spans[spans.length-1]===el)return 'reviewer_country';}return 'reviewer_name';}
          if(infoType==='group-name')return 'traveler_type';if(infoType==='room-type')return 'room_type';if(infoType==='stay-detail')return 'stay_detail';
          const testid=(el.getAttribute('data-testid')||'').toLowerCase();if(testid==='review-title')return 'review_title';if(testid==='review-comment')return 'review_text';if(testid==='tvat-ratingscore')return 'rating_score';
          if(/^direspon pada\b/i.test(text))return 'hotel_response_date';if(el.closest?.('.Review-statusBar-left')&&/^diulas\s+pada\b/i.test(text))return 'review_date';if(/^diulas\s+pada\s+\d{1,2}\s+(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)\s+\d{4}$/i.test(text))return 'review_date';if(/reviewitem-userreviewtime|review.*time|review.*date/i.test(hint))return 'review_date';if(/^(?:\d{1,2}\s+)?(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)\s+\d{4}$/i.test(text))return 'review_date';if(/^(?:reviewed|posted|diulas|ditulis|dikirim)\s+(?:(?:a|an|one|satu|\d+)\s+)?(?:minute(?:\(s\)|s)?|hour(?:\(s\)|s)?|day(?:\(s\)|s)?|week(?:\(s\)|s)?|month(?:\(s\)|s)?|year(?:\(s\)|s)?|menit|jam|hari|minggu|pekan|bulan|tahun)\s+(?:ago|lalu)$/i.test(text))return 'review_date';
          if(/^\s*\d+\s+(?:ulasan|review|reviews|komentar|comments?)\s*$/i.test(text))return 'review_count';
          const numericScore=text.match(/^\s*(10(?:[.,]0)?|[0-9](?:[.,]\d+)?)\s*$/);const ratingHint=/rating|score|star/.test(hint);let ratingContext=el.parentElement;let parentText=cleanText(ratingContext||el,80);
          for(let i=0;i<2&&ratingContext;i++,ratingContext=ratingContext.parentElement){const candidateText=cleanText(ratingContext,80);if(/(?:^|\s)(?:10(?:[.,]0)?|[0-9](?:[.,]\d+)?)(?:\s|$)/.test(candidateText)&&candidateText.length<70){parentText=candidateText;break;}}
          const parentLooksLikeRating=/(?:^|\s)(?:10(?:[.,]0)?|[0-9](?:[.,]\d+)?)(?:\s|$)/.test(parentText)&&parentText.length<70;const siblingTexts=[el.previousElementSibling,el.nextElementSibling].filter(Boolean).map(n=>cleanText(n,24));const hasNumericSibling=siblingTexts.some(v=>{const m=v.match(/^\s*(10(?:[.,]0)?|[0-9](?:[.,]\d+)?)\s*$/);return m&&Number(m[1].replace(',','.'))<=10;});
          if(numericScore&&Number(numericScore[1].replace(',','.'))<=10&&(ratingHint||parentLooksLikeRating||hasNumericSibling||text.length<=5))return 'rating_score';if(!numericScore&&text.length>0&&text.length<45&&(ratingHint||parentLooksLikeRating||hasNumericSibling))return 'rating_label';
          if(/^(?:(?:reviewed|posted)\s+(?:on\s+)?)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4}$/i.test(text))return 'review_date';
          const mappings=[[/rating|score|star/,'rating_score'],[/reviewer|review-user|guest-name|author|username|user-name/,'reviewer_name'],[/review.*(bodytext|text|content)|comment-bodytext|comment|feedback/,'review_text'],[/review.*date|reviewed|posted|date|time/,'review_date'],[/country|nationality/,'reviewer_country'],[/room.*type|room-type/,'room_type'],[/travell?er|guest.*type|trip.*type/,'traveler_type'],[/price|amount|cost|rate/,'price'],[/product.*name|product.*title/,'product_name'],[/hotel.*name|property.*name/,'hotel_name'],[/title|heading/,'title'],[/image|photo|thumbnail|avatar/,'image_url'],[/link|url/,'url']];
          for(const [rx,name] of mappings)if(rx.test(hint))return name;
          if(/\b(?:reviewed\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+20\d{2}\b/i.test(text))return 'review_date';if(/\bfrom\s+[a-z][a-z .'-]{2,}$/i.test(text)&&text.length<90)return 'reviewer_name';if(text.length>=70)return 'review_text';if(el.tagName.toLowerCase()==='a')return 'url';if(el.tagName.toLowerCase()==='img')return 'image_url';
          const semantic=attrPairs.map(([,v])=>sanitizeFieldName(v)).find(v=>v&&!/^(sc_|css_|r_|styled|typography)/.test(v)&&v.length<32);return semantic||'field';
        }
        function relativeSelectorFor(el, rootSelector) {
          if(!rootSelector)return null;const logical=logicalRootInfo(rootSelector,el);const roots=logical.roots;if(!roots.length)return null;let root=null;try{root=el.closest(rootSelector);}catch{return null;}if(!root)return null;
          const targetSignature=semanticSignature(el,root);
          const targetRole=semanticRole(el,root);
          if(el===root)return {containerSelector:rootSelector,selector:':scope',matches:roots.length,total:roots.length,ambiguous:0,mismatched:0,targetSignature,keyAttribute:logical.keyAttribute};
          const candidates=[];
          const positionalSelector=positionalRelativeSelector(el,root);
          if(positionalSelector)candidates.push(positionalSelector);
          const agodaRating=agodaRatingPart(el);
          if(agodaRating){
            const position=agodaRating.index===0?'first-of-type':'nth-of-type(2)';
            candidates.push(`:scope > .Review-comment-left p > span:${position}`);
            candidates.push(`:scope > .Review-comment-left .Review-comment-score > span:${position}`);
            candidates.push(`.Review-comment-left p > span:${position}`);
            candidates.push(`.Review-comment-left .Review-comment-score > span:${position}`);
          }
          if(targetRole==='review_date'){
            candidates.push(':scope [class*="ReviewCard_date__"]');
            candidates.push(':scope [class*="ReviewCard_date"]');
            candidates.push(':scope [class*="reviewItem-userReviewTime"]');
            candidates.push(':scope [class*="userReviewTime"]');
            candidates.push(':scope [class*="reviewTime"]');
            candidates.push(':scope [class*="date__"]');
            candidates.push(':scope time');
          }
          for(const attr of ['data-testid','data-test','data-qa','data-element-name','data-selenium','itemprop','name','aria-label','role']){const value=el.getAttribute(attr);if(value)candidates.push(el.tagName.toLowerCase()+'['+attr+'="'+quoteAttr(value)+'"]');}
          // Field selectors are evaluated empirically inside every logical record. Even an
          // opaque/CSS-module class is useful when it occurs exactly once per record. Do not
          // throw those classes away merely because their name looks generated.
          const rawClasses=[...(el.classList||[])].filter(c=>c&&c.length<=120&&!/^(active|selected|hover|focus|open|show|hidden|disabled)$/i.test(c));
          for(const c of rawClasses.slice(0,6)){candidates.push(`${el.tagName.toLowerCase()}.${cssEscape(c)}`);candidates.push(`.${cssEscape(c)}`);const family=cssModuleFamily(c);if(family){candidates.push(`${el.tagName.toLowerCase()}[class*="${quoteAttr(family)}"]`);candidates.push(`[class*="${quoteAttr(family)}"]`);}}
          if(rawClasses.length>=2)candidates.push(`${el.tagName.toLowerCase()}.${rawClasses.slice(0,2).map(cssEscape).join('.')}`);
          const anchored=semanticMarkerInfo(el.parentElement||el,root);if(anchored?.carrier&&anchored.carrier!==el){const carrierTag=anchored.carrier.tagName.toLowerCase(),targetTag=el.tagName.toLowerCase();candidates.push(`${carrierTag}:has(> ${anchored.selector}) > ${targetTag}`);const targetClasses=rawClasses.slice(0,1);if(targetClasses.length)candidates.push(`${carrierTag}:has(> ${anchored.selector}) > ${targetTag}.${cssEscape(targetClasses[0])}`);}
          const infoParent=el.closest?.('[data-info-type]');if(infoParent&&root.contains(infoParent)){const info=infoParent.getAttribute('data-info-type');const own=siblingPositionSelector(el);candidates.push(`[data-info-type="${quoteAttr(info)}"] ${own}`);if(el.tagName.toLowerCase()==='strong')candidates.push(`[data-info-type="${quoteAttr(info)}"] strong`);}
          const sem=semanticAncestorSelector(el,root);if(sem)candidates.push(`${sem} ${siblingPositionSelector(el)}`);
          const classes=stableClasses(el).filter(c=>classQuality(c)>0).slice(0,3);if(classes.length){candidates.push(el.tagName.toLowerCase()+'.'+classes.slice(0,2).map(cssEscape).join('.'));if(classQuality(classes[0])>=10)candidates.push('.'+cssEscape(classes[0]));}
          const path=[];let cur=el;while(cur&&cur!==root){let part=siblingPositionSelector(cur),strong=false;for(const attr of ['data-testid','data-info-type','data-element-name','data-selenium','aria-label']){const value=cur.getAttribute(attr);if(value){part=cur.tagName.toLowerCase()+'['+attr+'="'+quoteAttr(value)+'"]';strong=true;break;}}if(!strong){const cc=stableClasses(cur).filter(c=>/review|comment|rating|score|status|author|guest|user|date|title|room|stay|traveler|traveller/i.test(c)).slice(0,1);if(cc.length)part=cur.tagName.toLowerCase()+'.'+cc.map(cssEscape).join('.')+(siblingPositionSelector(cur).includes(':')?siblingPositionSelector(cur).slice(cur.tagName.toLowerCase().length):'');}path.unshift(part);cur=cur.parentElement;}if(path.length){candidates.push(`:scope > ${path.join(' > ')}`);candidates.push(path.join(' > '));}
          const contextBoundRole=/^(?:reviewer_country|room_type|traveler_type|stay_detail)$/.test(targetRole)||(targetRole==='review_text'&&/(?:^|\.)(?:tiket|trip)\.com$/i.test(location.hostname));
          // Review dates are semantically stable even when Agoda renders the same date
          // with a different wrapper/class signature (photos, hotel responses, etc.).
          // For this role, require the candidate to still be a review_date, but do not
          // reject it merely because its DOM signature differs from the originally
          // selected card. This prevents stay_detail from being accepted while allowing
          // legitimate "Diulas pada ..." variants across records.
          const semanticFlexibleRole=targetRole==='review_date';
          const ranked=[];for(const selector of [...new Set(candidates.filter(Boolean))]){const strictStructural=/^:scope\s*>\s*[a-z][a-z0-9-]*(?::(?:nth-of-type\(\d+\)|last-of-type))?(?:\s*>\s*[a-z][a-z0-9-]*(?::(?:nth-of-type\(\d+\)|last-of-type))?)*$/i.test(selector);let matches=0,ambiguous=0,mismatched=0,single=0;for(const r of roots){try{let found=[...r.querySelectorAll(selector)];if(found.length>1&&semanticFlexibleRole&&tripHost){const dateOnly=found.filter(node=>semanticRole(node,r)===targetRole);if(dateOnly.length)found=dateOnly;}if(found.length>1){const visible=found.filter(el=>{try{const st=getComputedStyle(el),b=el.getBoundingClientRect();return st.display!=='none'&&st.visibility!=='hidden'&&Number(st.opacity||1)>0&&b.width>0&&b.height>0;}catch{return true;}});if(visible.length===1)found=visible;else{const pool=visible.length?visible:found;const values=new Set(pool.map(el=>String(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim()));if(values.size===1)found=[pool[0]];}}if(found.length)matches++;if(found.length===1)single++;if(found.length>1)ambiguous++;if(found.length===1){const foundRole=semanticRole(found[0],r);const signatureMismatch=Boolean(targetSignature&&semanticSignature(found[0],r)!==targetSignature);const roleMismatch=Boolean((contextBoundRole||semanticFlexibleRole)&&foundRole!==targetRole);const signatureMismatchFatal=Boolean(!semanticFlexibleRole&&(!strictStructural||contextBoundRole)&&signatureMismatch);if(roleMismatch||signatureMismatchFatal)mismatched++;}}catch{}}const ratio=roots.length?matches/roots.length:0;const singleRatio=roots.length?single/roots.length:0;const semanticBonus=selector.includes(':has(')?320:(/data-testid|data-info-type|data-element-name|data-selenium|rating|score/i.test(selector)?110:0);const scopeBonus=selector.startsWith(':scope > ')?80:0;const structuralBonus=strictStructural?((contextBoundRole||semanticFlexibleRole)?40:260):0;const score=ratio*1000+singleRatio*700-ambiguous*700-mismatched*1100+semanticBonus+scopeBonus+structuralBonus-selector.length*0.08;ranked.push({containerSelector:rootSelector,selector,matches,total:roots.length,ambiguous,mismatched,targetSignature,score,keyAttribute:logical.keyAttribute});}ranked.sort((a,b)=>b.score-a.score);const best=ranked[0]||null;return best?{...best,selectors:ranked.filter(x=>x.matches>0&&x.ambiguous===0&&(!(contextBoundRole||semanticFlexibleRole)||x.mismatched===0)).slice(0,8).map(x=>x.selector)}:null;
        }
        function paginationContextFor(el) {
          let current=el;
          for(let depth=0;current&&current!==document.body&&depth<12;depth+=1,current=current.parentElement){
            const tag=current.tagName.toLowerCase();
            const attrs=['data-testid','data-element-name','data-selenium','aria-label','role'];
            const blob=[...attrs.map(name=>current.getAttribute(name)),...current.classList].filter(Boolean).join(' ').toLowerCase();
            let numericControls=0;
            try{
              const numericClickables=[...current.querySelectorAll('button,a,[role="button"],[role="link"]')].filter(node=>/^\d{1,5}$/.test(cleanText(node,12)));
              const numericBareItems=[...current.querySelectorAll('li')].filter(node=>/^\d{1,5}$/.test(cleanText(node,12))&&!node.querySelector('button,a,[role="button"],[role="link"]'));
              numericControls=numericClickables.length+numericBareItems.length;
            }catch{}
            if(!/(paginat|review[-_ ]?(?:list|modal|dialog|drawer|panel)|comment[-_ ]?(?:list|modal|dialog|drawer|panel))/.test(blob)&&numericControls<2)continue;
            for(const name of attrs){
              const value=current.getAttribute(name);
              if(!value||String(value).length>140)continue;
              const selector=`${tag}[${name}="${quoteAttr(value)}"]`;
              if(safeCount(selector)>=1)return{selector,kind:/paginat/.test(blob)?'pagination':'review-context',depth};
            }
            const className=[...current.classList].find(value=>/paginat|review[-_]?(?:list|modal|dialog|drawer|panel)|comment[-_]?(?:list|modal|dialog|drawer|panel)/i.test(value));
            if(className){const selector=`${tag}.${cssEscape(className)}`;if(safeCount(selector)>=1)return{selector,kind:/paginat/i.test(className)?'pagination':'review-context',depth};}
            const reusable=bestReusable(current,false);
            if(reusable?.selector&&safeCount(reusable.selector)===1)return{selector:reusable.selector,kind:numericControls>=2?'pagination':'review-context',depth};
            // CSS-module paginators (notably Trip) may have no semantic attribute
            // at all. A unique structural selector for the numeric-control cluster
            // is still safer than leaving the context empty and later allowing a
            // generic “Next” button elsewhere on the page to win.
            if(numericControls>=2){
              const structural=buildUniqueSelector(current);
              if(structural&&safeCount(structural)===1)return{selector:structural,kind:'pagination-structural',depth};
            }
          }
          return null;
        }
        function describe(el) {
          const reusable=bestReusable(el,false);
          const href=el.getAttribute?.('href');
          const src=el.getAttribute?.('src');
          const value=('value' in el&&typeof el.value!=='object')?String(el.value??''):'';
          let root=null;
          try{root=itemSelector?el.closest(itemSelector):null;}catch{}

          let inferredContainer=null;
          let candidates=[];
          let relative=null;
          if(target==='field'){
            if(itemSelector){
              relative=relativeSelectorFor(el,itemSelector);
              // Pulihkan proyek lama yang mengunci seluruh panel/list sebagai satu record.
              // Hook Agoda ini merepresentasikan satu ulasan tamu dan secara eksplisit
              // mengecualikan respons hotel. Penggantian baru diterapkan oleh renderer
              // setelah pengguna menekan Tambahkan; Batal tidak mengubah proyek.
              const semanticSelector=semanticAncestorRepeatedContainerSelector(el)||semanticRepeatedContainerSelector(el);
              const activeUnsafe=!relative||relative.selector===':scope'||relative.matches<2||relative.ambiguous>0||relative.mismatched>0;
              if(semanticSelector&&semanticSelector!==itemSelector){
                const semanticRelative=relativeSelectorFor(el,semanticSelector);
                if(semanticRelative&&semanticRelative.selector!==':scope'&&semanticRelative.matches>=2&&semanticRelative.ambiguous===0&&semanticRelative.mismatched===0){
                  candidates=containerCandidates(el,12);
                  const semanticCandidate=candidates.find(candidate=>candidate.selector===semanticSelector)
                    || {selector:semanticSelector,count:semanticRelative.total,logicalCount:semanticRelative.total,depth:1,tag:'div',label:'Review Agoda',textSample:cleanText(el.closest?.(semanticSelector)||el,180),descendants:Number(el.closest?.(semanticSelector)?.querySelectorAll('*').length||0),semanticRecord:true,panelLike:false,identity:directIdentityFromRoot(el.closest?.(semanticSelector)),recommended:true};
                  if(activeUnsafe||/data-element-name\s*=\s*["']?review-comment/i.test(semanticSelector)){
                    inferredContainer={...semanticCandidate,replaceActive:true,previousSelector:itemSelector,recommended:true};
                    relative=semanticRelative;
                    try{root=el.closest(semanticSelector);}catch{}
                  }
                }
              }
            }else{
              candidates=containerCandidates(el,12);
              // Uji kandidat bersama selector FIELD. Container yang membuat field menjadi
              // :scope (record === field), ambigu, atau tidak lintas-record tidak layak.
              const fieldReady=[];
              for(const candidate of candidates){
                const count=Number(candidate.logicalCount||candidate.count||0);
                if(candidate.depth===0||candidate.panelLike||count<2||count>250) continue;
                const rel=relativeSelectorFor(el,candidate.selector);
                if(!rel||rel.selector===':scope'||rel.matches<2) continue;
                const coverage=rel.total?rel.matches/rel.total:0;
                const quality=(candidate.score||0)+(candidate.identity?420:0)+coverage*500-rel.ambiguous*900-rel.mismatched*1000;
                fieldReady.push({candidate,rel,quality});
              }
              fieldReady.sort((a,b)=>b.quality-a.quality);
              if(fieldReady.length){
                inferredContainer=fieldReady[0].candidate;
                relative=fieldReady[0].rel;
              } else {
                // Jika klik jatuh pada kartu itu sendiri (umum pada situs dengan pointer-events
                // atau area kartu yang luas), pertahankan batas record semantik yang kuat.
                // Field spesifik kemudian dipulihkan dari nama/role field di dialog.
                const selfRecord=candidates.find(c=>c.recommended&&c.semanticRecord&&!c.panelLike&&Number(c.logicalCount||c.count||0)>=2&&Number(c.logicalCount||c.count||0)<=250)
                  || candidates.find(c=>c.semanticRecord&&!c.panelLike&&Number(c.logicalCount||c.count||0)>=2&&Number(c.logicalCount||c.count||0)<=250);
                if(selfRecord){
                  inferredContainer=selfRecord;
                  relative={containerSelector:selfRecord.selector,selector:':scope',matches:Number(selfRecord.logicalCount||selfRecord.count||0),total:Number(selfRecord.logicalCount||selfRecord.count||0),ambiguous:0,mismatched:0,targetSignature:'',keyAttribute:selfRecord.keyAttribute||null,selectors:[':scope']};
                }else{
                  inferredContainer=null;
                  relative=null;
                }
              }
              if(inferredContainer?.selector){try{root=el.closest(inferredContainer.selector);}catch{}}
            }
          }else if(target==='item'){
            candidates=containerCandidates(el,12);
          }

          const rootIdentity=findContainerIdentity(root) || inferredContainer?.identity || null;
          return {
            selector:buildUniqueSelector(el),
            reusableSelector:reusable?.selector||buildUniqueSelector(el),
            reusableCount:reusable?.count||1,
            xpath:buildXPath(el),
            tag:el.tagName.toLowerCase(),
            text:cleanText(el),
            href:href?String(el.href||href):'',
            src:src?String(el.src||src):'',
            value,
            suggestedName:suggestFieldName(el),
            semanticRole:semanticRole(el,root),
            semanticSignature:semanticSignature(el,root),
            paginationContext:target==='pagination'?paginationContextFor(el):null,
            containerIdentity:rootIdentity,
            attributes:attrsObject(el),
            relative,
            inferredContainer,
            containerCandidates:candidates
          };
        }
        function elementBelow(x,y,overlay) {
          const old=overlay.style.pointerEvents;
          overlay.style.pointerEvents='none';
          const el=document.elementFromPoint(x,y);
          overlay.style.pointerEvents=old;
          return el instanceof Element ? el : null;
        }
        function nearestScrollable(el) {
          let cur=el;
          while (cur && cur!==document.body) {
            const style=getComputedStyle(cur);
            if (/(auto|scroll)/.test(style.overflowY) && cur.scrollHeight>cur.clientHeight+4) return cur;
            cur=cur.parentElement;
          }
          return document.scrollingElement || document.documentElement;
        }

        const overlay=document.createElement('div');
        overlay.id='__crawlstudio_picker_overlay__';
        Object.assign(overlay.style,{position:'fixed',inset:'0',zIndex:'2147483647',background:'rgba(0,0,0,0.001)',cursor:'crosshair',pointerEvents:'auto'});
        const banner=document.createElement('div');
        banner.textContent=target==='item'?'MyDataset: klik satu kartu/baris sebagai batas record manual':target==='field'?'MyDataset: klik data yang ingin diambil — struktur record akan dicari otomatis':'MyDataset: klik kontrol navigasi yang ingin digunakan';
        Object.assign(banner.style,{position:'fixed',top:'10px',left:'50%',transform:'translateX(-50%)',padding:'8px 12px',background:'#111827',color:'#fff',font:'12px system-ui,sans-serif',borderRadius:'8px',boxShadow:'0 4px 18px rgba(0,0,0,.35)',pointerEvents:'none',maxWidth:'70vw',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'});
        overlay.appendChild(banner);
        document.documentElement.appendChild(overlay);

        let hovered=null, previous=null, settled=false;
        function restoreHover() {
          if (hovered && previous) {
            try { hovered.style.outline=previous.outline; hovered.style.outlineOffset=previous.outlineOffset; hovered.style.backgroundColor=previous.backgroundColor; if(previous.hadMarker) hovered.setAttribute('data-crawlloom-picker-hover',previous.markerValue||''); else hovered.removeAttribute('data-crawlloom-picker-hover'); } catch {}
          }
          hovered=null; previous=null;
        }
        function showHover(el, x, y) {
          if (target==='field') el=refineFieldElement(el,x,y);
          else if (target==='pagination') el=refinePaginationElement(el);
          if (!el || el===hovered) return;
          restoreHover();
          hovered=el;
          previous={outline:el.style.outline,outlineOffset:el.style.outlineOffset,backgroundColor:el.style.backgroundColor,hadMarker:el.hasAttribute('data-crawlloom-picker-hover'),markerValue:el.getAttribute('data-crawlloom-picker-hover')};
          el.setAttribute('data-crawlloom-picker-hover','');
          el.style.outline=`3px solid ${target==='item'?'#7c5cff':target==='pagination'?'#d8a542':'#4d91ff'}`;
          el.style.outlineOffset='2px';
          const t=cleanText(el,60);
          banner.textContent=`${target==='item'?'Batas record':target==='field'?'Data':'Navigasi'} · ${el.tagName.toLowerCase()}${t?' · '+t:''}`;
        }
        function cleanup(reason) {
          restoreHover();
          overlay.remove();
          window.removeEventListener('keydown',onKey,true);
          if (window[STATE_KEY]?.overlay===overlay) delete window[STATE_KEY];
          if (reason==='cancel' && !settled) { settled=true; resolve({cancelled:true}); }
        }
        function onKey(e) {
          if (e.key==='Escape') { e.preventDefault(); e.stopImmediatePropagation(); cleanup('cancel'); }
        }
        overlay.addEventListener('pointermove',e=>showHover(elementBelow(e.clientX,e.clientY,overlay),e.clientX,e.clientY),true);
        overlay.addEventListener('mousemove',e=>showHover(elementBelow(e.clientX,e.clientY,overlay),e.clientX,e.clientY),true);
        overlay.addEventListener('wheel',e=>{
          const el=elementBelow(e.clientX,e.clientY,overlay);
          const scroller=nearestScrollable(el);
          try { scroller.scrollBy({top:e.deltaY,left:e.deltaX,behavior:'auto'}); } catch { scroller.scrollTop+=e.deltaY; }
          e.preventDefault(); e.stopImmediatePropagation();
        },{capture:true,passive:false});
        overlay.addEventListener('click',e=>{
          e.preventDefault(); e.stopImmediatePropagation();
          let el=elementBelow(e.clientX,e.clientY,overlay);
          if(target==='field') el=refineFieldElement(el,e.clientX,e.clientY);
          else if(target==='pagination') el=refinePaginationElement(el);
          if (!el || el===document.documentElement || el===document.body) return;
          let payload;
          try { payload=describe(el); }
          catch (err) { cleanup('error'); if (!settled) { settled=true; reject(new Error(err?.message||String(err))); } return; }
          settled=true;
          cleanup('picked');
          resolve(payload);
        },true);
        window.addEventListener('keydown',onKey,true);
        window[STATE_KEY]={overlay,cleanup};
      } catch (err) {
        reject(err);
      }
    });
  }

  function cancelRuntime() {
    const s=window.__crawlLoomOverlayPickerV18 || window.__crawlLoomOverlayPickerV17 || window.__crawlLoomOverlayPickerV16 || window.__crawlLoomOverlayPickerV15 || window.__crawlLoomOverlayPickerV14 || window.__crawlLoomOverlayPickerV11 || window.__crawlStudioOverlayPickerV8 || window.__crawlStudioOverlayPickerV6;
    if (s?.cleanup) { try { s.cleanup('cancel'); } catch {} }
    return true;
  }

  function highlightRuntime(payload) {
    const KEY='__crawlLoomDirectHighlightsV15';
    const revision=Number(payload?.revision||0);
    const latest=Number(window.__crawlLoomLatestTransientRevision||0);
    if(revision && revision<latest) return 0;
    if(revision) window.__crawlLoomLatestTransientRevision=revision;
    const clear=()=>{
      for(const key of ['__crawlLoomDirectHighlightsV15','__crawlLoomDirectHighlightsV14','__crawlLoomDirectHighlightsV13']){
        const old=window[key]||[];
        for (const x of old) { try { x.el.style.outline=x.outline; x.el.style.outlineOffset=x.outlineOffset; x.el.style.boxShadow=x.boxShadow; if(x.hadMarker)x.el.setAttribute('data-crawlloom-transient-highlight',x.markerValue||'');else x.el.removeAttribute('data-crawlloom-transient-highlight'); } catch {} }
        window[key]=[];
      }
    };
    clear();
    if (!payload || payload.type==='clear') return 0;
    const marker=(el,limit)=>{let cur=el;for(let depth=0;cur&&cur!==limit&&depth<4;depth++,cur=cur.parentElement){for(const node of [cur,...cur.querySelectorAll(':scope > i, :scope > svg, :scope > [data-testid], :scope > [data-info-type], :scope > [data-element-name]')]){if(!node)continue;for(const a of ['data-testid','data-info-type','data-element-name','data-selenium','aria-label']){const v=node.getAttribute?.(a);if(v&&/(language|country|room|business|travell|guest|calendar|date|message|review|rating|score|author|user|name)/i.test(v))return a+'='+v;}for(const c of [...(node.classList||[])])if(/^(?:ic_languages|ic_roomline|ic_business2)$/i.test(c)||/(?:calendar|message|language|country|roomline|business2|travell|rating|score)/i.test(c))return 'class='+c;}}return '';};
    const signature=(el,root)=>{if(!el)return '';for(const a of ['data-testid','data-info-type','data-element-name','data-selenium','aria-label']){const v=el.getAttribute?.(a);if(v)return a+'='+v;}return marker(el.parentElement||el,root);};
    const roleOf=(el,root)=>{
      if(!el)return'';
      const txt=String(el.innerText||el.textContent||'').trim().replace(/\s+/g,' ');
      const classTokens=Array.from(el.classList||[],value=>String(value).toLowerCase());
      const hasClass=pattern=>classTokens.some(value=>pattern.test(value));
      const sig=signature(el,root).toLowerCase();
      const testid=String(el.getAttribute?.('data-testid')||'').toLowerCase();
      const infoCarrier=el.closest?.('[data-info-type]');
      const infoType=String(infoCarrier?.getAttribute?.('data-info-type')||'').toLowerCase();
      if(/\b(?:member\s+tingkat|member\s+level|membership\s+level|loyalty\s+(?:level|status)|tier|badge)\b/i.test(txt)&&txt.length<=120)return'';
      if(testid==='review-title')return'review_title';
      if(testid==='review-comment'||testid==='review-text')return'review_text';
      if(testid==='product-name')return'product_name';
      if(testid==='price')return'price';
      if(testid==='description')return'description';
      if(testid==='stock')return'stock';
      if(testid==='rating')return'rating_score';
      if(infoType==='reviewer-name'){if(el.closest?.('strong'))return'reviewer_name';if(String(el.tagName||'').toLowerCase()==='span')return'reviewer_country';return'reviewer_name';}
      if(infoType==='group-name')return'traveler_type';
      if(infoType==='room-type')return'room_type';
      if(infoType==='stay-detail')return'stay_detail';
      if(el.closest?.('.Review-statusBar-left')&&/^diulas\s+pada\b/i.test(txt))return'review_date';
      const agodaLeft=el.closest?.('.Review-comment-left');
      const agodaGroup=agodaLeft&&el.closest?.('.Review-comment-score, p');
      if(agodaGroup&&agodaLeft.contains(agodaGroup)){
        const spans=[...agodaGroup.children].filter(node=>String(node.tagName||'').toLowerCase()==='span');
        const carrier=spans.find(node=>node===el||node.contains(el));
        if(spans[0]===carrier)return'rating_score';
        if(spans[1]===carrier)return'rating_label';
      }
      if(/ic_languages|language|country/.test(sig))return'reviewer_country';
      if(/ic_roomline|roomline/.test(sig))return'room_type';
      if(/ic_business2|business2|travell/.test(sig))return'traveler_type';
      if(hasClass(/traveler[_-]?type|traveller[_-]?type|trip[_-]?type/))return'traveler_type';
      if(/calendar/.test(sig))return'stay_detail';
      if(/message/.test(sig)||/^\d+\s+(?:ulasan|reviews?|comments?|komentar)$/i.test(txt))return'review_count';
      if(hasClass(/reviewitem-username|review.*(?:user|guest|customer).*name|reviewer.*name|author.*name|customer[_-]?name/)||el.closest?.('cite'))return'reviewer_name';
      if(hasClass(/userreviewtime|review.*(?:date|time)|reviewcard.*date/)||/^\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}$/i.test(txt)||/^(?:reviewed|posted|diulas|ditulis|dikirim)\s+(?:(?:a|an|one|satu|\d+)\s+)?(?:minute(?:\(s\)|s)?|hour(?:\(s\)|s)?|day(?:\(s\)|s)?|week(?:\(s\)|s)?|month(?:\(s\)|s)?|year(?:\(s\)|s)?|menit|jam|hari|minggu|pekan|bulan|tahun)\s+(?:ago|lalu)$/i.test(txt)||/^diulas\s+pada\s+\d{1,2}\s+(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)\s+\d{4}$/i.test(txt)||/^(?:(?:reviewed|posted)\s+(?:on\s+)?)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4}$/i.test(txt))return'review_date';
      const ptxt=String(el.parentElement?.innerText||el.parentElement?.textContent||'').trim().replace(/\s+/g,' ');
      if(/^\/\s*(?:5|10)(?:[.,]0+)?$/.test(txt))return'rating_max';
      if(hasClass(/rating.*label|scorelabel|commentlevel/))return'rating_label';
      if(hasClass(/rating.*score|score.*rating|review[_-]?card[_-]?user[_-]?review/)||(el.getAttribute?.('data-testid')||'').toLowerCase()==='tvat-ratingscore'||(/^\d+(?:[.,]\d+)?$/.test(txt)&&/^\d+(?:[.,]\d+)?\s*\/\s*(?:5|10)$/.test(ptxt)))return'rating_score';
      if(hasClass(/reviewitem-content|review[-_].*(?:content|text|copy|body)|comment[-_].*(?:content|text|body)|review[_-]?card[_-]?comment|readmorecomments.*comment|reviewcopy|review-copy/))return'review_text';
      if(hasClass(/product[-_]?name|product[-_]?title|item[-_]?name/))return'product_name';
      if(hasClass(/(?:^|[-_])price(?:$|[-_])|product[-_]?price/))return'price';
      if(hasClass(/(?:^|[-_])description(?:$|[-_])|product[-_]?description/))return'description';
      if(hasClass(/(?:^|[-_])stock(?:$|[-_])|availability/))return'stock';
      if(String(el.tagName||'').toLowerCase()==='a'&&hasClass(/detail[-_]?link|product[-_]?link/))return'url';
      const metadataAggregate=/\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|desember)\s+\d{4}\s*(?:[•·|–—-]\s*)?\d+(?:[.,]\d+)?\s*\/\s*(?:5|10)(?:[.,]0+)?\s*$/i.test(txt)&&(/\b(?:perjalanan\s+bisnis|business\s+trip|pasangan|couple|keluarga|family|solo|sendiri|teman|friends?|rombongan|group|liburan|leisure)\b/i.test(txt)||(!/[.!?](?:\s|$)/.test(txt)&&txt.length<=180));
      if(metadataAggregate)return'';
      const textBlocks=[...el.children].filter(child=>String(child.innerText||child.textContent||'').trim().replace(/\s+/g,' ').length>=20).length;
      if(txt.length>=55&&txt.length<=5000&&textBlocks<=6)return'review_text';
      return'';
    };
    const resolve=(root,field)=>{const selectors=[...new Set([field.fieldSelector,...(field.fieldSelectors||[])].filter(Boolean))];const expected=field.expectedSignature||'';const tag=String(field.targetMeta?.tag||'').toLowerCase();const classes=new Set((field.targetMeta?.classes||[]).map(String));const wantedRole=String(field.targetMeta?.semanticRole||'');let best=null;for(let i=0;i<selectors.length;i++){const sel=selectors[i];let list=[];try{list=sel===':scope'?[root]:[...root.querySelectorAll(sel)];}catch{continue;}if(!list.length)continue;let candidates=list;if(tag){const byTag=candidates.filter(el=>el.tagName?.toLowerCase()===tag);if(byTag.length)candidates=byTag;}const strictStructural=/^:scope\s*>\s*[a-z][a-z0-9-]*(?::(?:nth-of-type\(\d+\)|last-of-type))?(?:\s*>\s*[a-z][a-z0-9-]*(?::(?:nth-of-type\(\d+\)|last-of-type))?)*$/i.test(sel);const contextBoundRole=/^(?:reviewer_country|room_type|traveler_type|stay_detail)$/.test(wantedRole)||(wantedRole==='review_text'&&/(?:^|\.)(?:tiket|trip)\.com$/i.test(location.hostname));const semanticFlexibleRole=wantedRole==='review_date';if(expected){const bySig=candidates.filter(el=>signature(el,root)===expected);if(bySig.length)candidates=bySig;else if(semanticFlexibleRole){const byRole=candidates.filter(el=>roleOf(el,root)===wantedRole);if(!byRole.length)continue;candidates=byRole;}else if(!strictStructural||contextBoundRole)continue;}if(wantedRole&&(!strictStructural||contextBoundRole||semanticFlexibleRole)){const byRole=candidates.filter(el=>roleOf(el,root)===wantedRole);if(!byRole.length)continue;candidates=byRole;}if(classes.size&&candidates.length>1){const byClass=candidates.filter(el=>[...classes].some(c=>el.classList?.contains(c)));if(byClass.length)candidates=byClass;}if(candidates.length>1){const visible=candidates.filter(el=>{try{const st=getComputedStyle(el),b=el.getBoundingClientRect();return st.display!=='none'&&st.visibility!=='hidden'&&Number(st.opacity||1)>0&&b.width>0&&b.height>0;}catch{return true;}});if(visible.length===1)candidates=visible;else{const pool=visible.length?visible:candidates;const values=new Set(pool.map(el=>String(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim()));if(values.size===1)candidates=[pool[0]];}}if(candidates.length!==1)continue;const el=candidates[0];let score=1200-i*35;if(expected)score+=signature(el,root)===expected?500:-420;if(tag&&el.tagName?.toLowerCase()===tag)score+=120;if(classes.size)score+=Math.min(240,[...classes].filter(c=>el.classList?.contains(c)).length*80);if(sel.startsWith(':scope > '))score+=90;if(!best||score>best.score)best={el,score};}if(!best&&wantedRole){let semantic=[];try{semantic=[...root.querySelectorAll('*')].filter(el=>roleOf(el,root)===wantedRole);}catch{}if(semantic.length===1)best={el:semantic[0],score:900};}return best?.el||null;};
    let elements=[];
    try {
      if (payload.type==='selector' && payload.selector) elements=[...document.querySelectorAll(payload.selector)];
      if (payload.type==='relative' && payload.rootSelector && payload.fieldSelector) {
        for (const root of document.querySelectorAll(payload.rootSelector)) {
          const el=resolve(root,{fieldSelector:payload.fieldSelector,fieldSelectors:payload.fieldSelectors||[],expectedSignature:payload.expectedSignature||'',targetMeta:payload.targetMeta||{}});if(el)elements.push(el);
        }
      }
    } catch { return 0; }
    const color=payload.color||'#21c77a';const saved=[];
    for (const el of elements.slice(0,300)) {saved.push({el,outline:el.style.outline,outlineOffset:el.style.outlineOffset,boxShadow:el.style.boxShadow,hadMarker:el.hasAttribute('data-crawlloom-transient-highlight'),markerValue:el.getAttribute('data-crawlloom-transient-highlight')});el.setAttribute('data-crawlloom-transient-highlight','');el.style.outline=`3px solid ${color}`;el.style.outlineOffset='-2px';el.style.boxShadow=`0 0 0 2px ${color}22`;}
    window[KEY]=saved;return saved.length;
  }

  function projectMarkersRuntime(payload) {
    const KEY='__crawlLoomProjectMarkersV15';
    const revision=Number(payload?.revision||0);
    const latest=Number(window.__crawlLoomLatestMarkerRevision||0);
    if(revision && revision<latest) return {roots:0,fields:0,stale:true};
    if(revision) window.__crawlLoomLatestMarkerRevision=revision;

    // Important ordering: project markers may have been created while a transient
    // selection highlight was active in older versions. Remove project markers first,
    // then restore direct-highlight styles so cleanup reaches the true page style.
    for(const key of ['__crawlLoomProjectMarkersV15','__crawlLoomProjectMarkersV14','__crawlLoomProjectMarkersV13']){
      const old=window[key]; if(old?.cleanup){try{old.cleanup();}catch{}}
    }
    for(const key of ['__crawlLoomDirectHighlightsV15','__crawlLoomDirectHighlightsV14','__crawlLoomDirectHighlightsV13']){
      const saved=window[key]||[];
      for(const x of saved){try{x.el.style.outline=x.outline;x.el.style.outlineOffset=x.outlineOffset;x.el.style.boxShadow=x.boxShadow;if(x.hadMarker)x.el.setAttribute('data-crawlloom-transient-highlight',x.markerValue||'');else x.el.removeAttribute('data-crawlloom-transient-highlight');}catch{}}
      window[key]=[];
    }
    for(const badge of document.querySelectorAll('[data-crawlloom-marker]')){try{badge.remove();}catch{}}
    const state={styled:[],badges:[],listeners:[]};
    const cleanup=()=>{
      for(const item of state.styled){try{item.el.style.outline=item.outline;item.el.style.outlineOffset=item.outlineOffset;item.el.style.boxShadow=item.boxShadow;}catch{}}
      for(const badge of state.badges){try{badge.remove();}catch{}}
      for(const [name,fn] of state.listeners){try{window.removeEventListener(name,fn,true);}catch{}}
      state.styled=[];state.badges=[];state.listeners=[];
      if(window[KEY]?.cleanup===cleanup) delete window[KEY];
    };
    window[KEY]={cleanup};
    if(!payload||payload.type==='clear'||!payload.rootSelector) return {roots:0,fields:0};
    let roots=[];try{roots=[...document.querySelectorAll(payload.rootSelector)];}catch{return {roots:0,fields:0};}
    const getPath=(obj,path)=>!path?obj:String(path).split('.').filter(Boolean).reduce((cur,key)=>cur==null?null:cur[key],obj);
    const parseJson=raw=>{try{return raw==null?null:JSON.parse(raw);}catch{return null;}};
    const identity=payload.itemIdentity||null,keyAttr=payload.itemKeyAttribute||'';
    const rootKey=root=>{if(keyAttr)return root.getAttribute(keyAttr);if(!identity)return null;if(identity.mode==='containerAttribute')return root.getAttribute(identity.attribute||'');if(identity.mode==='containerJsonAttribute')return getPath(parseJson(root.getAttribute(identity.attribute||'')),identity.jsonPath||'');return null;};
    const rootScore=r=>{if(!r||!r.isConnected)return-100000;let score=0;try{let n=r,hidden=false;for(let d=0;n&&n.nodeType===1&&d<18;d++,n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity||1)===0){hidden=true;break;}if(n.getAttribute?.('aria-hidden')==='true')score-=2200;}score+=hidden?-12000:1000;const b=r.getBoundingClientRect();if(b.width>1&&b.height>1){score+=700;if(b.bottom>0&&b.right>0&&b.top<innerHeight&&b.left<innerWidth)score+=650;}else score-=1800;score+=Math.min(220,String(r.innerText||r.textContent||'').trim().length*.05);}catch{}return score;};
    if(identity||keyAttr){const groups=new Map(),loose=[];roots.forEach((root,index)=>{const key=rootKey(root);if(key==null||String(key)===''){loose.push({index,root});return;}const k=String(key);if(!groups.has(k))groups.set(k,{index,list:[]});groups.get(k).list.push(root);});const chosen=[...loose];for(const g of groups.values()){const root=g.list.sort((a,b)=>rootScore(b)-rootScore(a))[0];if(root)chosen.push({index:g.index,root});}chosen.sort((a,b)=>a.index-b.index);roots=chosen.map(x=>x.root);}
    const visible=el=>{try{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)!==0;}catch{return false;}};
    const styleEl=(el,color,width='2px')=>{if(!el||state.styled.some(x=>x.el===el))return;state.styled.push({el,outline:el.style.outline,outlineOffset:el.style.outlineOffset,boxShadow:el.style.boxShadow});el.style.outline=`${width} solid ${color}`;el.style.outlineOffset='-2px';el.style.boxShadow=`inset 0 0 0 1px ${color}20`;};
    const badge=(el,label,color,offset=0)=>{
      if(!el||state.badges.length>=90)return;
      const b=document.createElement('div');b.textContent=label;b.setAttribute('data-crawlloom-marker','');
      Object.assign(b.style,{position:'fixed',zIndex:'2147483600',pointerEvents:'none',padding:'2px 6px',borderRadius:'999px',font:'600 10px/1.35 system-ui,sans-serif',color:'#fff',background:color,boxShadow:'0 2px 8px rgba(0,0,0,.28)',maxWidth:'190px',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'});
      document.documentElement.appendChild(b);state.badges.push(b);
      const update=()=>{try{const r=el.getBoundingClientRect();const on=r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth;b.style.display=on?'block':'none';if(on){b.style.left=Math.max(2,Math.min(innerWidth-b.offsetWidth-2,r.left+4))+'px';b.style.top=Math.max(2,r.top+4+offset)+'px';}}catch{b.style.display='none';}};update();b.__update=update;
    };
    const updateBadges=()=>state.badges.forEach(b=>b.__update?.());
    for(const root of roots){if(visible(root))styleEl(root,'#20b875','2px');}
    const firstVisibleRoot=roots.find(visible);if(firstVisibleRoot)badge(firstVisibleRoot,'RECORD ✓','#16855c',0);
    const marker=(el,limit)=>{let cur=el;for(let depth=0;cur&&cur!==limit&&depth<4;depth++,cur=cur.parentElement){for(const node of [cur,...cur.querySelectorAll(':scope > i, :scope > svg, :scope > [data-testid], :scope > [data-info-type], :scope > [data-element-name]')]){if(!node)continue;for(const a of ['data-testid','data-info-type','data-element-name','data-selenium','aria-label']){const v=node.getAttribute?.(a);if(v&&/(language|country|room|business|travell|guest|calendar|date|message|review|rating|score|author|user|name)/i.test(v))return a+'='+v;}for(const c of [...(node.classList||[])])if(/^(?:ic_languages|ic_roomline|ic_business2)$/i.test(c)||/(?:calendar|message|language|country|roomline|business2|travell|rating|score)/i.test(c))return 'class='+c;}}return '';};
    const signature=(el,root)=>{if(!el)return '';for(const a of ['data-testid','data-info-type','data-element-name','data-selenium','aria-label']){const v=el.getAttribute?.(a);if(v)return a+'='+v;}return marker(el.parentElement||el,root);};
    const roleOf=(el,root)=>{
      if(!el)return'';
      const txt=String(el.innerText||el.textContent||'').trim().replace(/\s+/g,' ');
      const classTokens=Array.from(el.classList||[],value=>String(value).toLowerCase());
      const hasClass=pattern=>classTokens.some(value=>pattern.test(value));
      const sig=signature(el,root).toLowerCase();
      const testid=String(el.getAttribute?.('data-testid')||'').toLowerCase();
      const infoCarrier=el.closest?.('[data-info-type]');
      const infoType=String(infoCarrier?.getAttribute?.('data-info-type')||'').toLowerCase();
      if(/\b(?:member\s+tingkat|member\s+level|membership\s+level|loyalty\s+(?:level|status)|tier|badge)\b/i.test(txt)&&txt.length<=120)return'';
      if(testid==='review-title')return'review_title';
      if(testid==='review-comment'||testid==='review-text')return'review_text';
      if(testid==='product-name')return'product_name';
      if(testid==='price')return'price';
      if(testid==='description')return'description';
      if(testid==='stock')return'stock';
      if(testid==='rating')return'rating_score';
      if(infoType==='reviewer-name'){if(el.closest?.('strong'))return'reviewer_name';if(String(el.tagName||'').toLowerCase()==='span')return'reviewer_country';return'reviewer_name';}
      if(infoType==='group-name')return'traveler_type';
      if(infoType==='room-type')return'room_type';
      if(infoType==='stay-detail')return'stay_detail';
      if(el.closest?.('.Review-statusBar-left')&&/^diulas\s+pada\b/i.test(txt))return'review_date';
      const agodaLeft=el.closest?.('.Review-comment-left');
      const agodaGroup=agodaLeft&&el.closest?.('.Review-comment-score, p');
      if(agodaGroup&&agodaLeft.contains(agodaGroup)){
        const spans=[...agodaGroup.children].filter(node=>String(node.tagName||'').toLowerCase()==='span');
        const carrier=spans.find(node=>node===el||node.contains(el));
        if(spans[0]===carrier)return'rating_score';
        if(spans[1]===carrier)return'rating_label';
      }
      if(/ic_languages|language|country/.test(sig))return'reviewer_country';
      if(/ic_roomline|roomline/.test(sig))return'room_type';
      if(/ic_business2|business2|travell/.test(sig))return'traveler_type';
      if(hasClass(/traveler[_-]?type|traveller[_-]?type|trip[_-]?type/))return'traveler_type';
      if(/calendar/.test(sig))return'stay_detail';
      if(/message/.test(sig)||/^\d+\s+(?:ulasan|reviews?|comments?|komentar)$/i.test(txt))return'review_count';
      if(hasClass(/reviewitem-username|review.*(?:user|guest|customer).*name|reviewer.*name|author.*name|customer[_-]?name/)||el.closest?.('cite'))return'reviewer_name';
      if(hasClass(/userreviewtime|review.*(?:date|time)|reviewcard.*date/)||/^\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}$/i.test(txt)||/^(?:reviewed|posted|diulas|ditulis|dikirim)\s+(?:(?:a|an|one|satu|\d+)\s+)?(?:minute(?:\(s\)|s)?|hour(?:\(s\)|s)?|day(?:\(s\)|s)?|week(?:\(s\)|s)?|month(?:\(s\)|s)?|year(?:\(s\)|s)?|menit|jam|hari|minggu|pekan|bulan|tahun)\s+(?:ago|lalu)$/i.test(txt)||/^diulas\s+pada\s+\d{1,2}\s+(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)\s+\d{4}$/i.test(txt)||/^(?:(?:reviewed|posted)\s+(?:on\s+)?)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4}$/i.test(txt))return'review_date';
      const ptxt=String(el.parentElement?.innerText||el.parentElement?.textContent||'').trim().replace(/\s+/g,' ');
      if(/^\/\s*(?:5|10)(?:[.,]0+)?$/.test(txt))return'rating_max';
      if(hasClass(/rating.*label|scorelabel|commentlevel/))return'rating_label';
      if(hasClass(/rating.*score|score.*rating|review[_-]?card[_-]?user[_-]?review/)||(el.getAttribute?.('data-testid')||'').toLowerCase()==='tvat-ratingscore'||(/^\d+(?:[.,]\d+)?$/.test(txt)&&/^\d+(?:[.,]\d+)?\s*\/\s*(?:5|10)$/.test(ptxt)))return'rating_score';
      if(hasClass(/reviewitem-content|review[-_].*(?:content|text|copy|body)|comment[-_].*(?:content|text|body)|review[_-]?card[_-]?comment|readmorecomments.*comment|reviewcopy|review-copy/))return'review_text';
      if(hasClass(/product[-_]?name|product[-_]?title|item[-_]?name/))return'product_name';
      if(hasClass(/(?:^|[-_])price(?:$|[-_])|product[-_]?price/))return'price';
      if(hasClass(/(?:^|[-_])description(?:$|[-_])|product[-_]?description/))return'description';
      if(hasClass(/(?:^|[-_])stock(?:$|[-_])|availability/))return'stock';
      if(String(el.tagName||'').toLowerCase()==='a'&&hasClass(/detail[-_]?link|product[-_]?link/))return'url';
      const metadataAggregate=/\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|desember)\s+\d{4}\s*(?:[•·|–—-]\s*)?\d+(?:[.,]\d+)?\s*\/\s*(?:5|10)(?:[.,]0+)?\s*$/i.test(txt)&&(/\b(?:perjalanan\s+bisnis|business\s+trip|pasangan|couple|keluarga|family|solo|sendiri|teman|friends?|rombongan|group|liburan|leisure)\b/i.test(txt)||(!/[.!?](?:\s|$)/.test(txt)&&txt.length<=180));
      if(metadataAggregate)return'';
      const textBlocks=[...el.children].filter(child=>String(child.innerText||child.textContent||'').trim().replace(/\s+/g,' ').length>=20).length;
      if(txt.length>=55&&txt.length<=5000&&textBlocks<=6)return'review_text';
      return'';
    };
    const resolve=(root,field)=>{const selectors=[...new Set([field.selector,...(field.selectors||[])].filter(Boolean))];const expected=field.expectedSignature||'';const tag=String(field.targetTag||'').toLowerCase();const classes=new Set((field.targetClasses||[]).map(String));const wantedRole=String(field.semanticRole||'');let best=null;for(let i=0;i<selectors.length;i++){const sel=selectors[i];let list=[];try{list=sel===':scope'?[root]:[...root.querySelectorAll(sel)];}catch{continue;}if(!list.length)continue;let candidates=list;if(tag){const byTag=candidates.filter(el=>el.tagName?.toLowerCase()===tag);if(byTag.length)candidates=byTag;}const strictStructural=/^:scope\s*>\s*[a-z][a-z0-9-]*(?::(?:nth-of-type\(\d+\)|last-of-type))?(?:\s*>\s*[a-z][a-z0-9-]*(?::(?:nth-of-type\(\d+\)|last-of-type))?)*$/i.test(sel);const contextBoundRole=/^(?:reviewer_country|room_type|traveler_type|stay_detail)$/.test(wantedRole)||(wantedRole==='review_text'&&/(?:^|\.)(?:tiket|trip)\.com$/i.test(location.hostname));const semanticFlexibleRole=wantedRole==='review_date';if(expected){const bySig=candidates.filter(el=>signature(el,root)===expected);if(bySig.length)candidates=bySig;else if(semanticFlexibleRole){const byRole=candidates.filter(el=>roleOf(el,root)===wantedRole);if(!byRole.length)continue;candidates=byRole;}else if(!strictStructural||contextBoundRole)continue;}if(wantedRole&&(!strictStructural||contextBoundRole||semanticFlexibleRole)){const byRole=candidates.filter(el=>roleOf(el,root)===wantedRole);if(!byRole.length)continue;candidates=byRole;}if(classes.size&&candidates.length>1){const byClass=candidates.filter(el=>[...classes].some(c=>el.classList?.contains(c)));if(byClass.length)candidates=byClass;}if(candidates.length>1){const visible=candidates.filter(el=>{try{const st=getComputedStyle(el),b=el.getBoundingClientRect();return st.display!=='none'&&st.visibility!=='hidden'&&Number(st.opacity||1)>0&&b.width>0&&b.height>0;}catch{return true;}});if(visible.length===1)candidates=visible;else{const pool=visible.length?visible:candidates;const values=new Set(pool.map(el=>String(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim()));if(values.size===1)candidates=[pool[0]];}}if(candidates.length!==1)continue;const el=candidates[0];let score=1200-i*35;if(expected)score+=signature(el,root)===expected?500:-420;if(tag&&el.tagName?.toLowerCase()===tag)score+=120;if(classes.size)score+=Math.min(240,[...classes].filter(c=>el.classList?.contains(c)).length*80);if(sel.startsWith(':scope > '))score+=90;if(!best||score>best.score)best={el,score};}if(!best&&wantedRole){let semantic=[];try{semantic=[...root.querySelectorAll('*')].filter(el=>roleOf(el,root)===wantedRole);}catch{}if(semantic.length===1)best={el:semantic[0],score:900};}return best?.el||null;};
    let fieldHits=0;
    const fields=Array.isArray(payload.fields)?payload.fields:[];
    fields.forEach((field,index)=>{
      const label=`${index+1} · ${field.name||'field'} ✓`;let badged=0;
      for(const root of roots){const el=resolve(root,field);if(!el)continue;fieldHits++;styleEl(el,'#755cff','2px');if(visible(el)&&badged<2){badge(el,label,'#6547e8',18+index*0);badged++;}}
    });
    window.addEventListener('scroll',updateBadges,true);window.addEventListener('resize',updateBadges,true);state.listeners.push(['scroll',updateBadges],['resize',updateBadges]);
    return {roots:roots.length,fields:fieldHits};
  }

  function clearVisualsRuntime(config) {
    const revision=Number(config?.revision||0);
    const transientRevision=Number(config?.transientRevision||0);
    if(transientRevision) window.__crawlLoomLatestTransientRevision=Math.max(Number(window.__crawlLoomLatestTransientRevision||0),transientRevision);
    if(revision) window.__crawlLoomLatestMarkerRevision=Math.max(Number(window.__crawlLoomLatestMarkerRevision||0),revision);
    // Project layer first, then transient/direct layer. This order prevents an old
    // project cleanup from restoring a blue selector outline after the direct layer
    // has already been cleared.
    for(const key of ['__crawlLoomProjectMarkersV15','__crawlLoomProjectMarkersV14','__crawlLoomProjectMarkersV13']){
      const state=window[key];if(state?.cleanup){try{state.cleanup();}catch{}}
      try{delete window[key];}catch{window[key]=null;}
    }
    for(const key of ['__crawlLoomDirectHighlightsV15','__crawlLoomDirectHighlightsV14','__crawlLoomDirectHighlightsV13']){
      const saved=window[key]||[];
      for(const x of saved){try{x.el.style.outline=x.outline;x.el.style.outlineOffset=x.outlineOffset;x.el.style.boxShadow=x.boxShadow;if(x.hadMarker)x.el.setAttribute('data-crawlloom-transient-highlight',x.markerValue||'');else x.el.removeAttribute('data-crawlloom-transient-highlight');}catch{}}
      try{delete window[key];}catch{window[key]=[];}
    }
    for(const key of ['__crawlLoomOverlayPickerV18','__crawlLoomOverlayPickerV17','__crawlLoomOverlayPickerV16','__crawlLoomOverlayPickerV15','__crawlLoomOverlayPickerV14','__crawlLoomOverlayPickerV11','__crawlStudioOverlayPickerV8','__crawlStudioOverlayPickerV6']){
      const picker=window[key];if(picker?.cleanup){try{picker.cleanup('reset');}catch{}}
      try{delete window[key];}catch{window[key]=null;}
    }
    for(const badge of document.querySelectorAll('[data-crawlloom-marker]')){try{badge.remove();}catch{}}
    for(const el of document.querySelectorAll('[data-crawlloom-picker-hover],[data-crawlloom-transient-highlight]')){try{el.removeAttribute('data-crawlloom-picker-hover');el.removeAttribute('data-crawlloom-transient-highlight');}catch{}}
    const overlay=document.querySelector('#__crawlstudio_picker_overlay__');if(overlay){try{overlay.remove();}catch{}}
    document.documentElement.style.cursor='';
    return true;
  }

  const api={
    buildPickScript(target,itemSelector){ return `(${pickerRuntime.toString()})(${JSON.stringify({target,itemSelector:itemSelector||''})})`; },
    buildCancelScript(){ return `(${cancelRuntime.toString()})()`; },
    buildHighlightScript(payload){ return `(${highlightRuntime.toString()})(${JSON.stringify(payload)})`; },
    buildProjectMarkersScript(payload){ return `(${projectMarkersRuntime.toString()})(${JSON.stringify(payload)})`; },
    buildClearVisualsScript(config){ return `(${clearVisualsRuntime.toString()})(${JSON.stringify(config||{})})`; }
  };
  root.CrawlPagePicker=api;
})(typeof globalThis!=='undefined'?globalThis:this);
