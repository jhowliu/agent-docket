(() => {
  const root = document.getElementById('agent-workbench-preview');
  const runs = [
    {id:'verify',role:'verify',task:'token-expiry',project:'atlas-api',provider:'Claude',sha:'a9e41c2',profile:'Python',change:'+84 −12',initial:'permission',wait:'2m',command:'python -m pytest tests/auth/test_token_expiry.py -q',question:'Run token expiry boundary tests',events:[['14:08:21','start','Loaded candidate a9e41c2 and Task spec v2'],['14:09:03','read','Read tests/auth/test_token_expiry.py (sample)'],['14:10:21','tool','Preparing tests; execution has not started'],['14:10:21','waiting','This command needs your approval']]},
    {id:'pm',role:'pm',task:'login-scope',project:'atlas-api',provider:'Claude',sha:'—',profile:'PM',change:'—',initial:'question',wait:'5m',question:'Should this login flow include signing out all devices?',choices:['Login and token refresh only','Include signing out all devices'],events:[['14:03:10','start','Organizing login requirements and acceptance criteria (sample)'],['14:04:15','plan','Split session refresh, token expiry and login UI'],['14:07:10','question','Scope needs your decision before Dev starts']]},
    {id:'dev-api',role:'dev',task:'session-refresh',project:'atlas-api',provider:'Codex',sha:'c284fd1',profile:'Python',change:'+126 −28',initial:'running',events:[['14:06:02','start','Started implementation in a separate environment (sample)'],['14:07:24','edit','Updating token refresh in src/auth/session.py'],['14:10:18','edit','Handling duplicate refresh requests'],['14:11:04','working','Adding related tests (simulated)']]},
    {id:'review',role:'review',task:'retry-backoff',project:'task-queue',provider:'Codex',sha:'e62f8b0',profile:'TypeScript',change:'+62 −18',initial:'complete',events:[['14:01:12','start','Reviewing candidate e62f8b0 in a fresh context (sample)'],['14:03:40','read','Tracing retry limits and cancellation paths'],['14:06:21','finding','Review summary prepared (sample)'],['14:07:32','done','Sample review ended; real verification has not run']]},
    {id:'pr',role:'pr',task:'retry-backoff',project:'task-queue',provider:'Claude',sha:'e62f8b0',profile:'TypeScript',change:'+62 −18',initial:'delivery',events:[['14:08:02','start','Preparing delivery for candidate e62f8b0 (sample)'],['14:09:14','report','Preparing the retry flow before / after explanation'],['14:10:05','draft','PR draft prepared (sample, unpublished)']]},
    {id:'dev-ui',role:'dev',task:'timezone-input',project:'habit-log',provider:'Claude',sha:'b17ac93',profile:'TypeScript',change:'+39 −9',initial:'running',events:[['14:05:40','start','Handling timezone input and date boundaries (sample)'],['14:09:10','edit','Updating DateInput and date conversion'],['14:11:02','working','Handling empty values and day boundaries (simulated)']]}
  ];
  const projects = [
    {id:'atlas-api',path:'~/projects/atlas-api'},
    {id:'task-queue',path:'~/projects/task-queue'},
    {id:'habit-log',path:'~/projects/habit-log'}
  ];
  const tabs = ['live','diff','timeline','evidence','services'];
  const storageKey = 'agent-workbench-html-preview-v1';
  const initialState = () => ({selected:'verify',tab:'live',filter:'all',project:'all',serviceLog:'all',previewService:null,decisions:{},extra:{},drafts:{},deliveryOpen:false});
  let state = initialState();
  let appearance = 'dark';
  let simulationEpoch = 0;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (saved && saved.version === 1) { restore(saved); appearance = saved.appearance === 'light' ? 'light' : 'dark'; }
  } catch { /* The preview remains usable when local storage is unavailable. */ }
  const services = window.WorkbenchServiceDemo.create((run,message) => {
    if (message) append(run,'services',message);
    render();
    if (message) feedback(run.project+' / '+run.role+' · '+message);
    persist();
  });
  function restore(value) {
    state.decisions = {};
    state.extra = {};
    if (runs.some(r => r.id === value.selected)) state.selected = value.selected;
    if (tabs.includes(value.tab)) state.tab = value.tab;
    if (['all','attention'].includes(value.filter)) state.filter = value.filter;
    if (value.project === 'all' || projects.some(p => p.id === value.project)) state.project = value.project;
    if (['all','db','api','web'].includes(value.serviceLog)) state.serviceLog = value.serviceLog;
    if (state.project !== 'all' && runs.find(r => r.id === state.selected).project !== state.project) state.project = 'all';
    if (value.decisions && typeof value.decisions === 'object') {
      for (const r of runs) if (['allowed','rejected','answered'].includes(value.decisions[r.id])) state.decisions[r.id] = value.decisions[r.id];
    }
    if (value.extra && typeof value.extra === 'object') {
      for (const r of runs) if (Array.isArray(value.extra[r.id])) state.extra[r.id] = value.extra[r.id].slice(-6).filter(e => Array.isArray(e) && e.length === 3 && e.every(s => typeof s === 'string')).map(e => e.map(s => s.slice(0,500)));
    }
    state.deliveryOpen = value.deliveryOpen === true;
  }
  function persist() {
    const extra = Object.fromEntries(Object.entries(state.extra).map(([id,events]) => [id,events.slice(-3).map(event => event.map(value => value.slice(0,180)))]));
    const snapshot = {version:1,selected:state.selected,tab:state.tab,filter:state.filter,project:state.project,serviceLog:state.serviceLog,decisions:state.decisions,extra,deliveryOpen:state.deliveryOpen,appearance};
    try {
      let serialized = JSON.stringify(snapshot);
      if (new TextEncoder().encode(serialized).length > 12000) serialized = JSON.stringify({...snapshot,extra:{}});
      localStorage.setItem(storageKey, serialized);
    } catch { /* Keeping browser history is optional for this local prototype. */ }
  }
  function applyAppearance() {
    document.documentElement.style.colorScheme = appearance;
    root.style.colorScheme = appearance;
    root.querySelector('[data-theme-toggle]').textContent = appearance === 'dark' ? 'Light' : 'Dark';
    root.querySelector('[data-theme-toggle]').setAttribute('aria-label', appearance === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  }
  function resetDemo() {
    simulationEpoch += 1;
    services.reset();
    state = initialState();
    render();
    applyAppearance();
    feedback('Samples reset · no commands executed');
    persist();
  }
  const $ = s => root.querySelector(s);
  const escape = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const serviceFailed = r => services.snapshot(r)?.services.some(s => s.status === 'failed') || false;
  const pending = r => (['permission','question'].includes(r.initial) && !state.decisions[r.id]) || serviceFailed(r);
  const scoped = () => runs.filter(r => state.project === 'all' || r.project === state.project);
  const visible = () => scoped().filter(r => state.filter === 'all' || pending(r));
  const selected = () => runs.find(r => r.id === state.selected);
  function runStatus(r) {
    const d = state.decisions[r.id];
    if (d === 'sending') return ['Sending response','aw-wait'];
    if (d === 'allowed') return ['Running · simulated','aw-running'];
    if (d === 'rejected') return ['Awaiting an alternative instruction','aw-wait'];
    if (d === 'answered') return ['Answer received','aw-running'];
    if (serviceFailed(r)) return ['Service start failed','aw-blocked'];
    return ({permission:['Awaiting approval · '+r.wait,'aw-wait'],question:['Awaiting answer · '+r.wait,'aw-wait'],running:['Running','aw-running'],complete:['Review complete · sample','aw-complete'],delivery:['Delivery draft','aw-complete']})[r.initial];
  }
  function statusMarkup(r) { const [text,cls]=runStatus(r); return '<span class="aw-state '+cls+'"><span class="aw-dot" aria-hidden="true"></span>'+escape(text)+'</span>'; }
  function append(r,kind,text) { const list=state.extra[r.id] ||= []; list.push(['14:12:'+String(8+list.length).padStart(2,'0'),kind,text]); if(list.length>6) list.shift(); }
  function feedback(text) { $('[data-feedback]').textContent=text; }
  function render() {
    const rows=visible();
    root.querySelector('.aw-detail').hidden = rows.length === 0;
    if (rows.length && !rows.some(r => r.id === state.selected)) state.selected = rows[0].id;
    $('[data-pending]').textContent=scoped().filter(pending).length;
    $('[data-total]').textContent=scoped().length;
    $('[data-scope-summary]').textContent=(state.project === 'all' ? 'All projects' : state.project)+' · separate environments (sample)';
    $('.aw-path').textContent=state.project === 'all' ? '~/projects · All projects' : projects.find(p => p.id === state.project).path;
    renderProjects();
    root.querySelectorAll('[data-filter]').forEach(b => b.setAttribute('aria-pressed',String(b.dataset.filter===state.filter)));
    $('[data-roster]').innerHTML = rows.length ? rows.map(r => '<button type="button" class="aw-run cursor-interaction" data-run="'+r.id+'" aria-pressed="'+(r.id===state.selected)+'" aria-label="'+escape(r.role+' '+r.task+', '+r.project+', '+runStatus(r)[0])+'"><span class="aw-run-title"><span class="aw-index">'+(runs.indexOf(r)+1)+'</span><span class="aw-role">'+r.role+'</span><span class="aw-task">'+r.task+'</span></span><span class="aw-project">'+r.project+'</span>'+statusMarkup(r)+'<span class="aw-provider">'+r.provider+'</span><span class="aw-change">'+r.change+'</span></button>').join('') : '<div class="aw-empty">Nothing needs attention here. Switch to All or choose another project.</div>';
    const r=selected();
    $('[data-detail-title]').textContent=r.role+' / '+r.task;
    $('[data-detail-state]').outerHTML=statusMarkup(r).replace('class="aw-state','data-detail-state class="aw-state');
    $('[data-detail-meta]').innerHTML='<span>'+escape(r.project)+'</span><span>'+escape(r.provider+' · '+r.profile)+'</span><span>candidate '+escape(r.sha)+' · sample</span><span>Separate environment · sample</span>';
    const environment = services.snapshot(r);
    const ready = environment?.services.filter(s => s.status === 'ready').length || 0;
    $('[data-service-count]').textContent=environment ? ready+'/'+environment.services.length : '—';
    $('[data-environment]').innerHTML=environment ? '<span>agent/'+escape(r.role+'-'+r.task)+'</span><code>'+escape('/sandboxes/'+environment.id+'/workspace/'+r.project)+'</code><button type="button" class="aw-button" data-open-services>Services '+ready+'/'+environment.services.length+(serviceFailed(r)?' · failed':'')+'</button>' : '<span>PM discussion · no execution environment yet</span>';
    root.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected',String(b.dataset.tab===state.tab)));
    $('[data-panel]').setAttribute('aria-labelledby','aw-tab-'+state.tab);
    renderPanel(r);
    renderAction(r);
    $('[data-input-label]').textContent='Reply to '+r.role+' / '+r.task+' · simulated, not sent to an agent';
    $('#aw-message').value=state.drafts[r.id]||'';
  }
  function renderProjects() {
    const current = selected();
    $('[data-project-summary]').textContent=(state.project === 'all' ? 'All projects' : state.project)+' · '+scoped().filter(pending).length+' pending';
    $('[data-projects]').innerHTML='<div class="aw-project-shortcuts"><button type="button" class="aw-project-button" data-project="all" aria-pressed="'+(state.project==='all' && state.filter==='all')+'"><span>All projects</span><span>'+runs.length+' agents</span></button><button type="button" class="aw-project-button" data-global-attention aria-pressed="'+(state.project==='all' && state.filter==='attention')+'"><span>Needs attention</span><span class="aw-wait">'+runs.filter(pending).length+'</span></button></div>'+projects.map(project => {
      const members = runs.filter(r => r.project === project.id);
      const count = members.filter(pending).length;
      const expanded = state.project === project.id || (state.project === 'all' && current.project === project.id);
      return '<div class="aw-project-group"><button type="button" class="aw-project-button aw-project-select" data-project="'+project.id+'" aria-pressed="'+(state.project===project.id)+'"><strong>'+project.id+'</strong><span class="'+(count?'aw-wait':'aw-muted')+'">'+(count?count+' pending':members.length+' agents')+'</span><code class="aw-repo-path">'+escape(project.path)+'</code></button>'+(expanded?'<div class="aw-project-agents">'+members.map(run => '<button type="button" class="aw-nav-agent" data-nav-run="'+run.id+'" aria-pressed="'+(run.id===state.selected)+'"><span class="aw-state '+runStatus(run)[1]+'"><span class="aw-dot" aria-hidden="true"></span>'+run.role+'</span><span>'+escape(run.task)+'</span></button>').join('')+'</div>':'')+'</div>';
    }).join('');
  }
  function eventHTML(events) { return events.map(e => '<div class="aw-event"><time class="aw-time">'+escape(e[0])+'</time><span class="aw-event-kind">'+escape(e[1])+'</span><span>'+escape(e[2])+'</span></div>').join(''); }
  function renderPanel(r) {
    const events=r.events.concat(state.extra[r.id]||[]);
    if(state.tab==='live') $('[data-panel]').innerHTML=eventHTML(events.slice(-4));
    if(state.tab==='timeline') $('[data-panel]').innerHTML='<p class="aw-note">Run timeline · sample</p>'+eventHTML(events);
    if(state.tab==='diff') {
      const snippets = {
        'verify': ['src/auth/session.py', '- if token.expires_at < now:', '+ if token.expires_at <= now:', '      raise TokenExpiredError()', '+ # The exact expiry time must also be invalid'],
        'dev-api': ['src/auth/refresh.py', '- session = refresh_session(token)', '+ with refresh_lock(token.session_id):', '+     session = refresh_once(token)', '+     return session'],
        'review': ['src/retry/backoff.ts', '- return delay * attempt;', '+ return Math.min(maxDelay, delay * 2 ** attempt);', '+ // Retry limits and cancellation require separate verification'],
        'pr': ['src/retry/backoff.ts', '- return delay * attempt;', '+ return Math.min(maxDelay, delay * 2 ** attempt);', '+ // Retry limits and cancellation require separate verification'],
        'dev-ui': ['src/components/DateInput.tsx', '- const value = date.toISOString().slice(0, 10);', '+ const value = formatDateInZone(date, timezone);', '+ // Use the selected timezone for date boundaries']
      };
      const snippet = snippets[r.id];
      $('[data-panel]').innerHTML = !snippet ? '<p class="aw-note">PM is clarifying scope; no code diff yet.</p>' : '<pre class="aw-diff">'+escape(snippet[0]+' · excerpt, sample code')+'\n\n'+snippet.slice(1).map(line => '<span class="'+(line.startsWith('+')?'aw-add':line.startsWith('-')?'aw-remove':'')+'">'+escape(line)+'</span>').join('\n')+'</pre>';
    }
    if(state.tab==='evidence') {
      $('[data-panel]').innerHTML='<p class="aw-note">Design preview; no agent connection or real checks have run.</p><div class="aw-evidence"><span>Verification commands and output</span><span class="aw-evidence-status">Not run</span><span>Review findings and code locations</span><span class="aw-evidence-status">Sample only</span><span>Candidate '+escape(r.sha)+'</span><span class="aw-evidence-status">Sample SHA</span></div>'+(r.role==='pr'?'<div style="margin-top:12px"><button type="button" class="aw-button cursor-interaction" data-preview-report>View delivery explanation</button><div class="aw-delivery '+(state.deliveryOpen?'is-visible':'')+'"><div class="aw-flow">Before: fixed delay → After: exponential backoff → capped delay</div><div>Change: retry intervals grow with each attempt, up to the maximum delay.</div><p class="aw-note">Sample explanation; live diagrams, code links and PR comments are not connected.</p></div></div>':'');
    }
    if(state.tab==='services') renderServices(r);
  }
  function renderServices(r) {
    const env = services.snapshot(r);
    if (!env) {
      $('[data-panel]').innerHTML='<div class="aw-empty"><p>PM is discussing requirements; no service environment yet.</p><button type="button" class="aw-button" data-nav-run="dev-api" data-nav-view="services">View Dev services</button></div>';
      return;
    }
    const labels = {stopped:['Stopped','aw-muted'],starting:['Checking health','aw-wait'],ready:['Ready · simulated','aw-complete'],failed:['Start failed','aw-blocked'],blocked:['Waiting for Backend','aw-wait']};
    const allReady = env.services.every(s => s.status === 'ready');
    const allStopped = env.services.every(s => s.status === 'stopped');
    const logs = env.logs.filter(log => state.serviceLog === 'all' || log.service === state.serviceLog);
    const preview = env.services.find(s => s.id === state.previewService && s.status === 'ready');
    $('[data-panel]').innerHTML='<div class="aw-service-heading"><div><strong>'+escape(env.id)+' / services</strong><p class="aw-note">This Run only · Database → Backend → Frontend</p></div><div class="aw-actions"><button type="button" class="aw-button aw-primary" data-service-action="start"'+(env.busy||allReady?' disabled':'')+'>Start all</button><button type="button" class="aw-button" data-service-action="stop"'+(allStopped?' disabled':'')+'>Stop all</button></div></div><div class="aw-service-table"><div class="aw-service-table-head" aria-hidden="true"><span>SERVICE / PORT</span><span>HEALTH</span><span>COMMAND / CHECK</span><span>CONTROLS</span></div>'+env.services.map(s => {
      const status = labels[s.status];
      const running = s.status === 'ready';
      return '<div class="aw-service-row" data-service-row="'+s.id+'"><div><strong>'+escape(s.name)+'</strong><span class="aw-port">:'+s.port+' · environment port</span></div><span class="aw-state '+status[1]+'" data-service-status="'+s.id+'"><span class="aw-dot" aria-hidden="true"></span>'+status[0]+'</span><div class="aw-service-command"><code>$ '+escape(s.command)+'</code><span>'+escape(s.directory+' · '+s.check)+'</span></div><div class="aw-service-controls"><button type="button" class="aw-button" data-service-action="'+(running?'restart':'start')+'" data-service-id="'+s.id+'" aria-label="'+(running?'Restart':s.status==='failed'?'Retry':'Start')+' '+escape(s.name)+'"'+(env.busy?' disabled':'')+'>'+(running?'Restart':s.status==='failed'?'Retry':'Start')+'</button><button type="button" class="aw-button" data-service-action="stop" data-service-id="'+s.id+'" aria-label="Stop '+escape(s.name)+' and dependents"'+(s.status==='stopped'?' disabled':'')+'>Stop</button>'+(s.id!=='db'?'<button type="button" class="aw-button" data-service-preview="'+s.id+'" aria-label="View '+escape(s.name)+' preview URL"'+(!running?' disabled':'')+'>URL</button>':'')+'</div></div>';
    }).join('')+'</div>'+(preview?'<div class="aw-endpoint" role="status"><strong>'+escape(preview.name)+' preview URL (sample)</strong><code>https://preview.example.invalid/'+escape(env.id+'/'+preview.id)+'</code><span>Production previews will use the environment proxy; this sample opens no connection.</span></div>':'')+'<p class="aw-note aw-service-disclaimer">States and commands are simulated. Stopping a service also stops its dependents; health readiness is not functional verification.</p><div class="aw-log-heading"><strong>Logs</strong><div class="aw-log-filters" role="group" aria-label="Filter service logs">'+[['all','All'],...env.services.map(s=>[s.id,s.name])].map(([id,label])=>'<button type="button" class="aw-button" data-service-log="'+id+'" aria-pressed="'+(state.serviceLog===id)+'">'+label+'</button>').join('')+'</div></div><div class="aw-service-logs" role="log" aria-live="off" aria-label="Service output for this environment">'+(logs.length?logs.map(log=>'<div class="aw-service-log"><time>'+escape(log.time)+'</time><span class="'+(log.level==='stderr'?'aw-blocked':'aw-running')+'">'+escape(log.service)+'/'+escape(log.level)+'</span><span>'+escape(log.message)+'</span></div>').join(''):'<p class="aw-note">No output yet. Start this service to see logs.</p>')+'</div><p class="aw-log-note">Latest 60 entries · this environment only · start/stop events appear in the Run timeline</p>';
    const logView=$('.aw-service-logs');
    logView.scrollTop=logView.scrollHeight;
  }
  function renderAction(r) {
    const d=state.decisions[r.id];
    if(d) {
      const messages={sending:'Response accepted → simulating delivery…',allowed:'Delivered to agent (simulated) · command has not actually run',rejected:'Command rejected (simulated) · enter an alternative instruction below',answered:'Answer delivered to PM (simulated) · continue the discussion below'};
      $('[data-action]').innerHTML='<div class="aw-receipt '+(d==='rejected'?'aw-rejected':'')+'" role="status" aria-live="polite">'+messages[d]+'</div>'; return;
    }
    if(r.initial==='permission') {
      $('[data-action]').innerHTML='<div class="aw-prompt"><div class="aw-prompt-title"><span>Awaiting your approval</span><span>Verify · waiting 2m</span></div><pre class="aw-command">$ '+escape(r.command)+'</pre><div class="aw-actions"><button type="button" class="aw-button aw-primary cursor-interaction" data-decision="allow">Allow once</button><button type="button" class="aw-button cursor-interaction" data-decision="reject">Reject</button><span class="aw-action-note">Simulates a response only; no command will run.</span></div></div>';
    } else if(r.initial==='question') {
      $('[data-action]').innerHTML='<div class="aw-prompt"><div class="aw-prompt-title"><span>PM needs your decision</span><span>Waiting 5m</span></div><div style="padding-top:7px">'+escape(r.question)+'</div><div class="aw-question-options">'+r.choices.map((c,i)=>'<button type="button" class="aw-button cursor-interaction" data-answer="'+i+'">'+escape(c)+'</button>').join('')+'</div></div>';
    } else $('[data-action]').innerHTML='';
  }
  function selectRun(id) { state.drafts[state.selected]=$('#aw-message').value; state.selected=id; state.deliveryOpen=false; state.previewService=null; render(); persist(); }
  function selectProject(id,attention=false) {
    state.drafts[state.selected]=$('#aw-message').value;
    state.project=id;
    state.filter=attention?'attention':'all';
    const rows=visible();
    if (rows.length && !rows.some(r => r.id === state.selected)) state.selected=rows[0].id;
    if (attention) state.tab=serviceFailed(selected())?'services':'live';
    state.previewService=null;
    render();persist();
  }
  function decide(decision) {
    const r=selected(); if(r.initial!=='permission'||state.decisions[r.id]) return;
    const epoch = simulationEpoch;
    state.decisions[r.id]=decision==='allow'?'sending':'rejected';
    append(r,'you',decision==='allow'?'You allowed once (sample)':'You rejected this command (sample)');
    render(); feedback(decision==='allow'?'Response accepted; simulating delivery':'Rejected · enter an alternative instruction');
    if(decision==='allow') setTimeout(()=>{if(epoch !== simulationEpoch) return;state.decisions[r.id]='allowed';append(r,'agent','Approval received; simulating execution, no command actually ran');render();feedback('Response delivery simulated · no real command executed');persist();},650);
    else persist();
  }
  function answer(text) {
    const r=selected(); if(r.initial==='question'&&!state.decisions[r.id]) state.decisions[r.id]='answered';
    append(r,'you',text);append(r,'received','Message delivery simulated; no live agent connection');state.drafts[r.id]='';render();feedback('Message delivery simulated to '+r.role);persist();
  }
  function sendMessage() { const text=$('#aw-message').value.trim();if(!text){feedback('Enter a message for the agent first');$('#aw-message').focus();return;}answer(text);$('#aw-message').focus(); }
  root.addEventListener('click',e=>{
    if(e.target.closest('[data-theme-toggle]')){appearance=appearance==='dark'?'light':'dark';applyAppearance();persist();return;}
    if(e.target.closest('[data-reset]')){resetDemo();return;}
    if(e.target.closest('[data-send]')){sendMessage();return;}
    const project=e.target.closest('[data-project]');if(project){selectProject(project.dataset.project);return;}
    if(e.target.closest('[data-global-attention]')){selectProject('all',true);return;}
    const navRun=e.target.closest('[data-nav-run]');if(navRun){state.project=runs.find(r=>r.id===navRun.dataset.navRun).project;state.filter='all';state.tab=navRun.dataset.navView || (serviceFailed(runs.find(r=>r.id===navRun.dataset.navRun))?'services':state.tab);selectRun(navRun.dataset.navRun);return;}
    const serviceAction=e.target.closest('[data-service-action]');if(serviceAction){$('[data-tab="services"]').focus();services[serviceAction.dataset.serviceAction](selected(),serviceAction.dataset.serviceId);return;}
    const logFilter=e.target.closest('[data-service-log]');if(logFilter){state.serviceLog=logFilter.dataset.serviceLog;renderPanel(selected());$('[data-service-log="'+state.serviceLog+'"]').focus();persist();return;}
    const servicePreview=e.target.closest('[data-service-preview]');if(servicePreview){state.previewService=servicePreview.dataset.servicePreview;renderPanel(selected());$('[data-service-preview="'+state.previewService+'"]').focus();return;}
    if(e.target.closest('[data-open-services]')){state.tab='services';render();$('[data-tab="services"]').focus();persist();return;}
    const run=e.target.closest('[data-run]'); if(run){const target=runs.find(r=>r.id===run.dataset.run);if(serviceFailed(target))state.tab='services';selectRun(run.dataset.run);return;}
    const tab=e.target.closest('[data-tab]');if(tab){state.tab=tab.dataset.tab;renderPanel(selected());root.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-selected',String(b===tab)));$('[data-panel]').setAttribute('aria-labelledby',tab.id);persist();return;}
    const filter=e.target.closest('[data-filter]');if(filter){state.filter=filter.dataset.filter;const rows=visible();if(rows.length&&!rows.some(r=>r.id===state.selected))state.selected=rows[0].id;render();persist();return;}
    const decision=e.target.closest('[data-decision]');if(decision){decide(decision.dataset.decision);return;}
    const choice=e.target.closest('[data-answer]');if(choice){answer(selected().choices[Number(choice.dataset.answer)]);return;}
    if(e.target.closest('[data-preview-report]')){state.deliveryOpen=!state.deliveryOpen;renderPanel(selected());persist();}
  });
  $('#aw-message').addEventListener('input',()=>{state.drafts[state.selected]=$('#aw-message').value;});
  $('#aw-message').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();sendMessage();}});
  root.addEventListener('keydown',e=>{
    if(e.target instanceof HTMLInputElement||e.target instanceof HTMLTextAreaElement||e.metaKey||e.ctrlKey||e.altKey)return;
    if(e.key==='a'&&state.tab!=='services'){e.preventDefault();decide('allow');}
    if(e.key==='r'&&state.tab!=='services'){e.preventDefault();decide('reject');}
    if(['1','2','3','4','5'].includes(e.key)){e.preventDefault();state.tab=tabs[Number(e.key)-1];render();$('[data-tab="'+state.tab+'"]').focus();persist();}
    if(['ArrowUp','ArrowDown'].includes(e.key)&&e.target.closest('[data-run]')){e.preventDefault();const rows=visible();const i=rows.findIndex(r=>r.id===state.selected);const next=rows[(i+(e.key==='ArrowDown'?1:-1)+rows.length)%rows.length];if(next){selectRun(next.id);$('[data-run="'+next.id+'"]').focus();}}
    if(['ArrowLeft','ArrowRight'].includes(e.key)&&e.target.closest('[data-tab]')){e.preventDefault();const current=tabs.indexOf(e.target.closest('[data-tab]').dataset.tab);const next=(current+(e.key==='ArrowRight'?1:tabs.length-1))%tabs.length;state.tab=tabs[next];render();$('[data-tab="'+state.tab+'"]').focus();persist();}
  });
  const compactNavigation = window.matchMedia('(max-width: 1000px)');
  const setNavigation = () => { $('.aw-project-nav').open=!compactNavigation.matches; };
  compactNavigation.addEventListener('change',setNavigation);
  setNavigation();
  render();
  applyAppearance();
})();
