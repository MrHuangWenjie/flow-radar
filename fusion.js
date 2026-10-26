/* Flow Radar v3 · Combined ETF creation/redemption versus intraday prices.
   Capital flow signs are NOT derived from trade volume. No prediction or execution.
*/
(() => {
 'use strict';
 const E=id=>document.getElementById(id);
 const h=t=>String(t??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const n=v=>typeof v==='number'&&Number.isFinite(v);
 const value=v=>v===null||v===undefined||v===''?NaN:Number(v);
 const money=v=>!n(v)?'—':(v>0?'+':v<0?'−':'')+'$'+(Math.abs(v)>=1e9?(Math.abs(v)/1e9).toFixed(2)+'B':Math.abs(v)>=1e6?(Math.abs(v)/1e6).toFixed(1)+'M':Math.abs(v)>=1e3?(Math.abs(v)/1e3).toFixed(0)+'K':Math.abs(v).toFixed(0));
 const pct=v=>n(v)?(v>0?'+':'')+v.toFixed(2)+'%':'—';
 const marketSymbols=['SPY','QQQ','SMH','XLK','XLF','XLE','XLV','XLU'];
 const state={rows:[],failures:[],flows:new Map(),inflight:false,lastRun:0};
 const validDate=d=>/^\d{4}-\d{2}-\d{2}$/.test(d||'')&&!Number.isNaN(Date.parse(d+'T12:00:00Z'));
 const diffDays=(a,b)=>Math.round((Date.parse(a+'T12:00:00Z')-Date.parse(b+'T12:00:00Z'))/864e5);
 const clamp=(v,l,u)=>Math.max(l,Math.min(u,v));
 const nyToday=()=>{const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));return parts.year+'-'+parts.month+'-'+parts.day;};
 function findWindow(root,period){
   if(!root||typeof root!=='object')return null;
   for(const bucket of [root,root.windows,root.flow_windows,root.totals,root.summary,root.data,root.periods,root.flows,root.net_flows]){
     if(!bucket||typeof bucket!=='object')continue;
     const win=bucket[period]||bucket[period.toLowerCase()];
     if(n(win))return {flow:win};
     if(win && typeof win==='object'){
       for(const key of ['flow','net_flow','net','netFlow','value'])if(n(win[key]))return {...win,flow:win[key]};
     }
   }
   return null;
 }
 function windowDate(win,root){
   // If a window itself advertises a last day, prefer it to general file as-of.
   const specific=[win?.last_day,win?.last_date,win?.end_date,win?.end,win?.through,win?.to,win?.last].find(validDate);
   const asof=[root?.cite?.as_of,root?.as_of,root?.date].find(validDate);
   return {date:specific||asof||'',verified:!!specific,sourceDate:asof||''};
 }
 function classify(row,flow,period){
   const missing={kind:'unknown',label:'无法判定',score:null,reason:'缺少可比较的申赎或盘中行情',flow:null,date:'',period};
   if(!row || !flow?.data)return {...missing,reason:!row?'尚未成功获取5分钟行情':'ETF 申赎数据不可用'};
   const win=findWindow(flow.data,period);
   if(!win||!n(win.flow))return {...missing,reason:'此 ETF 在该周期没有基金净申赎数值'};
   const date=windowDate(win,flow.data);
   const basis={flow:win.flow,date:date.date,verified:date.verified,period};
   if(flow.fallback)return {...missing,...basis,reason:'使用了离线申赎缓存，需在线更新后才评分'};
   if(!validDate(date.date)||!validDate(row.day))return {...missing,...basis,reason:'缺少可核验的数据日期'};
   const marketAge=diffDays(nyToday(),row.day);
   if(marketAge<0||marketAge>4)return {...missing,...basis,reason:'最近行情距纽约当前日已超过4天，无法作为近期盘中信号评分'};
   const dt=diffDays(row.day,date.date);
   if(dt<0||dt>7)return {...missing,...basis,reason:`两层数据相差${dt}天，超出最多7天的比较窗口`};
   if(row.cacheState==='过期缓存')return {...missing,...basis,reason:'盘中行情是过期缓存，不参与联动评分'};
   if(!n(row.rvol)||row.samples<3)return {...missing,...basis,reason:'RVOL历史同时段样本少于3天'};
   if(!n(row.changePct))return {...missing,...basis,reason:'价格变动数据不完整'};
   if(Math.abs(win.flow)<1)return {...missing,...basis,reason:'净申赎接近零，资金方向不明'};
   if(Math.abs(row.changePct)<0.2)return {...missing,...basis,reason:'价格波动不足±0.20%，暂不视为方向明确'};
   const flowSign=Math.sign(win.flow), priceSign=Math.sign(row.changePct), loud=row.rvol>=1.5;
   if(flowSign!==priceSign){return {...basis,kind:'divergence',label:loud?'放量背离':'方向背离',score:null,reason:flowSign>0?'申赎净流入，但价格下跌'+(loud?'且成交放大':''):'申赎净流出，但价格上涨'+(loud?'且成交放大':'')};}
   // Transparent observation strength, not a calibrated probability or an investment signal.
   const priceStrength=30*clamp(Math.abs(row.changePct)/1.5,0,1);
   const volumeStrength=25*clamp((row.rvol-0.7)/0.8,0,1);
   const score=Math.round(45+priceStrength+volumeStrength);
   return {...basis,kind:'aligned',label:loud?(flowSign>0?'放量正向共振':'放量负向共振'):'方向一致 · 未明显放量',score,reason:flowSign>0?'基金净申赎为正，同时价格上涨':'基金净申赎为负，同时价格下跌'};
 }
 const isScoreable=(row,flow,period)=>classify(row,flow,period);
 async function getJson(url){
   const ctrl=new AbortController(),tid=setTimeout(()=>ctrl.abort(),12000);
   try{const res=await fetch(url,{signal:ctrl.signal,credentials:'omit',cache:'no-store',headers:{Accept:'application/json'}});if(!res.ok)throw new Error('HTTP '+res.status);return await res.json();}
   finally{clearTimeout(tid);}
 }
 async function getFund(sym,force=false){
   const storageKey='fr_fusion_flow_v3_'+sym;
   const cache=()=>{try{return JSON.parse(localStorage.getItem(storageKey)||'null');}catch{return null;}};
   const old=cache();
   if(!force&&old?.data&&Date.now()-old.ts<30*60*1000)return {...old,fallback:false};
   const target='https://etfiq.com/data/flows/funds/'+encodeURIComponent(sym.toLowerCase())+'.json';
   try{
     let data;
     try{data=await getJson(target);}catch{data=await getJson('https://proxy.cors.dev/'+target);}
     const obj={data,ts:Date.now(),fallback:false};
     try{localStorage.setItem(storageKey,JSON.stringify(obj));}catch{}
     return obj;
   }catch(error){return old?.data?{...old,fallback:true,error:error.message}:{data:null,error:error.message};}
 }
 async function concurrency(items,fn,limit=4){
   let idx=0;const output=new Array(items.length);
   await Promise.all(Array.from({length:Math.min(items.length,limit)},async()=>{while(idx<items.length){const k=idx++;try{output[k]=await fn(items[k]);}catch(e){output[k]={data:null,error:e.message};}}}));return output;
 }
 function render(){
   const period=E('fusionPeriod').value,filter=E('fusionFilter').value;
   const entries=state.rows.map(row=>({row,res:isScoreable(row,state.flows.get(row.sym),period)}));
   const align=entries.filter(x=>x.res.kind==='aligned'&&x.row.rvol>=1.5).length;
   const divergence=entries.filter(x=>x.res.kind==='divergence').length;
   const unknown=entries.filter(x=>x.res.kind==='unknown').length;
   E('fusionAligned').textContent=state.lastRun||state.flows.size?String(align):'—';
   E('fusionDiverged').textContent=state.lastRun||state.flows.size?String(divergence):'—';
   E('fusionUnknown').textContent=state.lastRun||state.flows.size?String(unknown+state.failures.length):'—';
   let selected=entries;
   if(filter==='aligned')selected=entries.filter(x=>x.res.kind==='aligned');
   if(filter==='divergence')selected=entries.filter(x=>x.res.kind==='divergence');
   if(filter==='unknown')selected=entries.filter(x=>x.res.kind==='unknown');
   const order={aligned:0,divergence:1,unknown:2};
   selected=[...selected].sort((a,b)=>order[a.res.kind]-order[b.res.kind]||(b.res.score||0)-(a.res.score||0));
   const color=x=>x==='aligned'?'pos':x==='divergence'?'status':'neutral';
   E('fusionRows').innerHTML=selected.length?selected.map(({row,res})=>`<article class="fusion-item"><div class="fusion-itemhead"><div><span class="ticker">${h(row.sym)}</span><span class="small" style="margin-left:6px">${h(row.name||'ETF')}</span></div><div class="fusion-result ${color(res.kind)}">${h(res.label)}</div></div>
     <div class="fusion-values"><div><span>${h(period)} 基金净申赎</span><b class="${res.flow>0?'pos':res.flow<0?'neg':'neutral'}">${money(res.flow)}</b></div><div><span>日内涨跌</span><b class="${row.changePct>0?'pos':row.changePct<0?'neg':'neutral'}">${pct(row.changePct)}</b></div><div><span>RVOL</span><b>${n(row.rvol)?row.rvol.toFixed(2)+'×':'—'}</b></div></div>
     <div class="fusion-date">申赎截至 ${h(res.date||'未知')}${res.date&&!res.verified?'（来源文件日期，非已核验窗口结束日）':''} · 行情 ${h(row.day+' '+row.hm)} 美东 · RVOL基准${h(String(row.samples||0))}日</div>
     <div class="fusion-why">${h(res.reason)}${res.score!==null?' · 证据匹配分 '+res.score+'/100':''}</div></article>`).join(''):'<div class="empty">所选筛选条件下暂无可用结果。</div>';
   const failures=state.failures.map(x=>`${h(x.sym)} 盘中行情获取失败`).join('；');
   E('fusionErrors').innerHTML=failures?'<div class="error">'+failures+'</div>':'';
   if(state.rows.length)E('fusionMeta').textContent=`已比对 ${entries.length} 只 ETF｜申赎 ${period}，量价取最近一个有效行情交易日。${state.lastRun?'最近尝试更新 '+new Date(state.lastRun).toLocaleTimeString('zh-CN')+'。':''} 不同时段的相关性不证明因果。`;
 }
 async function run(force=false){
   if(state.inflight)return;
   if(!state.rows.length){E('fusionErrors').innerHTML='<div class="error">请先点击「获取盘中信号」，确认行情读取成功。</div>';return;}
   state.inflight=true;E('fusionRun').disabled=true;E('fusionRun').textContent='⟳ 申赎数据读取中';
   const symbols=[...new Set(state.rows.map(r=>r.sym))].filter(s=>/^[A-Z][A-Z0-9.-]{0,9}$/.test(s)).slice(0,12);
   E('fusionMeta').textContent='正在读取 '+symbols.length+' 只 ETF 的净申赎历史，分析与最近行情的方向关系…';
   try{
     const outcomes=await concurrency(symbols,s=>getFund(s,force),4);
     state.flows=new Map(symbols.map((s,i)=>[s,outcomes[i]]));state.lastRun=Date.now();render();
     const errors=symbols.filter((s,i)=>!outcomes[i]?.data).map((s)=>s+'：基金数据缺失或请求失败');
     if(errors.length)E('fusionErrors').innerHTML='<div class="error">'+h(errors.join('；'))+'</div>';
   }finally{state.inflight=false;E('fusionRun').disabled=false;E('fusionRun').textContent='更新双层联动';}
 }
 function boot(){
   E('fusionRun').addEventListener('click',()=>run(true));
   E('fusionPeriod').addEventListener('change',render);
   E('fusionFilter').addEventListener('change',render);
   document.addEventListener('flowradar:intraday',ev=>{
     state.rows=ev.detail.rows||[];state.failures=ev.detail.failures||[];
     if(state.flows.size)render();
     else E('fusionMeta').textContent=`已读取 ${state.rows.length} 只 ETF 行情，可以点击「更新双层联动」读取基金净申赎。`;
   });
 }
 window.FlowRadarFusionTest={findWindow,windowDate,classify};
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();
