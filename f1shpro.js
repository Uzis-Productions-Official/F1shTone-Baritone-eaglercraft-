/* F1shPr0 – Standalone client (SIM) with build canvas + planner
 * - Works by itself (no game needed)
 * - If items.json exists, loads it; otherwise uses a safe fallback set
 */

const DEFAULT_ITEMS = {
  // minimal fallback so UI never breaks; replace with your full items.json
  "oak_log": { from:"mining", block:"oak_log", tool:"axe" },
  "planks": { craftable:true, count:4, recipe:[
    ["oak_log",null,null],[null,null,null],[null,null,null]
  ]},
  "stick": { craftable:true, count:4, recipe:[
    [null,null,null],["planks",null,null],["planks",null,null]
  ]},
  "crafting_table": { craftable:true, count:1, recipe:[
    ["planks","planks",null],["planks","planks",null],[null,null,null]
  ]},
  "cobblestone": { from:"mining", block:"stone", tool:"pickaxe" },
  "stone": { from:"smelting", input:"cobblestone" },
  "furnace": { craftable:true, count:1, recipe:[
    ["cobblestone","cobblestone","cobblestone"],
    ["cobblestone",null,"cobblestone"],
    ["cobblestone","cobblestone","cobblestone"]
  ]},
  "torch": { craftable:true, count:4, recipe:[
    [null,null,null],["coal",null,null],["stick",null,null]
  ]},
  "coal": { from:"mining", block:"coal_ore", tool:"pickaxe" },
  "stone_bricks": { craftable:true, count:4, recipe:[
    [null,null,null],["stone","stone",null],["stone","stone",null]
  ]},
  "glass": { from:"smelting", input:"sand" },
  "sand": { from:"mining", block:"sand", tool:"shovel" }
};

const F1 = {
  state: {
    items: {},
    settings: { maxNodes: 4000, stepHeight: 1, breakMs: 6000 },
    inventory: {}, // id -> count
    currentBlock: "stone",
    px: 1,
    blueprint: null,
    paletteFilter: ""
  },

  async init() {
    // Keybinds
    document.addEventListener("keydown", (e) => {
      if (e.code === "ShiftRight") F1.ui.toggle(true);
      if (e.code === "ControlRight") F1.ui.toggle(false);
    });

    // Load items.json (fallback to DEFAULT_ITEMS)
    try {
      const res = await fetch("items.json", { cache: "no-store" });
      if (!res.ok) throw new Error(res.statusText);
      this.state.items = await res.json();
      this.ui.log(`Loaded items.json (${Object.keys(this.state.items).length} entries)`);
    } catch {
      this.state.items = DEFAULT_ITEMS;
      this.ui.log("items.json not found; using fallback items");
    }

    // Build UI defaults
    this.ui.sectionHome();
    this.build.initPalette(Object.keys(this.state.items)
      .filter(k => !this.state.items[k].recipe || this.state.items[k].from === "mining")
      .slice(0, 200)); // keep palette compact

    // Settings persist
    const s = localStorage.getItem("f1.settings");
    if (s) Object.assign(this.state.settings, JSON.parse(s));
    document.getElementById("optMaxNodes").value = this.state.settings.maxNodes;
    document.getElementById("optStep").value = this.state.settings.stepHeight;
    document.getElementById("optBreakMs").value = this.state.settings.breakMs;

    document.getElementById("modePill").textContent = "mode: sim";
  },

  /* ---------------- UI ---------------- */
  ui: {
    toggle(on) {
      const m = document.getElementById("f1Menu");
      m.style.display = on ? "block" : "none";
    },
    tab(name) {
      ["home", "build", "settings"].forEach(t => {
        document.getElementById("view" + t.charAt(0).toUpperCase() + t.slice(1)).style.display =
          t === name ? "block" : "none";
        document.getElementById("tab" + t.charAt(0).toUpperCase() + t.slice(1)).classList.toggle("active", t === name);
      });
    },
    sectionHome() {
      const p = document.getElementById("panelHome");
      p.innerHTML = `
        <div class="row">
          <input id="getItemInput" placeholder="Type an item (e.g. torch)" oninput="F1.ui.suggest()" />
          <button class="btn primary" onclick="F1.startGet()">Get</button>
        </div>
        <div id="suggestions" class="muted"></div>
        <div style="height:6px"></div>
        <div class="row">
          <input id="gotoX" placeholder="X" style="width:30%">
          <input id="gotoY" placeholder="Y" style="width:30%">
          <input id="gotoZ" placeholder="Z" style="width:30%">
          <button class="btn" onclick="F1.cmdGoto()">Goto</button>
        </div>
        <div class="row">
          <input id="trackName" placeholder="Player name">
          <button class="btn" onclick="F1.cmdTrack()">Track</button>
        </div>
      `;
    },
    suggest() {
      const q = document.getElementById("getItemInput").value.toLowerCase();
      if (!q) { document.getElementById("suggestions").textContent = ""; return; }
      const keys = Object.keys(F1.state.items);
      const m = keys.filter(k => k.includes(q)).slice(0, 10);
      document.getElementById("suggestions").textContent = m.length ? "Suggestions: " + m.join(", ") : "No matches";
    },
    quick() {
      document.getElementById("getItemInput").value = "wooden_pickaxe";
      F1.startGet();
    },
    clearLog() { document.getElementById("botLog").innerHTML = ""; },
    log(msg) {
      const el = document.getElementById("botLog");
      const t = new Date().toLocaleTimeString();
      el.innerHTML = `[${t}] ${msg}<br>` + el.innerHTML;
    }
  },

  saveSettings() {
    const g = id => +document.getElementById(id).value;
    this.state.settings.maxNodes = g("optMaxNodes");
    this.state.settings.stepHeight = +document.getElementById("optStep").value;
    this.state.settings.breakMs = g("optBreakMs");
    localStorage.setItem("f1.settings", JSON.stringify(this.state.settings));
    this.ui.log("Settings saved");
  },
  resetSettings() { localStorage.removeItem("f1.settings"); location.reload(); },

  /* ---------------- Planner (SIM) ---------------- */
  startGet() {
    const item = document.getElementById("getItemInput").value.trim().toLowerCase();
    if (!item) return;
    if (!this.state.items[item]) { this.ui.log(`Unknown item: ${item}`); return; }
    this.obtainItem(item, 1);
  },

  async obtainItem(item, count) {
    const def = this.state.items[item];
    this.ui.log(`Obtain <span class="k">${item}</span> ×${count}`);

    // inventory check
    if ((this.state.inventory[item] || 0) >= count) { this.ui.log(`Already have ${count}`); return true; }

    if (def?.craftable) {
      // count inputs
      const perCraftOut = def.count || 1;
      const crafts = Math.ceil(count / perCraftOut);
      const need = {};
      def.recipe.forEach(row => row.forEach(cell => { if (cell) need[cell] = (need[cell] || 0) + crafts; }));
      for (const [ing, qty] of Object.entries(need)) {
        const have = this.state.inventory[ing] || 0;
        if (have < qty) await this.obtainItem(ing, qty - have);
      }
      // “craft”
      this.addInv(item, perCraftOut * crafts);
      this.ui.log(`Crafted <span class="k">${item}</span> ×${perCraftOut * crafts}`);
      return true;
    }

    if (def?.from === "mining") {
      this.ui.log(`Mine block <span class="k">${def.block || item}</span> (tool: ${def.tool || "any"})`);
      this.addInv(item, def.count || 1);
      return true;
    }
    if (def?.from === "smelting") {
      await this.obtainItem("furnace", 1);
      await this.obtainItem(def.input, count);
      await this.obtainItem("coal", 1).catch(()=>{});
      this.addInv(item, count);
      this.ui.log(`Smelted <span class="k">${item}</span> ×${count}`);
      return true;
    }

    this.ui.log(`No acquisition path for ${item}`);
    return false;
  },

  addInv(id, n) {
    this.state.inventory[id] = (this.state.inventory[id] || 0) + n;
    this.ui.log(`Inventory: +${n} ${id} (now ${this.state.inventory[id]})`);
  },

  /* ---------------- Commands (SIM) ---------------- */
  cmdGoto() {
    const x = +document.getElementById("gotoX").value;
    const y = +document.getElementById("gotoY").value;
    const z = +document.getElementById("gotoZ").value;
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      this.ui.log(`Pathfinding to (${x},${y},${z}) … (sim)`);
    } else {
      this.ui.log("Invalid coordinates");
    }
  },
  cmdTrack() {
    const name = (document.getElementById("trackName").value||"").trim();
    if (!name) return this.ui.log("Enter a player name");
    this.ui.log(`Tracking ${name} … (sim)`);
  },

  /* ---------------- Build system ---------------- */
  build: {
    palette: [],
    current: "stone",
    grid: null, // 2D array of block ids or null
    w: 32, h: 32,

    initPalette(list) {
      this.palette = list.length ? list : ["stone","cobblestone","planks","glass","torch","sand"];
      const pal = document.getElementById("palette");
      pal.innerHTML = "";
      this.palette.forEach(id => {
        const b = document.createElement("button");
        b.className = "btn palbtn";
        b.textContent = id;
        b.onclick = () => {
          F1.state.currentBlock = id;
          document.getElementById("currentBlock").textContent = id;
        };
        pal.appendChild(b);
      });

      // canvas + grid
      this.w = 32; this.h = 32;
      this.grid = Array.from({length:this.h}, ()=>Array(this.w).fill(null));
      this.bindCanvas();
      document.getElementById("pxSize").value = "1";
      F1.state.px = 1;
      document.getElementById("currentBlock").textContent = F1.state.currentBlock;
    },

    bindCanvas() {
      const c = document.getElementById("buildCanvas");
      const ctx = c.getContext("2d");
      const cell = 8; // visual pixel size inside canvas (fixed UI size)
      const drawGrid = ()=>{
        ctx.fillStyle = "#000"; ctx.fillRect(0,0,c.width,c.height);
        // draw pixels
        for (let y=0;y<this.h;y++){
          for (let x=0;x<this.w;x++){
            const id = this.grid[y][x];
            if (!id) continue;
            ctx.fillStyle = "#ddd";
            ctx.fillRect(x*cell, y*cell, cell, cell);
            ctx.fillStyle = "#0f0";
            ctx.fillText(id.slice(0,6), x*cell+1, y*cell+7);
          }
        }
        // gridlines
        ctx.strokeStyle = "#111";
        for (let i=0;i<=this.w;i++){ ctx.beginPath(); ctx.moveTo(i*cell,0); ctx.lineTo(i*cell,c.height); ctx.stroke(); }
        for (let i=0;i<=this.h;i++){ ctx.beginPath(); ctx.moveTo(0,i*cell); ctx.lineTo(c.width,i*cell); ctx.stroke(); }
      };
      drawGrid();

      let painting = false, erasing = false;
      const hit = (e)=>{
        const r = c.getBoundingClientRect();
        const x = Math.floor((e.clientX - r.left) / (c.width/this.w));
        const y = Math.floor((e.clientY - r.top)  / (c.height/this.h));
        return {x,y};
      };
      const paint = (e)=>{
        const {x,y} = hit(e);
        if (x<0||y<0||x>=this.w||y>=this.h) return;
        this.grid[y][x] = erasing ? null : F1.state.currentBlock;
        drawGrid();
      };
      c.oncontextmenu = (e)=>{ e.preventDefault(); return false; };
      c.addEventListener("mousedown", (e)=>{ painting = true; erasing = (e.button===2); paint(e); });
      c.addEventListener("mousemove", (e)=>{ if (painting) paint(e); });
      window.addEventListener("mouseup", ()=>{ painting=false; });
    },

    changePx(){
      F1.state.px = +document.getElementById("pxSize").value;
      F1.ui.log(`Pixel size set to ${F1.state.px} (1 px = ${F1.state.px}×${F1.state.px} blocks)`);
    },

    filterPalette(){
      const q = (document.getElementById("searchBlock").value||"").toLowerCase();
      const pal = document.getElementById("palette");
      for (const btn of pal.querySelectorAll(".palbtn")){
        btn.style.display = btn.textContent.toLowerCase().includes(q) ? "block" : "none";
      }
    },

    clear(){
      for (let y=0;y<this.h;y++) for (let x=0;x<this.w;x++) this.grid[y][x]=null;
      document.getElementById("materials").innerHTML = "";
      const c = document.getElementById("buildCanvas");
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#000"; ctx.fillRect(0,0,c.width,c.height);
      F1.ui.log("Canvas cleared");
    },

    generate(){
      // convert 2D pixel grid -> block blueprint at ground plane (y = 0)
      const px = F1.state.px;
      const plan = [];
      const counts = {};
      for (let y=0;y<this.h;y++){
        for (let x=0;x<this.w;x++){
          const id = this.grid[y][x];
          if (!id) continue;
          for (let dy=0; dy<px; dy++){
            for (let dx=0; dx<px; dx++){
              const bx = x*px + dx;
              const bz = y*px + dy;
              plan.push({ x:bx, y:0, z:bz, id });
              counts[id] = (counts[id]||0)+1;
            }
          }
        }
      }
      F1.state.blueprint = { origin:{x:0,y:0,z:0}, blocks:plan, counts };
      // show materials
      const lines = Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`• ${k}: <b>${v}</b>`).join("<br>");
      document.getElementById("materials").innerHTML = `<div><b>Materials</b></div>${lines||"<i>No blocks</i>"}`;
      F1.ui.log(`Blueprint generated: ${plan.length} placements`);
    },

    export(){
      if (!F1.state.blueprint){ F1.ui.log("Generate a blueprint first"); return; }
      const data = JSON.stringify(F1.state.blueprint, null, 2);
      const blob = new Blob([data], {type:"application/json"});
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "blueprint.json";
      a.click();
      URL.revokeObjectURL(url);
      F1.ui.log(`Exported blueprint.json`);
    },

    async simulate(){
      if (!F1.state.blueprint){ F1.ui.log("Generate a blueprint first"); return; }
      // Ensure materials available (plan acquisitions)
      for (const [id, need] of Object.entries(F1.state.blueprint.counts)){
        const have = F1.state.inventory[id] || 0;
        if (have < need) await F1.obtainItem(id, need - have);
      }
      // Place in reading order
      let i=0;
      for (const step of F1.state.blueprint.blocks){
        F1.ui.log(`Place ${step.id} at (${step.x},${step.y},${step.z}) — (sim)`);
        // consume inventory
        F1.state.inventory[step.id] = Math.max(0, (F1.state.inventory[step.id]||1) - 1);
        i++; if (i%64===0) await new Promise(r=>setTimeout(r,10));
      }
      F1.ui.log(`Simulated ${i} placements`);
    }
  }
};

/* ------------- expose UI helpers ------------- */
F1.ui.get = ()=>F1.ui.sectionHome();
F1.ui.goto = ()=>F1.ui.sectionHome();
F1.ui.track = ()=>F1.ui.sectionHome();

/* ------------- boot ------------- */
window.onload = ()=>F1.init();
