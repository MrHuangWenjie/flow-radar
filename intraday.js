/* Flow Radar · Layer 2 — price/volume observation, NOT net fund flows.
   Default: public, unofficial Yahoo chart endpoint via third-party CORS proxy.
   Optional: official Twelve Data 5-minute time_series with a personal API key.
*/
(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const html = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const numeric = n => typeof n === 'number' && Number.isFinite(n);
  const num = v => v === null || v === undefined || v === '' ? NaN : Number(v);
  const fmtPct = n => numeric(n) ? (n > 0 ? '+' : '') + n.toFixed(2) + '%' : '—';
  const fmtRatio = n => numeric(n) ? n.toFixed(2) + '×' : '—';
  const fmtMoney = n => !numeric(n) ? '—' : '$' + (Math.abs(n) >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.abs(n) >= 1e3 ? (n / 1e3).toFixed(0) + 'K' : Math.round(n));
  const fmtVol = n => !numeric(n) ? '—' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n));
  const colors = n => !numeric(n) ? 'neutral' : n > 0 ? 'pos' : n < 0 ? 'neg' : 'neutral';
  const names = {SPY:'标普500',QQQ:'纳指100',IWM:'罗素2000',SMH:'半导体',XLK:'信息技术',XLF:'金融',XLE:'能源',XLI:'工业',XLV:'医疗',XLU:'公用事业',XLY:'可选消费',XLP:'必需消费',XLB:'原材料',XLC:'通信服务',TLT:'长期美债',HYG:'高收益债'};
  const defaultSymbols = 'SPY, QQQ, SMH, XLK, XLF, XLE, XLV, XLU';
  const wallFormatter = new Intl.DateTimeFormat('en-US', {timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false, hourCycle:'h23'});
  const state = {layer:'daily', provider:'proxy', rows:[], failures:[], loading:false, loadedOnce:false, lastAttempt:0, lastSuccess:0, lastProvider:'', requestToken:0, auto:false};

  function nyParts(date) {
    const p = Object.fromEntries(wallFormatter.formatToParts(date).filter(v=>v.type!=='literal').map(v=>[v.type,v.value]));
    const h = Number(p.hour) % 24, m = Number(p.minute);
    return {day:`${p.year}-${p.month}-${p.day}`, hm:`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`, clock:h*60+m};
  }
  function nyOpen() {
    const d = new Date(), dow = new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',weekday:'short'}).format(d);
    const t = nyParts(d);
    return !['Sat','Sun'].includes(dow) && t.clock >= 570 && t.clock < 960;
    // Holidays are NOT inferred. Data timestamp determines whether a market actually updated.
  }
  function validSymbols(raw, provider) {
    const unique = [...new Set(raw.toUpperCase().split(/[\s,，;]+/).map(x=>x.trim()).filter(x=>/^[A-Z][A-Z0-9.-]{0,9}$/.test(x)))];
    return unique.slice(0, provider==='twelve'?8:12);
  }
  function yahooToBars(obj) {
    const root = obj?.chart;
    if(root?.error) throw new Error(root.error.description || 'Yahoo 返回异常');
    const res = root?.result?.[0];
    if (!res) throw new Error('Yahoo 返回空行情');
    const candles = res.indicators?.quote?.[0];
    if (!candles || !Array.isArray(res.timestamp)) throw new Error('Yahoo 缺少5分钟K线');
    const bars = res.timestamp.map((sec,i) => {
      const p = nyParts(new Date(sec*1000));
      return {day:p.day, hm:p.hm, clock:p.clock, close:num(candles.close?.[i]), volume:num(candles.volume?.[i])};
    });
    return {bars, source:'Yahoo Finance（非官方）'};
  }
  function twelveToBars(obj) {
    if (obj?.status==='error' || obj?.code) throw new Error(obj?.message || 'Twelve Data 返回错误');
    if (!Array.isArray(obj?.values)) throw new Error('Twelve Data 缺少5分钟K线');
    const bars = obj.values.map(v => {
      const stamp = String(v.datetime || ''), hm = stamp.slice(11,16), h = +hm.slice(0,2), m = +hm.slice(3,5);
      return {day:stamp.slice(0,10), hm, clock:h*60+m, close:num(v.close), volume:num(v.volume)};
    });
    return {bars, source:'Twelve Data'};
  }
  function calcMetrics(sym, input) {
    const grouped = new Map();
    input.bars.forEach(b => {
      if (!b.day || !numeric(b.close) || b.close <= 0 || !numeric(b.volume) || b.volume < 0) return;
      if (b.clock < 570 || b.clock >= 960) return; // Regular NYSE session only
      if (!grouped.has(b.day)) grouped.set(b.day, new Map());
      grouped.get(b.day).set(b.clock,b); // last version of a duplicate bar wins
    });
    const days = [...grouped.keys()].sort();
    if (days.length < 2) throw new Error('可用的常规时段数据不足两天');
    const day = days.at(-1), previous = days.at(-2);
    const today = [...grouped.get(day).values()].sort((a,b)=>a.clock-b.clock);
    const prior = [...grouped.get(previous).values()].sort((a,b)=>a.clock-b.clock);
    if (!today.length || !prior.length) throw new Error('无法解析前收盘');
    const last = today.at(-1), lastPrev = prior.at(-1);
    const price = last.close;
    const changePct = (price / lastPrev.close - 1)*100;
    const volume = today.reduce((n,b)=>n+b.volume,0);
    // Dollar turnover is an estimate from 5-min bar closes, NOT signed capital flow.
    const turnover = today.reduce((n,b)=>n+b.volume*b.close,0);
    const samples=[];
    for (const d of days.slice(0,-1).reverse().slice(0,10)) {
      const bs=[...grouped.get(d).values()];
      const thru=bs.filter(b=>b.clock<=last.clock);
      const historicalCount = thru.length;
      if (historicalCount >= today.length*0.75 && historicalCount >= Math.min(10,today.length)) {
        samples.push(thru.reduce((n,b)=>n+b.volume,0));
      }
    }
    const average = samples.length>=3 ? samples.reduce((a,b)=>a+b,0)/samples.length : NaN;
    const rvol = average>0 ? volume/average : NaN;
    const isLoud = numeric(rvol) && rvol>=1.5;
    const signal = isLoud ? (changePct>0.05?'放量上涨':changePct< -0.05?'放量下跌':'放量横盘') : numeric(rvol) && rvol<0.7?'低活跃':numeric(rvol)?'常规':'样本不足';
    return {sym,name:names[sym]||'自选',day,hm:last.hm,price,changePct,volume,turnover,rvol,samples:samples.length,signal,source:input.source||'未知'};
  }
  async function timedJson(url,timeout=15000){
    const ctrl=new AbortController(), tid=setTimeout(()=>ctrl.abort(),timeout);
    try {
      const res=await fetch(url,{signal:ctrl.signal,credentials:'omit',cache:'no-store'});
      if(!res.ok)throw new Error('HTTP '+res.status);
      return await res.json();
    } finally {clearTimeout(tid);}
  }
  async function requestTicker(sym,provider,force){
    const key='fr_live_v2_'+provider+'_'+sym;
    let backup=null;
    try {backup=JSON.parse(localStorage.getItem(key)||'null');} catch{}
    if(!force && backup && Date.now()-backup.savedAt < 4*60*1000) return {...backup.metric, cacheState:'4分钟内缓存'};
    try {
      let value;
      if(provider==='twelve'){
        const token=byId('twelveKey').value.trim();
        if(!token)throw new Error('请填写 Twelve Data API Key');
        const url = 'https://api.twelvedata.com/time_series?'+new URLSearchParams({symbol:sym,interval:'5min',outputsize:'1200',timezone:'America/New_York',apikey:token});
        value=twelveToBars(await timedJson(url));
      } else {
        const url='https://query1.finance.yahoo.com/v8/finance/chart/'+encodeURIComponent(sym)+'?range=1mo&interval=5m&includePrePost=false';
        value=yahooToBars(await timedJson('https://proxy.cors.dev/'+url));
      }
      const metric=calcMetrics(sym,value);
      try{localStorage.setItem(key,JSON.stringify({savedAt:Date.now(),metric}));}catch{}
      return {...metric,cacheState:''};
    }catch(error){
      if(backup?.metric){return {...backup.metric,cacheState:'过期缓存',failedNow:error.message};}
      throw error;
    }
  }
  async function poolMap(items,fn,limit){
    const result = new Array(items.length); let next=0;
    const pool=Array.from({length:Math.min(limit,items.length)},async()=>{
      while(next<items.length){const i=next++;try{result[i]={ok:true,data:await fn(items[i])};}catch(e){result[i]={ok:false,error:e};}}
    });
    await Promise.all(pool);return result;
  }
  function setLayer(layer){
    state.layer=layer==='intraday'?'intraday':'daily';
    localStorage.setItem('flow_layer',state.layer);
    byId('dailyShell').hidden=state.layer!=='daily';
    byId('intradayShell').hidden=state.layer!=='intraday';
    byId('dailyTopMeta').hidden=state.layer!=='daily';
    byId('intradayTopMeta').hidden=state.layer!=='intraday';
    byId('bannerDaily').hidden=state.layer!=='daily';
    byId('bannerIntraday').hidden=state.layer!=='intraday';
    document.querySelectorAll('[data-layer]').forEach(b=>{
      const yes=b.dataset.layer===state.layer;
      b.classList.toggle('active',yes);b.setAttribute('aria-pressed',String(yes));
    });
    byId('sourceOpen').textContent=state.layer==='intraday'?'查看行情来源':'查看申赎来源';
    byId('bottomStatus').textContent=state.layer==='intraday'?'盘中量价 · 非净资金流':'ETF 净申赎 · 收盘后更新';
    if(state.layer==='intraday'&&!state.loadedOnce)loadIntraday(false);
  }
  function renderMeta(){
    const time=nyParts(new Date()), now='纽约 '+time.day+' '+time.hm;
    byId('marketHours').textContent=nyOpen()?'美东常规交易时段（需按数据时间戳确认）':'美东常规交易时段之外 / 可能休市';
    byId('nowNY').textContent=now;
    byId('liveSourceInfo').textContent=state.provider==='proxy'?'公开 Yahoo 行情 · 由 cors.dev 代理 · 可能延迟':'Twelve Data API · 需个人密钥 · 可能受额度限制';
  }
  function showProvider(){
    state.provider=byId('marketProvider').value;
    byId('keyPanel').hidden=state.provider!=='twelve';
    byId('providerHelp').textContent=state.provider==='twelve'?'免费基础版一般每分钟 8 credits、每日 800；每只 ETF 一次请求。最多选8只，自动刷新默认关闭。':'免费免注册，但属非官方 Yahoo 接口和第三方跨域代理，随时可能中断。最多选12只，刷新建议间隔≥5分钟。';
    renderMeta();
  }
  function buildRows(){
    const rows=state.rows, n=rows.length;
    const currentDate=rows.map(x=>x.day).sort().at(-1);
    const fresh=rows.filter(r=>r.day===currentDate && r.cacheState!=='过期缓存');
    const exceptional=fresh.filter(r=>numeric(r.rvol)&&r.rvol>=1.5);
    const up=exceptional.filter(r=>r.changePct>0.05).sort((a,b)=>(b.changePct*(b.rvol||1))-(a.changePct*(a.rvol||1)));
    const down=exceptional.filter(r=>r.changePct < -0.05).sort((a,b)=>(a.changePct*(a.rvol||1))-(b.changePct*(b.rvol||1)));
    const ts=rows.length?rows.map(x=>x.day+' '+x.hm).sort().at(-1):'—';
    byId('liveAsOf').textContent=rows.length?'最新有效5分钟 K 线：'+ts+'（纽约时间）':'暂无有效行情';
    byId('marketHeroValue').textContent=n?`${exceptional.length} / ${fresh.length}`:'—';
    byId('marketHeroDetail').textContent=n?'最新交易日且非过期缓存的 ETF 中，有多少只 RVOL ≥ 1.50；有些标的可能缺少基准样本。':'获取数据后显示放量标的数量。';
    byId('marketHeroValue').className='metric '+(exceptional.length?'pos':'neutral');
    byId('upLead').innerHTML=up[0]?`<span class="ticker">${html(up[0].sym)}</span><div class="cardval pos">${fmtPct(up[0].changePct)}</div><div class="cardtiny">${html(up[0].name)} · RVOL ${fmtRatio(up[0].rvol)}</div>`:'<div class="cardval neutral">—</div><div class="cardtiny">无可判定标的</div>';
    byId('downLead').innerHTML=down[0]?`<span class="ticker">${html(down[0].sym)}</span><div class="cardval neg">${fmtPct(down[0].changePct)}</div><div class="cardtiny">${html(down[0].name)} · RVOL ${fmtRatio(down[0].rvol)}</div>`:'<div class="cardval neutral">—</div><div class="cardtiny">无可判定标的</div>';
    byId('loudLead').innerHTML=`<div class="cardval">${exceptional.length} <small>只</small></div><div class="cardtiny">达到同一时段1.5倍 · 有效${fresh.length}只</div>`;
    const sort=byId('marketSort').value;
    const items=[...rows].sort((a,b)=> (a.day===currentDate?0:1)-(b.day===currentDate?0:1) ||
      (sort==='change'?b.changePct-a.changePct:sort==='turnover'?b.turnover-a.turnover:(numeric(b.rvol)?b.rvol:-1)-(numeric(a.rvol)?a.rvol:-1)));
    const mkTag=s=>s==='放量上涨'?'tag tag-up':s==='放量下跌'?'tag tag-down':'tag';
    byId('marketRows').innerHTML=items.length?items.map(r=>`<div class="market-row">
      <div class="market-row-head"><div class="market-name"><span class="ticker">${html(r.sym)}</span><span>${html(r.name)}</span></div><span class="${mkTag(r.signal)}">${html(r.signal)}</span></div>
      <div class="market-numbers"><div><div class="market-caption">当日涨跌</div><b class="${colors(r.changePct)}">${fmtPct(r.changePct)}</b></div><div><div class="market-caption">RVOL · 同时段</div><b>${fmtRatio(r.rvol)}</b></div><div><div class="market-caption">累计成交额估算</div><b>${fmtMoney(r.turnover)}</b></div></div>
      <div class="market-tail">价格 $${r.price.toFixed(2)} · 成交量 ${fmtVol(r.volume)} · ${html(r.day+' '+r.hm)} 美东 · RVOL基准${r.samples}日${r.cacheState?' · '+html(r.cacheState):''}</div>
    </div>`).join(''):'<div class="empty">尚无行情。请选择数据源并点「获取盘中信号」。</div>';
    const stale=rows.filter(x=>x.cacheState==='过期缓存');
    const dates=new Set(rows.map(x=>x.day));
    const emptyRV=rows.filter(x=>!numeric(x.rvol));
    const mixed=dates.size>1?`不同 ETF 最近有效数据日不一致，请勿横向直接比较。`:'';
    const tops=exceptional.filter(x=>x.changePct>.05).map(x=>x.sym);
    const weak=exceptional.filter(x=>x.changePct<-.05).map(x=>x.sym);
    byId('marketTakeaway').innerHTML=items.length?`${tops.length?'放量上涨：'+html(tops.join('、'))+'。':'没有观察到明确的放量上涨标的。'} ${weak.length?'放量下跌：'+html(weak.join('、'))+'。':'没有观察到明确的放量下跌标的。'}<br><span class="small">样本不足：${emptyRV.length}只；缓存已过期：${stale.length}只。${html(mixed)} 信号不区分主动买卖方，不提供全市场资金净流入结论。</span>`:'暂无足够数据判断盘中资金活跃程度。';
    const failed=state.failures;
    const notices=[];
    if(failed.length)notices.push('获取失败：'+failed.map(x=>x.sym+' ('+x.error+')').join('；'));
    if(stale.length)notices.push('部分显示的是过期缓存，未计入最新活跃统计。');
    byId('marketErrors').innerHTML=notices.length?'<div class="error">'+html(notices.join(' '))+'</div>':'';
    if(state.layer==='intraday')byId('bottomStatus').textContent=`行情 ${rows.length}只 · ${ts} 美东`;
  }
  async function loadIntraday(force=false){
    if(state.loading)return;
    showProvider();
    const provider=state.provider;
    const syms=validSymbols(byId('marketSymbols').value,provider);
    if(!syms.length){byId('marketErrors').innerHTML='<div class="error">请填写至少一个合法 ETF 代码。</div>';return;}
    const requested=byId('marketSymbols').value.toUpperCase().split(/[\s,，;]+/).filter(Boolean);
    byId('marketSymbols').value=syms.join(', ');
    localStorage.setItem('flow_intraday_symbols',syms.join(', '));
    localStorage.setItem('flow_market_provider',provider);
    if(provider==='twelve'){
      const key=byId('twelveKey').value.trim();
      if(!key){byId('marketErrors').innerHTML='<div class="error">请先输入 Twelve Data API Key。无需上传文件或登录本工具。</div>';return;}
      if(byId('saveKey').checked){try{localStorage.setItem('flow_twelve_key',key);}catch{}}
      else localStorage.removeItem('flow_twelve_key');
    }
    state.loading=true;state.lastAttempt=Date.now();state.loadedOnce=true;
    byId('marketLoad').disabled=true;byId('marketLoad').textContent='⟳ 正在读取';
    byId('liveLoadStatus').textContent=`获取 ${syms.length} 只 ETF 的5分钟K线中…`;
    if(requested.length>syms.length)byId('liveLoadStatus').textContent+=`（当前来源最多${syms.length===8?'8':'12'}只）`;
    const token=++state.requestToken;
    try{
      const results=await poolMap(syms,s=>requestTicker(s,provider,force),provider==='twelve'?2:4);
      if(token!==state.requestToken)return;
      state.rows=results.filter(x=>x.ok).map(x=>x.data);
      state.failures=results.map((x,i)=>x.ok?null:{sym:syms[i],error:x.error.message||'网络异常'}).filter(Boolean);
      if(state.rows.length){state.lastSuccess=Date.now();state.lastProvider=provider;}
      byId('liveLoadStatus').textContent=`本次读取 ${state.rows.length}/${syms.length} 只成功 · ${new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}（设备时间）${state.failures.length?' · 有失败项':''}`;
      buildRows();
      document.dispatchEvent(new CustomEvent('flowradar:intraday',{detail:{rows:state.rows.map(r=>({...r})),failures:state.failures.slice(),provider}}));
    }finally{
      state.loading=false;byId('marketLoad').disabled=false;byId('marketLoad').textContent='获取盘中信号';
    }
  }
  function boot(){
    byId('marketSymbols').value=localStorage.getItem('flow_intraday_symbols')||defaultSymbols;
    byId('marketProvider').value=localStorage.getItem('flow_market_provider')||'proxy';
    byId('twelveKey').value=localStorage.getItem('flow_twelve_key')||'';
    byId('saveKey').checked=!!localStorage.getItem('flow_twelve_key');
    byId('marketProvider').addEventListener('change',()=>{showProvider();state.rows=[];state.loadedOnce=false;buildRows();document.dispatchEvent(new CustomEvent('flowradar:intraday',{detail:{rows:[],failures:[],provider:state.provider}}));});
    byId('marketLoad').addEventListener('click',()=>loadIntraday(true));
    byId('marketSort').addEventListener('change',buildRows);
    byId('marketAuto').addEventListener('change',()=>{state.auto=byId('marketAuto').checked;byId('autoHint').textContent=state.auto?'每5分钟最多刷新一次，仅在网页前台且美东常规开市时':'自动刷新已关闭';});
    byId('saveKey').addEventListener('change',()=>{if(!byId('saveKey').checked)localStorage.removeItem('flow_twelve_key');});
    byId('clearKey').addEventListener('click',()=>{byId('twelveKey').value='';byId('saveKey').checked=false;localStorage.removeItem('flow_twelve_key');byId('liveLoadStatus').textContent='已清除本机保存的密钥';});
    document.querySelectorAll('[data-layer]').forEach(b=>b.addEventListener('click',()=>setLayer(b.dataset.layer)));
    const refresh=byId('refresh');
    refresh.addEventListener('click', e=>{if(state.layer!=='intraday')return; e.stopImmediatePropagation();loadIntraday(true);},true);
    byId('sourceOpen').addEventListener('click', e=>{if(state.layer!=='intraday')return;e.stopImmediatePropagation();window.open(state.provider==='twelve'?'https://twelvedata.com/docs':'https://finance.yahoo.com/','_blank','noopener');},true);
    setInterval(()=>{renderMeta();if(state.auto&&state.layer==='intraday'&&document.visibilityState==='visible'&&nyOpen()&&!state.loading&&Date.now()-state.lastAttempt>=5*60*1000)loadIntraday(true);},30000);
    renderMeta();showProvider();setLayer(localStorage.getItem('flow_layer')||'daily');
  }
  // Only for transparent, deterministic smoke tests with synthetic data.
  window.FlowRadarMath={calcMetrics,yahooToBars,twelveToBars,nyParts,validSymbols};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();
