/* F1shPr0 — Fishtone bot for Eaglercraft 1.8.8
 * Works with:
 *  - index.html (iframe launcher)  -> talks to iframe.contentWindow
 *  - Release 1.8.8.html (direct)  -> talks to window directly
 *
 * Notes:
 * - This ships with a robust adapter layer to map Eaglercraft's player/world API.
 * - A* pathfinding across a 3D grid with step-up, step-down and jump.
 * - Optional breaking/placing (requires world mutation methods; see adapter).
 * - If a specific method isn't available in your build, the adapter falls back gracefully.
 */

/* -------------------- DOM / UI wiring -------------------- */
(function bootstrapUI(){
  const el = (id) => document.getElementById(id);

  const tabs = document.querySelectorAll('.f1-tabs button');
  const tabPages = document.querySelectorAll('.f1-tab');
  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      tabs.forEach(b => b.classList.remove('active'));
      tabPages.forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      el('f1-tab-' + btn.dataset.tab).classList.add('active');
    });
  });

  // Open/Close via keys (Right Shift / Right Ctrl)
  const panel = el('f1-ui');
  document.addEventListener('keydown', (e) => {
    if (e.code === 'ShiftRight') panel.style.display = 'block';
    if (e.code === 'ControlRight') panel.style.display = 'none';
  });
  const closeBtn = el('f1-close');
  if (closeBtn) closeBtn.onclick = () => panel.style.display = 'none';

  // Buttons
  const setStatus = (s)=> el('f1-status') && (el('f1-status').textContent = s);
  const logBox = el('f1-log');
  const log = (...a)=>{ if(logBox){ logBox.textContent += a.join(' ') + '\n'; logBox.scrollTop = logBox.scrollHeight; } console.log('[Fishtone]',...a); };

  const ctx = GameContext(); // locate game window + adapter
  if (!ctx) {
    setStatus('no game context (same-origin required)');
    console.warn('[Fishtone] Same-origin requirement: index.html and Release 1.8.8.html must be served from the same folder/domain.');
    return;
  }
  const FT = Fishtone(ctx, { log, setStatus });

  // Inputs
  const ix=el('f1-x'), iy=el('f1-y'), iz=el('f1-z');

  // Actions
  const btnGoto = el('f1-goto');
  btnGoto && btnGoto.addEventListener('click', () => {
    if (!ix.value || !iy.value || !iz.value) return;
    FT.goto(parseInt(ix.value,10), parseInt(iy.value,10), parseInt(iz.value,10));
  });

  const btnGotoLook = el('f1-goto-look');
  btnGotoLook && btnGotoLook.addEventListener('click', async () => {
    const blk = FT.lookBlock();
    if (!blk) { setStatus('look at a block'); return; }
    ix.value = blk.x; iy.value = blk.y; iz.value = blk.z;
    FT.goto(blk.x, blk.y, blk.z);
  });

  const btnStop = el('f1-stop');
  btnStop && btnStop.addEventListener('click', () => FT.stop());

  const btnMineFront = el('f1-mine-front');
  btnMineFront && btnMineFront.addEventListener('click', () => FT.mineFront());

  const btnBridge = el('f1-bridge');
  btnBridge && btnBridge.addEventListener('click', () => FT.bridgeForward());

  const btnStepUp = el('f1-step-up');
  btnStepUp && btnStepUp.addEventListener('click', () => FT.buildStepUp());

  const btnCraftBench = el('f1-craft-bench');
  btnCraftBench && btnCraftBench.addEventListener('click', () => FT.craftBench());

  const cbBreak = el('f1-allow-break');
  const cbPlace = el('f1-allow-place');
  const maxNodes = el('f1-maxnodes');
  const range = el('f1-range');

  cbBreak && cbBreak.addEventListener('change', () => FT.settings.allowBreak = !!cbBreak.checked);
  cbPlace && cbPlace.addEventListener('change', () => FT.settings.allowPlace = !!cbPlace.checked);
  maxNodes && maxNodes.addEventListener('change', () => FT.settings.maxNodes = Math.max(200, parseInt(maxNodes.value,10)||800));
  range && range.addEventListener('change', () => FT.settings.searchRange = Math.max(8, parseInt(range.value,10)||64));

  // Expose for console testing
  window.F1_Fishtone = FT;
})();

/* -------------------- Game context & adapter -------------------- */
// Finds where the game lives (top window or in #game-frame) and returns an adapter
function GameContext() {
  const frame = document.getElementById('game-frame');
  const win = frame ? frame.contentWindow : window;

  try {
    // Access test (fails if cross-origin)
    const test = win.location.href;
  } catch(e) { return null; }

  // Try to discover likely globals
  const mc = win.mc || win.eaglercraftX || win.game || null;

  return {
    win,
    mc,
    adapter: makeAdapter(win)
  };
}

function makeAdapter(win) {
  // Attempt to resolve world/player methods used across Eaglercraft builds.
  const g = (p, ...keys) => keys.reduce((o,k)=> o&&o[k]!=null?o[k]:null, p);

  // Candidate roots
  const roots = [
    win, win.mc, g(win,'eaglercraftX','game'), g(win,'eaglercraftX'),
    g(win,'game'), g(win,'Minecraft')
  ].filter(Boolean);

  function findPlayer() {
    for (const r of roots) {
      const p = g(r,'thePlayer') || g(r,'player') || g(r,'localPlayer') || g(r,'playerController')?.player;
      if (p && ('posX' in p) && ('posY' in p) && ('posZ' in p)) return p;
    }
    return null;
  }

  function findWorld() {
    for (const r of roots) {
      const w = g(r,'theWorld') || g(r,'world') || g(r,'clientWorld') || g(r,'World');
      if (w) return w;
    }
    return null;
  }

  function getBlockId(w,x,y,z){
    if (!w) return 0;
    // Known patterns
    if (typeof w.getBlockId === 'function') return w.getBlockId(x,y,z);
    if (typeof w.getBlock === 'function') {
      const b = w.getBlock(x,y,z);
      if (b == null) return 0;
      if (typeof b === 'number') return b;
      if (typeof b.id === 'number') return b.id;
      if (b.blockID != null) return b.blockID;
    }
    if (w.blocks && w.blocks[y] && w.blocks[y][x] && w.blocks[y][x][z] != null) {
      return w.blocks[y][x][z];
    }
    return 0; // fallback: treat as air
  }

  function setBlock(w,x,y,z,id){
    if (!w) return false;
    if (typeof w.setBlock === 'function') { w.setBlock(x,y,z,id); return true; }
    if (typeof w.setBlockId === 'function') { w.setBlockId(x,y,z,id); return true; }
    if (w.blocks && w.blocks[y] && w.blocks[y][x]) { w.blocks[y][x][z] = id; return true; }
    return false;
  }

  function hitBlock(w,x,y,z){
    // naive instant-break; replace with proper damage if you have API
    return setBlock(w,x,y,z,0);
  }

  function placeBlockFacing(w, x,y,z, blockId){
    // Simple place at position
    return setBlock(w,x,y,z,blockId);
  }

  function lookRay(winCtx, player, reach=5.0) {
    // Very simple forward ray from player's yaw/pitch; requires yaw/pitch on player
    if (player == null) return null;
    const yaw = (player.rotationYaw || player.yaw || 0) * (Math.PI/180);
    const pitch = (player.rotationPitch || player.pitch || 0) * (Math.PI/180);
    const dirX = -Math.sin(yaw) * Math.cos(pitch);
    const dirY = -Math.sin(pitch);
    const dirZ =  Math.cos(yaw) * Math.cos(pitch);
    const ox = (player.posX || 0);
    const oy = (player.posY || 0) + (player.eyeHeight || 1.62);
    const oz = (player.posZ || 0);
    for (let t=0; t<=reach; t+=0.1) {
      const x = Math.floor(ox + dirX * t);
      const y = Math.floor(oy + dirY * t);
      const z = Math.floor(oz + dirZ * t);
      const w = findWorld();
      if (!w) break;
      const id = getBlockId(w,x,y,z);
      if (id && id !== 0) return { x,y,z, id };
    }
    return null;
  }

  return {
    findPlayer,
    findWorld,
    getBlockId,
    setBlock,
    hitBlock,
    placeBlockFacing,
    lookRay
  };
}

/* -------------------- Core bot (A*, movement, actions) -------------------- */
function Fishtone(ctx, ui) {
  const { win, adapter } = ctx;
  const { findPlayer, findWorld, getBlockId, setBlock, hitBlock, placeBlockFacing, lookRay } = adapter;

  const state = {
    active: false,
    path: [],
    currentIdx: 0,
    settings: {
      allowBreak: false,
      allowPlace: false,
      searchRange: 64,
      maxNodes: 800
    }
  };

  const api = {
    settings: state.settings,

    goto(x,y,z){
      const player = findPlayer();
      const world = findWorld();
      if (!player || !world) return ui.setStatus('no player/world');
      const start = toNode(player.posX, player.posY, player.posZ);
      const goal = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
      const res = aStar(start, goal, world, state.settings);
      if (!res) { ui.setStatus('no path'); ui.log('No path found'); state.active=false; return; }
      state.path = res;
      state.currentIdx = 0;
      state.active = true;
      ui.setStatus(`path len ${res.length}`);
      ui.log('Path computed:', res.length, 'nodes');
    },

    stop(){
      state.active = false;
      state.path = [];
      state.currentIdx = 0;
      const p = findPlayer();
      if (p){ p.motionX = 0; p.motionZ = 0; }
      ui.setStatus('stopped');
    },

    lookBlock(){
      const p = findPlayer();
      return lookRay(win, p, 6.0);
    },

    mineFront(){
      const p = findPlayer(), w = findWorld();
      if (!p || !w) return ui.setStatus('no player/world');
      const target = lookRay(win, p, 5.0);
      if (!target) return ui.setStatus('no block in sight');
      const ok = hitBlock(w, target.x, target.y, target.z);
      ui.setStatus(ok ? `mined ${target.x},${target.y},${target.z}` : 'mine failed (adapter)');
    },

    bridgeForward(){
      const p = findPlayer(), w = findWorld();
      if (!p || !w) return ui.setStatus('no player/world');
      const fx = Math.floor(p.posX);
      const fy = Math.floor(p.posY) - 1;
      const fz = Math.floor(p.posZ);
      // place one block under feet (simple)
      const ok = placeBlockFacing(w, fx, fy, fz, 1);
      ui.setStatus(ok ? 'bridged under feet' : 'place failed (adapter)');
    },

    buildStepUp(){
      const p = findPlayer(), w = findWorld();
      if (!p || !w) return ui.setStatus('no player/world');
      const x = Math.floor(p.posX);
      const y = Math.floor(p.posY) - 1;
      const z = Math.floor(p.posZ);
      const ok = placeBlockFacing(w, x, y, z, 1);
      if (ok && p.onGround) p.motionY = 0.42;
      ui.setStatus(ok ? 'stepped up' : 'place failed (adapter)');
    },

    craftBench(){
      // Placeholder: needs your client’s inventory & crafting API.
      ui.setStatus('crafting requires inventory API mapping');
      ui.log('To enable crafting, map your inventory API here (openContainer, craft grid, etc.)');
    }
  };

  // main tick
  setInterval(() => {
    if (!state.active || state.currentIdx >= state.path.length) return;
    const player = findPlayer();
    const world = findWorld();
    if (!player || !world) { state.active=false; return; }

    const node = state.path[state.currentIdx];
    // If the node is now blocked and breaking/placing is allowed, act:
    if (!isStandable(world, node.x, node.y, node.z)) {
      // Try to clear head / feet if allowed
      if (state.settings.allowBreak) {
        hitAround(world, node.x, node.y, node.z);
      } else {
        // Repath if blocked and we can't break
        const start = toNode(player.posX, player.posY, player.posZ);
        const res = aStar(start, state.path[state.path.length-1], world, state.settings);
        if (res) { state.path = res; state.currentIdx = 0; ui.setStatus('repath'); }
        return;
      }
    }

    const reached = moveTowardsBlock(player, node);
    if (reached) {
      state.currentIdx++;
      if (state.currentIdx >= state.path.length) {
        state.active = false;
        ui.setStatus('arrived');
      }
    }
  }, 50);

  /* ---------- helpers ---------- */

  function toNode(px,py,pz){
    return { x: Math.floor(px), y: Math.floor(py+0.001), z: Math.floor(pz) };
  }

  function moveTowardsBlock(player, node){
    // target center
    const tx = node.x + 0.5, tz = node.z + 0.5;
    const dx = tx - player.posX;
    const dz = tz - player.posZ;
    const dist = Math.hypot(dx,dz);
    if (dist < 0.35 && Math.abs((node.y) - player.posY) < 1.1) {
      player.motionX = 0; player.motionZ = 0; return true;
    }
    const nx = dx / (dist || 1e-6);
    const nz = dz / (dist || 1e-6);
    player.motionX = nx * 0.22;
    player.motionZ = nz * 0.22;

    // Handle vertical step
    const dy = node.y - Math.floor(player.posY);
    if (dy >= 1 && player.onGround) player.motionY = 0.42; // jump up

    return false;
  }

  function hitAround(world, x,y,z){
    // Try clearing head and feet spaces
    hitBlock(world, x, y, z);
    hitBlock(world, x, y+1, z);
  }

  function isAir(world, x,y,z){
    return (getBlockId(world,x,y,z) === 0);
  }

  function isStandable(world, x,y,z){
    // feet & head must be air, block below solid
    const below = getBlockId(world,x,y-1,z);
    return isAir(world,x,y,z) && isAir(world,x,y+1,z) && (below !== 0);
  }

  /* ---------- A* pathfinding ---------- */
  function aStar(start, goal, world, settings){
    const maxNodes = settings.maxNodes || 800;
    const range = Math.max(8, settings.searchRange || 64);

    const open = new MinHeap((a,b)=> a.f - b.f);
    const startKey = key(start);
    const g = new Map([[startKey, 0]]);
    const f = new Map([[startKey, heuristic(start, goal)]]);
    const came = new Map();
    open.push({ n: start, f: f.get(startKey) });

    let visited = 0;

    while(!open.isEmpty()){
      if (++visited > maxNodes) break;
      const cur = open.pop().n;
      const cKey = key(cur);

      if (cur.x === goal.x && cur.y === goal.y && cur.z === goal.z){
        return reconstruct(came, cur);
      }

      for (const nb of neighbors(cur, world, range)){
        const nKey = key(nb);
        const tentative = (g.get(cKey) || Infinity) + nb.cost;
        if (tentative < (g.get(nKey) || Infinity)) {
          came.set(nKey, cur);
          g.set(nKey, tentative);
          const fScore = tentative + heuristic(nb, goal);
          f.set(nKey, fScore);
          open.push({ n: nb, f: fScore });
        }
      }
    }
    return null;
  }

  function neighbors(n, world, range){
    // 4-way + vertical steps (up/down 1) + small drop
    const out = [];
    const dirs = [
      [ 1,0],[-1,0],[0, 1],[0,-1]
    ];
    for (const [dx,dz] of dirs){
      // same Y
      const nx = n.x + dx, ny = n.y, nz = n.z + dz;
      if (within(n, nx, ny, nz, range) && isStandable(world, nx, ny, nz)) {
        out.push({ x:nx, y:ny, z:nz, cost: 1 });
      }
      // step up
      const uy = n.y + 1;
      if (within(n, nx, uy, nz, range) && isStandable(world, nx, uy, nz) && isAir(world, nx, ny, nz)) {
        out.push({ x:nx, y:uy, z:nz, cost: 1.4 });
      }
      // step down (one)
      const dy = n.y - 1;
      if (within(n, nx, dy, nz, range) && isStandable(world, nx, dy, nz)) {
        out.push({ x:nx, y:dy, z:nz, cost: 1.2 });
      }
    }
    return out;
  }

  function within(a, x,y,z, r){
    return Math.abs(x - a.x) <= r && Math.abs(y - a.y) <= 8 && Math.abs(z - a.z) <= r;
  }

  function heuristic(a,b){
    // Manhattan with vertical bias
    return Math.abs(a.x-b.x) + Math.abs(a.z-b.z) + 1.5*Math.abs(a.y-b.y);
  }

  function key(n){ return `${n.x},${n.y},${n.z}`; }

  function reconstruct(came, cur){
    const path = [cur];
    while (came.has(key(cur))) {
      cur = came.get(key(cur));
      path.unshift(cur);
    }
    return path;
  }

  /* ---------- tiny binary heap ---------- */
  function MinHeap(comp){
    this.a = []; this.comp = comp;
  }
  MinHeap.prototype.size = function(){ return this.a.length; };
  MinHeap.prototype.isEmpty = function(){ return this.a.length === 0; };
  MinHeap.prototype.push = function(x){
    const a=this.a, c=this.comp; a.push(x);
    let i=a.length-1; while(i>0){
      const p=(i-1)>>1; if(c(a[i],a[p])>=0) break; [a[i],a[p]]=[a[p],a[i]]; i=p;
    }
  };
  MinHeap.prototype.pop = function(){
    const a=this.a, c=this.comp; if(a.length===0) return null;
    const top=a[0], last=a.pop(); if(a.length){ a[0]=last; let i=0;
      for(;;){
        const l=i*2+1, r=l+1; let s=i;
        if(l<a.length && c(a[l],a[s])<0) s=l;
        if(r<a.length && c(a[r],a[s])<0) s=r;
        if(s===i) break; [a[i],a[s]]=[a[s],a[i]]; i=s;
      }
    }
    return top;
  };

  return api;
}
