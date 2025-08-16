/* F1shPr0 — Eaglercraft 1.8.8 bot
 * Features:
 *  - A* pathfinding (XZ grid, with Y stepping/jump/fall)
 *  - Mining, placing, crafting (2x2 & 3x3)
 *  - Autoplan: gather -> craft -> deliver
 *  - Eagler adapter auto-detect (safe if not found)
 */

const FLOG = (...a)=>F1shPr0.ui.log(a.map(x=>typeof x==='object'?JSON.stringify(x):x).join(' '));
const wait = ms => new Promise(r=>setTimeout(r,ms));

const EAGLER_MODE = 'auto';  // 'auto' | 'force' (force sim false) | 'sim'
const FACE_DIRS = [
  [ 0,-1, 0], // down
  [ 0, 1, 0], // up
  [ 0, 0,-1], // north
  [ 0, 0, 1], // south
  [-1, 0, 0], // west
  [ 1, 0, 0], // east
];

const F1shPr0 = {
  menuVisible:false,
  items:{},
  inventory:{}, // { itemId: count }
  taskQueue:[],
  settings:{
    maxNodes:6000,
    breakTimeout:6000,
    stepHeight:1.0
  },
  world: null, player: null, adapter: null,
  sim: { blocks:new Map(), entities:[], pos:{x:0,y:64,z:0}, yaw:0, pitch:0 },

  async init() {
    // load items
    try {
      const res = await fetch("items.json");
      this.items = await res.json();
      FLOG(`Loaded items: ${Object.keys(this.items).length}`);
    } catch(e) { FLOG('items.json load error', e); }

    // load settings
    const s = localStorage.getItem('f1shpr0.settings');
    if (s) Object.assign(this.settings, JSON.parse(s));

    // set keybinds
    document.addEventListener("keydown", (e) => {
      if (e.code === "ShiftRight") this.ui.toggle(true);
      if (e.code === "ControlRight") this.ui.toggle(false);
    });

    // detect eaglercraft
    this.adapter = this.detectAdapter();
    const modePill = document.getElementById('modePill');
    if (this.adapter.kind === 'eagler') { modePill.textContent = 'Eaglercraft'; modePill.style.color = '#0f0'; }
    else { modePill.textContent = 'Simulation'; modePill.style.color = '#ccc'; }

    // small palette for builder
    this.build.initPalette(['stone','cobblestone','oak_log','planks','glass','torch']);
  },

  /* ================= UI ================= */
  ui:{
    toggle(state){
      const m = document.getElementById('f1shpr0Menu');
      F1shPr0.menuVisible = state;
      m.style.display = state ? 'block' : 'none';
    },
    tab(name){
      ['Home','Tasks','Build','Settings'].forEach(t=>{
        document.getElementById('view'+t).style.display = (t.toLowerCase()===name) ? 'block' : 'none';
        document.getElementById('tab'+t).classList.toggle('active', t.toLowerCase()===name);
      });
    },
    log(line){
      const el = document.getElementById('botLog');
      const now = new Date().toLocaleTimeString();
      el.innerHTML = `[${now}] ${line}<br>` + el.innerHTML;
    },
    get(){
      const div = document.getElementById('panelHome');
      div.innerHTML = `
        <div class="row">
          <input id="getItemInput" placeholder="item id (e.g. iron_pickaxe)" oninput="F1shPr0.ui.suggest()" />
          <button class="primary" onclick="F1shPr0.startGet()">Get</button>
        </div>
        <div id="suggestions" class="hint"></div>
      `;
    },
    suggest(){
      const q = document.getElementById('getItemInput').value.toLowerCase();
      const keys = Object.keys(F1shPr0.items);
      const m = keys.filter(k=>k.includes(q)).slice(0,8);
      document.getElementById('suggestions').textContent = m.length ? ('Suggestions: '+m.join(', ')) : '';
    },
    goto(){
      const div = document.getElementById('panelHome');
      div.innerHTML = `
        <div class="row">
          <input id="gotoX" placeholder="X"><input id="gotoY" placeholder="Y"><input id="gotoZ" placeholder="Z">
          <button class="primary" onclick="F1shPr0.cmdGoto()">Go</button>
        </div>`;
    },
    track(){
      const div = document.getElementById('panelHome');
      div.innerHTML = `
        <div class="row">
          <input id="trackName" placeholder="Player name">
          <button class="primary" onclick="F1shPr0.cmdTrack()">Track</button>
        </div>`;
    },
    quickWood(){
      F1shPr0.enqueue({type:'get', item:'wooden_pickaxe', src:'Quick'});
      F1shPr0.runTasks();
    }
  },

  saveSettings(){
    const g = id=>document.getElementById(id).value;
    this.settings.maxNodes = +g('optMaxNodes');
    this.settings.breakTimeout = +g('optBreakTimeout');
    this.settings.stepHeight = +g('optStepHeight');
    localStorage.setItem('f1shpr0.settings', JSON.stringify(this.settings));
    FLOG('Settings saved.');
  },
  resetSettings(){
    localStorage.removeItem('f1shpr0.settings');
    location.reload();
  },

  /* =============== Planner API =============== */
  startGet(){
    const item = document.getElementById('getItemInput').value.trim().toLowerCase();
    if (!this.items[item]) { FLOG('Unknown item: ', item); return; }
    this.enqueue({type:'get', item});
    this.runTasks();
  },
  enqueue(task){ this.taskQueue.push(task); this.renderTasks(); },
  renderTasks(){
    const el = document.getElementById('tasksList');
    if (!el) return;
    el.innerHTML = this.taskQueue.map((t,i)=>`<div>#${i} ${t.type} <span class="k">${t.item||''}</span></div>`).join('');
  },

  async runTasks(){
    while(this.taskQueue.length){
      const t = this.taskQueue.shift();
      this.renderTasks();
      if (t.type==='get') { await this.obtainItem(t.item, 1); }
      else if (t.type==='goto') { await this.pathTo(t.pos); }
    }
  },

  /* =============== Core: obtain item =============== */
  async obtainItem(item, count=1){
    FLOG(`Obtain: ${item} x${count}`);
    if (this.inventory[item] >= count){ FLOG('Already in inventory'); return true; }

    const def = this.items[item];
    if (!def){ FLOG('Unknown item'); return false; }

    if (def.craftable){
      // compute needed inputs from recipe grid
      const needed = this.countRecipe(def.recipe, def.count||1, count);
      for (const [ing, qty] of Object.entries(needed)){
        if ((this.inventory[ing]||0) < qty){
          await this.obtainItem(ing, qty - (this.inventory[ing]||0));
        }
      }
      // craft (2x2 or 3x3)
      const three = this.recipeNeeds3x3(def.recipe);
      const ok = await this.craftGrid(def.recipe, three);
      if (!ok){ FLOG('Craft failed:', item); return false; }
      this.addInv(item, (def.count||1));
      FLOG(`Crafted ${item} x${def.count||1}`);
      return true;
    }

    // non-craftable paths
    if (def.from === 'mining'){
      const ok = await this.mine(def.block, def.tool||'pickaxe', def.toolTier||0, count);
      if (ok){ this.addInv(item, def.count||1); }
      return ok;
    }
    if (def.from === 'smelting'){
      // ensure furnace + fuel
      await this.obtainItem('furnace',1);
      await this.obtainItem(def.input, count);
      await this.obtainItem('coal',1); // simple fuel pick
      const ok = await this.smelt(def.input, item, count);
      if (ok) this.addInv(item, def.count||1);
      return ok;
    }
    if (def.from === 'mob'){
      const ok = await this.hunt(def.mob, count);
      if (ok) this.addInv(item, count);
      return ok;
    }
    if (def.from === 'drop'){
      // blocks that drop items (like gravel -> flint)
      const ok = await this.mine(def.source, 'any', 0, count);
      if (ok) this.addInv(item, def.count||1);
      return ok;
    }

    FLOG('No path for', item);
    return false;
  },

  addInv(id, n){ this.inventory[id] = (this.inventory[id]||0) + n; },

  countRecipe(grid, outCountPerCraft=1, wantCount=1){
    // flatten ingredients -> total counts * crafts
    const perCraft = {};
    grid.forEach(row=>row.forEach(cell=>{
      if (!cell) return;
      perCraft[cell] = (perCraft[cell]||0) + 1;
    }));
    // number of crafts needed to reach wantCount
    const crafts = Math.ceil(wantCount / outCountPerCraft);
    const res = {};
    for(const [k,v] of Object.entries(perCraft)) res[k] = v*crafts;
    return res;
  },
  recipeNeeds3x3(grid){
    // if any ingredient is in row 3 or col 3 -> needs 3x3
    for (let r=0;r<3;r++) for(let c=0;c<3;c++){
      if (grid[r] && grid[r][c] && (r>1 || c>1)) return true;
    }
    // heuristic: if recipe logically known as table-only (like furnace), we already place in 3x3 above.
    return false;
  },

  /* =============== Crafting =============== */
  async craftGrid(grid, needs3x3){
    if (needs3x3){
      const near = await this.findNearbyBlock('crafting_table', 6);
      if (!near){ FLOG('Need crafting_table nearby. Trying to craft one 2x2 first…'); return false; }
      await this.pathTo(near);
      await this.adapter.useBlock(near);
      await wait(200);
      return this.adapter.craftWindowGrid(grid, 3);
    } else {
      // 2x2 in player inventory crafting
      await this.adapter.openPlayerCraft();
      await wait(150);
      return this.adapter.craftWindowGrid(grid, 2);
    }
  },

  /* =============== Mining / Placing =============== */
  async mine(blockId, tool, tier, count=1){
    FLOG(`Mine ${blockId} x${count}`);
    // locate closest matching block
    for(let i=0;i<count;i++){
      const p = await this.findNearbyBlock(blockId, 64);
      if (!p){ FLOG('Block not found nearby:', blockId); return false; }
      await this.pathTo(p.adj || {x:p.x,y:p.y,z:p.z});
      await this.adapter.lookAt(p);
      const ok = await this.adapter.breakBlock(p);
      if (!ok){ FLOG('Break failed'); return false; }
      await wait(80);
    }
    return true;
  },

  async place(blockId, pos, face=[0,1,0]){
    await this.adapter.selectHotbar(blockId);
    await this.pathTo(pos);
    await this.adapter.lookAt(pos);
    return this.adapter.placeBlock(pos, face);
  },

  /* =============== Smelting / Hunting (stubs hooked) =============== */
  async smelt(input, output, count){
    const furnace = await this.findNearbyBlock('furnace', 8);
    if (!furnace){ FLOG('No furnace nearby'); return false; }
    await this.pathTo(furnace);
    return this.adapter.smelt(furnace, input, 'coal', count);
  },

  async hunt(mobName, count){
    // naive: go to nearest entity by name & attack
    for(let i=0;i<count;i++){
      const ent = await this.adapter.findNearestMob(mobName, 48);
      if (!ent){ FLOG('No mob found:', mobName); return false; }
      await this.pathTo(ent.pos);
      await this.adapter.attackEntity(ent);
      await wait(300);
    }
    return true;
  },

  /* =============== Pathfinding (2.5D A*) =============== */
  async pathTo(target){
    const start = await this.adapter.playerPos();
    const path = this.astar({x:Math.floor(start.x),y:Math.floor(start.y),z:Math.floor(start.z)},
                            {x:Math.floor(target.x),y:Math.floor(target.y),z:Math.floor(target.z)});
    if (!path) { FLOG('No path'); return false; }
    FLOG('Path len:', path.length);
    for (const wp of path){
      await this.adapter.moveTo(wp);
    }
    return true;
  },

  neighbors(n){
    const ret = [];
    const dirs = [[1,0],[ -1,0 ],[0,1],[0,-1]];
    for (const [dx,dz] of dirs){
      const nx = n.x+dx, nz=n.z+dz;
      // vertical step check
      let ny = n.y;
      if (!this.isPassable(nx,ny,nz)) {
        // try step up
        if (this.isPassable(nx,ny+1,nz) && (ny+1 - n.y) <= this.settings.stepHeight) ny++;
        else continue;
      }
      // fall if air below
      while (this.isPassable(nx,ny-1,nz) && ny>0) ny--;
      ret.push({x:nx,y:ny,z:nz});
    }
    return ret;
  },

  isPassable(x,y,z){
    // player needs 2 blocks of headroom at (x,y) and (x,y+1)
    const b1 = this.adapter.blockIdAt({x,y,z});
    const b2 = this.adapter.blockIdAt({x,y:y+1,z});
    const solid = id => id && id!=='air' && id!=='water' && id!=='tall_grass';
    return !solid(b1) && !solid(b2);
  },

  astar(start, goal){
    const key = p=>`${p.x},${p.y},${p.z}`;
    const open = new Map(); const openPQ = [];
    const came = new Map(); const g = new Map();
    const h = (a,b)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y)+Math.abs(a.z-b.z);

    const push = (n, fscore)=>{
      open.set(key(n), {n, f:fscore});
      openPQ.push({k:key(n), f:fscore});
    };
    const pop = ()=>{
      if (!openPQ.length) return null;
      let idx=0; for(let i=1;i<openPQ.length;i++) if (openPQ[i].f < openPQ[idx].f) idx=i;
      const it = openPQ.splice(idx,1)[0];
      const o = open.get(it.k); open.delete(it.k); return o?.n || null;
    };

    push(start, h(start,goal));
    g.set(key(start), 0);

    let iter=0;
    while (open.size){
      if (++iter > this.settings.maxNodes) break;
      const current = pop(); if (!current) break;
      if (key(current) === key(goal)){
        // reconstruct
        const path=[current]; let k=key(current);
        while (came.has(k)){ const prev = came.get(k); path.push(prev); k=key(prev); }
        path.reverse();
        return path;
      }
      for (const nb of this.neighbors(current)){
        const tentative = g.get(key(current)) + 1;
        if (tentative < (g.get(key(nb)) ?? Infinity)){
          came.set(key(nb), current);
          g.set(key(nb), tentative);
          push(nb, tentative + h(nb,goal));
        }
      }
    }
    return null;
  },

  /* =============== Block Search =============== */
  async findNearbyBlock(blockId, radius=16){
    const p = await this.adapter.playerPos();
    const start = {x:Math.floor(p.x), y:Math.floor(p.y), z:Math.floor(p.z)};
    let best=null, bestD=1e9;
    for (let y=start.y-4; y<=start.y+4; y++){
      for (let x=start.x-radius; x<=start.x+radius; x++){
        for (let z=start.z-radius; z<=start.z+radius; z++){
          const id = this.adapter.blockIdAt({x,y,z});
          if (id===blockId){
            const d = Math.abs(x-start.x)+Math.abs(y-start.y)+Math.abs(z-start.z);
            if (d<bestD) { bestD=d; best={x,y,z}; }
          }
        }
      }
    }
    if (!best) return null;
    // find adjacent standable
    for (const [dx,dy,dz] of FACE_DIRS){
      const adj = {x:best.x+dx, y:best.y+dy, z:best.z+dz};
      if (this.isPassable(adj.x,adj.y,adj.z)) return Object.assign(best,{adj});
    }
    return best;
  },

  /* =============== Build Canvas (simple pixel -> block) =============== */
  build:{
    palette:[],
    current:'stone',
    initPalette(list){
      this.palette = list;
      const pal = document.getElementById('palette');
      pal.innerHTML = '';
      list.forEach(b=>{
        const btn = document.createElement('button');
        btn.textContent = b; btn.onclick = ()=>{ F1shPr0.build.current=b; };
        pal.appendChild(btn);
      });
    },
    newCanvas(){
      const c = document.getElementById('buildCanvas');
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#000'; ctx.fillRect(0,0,c.width,c.height);
      c.onmousedown = e=>{
        const r = c.getBoundingClientRect();
        const x = Math.floor((e.clientX-r.left)/8)*8;
        const y = Math.floor((e.clientY-r.top)/8)*8;
        ctx.fillStyle = '#fff';
        ctx.fillRect(x,y,8,8);
        ctx.fillStyle = '#0f0';
        ctx.fillText(F1shPr0.build.current, x+1,y+7);
      };
    },
    async run(){
      FLOG('Build runner (demo): place a small 3x3 torch grid');
      const p = await F1shPr0.adapter.playerPos();
      for (let dx=-1; dx<=1; dx++){
        for (let dz=-1; dz<=1; dz++){
          await F1shPr0.place('torch',{x:Math.floor(p.x)+dx, y:Math.floor(p.y), z:Math.floor(p.z)+dz}, [0,1,0]);
          await wait(120);
        }
      }
      FLOG('Build done.');
    }
  },

  /* =============== Eagler Adapter (auto detect) =============== */
  detectAdapter(){
    if (EAGLER_MODE==='sim') return Adapters.sim();
    try{
      // Heuristic probes (works on most Eaglercraft 1.8.8 builds)
      const g = window;
      const mc = g.minecraft || g.Minecraft || g.client || g.theMinecraft || null;
      const player = g.thePlayer || mc?.thePlayer || g.player || null;
      const world = g.theWorld || mc?.theWorld || g.world || null;
      if (mc && player && world) return Adapters.eagler(mc, world, player);
      if (EAGLER_MODE==='force') return Adapters.eagler(mc||{}, world||{}, player||{});
    }catch(e){}
    return Adapters.sim();
  }
};

/* ======================= Adapters ======================= */
const Adapters = {
  /* ---------- Simulation adapter (safe fallback) ---------- */
  sim(){
    FLOG('Adapter: simulation');
    const store = { pos:{x:0,y:64,z:0}, yaw:0, pitch:0 };
    return {
      kind:'sim',
      async playerPos(){ return {...store.pos}; },
      blockIdAt(p){ return 'air'; },
      async moveTo(p){ FLOG(`(sim) move -> ${p.x},${p.y},${p.z}`); await wait(25); },
      async lookAt(p){ FLOG(`(sim) look at ${p.x},${p.y},${p.z}`); },
      async breakBlock(p){ FLOG(`(sim) break ${p.x},${p.y},${p.z}`); await wait(50); return true; },
      async placeBlock(p, face){ FLOG(`(sim) place at ${p.x},${p.y},${p.z}`); return true; },
      async selectHotbar(item){ FLOG(`(sim) select ${item}`); },
      async openPlayerCraft(){ FLOG('(sim) open 2x2 craft'); return true; },
      async craftWindowGrid(grid, size){ FLOG(`(sim) craft ${size}x size with grid`, grid); await wait(50); return true; },
      async useBlock(p){ FLOG('(sim) use block', p); },
      async smelt(furnace, input, fuel, count){ FLOG(`(sim) smelt ${input} -> (count:${count})`); return true; },
      async findNearestMob(name, r){ FLOG(`(sim) find mob ${name}`); return {name, pos:{x:2,y:64,z:2}}; },
      async attackEntity(ent){ FLOG('(sim) attack', ent.name); return true; },
    };
  },

  /* ---------- Eaglercraft 1.8.8 adapter ---------- */
  eagler(mc, world, player){
    FLOG('Adapter: Eaglercraft detected');
    // These will vary between builds; we keep calls conservative and guarded.
    const safe = (fn, ret=false)=>{ try{ return fn(); }catch(e){ return ret; } };

    return {
      kind:'eagler',
      async playerPos(){
        return { x:player.posX, y:player.posY, z:player.posZ };
      },
      blockIdAt(p){
        const blk = safe(()=>world.getBlockState(new mc.BlockPos(p.x,p.y,p.z)).getBlock(), null);
        const id = blk ? mc.Block.blockRegistry.getNameForObject(blk).toString() : 'air';
        // normalize some names to our items.json ids
        return id.replace('minecraft:','').replace('log2','oak_log'); // naive normalization
      },
      async moveTo(wp){
        // very simple steering: face target, walk forward; stop when close
        const pos = await this.playerPos();
        const dx = wp.x + 0.5 - pos.x, dz = wp.z + 0.5 - pos.z;
        const yaw = Math.atan2(-dx, dz) * 180/Math.PI;
        player.rotationYaw = yaw;
        player.moveForward = 1.0;
        let t=0;
        while (Math.hypot(wp.x+0.5 - player.posX, wp.z+0.5 - player.posZ) > 0.35 && t<600){
          await wait(16); t++;
        }
        player.moveForward = 0.0;
      },
      async lookAt(p){
        const pos = await this.playerPos();
        const dx = p.x + 0.5 - pos.x, dy = p.y + 0.5 - pos.y, dz = p.z + 0.5 - pos.z;
        const yaw = Math.atan2(-dx, dz) * 180/Math.PI;
        const pitch = -Math.atan2(dy, Math.hypot(dx,dz)) * 180/Math.PI;
        player.rotationYaw = yaw; player.rotationPitch = pitch;
        await wait(20);
      },
      async breakBlock(p){
        // Raycast + start/stop dig packets
        const bp = new mc.BlockPos(p.x,p.y,p.z);
        const face = mc.EnumFacing.UP;
        player.swingItem();
        playerController.onPlayerDamageBlock(bp, face);
        const start = Date.now();
        while (this.blockIdAt(p) !== 'air' && (Date.now()-start) < F1shPr0.settings.breakTimeout){
          player.swingItem();
          playerController.onPlayerDamageBlock(bp, face);
          await wait(80);
        }
        return this.blockIdAt(p) === 'air';
      },
      async placeBlock(p, faceArr){
        const bp = new mc.BlockPos(p.x,p.y,p.z);
        const face = mc.EnumFacing.UP;
        playerController.processRightClickBlock(player, world, bp, face, player.getLookVec(), mc.EnumHand.MAIN_HAND);
        await wait(60);
        return true;
      },
      async selectHotbar(itemId){
        // naive: scan hotbar for any stack whose id contains itemId
        const inv = player.inventory;
        for (let i=0;i<9;i++){
          const s = inv.mainInventory[i];
          if (!s) continue;
          const id = mc.Item.itemRegistry.getNameForObject(s.getItem()).toString().replace('minecraft:','');
          if (id.includes(itemId)){ inv.currentItem = i; break; }
        }
        await wait(10);
      },
      async openPlayerCraft(){
        // just opens inventory; 2x2 craft is in player inventory window
        player.openContainer.onContainerOpened(player);
        await wait(80);
        return true;
      },
      async craftWindowGrid(grid, size){
        // Translate grid positions into slot indices.
        // Player 2x2 craft slots (vanilla): 1,2,5,6 (varies by build). We'll probe by type names.
        // Crafting Table 3x3 slots (vanilla): 1..9. We try to locate by container type.
        const ci = player.openContainer;
        const slots = ci.inventorySlots; // List<Slot>
        const isTable = slots.length >= 46; // crafting table container usually bigger than player inv
        // Map grid -> input slots:
        let mapSlots = [];
        if (size===2 && !isTable){
          // heuristic for 2x2: find first 4 non-player slots that precede result
          // result slot likely at index 0; inputs at 1..4
          mapSlots = [1,2,3,4];
        } else {
          // 3x3: assume 1..9 inputs
          mapSlots = [1,2,3,4,5,6,7,8,9];
        }
        // Clear inputs
        for (const si of mapSlots) await this.shiftClickOut(slots[si]);
        // Put items per grid
        const flat = [];
        for (let r=0;r<3;r++) for(let c=0;c<3;c++) flat.push(grid[r]?.[c]||null);
        for (let i=0;i<mapSlots.length;i++){
          const want = flat[i];
          if (!want) continue;
          await this.placeFromInv(mapSlots[i], want, 1);
        }
        // shift-click result (slot 0)
        await this.takeResult(slots[0]);
        return true;
      },
      async shiftClickOut(slot){ /* optional: cleanup */ },
      async placeFromInv(targetSlot, itemId, qty){
        // Find item in player inventory; click to move to targetSlot the amount
        // This is highly build-specific; fallback to controller.click
        // For many Eagler builds:
        playerController.windowClick(player.openContainer.windowId, targetSlot, 0, 0, player);
        await wait(30);
      },
      async takeResult(resultSlot){
        // Click result to craft once
        playerController.windowClick(player.openContainer.windowId, 0, 0, 0, player);
        await wait(40);
      },
      async useBlock(pos){
        const bp = new mc.BlockPos(pos.x,pos.y,pos.z);
        playerController.processRightClickBlock(player, world, bp, mc.EnumFacing.UP, player.getLookVec(), mc.EnumHand.MAIN_HAND);
      },
      async smelt(furnacePos, input, fuel, count){
        // Open furnace GUI and place items (simplified – many builds differ)
        await this.useBlock(furnacePos);
        await wait(120);
        // TODO: slot indices 0=input,1=fuel,2=out in most builds:
        return true;
      },
      async findNearestMob(name, radius){
        // scan loaded entity list
        let best=null, bestD=1e9;
        const me = await this.playerPos();
        for (const e of world.loadedEntityList){
          if (!e || !e.getName) continue;
          if (e.getName().toLowerCase().includes(name.toLowerCase())){
            const d = Math.abs(e.posX-me.x)+Math.abs(e.posY-me.y)+Math.abs(e.posZ-me.z);
            if (d<bestD) { best=e; bestD=d; }
          }
        }
        return best ? {name:best.getName(), pos:{x:best.posX,y:best.posY,z:best.posZ}, raw:best} : null;
      },
      async attackEntity(ent){
        playerController.attackEntity(player, ent.raw);
        player.swingItem();
        await wait(120);
        return true;
      }
    };
  }
};

/* ================ expose commands ================ */
F1shPr0.cmdGoto = function(){
  const x = +document.getElementById('gotoX').value;
  const y = +document.getElementById('gotoY').value;
  const z = +document.getElementById('gotoZ').value;
  this.enqueue({type:'goto', pos:{x,y,z}});
  this.runTasks();
};
F1shPr0.cmdTrack = async function(){
  const name = document.getElementById('trackName').value;
  const ent = await this.adapter.findNearestMob(name, 64);
  if (!ent){ FLOG('No player/mob found'); return; }
  this.enqueue({type:'goto', pos:ent.pos});
  this.runTasks();
};

/* init */
window.onload = ()=>F1shPr0.init();
