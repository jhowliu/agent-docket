/* In-memory service simulator. This module never starts a process or makes a request. */
window.WorkbenchServiceDemo = Object.freeze({
  create(onChange) {
    const environments = new Map();
    let generation = 0;
    const profiles = {
      'atlas-api': [
        {id:'db',name:'Database',port:'5432',command:'postgres',directory:'.',check:'pg_isready',depends:[]},
        {id:'api',name:'Backend',port:'8000',command:'uvicorn src.app:app --host 0.0.0.0 --port 8000',directory:'.',check:'GET /health',depends:['db']},
        {id:'web',name:'Frontend',port:'5173',command:'npm run dev -- --host 0.0.0.0',directory:'web',check:'GET /',depends:['api']}
      ],
      'task-queue': [
        {id:'db',name:'Redis',port:'6379',command:'redis-server',directory:'.',check:'redis-cli ping',depends:[]},
        {id:'api',name:'Worker API',port:'8000',command:'npm run dev:api',directory:'server',check:'GET /health',depends:['db']},
        {id:'web',name:'Dashboard',port:'5173',command:'npm run dev -- --host 0.0.0.0',directory:'web',check:'GET /',depends:['api']}
      ],
      'habit-log': [
        {id:'db',name:'Database',port:'5432',command:'postgres',directory:'.',check:'pg_isready',depends:[]},
        {id:'api',name:'Backend',port:'8000',command:'npm run dev:api',directory:'server',check:'GET /health',depends:['db']},
        {id:'web',name:'Frontend',port:'5173',command:'npm run dev -- --host 0.0.0.0',directory:'web',check:'GET /',depends:['api']}
      ]
    };
    function log(env,service,level,message) {
      env.logs.push({time:new Date().toLocaleTimeString('en-GB',{hour12:false}),service,level,message});
      env.logs = env.logs.slice(-60);
    }
    function environment(run) {
      if (run.role === 'pm') return null;
      const key = run.id + ':' + run.sha;
      if (!environments.has(key)) {
        const env = {id:'env-' + run.id,run,version:0,busy:false,services:profiles[run.project].map(s => ({...s,depends:[...s.depends],status:'stopped'})),logs:[]};
        if (run.id === 'dev-ui') {
          env.services[0].status = 'ready';
          env.services[1].status = 'failed';
          env.services[2].status = 'blocked';
          log(env,'db','health','Database health check passed (sample)');
          log(env,'api','stderr','Sample: start failed; test database connection refused. Retry Backend.');
          log(env,'web','waiting','Waiting for Backend recovery; Frontend has not started.');
        } else log(env,'stack','info','Services have not started. Actions only simulate this Run environment.');
        environments.set(key,env);
      }
      return environments.get(key);
    }
    function snapshot(run) {
      const env = environment(run);
      if (!env) return null;
      return {id:env.id,busy:env.busy,services:env.services.map(s => ({...s,depends:[...s.depends]})),logs:env.logs.map(l => ({...l}))};
    }
    function withDependencies(env,ids) {
      const included = new Set();
      function visit(id) {
        if (included.has(id)) return;
        const service = env.services.find(s => s.id === id);
        if (!service) return;
        service.depends.forEach(visit);
        included.add(id);
      }
      ids.forEach(visit);
      return [...included];
    }
    function withDependents(env,id) {
      const included = new Set([id]);
      for (let count=0;count<env.services.length;count++) {
        for (const s of env.services) if (s.depends.some(d => included.has(d))) included.add(s.id);
      }
      return env.services.map(s => s.id).filter(key => included.has(key));
    }
    function notify(env,message) { onChange(env.run,message); }
    function startIds(env,ids) {
      const order = withDependencies(env,ids);
      const version = ++env.version;
      const currentGeneration = generation;
      env.busy = true;
      function next(index) {
        if (generation !== currentGeneration || version !== env.version) return;
        if (index >= order.length) {
          env.busy = false;
          notify(env,'Services started (simulated) · health is not functional verification');
          return;
        }
        const service = env.services.find(s => s.id === order[index]);
        if (service.status === 'ready') { next(index+1); return; }
        service.status = 'starting';
        log(env,service.id,'stdout','$ ' + service.command);
        log(env,service.id,'health','Process starting; waiting for ' + service.check + ' (simulated)');
        notify(env);
        setTimeout(() => {
          if (generation !== currentGeneration || version !== env.version) return;
          service.status = 'ready';
          log(env,service.id,'health',service.check + ' passed; service ready (simulated)');
          next(index+1);
        },550);
      }
      next(0);
    }
    function stopIds(env,ids) {
      env.version += 1;
      env.busy = false;
      for (const service of [...env.services].reverse()) if (ids.includes(service.id) && service.status !== 'stopped') {
        service.status = 'stopped';
        log(env,service.id,'stop','Stopped (simulated)');
      }
    }
    return Object.freeze({
      snapshot,
      start(run,id) {
        const env = environment(run);
        if (!env || env.busy) return;
        startIds(env,id ? withDependents(env,id).filter(key => key === id || env.services.find(s => s.id === key).status === 'blocked') : env.services.map(s => s.id));
      },
      stop(run,id) {
        const env = environment(run);
        if (!env) return;
        stopIds(env,id ? withDependents(env,id) : env.services.map(s => s.id));
        notify(env,id ? 'Service and dependents stopped (simulated)' : 'All services stopped in this environment (simulated)');
      },
      restart(run,id) {
        const env = environment(run);
        if (!env || env.busy) return;
        const affected = withDependents(env,id).filter(key => key === id || env.services.find(s => s.id === key).status !== 'stopped');
        stopIds(env,affected);
        log(env,id,'info','Restarting service and affected dependents (simulated)');
        startIds(env,affected);
      },
      reset() { generation += 1; environments.clear(); }
    });
  }
});
