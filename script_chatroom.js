/* Load this file BEFORE script.letter-of-records.js — Sections 1 & 2 (outside the chatroom + inside/connecting the chatroom). Plain global scope, no module wrapper. */

/* ################################################################################
   SECTION 1 — OUTSIDE THE CHATROOM (app shell + shared infra)
   Everything that isn't the story/roleplay itself, plus the shared plumbing
   that connects the chatroom to the outside world: IndexedDB storage, screen
   navigation, the library (world list), the world editor, settings, usage
   stats, the lock screen / PIN flow, image resizing, and the core AI-calling
   layer (askAI, askAIWithRetry, usage tracking, JSON extraction, the async
   world-op queue). Section 2 and Section 3 both call into this section, so
   this section must load FIRST in index.html.
################################################################################ */

// ================= storage (IndexedDB — fully local, on-device, no account needed) =================
const INDEX_KEY = 'wc_index_v2';
const IDB_NAME = 'worlds_catalog_db';
const IDB_STORE = 'kv';
let _idbPromise = null;

// Without this, IndexedDB here is only "best-effort" storage — Android Chrome (and other
// browsers) are allowed to silently evict it under disk pressure, with no warning to the
// player, no matter how careful the code above is about never overwriting Identity/Finances/
// Inventory itself. Asking for persistent storage tells the browser this origin's data should
// be treated the same as an installed app's and left alone unless the player clears it
// themselves. Best-effort (the browser can still say no, mainly on iOS Safari), but there's no
// downside to asking, and it's the one piece of "stored forever" that isn't under this app's
// own control at all.
if(navigator.storage && navigator.storage.persist){
  navigator.storage.persist().catch(()=>{});
}

function openDB(){
  if(_idbPromise) return _idbPromise;
  _idbPromise = new Promise((resolve, reject)=>{
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = ()=>{ req.result.createObjectStore(IDB_STORE); };
    req.onsuccess = ()=> resolve(req.result);
    req.onerror = ()=> reject(req.error);
  });
  return _idbPromise;
}

async function kvGet(key){
  try{
    const db = await openDB();
    return await new Promise((resolve)=>{
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = ()=> resolve(req.result !== undefined ? req.result : null);
      req.onerror = ()=> resolve(null);
    });
  }catch(e){ return null; }
}
async function kvSet(key, val){
  try{
    const db = await openDB();
    await new Promise((resolve, reject)=>{
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(val, key);
      tx.oncomplete = resolve; tx.onerror = ()=> reject(tx.error);
    });
  }catch(e){ console.error('save failed', e); }
}
async function kvDel(key){
  try{
    const db = await openDB();
    await new Promise((resolve)=>{
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = resolve; tx.onerror = resolve;
    });
  }catch(e){}
}

async function getIndex(){ return (await kvGet(INDEX_KEY)) || []; }
async function saveIndex(list){ await kvSet(INDEX_KEY, list); }
async function getWorld(id){ return await kvGet('wc_world_'+id); }
async function saveWorld(w){ await kvSet('wc_world_'+w.id, w); }
async function deleteWorldData(id){ await kvDel('wc_world_'+id); await kvDel('wc_chat_'+id); await kvDel('wc_mem_'+id); await kvDel('wc_panel_'+id); }
async function getChat(id){ return (await kvGet('wc_chat_'+id)) || []; }
async function saveChat(id, msgs){ await kvSet('wc_chat_'+id, msgs); }
async function getMemory(id){ return (await kvGet('wc_mem_'+id)) || ''; }
async function saveMemory(id, mem){ await kvSet('wc_mem_'+id, mem); }

// ================= image handling =================
function resizeImageToDataUrl(file, maxSize=640, quality=0.8){
  return new Promise((resolve, reject)=>{
    const img = new Image(); const reader = new FileReader();
    reader.onload = e => { img.onload = ()=>{
      let {width, height} = img;
      if(width > height){ if(width > maxSize){ height *= maxSize/width; width = maxSize; } }
      else { if(height > maxSize){ width *= maxSize/height; height = maxSize; } }
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    }; img.onerror = reject; img.src = e.target.result; };
    reader.onerror = reject; reader.readAsDataURL(file);
  });
}

// ================= state / navigation =================
let state = { editingId:null, chattingId:null, pendingCover:null, pendingBg:null };
const els = {};
['library','libGrid','libEmpty','worldCount','editor','editorCloseBtn','editorTitle','chatScreen','chatBody','chatBackBtn',
 'avatarPreview','fileInput','bgPreview','bgClearBtn','bgFileInput','fName','fLore','fOpening','editorLockNote','saveCardBtn','deleteCardBtn',
 'chatAvatar','chatName','chatBg','chatHeader','chatFooter','chatSettingsBtn','log','textInput','sendBtn','panelBtn',
 'searchInput','memoryModal','memoryContent','closeMemoryBtn',
 'panelModal','panelContent','closePanelBtn','panelTabBar','catInfoModal','closeCatInfoBtn',
 'invModal','invContent','closeInvBtn','invWorldName',
 'relInfoModal','relInfoContent','relInfoName','closeRelInfoBtn',
 'chatSettingsModal','csMemoryBtn','csExportBtn','csImportIntoBtn','csImportIntoFileInput',
 'msgCtxMenu','msgCtxOverlay','msgCtxCopy','msgCtxDelete',
 'mediaDrawerOverlay','mediaDrawer','mediaFileInput','mediaPhotoBtn','mediaGifBtn','mediaVideoBtn',
 'cardCtxMenu','cardCtxOverlay','cardCtxEdit','cardCtxDownload','cardCtxImport','cardCtxDelete','cardCtxImportFileInput',
 'addDrawerOverlay','addDrawer','addDrawerNewBtn','addDrawerImportBtn','addDrawerImportFileInput'
].forEach(id => els[id] = document.getElementById(id));

function playScreenIn(el){ if(!el) return; el.classList.remove('screen-in'); void el.offsetWidth; el.classList.add('screen-in'); }
function hideAllScreens(){
  document.getElementById('homeScreen').style.display='none';
  els.editor.style.display='none'; els.chatScreen.style.display='none';
  document.getElementById('messagesScreen').style.display='none';
  document.getElementById('settingsScreen').style.display='none';
  document.getElementById('usageScreen').style.display='none';
}
function showLibrary(){ setActiveTab('library'); hideAllScreens(); document.getElementById('homeScreen').style.display='block';
  document.getElementById('bottomNav').style.display='flex'; playScreenIn(document.getElementById('homeScreen')); }
function showEditor(){ hideAllScreens();
  els.editor.style.display='block';
  document.getElementById('bottomNav').style.display='none';
  els.editor.classList.remove('opening'); void els.editor.offsetWidth; els.editor.classList.add('opening'); }
function showChat(){ hideAllScreens();
  els.chatScreen.style.display='flex';
  document.getElementById('bottomNav').style.display='none'; syncChatPadding(); syncChatBgViewport(); playScreenIn(els.chatScreen); }

function showMessages(){ setActiveTab('messages'); hideAllScreens();
  document.getElementById('messagesScreen').style.display='block';
  document.getElementById('bottomNav').style.display='flex'; renderMessages(); playScreenIn(document.getElementById('messagesScreen')); }
function showSettings(){ setActiveTab('settings'); hideAllScreens();
  document.getElementById('settingsScreen').style.display='block';
  document.getElementById('bottomNav').style.display='flex'; renderSettings(); playScreenIn(document.getElementById('settingsScreen')); }
function showUsage(){ setActiveTab('usage'); hideAllScreens();
  document.getElementById('usageScreen').style.display='block';
  document.getElementById('bottomNav').style.display='flex'; renderUsage(); playScreenIn(document.getElementById('usageScreen')); }

function setActiveTab(tab){
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active', b.dataset.tab===tab));
}
document.querySelectorAll('.nav-item').forEach(btn=>{
  btn.onclick = ()=>{
    const tab = btn.dataset.tab;
    if(tab==='library'){ renderLibrary(); showLibrary(); pushNavState('library'); }
    else if(tab==='messages'){ showMessages(); pushNavState('messages'); }
    else if(tab==='usage'){ showUsage(); pushNavState('usage'); }
    else if(tab==='settings'){ showSettings(); pushNavState('settings'); }
    else if(tab==='new'){ openAddDrawer(); }
  };
});

function openAddDrawer(){
  els.addDrawerOverlay.style.display = 'block';
  els.addDrawer.classList.add('open');
  pushNavState('modal');
}
function closeAddDrawer(){
  els.addDrawerOverlay.style.display = 'none';
  els.addDrawer.classList.remove('open');
}
els.addDrawerOverlay.onclick = closeAddDrawer;
els.addDrawerNewBtn.onclick = ()=>{ closeAddDrawer(); openEditor(null); };
els.addDrawerImportBtn.onclick = ()=>{ closeAddDrawer(); els.addDrawerImportFileInput.click(); };
els.addDrawerImportFileInput.onchange = ()=>{
  const file = els.addDrawerImportFileInput.files[0];
  els.addDrawerImportFileInput.value = '';
  if(file) importWorldFromFile(file);
};

async function renderMessages(){
  const index = await getIndex();
  const rows = [];
  for(const w of index){
    const chat = await getChat(w.id);
    if(chat.length>0) rows.push({world:w, chat});
  }
  rows.sort((a,b)=> (b.chat[b.chat.length-1]?.ts||0) - (a.chat[a.chat.length-1]?.ts||0));
  const list = document.getElementById('msgList');
  list.innerHTML = '';
  document.getElementById('msgEmpty').classList.toggle('screen-hidden', rows.length>0);
  rows.forEach(({world, chat})=>{
    const last = chat[chat.length-1];
    const row = document.createElement('div'); row.className = 'conv-row';
    row.innerHTML = `
      ${world.cover ? `<img class="conv-avatar" src="${world.cover}">` : `<div class="conv-avatar placeholder">${world.name.charAt(0)}</div>`}
      <div class="conv-info">
        <div class="conv-name">${escapeHtml(world.name)}</div>
        <div class="conv-preview">${escapeHtml((last.role==='user'?'You: ':'') + (last.text || (last.media ? (last.media.kind==='video' ? '📹 Video' : '📷 Photo') : '')))}</div>
      </div>`;
    row.onclick = ()=> openStory(world.id);
    list.appendChild(row);
  });
}

async function getGeminiKey(){ return (await kvGet('wc_gemini_key')) || ''; }
async function saveGeminiKey(key){ await kvSet('wc_gemini_key', key); }
async function getGeminiModel(){ return (await kvGet('wc_gemini_model')) || 'gemini-3.6-flash'; }
async function saveGeminiModel(model){ await kvSet('wc_gemini_model', model); }
// Background work (memory summaries + the letter of records) is ONLY ever allowed to run on
// a Flash Lite model — never the full/non-lite models used for the main story. The settings
// dropdown already only offers the two Lite options, but that alone doesn't protect against
// a corrupted value, an old imported backup, or a direct edit to browser storage holding
// something else. This whitelists the stored value against the exact allowed set and falls
// back to the safe default rather than ever handing a non-lite model to a background call.
const ALLOWED_BG_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
const DEFAULT_BG_MODEL = 'gemini-3.5-flash-lite';
async function getGeminiBgModel(){
  const stored = await kvGet('wc_gemini_bg_model');
  return ALLOWED_BG_MODELS.includes(stored) ? stored : DEFAULT_BG_MODEL;
}
async function saveGeminiBgModel(model){
  // Refuse to persist anything outside the allowed set in the first place.
  await kvSet('wc_gemini_bg_model', ALLOWED_BG_MODELS.includes(model) ? model : DEFAULT_BG_MODEL);
}

async function renderSettings(){
  const key = await getGeminiKey();
  const statusEl = document.getElementById('geminiKeyStatus');
  document.getElementById('geminiKeyInput').value = key;
  statusEl.textContent = key ? '✓ Key saved — stories will use Gemini.' : 'No key saved yet — stories won\'t work until you add one.';
  document.getElementById('geminiModelSelect').value = await getGeminiModel();
  document.getElementById('geminiBgModelSelect').value = await getGeminiBgModel();
}
document.getElementById('saveGeminiKeyBtn').onclick = async ()=>{
  const val = document.getElementById('geminiKeyInput').value.trim();
  await saveGeminiKey(val);
  document.getElementById('geminiKeyStatus').textContent = val ? '✓ Key saved — stories will use Gemini.' : 'No key saved yet — stories won\'t work until you add one.';
}
document.getElementById('geminiModelSelect').onchange = async (e)=>{ await saveGeminiModel(e.target.value); };
document.getElementById('geminiBgModelSelect').onchange = async (e)=>{ await saveGeminiBgModel(e.target.value); };
document.getElementById('eraseAllBtn').onclick = async ()=>{
  if(!confirm('Erase every world and conversation? This can\'t be undone.')) return;
  const index = await getIndex();
  for(const w of index) await deleteWorldData(w.id);
  await saveIndex([]);
  await renderLibrary(); showLibrary();
};

els.editorCloseBtn.onclick = ()=>{ renderLibrary(); showLibrary(); };
els.chatBackBtn.onclick = ()=>{ renderLibrary(); showLibrary(); };

function formatBytes(n){
  if(!n && n !== 0) return '—';
  if(n < 1024) return n + ' B';
  if(n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
  if(n < 1024*1024*1024) return (n/(1024*1024)).toFixed(1) + ' MB';
  return (n/(1024*1024*1024)).toFixed(2) + ' GB';
}
function formatTokens(n){
  if(!n) return '0';
  if(n < 1000) return String(n);
  if(n < 1000000) return (n/1000).toFixed(1) + 'K';
  return (n/1000000).toFixed(2) + 'M';
}
const MODEL_LABELS = {
  'gemini-3.6-flash':'Gemini 3.6 Flash', 'gemini-3.5-flash':'Gemini 3.5 Flash',
  'gemini-3.5-flash-lite':'Gemini 3.5 Flash Lite', 'gemini-3.1-flash-lite':'Gemini 3.1 Flash Lite'
};
// Google doesn't return live account quota from the API, and published free-tier numbers
// shift over time / by account. These are reference daily limits from Google's current
// published docs (Aug 2026) — shown as an estimate, not a real-time balance.
const MODEL_DAILY_LIMIT = {
  'gemini-3.6-flash': 1500,
  'gemini-3.5-flash': 1500,
  'gemini-3.5-flash-lite': 1500,
  'gemini-3.1-flash-lite': 1500
};
async function renderUsage(){
  const key = await getGeminiKey();
  document.getElementById('usageNoKeyWarn').classList.toggle('screen-hidden', !!key);
  const currentModel = await getGeminiModel();

  const stats = (await kvGet('wc_usage_stats')) || { totalTokens:0, byDay:{}, byModel:{} };
  const today = new Date().toISOString().slice(0,10);
  const byModel = stats.byModel || {};

  const grid = document.getElementById('usageModelGrid');
  grid.innerHTML = '';
  Object.keys(MODEL_LABELS).forEach(mId=>{
    const entry = byModel[mId] || { requests:0, tokens:0, byDay:{} };
    const usedToday = (entry.byDay && entry.byDay[today]) || 0;
    const limit = MODEL_DAILY_LIMIT[mId];
    const card = document.createElement('div');
    card.className = 'usage-model-card' + (limit === null ? ' no-free' : '');
    if(limit === null){
      card.innerHTML = `
        <div class="um-name">${MODEL_LABELS[mId]}</div>
        <div class="um-stats"><div class="um-used">${entry.requests}</div><div class="um-of">requests all-time</div></div>
        <div class="um-paid-note">No free-tier quota for this model — every request is billed.</div>
        <div class="um-tokens">${formatTokens(entry.tokens)} tokens all-time</div>`;
    } else {
      const remaining = Math.max(0, limit - usedToday);
      const pct = Math.min(100, (usedToday/limit)*100);
      card.innerHTML = `
        <div class="um-name">${MODEL_LABELS[mId]}</div>
        <div class="um-stats"><div class="um-used">${usedToday}</div><div class="um-of">/ ~${limit} today</div></div>
        <div class="usage-bar-track"><div class="usage-bar-fill" style="width:${pct.toFixed(1)}%;"></div></div>
        <div class="um-remaining" style="margin-top:10px;">≈ <b>${remaining}</b> requests left today</div>
        <div class="um-tokens">${formatTokens(entry.tokens)} tokens all-time</div>`;
    }
    grid.appendChild(card);
  });

  // Real on-device storage usage/quota for this origin (covers IndexedDB, incl. worlds, chats, images).
  const storageUsedEl = document.getElementById('usageStorageUsed');
  const storageQuotaEl = document.getElementById('usageStorageQuota');
  const storageBarEl = document.getElementById('usageStorageBar');
  if(navigator.storage && navigator.storage.estimate){
    try{
      const est = await navigator.storage.estimate();
      storageUsedEl.textContent = formatBytes(est.usage);
      storageQuotaEl.textContent = formatBytes(est.quota);
      const pct = est.quota ? Math.min(100, (est.usage/est.quota)*100) : 0;
      storageBarEl.style.width = pct.toFixed(1) + '%';
    }catch(e){ storageUsedEl.textContent = 'Unavailable'; storageQuotaEl.textContent = '—'; }
  } else {
    storageUsedEl.textContent = 'Unsupported by this browser'; storageQuotaEl.textContent = '—';
  }
}
document.getElementById('resetUsageStatsBtn').onclick = async ()=>{
  await kvSet('wc_usage_stats', { totalRequests:0, totalTokens:0, totalPromptTokens:0, totalCompletionTokens:0, byDay:{}, byModel:{}, lastModel:'', lastAt:0 });
  renderUsage();
};


function escapeHtml(s){ const d=document.createElement('div'); d.textContent=s||''; return d.innerHTML; }
// ---------- library ----------
async function renderLibrary(){
  const index = await getIndex();
  const q = els.searchInput.value.trim().toLowerCase();
  const filtered = index.filter(w=>{
    if(q && !w.name.toLowerCase().includes(q)) return false;
    return true;
  });
  els.libGrid.innerHTML = '';
  els.libEmpty.classList.toggle('screen-hidden', index.length>0);
  els.worldCount.textContent = index.length===1 ? '1 world' : `${index.length} worlds`;
  for(const w of filtered){
    const chat = await getChat(w.id);
    const tile = document.createElement('div');
    tile.className = 'world-card';
    tile.innerHTML = `
      <div class="cover-wrap ${w.cover?'':'placeholder'}">
        ${w.cover ? `<img src="${w.cover}">` : (w.name||'?').charAt(0)}
        <div class="cover-fade"></div>
        <div class="msg-count"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg> ${chat.length}</div>
      </div>
      <div class="card-info">
        <div class="card-name">${escapeHtml(w.name)}</div>
      </div>`;
    let cardLongPressFired = false;
    tile.onclick = ()=>{ if(cardLongPressFired){ cardLongPressFired = false; return; } openStory(w.id); };
    attachCardLongPress(tile, w, (fired)=>{ cardLongPressFired = fired; });
    els.libGrid.appendChild(tile);
  }
}

// ---------- library card long-press: edit / download / import / delete ----------
let cardLongPressTimer = null;
function attachCardLongPress(tile, world, setFired){
  const start = (e)=>{
    if(e.touches && e.touches.length > 1) return;
    setFired(false);
    cardLongPressTimer = setTimeout(()=>{ setFired(true); openCardCtxMenu(tile, world); }, 480);
  };
  const cancel = ()=> clearTimeout(cardLongPressTimer);
  tile.addEventListener('touchstart', start, {passive:true});
  tile.addEventListener('touchend', cancel);
  tile.addEventListener('touchmove', cancel);
  tile.addEventListener('touchcancel', cancel);
  tile.addEventListener('mousedown', start);
  tile.addEventListener('mouseup', cancel);
  tile.addEventListener('mouseleave', cancel);
}

function openCardCtxMenu(tile, world){
  const rect = tile.getBoundingClientRect();
  const menu = els.cardCtxMenu;
  els.cardCtxOverlay.style.display = 'block';
  menu.style.visibility = 'hidden';
  menu.style.display = 'flex';
  const menuWidth = menu.offsetWidth || 168;
  const menuHeight = menu.offsetHeight || 180;
  const gap = 10;

  let left = rect.left + rect.width/2 - menuWidth/2;
  if(left < 10) left = 10;
  if(left + menuWidth > window.innerWidth - 10) left = window.innerWidth - menuWidth - 10;

  let top = rect.top + rect.height/2 - menuHeight/2;
  if(top < 10) top = 10;
  if(top + menuHeight > window.innerHeight - 10) top = window.innerHeight - menuHeight - 10;

  menu.style.top = top + 'px';
  menu.style.left = left + 'px';
  menu.style.visibility = '';
  menu.dataset.id = world.id;
  requestAnimationFrame(()=>{
    menu.classList.add('open');
    els.cardCtxOverlay.classList.add('open');
  });
  pushNavState('modal');
}

let cardCtxCloseToken = 0;
function closeCardCtxMenu(){
  const menu = els.cardCtxMenu;
  menu.classList.remove('open');
  els.cardCtxOverlay.classList.remove('open');
  const myToken = ++cardCtxCloseToken;
  setTimeout(()=>{
    if(myToken === cardCtxCloseToken){ menu.style.display = 'none'; els.cardCtxOverlay.style.display = 'none'; }
  }, 280);
}
els.cardCtxOverlay.onclick = closeCardCtxMenu;

els.cardCtxEdit.onclick = async ()=>{
  const id = els.cardCtxMenu.dataset.id;
  closeCardCtxMenu();
  if(!id) return;
  const world = await getWorld(id);
  if(world) openEditor(world);
};

els.cardCtxDownload.onclick = ()=>{
  const id = els.cardCtxMenu.dataset.id;
  closeCardCtxMenu();
  if(id) exportWorld(id);
};

els.cardCtxImport.onclick = ()=>{
  closeCardCtxMenu();
  els.cardCtxImportFileInput.click();
};
els.cardCtxImportFileInput.onchange = ()=>{
  const file = els.cardCtxImportFileInput.files[0];
  els.cardCtxImportFileInput.value = '';
  if(file) importWorldFromFile(file);
};

els.cardCtxDelete.onclick = async ()=>{
  const id = els.cardCtxMenu.dataset.id;
  closeCardCtxMenu();
  if(!id) return;
  const world = await getWorld(id);
  if(!confirm(`Delete "${world?.name || 'this world'}" and its whole story so far? This can't be undone.`)) return;
  await deleteWorldData(id);
  const index = (await getIndex()).filter(w=>w.id!==id);
  await saveIndex(index);
  await renderLibrary();
};
els.searchInput.addEventListener('input', ()=> renderLibrary());

// ---------- editor ----------
async function openEditor(worldOrNull){
  state.editingId = worldOrNull ? worldOrNull.id : null;
  state.pendingCover = worldOrNull ? worldOrNull.cover : null;
  state.pendingBg = worldOrNull ? (worldOrNull.bg || null) : null;
  els.editorTitle.textContent = worldOrNull ? 'Edit world' : 'New world';
  els.fName.value = worldOrNull?.name || '';
  els.fLore.value = worldOrNull?.lore || '';
  els.fOpening.value = worldOrNull?.opening || '';
  els.avatarPreview.innerHTML = state.pendingCover
    ? `<img src="${state.pendingCover}" style="width:100%;height:100%;object-fit:cover;">`
    : ((worldOrNull?.name||'葉').charAt(0));
  els.bgPreview.style.backgroundImage = state.pendingBg ? `url(${state.pendingBg})` : 'none';
  els.bgClearBtn.classList.toggle('screen-hidden', !state.pendingBg);
  els.deleteCardBtn.classList.toggle('screen-hidden', !worldOrNull);

  // Once the AI has actually started building on the world's setting/characters and
  // opening scene (i.e. the story has messages), those two fields are locked. Editing
  // them mid-story would silently contradict everything already narrated from them —
  // the world name and cover/background art stay editable since those are cosmetic and
  // don't feed the AI's story context.
  const started = worldOrNull ? (await getChat(worldOrNull.id)).length > 0 : false;
  els.fLore.readOnly = started;
  els.fOpening.readOnly = started;
  els.fLore.classList.toggle('locked', started);
  els.fOpening.classList.toggle('locked', started);
  els.editorLockNote.classList.toggle('screen-hidden', !started);

  showEditor();
  pushNavState('editor');
}
els.avatarPreview.onclick = ()=> els.fileInput.click();
els.fileInput.onchange = async ()=>{
  const file = els.fileInput.files[0]; if(!file) return;
  const dataUrl = await resizeImageToDataUrl(file);
  state.pendingCover = dataUrl;
  els.avatarPreview.innerHTML = `<img src="${dataUrl}" style="width:100%;height:100%;object-fit:cover;">`;
};
els.bgPreview.onclick = ()=> els.bgFileInput.click();
els.bgFileInput.onchange = async ()=>{
  const file = els.bgFileInput.files[0]; if(!file) return;
  const dataUrl = await resizeImageToDataUrl(file, 900, 0.75);
  state.pendingBg = dataUrl;
  els.bgPreview.style.backgroundImage = `url(${dataUrl})`;
  els.bgClearBtn.classList.remove('screen-hidden');
};
els.bgClearBtn.onclick = ()=>{
  state.pendingBg = null;
  els.bgPreview.style.backgroundImage = 'none';
  els.bgFileInput.value = '';
  els.bgClearBtn.classList.add('screen-hidden');
};
els.saveCardBtn.onclick = async ()=>{
  const name = els.fName.value.trim();
  if(!name){ els.fName.focus(); return; }
  const isNewWorld = !state.editingId;
  const id = state.editingId || ('w'+Date.now());
  // Re-derive "locked" from the actual chat history at save time — not from the
  // textarea's readOnly attribute, which reflects DOM state and could be flipped by
  // anything that touches the page. Whether a story has begun is a fact about the data,
  // so that's what decides whether lore/opening are allowed to change here.
  const existing = state.editingId ? await getWorld(state.editingId) : null;
  const locked = state.editingId ? (await getChat(state.editingId)).length > 0 : false;
  const world = {
    id, name,
    lore: locked ? (existing?.lore || '') : els.fLore.value.trim(),
    opening: locked ? (existing?.opening || '') : (els.fOpening.value.trim() || `Narrate the player's arrival in ${name}. Set the scene in second person, 3-4 sentences, then end on a moment the player can respond to.`),
    cover: state.pendingCover || null,
    bg: state.pendingBg || null,
  };
  els.saveCardBtn.disabled = true; els.saveCardBtn.textContent = 'Saving...';
  await saveWorld(world);
  const index = await getIndex();
  const idx = index.findIndex(w=>w.id===id);
  const entry = {id, name, cover:world.cover};
  if(idx>-1) index[idx] = entry; else index.push(entry);
  await saveIndex(index);
  els.saveCardBtn.disabled = false; els.saveCardBtn.textContent = 'Save world';
  // Pull any dated skills/abilities straight out of the setup text now, while it's still
  // unlocked — same background-op queue as the regular memory/panel updates, so it can't
  // race with them.
  if(!locked) queueWorldOp(id, async ()=>{ await seedSkillsFromLore(world); });
  // Any "Day N — description" line the player wrote directly in the setup text gets seeded
  // into Scheduled Events too — deterministic text-pattern matching only (see
  // parseLoreScheduledEvents), not the AI inventing dates from vague prose. Only runs once,
  // at the moment a brand-new world is first created — never re-run on a later edit, so
  // re-saving the same world can't duplicate entries. Queued (not awaited) same as the skills
  // seed above, and it manages its own single queueWorldOp round trip internally.
  if(isNewWorld) seedScheduledEventsFromLore(world);
  await openStory(id);
};
els.deleteCardBtn.onclick = async ()=>{
  if(!confirm('Delete this world and its whole story so far? This can\'t be undone.')) return;
  const id = state.editingId;
  await deleteWorldData(id);
  const index = (await getIndex()).filter(w=>w.id!==id);
  await saveIndex(index);
  await renderLibrary(); showLibrary();
};

// ---------- suppress native browser long-press context menu app-wide ----------
document.addEventListener('contextmenu', (e)=>{
  const t = e.target;
  if(t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return; // still allow long-press in editable fields
  e.preventDefault();
});

// ---------- guard against long-press menus firing/lingering during screenshot gestures ----------
// Screenshot gestures (palm swipe, 3-finger swipe, edge-assistant swipe, browser's
// screenshot/annotate tool) briefly touch the page and can be misread as a long-press,
// and the OS overlay that appears mid-gesture blurs/hides the page. This cancels any
// pending long-press timer and force-closes an already-open menu whenever that happens.
function killPendingLongPresses(){
  clearTimeout(msgLongPressTimer);
  clearTimeout(cardLongPressTimer);
  clearTimeout(sendLongPressTimer);
  if(els.msgCtxMenu && els.msgCtxMenu.classList.contains('open')) closeMsgCtxMenu();
  if(els.cardCtxMenu && els.cardCtxMenu.classList.contains('open')) closeCardCtxMenu();
}
document.addEventListener('visibilitychange', ()=>{ if(document.hidden) killPendingLongPresses(); });
window.addEventListener('blur', killPendingLongPresses);
window.addEventListener('pagehide', killPendingLongPresses);
// Any second finger touching down means it's a multi-finger gesture (like a
// screenshot swipe), not a genuine single-finger long-press — abort immediately.
document.addEventListener('touchstart', (e)=>{ if(e.touches && e.touches.length > 1) killPendingLongPresses(); }, {passive:true});

// ---------- smooth open/close for full-screen overlays (Letter of Records + Inventory) ----------
// Both are plain display:none/flex toggles at heart (so every existing `.style.display ===
// 'flex'` check elsewhere in the code still works exactly as before, including mid-transition),
// but opening/closing now fades and slides the sheet via the `.is-open` CSS class instead of
// snapping instantly — including when triggered by the hardware/browser back button, since that
// goes through the same two functions as every other close path (X button, tap-outside).
function showOverlayModal(modalEl){
  modalEl.style.display = 'flex';
  // Force layout so the browser registers the closed (opacity:0/translateY) state before the
  // class flips — without this the two style changes get batched and there's nothing to
  // transition FROM.
  void modalEl.offsetWidth;
  modalEl.classList.add('is-open');
}
function hideOverlayModal(modalEl){
  if(modalEl.style.display !== 'flex') return;
  modalEl.classList.remove('is-open');
  let done = false;
  const finish = ()=>{
    if(done) return;
    done = true;
    modalEl.style.display = 'none';
    modalEl.removeEventListener('transitionend', onEnd);
  };
  const onEnd = (e)=>{ if(e.target === modalEl) finish(); };
  modalEl.addEventListener('transitionend', onEnd);
  // Fallback in case transitionend never fires (reduced-motion, tab backgrounded, etc.) so the
  // modal is never stuck holding its spot in the layout.
  setTimeout(finish, 320);
}


// Every screen change or modal open pushes a history entry. Pressing back closes
// the topmost modal/menu/drawer first, then steps back up to the library, instead
// of exiting the app immediately.
function pushNavState(name){
  history.pushState({navApp:true, view:name}, '');
}

window.addEventListener('popstate', ()=>{
  // 1) close topmost overlay/menu/drawer, if any is open
  if(els.msgCtxMenu.classList.contains('open')){ closeMsgCtxMenu(); return; }
  if(els.cardCtxMenu.classList.contains('open')){ closeCardCtxMenu(); return; }
  if(els.mediaDrawer.classList.contains('open')){ closeMediaDrawer(); return; }
  if(els.addDrawer.classList.contains('open')){ closeAddDrawer(); return; }
  if(els.relInfoModal.style.display === 'flex'){ hideOverlayModal(els.relInfoModal); return; }
  if(els.catInfoModal.style.display === 'flex'){ els.catInfoModal.style.display = 'none'; return; }
  if(els.invModal.style.display === 'flex'){
    hideOverlayModal(els.invModal); invPendingMerge = null;
    // Same re-sync as the close button/tap-outside handlers — a back-button close must not
    // leave the Letter of Records behind it showing pre-merge data.
    if(els.panelModal.style.display === 'flex') paintPanel();
    return;
  }
  if(els.panelModal.style.display === 'flex'){ hideOverlayModal(els.panelModal); return; }
  if(els.memoryModal.style.display === 'flex'){ els.memoryModal.style.display = 'none'; return; }
  if(els.chatSettingsModal.style.display === 'flex'){ els.chatSettingsModal.style.display = 'none'; return; }
  // 2) step back up to the library from any full screen
  if(els.chatScreen.style.display === 'flex'){ renderLibrary(); showLibrary(); return; }
  if(els.editor.style.display === 'block'){ renderLibrary(); showLibrary(); return; }
  if(document.getElementById('messagesScreen').style.display === 'block'){ renderLibrary(); showLibrary(); return; }
  if(document.getElementById('settingsScreen').style.display === 'block'){ renderLibrary(); showLibrary(); return; }
  if(document.getElementById('usageScreen').style.display === 'block'){ renderLibrary(); showLibrary(); return; }
  // 3) already at the library root — let the back press exit the app as normal
});

// ---------- lock screen ----------
// The PIN is never stored in plain text: only its SHA-256 hash is saved (in this
// browser's IndexedDB, alongside your Gemini key), and only the hash of whatever
// is typed is ever compared against it.
// Note: this is a static file, so this check is visible to anyone who opens dev
// tools — it deters casual visitors, not a determined attacker.
//
// There is no baked-in default PIN. On first run (no hash saved yet) the screen
// walks the person through creating their own PIN instead of silently requiring
// some hidden factory value nobody was ever told.
const LOCK_STORAGE_KEY = 'wc_unlocked_v1';
let lockPin = '';
let lockAttempts = 0;
let lockLockoutUntil = 0;
// 'unlock' = normal entry against a saved hash
// 'create' = first step of setting a new PIN (first run)
// 'confirm' = re-enter the same PIN to confirm it before saving
let lockMode = 'unlock';
let lockPendingPin = '';
const lockEls = {
  screen: document.getElementById('lockScreen'),
  title: document.getElementById('lockTitle'),
  sub: document.getElementById('lockSub'),
  dots: document.getElementById('lockDots'),
  keypad: document.getElementById('lockKeypad'),
  error: document.getElementById('lockError'),
};

// Pure-JS SHA-256 (no Web Crypto dependency). crypto.subtle only works in a
// "secure context" (HTTPS or localhost) — on plain HTTP or a LAN IP it silently
// doesn't exist, which would make the PIN check fail with zero feedback. This
// implementation works identically everywhere the page is served from.
function sha256Hex(str){
  function rrot(x,n){ return (x>>>n)|(x<<(32-n)); }
  const K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ];
  let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
  const bytes = new TextEncoder().encode(str);
  const bitLen = bytes.length * 8;
  const withOne = new Uint8Array(((bytes.length + 9 + 63) & ~63));
  withOne.set(bytes);
  withOne[bytes.length] = 0x80;
  const dv = new DataView(withOne.buffer);
  dv.setUint32(withOne.length - 4, bitLen >>> 0);
  dv.setUint32(withOne.length - 8, Math.floor(bitLen / 4294967296));
  const w = new Uint32Array(64);
  for(let chunk = 0; chunk < withOne.length; chunk += 64){
    for(let i = 0; i < 16; i++) w[i] = dv.getUint32(chunk + i*4);
    for(let i = 16; i < 64; i++){
      const s0 = rrot(w[i-15],7) ^ rrot(w[i-15],18) ^ (w[i-15]>>>3);
      const s1 = rrot(w[i-2],17) ^ rrot(w[i-2],19) ^ (w[i-2]>>>10);
      w[i] = (w[i-16] + s0 + w[i-7] + s1) | 0;
    }
    let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
    for(let i = 0; i < 64; i++){
      const S1 = rrot(e,6) ^ rrot(e,11) ^ rrot(e,25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rrot(a,2) ^ rrot(a,13) ^ rrot(a,22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      h=g; g=f; f=e; e=(d+temp1)|0; d=c; c=b; b=a; a=(temp1+temp2)|0;
    }
    h0=(h0+a)|0; h1=(h1+b)|0; h2=(h2+c)|0; h3=(h3+d)|0;
    h4=(h4+e)|0; h5=(h5+f)|0; h6=(h6+g)|0; h7=(h7+h)|0;
  }
  return [h0,h1,h2,h3,h4,h5,h6,h7].map(n => (n>>>0).toString(16).padStart(8,'0')).join('');
}

async function getPinHash(){ return await kvGet('wc_pin_hash'); }
async function savePinHash(hash){ await kvSet('wc_pin_hash', hash); }

function updateLockDots(){
  lockEls.dots.querySelectorAll('.lock-dot').forEach((d,i)=>{
    d.classList.toggle('filled', i < lockPin.length);
  });
}

function lockShakeAndClear(msg){
  lockEls.dots.classList.add('shake');
  lockEls.error.textContent = msg;
  setTimeout(()=>{
    lockEls.dots.classList.remove('shake');
    lockPin = '';
    updateLockDots();
  }, 380);
}

async function tryUnlock(){
  try{
    const [enteredHash, storedHash] = await Promise.all([sha256Hex(lockPin), getPinHash()]);
    if(enteredHash === storedHash){
      lockEls.screen.classList.add('hidden');
      bootApp();
      return;
    }
    lockAttempts++;
    if(lockAttempts >= 5){
      const lockoutSec = 30;
      lockLockoutUntil = Date.now() + lockoutSec * 1000;
      lockEls.keypad.style.pointerEvents = 'none';
      lockShakeAndClear(`Too many attempts — try again in ${lockoutSec}s`);
      setTimeout(()=>{
        lockEls.keypad.style.pointerEvents = '';
        lockEls.error.textContent = '';
        lockAttempts = 0;
      }, lockoutSec * 1000);
    } else {
      lockShakeAndClear('Incorrect PIN');
    }
  }catch(err){
    console.error('[lock] unlock check failed', err);
    lockShakeAndClear('Something went wrong — try again');
  }
}

// ---------- PIN creation flow (first run) ----------
function enterCreateMode(isFirstRun){
  lockMode = 'create';
  lockPendingPin = '';
  lockPin = '';
  lockAttempts = 0;
  lockLockoutUntil = 0;
  lockEls.keypad.style.pointerEvents = '';
  lockEls.title.textContent = 'Worlds';
  lockEls.sub.textContent = isFirstRun ? 'Choose a 6-digit PIN to protect your worlds' : 'Choose a new 6-digit PIN';
  lockEls.error.textContent = '';
  updateLockDots();
}
function enterConfirmMode(){
  lockMode = 'confirm';
  lockPin = '';
  lockEls.sub.textContent = 'Enter it again to confirm';
  lockEls.error.textContent = '';
  updateLockDots();
}
function enterUnlockMode(){
  lockMode = 'unlock';
  lockPin = '';
  lockPendingPin = '';
  lockEls.sub.textContent = 'Enter PIN to continue';
  lockEls.error.textContent = '';
  updateLockDots();
}
async function handlePinComplete(){
  if(lockMode === 'unlock'){
    tryUnlock();
  } else if(lockMode === 'create'){
    lockPendingPin = lockPin;
    enterConfirmMode();
  } else if(lockMode === 'confirm'){
    if(lockPin === lockPendingPin){
      try{
        const hash = await sha256Hex(lockPin);
        await savePinHash(hash);
        lockEls.screen.classList.add('hidden');
        bootApp();
      }catch(err){
        console.error('[lock] pin creation failed', err);
        lockShakeAndClear('Something went wrong — try again');
        enterCreateMode(false);
      }
    }else{
      lockShakeAndClear("PINs didn't match — try again");
      setTimeout(()=> enterCreateMode(false), 400);
    }
  }
}

lockEls.keypad.addEventListener('click', (e)=>{
  if(Date.now() < lockLockoutUntil) return;
  const btn = e.target.closest('.lock-key');
  if(!btn || !btn.dataset.k) return;
  lockEls.error.textContent = '';
  if(btn.dataset.k === 'back'){ lockPin = lockPin.slice(0, -1); updateLockDots(); return; }
  if(lockPin.length >= 6) return;
  lockPin += btn.dataset.k;
  updateLockDots();
  if(lockPin.length === 6) handlePinComplete();
});

document.addEventListener('keydown', (e)=>{
  if(lockEls.screen.classList.contains('hidden') || Date.now() < lockLockoutUntil) return;
  if(e.key >= '0' && e.key <= '9'){
    if(lockPin.length < 6){ lockPin += e.key; updateLockDots(); if(lockPin.length === 6) handlePinComplete(); }
  } else if(e.key === 'Backspace'){
    lockPin = lockPin.slice(0, -1); updateLockDots();
  }
});

// ---------- change PIN (Settings) ----------
document.getElementById('savePinBtn').onclick = async ()=>{
  const statusEl = document.getElementById('pinChangeStatus');
  const currentEl = document.getElementById('currentPinInput');
  const newEl = document.getElementById('newPinInput');
  const confirmEl = document.getElementById('confirmPinInput');
  const current = currentEl.value.trim();
  const next = newEl.value.trim();
  const confirm = confirmEl.value.trim();

  const isSixDigits = v => /^\d{6}$/.test(v);
  if(!isSixDigits(current)){ statusEl.textContent = 'Enter your current 6-digit PIN.'; return; }
  if(!isSixDigits(next)){ statusEl.textContent = 'New PIN must be exactly 6 digits.'; return; }
  if(next !== confirm){ statusEl.textContent = "New PIN and confirmation don't match."; return; }

  try{
    const [currentHash, storedHash] = await Promise.all([sha256Hex(current), getPinHash()]);
    if(currentHash !== storedHash){ statusEl.textContent = 'Current PIN is incorrect.'; return; }

    const newHash = await sha256Hex(next);
    await savePinHash(newHash);
    currentEl.value = ''; newEl.value = ''; confirmEl.value = '';
    statusEl.textContent = '✓ PIN updated.';
  }catch(err){
    console.error('[lock] pin change failed', err);
    statusEl.textContent = 'Something went wrong — please try again.';
  }
};

function bootApp(){
  history.replaceState({navApp:true, view:'library'}, '');
  (async ()=>{ await renderLibrary(); showLibrary(); setActiveTab('library'); })();
}

// ---------- boot ----------
// Every load re-checks against the stored PIN hash — there is no "stay unlocked"
// bypass, so the PIN screen always triggers before the site opens.
(async ()=>{
  // Clean up a legacy flag from an earlier version of this file that used to skip
  // the lock screen entirely once set. Removing it here guarantees any old value
  // still sitting in this browser's storage can never suppress the PIN prompt again.
  try{ localStorage.removeItem(LOCK_STORAGE_KEY); }catch(e){}
  try{
    const existingHash = await getPinHash();
    if(existingHash){ enterUnlockMode(); }
    else { enterCreateMode(true); }
  }catch(err){
    console.error('[lock] boot check failed', err);
    // If IndexedDB itself is unreachable, fall back to letting the person set a
    // fresh PIN rather than leaving them stuck on a screen that can never unlock.
    enterCreateMode(true);
  }
})();


// ================= AI =================
function withTimeout(promise, ms, msg){ return Promise.race([promise, new Promise((_,rej)=>setTimeout(()=>rej(new Error(msg)), ms))]); }

async function askAI(systemPrompt, userPrompt, modelOverride){
  const key = await getGeminiKey();
  if(!key) throw new Error('No Gemini API key set. Go to Settings and paste a free key from aistudio.google.com/apikey.');
  const model = modelOverride || await getGeminiModel();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const body = {
    contents: [{ role:'user', parts:[{ text:userPrompt }] }],
    systemInstruction: { parts:[{ text:systemPrompt }] }
  };
  let response;
  try{
    response = await withTimeout(
      fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) }),
      45000, 'That took too long and timed out. Check your connection and try again.'
    );
  }catch(err){ throw err; }
  if(!response.ok){
    let msg = `Gemini request failed (${response.status}).`;
    try{ const errJson = await response.json(); if(errJson?.error?.message) msg = errJson.error.message; }catch(e){}
    if(response.status === 400 || response.status === 403) msg = 'Your Gemini API key looks invalid. Check it in Settings.';
    if(response.status === 429) msg = 'Gemini\'s free rate limit was hit — wait a bit and try again.';
    throw new Error(msg);
  }
  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p=>p.text).join('') ?? null;
  if(!text) throw new Error('No reply came back. Try again.');
  recordUsage(model, data?.usageMetadata);
  return text.trim();
}

// Tracks a running, on-device count of Gemini requests/tokens for the Usage screen.
// Queued so rapid parallel calls (story reply + background memory/panel updates) never
// clobber each other's read-modify-write, the same issue fixed for panel updates.
let _usageQueue = Promise.resolve();
function recordUsage(model, usageMetadata){
  _usageQueue = _usageQueue.then(async ()=>{
    try{
      const stats = (await kvGet('wc_usage_stats')) || { totalRequests:0, totalTokens:0, totalPromptTokens:0, totalCompletionTokens:0, byDay:{}, byModel:{}, lastModel:'', lastAt:0 };
      const today = new Date().toISOString().slice(0,10);
      stats.totalRequests = (stats.totalRequests||0) + 1;
      stats.byDay = stats.byDay || {};
      stats.byDay[today] = (stats.byDay[today]||0) + 1;
      // keep only the last 14 days of daily buckets so this never grows unbounded
      const keys = Object.keys(stats.byDay).sort();
      while(keys.length > 14){ delete stats.byDay[keys.shift()]; }
      stats.byModel = stats.byModel || {};
      const mEntry = stats.byModel[model] || { requests:0, tokens:0, byDay:{} };
      mEntry.requests += 1;
      mEntry.byDay = mEntry.byDay || {};
      mEntry.byDay[today] = (mEntry.byDay[today]||0) + 1;
      const mKeys = Object.keys(mEntry.byDay).sort();
      while(mKeys.length > 14){ delete mEntry.byDay[mKeys.shift()]; }
      if(usageMetadata){
        stats.totalPromptTokens = (stats.totalPromptTokens||0) + (usageMetadata.promptTokenCount||0);
        stats.totalCompletionTokens = (stats.totalCompletionTokens||0) + (usageMetadata.candidatesTokenCount||0);
        const tk = usageMetadata.totalTokenCount || ((usageMetadata.promptTokenCount||0)+(usageMetadata.candidatesTokenCount||0));
        stats.totalTokens = (stats.totalTokens||0) + tk;
        mEntry.tokens += tk;
      }
      stats.byModel[model] = mEntry;
      stats.lastModel = model;
      stats.lastAt = Date.now();
      await kvSet('wc_usage_stats', stats);
    }catch(e){ console.error('[usage tracking failed]', e); }
  });
  return _usageQueue;
}

// Retries a lite-model call once on failure (network blip, rate limit, empty reply) before
// giving up, since memory/panel updates run silently in the background with no user-visible
// way to retry them manually — losing an update this way would quietly erode the story's record.
async function askAIWithRetry(systemPrompt, userPrompt, model, retries=1){
  try{
    return await askAI(systemPrompt, userPrompt, model);
  }catch(e){
    if(retries <= 0) throw e;
    await new Promise(r=>setTimeout(r, 1200));
    return askAIWithRetry(systemPrompt, userPrompt, model, retries-1);
  }
}

// The model is instructed to output raw JSON only, but strips fences defensively and, if any
// stray preamble/trailing text still slips in, falls back to extracting the first {...} block
// rather than dropping the whole update.
// Finds the '}' that actually matches the first '{' (depth-counted, string-aware) instead of
// just grabbing the last '}' in the reply — a trailing stray brace after the real object used
// to break this.
function findMatchingBraceEnd(str, start){
  let depth = 0, inString = false, escaped = false;
  for(let i = start; i < str.length; i++){
    const ch = str[i];
    if(inString){
      if(escaped){ escaped = false; }
      else if(ch === '\\'){ escaped = true; }
      else if(ch === '"'){ inString = false; }
      continue;
    }
    if(ch === '"'){ inString = true; continue; }
    if(ch === '{'){ depth++; }
    else if(ch === '}'){ depth--; if(depth === 0) return i; }
  }
  return -1; // no matching close found — malformed/truncated
}
function extractJsonObject(raw){
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try{ return JSON.parse(cleaned); }catch(e){}
  const start = cleaned.indexOf('{');
  if(start !== -1){
    const end = findMatchingBraceEnd(cleaned, start);
    if(end !== -1) return JSON.parse(cleaned.slice(start, end+1));
  }
  throw new Error('No valid JSON found in response');
}

// Same defensive fence-stripping/brace-hunting as extractJsonObject above, but for a top-level
// JSON ARRAY response (used by readClaimsFromInput below, which always returns a list of
// claims — possibly empty — never a single object).
function extractJsonArray(raw){
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try{ const p = JSON.parse(cleaned); if(Array.isArray(p)) return p; }catch(e){}
  const start = cleaned.indexOf('['); const end = cleaned.lastIndexOf(']');
  if(start !== -1 && end !== -1 && end > start){
    const p = JSON.parse(cleaned.slice(start, end+1));
    if(Array.isArray(p)) return p;
  }
  throw new Error('No valid JSON array found in response');
}

// Single shared formatter for turning a chat message into a log line for AI prompts, used
// everywhere (story continuation, system chat, memory, panel, resync) so labeling stays
// consistent and media-only messages (no caption) never produce a blank, contextless line.
function messageToLogLine(m){
  const speaker = m.role==='user' ? 'Player' : (m.role==='system' ? 'System' : 'Story');
  let text = m.text || '';
  if(m.media){
    const tag = m.media.kind==='video' ? '[shared a video]' : '[shared an image]';
    text = text ? `${text} ${tag}` : tag;
  }
  return `${speaker}: ${text}`;
}

const worldOpQueue = {};
// Tracks how many background world-ops (memory/panel updates, resyncs) are currently in
// flight. These are fired without being awaited by the caller (so replies stay snappy), which
// means a page refresh/close mid-update loses that update's result silently — the story's
// letter of records or memory just quietly doesn't get the correction it was about to save.
// Warn before unload while any are pending so that data loss requires the person to
// deliberately confirm it, instead of it happening invisibly.
let pendingBgOps = 0;
window.addEventListener('beforeunload', (e)=>{
  if(pendingBgOps > 0){ e.preventDefault(); e.returnValue = ''; return ''; }
});
function queueWorldOp(worldId, fn){
  pendingBgOps++;
  const prev = worldOpQueue[worldId] || Promise.resolve();
  const next = prev.then(fn, fn).catch(e=>console.error('[world op failed]', e)).finally(()=>{ pendingBgOps--; });
  worldOpQueue[worldId] = next;
  return next;
}

// Shared by updatePanel() and resyncMemoryAndPanel() so both stay in sync with the same rules.
// Written to be genre-neutral on purpose — this app is used for many different kinds of
// stories (fantasy, sci-fi, slice-of-life, romance, etc.), not just one setting, so the
// categories/examples below are illustrative patterns, not a fixed schema to imitate.


/* ################################################################################
   SECTION 2 — INSIDE THE CHATROOM (story chat UI/flow)
   The actual chat screen and its moment-to-moment behavior: building the
   system prompt and rendering messages, sending/regenerating/continuing a
   turn, the "system bro" OOC tools panel, message long-press (copy/rewind),
   media attach (photo/gif/video), the memory-log updater, and chat-specific
   UI plumbing (log scroll padding, pinned background, composer-above-
   keyboard). This is the layer the player directly interacts with each turn.
   Reads and writes the Letter of Records via Section 3's functions, and uses
   Section 1's storage/AI helpers.
################################################################################ */

async function updateMemory(world){
  const chat = await getChat(world.id);
  // Only summarize every few turns, not after every single message — this is a full extra AI call.
  const turnCount = chat.filter(m=>m.role==='user').length;
  if(turnCount < 4 || turnCount % 4 !== 0) return;
  const recent = chat.slice(-14);
  const convo = recent.map(messageToLogLine).join('\n');
  let prevMem = await getMemory(world.id);
  // Cross-reference the character sheet ("letter of records") so the two never quietly drift
  // apart — the sheet holds exact tracked values (currency, inventory counts, etc.) that the
  // memory log should agree with, so this catches the memory going stale on its own.
  const panel = await getPanel(world.id);
  // Free, non-AI pass first: fix any plainly stale numbers before spending a token on the
  // AI rewrite below, and save the correction if it actually changed anything.
  const cheaplyFixed = crossCheckMemoryAgainstPanel(prevMem, panel);
  if(cheaplyFixed !== prevMem){ prevMem = cheaplyFixed; await saveMemory(world.id, prevMem); }
  const prompt = `Recent story log:\n${convo}\n\nPrevious memory (everything remembered so far):\n${prevMem || '(none yet)'}\n\nCharacter sheet, aka the letter of records (for consistency-checking only — the log above is still the source of truth):\n${panelToText(panel)}\n\nUpdate the memory. Keep every fact from the previous memory unless the recent log directly contradicts it — never drop old details just because they weren't mentioned recently. Add any new facts from the recent log, following the letter of the log exactly — never invent, infer, or assume a detail that isn't explicitly there. If a memory bullet conflicts with the character sheet (e.g. a stale currency, item total, or day count), correct that bullet to match the sheet's tracked value. Do not add brand-new facts sourced only from the sheet — only use it to correct or resolve contradictions in existing memory bullets. TIME TRACKING: if the recent log shows a new in-story day beginning — whether the player said it ("I rest for the night", "skip ahead two days") or the narrator/story text did (an explicit time-skip like "the next morning" or "two days later", travel, sleeping, a training montage, etc.) — keep a running day-by-day log as part of the bullets, formatted like "Day 4 — met Kakashi at training ground" — one such bullet per day that's actually shown passing, numbered strictly sequentially, never skipping or repeating a day number already used earlier in this same memory. If any Scheduled Events are due soon or overdue based on the sheet's "Current Day", note that plainly in the relevant day's bullet (e.g. "Day 38 — 2 days left until Chunin Exam Finals"). This is the easiest way to catch a story that's quietly lost track of a scheduled date — the day count here should always line up with the sheet's own "Current Day" and Scheduled Events list. Output the full updated bullet list (old + new merged), 3-5 words per bullet (day-log bullets can run a little longer to stay readable), as many bullets as needed to not lose anything important.`;
  try{
    const bgModel = await getGeminiBgModel();
    const summary = await askAIWithRetry('You maintain a permanent, ever-growing story memory log. You never delete facts, you only add to or correct them. You never invent facts that aren\'t explicitly stated in the log. Output only the updated bullet list, nothing else.', prompt, bgModel);
    if(summary && summary.trim()){
      await saveMemory(world.id, summary);
      // Two-way reconciliation at this same sync point (was one-way: panel-corrects-memory
      // only, via crossCheckMemoryAgainstPanel above and the "correct that bullet to match the
      // sheet" instruction in the prompt). Now that memory reflects the latest log, also check
      // the sheet against IT — memory can hold a fact the sheet never picked up, or still be
      // ahead of a sheet value memory has since corrected.
      await reconcilePanelFromMemory(world, summary, panel);
    }
  }catch(e){ showBackgroundWarning(world.id, 'Memory', e); }
}

// The other half of the two-way sync above. Panel -> memory correction already happens via
// crossCheckMemoryAgainstPanel (deterministic) and the updateMemory() prompt itself (AI-level).
// This is memory -> panel: re-reads the just-updated memory and asks only what the sheet is
// missing or misstating relative to it, sharing PANEL_SYS_PROMPT/mergePanelUpdate with the
// normal per-turn updatePanel() so the output shape and merge behavior stay identical — this is
// a different *source* being checked against the sheet, not a different mechanism. Runs only at
// the same every-4-turn sync point as updateMemory(), not every turn.
async function reconcilePanelFromMemory(world, memory, panel){
  if(!memory || !memory.trim()) return;
  const prompt = `Memory log (the story's running record of everything that's happened so far — treat this as the source of truth for this check):\n${memory}\n\nCurrent character sheet:\n${panelToText(panel)}\n\nCompare the two. Report ONLY what the sheet is missing or has wrong that the memory log clearly and explicitly states — a fact the sheet never picked up, or a value the sheet still has stale that the memory log has since corrected. Never invent, infer, or assume anything the memory log doesn't explicitly say, and never change something on the sheet just because the memory log happens not to mention it. If the sheet and memory already agree on everything, output {"categories":{}}.`;
  try{
    const bgModel = await getGeminiBgModel();
    const raw = await askAIWithRetry(PANEL_SYS_PROMPT, prompt, bgModel);
    const data = extractJsonObject(raw);
    if(!data || !data.categories || Object.keys(data.categories).length === 0) return;
    // This pass isn't tied to a single live turn — same situation resyncMemoryAndPanel is in —
    // so it needs the exact same guard suite that path uses, not the bare merge it had before.
    // Without these, a memory-sourced Current Day bump or Scheduled Events edit could land with
    // none of the normal skip/removal checks applied, letting the sheet drift out of sync with
    // what the story log actually supports. playerText is deliberately empty — there's no
    // player action backing this pass, so any currency/skill guard that requires an explicit
    // player confirmation should block the gain rather than allow it; memory as the "log" text
    // still lets genuine narrated day-skips/event resolutions already recorded in memory's own
    // bullets through.
    guardCurrencyDecreases(data, panel, '', memory);
    guardCurrencyIncreases(data, panel, memory);
    guardSkillProgress(data, panel, '', true);
    guardSkillGraduation(data, panel);
    guardUngraduatedAbilityInventory(data, panel, memory);
    guardStackableItems(data, panel, '', memory);
    guardDuplicationMath(data, panel, memory);
    guardInventoryEquipStatus(data, panel, '');
    guardInventoryRenameBypass(data, panel, '', memory);
    guardInventoryDiscard(data, panel, '');
    guardTimelineDay(data, panel, memory, world.id, true, false);
    guardScheduledEvents(data, panel, world.id, memory);
    guardIdentityChanges(data, panel, memory);
    if(data.categories && Object.keys(data.categories).length > 0){
      mergePanelUpdate(panel, data);
      await savePanel(world.id, panel);
    }
  }catch(e){ showBackgroundWarning(world.id, 'Letter of records (memory sync)', e); }
}

// Memory/panel updates do a read -> modify -> write against IndexedDB. If two of these ever
// run concurrently for the same world (fast messages, regenerate, or a rewind resync overlapping
// a still-in-flight background update from the previous turn), whichever save lands last silently
// wins and erases the other's changes -- entries "vanish" and reappear on the next update. This
// queue serializes every memory/panel-touching op per world so they can never overlap.
// ---------- keep #log padding-bottom matched to the REAL rendered height of
// the fixed footer, instead of a fixed guess. Footer height can change
// (suggestion chips appearing, dynamic browser toolbars, safe-area quirks),
// which previously caused messages to hide behind the input bar. ----------
//
// Everything auto-follow/near-bottom-detection related has been removed on
// purpose. It was fighting the user's own touch scrolling — a MutationObserver
// fired on every incidental DOM change (action buttons toggling, images
// loading, footer resizing) and force-set scrollTop whenever it guessed the
// user was "near" the bottom, with no awareness of an in-progress scroll
// gesture. That produced the "scroll down and it snaps straight to the very
// bottom" bug. Scrolling is now 100% native/manual: the browser handles it,
// nothing here ever touches scrollTop except the explicit call sites below
// (opening a chat, sending a message, a reply arriving).
let _chatPadRO = null;
function scrollLogToBottom(){
  if(!els.chatBody) return;
  els.chatBody.scrollTop = els.chatBody.scrollHeight;
}
function syncChatPadding(){
  if(!els.log || !els.chatBody || !els.chatFooter) return;
  const footerH = els.chatFooter.offsetHeight;
  els.log.style.paddingBottom = (footerH + 30) + 'px';
}
// Called only from the explicit "this should jump to bottom" call sites
// (opening a chat, sending a message, a reply/typing-indicator arriving).
function pinToBottomAfterRender(){
  syncChatPadding();
  els.chatBody.scrollTop = els.chatBody.scrollHeight;
}
if('ResizeObserver' in window){
  // Footer height can still change (textarea growing, chips appearing) —
  // keep the padding in sync so the last message doesn't end up hidden
  // behind the input bar. This only adjusts padding, it never scrolls.
  _chatPadRO = new ResizeObserver(()=> syncChatPadding());
}
window.addEventListener('load', ()=>{
  syncChatPadding();
  if(els.chatFooter) { _chatPadRO && _chatPadRO.observe(els.chatFooter); }
});
window.addEventListener('resize', syncChatPadding);
window.addEventListener('orientationchange', ()=> setTimeout(syncChatPadding, 60));
if(window.visualViewport){ window.visualViewport.addEventListener('resize', syncChatPadding); }

// ---------- background is now permanently pinned via CSS (100svh) — see #chatBg rule ----------
// Previously this JS re-measured and re-pinned #chatBg's height/top on every keyboard or
// address-bar viewport change. Now that the CSS itself uses a static viewport unit (`svh`)
// that never changes value during scrolling, the background never needs JS repositioning at
// all — it's simply fixed in place by the browser, permanently, with zero moving parts. This
// function is kept as a no-op (rather than deleted) only so any other code still calling it
// doesn't break; it intentionally does nothing to #chatBg's size/position anymore.
function syncChatBgViewport(){ /* intentionally a no-op — background is CSS-pinned now */ }
const KEYBOARD_HEIGHT_THRESHOLD = 120; // px — comfortably above address-bar collapse, comfortably below any real keyboard
function isKeyboardLikelyOpen(){
  if(!window.visualViewport) return false;
  return (window.innerHeight - window.visualViewport.height) > KEYBOARD_HEIGHT_THRESHOLD;
}
function rafThrottle(fn){
  let scheduled = false;
  return function(...args){
    if(scheduled) return;
    scheduled = true;
    requestAnimationFrame(()=>{ scheduled = false; fn.apply(this, args); });
  };
}

// ---------- keep the composer above the on-screen keyboard ----------
// #chatFooter is `position:fixed; bottom:0`, which trusts the
// `interactive-widget=resizes-content` viewport meta tag to shrink the layout
// viewport when the keyboard opens. Not every Android/Chrome build honors that,
// so the footer can end up sitting under the keyboard instead of above it.
//
// The first version of this fix computed the keyboard's height as
// `window.innerHeight - visualViewport.height` and nudged the footer up by that
// diff. window.innerHeight isn't a stable reference on mobile Chrome though — it
// shifts on its own as the address bar collapses/expands, independent of the
// keyboard — so that diff could come out non-zero even with no keyboard open,
// permanently knocking the footer out of its normal spot (the doubled/overlapping
// bar bug). Anchoring `top` directly to visualViewport's own bottom edge instead
// only ever depends on one number (what's actually visible right now), so at
// rest — nothing shrinking the view — it lands exactly where `bottom:0` already
// would have.
//
// BUG (same root cause as the background above): the address bar's own show/hide
// animation during ordinary scrolling fires `visualViewport.scroll` many times a
// second, and `vv.height` changes smoothly frame-by-frame as it animates. Our JS
// only recomputes `top` once per fired event, so it lagged a frame behind the
// browser's own native rendering of the fixed element — which is exactly what
// looked like the footer "leaving the bottom for a moment" while scrolling. Fix:
// only switch the footer into JS-driven `top` positioning when a real keyboard is
// actually open (large viewport gap). Otherwise leave it on its normal CSS
// `bottom:0`, which the browser keeps perfectly synced on its own with zero JS
// involved — nothing for our code to lag behind. Also batched onto
// requestAnimationFrame so at most one style write happens per frame.
function syncFooterViewport(){
  if(!els.chatFooter || !window.visualViewport) return;
  if(!isKeyboardLikelyOpen()){
    els.chatFooter.style.top = '';
    els.chatFooter.style.bottom = '0';
    return;
  }
  const vv = window.visualViewport;
  const footerH = els.chatFooter.offsetHeight;
  els.chatFooter.style.top = Math.round(vv.offsetTop + vv.height - footerH) + 'px';
  els.chatFooter.style.bottom = 'auto';
}
const syncFooterViewportThrottled = rafThrottle(syncFooterViewport);
if(window.visualViewport){
  window.visualViewport.addEventListener('resize', syncFooterViewportThrottled);
  window.visualViewport.addEventListener('scroll', syncFooterViewportThrottled);
}
window.addEventListener('load', syncFooterViewport);
window.addEventListener('resize', syncFooterViewportThrottled);
window.addEventListener('orientationchange', ()=> setTimeout(syncFooterViewport, 60));
els.textInput.addEventListener('focus', ()=> setTimeout(syncFooterViewport, 60));
if('ResizeObserver' in window){
  // The footer's own height changes (textarea growing) which shifts what its
  // correct `top` should be too, not just the padding below it.
  new ResizeObserver(()=> syncFooterViewportThrottled()).observe(els.chatFooter);
}
window.addEventListener('load', syncChatBgViewport);
window.addEventListener('orientationchange', ()=> setTimeout(syncChatBgViewport, 60));

function formatStoryText(s){
  if(!s) return '';
  // splits on "quoted speech" segments (straight or curly quotes) so spoken lines can be styled distinctly
  const parts = s.split(/("(?:[^"\\]|\\.)*"|“[^”]*”)/g);
  return parts.map(part=>{
    if(part && ((part.startsWith('"') && part.endsWith('"') && part.length>=2) || (part.startsWith('“') && part.endsWith('”')))){
      return `<span class="dialogue">${escapeHtml(part)}</span>`;
    }
    return escapeHtml(part);
  }).join('');
}

// ---------- story chat ----------
function worldSystemPrompt(world, memory, panel){
  const memCtx = memory ? `\n\nWhat has happened in the story so far:\n${memory}` : '';
  const panelCtx = panel ? `\n\nPlayer's current character sheet (source of truth for what they have/know/can do):\n${panelToText(panel)}` : '';
  const storyCommitmentRule = `\n\n=== STORY COMMITMENT — READ CAREFULLY ===\nThe "World & characters" text below isn't just flavor — it's a commitment for how this story plays out. Any specific event, milestone, test, exam, deadline, ceremony, mission, or main plot point stated there is something the story owes the player: it must actually happen, in substance, at the point in the story where it belongs. Never skip it, water it down, quietly reinterpret it into something easier or different, or let the story wander off and never come back to it. If the world description says there's an exam, that exam happens, for real, when the story reaches it — you can pace how you get there and narrate around it, but you cannot erase, dodge, soften, or rewrite what was set up when this world was created.`;
  const hardLimitRule = panel ? `\n\n=== HARD LIMIT — READ CAREFULLY ===\nThe character sheet above is the complete and total truth of what the player currently has, knows, and can do. Nothing exists for the player beyond it — not one extra coin, not one extra jutsu/technique/power, not one extra item, not one extra title or relationship beyond exactly what's listed. This is a strict, non-negotiable constraint on every reply you write:\n- Money/currency: the player can only spend, pay, or exchange away up to the exact amount listed, in ANY currency the sheet tracks (not just an obvious one like gold — whatever the story's Finances section lists). If they try to spend, pay, or exchange more than they have, or do so when they have none listed, the story must show the shortfall (a purchase or trade falls through, they come up short, someone points out they can't afford it) — never silently let the transaction succeed.\n- Powers/jutsu/techniques/skills: the player can only use an ability that is explicitly listed on the sheet. If they attempt one that isn't listed, the story must show the attempt failing, fizzling, or simply not being something the player knows how to do — never let it work anyway, and never quietly grant a new one just because the player asked for it in dialogue or action. New abilities only appear on the sheet after the story has already established the player legitimately learned or gained them. If a listed skill is tracked as a percentage (e.g. "Business Study: 14%"), that number is its real current power level — write its use accordingly: low percentage means weak, shaky, or unreliable results (and it can plausibly fail or backfire), a middling percentage means workable but imperfect, and 100%/mastered means full, confident power. Never let a barely-learned skill perform as if it were already mastered. Once a skill reaches 100% and moves into "Skills & Abilities" (whether it started there or graduated out of "Learning"), treat it exactly the same as every other entry in that list — full, reliable, unrestricted power, usable in dialogue/action and on Inventory items alike, with no lingering caution, no "still getting used to it" hedging, and no extra confirmation beyond just being listed. A listed ability with a generic effect (duplication, creation, multiplication, transmutation, and similar) is NOT limited to whichever resource it happened to be used on before — it works the same way on any resource the player deliberately targets it at, currency and Inventory items alike, as long as the ability is genuinely listed and the story actually shows it being used that way.
- Items/inventory: the player can only use, wield, or reference an item that's listed. If it's not there, they don't have it. An item's status (the text after an em dash, e.g. "Equipped", "Hidden under the bed", "Left at the shop", "Stored in the scroll") reflects where or how it currently sits — if that status shows the item is stored, hidden, or left somewhere away from the player's person, the player CANNOT use, wield, or reach for it in this reply, even though it's still listed, until the story actually shows them physically retrieving it first. An item with no status, or a status like "Equipped"/"Worn"/"Sheathed"/"Held", is on the player's person and usable normally.
- Relationships/titles/status: treat only what's listed as established fact; don't invent favor, rank, or standing the sheet doesn't show.
This applies even if the player's own message assumes or asserts they can do something the sheet doesn't support — the player narrating an action doesn't make it true. Push back through the story itself (an NPC's reaction, a failed attempt, a moment of realization) rather than breaking immersion to explain the rule directly.\n- DATA OVER MEMORY: the character sheet above is a live, exact record — always more current and more trustworthy than "What has happened in the story so far" or anything you might recall from earlier turns. If the memory summary below ever seems to imply a different number, item, or ability than the sheet actually lists, the sheet wins, no exceptions. Base this reply on the sheet as written, not on a general impression of how the story "should" have gone.` : '';
  // ---------- category-rules reinforcement (second, independent layer alongside the guards) ----------
  // The section-info popup (CAT_INFO/getCatInfo, defined further down) already spells out, in
  // plain English, exactly how each section is meant to update and what should NOT update it —
  // text that used to be shown only to the player. Sending that same text to the AI too means
  // the rule is enforced in two independent places: the post-response guards catch it
  // mechanically even if the model slips, and the model has also been told the rule directly up
  // front, so it's less likely to slip in the first place. Scoped to only the categories this
  // panel actually has, so the prompt doesn't pad itself out with rules for sections that don't
  // exist in this particular world.
  const categoryRulesText = panel && panel.categories ? (()=>{
    const lines = Object.keys(panel.categories).map(name=>{
      const info = getCatInfo(name);
      return `- ${info.title}: updates when ${info.how} Does NOT update from: ${info.wont}`;
    });
    return lines.length ? `\n\n=== SECTION RULES (how each part of the sheet is allowed to change) ===\n${lines.join('\n')}` : '';
  })() : '';
  const memoryPermanenceRule = memory ? `\n\n=== MEMORY IS PERMANENT ===\nEverything in "What has happened in the story so far" above is permanent, established fact — it happened, it's real, and it never gets forgotten, contradicted, or quietly retconned, no matter how many turns pass or how long ago it was recorded. Every new reply must stay fully consistent with all of it. If a newer instinct for the scene seems to conflict with an older established fact, the older fact wins unless the story has already explicitly and deliberately changed it (an item was destroyed, a relationship shifted, etc.) — never let inconsistency slip in just because a detail wasn't mentioned recently.` : '';
  const scheduledEventTriggerRule = panel ? `\n\n=== SCHEDULED EVENTS — AUTO-TRIGGER ===\nThe character sheet above has a Timeline (a "Current Day" number) and a Scheduled Events list, formatted "Day N — event name". Check them on every reply: if Current Day has reached or passed an entry's day number, that event is due right now — it must actively start happening in THIS reply, on your own initiative, no matter what the player was doing or talking about. Don't wait for the player to ask, bring it up, or go looking for it — the story comes to them instead: someone arrives to fetch them, a name gets called, a bell rings, a door opens, whatever fits the event and the scene. Work it in naturally even if it interrupts or redirects what the player was mid-action on. If more than one entry is due, surface the earliest/most pressing one first. This all happens inside the one reply you're already writing right now, in response to the player's own message or Forward tap — never as a separate, additional reply of your own; you only ever get to speak once per player turn, exactly like any other reply. A Scheduled Events entry is permanent and never something you remove — once you've shown it happening, just keep narrating forward; the entry itself stays on the sheet (the app dims it automatically once its day has passed).\n\nA request or narrated time-skip (resting, traveling, training montages, "let's skip ahead N days", etc.) can NEVER carry Current Day past a still-upcoming Scheduled Events day in one jump, even if the requested/described skip length is nominally longer than that. If Current Day is 8 and Scheduled Events has "Day 12 — Chunin Exam", a skip of "ten days" does not land on day 18 — the skip stops at day 12: narrate arriving at that day and the due event actually starting, not the full requested skip. Only once that event has been shown happening can time resume moving forward past it, on a later turn.` : '';
  return `You are the narrator and every character of this story world.\n\nWorld & characters:\n${world.lore || '(no details given — invent something fitting the world name)'}\n\nRules: narrate in strict second person ("you") from the player's own point of view only. Describe only what the player can directly see, hear, or sense. Voice other characters only through visible dialogue and action, never their private thoughts. Always wrap every spoken line of dialogue in double quotation marks ("like this"), exactly as a character would say it aloud — never leave spoken words unquoted. No stage directions in asterisks; weave narration and dialogue naturally. Keep replies immersive but concise — 2-5 sentences unless a scene truly calls for more.${storyCommitmentRule}${memoryPermanenceRule}${panelCtx}${hardLimitRule}${categoryRulesText}${memCtx}${scheduledEventTriggerRule}`;
}

async function openStory(id){
  const world = await getWorld(id);
  if(!world) return;
  state.chattingId = id;
  els.chatName.textContent = world.name;
  els.chatBg.style.backgroundImage = (world.bg || world.cover) ? `url(${world.bg || world.cover})` : 'none';
  if(world.cover){ els.chatAvatar.classList.remove('placeholder'); els.chatAvatar.innerHTML = `<img src="${world.cover}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`; }
  else { els.chatAvatar.classList.add('placeholder'); els.chatAvatar.textContent = world.name.charAt(0); }
  els.log.innerHTML = '';
  showChat();
  pushNavState('chat');

  let chat = await getChat(id);
  if(chat.length === 0){
    showTyping();
    let text;
    try{ text = await askAI(worldSystemPrompt(world, ''), world.opening); }
    catch(err){
      hideTyping();
      const w = document.createElement('div'); w.className='warn'; w.textContent = '⚠️ ' + err.message;
      els.log.appendChild(w);
      const retry = document.createElement('button'); retry.className='warn';
      retry.style.cssText='background:none;border:1px solid var(--line);color:var(--text);padding:8px 16px;border-radius:16px;cursor:pointer;';
      retry.textContent = 'Retry'; retry.onclick = ()=> openStory(id);
      els.log.appendChild(retry);
      return;
    }
    hideTyping();
    chat = [{role:'ai', text, ts:Date.now()}];
    await saveChat(id, chat);
  }
  // pin:false here — pinning after every single historical message (instead of once at
  // the end) was the cause of the scroll flicker/snap-to-bottom bug: a long chat fired
  // dozens of stacked snap-to-bottom sequences whose delayed callbacks (up to 350ms out)
  // were still firing after the chat was already open, yanking any manual scroll-up
  // straight back down.
  chat.forEach((m,i) => renderMsg(m, i===chat.length-1, i, false));
  pinToBottomAfterRender();
}

function renderMsg(m, isLast, index, pin=true){
  const wrap = document.createElement('div');
  const kind = m.role==='user' ? 'user' : (m.role==='system' ? 'system' : 'ai');
  wrap.className = 'msg ' + kind;
  const label = kind==='system' ? `<div class="sys-label">⚙️ System</div>` : '';
  const mediaHtml = m.media
    ? (m.media.kind === 'video'
        ? `<video src="${m.media.url}" controls playsinline class="msg-media"></video>`
        : `<img src="${m.media.url}" class="msg-media" alt="attachment">`)
    : '';
  const textHtml = m.text ? (kind==='system' ? renderMarkdownLite(m.text) : formatStoryText(m.text)) : '';
  const body = mediaHtml + textHtml;
  wrap.innerHTML = `${label}<div class="bubble">${body}</div>`;
  if(typeof index === 'number') attachMsgLongPress(wrap.querySelector('.bubble'), index, m.text);
  if((m.role==='ai' || m.role==='system') && isLast){
    const actions = document.createElement('div'); actions.className='msg-actions';
    let html = `<button title="Regenerate" id="regenBtn">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v6h-6"/></svg>
    </button>`;
    if(m.role==='ai'){
      html += `<button title="Continue" id="forwardBtn">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 4 8 8-8 8"/><path d="m13 4 8 8-8 8"/></svg>
    </button>`;
    }
    actions.innerHTML = html;
    wrap.appendChild(actions);
    setTimeout(()=>{
      const b=document.getElementById('regenBtn'); if(b) b.onclick = regenerateLast;
      const f=document.getElementById('forwardBtn'); if(f) f.onclick = continueForward;
    }, 0);
  }
  els.log.appendChild(wrap);
  if(m.role==='system' && isLast) attachSystemToolsPanel(wrap);
  if(pin) pinToBottomAfterRender();
}

// ---------- OOC "system bro" tools panel ----------
// Summoned alongside the System's reply (typing "system bro") — a semi-square tile
// rendered INSIDE that same reply's bubble (Scheduled Events), expanding its own tool
// in place when tapped. This replaces the old setup where "add a schedule event ..."
// was a second free-text chat command a player could type mid-story (and which wrote
// straight to the letter of records with zero review) — that text trigger is gone now;
// the only way to add a scheduled event is through this deliberate, structured form,
// reachable only after explicitly summoning the System. Only ever shown on the latest
// system message (same rule the regenerate/continue actions already follow), and it
// always paints from live storage so it can never show or act on a stale snapshot.
// (Inventory tap-to-remove used to live here too — it's been moved to the dedicated
// Inventory-only merger page as a per-chip delete cross; see wireInventoryChipDrag.)
async function attachSystemToolsPanel(wrap){
  if(!state.chattingId) return;
  const worldId = state.chattingId;
  const bubble = wrap.querySelector('.bubble');
  if(!bubble) return;
  const box = document.createElement('div');
  box.className = 'sys-tools-wrap';
  box.innerHTML = `
    <div class="sys-tools">
      <button type="button" class="sys-tool-tile" data-tool="sched">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
        <span>Scheduled Events</span>
      </button>
    </div>
    <div class="sys-tool-body" data-body="sched"></div>
  `;
  bubble.appendChild(box);

  const schedBody = box.querySelector('[data-body="sched"]');
  const tiles = box.querySelectorAll('.sys-tool-tile');
  const closeAll = ()=>{
    schedBody.classList.remove('open');
    tiles.forEach(t=>t.classList.remove('active'));
  };

  // ---- [TL-7 UI] Scheduled Events tile — reward-language guard, list, and add form ----
  // (addScheduledEvent itself — the actual write — lives up in the main TIMELINE-EVENTS-MODULE
  // block with the rest of the timeline/schedule logic; only the UI glue lives here.)
  // The manual add box is deterministic (no AI in the loop) and writes straight to the
  // sheet, and its text later gets fed back to the narrator as "this event is due" —
  // which can seed the AI's own narration with a fabricated grounding that the
  // Finances/Inventory guards would otherwise accept. This keeps event descriptions to
  // "what happens", not "what you get": only blocks when a number AND a reward-ish word
  // both appear, so ordinary text like "turns 18" or "meet at gate 3" still goes through.
  const SCHED_REWARD_WORDS = /\b(gold|coins?|cash|credits?|gems?|silver|copper|money|dollars?|gil|ryo|points?|xp|exp|item|items?|reward(s|ed)?|loot(ed)?|prize|bonus|receive(s|d)?|gain(s|ed)?|earn(s|ed)?|obtain(s|ed)?|grant(s|ed)?|award(s|ed)?|unlock(s|ed)?|collect(s|ed)?|win(s)?|find(s)?|got|get)\b/i;
  const SCHED_NUMBER = /\d/;
  function looksLikeRewardText(desc){
    return SCHED_NUMBER.test(desc) && SCHED_REWARD_WORDS.test(desc);
  }

  // ---- Scheduled Events: existing entries (permanent, read-only) + add form ----
  // Entries are never removable here (or anywhere) once added — tapping used to delete one,
  // but a scheduled event is meant to be a permanent record of the story's calendar. Once its
  // day arrives it's simply shown dimmed (via is-past) rather than taken off the list, and
  // whether/how it actually plays out in the story is left to the narrator, not forced or
  // auto-cleared. See guardScheduledEvents (blocks any removal at the data layer) and
  // renderPanelHtml (same dimming, on the full letter-of-records sheet).
  // `notice` (optional) is a one-shot informational message shown in place of the default
  // hint on this repaint only — used right after adding an event whose typed day got
  // clamped to today, so the player sees WHY the entry landed on a different day than they
  // typed instead of it just silently appearing there with zero explanation (addScheduledEvent
  // already computed this exact fact via its `clamped` return value — it just used to be
  // thrown away unread at the call site below).
  const paintSched = async (notice)=>{
    const panel = await getPanel(worldId);
    const se = panel.categories['Scheduled Events'];
    const items = (se && se.type==='list') ? se.data : [];
    let currentDay = null;
    for(const c of Object.values(panel.categories || {})){
      if(c.type !== 'kv') continue;
      for(const [k, v] of Object.entries(c.data || {})){
        if(!CURRENT_DAY_KEY_RE.test(k)) continue;
        const n = parseInt(String(v).replace(/[^\d]/g,''), 10);
        if(!isNaN(n)) currentDay = n;
      }
    }
    const listHtml = `<div class="sys-inv-title">Scheduled</div>` + (items.length
      ? `<div class="sys-inv-list">${items.map((it)=>{
          const text = String(it);
          const parsed = parseDayEntry(text);
          const isPast = parsed && currentDay != null && parsed.day <= currentDay;
          return `<div class="sys-inv-item is-sched${isPast ? ' is-past' : ''}">
            <span class="sys-inv-label">${escapeHtml(text)}</span>
          </div>`;
        }).join('')}</div>`
      : `<div class="sys-inv-empty">Nothing scheduled right now.</div>`);
    const hintDefaultText = 'Leave day blank to make it due right away. Once added, an event can\'t be removed.';
    schedBody.innerHTML = `${listHtml}
      <div class="sys-inv-title" style="margin-top:14px;">Add a scheduled event</div>
      <div class="sys-sched-form">
        <div class="sys-sched-row">
          <input type="number" min="1" inputmode="numeric" class="sys-sched-day" placeholder="Day">
          <input type="text" class="sys-sched-desc" placeholder="What happens (e.g. Chūnin Exam)">
        </div>
        <div class="sys-sched-hint${notice ? ' is-notice' : ''}">${escapeHtml(notice || hintDefaultText)}</div>
        <button type="button" class="sys-sched-btn">Add to Scheduled Events</button>
      </div>
    `;
    const dayInput = schedBody.querySelector('.sys-sched-day');
    const descInput = schedBody.querySelector('.sys-sched-desc');
    const addBtn = schedBody.querySelector('.sys-sched-btn');
    const hintEl = schedBody.querySelector('.sys-sched-hint');
    const clearNonDefaultHint = ()=>{
      if(hintEl.classList.contains('is-error') || hintEl.classList.contains('is-notice')){
        hintEl.textContent = hintDefaultText;
        hintEl.classList.remove('is-error', 'is-notice');
      }
    };
    descInput.oninput = clearNonDefaultHint;
    dayInput.oninput = clearNonDefaultHint;
    addBtn.onclick = async ()=>{
      const desc = descInput.value.trim();
      if(!desc){ descInput.focus(); return; }
      if(looksLikeRewardText(desc)){
        hintEl.textContent = 'Describe the event, not what you get from it — rewards are earned in the story.';
        hintEl.classList.remove('is-notice');
        hintEl.classList.add('is-error');
        descInput.focus();
        return;
      }
      const dayVal = dayInput.value.trim();
      const parsedDay = dayVal ? parseInt(dayVal, 10) : null;
      addBtn.disabled = true; addBtn.textContent = 'Adding…';
      const { day, clamped } = await addScheduledEvent(worldId, parsedDay, desc);
      await paintSched(clamped ? `Day ${parsedDay} has already passed — added as Day ${day} (today) instead.` : null);
    };
  };


  // Switching tiles: paint the target's content BEFORE revealing it (not after), and
  // guard against a second tap landing mid-fetch. The old order — open the (still empty)
  // panel, then await the data fetch — showed a blank box that suddenly popped full a
  // beat later, which read as a flicker/glitch every time you switched tiles. Painting
  // first means the switch is a single, complete visual change with nothing to pop in
  // afterward, and the CSS below gives it a small fade/slide instead of a hard snap.
  let switching = false;
  tiles.forEach(tile=>{
    tile.onclick = async ()=>{
      if(switching) return;
      const body = schedBody;
      const wasOpen = body.classList.contains('open');
      if(wasOpen){ closeAll(); return; } // tapping an already-open tile just collapses it
      switching = true;
      tiles.forEach(t=>t.disabled = true);
      try{
        await paintSched();
      } finally {
        closeAll();
        tile.classList.add('active');
        body.classList.add('open');
        tiles.forEach(t=>t.disabled = false);
        switching = false;
      }
    };
  });
}


// ---------- message long-press: copy / delete (rewinds the story) ----------
let msgLongPressTimer = null;
function attachMsgLongPress(bubbleEl, index, text){
  if(!bubbleEl) return;
  const start = (e)=>{
    if(e.touches && e.touches.length > 1) return;
    msgLongPressTimer = setTimeout(()=> openMsgCtxMenu(bubbleEl, index, text), 480);
  };
  const cancel = ()=>{ clearTimeout(msgLongPressTimer); };
  bubbleEl.addEventListener('touchstart', start, {passive:true});
  bubbleEl.addEventListener('touchend', cancel);
  bubbleEl.addEventListener('touchmove', cancel);
  bubbleEl.addEventListener('touchcancel', cancel);
  bubbleEl.addEventListener('mousedown', start);
  bubbleEl.addEventListener('mouseup', cancel);
  bubbleEl.addEventListener('mouseleave', cancel);
}

function openMsgCtxMenu(bubbleEl, index, text){
  const rect = bubbleEl.getBoundingClientRect();
  const menu = els.msgCtxMenu;
  els.msgCtxOverlay.style.display = 'block';
  menu.style.visibility = 'hidden';
  menu.style.display = 'flex';
  const menuWidth = menu.offsetWidth || 150;
  const menuHeight = menu.offsetHeight || 100;
  const gap = 10;

  const headerRect = els.chatHeader ? els.chatHeader.getBoundingClientRect() : {bottom:70};
  const footerRect = els.chatFooter ? els.chatFooter.getBoundingClientRect() : {top: window.innerHeight - 140};
  const minTop = headerRect.bottom + gap;
  const maxBottom = footerRect.top - gap;

  const spaceRight = window.innerWidth - 10 - (rect.right + gap);
  const spaceLeft = (rect.left - gap) - 10;

  let left;
  if(menuWidth <= spaceRight || spaceRight >= spaceLeft){
    left = rect.right + gap;
  } else {
    left = rect.left - menuWidth - gap;
  }
  if(left < 10) left = 10;
  if(left + menuWidth > window.innerWidth - 10) left = window.innerWidth - menuWidth - 10;

  let top = rect.top + rect.height/2 - menuHeight/2;
  if(top < minTop) top = minTop;
  if(top + menuHeight > maxBottom) top = Math.max(minTop, maxBottom - menuHeight);

  menu.style.top = top + 'px';
  menu.style.left = left + 'px';
  menu.style.visibility = '';
  menu.dataset.index = index;
  menu.dataset.text = text;
  requestAnimationFrame(()=>{
    menu.classList.add('open');
    els.msgCtxOverlay.classList.add('open');
  });
  pushNavState('modal');
}

let msgCtxCloseToken = 0;
function closeMsgCtxMenu(){
  const menu = els.msgCtxMenu;
  menu.classList.remove('open');
  els.msgCtxOverlay.classList.remove('open');
  const myToken = ++msgCtxCloseToken;
  setTimeout(()=>{
    if(myToken === msgCtxCloseToken){ menu.style.display = 'none'; els.msgCtxOverlay.style.display = 'none'; }
  }, 320);
}
els.msgCtxOverlay.onclick = closeMsgCtxMenu;

els.msgCtxCopy.onclick = async ()=>{
  const text = els.msgCtxMenu.dataset.text || '';
  try{ await navigator.clipboard.writeText(text); }catch(e){}
  closeMsgCtxMenu();
};

els.msgCtxDelete.onclick = async ()=>{
  const index = Number(els.msgCtxMenu.dataset.index);
  closeMsgCtxMenu();
  if(!state.chattingId || isNaN(index)) return;
  // A reply still in flight is holding its own copy of the chat array and will save it
  // back (with the new AI reply appended) once it resolves — that stale save would
  // silently resurrect whatever gets deleted here in the meantime. Block deletion until
  // the in-flight send/regenerate finishes so the two writes can never race each other.
  if(isSending){ alert('Please wait for the current reply to finish before deleting a message.'); return; }
  const world = await getWorld(state.chattingId);
  let chat = await getChat(state.chattingId);
  chat = chat.slice(0, index);
  await saveChat(state.chattingId, chat);
  document.querySelectorAll('.msg-actions').forEach(a=>a.remove());
  document.querySelectorAll('.sys-tools-wrap').forEach(a=>a.remove());
  els.log.innerHTML = '';
  chat.forEach((m,i) => renderMsg(m, i===chat.length-1, i, false)); // pin once below, not per-message — see note above
  pinToBottomAfterRender();
  // Rewinding can leave the memory/character sheet referencing a branch that no
  // longer exists — resync both against the trimmed chat before the next reply,
  // so the story doesn't contradict itself.
  if(world) showTyping();
  try{ if(world) await queueWorldOp(world.id, ()=>resyncMemoryAndPanel(world, chat)); }
  catch(e){ console.error('[resync after delete failed]', e); }
  finally{ if(world) hideTyping(); }
};

function showTyping(){
  const wrap = document.createElement('div'); wrap.className = 'msg ai typing'; wrap.id = 'typingIndicator';
  wrap.innerHTML = `<div class="bubble"><span></span><span></span><span></span></div>`;
  els.log.appendChild(wrap); scrollLogToBottom(); pinToBottomAfterRender();
}
function hideTyping(){ document.getElementById('typingIndicator')?.remove(); }

els.chatSettingsBtn.onclick = ()=>{ els.chatSettingsModal.style.display = 'flex'; pushNavState('modal'); };
els.chatSettingsModal.onclick = (e)=>{ if(e.target===els.chatSettingsModal) els.chatSettingsModal.style.display='none'; };

els.csMemoryBtn.onclick = async ()=>{
  els.chatSettingsModal.style.display = 'none';
  const mem = await getMemory(state.chattingId);
  els.memoryContent.textContent = mem || 'Nothing remembered yet — memory builds up as you play.';
  els.memoryModal.style.display = 'flex';
  pushNavState('modal');
};
els.closeMemoryBtn.onclick = ()=> els.memoryModal.style.display = 'none';
els.memoryModal.onclick = (e)=>{ if(e.target===els.memoryModal) els.memoryModal.style.display='none'; };

// ---------- export / import a world (download & continue later, on this device or another) ----------
async function exportWorld(id){
  const world = await getWorld(id);
  if(!world) return;
  const chat = await getChat(id);
  const memory = await getMemory(id);
  const panel = await getPanel(id);
  const payload = { app:'worlds-export', version:1, exportedAt:new Date().toISOString(), world, chat, memory, panel };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (world.name||'world').trim().replace(/[^a-z0-9]+/gi,'_').toLowerCase() + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
els.csExportBtn.onclick = ()=>{ els.chatSettingsModal.style.display = 'none'; if(state.chattingId) exportWorld(state.chattingId); };

async function importWorldFromFile(file){
  let data;
  try{ data = JSON.parse(await file.text()); }
  catch(e){ alert('That file isn\'t a valid world backup.'); return; }
  if(!data || !data.world || !data.world.name){ alert('That file isn\'t a valid world backup.'); return; }

  const index = await getIndex();
  let id = data.world.id;
  if(!id || index.some(w=>w.id===id)) id = 'w'+Date.now(); // avoid clobbering an existing world
  const world = {...data.world, id};

  await saveWorld(world);
  if(Array.isArray(data.chat)) await saveChat(id, data.chat);
  if(typeof data.memory === 'string') await saveMemory(id, data.memory);
  if(data.panel && typeof data.panel === 'object') await savePanel(id, data.panel);

  index.push({id, name:world.name, cover:world.cover||null});
  await saveIndex(index);
  await renderLibrary();
  await openStory(id); // jump straight in — the story continues from where the file left off
}

// Overwrites the CURRENTLY OPEN world's chat/memory/character-sheet with a backup file's
// content, instead of spinning up a separate world like importWorldFromFile does. The
// world's own identity (name, cover, lore, opening line) is left untouched — only the
// story-so-far changes to match the imported file.
async function importIntoCurrentWorld(file){
  const id = state.chattingId;
  if(!id) return;
  let data;
  try{ data = JSON.parse(await file.text()); }
  catch(e){ alert('That file isn\'t a valid world backup.'); return; }
  if(!data || !data.world || !data.world.name){ alert('That file isn\'t a valid world backup.'); return; }
  if(!confirm('Replace this world\'s current story, memory, and character sheet with the imported file\'s content? This can\'t be undone.')) return;

  await saveChat(id, Array.isArray(data.chat) ? data.chat : []);
  await saveMemory(id, typeof data.memory === 'string' ? data.memory : '');
  await savePanel(id, (data.panel && typeof data.panel === 'object') ? data.panel : defaultPanel());
  await openStory(id); // re-render the chat, memory, and panel from the freshly-overwritten data
}
els.csImportIntoBtn.onclick = ()=>{ els.chatSettingsModal.style.display = 'none'; els.csImportIntoFileInput.click(); };
els.csImportIntoFileInput.onchange = ()=>{
  const file = els.csImportIntoFileInput.files[0];
  els.csImportIntoFileInput.value = '';
  if(file) importIntoCurrentWorld(file);
};

let isSending = false;

async function regenerateLast(){
  if(isSending) return;
  // Guard set immediately, before any await — otherwise a rapid double-tap can slip
  // through the gap while world/chat are still being fetched and fire twice.
  isSending = true; els.sendBtn.disabled = true;
  const world = await getWorld(state.chattingId);
  if(!world){ isSending = false; els.sendBtn.disabled = false; return; } // bail out cleanly rather than throwing and leaving the button stuck disabled
  let chat = await getChat(world.id);
  const wasSystem = chat.length && chat[chat.length-1].role==='system';
  if(chat.length && (chat[chat.length-1].role==='ai' || chat[chat.length-1].role==='system')) chat.pop();
  els.log.lastElementChild?.remove();
  scrollLogToBottom(); pinToBottomAfterRender();
  await saveChat(world.id, chat);
  if(wasSystem){
    const lastUser = [...chat].reverse().find(m=>m.role==='user');
    await systemReply(world, chat, lastUser ? lastUser.text : '');
  }else{
    // The discarded reply may already be baked into memory/panel if it landed on a
    // batch boundary — resync against the trimmed chat so the new reply doesn't
    // generate alongside facts from the version we just threw away.
    try{ await queueWorldOp(world.id, ()=>resyncMemoryAndPanel(world, chat)); }
    catch(e){ console.error('[resync before regenerate failed]', e); }
    await continueStory(world, chat);
  }
}

// Re-verified: this shares continueStory()/updatePanel()/updateMemory()/worldSystemPrompt()
// with sendMessage() and regenerateLast() (no forward-only branch anywhere in that pipeline),
// so every guard fixed elsewhere already applies here with zero extra wiring:
//  - guardTimelineDay is called with allowBackward unset (falsy) on this path, same as a
//    normal send — Current Day still can't move backward from a forward-button turn.
//  - maxAllowedDaySkip/isCountdownContext (the "go back N days" / "N days left" exclusions)
//    run against whatever recent log text this turn produces, same regex, same function.
//  - the expanded CROSS-CATEGORY CONSISTENCY rule (Money/Inventory/Skills/Timeline/Scheduled
//    Events) lives in worldSystemPrompt(), which this path calls identically to sendMessage.
//  - the Scheduled Events reward-language guard is a separate, deterministic UI-only check
//    (looksLikeRewardText) with no AI turn involved, so it's unaffected by which button fired.
// None of this depends on in-memory state that resets on page reload — panel/memory/chat are
// all re-read from IndexedDB each call, and isSending is just a double-tap guard.
async function continueForward(){
  if(isSending) return;
  isSending = true; els.sendBtn.disabled = true; // same guard-before-await fix as regenerateLast
  const world = await getWorld(state.chattingId);
  if(!world){ isSending = false; els.sendBtn.disabled = false; return; } // bail out cleanly rather than throwing and leaving the button stuck disabled
  const chat = await getChat(world.id);
  document.querySelectorAll('.msg-actions').forEach(a=>a.remove());
  document.querySelectorAll('.sys-tools-wrap').forEach(a=>a.remove());
  scrollLogToBottom(); pinToBottomAfterRender();
  await continueStory(world, chat, 'forward');
}

async function continueStory(world, chat, mode, panelOpts){
  isSending = true; els.sendBtn.disabled = true;
  let memory = await getMemory(world.id);
  const panel = await getPanel(world.id);
  // Free, non-AI cross-check: correct any stale number in memory against the letter of
  // records before the story prompt is built. No tokens spent.
  const fixedMemory = crossCheckMemoryAgainstPanel(memory, panel);
  if(fixedMemory !== memory){ memory = fixedMemory; await saveMemory(world.id, memory); }
  const recentLog = chat.slice(-6).map(m => m.role==='system' ? `[OOC aside, not part of the scene] ${messageToLogLine(m)}` : messageToLogLine(m)).join('\n');
  showTyping();
  let reply;
  const instruction = mode === 'forward'
    ? `Continue the story forward on your own — the player hasn't said or done anything new. Advance time, have a character act, or introduce a development, and end on a moment the player can react to. IMPORTANT: since the player didn't take any action this turn, do not narrate a transaction as already completed on their behalf — don't have them spend currency, hand over an item, pay a fee, get charged, or lose/gain any tracked resource as a done deal. You may introduce a cost, price, or demand as something the player now faces (a bill comes due, a toll is demanded, a merchant names a price), but leave it unresolved for the player to actually decide on and act on next turn.`
    : `Continue the story naturally in response to what the player just did or said.`;
  // Short reminder placed as the very last thing before generation (right after the recent
  // log and instruction, closest to where the reply is actually written) — the HARD LIMIT
  // rule earlier in the system prompt already states the full restriction in detail, this is
  // deliberately just a one-line nudge back to it, not a restatement of the sheet itself, so
  // it costs almost no extra tokens while still catching the model's attention at the moment
  // it matters most.
  const finalReminder = panel ? `\n\nReminder: stay strictly within the letter of records above — don't let this turn give the player more money, items, or abilities than it lists, or let them spend/use more than it lists, no matter what their message assumes.` : '';
  try{
    reply = await askAI(worldSystemPrompt(world, memory, panel), `Story so far:\n${recentLog}\n\n${instruction}${finalReminder}`);
  }catch(err){
    hideTyping();
    const w = document.createElement('div'); w.className = 'warn'; w.textContent = '⚠️ ' + err.message;
    els.log.appendChild(w); pinToBottomAfterRender();
    els.sendBtn.disabled = false; isSending = false;
    return;
  }
  hideTyping();
  document.querySelectorAll('.msg-actions').forEach(a=>a.remove());
  document.querySelectorAll('.sys-tools-wrap').forEach(a=>a.remove());
  chat.push({role:'ai', text:reply, ts:Date.now()});
  renderMsg({role:'ai', text:reply}, true, chat.length-1);
  await saveChat(world.id, chat);
  els.sendBtn.disabled = false; isSending = false;
  queueWorldOp(world.id, async ()=>{ await updateMemory(world); await updatePanel(world, panelOpts); });
}

// ---------- "system" — an out-of-character assistant the player can summon by name ----------
function isSystemTrigger(text){ return /^\s*system\s+bro\b/i.test(text); }

async function systemReply(world, chat, userText){
  isSending = true; els.sendBtn.disabled = true;
  let memory = await getMemory(world.id);
  const panel = await getPanel(world.id);
  // Free, non-AI cross-check: make sure the System never reads/repeats a stale number from
  // memory when the letter of records already has the correct one. No tokens spent.
  const fixedMemory = crossCheckMemoryAgainstPanel(memory, panel);
  if(fixedMemory !== memory){ memory = fixedMemory; await saveMemory(world.id, memory); }
  const recentLog = chat.slice(-6).map(messageToLogLine).join('\n');
  showTyping();
  const sysPrompt = `You are "the System" — a casual, friendly out-of-character assistant built into this interactive-fiction app. The player just broke the fourth wall to talk to you directly instead of acting in the story. Reply out of character, never as any story character or narrator.

You have full access to the player's memory log and character sheet (letter of records) below — use them as ground truth to answer ANY question the player asks about the story: their inventory, money, powers/jutsu/skills, relationships, status, past events, or anything else on the sheet or in the memory. Never guess or make up a detail that isn't actually there — if the player asks about something not recorded anywhere, tell them honestly it's not something they have/know/that's happened yet, don't invent an answer to be helpful.

Format the reply like this, using **bold** for labels and lines starting with "- " for bullets:
1. One short casual greeting line (e.g. "Yo! What's up?").
2. One short paragraph recapping where the player currently is and what's at stake, based on the log below.
3. A "**Current Situation:**" bullet list — one bullet per relevant character or goal, each starting with a bolded name/label followed by a very short status.
4. Directly answer whatever the player just said or asked, in one or two short lines — pulling exact facts from the character sheet or memory when relevant (e.g. exact money amount, exact items held, exact powers known).
5. If there's nothing more to add, end with "What's the move?"

Keep it short, punchy, and casual. Never slip into full story narration — this is a status/chat reply, not a scene.`;
  let reply;
  try{
    reply = await askAI(sysPrompt, `World: ${world.name}\n\nCharacter sheet (letter of records):\n${panel ? panelToText(panel) : '(none yet)'}\n\nMemory:\n${memory || '(none yet)'}\n\nRecent log:\n${recentLog}\n\nPlayer just said: "${userText}"`);
  }catch(err){
    hideTyping();
    const w = document.createElement('div'); w.className = 'warn'; w.textContent = '⚠️ ' + err.message;
    els.log.appendChild(w); pinToBottomAfterRender();
    els.sendBtn.disabled = false; isSending = false;
    return;
  }
  hideTyping();
  document.querySelectorAll('.msg-actions').forEach(a=>a.remove());
  document.querySelectorAll('.sys-tools-wrap').forEach(a=>a.remove());
  chat.push({role:'system', text:reply, ts:Date.now()});
  renderMsg({role:'system', text:reply}, true, chat.length-1);
  await saveChat(world.id, chat);
  els.sendBtn.disabled = false; isSending = false;
  // OOC chat doesn't feed the story memory — it's a side-channel, not part of the narrative
}

// NOTE: "add a schedule event ..." used to be a second free-text chat command a player
// could type directly into the story (bypassing all claim checks and writing straight to
// the letter of records). That trigger has been removed — adding a scheduled event is now
// only possible through the "Scheduled Events" tile inside the "system bro" reply (see
// attachSystemToolsPanel/addScheduledEvent above), a deliberate structured form rather
// than something reachable by phrasing a normal message a certain way.

// ---------- send button long-press: attach photo / gif / video ----------
let sendLongPressTimer = null;
let sendLongPressFired = false;
els.sendBtn.addEventListener('touchstart', ()=>{
  sendLongPressFired = false;
  sendLongPressTimer = setTimeout(()=>{ sendLongPressFired = true; openMediaDrawer(); }, 480);
}, {passive:true});
els.sendBtn.addEventListener('touchend', (e)=>{ clearTimeout(sendLongPressTimer); if(sendLongPressFired) e.preventDefault(); });
els.sendBtn.addEventListener('touchmove', ()=> clearTimeout(sendLongPressTimer));
els.sendBtn.addEventListener('mousedown', ()=>{
  sendLongPressFired = false;
  sendLongPressTimer = setTimeout(()=>{ sendLongPressFired = true; openMediaDrawer(); }, 480);
});
els.sendBtn.addEventListener('mouseup', ()=> clearTimeout(sendLongPressTimer));
els.sendBtn.addEventListener('mouseleave', ()=> clearTimeout(sendLongPressTimer));
els.sendBtn.addEventListener('click', (e)=>{ if(sendLongPressFired){ e.preventDefault(); e.stopImmediatePropagation(); sendLongPressFired = false; } });

function openMediaDrawer(){
  els.mediaDrawerOverlay.style.display = 'block';
  els.mediaDrawer.classList.add('open');
  pushNavState('modal');
}
function closeMediaDrawer(){
  els.mediaDrawerOverlay.style.display = 'none';
  els.mediaDrawer.classList.remove('open');
}
els.mediaDrawerOverlay.onclick = closeMediaDrawer;

els.mediaPhotoBtn.onclick = ()=>{ els.mediaFileInput.accept = 'image/*'; els.mediaFileInput.dataset.kind='image'; els.mediaFileInput.click(); closeMediaDrawer(); };
els.mediaGifBtn.onclick = ()=>{ els.mediaFileInput.accept = 'image/gif'; els.mediaFileInput.dataset.kind='image'; els.mediaFileInput.click(); closeMediaDrawer(); };
els.mediaVideoBtn.onclick = ()=>{ els.mediaFileInput.accept = 'video/*'; els.mediaFileInput.dataset.kind='video'; els.mediaFileInput.click(); closeMediaDrawer(); };

els.mediaFileInput.addEventListener('change', async ()=>{
  const file = els.mediaFileInput.files[0];
  const kind = els.mediaFileInput.dataset.kind || 'image';
  els.mediaFileInput.value = '';
  if(!file || !state.chattingId || isSending) return;
  // Guard set immediately, before any await, matching the same fix applied to
  // sendMessage/regenerateLast/continueForward — and wrapped in try/finally so a
  // failure anywhere below (bad file, read error) can't leave the button stuck disabled.
  isSending = true; els.sendBtn.disabled = true;
  try{
    const url = await new Promise((res, rej)=>{
      const r = new FileReader();
      r.onload = ()=> res(r.result);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
    const world = await getWorld(state.chattingId);
    if(!world){ isSending = false; els.sendBtn.disabled = false; return; } // bail out cleanly rather than leaving the button stuck disabled
    let chat = await getChat(world.id);
    document.querySelectorAll('.msg-actions').forEach(a=>a.remove());
  document.querySelectorAll('.sys-tools-wrap').forEach(a=>a.remove());
    const msg = {role:'user', text:'', media:{kind, url}, ts:Date.now()};
    chat.push(msg);
    renderMsg(msg, false, chat.length-1);
    scrollLogToBottom(); pinToBottomAfterRender();
    await saveChat(world.id, chat);
    // A sent photo/video is still the player's turn — the story must react to it just like
    // a text message would, or the player is left hanging with no reply. continueStory
    // manages isSending/sendBtn itself from here on the success path.
    await continueStory(world, chat);
  }catch(e){
    console.error('[media send failed]', e);
    isSending = false; els.sendBtn.disabled = false;
  }
});

// ---------- shared inventory drag-to-merge (+ delete) wiring ----------
// Long-press-drag-to-merge (and the resulting confirm/cancel name bar), plus each chip's
// own delete cross, now live ONLY on the dedicated, larger-size Inventory-only page
// (openInventoryModal below) — the main Letter of Records shows Inventory as plain,
// non-interactive chips. Kept as its own function (rather than inlined into
// paintInventoryModal) purely so the pointer-event plumbing doesn't clutter the modal's
// own open/paint/close logic.
function wireInventoryChipDrag(container, worldId, pendingRef, repaint){
  // Deterministic, user-initiated merge: no AI/guard chain involved at all, since the
  // player physically dragged both ingredients together themselves — there's nothing to
  // ground or confirm beyond the drag-drop gesture that already happened.
  const doMerge = async (idA, idB, newName)=>{
    const name = String(newName || '').trim();
    if(!name) return;
    await queueWorldOp(worldId, async ()=>{
      const fresh = await getPanel(worldId);
      const freshInv = fresh.categories['Inventory'];
      if(!freshInv || !freshInv.data || !Array.isArray(freshInv.ids)) return;
      const idxA = freshInv.ids.indexOf(idA);
      const idxB = freshInv.ids.indexOf(idB);
      if(idxA === -1 || idxB === -1) return; // one of the two dragged items vanished from under this action — abort safely, remove nothing

      // Quantity-aware merge: a drag only ever consumes ONE unit from each side, using the
      // same "N <name>" quantity parsing as the stackable-items guard (splitItemEntry — no
      // leading number means an implicit quantity of 1). A stack with more than one left
      // just loses one and stays put; a side down to its last (or only ever having had one)
      // vanishes entirely. e.g. "1 kunai" + "10 poison bottle" -> new "poison kunai" merged
      // item, kunai gone, "9 poison bottle" left. "10 kunai" + "10 poison bottle" -> new
      // merged item, "9 kunai" and "9 poison bottle" both left behind.
      const parsedA = splitItemEntry(freshInv.data[idxA]);
      const parsedB = splitItemEntry(freshInv.data[idxB]);
      const qtyA = (parsedA.qty == null || isNaN(parsedA.qty)) ? 1 : parsedA.qty;
      const qtyB = (parsedB.qty == null || isNaN(parsedB.qty)) ? 1 : parsedB.qty;
      const remainA = qtyA - 1, remainB = qtyB - 1;

      // The merged item lands where the DROP TARGET (idB) was — same "lands in place" fix
      // as before. Process whichever original index is HIGHER first, since updating/removing
      // it can never shift the position of the lower one; only removing the LOWER one can
      // shift a higher position, so that adjustment is applied afterward, to insertAt only
      // when it's actually needed (B was the higher index and A got removed out from under it).
      //
      // BUG FIX: the merged result used to always get a brand-new ID/number, even when one
      // whole side of the merge was fully consumed — so "#1 Kunai" + "#4 Poison Vial" ->
      // "Poisoned Kunai" landed as some unrelated "#7", which broke the promise that a
      // stack's number survives whatever happens to it. Now: if the TARGET side (B) is fully
      // used up, the merged item inherits ITS id — that slot visually "became" the merged
      // item, so it keeps its number. Otherwise, if the SOURCE (A) is the one fully used up
      // (B had leftovers and keeps its own id for that leftover stack), the merged item
      // inherits A's id instead. A fresh id is only minted in the one case where NEITHER side
      // was used up — both original stacks still exist afterward with their own numbers, so
      // the newly formed combined item genuinely has no existing identity to inherit. This is
      // computed up front, independent of the splice order below (which is purely about
      // keeping array indices correct, not about which id "wins").
      const mergedId = remainB <= 0 ? idB : (remainA <= 0 ? idA : genInvId(fresh));
      let insertAt;
      if(idxB > idxA){
        if(remainB > 0){ freshInv.data[idxB] = rebuildItemEntry(remainB, parsedB.name, parsedB.status); insertAt = idxB + 1; }
        else{ freshInv.data.splice(idxB, 1); freshInv.ids.splice(idxB, 1); insertAt = idxB; }
        if(remainA > 0){ freshInv.data[idxA] = rebuildItemEntry(remainA, parsedA.name, parsedA.status); }
        else{ freshInv.data.splice(idxA, 1); freshInv.ids.splice(idxA, 1); insertAt--; }
      }else{
        if(remainA > 0){ freshInv.data[idxA] = rebuildItemEntry(remainA, parsedA.name, parsedA.status); }
        else{ freshInv.data.splice(idxA, 1); freshInv.ids.splice(idxA, 1); }
        if(remainB > 0){ freshInv.data[idxB] = rebuildItemEntry(remainB, parsedB.name, parsedB.status); insertAt = idxB + 1; }
        else{ freshInv.data.splice(idxB, 1); freshInv.ids.splice(idxB, 1); insertAt = idxB; }
      }
      insertAt = Math.max(0, Math.min(insertAt, freshInv.data.length));
      freshInv.data.splice(insertAt, 0, name);
      freshInv.ids.splice(insertAt, 0, mergedId);
      await savePanel(worldId, fresh);
    });
    pendingRef.set(null);
    await repaint();
  };

  // Per-item delete no longer lives on this page — it moved to the long-press action sheet
  // on the main Letter of Records view (see deleteInventoryItemById in
  // script_letter-of-records.js). No .panel-chip-del crosses are rendered here anymore, so
  // there's nothing left to wire up for it on this container.

  if(mergeConfirmBtn) mergeConfirmBtn.onclick = ()=>{
    const pending = pendingRef.get();
    if(pending) doMerge(pending.a.id, pending.b.id, pending.name);
  };
  const mergeCancelBtn = container.querySelector('.panel-merge-cancel');
  if(mergeCancelBtn) mergeCancelBtn.onclick = ()=>{ pendingRef.set(null); repaint(); };
  container.querySelectorAll('.panel-merge-option').forEach(btn=>{
    btn.onclick = ()=>{
      const pending = pendingRef.get();
      if(!pending) return;
      pendingRef.set({ ...pending, name: btn.dataset.name });
      repaint();
    };
  });

  if(pendingRef.get()) return; // a merge confirm bar is already showing — don't also arm a new drag underneath it

  // ---- long-press-then-drag: no separate "merge mode" toggle. Holding a chip still for
  // LONG_PRESS_MS arms it — at that instant the chip itself is cloned into a full-size
  // floating copy that sticks to the finger, while the real chip in the list dims in
  // place. Moving too far before that timer fires cancels the press outright, so an
  // ordinary scroll/tap is never mistaken for a drag, and normal up/down scrolling through
  // a long inventory list keeps working right up until a press actually arms. Built on
  // Pointer Events (not HTML5 drag-and-drop) since HTML5 DnD doesn't fire from a finger
  // touch on most phones/tablets — Pointer Events unify mouse, touch, and pen so the same
  // code handles a mouse drag on desktop and a finger drag on a phone identically.
  const chips = Array.from(container.querySelectorAll('.panel-chip[data-id]'));
  let drag = null; // { id, label, chip, armed, startX, startY, offsetX, offsetY, ghost, timer }
  const LONG_PRESS_MS = 380;      // hold time before a press arms into a draggable pickup
  const PRESS_CANCEL_PX = 24;     // movement past this before arming cancels the press — loose
                                   // enough to absorb ordinary finger tremor during the hold
                                   // (a real scroll attempt moves well past this within 380ms;
                                   // a held finger waiting to arm typically doesn't), tight
                                   // enough to still tell the two apart

  // The scrollable ancestor (.sheet-scroll) that holds the whole chip list — needed so an
  // armed drag can auto-scroll it near the top/bottom edges instead of the drag just
  // stalling (or, worse, the browser's own touch-scroll stealing the gesture out from
  // under us and firing pointercancel, which is what made an accidental scroll snap the
  // dragged item back to its original spot instead of following the finger).
  const scrollEl = container.closest('.sheet-scroll') || container.parentElement;
  const AUTO_SCROLL_EDGE = 64;    // px from the scrollable area's edge that starts auto-scroll
  const AUTO_SCROLL_MAX_PX = 16;  // fastest auto-scroll speed, in px per animation frame
  let autoScrollRAF = null;

  const updateDropTarget = (chip, x, y)=>{
    chips.forEach(c=>{ if(c !== chip) c.classList.remove('is-drop-target'); });
    const under = document.elementFromPoint(x, y);
    const targetChip = under ? under.closest('.panel-chip[data-id]') : null;
    if(targetChip && targetChip !== chip) targetChip.classList.add('is-drop-target');
  };

  // Runs every frame while a drag is armed, so holding the ghost near the top or bottom
  // edge of the list scrolls it smoothly (proportional to how close to the edge the
  // finger is) at the same time the ghost keeps tracking the finger — the two stay in
  // sync because the ghost's position is driven purely by clientX/clientY (viewport
  // coordinates, unaffected by scrolling) while elementFromPoint is re-checked every
  // frame here rather than only on pointermove, since the finger can sit still at the
  // edge while the list keeps scrolling underneath it.
  const stepAutoScroll = ()=>{
    if(!drag || !drag.armed){ autoScrollRAF = null; return; }
    if(scrollEl){
      const rect = scrollEl.getBoundingClientRect();
      const y = drag.lastY;
      let speed = 0;
      if(y < rect.top + AUTO_SCROLL_EDGE){
        speed = -Math.ceil(((rect.top + AUTO_SCROLL_EDGE - y) / AUTO_SCROLL_EDGE) * AUTO_SCROLL_MAX_PX);
      } else if(y > rect.bottom - AUTO_SCROLL_EDGE){
        speed = Math.ceil(((y - (rect.bottom - AUTO_SCROLL_EDGE)) / AUTO_SCROLL_EDGE) * AUTO_SCROLL_MAX_PX);
      }
      if(speed !== 0) scrollEl.scrollTop += speed;
    }
    updateDropTarget(drag.chip, drag.lastX, drag.lastY);
    autoScrollRAF = requestAnimationFrame(stepAutoScroll);
  };

  const clearDragVisuals = ()=>{
    chips.forEach(c=>{ c.classList.remove('is-drop-target'); c.classList.remove('is-dragging'); c.classList.remove('is-pressing'); });
    if(drag && drag.timer) clearTimeout(drag.timer);
    if(drag && drag.ghost && drag.ghost.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
    if(drag && drag.chip) drag.chip.style.touchAction = 'pan-y'; // undo the 'none' lock set in armDrag
    if(autoScrollRAF){ cancelAnimationFrame(autoScrollRAF); autoScrollRAF = null; }
    if(scrollEl) scrollEl.style.touchAction = '';
    drag = null;
  };

  // Turns the live chip into the thing that follows the finger: a full-size clone
  // (same width, height, padding, text) positioned exactly on top of the original, then
  // the original dims to `is-dragging` so it reads as "lifted out" rather than duplicated.
  // left/top are set once, to the chip's own on-screen position — all subsequent movement
  // is done purely via `transform: translate()`, which the browser can animate on the GPU
  // compositor thread without forcing a layout recalculation on every pointermove. Moving
  // it by changing left/top instead (as an earlier version of this did) forces a full
  // reflow per event and is what made the drag feel laggy/glitchy on a phone.
  const armDrag = ()=>{
    if(!drag) return;
    const chip = drag.chip;
    const rect = chip.getBoundingClientRect();
    const ghost = chip.cloneNode(true);
    ghost.className = 'panel-chip panel-chip-ghost';
    ghost.style.width = rect.width + 'px';
    ghost.style.height = rect.height + 'px';
    ghost.style.left = rect.left + 'px';
    ghost.style.top = rect.top + 'px';
    ghost.style.transform = 'scale(1.04)';
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    drag.armed = true;
    drag.lastX = drag.startX;
    drag.lastY = drag.startY;
    chip.classList.remove('is-pressing');
    chip.classList.add('is-dragging');
    // Once armed, hand scrolling entirely to our own auto-scroll loop — locking the
    // scroll container's touch-action stops the browser from also interpreting the same
    // finger movement as a native scroll gesture (which used to fire pointercancel mid-
    // drag and snap the item back, since that cancels the whole pickup).
    // BUG FIX (vertical drag getting hijacked as a page-scroll): the chip itself was left at
    // its resting `touch-action: pan-y` (set below, so plain scrolling still works before a
    // press arms) for the ENTIRE gesture — only the scroll container's touch-action got
    // locked to 'none' here. Since `pan-y` is what tells the browser "you're allowed to take
    // vertical finger movement as a native scroll on this element," the browser kept doing
    // exactly that on the chip itself once the finger actually moved vertically, regardless
    // of the scroll container's own setting or this handler's preventDefault() — the ghost
    // would stall/jump instead of tracking the finger, and horizontal drags looked fine only
    // because `pan-y` never claimed horizontal movement in the first place. Locking the CHIP
    // to 'none' too (restored back to 'pan-y' in clearDragVisuals once the drag ends) is what
    // actually stops the browser from claiming vertical movement mid-drag.
    chip.style.touchAction = 'none';
    if(scrollEl) scrollEl.style.touchAction = 'none';
    if(!autoScrollRAF) autoScrollRAF = requestAnimationFrame(stepAutoScroll);
    // navigator.vibrate() call removed here — the native long-press haptic (from Android/
    // Chrome's own touch handling) already fires on its own, so calling vibrate() too
    // produced a double buzz. Only the OS-level tick remains now.
  };

  chips.forEach(chip=>{
    // Allows normal vertical scrolling through the inventory list on a touch that starts
    // on a chip — a long-press-armed drag is the only thing that suspends it (see the
    // preventDefault below), so browsing a long list stays completely ordinary.
    chip.style.touchAction = 'pan-y';
    // Android/Chrome shows its own text-selection/context-menu handling on a held touch by
    // default, complete with its own system haptic tick — on top of the vibrate() above
    // that's what produced two separate buzzes for one long-press. Killing the context
    // menu here stops that native gesture from ever engaging.
    chip.addEventListener('contextmenu', (e)=> e.preventDefault());

    chip.addEventListener('pointerdown', (e)=>{
      if(e.target.closest('.panel-chip-del')) return; // tapping the delete cross is its own action, never a drag pickup
      if(e.pointerType === 'mouse' && e.button !== 0) return; // left-click/primary touch/pen only
      clearDragVisuals();
      drag = { id: chip.dataset.id, label: chip.dataset.label, chip, armed: false, startX: e.clientX, startY: e.clientY, ghost: null, timer: null };
      try{ chip.setPointerCapture(e.pointerId); }catch(_){}
      chip.classList.add('is-pressing');
      drag.timer = setTimeout(armDrag, LONG_PRESS_MS);
    }, { passive: false });

    chip.addEventListener('pointermove', (e)=>{
      if(!drag || drag.chip !== chip) return;
      const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
      if(!drag.armed){
        // Still waiting on the long-press timer — any real movement this early means the
        // person is scrolling the sheet, not trying to pick the item up.
        if(Math.hypot(dx, dy) >= PRESS_CANCEL_PX) clearDragVisuals();
        return;
      }
      // Now armed and carrying the clone — block the page scroll this same touch would
      // otherwise trigger, so the drag doesn't fight the sheet's own scrolling.
      e.preventDefault();
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      drag.ghost.style.transform = `translate(${dx}px, ${dy}px) scale(1.04)`;
      // Highlight whichever OTHER chip is currently underneath the pointer as the drop
      // target — pointer capture keeps events routed to the origin chip, so the actual
      // element under the finger/cursor has to be found manually via elementFromPoint.
      updateDropTarget(chip, e.clientX, e.clientY);
    }, { passive: false });

    const endDrag = (e)=>{
      if(!drag || drag.chip !== chip) return;
      const wasCarrying = !!drag.ghost; // only a real pickup-and-move counts as a drag
      const sourceId = drag.id, sourceLabel = drag.label;
      const under = (e.clientX != null) ? document.elementFromPoint(e.clientX, e.clientY) : null;
      const targetChip = under ? under.closest('.panel-chip[data-id]') : null;
      clearDragVisuals();
      if(!wasCarrying) return; // released before or right at arming, or never moved — no-op
      if(!targetChip || targetChip.dataset.id === sourceId) return; // dropped on empty space or back on itself — no-op
      pendingRef.set({ a: { id: sourceId, label: sourceLabel }, b: { id: targetChip.dataset.id, label: targetChip.dataset.label }, name: autoMergeName(sourceLabel, targetChip.dataset.label) });
      repaint();
    };
    chip.addEventListener('pointerup', endDrag);
    chip.addEventListener('pointercancel', ()=> clearDragVisuals());
  });
}

// Which of the four bottom tabs is currently showing. Module-level so a background repaint
// (a story turn changing Inventory, a merge on the dedicated Inventory page, etc.) redraws
// whichever tab the player currently has open instead of snapping them back to tab 1.
let activePanelTab = 1;
async function paintPanel(){
  if(!state.chattingId) return;
  const worldId = state.chattingId;
  const panel = await getPanel(worldId);
  document.getElementById('panelWorldName').textContent = 'A letter of records';
  // Plain, static display only — no merge state, no drag wiring. Inventory is shown as
  // read-only chips here; long-press-drag-to-merge only exists on the dedicated Inventory
  // page (see openInventoryModal below).
  els.panelContent.innerHTML = renderPanelHtml(panel, { tabFilter: activePanelTab });
}

async function openPanelModal(){
  if(!state.chattingId) return;
  // Always open back on tab 1 (Identity) — only a same-session tab tap or a background
  // repaint should preserve whichever tab is showing.
  activePanelTab = 1;
  els.panelTabBar.querySelectorAll('.panel-tab').forEach(b=> b.classList.toggle('active', b.dataset.tab === '1'));
  await paintPanel();
  showOverlayModal(els.panelModal);
  pushNavState('modal');
}
els.panelBtn.onclick = openPanelModal;
els.closePanelBtn.onclick = ()=>{ hideOverlayModal(els.panelModal); };
els.panelModal.onclick = (e)=>{ if(e.target===els.panelModal){ hideOverlayModal(els.panelModal); } };
els.panelTabBar.addEventListener('click', (e)=>{
  const btn = e.target.closest('.panel-tab');
  if(!btn) return;
  const tab = parseInt(btn.dataset.tab, 10);
  if(tab === activePanelTab) return;
  activePanelTab = tab;
  els.panelTabBar.querySelectorAll('.panel-tab').forEach(b=> b.classList.toggle('active', b === btn));
  const scrollEl = els.panelContent.parentElement; // .sheet-scroll — snap back to top on tab switch
  if(scrollEl) scrollEl.scrollTop = 0;
  paintPanel();
});

// ---------- dedicated, larger-size Inventory-only page ----------
// Opened via the small "expand" button next to the Inventory title on the main Letter of
// Records (see the headerExtra branch in renderPanelHtml above) — same paper theme, same
// modal size/shape as the Letter of Records itself, just scoped to Inventory alone and
// rendered with bigger chips (opts.largeChips). This is now the ONLY place long-press,
// drag, drop, and the merge confirm/cancel name bar exist at all (opts.enableMerge) —
// nothing about how Inventory itself is stored, guarded, or updated changes; this is a
// display/interaction surface only.
let invPendingMerge = null;
// ---------- display-only status grouping (Inventory-only page) ----------
// Groups the Inventory-only page's chips by their status suffix (e.g. every "Equipped" item
// together, every "Sheathed" item together), so equip/carry state is visible at a glance
// without opening the Letter of Records. Items with NO status sort last as their own group.
// Purely a reorder of a COPY for this one render — never mutates panel.categories['Inventory']
// itself, so the panel's own stored array order (what panelToText sends to the AI every turn,
// and what doMerge above looks up fresh by ID from storage, not by screen position) is
// completely unaffected. Array.prototype.sort is stable, so items within the same status group
// keep their existing relative order.
function sortInventoryDisplayByStatus(cat){
  if(!cat || cat.type !== 'list' || !Array.isArray(cat.data)) return cat;
  const ids = Array.isArray(cat.ids) ? cat.ids : [];
  const paired = cat.data.map((entry, i) => ({
    entry,
    id: ids[i] || '',
    status: (splitItemEntry(entry).status || '').toLowerCase()
  }));
  paired.sort((a, b) => {
    if(!a.status && !b.status) return 0;
    if(!a.status) return 1;  // no status -> sorts after every status group
    if(!b.status) return -1;
    return a.status.localeCompare(b.status);
  });
  return { type:'list', data: paired.map(p=>p.entry), ids: paired.map(p=>p.id) };
}
async function paintInventoryModal(){
  if(!state.chattingId) return;
  const worldId = state.chattingId;
  const panel = await getPanel(worldId);
  const inv = panel.categories['Inventory'];
  const invIds = (inv && inv.type==='list' && Array.isArray(inv.ids)) ? inv.ids : [];
  // If the sheet changed underneath a pending merge (an item got used up, renamed, or
  // removed by a story turn while this page was open), drop it rather than let a stale
  // pair try to merge something that's no longer there.
  if(invPendingMerge && (!invIds.includes(invPendingMerge.a.id) || !invIds.includes(invPendingMerge.b.id))) invPendingMerge = null;

  const displayInv = inv ? sortInventoryDisplayByStatus(inv) : null;
  const invOnlyPanel = { categories: displayInv ? { 'Inventory': displayInv } : {} };
  els.invContent.innerHTML = renderPanelHtml(invOnlyPanel, { pendingMerge: invPendingMerge, largeChips: true, showInvExpandBtn: false, enableMerge: true, hideSectionTitle: true });

  wireInventoryChipDrag(els.invContent, worldId, { get:()=>invPendingMerge, set:(v)=>{ invPendingMerge = v; } }, paintInventoryModal);
}
async function openInventoryModal(){
  if(!state.chattingId) return;
  await paintInventoryModal();
  showOverlayModal(els.invModal);
  pushNavState('modal');
}
els.closeInvBtn.onclick = ()=>{
  hideOverlayModal(els.invModal); invPendingMerge = null;
  // The Inventory page is opened FROM the Letter of Records panel (still sitting open
  // behind it, unrepainted) via its "expand" button — without this, a merge done here
  // wouldn't show up on the main sheet (new item, decreased/removed stacks) until the
  // whole Letter of Records was closed and reopened. Repaint it now so it's back in sync
  // the instant this page closes.
  if(els.panelModal.style.display === 'flex') paintPanel();
};
els.invModal.onclick = (e)=>{
  if(e.target===els.invModal){
    hideOverlayModal(els.invModal); invPendingMerge = null;
    if(els.panelModal.style.display === 'flex') paintPanel();
  }
};


