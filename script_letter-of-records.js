/* Load this file AFTER script.chatroom.js — Section 3 (Letter of Records). Depends on globals defined in script.chatroom.js (storage helpers, els, askAI, etc). */

/* ################################################################################
   SECTION 3 — LETTER OF RECORDS (character-sheet engine)
   The Letter of Records data model and every deterministic guard that keeps
   it honest: the panel schema + migrations, Finances (currency up/down
   guards), Inventory (stackable items, equip-status, discard, rename-bypass
   guards), Skills & Abilities (progress, graduation, duplication-math,
   backstop guards), Timeline (day-advancement, time-skip detection),
   Scheduled Events (add/remove, auto-seeding from lore), panel rendering,
   the pre-send claim checkers (currency/inventory/ability), and the "what is
   this section" info modal. Pure data/logic — no story-chat UI lives here.
################################################################################ */

// ================= DATA MODEL & SCHEMA =================
// Panel shape, default/permanent categories, hidden entry IDs, load/save, and migrating
// older saves into the current schema.

// ---------- character panel (persistent, permanent, grows from the chat itself) ----------
// A fixed set of categories is always present (Identity, Finances, Inventory, Skills &
// Abilities, Timeline, Scheduled Events, Milestones, Relationships, Status), plus "Learning"
// which appears the moment training actually begins. This is the COMPLETE set — the AI is no
// longer allowed to invent any brand-new category beyond these (see isRecognizedCategory).
// Each category has a type: 'kv' (named stat/value pairs), 'list' (a growing collection), or
// 'text' (a single free-text value like current status).
//
// ---------- entry identity (hidden internal IDs) ----------
// Every kv key and every list entry additionally gets a permanent, hidden internal ID the
// moment it's first created — stored in a parallel `ids` field alongside `data` (an object
// mapping key->id for 'kv' categories, an array parallel to `data` for 'list' categories).
// The AI itself never sees or sets these IDs; it still communicates in plain text
// (list_add/list_remove/kv keys), and findExistingKey/findFuzzyExistingKey/the list-entry
// pairing logic in mergePanelUpdate below are what resolve that text back to a stable ID.
// Once an entry has an ID, an in-place correction (a status change, a qty update, a name
// tweak) keeps that SAME ID for as long as the entry exists — it is never treated as
// "delete old, create new" at the identity level, even though the visible text changes. This
// is what future phases can build on to target updates by ID instead of re-deriving identity
// from text every time, and it's also what stops a rename/correction from silently producing
// a duplicate, or a percentage bar from resetting because a slightly-reworded name looked new.
function genId(){
  return 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}
function defaultPanel(){
  return { numSeq:0, numMap:{}, photos:{}, categories: {
    'Identity': { type:'kv', data:{}, ids:{} },
    'Finances': { type:'kv', data:{}, ids:{} },
    'Inventory': { type:'list', data:[], ids:[] },
    'Skills & Abilities': { type:'list', data:[], ids:[] },
    'Timeline': { type:'kv', data:{ 'Current Day':'1' }, ids:{ 'Current Day':genId() } },
    'Scheduled Events': { type:'list', data:[], ids:[] },
    'Milestones': { type:'list', data:[], ids:[] },
    'Relationships': { type:'kv', data:{}, ids:{} },
    'Status': { type:'text', data:'' },
  } };
}
function migrateOldPanel(old){
  // upgrades panels saved under the earlier fixed-field schema — none of this data has IDs
  // yet, so every entry gets a freshly-minted one here, the same as any other backfill.
  const panel = { numSeq:0, numMap:{}, photos:{}, categories: {
    'Identity': { type:'kv', data: old.identity||{}, ids:{} },
    'Finances': { type:'kv', data:{}, ids:{} },
    'Inventory': { type:'list', data: old.items||[], ids:[] },
    'Skills & Abilities': { type:'list', data:[], ids:[] },
    'Milestones': { type:'list', data: old.milestones||[], ids:[] },
    'Relationships': { type:'kv', data: old.relationships||{}, ids:{} },
    'Status': { type:'text', data: old.status||'' },
  } };
  if(old.mastery && Object.keys(old.mastery).length) panel.categories['Learning'] = { type:'kv', data: old.mastery, ids:{} };
  ensureCategoryIds(panel);
  return panel;
}
function sanitizePanel(p){
  // numSeq/numMap carry the visible "#N" inventory numbering (see genInvId/numFromId) — kept
  // and passed through here just like everything else, so a load-time sanitize pass never
  // resets a player's already-assigned item numbers back to nothing.
  const out = { categories:{}, numSeq: typeof p.numSeq==='number' ? p.numSeq : 0, numMap: (p.numMap && typeof p.numMap==='object') ? p.numMap : {}, photos: (p.photos && typeof p.photos==='object') ? p.photos : {} };
  for(const [name, cat] of Object.entries(p.categories||{})){
    if(!cat || !['kv','list','text'].includes(cat.type)) continue;
    if(!isRecognizedCategory(name)) continue; // drop any category the AI invented outside the fixed set
    out.categories[name] = { type:cat.type, data: cat.type==='kv' ? (cat.data||{}) : cat.type==='list' ? (cat.data||[]) : (cat.data||'') };
    if(cat.type==='kv') out.categories[name].ids = (cat.ids && typeof cat.ids==='object') ? cat.ids : {};
    if(cat.type==='list') out.categories[name].ids = Array.isArray(cat.ids) ? cat.ids : [];
  }
  ensureCategoryIds(out);
  return out;
}
// Backfills a permanent, unique ID for any kv key or list entry that doesn't already have
// one — covers saves written before IDs existed, categories/entries added by code paths that
// don't yet thread IDs through, and any drift between `data` and `ids` (wrong length/missing
// key) so the two never get silently out of sync. Safe to call on every load: entries that
// already have an ID are left untouched. Inventory list entries get a NUMBERED id (genInvId)
// instead of a plain genId() — see genInvId/numFromId below for why.
function ensureCategoryIds(panel){
  if(!panel || !panel.categories) return false;
  let changed = false;
  for(const [catName, cat] of Object.entries(panel.categories)){
    if(!cat || cat.type==='text') continue;
    const isInv = cat.type==='list' && /^inventory/i.test(String(catName).trim());
    const mintId = () => isInv ? genInvId(panel) : genId();
    if(cat.type==='kv'){
      if(!cat.ids || typeof cat.ids!=='object') { cat.ids = {}; changed = true; }
      for(const k of Object.keys(cat.data||{})){
        if(!cat.ids[k]){ cat.ids[k] = mintId(); changed = true; }
      }
      for(const k of Object.keys(cat.ids)){
        if(!(k in (cat.data||{}))){ delete cat.ids[k]; changed = true; }
      }
    } else if(cat.type==='list'){
      if(!Array.isArray(cat.ids)) { cat.ids = []; changed = true; }
      const data = cat.data || [];
      while(cat.ids.length < data.length){ cat.ids.push(mintId()); changed = true; }
      if(cat.ids.length > data.length){ cat.ids.length = data.length; changed = true; }
      for(let i=0;i<data.length;i++){
        if(!cat.ids[i]){ cat.ids[i] = mintId(); changed = true; }
      }
    }
  }
  return changed;
}
// The visible "#N" inventory number and the item's hidden identity used to be two separate
// pieces of state (a plain genId() string, plus a lookup table mapping that string to a
// number) — two things that had to be kept in sync by hand, and could in principle drift apart
// (an id with no number yet, a number left behind for an id that no longer exists, etc.).
// Merged into one now: an Inventory item's ID itself encodes its number, in the form
// "n<number>_<random>" — e.g. "n1_x7k2p9q". There is exactly one source of truth. The number
// is never reassigned for as long as that id exists, no matter how the item's text changes
// (rename, status, quantity) — same permanence guarantee as before, just with no second
// structure that could fall out of step with it.
// panel.numSeq is the running "next number to hand out" counter, persisted at the panel's top
// level (see sanitizePanel/defaultPanel/migrateOldPanel). panel.numMap is legacy leftover from
// before this merge — still read (once) by migrateLegacyInventoryIds below, to keep every
// already-visible number stable across the upgrade, but nothing writes to it anymore.
function genInvId(panel){
  if(typeof panel.numSeq !== 'number' || isNaN(panel.numSeq)) panel.numSeq = 0;
  panel.numSeq += 1;
  return 'n' + panel.numSeq + '_' + Math.random().toString(36).slice(2, 9);
}
function numFromId(id){
  const m = /^n(\d+)_/.exec(String(id||''));
  return m ? parseInt(m[1], 10) : null;
}
// One-time upgrade path: any Inventory id that predates this merge (a plain genId() string,
// carrying no number of its own) gets replaced in place with a proper numbered id. If that old
// id already had a number recorded in the legacy panel.numMap, the new numbered id reuses that
// exact number — so nobody's already-visible "#N" changes just because of this upgrade. Only
// truly never-numbered legacy ids get a fresh number off the running counter.
function migrateLegacyInventoryIds(panel){
  if(!panel || !panel.categories) return false;
  let changed = false;
  for(const [catName, cat] of Object.entries(panel.categories)){
    if(!cat || cat.type !== 'list' || !/^inventory/i.test(catName.trim())) continue;
    if(!Array.isArray(cat.ids)) continue;
    for(let i=0;i<cat.ids.length;i++){
      const id = cat.ids[i];
      if(!id || numFromId(id) != null) continue; // already a proper numbered id — nothing to do
      const legacyNum = panel.numMap && panel.numMap[id];
      if(legacyNum){
        cat.ids[i] = 'n' + legacyNum + '_' + Math.random().toString(36).slice(2, 9);
        if(typeof panel.numSeq !== 'number' || panel.numSeq < legacyNum) panel.numSeq = legacyNum;
      } else {
        cat.ids[i] = genInvId(panel);
      }
      changed = true;
    }
  }
  return changed;
}
async function getPanel(id){
  const p = await kvGet('wc_panel_'+id);
  // Detected here (against the raw, pre-sanitize data) so the removal actually gets written
  // back to storage below — sanitizePanel drops any category outside the fixed set in memory
  // on every load regardless, but without this flag that removal was never persisted, so the
  // stray category just silently reappeared out of storage on the next load forever.
  const purged = hasUnrecognizedCategories(p);
  const panel = !p ? defaultPanel() : (p.categories ? sanitizePanel(p) : migrateOldPanel(p));
  const migrated = migrateSkillCategoryNames(panel);
  const strayMerged = mergeStrayInventoryCategories(panel);
  const ensured = ensurePermanentCategories(panel);
  const dedupedLearning = repairDuplicateLearningKeys(panel);
  const promoted = promoteMasteredSkills(panel);
  const repaired = repairDuplicateSkills(panel);
  const idsBackfilled = ensureCategoryIds(panel);
  const legacyIdsMigrated = migrateLegacyInventoryIds(panel);
  if(!p || purged || migrated || strayMerged || ensured || dedupedLearning || promoted || repaired || idsBackfilled || legacyIdsMigrated) await savePanel(id, panel);

  return panel;
}
async function savePanel(id, panel){
  await kvSet('wc_panel_'+id, panel);
  // Single choke point for every inventory/panel write in the app (story turns, background-
  // model updates, merges, imports, the "system bro" admin panel, ...) — rather than adding a
  // repaint call at each of those call sites individually (easy to miss one and end up with a
  // page that's silently out of sync again), hook the live-refresh here so ANY save, from
  // anywhere, immediately updates whichever of the two Inventory-facing views is currently
  // open for this exact world: an item appearing/disappearing on the Letter of Records shows
  // up on the Inventory merge page right away (and vice versa) with no need to close/reopen.
  if(state.chattingId === id){
    if(els.invModal.style.display === 'flex') await paintInventoryModal();
    if(els.panelModal.style.display === 'flex') await paintPanel();
  }
}
// Stores (or clears, when dataUrl is falsy) a snapshot photo for a single inventory item,
// keyed by that item's own permanent hidden ID — so the photo survives renames, quantity
// changes, and status changes the exact same way the rest of the item's identity does.
// Goes through the same savePanel choke point as every other panel write, so it repaints
// live if either Inventory-facing view happens to be open.
async function setInventoryItemPhoto(worldId, itemId, dataUrl){
  const panel = await getPanel(worldId);
  if(!panel.photos || typeof panel.photos !== 'object') panel.photos = {};
  if(dataUrl) panel.photos[itemId] = dataUrl;
  else delete panel.photos[itemId];
  await savePanel(worldId, panel);
}
// Rewrites a single inventory item's " — status" suffix (or clears it), found by its
// permanent hidden ID rather than position/text — used by the long-press action sheet's
// Equip/Unequip toggle. Rebuilds the entry in the exact same "<qty> <name> — <status>" shape
// the AI itself writes (splitItemEntry/rebuildItemEntry, defined further down but hoisted),
// so nothing downstream (guards, the merge-name logic, the Inventory info modal) sees
// anything different from a normal status change. Goes through the same savePanel choke
// point as every other panel write, so it repaints live if either Inventory-facing view is open.
async function setInventoryItemStatus(worldId, itemId, newStatus){
  const panel = await getPanel(worldId);
  const cat = panel.categories && panel.categories['Inventory'];
  if(!cat || cat.type !== 'list' || !Array.isArray(cat.ids)) return;
  const idx = cat.ids.indexOf(itemId);
  if(idx === -1) return;
  const parsed = splitItemEntry(cat.data[idx]);
  const qtyStr = parsed.qty != null ? parsed.qty.toLocaleString('en-US') + ' ' : '';
  cat.data[idx] = `${qtyStr}${parsed.name}${newStatus ? ' — ' + newStatus : ''}`.trim();
  await savePanel(worldId, panel);
}
// Permanent, direct delete for a single inventory item, found by its hidden ID — used by the
// long-press action sheet's Delete button (this replaces the old per-chip "✕" cross that used
// to live on the dedicated drag-to-merge Inventory-only page; that page no longer has its own
// delete affordance at all — see wireInventoryChipDrag in script.chatroom.js). Same per-world
// op queue as every other Letter of Records write (queueWorldOp, defined in
// script.chatroom.js but globally available since neither file is a module), so a delete
// tapped while a background sheet update from the last story turn is still resolving can't
// race it. Always confirmed first, since there's no story action behind this at all. Also
// clears the item's stored photo (if any) so an orphaned data URL doesn't linger in storage
// for an ID nothing references anymore. Returns true if the item was actually deleted.
async function deleteInventoryItemById(worldId, id, label){
  if(!confirm(`Delete "${label || 'this item'}"? This can't be undone.`)) return false;
  await queueWorldOp(worldId, async ()=>{
    const fresh = await getPanel(worldId);
    const freshInv = fresh.categories['Inventory'];
    if(!freshInv || !freshInv.data || !Array.isArray(freshInv.ids)) return;
    const at = id ? freshInv.ids.indexOf(id) : -1;
    if(at !== -1){ freshInv.data.splice(at, 1); freshInv.ids.splice(at, 1); }
    if(id && fresh.numMap && fresh.numMap[id] != null) delete fresh.numMap[id];
    if(id && fresh.photos && fresh.photos[id] != null) delete fresh.photos[id];
    await savePanel(worldId, fresh);
  });
  return true;
}

// ================= LEGACY SAVE MIGRATIONS =================
// One-time upgrades for panels saved under earlier schemas — old kv-style Skills &
// Abilities, duplicate keys, and promoting mastered skills out of Learning.

// ---------- fixed-category cleanup helpers (used by getPanel above) ----------
// hasUnrecognizedCategories checks the RAW, pre-sanitize saved data for any category outside
// the fixed set (see isRecognizedCategory, defined further below alongside CATEGORY_ORDER) —
// sanitizePanel already drops these in memory on every load regardless, but getPanel needs this
// flag to know to actually persist that removal, or the stray category would just silently come
// back out of storage on the next load forever.
function hasUnrecognizedCategories(p){
  if(!p || !p.categories) return false;
  return Object.keys(p.categories).some(name => !isRecognizedCategory(name));
}
// ---------- one-time migration: merge stray duplicate inventory categories, then delete them ----------
// The background model has occasionally invented a second, differently-worded inventory-ish
// category (e.g. "Inventory Description") sitting alongside the real "Inventory" — since it
// still matches /^inventory/i, it passes isRecognizedCategory and isn't caught by
// hasUnrecognizedCategories above. This used to just be hidden from the rendered sheet and from
// what's sent to the AI, while the duplicate data sat around untouched in storage forever.
// Instead, the first time an affected save is loaded, this folds that data into the real
// "Inventory" category (so nothing is lost) and deletes the stray category outright.
function mergeStrayInventoryCategories(panel){
  if(!panel || !panel.categories) return false;
  const canonicalKey = findExistingKey(panel.categories, 'Inventory');
  if(!canonicalKey) return false;
  let changed = false;
  for(const key of Object.keys(panel.categories)){
    if(key === canonicalKey || !/^inventory/i.test(key.trim())) continue;
    const strayCat = panel.categories[key];
    if(strayCat && strayCat.type === 'list'){
      const canonicalCat = panel.categories[canonicalKey];
      if(!Array.isArray(canonicalCat.ids)) canonicalCat.ids = [];
      (strayCat.data||[]).forEach((it,i)=>{
        if(!canonicalCat.data.includes(it)){
          canonicalCat.data.push(it);
          canonicalCat.ids.push((strayCat.ids && strayCat.ids[i]) || genId());
        }
      });
    }
    delete panel.categories[key];
    changed = true;
  }
  return changed;
}
// ---------- one-time structural migration for older saves ----------
// Earlier versions tracked "Skills & Abilities" as a percentage kv category, and let the AI
// freely invent a separate list category for owned techniques (e.g. "Jutsu & Techniques").
// The current design splits these into two fixed categories: "Learning" (kv, in-progress
// percentage tracking, only appears once training actually starts) and "Skills & Abilities"
// (list, the permanent definitive record of everything the character can actually use). This
// folds any old-style data into the new shape the first time an old save is loaded.
function migrateSkillCategoryNames(panel){
  if(!panel || !panel.categories) return false;
  let changed = false;
  const oldSkillsKey = findExistingKey(panel.categories, 'Skills & Abilities');
  if(oldSkillsKey && panel.categories[oldSkillsKey].type === 'kv'){
    const oldCat = panel.categories[oldSkillsKey];
    const oldData = oldCat.data || {};
    if(Object.keys(oldData).length){
      const learningKey = findExistingKey(panel.categories, 'Learning') || 'Learning';
      if(!panel.categories[learningKey]) panel.categories[learningKey] = { type:'kv', data:{}, ids:{} };
      const learningCat = panel.categories[learningKey];
      if(!learningCat.ids) learningCat.ids = {};
      for(const [k,v] of Object.entries(oldData)){
        const existingK = findExistingKey(learningCat.data, k);
        const targetK = existingK || k;
        learningCat.data[targetK] = v;
        // carries the entry's existing ID across the migration rather than minting a fresh
        // one, so its identity survives the schema change intact.
        learningCat.ids[targetK] = learningCat.ids[targetK] || (oldCat.ids && oldCat.ids[k]) || genId();
      }
    }
    delete panel.categories[oldSkillsKey];
    changed = true;
  }
  const jutsuKey = Object.keys(panel.categories).find(k => /^jutsu/i.test(k.trim()));
  if(jutsuKey){
    const jutsuCat = panel.categories[jutsuKey];
    const skillsKey = findExistingKey(panel.categories, 'Skills & Abilities') || 'Skills & Abilities';
    if(!panel.categories[skillsKey]) panel.categories[skillsKey] = { type:'list', data:[], ids:[] };
    const skillsCat = panel.categories[skillsKey];
    if(!Array.isArray(skillsCat.ids)) skillsCat.ids = [];
    if(jutsuCat.type === 'list'){
      (jutsuCat.data||[]).forEach((it,i)=>{
        if(!skillsCat.data.includes(it)){
          skillsCat.data.push(it);
          skillsCat.ids.push((jutsuCat.ids && jutsuCat.ids[i]) || genId());
        }
      });
    }else if(jutsuCat.type === 'kv'){
      Object.entries(jutsuCat.data||{}).forEach(([k,v])=>{
        const entry = `${k}: ${v}`;
        if(!skillsCat.data.includes(entry)){
          skillsCat.data.push(entry);
          skillsCat.ids.push((jutsuCat.ids && jutsuCat.ids[k]) || genId());
        }
      });
    }
    delete panel.categories[jutsuKey];
    changed = true;
  }
  return changed;
}
// Ensures the fixed permanent categories always exist (even empty), so Finances, Skills &
// Abilities, Timeline, and Scheduled Events show up on the sheet from the very start rather
// than waiting on the AI to decide they're needed. Each is seeded with its actual default
// data (e.g. Timeline starts at "Current Day: 1") rather than forced blank, so Timeline
// always has a real starting day instead of sitting empty until the first time-skip.
// "Learning" is deliberately NOT in this list — it should only appear once training on
// something actually begins.
function ensurePermanentCategories(panel){
  if(!panel.categories) panel.categories = {};
  let changed = false;
  const defaults = defaultPanel().categories;
  for(const [name, cat] of Object.entries(defaults)){
    if(!findExistingKey(panel.categories, name)){
      panel.categories[name] = { type:cat.type, data: cat.type==='kv' ? {...cat.data} : cat.type==='list' ? [...cat.data] : cat.data };
      if(cat.type==='kv') panel.categories[name].ids = {...cat.ids};
      if(cat.type==='list') panel.categories[name].ids = [...cat.ids];
      changed = true;
    }
  }
  return changed;
}
// A "Learning" entry that reaches 100% graduates automatically: it's removed from Learning
// and added to Skills & Abilities as a normal, permanently-usable entry.
function promoteMasteredSkills(panel){
  if(!panel || !panel.categories) return false;
  const learningKey = findExistingKey(panel.categories, 'Learning');
  if(!learningKey) return false;
  const learningCat = panel.categories[learningKey];
  if(!learningCat || learningCat.type !== 'kv') return false;
  if(!learningCat.ids) learningCat.ids = {};
  const masteredKeys = Object.keys(learningCat.data).filter(k => /^100\s*%$/.test(String(learningCat.data[k]).trim()));
  if(masteredKeys.length === 0) return false;
  const skillsKey = findExistingKey(panel.categories, 'Skills & Abilities') || 'Skills & Abilities';
  if(!panel.categories[skillsKey]) panel.categories[skillsKey] = { type:'list', data:[], ids:[] };
  const skillsCat = panel.categories[skillsKey];
  if(!Array.isArray(skillsCat.ids)) skillsCat.ids = [];
  masteredKeys.forEach(k=>{
    const carriedId = learningCat.ids[k];
    delete learningCat.data[k];
    delete learningCat.ids[k];
    const already = skillsCat.data.some(it => String(it).toLowerCase().replace(/\s*—.*$/,'').trim() === k.toLowerCase().trim());
    if(!already){
      skillsCat.data.push(k);
      // the graduated skill keeps the SAME hidden ID it had while it was a Learning entry —
      // graduating from a percentage bar to a plain owned ability is a state change, not a
      // new entry, so nothing downstream should treat it as having reset.
      skillsCat.ids.push(carriedId || genId());
    }
  });
  return true;
}
// One-time repair for saves affected by a past bug where a skill could get added to Skills &
// Abilities while still sitting below 100% in Learning (guardSkillGraduation now prevents this
// going forward — see its comment above). Removes any Skills & Abilities entry that still has
// a matching below-100% Learning entry, so a skill in progress no longer also shows up as
// already mastered. Uses the same loose-label matching as the guard itself.
function repairDuplicateSkills(panel){
  if(!panel || !panel.categories) return false;
  const learningKey = findExistingKey(panel.categories, 'Learning');
  const learningCat = learningKey ? panel.categories[learningKey] : null;
  if(!learningCat || learningCat.type !== 'kv') return false;
  const inProgress = Object.entries(learningCat.data)
    .filter(([,v]) => { const n = parseInt(String(v).trim(), 10); return !isNaN(n) && n < 100; })
    .map(([k]) => normalizeSkillLabel(k))
    .filter(Boolean);
  if(!inProgress.length) return false;
  let changed = false;
  const skillsKey = findExistingKey(panel.categories, 'Skills & Abilities');
  const skillsCat = skillsKey ? panel.categories[skillsKey] : null;
  if(!skillsCat || skillsCat.type !== 'list') return false;
  if(!Array.isArray(skillsCat.ids)) skillsCat.ids = [];
  const keptData = [], keptIds = [];
  skillsCat.data.forEach((it, i)=>{
    const norm = normalizeSkillLabel(it);
    const stillLearning = inProgress.some(k => norm===k || norm.includes(k) || k.includes(norm));
    if(stillLearning){ changed = true; return; }
    keptData.push(it);
    keptIds.push(skillsCat.ids[i]);
  });
  if(changed){ skillsCat.data = keptData; skillsCat.ids = keptIds; }
  return changed;
}

// One-time repair for saves affected by a past bug where the AI could name the same Learning
// entry slightly differently between turns ("Basic Chakra-Conduction Theory" vs
// "Basic-Conduction Theory") and end up with two separate bars for what's really one skill —
// mergePanelUpdate's kv merge now catches this going forward via fuzzy key matching (see
// findFuzzyExistingKey below), but this cleans up any duplicate pair already sitting on the
// sheet: keeps the higher of the two percentages (the more advanced one reflects real
// progress) under the more descriptive of the two names, and drops the other.
function repairDuplicateLearningKeys(panel){
  if(!panel || !panel.categories) return false;
  const learningKey = findExistingKey(panel.categories, 'Learning');
  const cat = learningKey ? panel.categories[learningKey] : null;
  if(!cat || cat.type !== 'kv') return false;
  if(!cat.ids) cat.ids = {};
  let changed = false;
  const keys = Object.keys(cat.data);
  for(let i=0; i<keys.length; i++){
    const k = keys[i];
    if(!(k in cat.data)) continue;
    for(let j=i+1; j<keys.length; j++){
      const k2 = keys[j];
      if(!(k2 in cat.data)) continue;
      if(!findFuzzyExistingKey({ [k]: cat.data[k] }, k2)) continue;
      const n1 = parseInt(String(cat.data[k]).trim(), 10);
      const n2 = parseInt(String(cat.data[k2]).trim(), 10);
      const keepKey = k.length >= k2.length ? k : k2;
      const dropKey = keepKey === k ? k2 : k;
      const bestVal = Math.max(isNaN(n1)?0:n1, isNaN(n2)?0:n2);
      cat.data[keepKey] = bestVal + '%';
      delete cat.data[dropKey];
      // the surviving key keeps its own existing ID untouched; the dropped duplicate's ID is
      // simply discarded along with it — one skill, one ID, no matter which of the two
      // differently-worded keys the AI happened to use most recently.
      delete cat.ids[dropKey];
      changed = true;
    }
  }
  return changed;
}



const PANEL_SYS_PROMPT = `You maintain a persistent character-sheet tracker for an interactive fiction story, organized into named categories. Each category is one of: "kv" (named stat/value pairs), "list" (a growing collection), or "text" (a single free-text value). Given the recent story log and the current sheet, output ONLY a raw JSON object — no preamble, no markdown fences — describing what's genuinely new or changed since the current sheet, in this exact shape:
{"categories":{"Category Name":{"kv":{"key":"value"}},"Another Category":{"list_add":["thing"],"list_remove":["thing"]},"Status":{"text":"..."}}}

Before creating a new key within a category, always check whether an existing one already represents the same thing, and reuse its exact existing name instead of inventing a fresh synonym (e.g. if the sheet already tracks a currency as "Gold", don't later create "Money" or "Coins" for the same thing — update "Gold"). This matters most for the same countable resource being referenced repeatedly (a story's money, health, a relationship meter, etc.) — the same real-world thing must always live under one consistent name for the whole story, never split across near-duplicate keys.

You are strictly limited to the sheet's fixed set of categories — never invent a new category name, no matter what the player learns, gains, or becomes. The sheet always has these permanent categories available — Identity, Finances, Inventory, Skills & Abilities, Milestones, Relationships, Status — plus "Learning", "Timeline", and "Scheduled Events", which the app itself manages. Whatever the player learns, gains, or becomes must be filed into one of these existing categories, using the closest fit:
- A special skill, technique, spell, or innate power the character has FULLY learned or acquired and can genuinely use right now → goes straight into "Skills & Abilities" (a permanent list category, always on the sheet) — this is the definitive, ready-to-use record; nothing the character can actually do should be missing from it.
- A skill or technique the character is still IN THE PROCESS of learning, not yet usable at full strength → track its progress in "Learning" (a kv category, created the moment real training begins) as a percentage — see SKILL & ABILITY PROGRESS below. Once it reaches 100%, it moves itself into "Skills & Abilities" automatically — never add it there yourself while it's still in Learning.
- A language, credential, or learned proficiency → a key within "Identity" or "Skills & Abilities", e.g. {"Japanese":"Fluent"}
- A title, rank, job, or affiliation → a key within "Identity"
- Anything else that doesn't fit one of these → the closest existing category by meaning; never create a new one.
Do not wait for a "big enough" moment — if the log explicitly states the character used, learned, or gained one of these, record it that same update, filed into the existing category it best fits.

Strict rules:
- Follow the letter of the log exactly. Only record an item, stat, or event that is explicitly stated in the log. Never infer, assume, guess, round, or add anything not written there.
- COMPLETED TRANSACTIONS ONLY: never change a currency, inventory count, or any other stat just because a price, cost, or quantity was mentioned, quoted, offered, or negotiated in dialogue. A line like "5 thousand each, I'll take 3" or "that'll cost you 500 ryo" is only a proposal until the log explicitly shows the exchange actually happening (payment handed over, goods received, a narration line stating the deal was completed). If it's still being discussed/haggled over, output nothing for that stat yet — wait for the turn where the transaction actually resolves.
- CURRENCY lives in "Finances" (a permanent kv category, always on the sheet) — e.g. {"Ryo":"120,200"}. Reuse it for every currency the story tracks; never spin up a separate category for money.
- EXCHANGES/TRADES/CONVERSIONS: an exchange ("I exchange 100 for gold", "I trade my dagger for 50 ryo", "I swap 200 credits for a room key") is a completed transaction exactly like a purchase once the log shows it actually happening — apply the same rule above. Every exchange has two sides, and BOTH must be output together in the same response: whatever is given up decreases (or leaves Inventory entirely if a whole item was traded away) and whatever is received increases or is added — never record one side without the other. This holds no matter which two things are being exchanged: currency-for-currency, currency-for-item, item-for-currency, or item-for-item.
- "Milestones" is for major, pivotal, story-defining events ONLY — never routine or minor happenings. The separate memory log already records everything in detail; Milestones must stay short and selective.
- Before adding anything to Milestones (or any list), re-read every existing entry in that category on the current sheet first. If a new entry would describe the same underlying event as one already there — even if worded, phrased, or emphasized differently — do NOT add it again. A single event gets exactly one entry, ever. If the newer log line gives a more complete/corrected version of an event already on the sheet, use list_remove with the OLD entry's exact existing text plus list_add with the corrected single replacement — never leave both the old and new phrasing sitting side by side.
- For any countable/stackable item whose amount changes (used, spent, gained, lost, consumed, etc.), you MUST update it to the exact new remaining total — this is a strict arithmetic requirement, not optional. Work it out step by step: (1) find the item's current exact value on the sheet given below, (2) find the exact change stated in the log, (3) compute old value minus/plus change = new value, (4) output that new value. Never leave a stale amount unchanged when the log describes it changing, and never invent a total the log doesn't support. A count can never go below 0 — if the math would take it negative, that means the log is describing the character trying to use more than they have, which the story itself must show failing/coming up short; output 0, never a negative number.
  - If the item lives in a "kv" category, just overwrite the key with the new value: {"kv":{"Gold":"900"}}.
  - If the item lives in a "list" category (e.g. an inventory entry like "1,000 gold pouch"), copy the OLD entry's text from the current sheet EXACTLY as written for list_remove, and add the corrected entry for list_add. Example: sheet shows "1,000 gold pouch" in Inventory, log says 100 gold was spent → list_remove:["1,000 gold pouch"], list_add:["900 gold pouch"].
  - When starting to track a brand-new countable resource, prefer "kv" over a list entry — a plain key/value pair is far less error-prone to update correctly over time than matching list text.
- ABILITY-DRIVEN QUANTITY CHANGES (duplication, creation, multiplication, transmutation, or any other listed skill/ability whose whole point is to change how much of something the player has): this is a normal quantity update and follows the EXACT SAME strict-arithmetic rule above — it is never limited to currency. If the log shows the player using such an ability on an Inventory item (or any other kv/list stat), update that item's total exactly the same way a currency change is tracked. Example: sheet shows "1 Knife" in Inventory, log shows the player duplicating it into 10 → list_remove:["1 Knife"], list_add:["10 Knife"] — keep the item's name text identical to how it already appears on the sheet (don't switch "Knife" to "Knives" or otherwise reword it), only the leading quantity number changes, so the item is recognized as the same object rather than a new one.
- SKILL & ABILITY PROGRESS (real, cumulative training — not a one-time label): "Learning" is a kv category, created the moment the character genuinely begins studying or practicing something they don't already have in "Skills & Abilities". Each entry is a plain percentage string, e.g. "Business Study":"14%", representing progress toward full mastery, from 0 to 100.
  - First time the log shows the character genuinely beginning to learn or practice something new (reading a book on the subject, a first training session, a master's first lesson, etc.), create the entry in "Learning" at "10%" — never create the entry at all if the log only mentions wanting or planning to learn it.
  - Every time the log shows the character actually practicing, studying, training, drilling, or otherwise doing focused work on an entry already in "Learning", increase it by a flat 10 percentage points (a fixed step, not a judgment call): (1) read that skill's exact current percentage on the sheet, (2) add exactly 10, (3) cap the sum at 100, (4) output that exact new total formatted as "NN%". Never invent an increase for a skill the log didn't show being practiced this turn, and never use any amount other than exactly 10.
  - Percentages only ever go up, never down.
  - Once an entry reaches exactly "100%", it's fully mastered — the app itself moves it out of "Learning" and into "Skills & Abilities" as a normal, permanently-usable entry. You never need to add it to "Skills & Abilities" yourself or keep re-outputting it in "Learning" afterward.
  - A skill can be actively used by the character at any percentage while it's still in "Learning" — write the story so its power, reliability, and control genuinely reflect that percentage (low: weak, clumsy, unreliable, or costly to pull off; mid: workable but imperfect; near 100%: nearly full power). This is guidance for how you narrate the skill being used, not something you output on the sheet.
  - A power, jutsu, or technique the character gains INNATELY or fully-formed all at once — no training montage, e.g. a bloodline ability, a magic item's granted power, something taught and mastered in a single explicit scene — skips "Learning" entirely and goes straight into "Skills & Abilities".
- If a memory log is provided below the current sheet, it's given only so you can catch things the recent-log window might have missed or spot a sheet value that's gone stale (e.g. the memory mentions a currency change the sheet never applied). Use it only to correct or fill in a fact that's genuinely supported by the story so far — never invent or add something sourced only from the memory summary that isn't itself grounded in an explicit event.
- TIME & DATED EVENTS: track elapsed time with a "Timeline" category: a kv entry {"Current Day":"N"} that only ever counts UP. Scheduled Events (the list of upcoming dated entries, formatted "Day N — event name") is a READ-ONLY list as far as you're concerned — you never add a new entry to it yourself, no matter how clearly the world's setup text or the log names a date for something, and you never remove one either, even after it's happened; the player manages that list entirely through their own tool, and an entry is meant to stay on the sheet permanently (the app itself dims it once its day has passed). Your only job with an existing Scheduled Events entry is to notice when Current Day reaches it and narrate it actually happening (see SCHEDULED EVENTS — AUTO-TRIGGER below) — never to list_add or list_remove anything in that category.
  - A time-skip counts no matter which side of the conversation states it — the player saying it ("I rest for the night", "let's skip ahead two days", "after two days, I go back") counts exactly the same as the narrator/story text saying it. Don't only watch the narrator's lines.
  - Read the actual phrase for its real length and convert it precisely: "a night" / "overnight" / "the next morning" / "til morning" = +1 day. "the next day" = +1 day. "two days" / "two days later" / "a couple days" = +2 days. "a few days" = +3 days (unless a more specific number is given, in which case use that number instead). "a week" = +7 days. Always prefer an explicit number stated in the log over any default above.
  - Every time the log shows time passing this way, work out exactly how many days passed and increase "Current Day" by that exact amount — the same strict arithmetic requirement as currency, not a vibe. Never leave "Current Day" unchanged when the log shows time passing, and never invent days passing that the log doesn't support.
  - Once "Current Day" reaches or passes a Scheduled Events entry's day number, that event is due, and this reply must show it actually happening (see SCHEDULED EVENTS — AUTO-TRIGGER); the entry itself is never removed from Scheduled Events, before or after it happens — it's a permanent record, so just narrate it and move on.
  - "Current Day" must never jump straight past a still-upcoming Scheduled Events day in a single update — e.g. if the day is 8 and an entry reads "Day 12 — Chunin Exam", a time-skip cannot advance "Current Day" beyond 12 in one go even if the log's stated skip length would otherwise reach further (e.g. "we traveled for ten days" from day 8 does not mean day 18 — it means the day advances only as far as 12, since the story has to actually arrive at and show that event before time can keep moving past it). If the described time-skip would otherwise land beyond a still-upcoming dated event, stop the narration at that event's day instead and let the story address the event before any later days pass.
- INVENTORY ITEM STATUS: an inventory item may optionally carry its current state as a suffix, using an em dash specifically — " — " — never a plain hyphen (item names can legitimately contain hyphens, e.g. "bone-wood half-mask", so a bare "-" can't be trusted as a separator). Format: "<item>" or "<item> — <status>", e.g. "Pale bone-wood half-mask — Equipped", "0 explosive tags — All used", "Steel kunai — Sheathed", "Blade — Poisoned" (the log showed the blade being dipped in poison). Only attach a status when the log actually shows that state (put on, worn, drawn, holstered, broken, emptied, hidden, sealed, poisoned, sharpened, etc.) — most items don't need one and should stay as plain entries; don't invent a status just to have one. When an item's state changes, ALWAYS use the same list_remove(old exact text)+list_add(corrected text) pattern as any other sheet correction, keeping the item's name itself exactly as it already appears on the sheet — never invent a differently-worded new name for the same physical item (e.g. never add "Poisoned Blade" as if it were a separate object from the existing "Blade"; correct "Blade" itself to "Blade — Poisoned"). A quantity dropping to 0 is not automatically "used up" — only add that wording if the log itself shows the last one being used.
  - "Remove" and "take off" mean UNEQUIPPING, never discarding — the item stays in Inventory (just no longer worn/held), so this is a status change: list_remove the old entry + list_add the same item with an appropriate status (e.g. "Boots — Removed" or drop the status back to none if that fits better).
  - An item leaves Inventory ENTIRELY — list_remove with NO matching list_add — only when the log shows it actually being gotten rid of: thrown away/out, left behind, dropped, tossed, discarded, given away, sold, traded away, abandoned, lost, or destroyed. That's a different action from unequipping and must never be confused with it.
- CROSS-CATEGORY CONSISTENCY: categories are not independent — if one update implies a change to another, both MUST be included in the SAME response. Concretely: if you add a Milestones entry describing an item being purchased/received/looted/gifted, that exact item must also get a list_add in Inventory (or wherever such items are tracked) in this same JSON output — never one without the other. The same applies to a skill/technique being learned (Milestones + Skills & Abilities), a title being granted (Milestones + Identity/Titles), a currency amount being earned, paid, or received (Milestones + Finances — and if it's a purchase, the Inventory list_add for the item bought too), a time-skip or day passing (Milestones + Timeline's "Current Day", per TIME & DATED EVENTS above), and a dated Scheduled Events entry actually occurring in the log (add a Milestones entry for it — never a list_remove in Scheduled Events itself, per TIME & DATED EVENTS above). Before finalizing your output, re-read every new Milestones entry you're about to add and check: does the thing it describes (an item, skill, title, relationship change, currency change, day advancing, or scheduled event occurring) already have — or now get — a matching entry in its own category in this same response (Scheduled Events itself excepted, since that category is never written to by you)? If not, add it now. A milestone recording an acquisition, payment, or time-skip with no matching entry anywhere else on the sheet is an incomplete, invalid update.

If truly nothing new or changed happened in the recent log, output exactly {"categories":{}} and nothing else.`;

// ================= FINANCES — CURRENCY GUARDS =================
// Currency can only move if the player's own message (decreases) or the recent log
// (increases) actually grounds the change — spend-confirmation detection, per-key
// matching, and the up/down guards themselves. (The Identity guard sits in the middle
// of this block since it reuses the same grounding helper — see the note below.)

// ---------- hard code-level guard: currency can only go DOWN if the player's own last
// message actually confirms a spend. This is deliberately NOT another prompt instruction —
// prompt-only rules are exactly what kept letting money drain on turns the player didn't
// initiate (see the 'forward'-continue instruction above). This runs in plain code after
// the AI response comes back, so it can't be talked around or forgotten by a lite model.
// Word list lives here as a plain string (not pre-wrapped in \b...\b) so it can be reused
// both as the standalone CURRENCY_NAME_RE fallback AND inside SPEND_TRIGGER_RE below, where
// several verbs (hand over/give/exchange/trade/swap/convert) are only real spend confirmations
// when their object is actually money — see note further down.
const CURRENCY_WORDS_SRC = 'gold|money|cash|coin|coins|currency|credit|credits|gil|ryo|dollars?|yen|silver|funds|wallet|purse|gem|gems|token|tokens|points?|chips?|bits?|rupees?|zenny|zeni|bells?|shekels?|drachma|denarii|florins?|coppers?|bronze|platinum|diamonds?|crystals?|shards?|marks?|crowns?';
const CURRENCY_NAME_RE = new RegExp('\\b(?:' + CURRENCY_WORDS_SRC + ')\\b', 'i');
// A story can invent ANY currency name ("Belruit", "Trade Bars", whatever fits its setting) —
// no fixed word list above can ever be exhaustive. So the real, general-purpose signal is
// the CATEGORY the stat lives in: anything tracked under a Finance/Currency/Treasury-style
// category is currency, regardless of what the individual stat is called. CURRENCY_NAME_RE
// above stays only as a fallback for a currency-looking key that ended up outside that
// category (e.g. folded into Identity or Inventory as a kv).
const FINANCE_CATEGORY_RE = /^(financ|currency|currencies|econom|treasury|coffers?|bank|wallet)/i;
// Deliberately does NOT include "I have (enough) money" or "I owe" — those describe
// checking a balance or taking on a future debt, not an actual completed transaction, and
// matching them was letting the background model justify decreases the player never
// actually confirmed (a merely-mentioned balance was enough to "unlock" a spend).
//
// IMPORTANT — this whole regex is a single global switch: one match anywhere in the player's
// message sets playerConfirmedSpend=true and waves through EVERY currency decrease that turn
// with no further checking (see guardCurrencyDecreases below). That makes false positives far
// more dangerous here than in a normal regex, because they don't just mislabel one value —
// they fully disarm the guard for the whole turn. Verified against real narrative lines:
// "pay"/"spend" alone and the bare verbs hand over/give/exchange/trade/swap/convert matched
// constantly on lines that have nothing to do with money — "I pay attention", "I spend the
// night at the inn", "I give him a hug", "I hand over my kunai", "I trade blows with the
// enemy", "I exchange a glance", "I swap seats", "I convert my chakra into a jutsu" — every
// one of those used to flip the switch and open the door for an unrelated money drain that
// turn. Fixed two ways: (1) "pay"/"spend" get negative lookaheads for their common non-money
// idioms, (2) the six ambiguous verbs now require their own object to actually be a currency
// word — plain "I trade blows" no longer counts, but "I trade my gold for the sword" still does.
// "spend"/"pay" also need a multi-word-quantifier-aware time exclusion ("a few days",
// "several hours" — not just a single word) or phrases like "I spend a few days recovering"
// slip through as a false spend confirmation.
const TIME_WORD_RE_SRC = '(?:a\\s*few|a\\s*couple(?:\\s*of)?|several|many|\\d+|one|two|three|four|five|six|seven|eight|nine|ten|a|an|the)?\\s*(?:night|day|days|evening|evenings|hour|hours|week|weeks|month|months|moment|moments|while)';
// Same "i" -> verb adjacency gap as PRACTICE_TRIGGER_RE below: originally every alternative
// here required the verb to sit immediately (whitespace-only) after "i", so ordinary phrasing
// like "I haggle and buy X", "I decide to purchase Y", "I end up paying Z" never matched at
// all — the trigger silently failed to confirm real spends, which then got blocked as
// "unconfirmed" by guardCurrencyDecreases even though the player very clearly spent money.
// GAP_SRC allows up to 3 intervening words between "i" and the verb, with a negative lookahead
// per word so a negation in that gap (not/never/refuse/decide not to/etc.) still correctly
// fails to confirm a spend, same reasoning as the Learning trigger fix.
const SPEND_GAP_SRC = "(?:\\s+(?!(?:not|never|n't|refuse\\w*|avoid\\w*|stop\\w*|quit\\w*|skip\\w*|can'?t|won'?t|wouldn'?t|don'?t|didn'?t)\\b)\\w+){0,3}\\s*";
const SPEND_TRIGGER_RE = new RegExp(
  '\\b(' +
    "i\\b(?:'|\u2019)?(?:ve|d|ll)?" + SPEND_GAP_SRC + "pa(?:y|id|ying)(?!\\s*(?:my\\s*)?(?:respects?|attention|homage|tribute|no\\s*mind))" + '|' +
    "i\\b" + SPEND_GAP_SRC + "spen(?:d|t|ding)(?!\\s*" + TIME_WORD_RE_SRC + ")" + '|' +
    'i\\b' + SPEND_GAP_SRC + 'bu(?:y|ying|ought)' + '|' +
    'i\\b' + SPEND_GAP_SRC + 'purchas(?:e|ed|ing)' + '|' +
    'i\\b' + SPEND_GAP_SRC + 'hand(?:ed)?\\s*(?:it\\s*|them\\s*)?over\\s*(?:to\\s*\\S+\\s*)?(?:[\\d,]+\\s*)?(?:the\\s*)?(?:' + CURRENCY_WORDS_SRC + ')' + '|' +
    'i\\b' + SPEND_GAP_SRC + 'give\\s*(?:him|her|them|it)\\s*(?:[\\d,]+\\s*)?(?:the\\s*)?(?:' + CURRENCY_WORDS_SRC + ')' + '|' +
    'i\\b' + SPEND_GAP_SRC + 'use\\s*(?:my|the)\\s*(?:money|gold|coins?|cash|credits?)' + '|' +
    'hand\\s*(?:him|her|them|over)\\s*(?:the\\s*)?(?:money|gold|coins?|cash)' + '|' +
    'i\\b' + SPEND_GAP_SRC + 'pay\\s*for' + '|' +
    'i\\b' + SPEND_GAP_SRC + 'exchang(?:e|ed|ing)\\s*(?:my|the)?\\s*(?:[\\d,]+\\s*)?(?:' + CURRENCY_WORDS_SRC + ')' + '|' +
    'i\\b' + SPEND_GAP_SRC + 'trad(?:e|ed|ing)\\s*(?:my|the)?\\s*(?:[\\d,]+\\s*)?(?:' + CURRENCY_WORDS_SRC + ')' + '|' +
    'i\\b' + SPEND_GAP_SRC + 'swap(?:s|ped|ping)?\\s*(?:my|the)?\\s*(?:[\\d,]+\\s*)?(?:' + CURRENCY_WORDS_SRC + ')' + '|' +
    'i\\b' + SPEND_GAP_SRC + 'convert(?:s|ed|ing)?\\s*(?:my|the)?\\s*(?:[\\d,]+\\s*)?(?:' + CURRENCY_WORDS_SRC + ')' +
  ')\\b', 'i'
);
// ---- Identity guard (lives here because it shares normalizeForGrounding() with the
// currency spend-confirmation logic above, not because it's currency itself) ----
// ---------- hard code-level guard: an established Identity fact (name, village, rank, etc.)
// can't be silently overwritten with a different value unless the new value is actually
// grounded in the recent log — i.e. it genuinely appears in the text, not just asserted by
// the background model on its own judgment. Same "code, not just prompt wording" reasoning as
// the guards above, applied to the one category that had no protection at all. A brand-new
// key, or filling in a field that was previously blank, is always allowed straight through.
const IDENTITY_CAT_RE = /^identity/i;
function normalizeForGrounding(s){
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function guardIdentityChanges(data, panel, recentLogText){
  if(!data || !data.categories) return data;
  const haystack = normalizeForGrounding(recentLogText);
  for(const [catName, catUpdate] of Object.entries(data.categories)){
    if(!catUpdate || !catUpdate.kv || typeof catUpdate.kv !== 'object') continue;
    if(!IDENTITY_CAT_RE.test(catName)) continue;
    const existingCat = panel && panel.categories ? panel.categories[findExistingKey(panel.categories, catName) || catName] : null;
    for(const [k, v] of Object.entries(catUpdate.kv)){
      const existingRaw = existingCat && existingCat.type==='kv' ? existingCat.data[findExistingKey(existingCat.data, k) || k] : null;
      if(existingRaw == null || !String(existingRaw).trim()) continue; // was blank/new — always allowed
      if(normalizeForGrounding(existingRaw) === normalizeForGrounding(v)) continue; // no actual change
      const needle = normalizeForGrounding(v);
      if(needle && !haystack.includes(needle)){
        console.warn(`[identity guard] blocked ${catName}.${k} change ("${existingRaw}" -> "${v}") — new value doesn't appear anywhere in the recent log`);
        delete catUpdate.kv[k];
      }
    }
    if(Object.keys(catUpdate.kv).length === 0) delete catUpdate.kv;
  }
  return data;
}

// Builds a matcher for a specific currency key name that tolerates a missing/extra trailing
// "s" ("Dollars" on the sheet vs. player typing "100 dollar") and matches on a real word
// boundary rather than a raw substring (so "Gil" doesn't accidentally match inside an
// unrelated longer word). Cached per key since guardCurrencyDecreases can run this for the
// same key across multiple categories/turns.
const _keyMatchReCache = new Map();
function keyMatchRegex(key){
  const cacheKey = String(key || '');
  if(_keyMatchReCache.has(cacheKey)) return _keyMatchReCache.get(cacheKey);
  const esc = cacheKey.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flexible = esc.replace(/s$/i, '') + 's?'; // "Dollars"->"Dollars?" (matches dollar/dollars), "Gold"->"Golds?"
  const re = new RegExp('\\b' + flexible + '\\b', 'i');
  _keyMatchReCache.set(cacheKey, re);
  return re;
}

function guardCurrencyDecreases(data, panel, playerText, recentLogText){
  if(!data || !data.categories) return data;
  const text = playerText || '';
  const playerSaidSomethingSpendShaped = SPEND_TRIGGER_RE.test(text);
  const groundingHaystack = String(recentLogText || '') + ' ' + text;

  // Collect every distinct currency stat name already tracked anywhere on the sheet, so we
  // know whether this is a single- or multi-currency world. This matters because the old
  // version treated "did the player confirm A spend" as one global yes/no switch for the
  // whole turn — so in a world tracking two currencies (e.g. "Gold" and "Guild Treasury"),
  // confirming a Gold purchase would also silently wave through an unrelated, unconfirmed
  // drop in Guild Treasury the very same turn. Fix: in a multi-currency world, a generic
  // spend phrase only clears the specific currency it actually names.
  const allCurrencyKeys = new Set();
  if(panel && panel.categories){
    for(const [catName, cat] of Object.entries(panel.categories)){
      if(!cat || cat.type !== 'kv') continue;
      const catIsCurrency = FINANCE_CATEGORY_RE.test(catName);
      for(const k of Object.keys(cat.data || {})){
        if(catIsCurrency || CURRENCY_NAME_RE.test(k)) allCurrencyKeys.add(k.toLowerCase());
      }
    }
  }
  const singleCurrencyWorld = allCurrencyKeys.size <= 1;

  for(const [catName, catUpdate] of Object.entries(data.categories)){
    if(!catUpdate || !catUpdate.kv || typeof catUpdate.kv !== 'object') continue;
    const catIsCurrency = FINANCE_CATEGORY_RE.test(catName) || CURRENCY_NAME_RE.test(catName);
    for(const [k, v] of Object.entries(catUpdate.kv)){
      if(!catIsCurrency && !CURRENCY_NAME_RE.test(k)) continue; // only gate currency-looking stats
      const newNum = parseFloat(String(v).replace(/,/g,''));
      if(isNaN(newNum)) continue;
      const existingCat = panel && panel.categories ? panel.categories[findExistingKey(panel.categories, catName) || catName] : null;
      const existingRaw = existingCat && existingCat.type==='kv' ? existingCat.data[findExistingKey(existingCat.data, k) || k] : null;
      const oldNum = existingRaw != null ? parseFloat(String(existingRaw).replace(/,/g,'')) : null;
      if(oldNum == null || isNaN(oldNum) || newNum >= oldNum) continue; // not a decrease — nothing to gate

      // Single-currency world: a generic spend phrase ("I buy...", "I pay for...") is
      // unambiguous, since there's only one currency it could possibly refer to — same
      // behavior as before. Multi-currency world: a generic phrase doesn't say WHICH
      // currency was spent, so also require this specific currency's own name to actually
      // appear in the player's text before letting its number drop — matched singular/plural-
      // tolerantly and on a real word boundary, not a raw substring (so "Dollars" on the
      // sheet still matches a player typing "100 dollar", and "Gil" doesn't false-match
      // inside an unrelated word).
      let confirmed = playerSaidSomethingSpendShaped;
      if(confirmed && !singleCurrencyWorld){
        confirmed = keyMatchRegex(k).test(text);
      }
      if(!confirmed){
        const reason = singleCurrencyWorld ? 'no spend phrase' : 'no spend phrase naming this specific currency';
        console.warn(`[money guard] blocked ${catName}.${k} decrease (${oldNum} -> ${newNum}) — ${reason} ("I paid/I spent/I bought/...") in player's last message`);
        delete catUpdate.kv[k];
        continue;
      }
      // A confirmed spend phrase only proves A transaction happened, not that THIS proposed
      // new total is arithmetically right — the background model's own subtraction can still
      // drift. But real narration almost never restates the running balance after every
      // purchase (it states the PRICE — "for 10,000 ryo", "Paid 3,500 ryo") — so requiring the
      // new TOTAL to appear verbatim (an earlier version of this guard) wrongly blocked nearly
      // every ordinary purchase. Instead: accept the drop if EITHER (a) the new total is
      // itself stated somewhere in the log (covers narration that does restate a running
      // balance, e.g. "accumulate 509,600 ryo"), OR (b) the exact delta (old − new) matches a
      // number stated near this currency's name in the log, OR (c) the delta matches the sum
      // of several such nearby numbers (covers a turn buying more than one priced item at
      // once, e.g. "smoke bombs and steel wire for 4,000 ryo" combined). Only block when none
      // of these hold — i.e. no numeric evidence anywhere ties this specific drop to anything
      // actually narrated.
      const delta = oldNum - newNum;
      const nearbyNumbers = extractNumbersNearKey(k, groundingHaystack);
      const grounded = nearbyNumbers.includes(Math.round(newNum))
        || nearbyNumbers.includes(Math.round(delta))
        || subsetSumMatches(delta, nearbyNumbers);
      if(!grounded){
        console.warn(`[money guard] blocked ${catName}.${k} decrease (${oldNum} -> ${newNum}, drop of ${delta}) — no number near "${k}" in the recent log adds up to that drop or matches the new total; likely bad arithmetic from the background model`);
        delete catUpdate.kv[k];
      }
    }
    if(Object.keys(catUpdate.kv).length === 0) delete catUpdate.kv;
  }
  return data;
}

// ---------- hard code-level guard: currency can only go UP if the gain is grounded in an
// actual number stated near that currency's name in the recent log (the player's message OR
// the story's own narration — a reward, a find, a payment received, wages, a refund). Every
// guard above defends the player against an unconfirmed LOSS; until now nothing defended the
// letter of records against an unconfirmed GAIN, which is the more exploitable direction —
// nothing in code stopped the background model from writing an arbitrarily large currency
// total onto the sheet with zero basis in what was actually narrated (a hallucinated reward, a
// jailbreak-style message asking for "free gold", or simple bad arithmetic that happens to
// round upward instead of down). Same grounding logic as guardCurrencyDecreases, mirrored:
// accept the gain if EITHER (a) the new total itself is stated somewhere in the log, OR (b) the
// exact delta (new − old) matches a number stated near this currency's name, OR (c) the delta
// matches the sum of several such nearby numbers (covers multiple rewards landing the same
// turn). A brand-new currency key (never tracked before) is treated as old value 0, so its
// very first amount must also be grounded — the same protection a returning currency gets.
function guardCurrencyIncreases(data, panel, recentLogText){
  if(!data || !data.categories) return data;
  const haystack = String(recentLogText || '');
  for(const [catName, catUpdate] of Object.entries(data.categories)){
    if(!catUpdate || !catUpdate.kv || typeof catUpdate.kv !== 'object') continue;
    const catIsCurrency = FINANCE_CATEGORY_RE.test(catName) || CURRENCY_NAME_RE.test(catName);
    for(const [k, v] of Object.entries(catUpdate.kv)){
      if(!catIsCurrency && !CURRENCY_NAME_RE.test(k)) continue; // only gate currency-looking stats
      const newNum = parseFloat(String(v).replace(/,/g,''));
      if(isNaN(newNum)) continue;
      const existingCat = panel && panel.categories ? panel.categories[findExistingKey(panel.categories, catName) || catName] : null;
      const existingRaw = existingCat && existingCat.type==='kv' ? existingCat.data[findExistingKey(existingCat.data, k) || k] : null;
      const oldNum = existingRaw != null ? parseFloat(String(existingRaw).replace(/,/g,'')) : 0;
      if(isNaN(oldNum) || newNum <= oldNum) continue; // not an increase — nothing to gate

      const delta = newNum - oldNum;
      const nearbyNumbers = extractNumbersNearKey(k, haystack);
      const grounded = nearbyNumbers.includes(Math.round(newNum))
        || nearbyNumbers.includes(Math.round(delta))
        || subsetSumMatches(delta, nearbyNumbers);
      if(!grounded){
        console.warn(`[money guard] blocked ${catName}.${k} increase (${oldNum} -> ${newNum}, gain of ${delta}) — no number near "${k}" in the recent log adds up to that gain or matches the new total; likely an ungrounded/invented grant`);
        delete catUpdate.kv[k];
      }
    }
    if(Object.keys(catUpdate.kv).length === 0) delete catUpdate.kv;
  }
  return data;
}
// Finds every number that appears near an occurrence of `key` (singular/plural tolerant,
// same matcher as keyMatchRegex) anywhere in `haystack`, within a small character window —
// e.g. "for 10,000 ryo" or "Paid 3,500 ryo administrative fee". Commas are stripped before
// parsing so "10,000" reads as 10000. Deduplicated, capped at 8 distinct numbers (plenty for
// even a busy multi-purchase turn) to keep the subset-sum check below cheap.
function extractNumbersNearKey(key, haystack){
  const src = keyMatchRegex(key).source; // already \b...s?\b, case-insensitive
  const globalRe = new RegExp(src, 'gi');
  const found = new Set();
  let m;
  while((m = globalRe.exec(haystack))){
    const start = Math.max(0, m.index - 25);
    const end = Math.min(haystack.length, m.index + m[0].length + 25);
    const window = haystack.slice(start, end).replace(/,/g, '');
    const nums = window.match(/\d+(?:\.\d+)?/g) || [];
    for(const n of nums){ found.add(Math.round(parseFloat(n))); if(found.size >= 8) break; }
    if(found.size >= 8) break;
  }
  return [...found];
}
// Generic-word anchors that shouldn't be trusted to identify a SPECIFIC item on their own —
// used by both the duplication-math anchor match and the item-label grounding fallback below,
// replacing a raw "word.length < 4" cutoff (which wrongly excluded short real item names like
// "Bow"/"Axe") with an actual stopword check.
const STOPWORD_ANCHORS = new Set(['the','and','with','from','pack','pouch','vial','bundle','stack','pair','set','item','items','thing','things']);
// BUG FIX (ungrounded multi-word item names): extractNumbersNearKey requires the ENTIRE label
// to appear verbatim near a number (keyMatchRegex escapes and matches the whole string) — fine
// for a single-word currency name, but narration almost never repeats a full descriptive item
// name verbatim ("Pale bone-wood half-mask", "1,000 gold pouch"), so legitimate quantity gains
// on those items were routinely blocked as "ungrounded." Try the full name first (most precise
// grounding); only if that finds nothing, fall back to the name's single longest/most
// distinctive word — same anchor logic guardDuplicationMath already uses — so a real gain isn't
// blocked just because the short-form name used in the log doesn't match the sheet's full label.
function extractNumbersNearItemLabel(label, haystack){
  const full = extractNumbersNearKey(label, haystack);
  if(full.length) return full;
  const words = String(label||'').toLowerCase().split(/\s+/).filter(Boolean);
  if(words.length <= 1) return full; // already a single word — nothing looser to try
  const anchor = words.reduce((a,b)=> b.length>a.length ? b : a, '');
  if(!anchor || STOPWORD_ANCHORS.has(anchor)) return full;
  return extractNumbersNearKey(anchor, haystack);
}
// BUG FIX (unscoped player-confirmation): every confirmation-based inventory guard used to
// compute ONE global boolean from the player's whole message and apply it to every item in
// every category that turn — so "I put on my boots" would green-light a status rewrite, rename,
// or discard on a completely unrelated item in the same turn. This scopes confirmation to the
// specific item: splits the text into sentence/clause chunks and only counts a trigger phrase
// as confirming THIS item if a distinctive word from the item's own name appears in the same
// chunk as the trigger. playerNamedListedAbility is kept as a separate, already-scoped
// alternative (it already checks the ability's own name appears in the text).
function itemMentionedNear(text, itemLabel, triggerRe){
  const norm = String(text || '');
  if(!norm) return false;
  const words = [...itemWordSet(itemLabel)].filter(w => w.length > 2 && !STOPWORD_ANCHORS.has(w));
  if(!words.length) return false;
  const chunks = norm.split(/(?<=[.!?\n])/);
  for(const chunk of chunks){
    if(!triggerRe.test(chunk)) continue;
    const chunkLower = chunk.toLowerCase();
    if(words.some(w => chunkLower.includes(w))) return true;
  }
  return false;
}
function itemActionConfirmed(playerText, itemLabel, triggerRe, panel){
  return itemMentionedNear(playerText, itemLabel, triggerRe) || abilityMentionedNear(playerText, itemLabel, panel);
}
// ---------- STRICT gain confirmation (used ONLY for authorizing an inventory INCREASE) ----------
// Deliberately does not reuse itemActionConfirmed's default abilityMentionedNear call, because
// that function's "pass 2" fallback (below) only requires the ability's name and the item's name
// to appear somewhere in the same sentence — no actual usage claim at all. That looseness is
// acceptable for a DECREASE or a cosmetic STATUS change (worst case: a slightly-too-eager status
// edit), but not for something that manufactures value out of nothing: "my Duplication Jutsu is
// strong, I really like this Kunai" must NOT be enough to duplicate the Kunai. Gains require the
// tight, structural "I used/applied <ability> on/to <item>" pattern (abilityMentionedNear's pass
// 1) or an explicit acquisition verb (ITEM_GAIN_TRIGGER_RE) — never the loose co-occurrence pass.
function itemGainConfirmed(playerText, itemLabel, panel){
  return itemMentionedNear(playerText, itemLabel, ITEM_GAIN_TRIGGER_RE) || abilityMentionedNear(playerText, itemLabel, panel, true);
}
// BUG FIX (unscoped ability confirmation — same class as the verb-list scoping bug above, just
// via the ability path): playerNamedListedAbility used to authorize a change on ANY item as
// long as a listed ability's name appeared ANYWHERE in the player's message — "I use my Fire
// Breathing Technique" would green-light a status change on a totally unrelated item in the
// same turn. Scoped here the same way the verb triggers are: the ability only counts as
// confirming THIS item if it's named in the same sentence/clause as the item. Also fuzzy: only
// the ability's single longest/most distinctive word has to appear (same anchor approach as the
// duplication guard), not the full name verbatim — "I use my fire technique on it" still
// matches a listed "Mouth Fire-Breathing Technique," dropping "mouth"/"breathing" but keeping
// the core word that actually identifies the technique.
// Captures the "I used ___ on/to/onto/against/over ___" shape: group 2 is whatever sits between
// "used" and the preposition (should name the ability), group 4 is whatever follows the
// preposition (should name the item). Mirrors ITEM_USE_ON_OTHER_RE's direction assumption.
// Widened to also accept "I applied/apply/applying <ability> to <item>" alongside "used" —
// same pair of equivalent verbs this file already treats as interchangeable elsewhere (see
// ITEM_USE_TRIGGER_RE's own use(?:...)/appl(?:y|ied|ying) pairing).
const ABILITY_USE_ON_RE = /\b(i\s*(?:us(?:e|ed|ing)|appl(?:y|ies|ied|ying)))\b(.*?)\b(on|onto|to|over|against)\b(.*)$/i;
// `strict` (default false, preserves existing decrease/status behavior): when true, skips pass 2
// below entirely — only the tight structural "I used/applied X on/to Y" pattern can confirm.
// Used by itemGainConfirmed above so a GAIN can never be authorized by loose co-occurrence.
function abilityMentionedNear(playerText, itemLabel, panel, strict){
  const text = String(playerText || '');
  if(!text || !panel) return false;
  // Rule 1: both sides must already be real entries on the sheet — itemLabel here is always
  // drawn from an existing Inventory entry by the caller, and `abilities` below is only ever
  // populated from what's actually listed in Skills & Abilities, so a skill or item the player
  // merely TYPES but doesn't actually have on the sheet can never satisfy this. Word-length
  // cutoff kept low (>2) on both sides so a real short name isn't excluded just for being short.
  const itemWords = [...itemWordSet(itemLabel)].filter(w => w.length > 2 && !STOPWORD_ANCHORS.has(w));
  if(!itemWords.length) return false;
  const abilities = listedAbilityNames(panel);
  if(!abilities.length) return false;
  const abilityWordsFor = (ability) => ability.split(' ').filter(w => w.length > 2 && !STOPWORD_ANCHORS.has(w));
  const chunks = text.split(/(?<=[.!?\n])/);
  // Rule 2, pass 1 (tight): the structural "I used/applied <ability> on/to/onto/against/over
  // <item>" pattern — ability before the preposition, item after.
  for(const chunk of chunks){
    const m = ABILITY_USE_ON_RE.exec(chunk);
    if(!m) continue;
    const beforePrep = normalizeSkillLabel(m[2]);
    const afterPrep = normalizeSkillLabel(m[4]);
    if(!itemWords.some(w => afterPrep.includes(w))) continue; // this item isn't the "on/to" target
    for(const ability of abilities){
      if(abilityWordsFor(ability).some(w => beforePrep.includes(w))) return true;
    }
  }
  if(strict) return false; // gain path: never fall through to the loose pass below
  // Rule 2, pass 2 (looser fallback — DECREASE/STATUS ONLY, never gain; see itemGainConfirmed):
  // real phrasing varies more than any fixed verb/preposition list can fully cover ("I channel
  // my X into Y", "I hit Y with my X", ...). Rather than block a legitimate action just because
  // it doesn't match the exact "used/applied ... on/to ..." shape, fall back to requiring the
  // ability's word and the item's word to at least appear together in the SAME sentence/clause —
  // looser on structure, but still gated on both being real sheet entries (Rule 1) and
  // co-located, never just anywhere in the whole message (that whole-message version is the
  // exact bug that let one confirming phrase authorize a change on an unrelated item elsewhere
  // in the same turn).
  for(const chunk of chunks){
    const chunkNorm = normalizeSkillLabel(chunk);
    if(!itemWords.some(w => chunkNorm.includes(w))) continue;
    for(const ability of abilities){
      if(abilityWordsFor(ability).some(w => chunkNorm.includes(w))) return true;
    }
  }
  return false;
}
// Status-only confirmation: adds a generic first-person fallback on top of itemActionConfirmed
// — any clause that names the item AND has the player speaking in first person counts as "did
// something to it," even with a verb outside the hardcoded ITEM_STATE_TRIGGER_RE list ("I
// stitched my shirt" isn't in the verb list, but should still be able to clear a "Torn" status).
// Deliberately NOT used for quantity changes (still gated by the specific ITEM_USE_TRIGGER_RE
// list) or discards (still gated by DISCARD_TRIGGER_RE) or rename-identity confirmation (still
// gated by itemActionConfirmed's verb/ability match, never the loose fallback) — those are
// destructive or resource-affecting paths where "the item was merely mentioned" isn't enough of
// a signal, unlike a cosmetic status string.
const FIRST_PERSON_RE = /\bi\b/i;
function itemStatusConfirmed(playerText, itemLabel, panel){
  return itemActionConfirmed(playerText, itemLabel, ITEM_STATE_TRIGGER_RE, panel)
    || itemActionConfirmed(playerText, itemLabel, ITEM_USE_ON_OTHER_RE, panel)
    || itemMentionedNear(playerText, itemLabel, FIRST_PERSON_RE);
}
// True if `target` equals any single number in `numbers`, or the sum of any subset of them —
// covers a turn where several separately-priced items were bought together and the sheet
// update is their combined total. Numbers array is capped at 8 by extractNumbersNearKey, so
// the full subset space (2^8=256) is cheap to check exhaustively.
function subsetSumMatches(target, numbers){
  if(!numbers.length) return false;
  const n = numbers.length;
  for(let mask = 1; mask < (1 << n); mask++){
    let sum = 0;
    for(let i = 0; i < n; i++) if(mask & (1 << i)) sum += numbers[i];
    if(Math.abs(sum - target) < 0.5) return true;
  }
  return false;
}

// ================= SKILLS & ABILITIES — LEARNING GUARDS =================
// Percentage-progress guard for in-training skills, mastery graduation into the
// permanent Skills & Abilities list, and the backstop that blocks using an ability
// that was never actually granted.

// ---------- hard code-level guard: a skill/ability percentage can only go UP (or be created)
// if the player's own last message actually shows them studying/practicing/learning it. Same
// reasoning as the currency guard above — without this, the background model tends to nudge
// skill percentages up on its own just because the story is continuing, even on turns where
// the player didn't actually do anything to earn the progress.
const SKILL_PCT_RE = /^\d{1,3}\s*%$/;
// Was requiring "i" to sit immediately next to the verb (only whitespace allowed between them),
// so "I started learning", "I began training", "I keep practicing", "I decided to study" all
// failed to match — the verb has to be the very next word. That silently blocked brand-new
// "Learning" entries (and progress on existing ones) any time the player phrased it with so
// much as one word in between. Fix: allow up to 3 intervening words between "i" and the verb,
// with a negative lookahead so a negation word in that gap (not/never/refuse/avoid/stop/quit/
// skip/can't/won't/wouldn't/don't/didn't) correctly blocks the match instead of "I refuse to
// train" or "I decided not to study" false-triggering progress.
const PRACTICE_TRIGGER_RE = /\bi\b(?:'|’)?(?:ve|d|m)?(?:\s+(?!(?:not|never|n't|refuse\w*|avoid\w*|stop\w*|quit\w*|skip\w*|can'?t|won'?t|wouldn'?t|don'?t|didn'?t)\b)\w+){0,3}\s*\b(?:stud(?:y|ied|ying)|open(?:ed|ing)?|read(?:ing)?|learn(?:ed|t|ing)?|practic(?:e|ed|ing)|train(?:ed|ing)?|drill(?:ed|ing)?|rehears(?:e|ed|ing)|work(?:ed|ing)?\s*on|review(?:ed|ing)?|go(?:es)?\s*over)\b/i;
// Normalizes a skill/label name for loose matching: lowercase, drop parenthetical notes,
// strip punctuation, collapse whitespace.
function skillLabelWords(s){
  return String(s||'')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(w => w.length >= 4); // ignore short/filler words (style, of, the, etc. mostly survive on purpose)
}
// A skill's percentage can only move if the player's own message actually names that specific
// skill — not just any skill. Without this, a single generic "I practiced" line was bumping
// EVERY percentage entry the background model happened to echo back in its update (often the
// whole Learning list, since models tend to restate unchanged fields), so skills the player
// never touched that turn still climbed. Requires at least one distinctive (4+ letter) word
// from the skill's own name to appear in the player's text.
function skillMentionedInText(skillKey, text){
  const words = skillLabelWords(skillKey);
  if(!words.length) return false;
  const norm = String(text||'').toLowerCase();
  return words.some(w => norm.includes(w));
}
function guardSkillProgress(data, panel, playerText, isResync){
  if(!data || !data.categories) return data;
  const playerConfirmedPractice = PRACTICE_TRIGGER_RE.test(playerText || '');
  for(const [catName, catUpdate] of Object.entries(data.categories)){
    if(!catUpdate || !catUpdate.kv || typeof catUpdate.kv !== 'object') continue;
    for(const [k, v] of Object.entries(catUpdate.kv)){
      if(!SKILL_PCT_RE.test(String(v).trim())) continue; // only gate percentage-style skill progress
      const existingCat = panel && panel.categories ? panel.categories[findExistingKey(panel.categories, catName) || catName] : null;
      const existingRaw = existingCat && existingCat.type==='kv' ? existingCat.data[findExistingKey(existingCat.data, k) || k] : null;
      const oldNum = existingRaw != null ? parseInt(String(existingRaw).trim(), 10) : null;
      // During a rewind/regenerate resync this is correcting the sheet to match a branch that
      // no longer happened — that correction (often a DEcrease, undoing progress from a message
      // that just got deleted) has no reason to be backed by a fresh "I studied/practiced"
      // phrase in the post-rewind log, and forcing the flat +10%-per-practice-phrase rule here
      // would actively fight the correction instead of allowing it. Only the normal per-turn
      // forward-progress path needs the practice-phrase gate and the flat +10% step.
      if(isResync){
        catUpdate.kv[k] = String(Math.max(0, Math.min(100, isNaN(parseInt(String(v).trim(),10)) ? (oldNum||0) : parseInt(String(v).trim(),10)))) + '%';
        continue;
      }
      const mentionedThisSkill = playerConfirmedPractice && skillMentionedInText(k, playerText);
      if(!mentionedThisSkill){
        // Either no study/practice phrase this turn, or the phrase didn't name this particular
        // skill — either way this entry cannot move, no matter what the background model
        // proposed. Drop the proposed change entirely rather than trusting it.
        console.warn(`[skill guard] blocked ${catName}.${k} progress (${oldNum==null?'new entry':oldNum+'%'} -> ${v}) — ${playerConfirmedPractice ? `player's message didn't name "${k}"` : 'no study/practice phrase ("I studied/opened/read/learned/practiced/trained/...") in player\'s last message'}`);
        delete catUpdate.kv[k];
        continue;
      }
      // A confirmed study/practice phrase naming this exact skill was found — force a flat,
      // deterministic +10% for this turn, capped at 100. Deliberately never trusts the AI's own
      // guessed increment (which drifted/varied), so one "I studied X" always means exactly the
      // same +10% for X, and nothing else.
      const base = (oldNum != null && !isNaN(oldNum)) ? oldNum : 0;
      catUpdate.kv[k] = Math.min(100, base + 10) + '%';
    }
    if(Object.keys(catUpdate.kv).length === 0) delete catUpdate.kv;
  }
  return data;
}

// ---------- hard code-level guard: a skill can only enter "Skills & Abilities" once it has
// actually graduated (reached 100% in "Learning") — never the moment training starts, and
// never just because the AI decided to add it directly. The system prompt already tells the
// model not to do this, but the background model does it anyway from time to time, which is
// what causes the same technique to show up both as a 10%/16%/44% bar in "Learning" AND as a
// fully-usable entry in "Skills & Abilities" at the same time. This strips any proposed
// list_add to "Skills & Abilities" that names something still below 100% in "Learning" —
// checking BOTH the sheet as it stood before this turn AND this turn's own proposed Learning
// changes (a skill can be added to Learning at, say, 10% and to Skills & Abilities in the very
// same response — the old panel alone wouldn't catch that, since the entry didn't exist yet
// before this turn). promoteMasteredSkills() is the only thing allowed to move an entry across
// once it actually hits 100%.
function normalizeSkillLabel(s){
  return String(s||'')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ') // drop parenthetical notes like "(Innate Power)"
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function guardSkillGraduation(data, panel){
  if(!data || !data.categories) return data;
  const learningKey = panel && panel.categories ? findExistingKey(panel.categories, 'Learning') : null;
  const learningCat = learningKey ? panel.categories[learningKey] : null;
  // Start from the sheet as it stood before this turn.
  const merged = {}; // normalized label -> percentage number
  if(learningCat && learningCat.type === 'kv'){
    for(const [k,v] of Object.entries(learningCat.data)){
      const n = parseInt(String(v).trim(), 10);
      if(!isNaN(n)) merged[normalizeSkillLabel(k)] = n;
    }
  }
  // Overlay this turn's own proposed Learning changes (new entries and updates alike) — these
  // take precedence since they reflect what the sheet will actually be after this update.
  const dataLearningKey = findExistingKey(data.categories, 'Learning');
  const dataLearningUpdate = dataLearningKey ? data.categories[dataLearningKey] : null;
  if(dataLearningUpdate && dataLearningUpdate.kv && typeof dataLearningUpdate.kv === 'object'){
    for(const [k,v] of Object.entries(dataLearningUpdate.kv)){
      const n = parseInt(String(v).trim(), 10);
      if(!isNaN(n)) merged[normalizeSkillLabel(k)] = n;
    }
  }
  const inProgress = Object.entries(merged).filter(([,n]) => n < 100).map(([k]) => k).filter(Boolean);
  if(!inProgress.length) return data;
  for(const [catName, catUpdate] of Object.entries(data.categories)){
    if(!/^skills?(\s|&|$)/i.test(catName.trim())) continue;
    if(!catUpdate || !Array.isArray(catUpdate.list_add)) continue;
    catUpdate.list_add = catUpdate.list_add.filter(it=>{
      const norm = normalizeSkillLabel(it);
      const stillLearning = inProgress.some(k => norm===k || norm.includes(k) || k.includes(norm));
      if(stillLearning){
        console.warn(`[skill guard] blocked "${it}" from entering Skills & Abilities — still in Learning below 100%`);
        return false;
      }
      return true;
    });
    if(catUpdate.list_add.length === 0) delete catUpdate.list_add;
  }
  return data;
}

// ================= INVENTORY — STACKABLE ITEMS & GUARDS =================
// Parsing "<item> — <status>" entries; entry naming for drag-to-merge; the shared
// ability cross-reference helpers; the quantity guard for stackable items and its
// duplication-math and ungraduated-ability backstops; and the equip-status/
// rename-bypass/discard guards. Ordered so every helper appears before the guard(s)
// that depend on it.

// ---------- entry parsing: "<item>", "<qty> <item>", or "<item> — <status>" ----------
// BUG FIX (status parsing / duplicate-name bug): the documented separator for an item's status
// suffix is an em dash (—, U+2014), but a model sometimes emits the visually near-identical en
// dash (–, U+2013) instead — the exact same substitution the "Day N — description" parser
// elsewhere in this file already had to special-case (see DAY_ENTRY_RE above), except that fix
// was never carried over to inventory items. When an en dash slipped through, indexOf('—')
// found nothing, so the WHOLE string (e.g. "Blade – Poisoned") was read back as the item's
// NAME with status:null — status silently stopped working, and because the "name" no longer
// matched the real "Blade" entry already on the sheet, later turns that referenced the item by
// its actual name couldn't find it either, so a second near-duplicate entry got created instead
// of updating the original. Centralized here (rather than duplicating the check in every place
// that reads this suffix) so it only ever needs fixing once. Deliberately still excludes a
// plain hyphen: item names can legitimately contain one ("bone-wood half-mask"), so a bare "-"
// can never be trusted as the separator without risking splitting a name in half.
function findItemStatusDashIndex(text){
  const m = /[—–]/.exec(text);
  return m ? m.index : -1;
}
function splitItemEntry(raw){
  const s = String(raw || '').trim();
  // Quantities can be written with thousands separators, exactly like the sheet's own
  // examples ("1,000 gold pouch" -> "900 gold pouch") — the number itself must allow commas
  // or a comma-formatted amount silently fails to parse as a quantity at all (falls through
  // as a plain, un-countable item named "1,000 gold pouch"), which breaks every guard that
  // relies on comparing old vs. new quantity for the exact same item.
  // BUG FIX: this used to allow a leading "-" ("-5 Kunai"), which parsed as a "confirmed"
  // negative quantity and only got floored to 0 downstream — after it had already been treated
  // as a legitimate decrease if a use-phrase happened to be present anywhere that turn. A
  // negative number in front of an item name isn't a real quantity at all, so it's rejected
  // at the source instead: qm simply won't match, and the whole string falls through as a
  // non-quantity item name (cosmetic at worst, never a gamed decrease).
  const qm = /^([\d,]+)\s+(.*)$/.exec(s);
  const qty = qm ? parseInt(qm[1].replace(/,/g, ''), 10) : null;
  const rest = (qm ? qm[2] : s).trim();
  const dashIdx = findItemStatusDashIndex(rest);
  if(dashIdx === -1) return { qty, name: rest, status: null };
  return { qty, name: rest.slice(0, dashIdx).trim(), status: rest.slice(dashIdx+1).trim() || null };
}
function itemNameKey(raw){ return splitItemEntry(raw).name.toLowerCase().replace(/\s+/g,' ').trim(); }
// Inventory grid slots (the square, game-style frames on the Letter of Records / Inventory
// page) have no uploaded artwork per item, so each slot shows a short glyph derived from the
// item's own name instead of a picture — first letters of up to the first two words, e.g.
// "Healing Potion" -> "HP", "Kunai" -> "K". Purely cosmetic/display; never stored or sent
// to the AI, and has no bearing on matching/merging (which still key off the full name).
function invSlotGlyph(name){
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if(!words.length) return '?';
  if(words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
function rebuildItemEntry(qty, name, status){
  const qtyStr = Number.isFinite(qty) ? qty.toLocaleString('en-US') : String(qty);
  return `${qtyStr} ${name}${status ? ' — ' + status : ''}`.trim();
}

// ---------- Equip compass: display-only visual summary of Inventory's on-body statuses ----------
// Reads the same Inventory entries/statuses everything above already maintains — no new
// data, no new guard. An item counts as "on body" when its status (from splitItemEntry)
// is one of these; slot is guessed from keywords in the item's name. Purely a render-time
// grouping for the Letter of Records — never written back to the sheet.
// For now the only statuses this equip system itself writes or recognizes are "Equipped" and
// nothing (unequipped) — the long-press action sheet's toggle only ever sets one of those two.
// Worn/Sheathed/Held are no longer treated as on-body here (an item can still carry any other
// status text the story writes, e.g. "Poisoned" or "Hidden under the bed" — that's a separate,
// unrelated system — it just won't show as equipped in the box/slots below unless it's
// literally "Equipped").
const EQUIP_ON_BODY_STATUSES = ['equipped'];
function isOnBodyStatus(status){
  if(status == null) return false;
  return EQUIP_ON_BODY_STATUSES.includes(String(status).toLowerCase());
}
const EQUIP_SLOT_RULES = [
  // --- head-to-foot order: full body, head/hair/face, neck, shoulders, chest, back, arms,
  // wrist, hands, waist, thigh, foot. 26 slots total (23 previous + hair, left shoulder,
  // right shoulder). Each rule also carries a `group` — purely for organizing the legend
  // into labeled, well-spaced sections; it has no effect on matching/merging. ---
  { slot:'full-body', icon:'⬜', label:'Full body', group:'Body', kws:['bodysuit','jumpsuit','onesie','full-body','full body'] },
  { slot:'head', icon:'⬜', label:'Head / forehead', group:'Head & Face', kws:['helm','kabuto','hat','hood','headband','crown','circlet','forehead'] },
  { slot:'hair', icon:'⬜', label:'Hair', group:'Head & Face', kws:['wig','hairpin','hair clip','hair ribbon','hair ornament'] },
  { slot:'face', icon:'⬜', label:'Face / eyes', group:'Head & Face', kws:['mask','veil','goggles','blindfold','visor','glasses','monocle'] },
  { slot:'neck', icon:'⬜', label:'Neck', group:'Neck & Shoulders', kws:['amulet','necklace','pendant','torc','choker'] },
  { slot:'shoulder-left', icon:'⬜', label:'Left shoulder', group:'Neck & Shoulders', kws:[] },
  { slot:'shoulder-right', icon:'⬜', label:'Right shoulder', group:'Neck & Shoulders', kws:[] },
  { slot:'chest', icon:'⬜', label:'Chest', group:'Torso', kws:['armor','cuirass','robe','coat','jacket','vest','kimono','plate','breastplate'] },
  { slot:'back', icon:'⬜', label:'Back', group:'Torso', kws:['cloak','cape','mantle','backpack','quiver','satchel'] },

  // --- positional/manual: left vs right, inner vs outer wrist, worn vs held in hand — can't
  // be told apart from an item's name alone, so these never auto-fill yet. Placeholder icon
  // only; will stay "Empty" until we decide how an item gets pinned to one of these.
  // Labels below use the plain standard term where one exists (Upper Arm, Forearm, Thigh —
  // no side-vs-side ambiguity to resolve), and fall back to an em-dash qualifier — matching
  // the item-status style used elsewhere on the sheet (e.g. "Kunai — Sheathed") — only where
  // there's no single clean word for the distinction (wrist position, hand worn vs. held).
  // Every paired slot uses the SAME qualifier vocabulary on both sides (e.g. inner/outer for
  // both wrists, not inner/outer on one side and front/back on the other) so a left/right pair
  // always reads as the obviously-same spot on opposite limbs. Same slot keys/kws/icons as
  // before; only the display text changed. ---
  { slot:'upper-arm-left', icon:'⬜', label:'Left upper arm', group:'Arms', kws:[] },
  { slot:'upper-arm-right', icon:'⬜', label:'Right upper arm', group:'Arms', kws:[] },
  { slot:'forearm-left', icon:'⬜', label:'Left forearm', group:'Arms', kws:[] },
  { slot:'forearm-right', icon:'⬜', label:'Right forearm', group:'Arms', kws:[] },
  { slot:'wrist-upper-left', icon:'⬜', label:'Left wrist — front', group:'Wrists', kws:[] },
  { slot:'wrist-lower-left', icon:'⬜', label:'Left wrist — back', group:'Wrists', kws:[] },
  { slot:'wrist-front-right', icon:'⬜', label:'Right wrist — front', group:'Wrists', kws:[] },
  { slot:'wrist-back-right', icon:'⬜', label:'Right wrist — back', group:'Wrists', kws:[] },
  { slot:'hand-left-wearing', icon:'⬜', label:'Left hand — worn', group:'Hands', kws:[] },
  { slot:'hand-left-action', icon:'⬜', label:'Left hand — held', group:'Hands', kws:[] },
  { slot:'hand-right-wearing', icon:'⬜', label:'Right hand — worn', group:'Hands', kws:[] },
  { slot:'hand-right-action', icon:'⬜', label:'Right hand — held', group:'Hands', kws:[] },

  // --- auto-guessed, resumed here to keep the whole array in head-to-foot order ---
  { slot:'waist', icon:'⬜', label:'Waist', group:'Waist', kws:['belt','sash','girdle','waistband'] },
  { slot:'legs', icon:'⬜', label:'Legs', group:'Legs', kws:['greaves','trousers','pants','leggings','hakama'] },
  { slot:'thigh-left', icon:'⬜', label:'Left thigh', group:'Thighs', kws:[] },
  { slot:'thigh-right', icon:'⬜', label:'Right thigh', group:'Thighs', kws:[] },
  { slot:'foot', icon:'⬜', label:'Feet / ankles', group:'Feet', kws:['boot','tabi','shoe','sandal','geta','anklet'] },
];
function guessEquipSlot(name){
  const n = String(name||'').toLowerCase();
  for(const r of EQUIP_SLOT_RULES){ if(r.kws.some(k => n.includes(k))) return r; }
  return { slot:'accessory', icon:'🏷️', label:'Accessory' };
}
// Builds { bySlot, accessories } straight from Inventory's own list entries — reuses
// splitItemEntry so an en dash vs em dash status suffix, quantities, etc. are read
// identically to every other Inventory-facing view. `ids` (same index as `items`, i.e.
// Inventory's own cat.ids) is threaded through so each matched item keeps its permanent
// hidden ID — needed to look up its stored photo for the filled-slot display below.
function computeEquipSlots(items, ids){
  const bySlot = {};
  const accessories = [];
  (items||[]).forEach((raw, i)=>{
    const it = splitItemEntry(raw);
    if(!isOnBodyStatus(it.status)) return;
    const rule = guessEquipSlot(it.name);
    const withId = Object.assign({}, it, rule, { id: (ids && ids[i]) || null });
    if(rule.slot === 'accessory'){ accessories.push(withId); return; }
    if(!bySlot[rule.slot]) bySlot[rule.slot] = withId;
  });
  return { bySlot, accessories };
}
// Renders the hub (person icon, left) + a simple 2-column grid of every slot (right), as
// plain HTML (no React — matches how the rest of the Letter of Records is built). Slots are
// now wired live to the long-press action sheet's Equip/Unequip toggle: a slot whose guessed
// item is currently "Equipped" shows that item's own photo (falling back to its name-glyph)
// and name; every other slot shows its plain placeholder icon and label, same as before.
// Still fully display-only here — no data-id, no click handling — the actual equip/unequip
// action lives on the Inventory card itself (see the itemActionSheet wiring further down);
// this just reflects whatever that toggle last set.
function renderEquipCompassHtml(items, ids, photos){
  const { bySlot } = computeEquipSlots(items, ids);
  const cells = EQUIP_SLOT_RULES.map(rule=>{
    const item = bySlot[rule.slot];
    const photoUrl = item && item.id && photos ? photos[item.id] : null;
    const iconInner = photoUrl
      ? `<img class="equip-slot-photo" src="${escapeHtml(photoUrl)}" alt="">`
      : (item ? escapeHtml(invSlotGlyph(item.name)) : rule.icon);
    return `<div class="equip-cell${item ? ' is-filled' : ''}">
      <div class="equip-slot-icon${item ? ' has-item' : ''}">${iconInner}</div>
      <div class="equip-slot-label">${escapeHtml(rule.label)}</div>
      ${item ? `<div class="equip-slot-item-name">${escapeHtml(item.name)}</div>` : ''}
    </div>`;
  }).join('');
  const hub = `<div class="equip-hub-top" onclick="document.getElementById('equipHubTopFile').click()"><span class="equip-hub-placeholder" id="equipHubTopIcon">+ Add image</span></div><div class="equip-hub-bottom" onclick="document.getElementById('equipHubBottomFile').click()"><span class="equip-hub-placeholder" id="equipHubBottomPlaceholder">+ Add image</span></div>`;
  return `<div class="equip-compass-wrap">
    <div class="equip-box">
      <div class="equip-body-row">
        <div class="equip-hub-col">${hub}</div>
        <div class="equip-grid">${cells}</div>
      </div>
    </div>
  </div>`;
}

// ---------- drag-to-merge naming ----------
// ---- Drag-to-merge naming: the merged item's name is ALWAYS derived from the two items
// actually dragged together, never free-typed. The old flow let the player confirm a merge
// with any text at all ("100 gold", "a power jutsu"...), which was a wide-open backdoor
// straight past every guard above that keeps Finances/Skills/Inventory honest — merging
// bypasses the AI/guard chain entirely by design (see doMerge in paintPanel), so an
// unconstrained name field was the one place nothing was checking what landed on the sheet.
// Deriving the name mechanically from the two existing (already-vetted) labels closes that
// off without needing a slow AI round-trip: there is no field left for the player to type
// something that wasn't already legitimately on the sheet.
function mergeNameCore(label){
  let s = String(label || '').trim();
  // Drop a leading count ("2 bundles of ...", "120,000,000 packs of ...") the same way
  // splitItemEntry already parses it elsewhere — the number is bookkeeping, not part of the
  // merged item's identity.
  s = splitItemEntry(s).name;
  // Drop a leading generic article so "a poisoned dart" + "kunai" reads as "Poisoned Dart
  // Kunai", not "A Poisoned Dart Kunai".
  s = s.replace(/^(a|an|the|some)\s+/i, '');
  return s.trim();
}
function autoMergeName(sourceLabel, targetLabel){
  const a = mergeNameCore(sourceLabel) || String(sourceLabel || '').trim();
  const b = mergeNameCore(targetLabel) || String(targetLabel || '').trim();
  return `${a} ${b}`.replace(/\s+/g, ' ').trim();
}

// ---------- ability cross-reference helpers (shared by every guard below) ----------
// ---------- shared helper: recognizes when the player's own message names a skill/ability
// that's actually GRADUATED on their sheet (a mastered entry in "Skills & Abilities") — e.g.
// "I use my Duplication on the knife" or "I hit it with Repair Touch". This lets a
// player-invoked ability satisfy any of the inventory action-phrase guards below on its own,
// without also needing to happen to phrase the action using one of the hardcoded English verbs
// those guards otherwise look for. The ability still has to already be listed for this to fire
// — that's the sheet's own earned truth, not re-checked here — so this only ever loosens
// confirmation for something the player legitimately has, never grants a free pass to an
// ability they don't.
//
// Deliberately does NOT include "Learning" entries, even ones sitting at 90%+ — the hard-limit
// rule only grants full, reliable, unrestricted power (usable on Inventory items with no
// "still getting used to it" hedging) to a skill once it has actually graduated into "Skills &
// Abilities". Counting an in-progress Learning entry as equally authorizing here would let the
// player's own message bypass guardStackableItems / guardInventoryEquipStatus /
// guardInventoryRenameBypass using a skill that isn't supposed to reliably work yet at all.
// guardUngraduatedAbilityInventory further down is the backstop for the same bypass happening
// from the background model's own narration, without the player even naming anything.
function listedAbilityNames(panel){
  const names = [];
  if(!panel || !panel.categories) return names;
  for(const [catName, cat] of Object.entries(panel.categories)){
    if(!cat) continue;
    if(cat.type === 'list' && /skills?(\s|&|$)|abilit|powers?\b|techniques?\b|jutsu\b/i.test(catName)){
      for(const it of (cat.data || [])) names.push(it);
    }
  }
  // Drop very short normalized names (<=3 chars) — too likely to false-positive by matching
  // an unrelated common word elsewhere in the player's sentence.
  return names.map(normalizeSkillLabel).filter(n => n.length > 3);
}
function playerNamedListedAbility(playerText, panel){
  const text = normalizeSkillLabel(playerText || '');
  if(!text) return false;
  return listedAbilityNames(panel).some(name => name && text.includes(name));
}

// ---------- quantity guard (stackable items) ----------
// ---------- hard code-level guard: an item's quantity — a list-category entry
// written as "N <descriptor>", e.g. "5 packs of explosive tags" — can only DECREASE if the
// player's own last message actually shows them using/spending it. Same reasoning as the
// currency and skill guards above — this is exactly the bug those were built for, just
// showing up in "list" categories (inventory) instead of "kv" ones (currency/skills), so it
// slipped past both existing guards. Also hard-floors any count at 0 so it can never go
// negative, no matter what triggered the change.
//
// An entry may also carry an optional " — <status>" suffix (e.g. "1 half-mask — Equipped",
// "0 explosive tags — All used") using an em dash specifically, never a bare hyphen — item
// names themselves can legitimately contain hyphens ("bone-wood"), so a plain "-" can't be
// trusted as the status separator without risking splitting a name in half. splitItemEntry
// below is the one place that parses this format; every guard here reads through it instead
// of pattern-matching the raw string, so quantity comparisons always compare like-for-like
// regardless of whatever status text is or isn't attached.
// Bug fixes: "dropp(?:ed|ing)?" and "popp(?:ed|ing)" required the doubled consonant even for
// the bare present-tense verb ("I drop"/"I pop" never matched at all, since neither contains
// the literal substring "dropp"/"popp") — corrected to "drop(?:s|ped|ping)?" / "pop(?:s|ped|ping)?"
// so the doubling only applies to the "-ed"/"-ing" suffixes, matching the pattern used
// correctly everywhere else in this file (grip, strap, chip, snap, wrap, swap, ...). Also
// added present-tense "eat"/"drink" — only their past-tense forms ("ate"/"drank") were here,
// so "I eat the food" / "I drink the potion" silently failed to authorize the item-count drop.
const ITEM_USE_TRIGGER_RE = /\b(i\s*us(?:e|ed|ing)|i\s*threw|i\s*throw(?:ing)?|i\s*detonat(?:e|ed|ing)|i\s*set\s*off|i\s*activat(?:e|ed|ing)|i\s*consum(?:e|ed|ing)|i\s*spen(?:d|t|ding)|i\s*drop(?:s|ped|ping)?|i\s*gave|i\s*hand(?:ed)?(?:\s*over)?|i\s*los[et]|i\s*broke|i\s*burn(?:ed|t|ing)|i\s*deploy(?:ed|ing)?|i\s*plant(?:ed|ing)?|i\s*fir(?:e|ed|ing)|i\s*shot|i\s*pop(?:s|ped|ping)?|i\s*trigger(?:ed|ing)?|i\s*eat(?:s|en|ing)?|i\s*ate|i\s*drink(?:s|ing)?|i\s*drank|i\s*appl(?:y|ied|ying)|i\s*sold|i\s*trad(?:e|ed|ing)|i\s*exchang(?:e|ed|ing)|i\s*swap(?:s|ped|ping)?)\b/i;
// ---------- acquisition/ability-gain trigger (HARD GATE on every inventory INCREASE) ----------
// A quantity going UP, or a brand-new item appearing at all, is only ever authorized by the
// PLAYER'S OWN message containing one of these phrases naming the item — never by the AI's own
// narration, an NPC's dialogue, or a number that merely happens to sit near the item's name
// somewhere in the log. This is deliberately narrower than ITEM_USE_TRIGGER_RE's log-wide
// grounding: acquisition ("I bought/received/paid/looted/gifted/found/picked up/took/earned/won/
// claimed a...") and ability-driven gain ("I used/applied my <listed ability> on <item>", via
// abilityMentionedNear inside itemActionConfirmed) are the ONLY two paths that can increase an
// item's count or add a new one through the AI pipeline. The one path outside this pipeline
// entirely is the manual drag-to-merge action on the dedicated Inventory page (doMerge), which
// bypasses guards by design and is unaffected by this regex.
const ITEM_GAIN_TRIGGER_RE = /\b(i\s*bought|i\s*buy(?:s|ing)?|i\s*purchas(?:e|ed|ing)|i\s*paid|i\s*pay(?:s|ing)?|i\s*receiv(?:e|ed|ing)|i\s*got|i\s*get(?:s|ting)?|i\s*loot(?:ed|s|ing)?|i\s*found|i\s*find(?:s|ing)?|i\s*pick(?:ed|s|ing)?\s*up|i\s*took|i\s*take|i\s*was\s*(?:given|gifted|handed)|i\s*gift(?:ed)?|i\s*earn(?:ed|s|ing)?|i\s*won|i\s*win(?:s|ning)?|i\s*claim(?:ed|s|ing)?|i\s*collect(?:ed|s|ing)?|i\s*trad(?:e|ed|ing)|i\s*exchang(?:e|ed|ing)|i\s*swap(?:s|ped|ping)?|i\s*us(?:e|ed|ing)|i\s*appl(?:y|ied|ying))\b/i;
function guardStackableItems(data, panel, playerText, recentLogText){
  if(!data || !data.categories) return data;
  // Same reasoning as guardCurrencyIncreases: a quantity DECREASE without a use/spend phrase is
  // already blocked just above, but until now a quantity INCREASE on an item already tracked
  // sailed through with no check at all — nothing stopped "3 Kunai" silently becoming "300
  // Kunai" with no basis in anything actually narrated. Ground it the same way currency gains
  // are grounded: require the new total or the exact gained amount to appear near the item's
  // own name somewhere in the recent log (player message + story narration).
  // NOTE: increases and brand-new adds are deliberately grounded against playerText ONLY, never
  // recentLogText/memory — the AI's own narration or an NPC's dialogue naming a number is not
  // authorization to grant it. recentLogText is still accepted for confirming a DECREASE/status
  // change (that direction was never the gap being closed here) and is left untouched below.
  for(const [catName, catUpdate] of Object.entries(data.categories)){
    if(!catUpdate || !Array.isArray(catUpdate.list_add)) continue;
    const existingCat = panel && panel.categories ? panel.categories[findExistingKey(panel.categories, catName) || catName] : null;
    if(!existingCat || existingCat.type !== 'list') continue;
    const blockedLabels = [];
    const fixedAdd = [];
    for(const entry of catUpdate.list_add){
      const parsed = splitItemEntry(entry);
      const label = itemNameKey(entry);
      const oldEntry = existingCat.data.find(it => itemNameKey(it) === label);
      if(parsed.qty == null){
        // Non-quantity entry (e.g. "Ancient Sword", no leading number). If it already exists on
        // the sheet, this is a rename/status change — leave it for guardInventoryEquipStatus /
        // guardInventoryRenameBypass to police, unchanged from before. If it does NOT already
        // exist, this is a brand-new item appearing out of nowhere, and used to sail through with
        // ZERO checks — closed now: it needs the same acquisition/ability phrase as any other
        // gain, in the player's own message, naming this item.
        if(oldEntry){ fixedAdd.push(entry); continue; }
        const playerConfirmedNewItem = itemGainConfirmed(playerText, label, panel);
        if(!playerConfirmedNewItem){
          console.warn(`[item guard] blocked brand-new item "${label}" — no acquisition/ability phrase ("I bought/received/paid/looted/gifted/found/picked up/took/earned/won/claimed/used/applied...") naming this item in player's own message`);
          blockedLabels.push(label);
          continue;
        }
        fixedAdd.push(entry);
        continue;
      }
      // BUG FIX: a brand-new item name (no exact match anywhere on the sheet) used to be waved
      // through with ANY quantity, no check at all — a background model could add "999999999
      // Gold Bricks" as a "new" item and nothing stopped it. Mirrors guardCurrencyIncreases:
      // treat a never-before-seen item as starting from an implicit quantity of 0, so its very
      // first amount has to be grounded exactly like any other gain, via the same logic below.
      const oldParsed = oldEntry ? splitItemEntry(oldEntry) : { qty: 0, name: parsed.name, status: null };
      if(oldEntry && (oldParsed.qty == null || isNaN(oldParsed.qty))){ fixedAdd.push(entry); continue; }
      let newQty = parsed.qty;
      const playerConfirmedUse = itemActionConfirmed(playerText, label, ITEM_USE_TRIGGER_RE, panel);
      const playerConfirmedState = itemStatusConfirmed(playerText, label, panel);
      if(newQty < oldParsed.qty && !playerConfirmedUse){
        console.warn(`[item guard] blocked "${label}" count decrease (${oldParsed.qty} -> ${newQty}) — no use/spend phrase ("I used/threw/detonated/spent/dropped/...") in player's last message`);
        blockedLabels.push(label);
        continue; // drop the proposed entry — the old one stays exactly as it was
      }
      if(newQty > oldParsed.qty){
        const gainDelta = newQty - oldParsed.qty;
        // HARD GATE: an increase is only authorized once the player's own message contains an
        // acquisition or ability-use phrase naming THIS item (or a listed ability applied to it)
        // — see ITEM_GAIN_TRIGGER_RE above. This is checked before, and separately from, the
        // arithmetic grounding just below: a trigger phrase with no matching number is still
        // blocked, and a matching number with no trigger phrase is also still blocked.
        const playerConfirmedGain = itemGainConfirmed(playerText, label, panel);
        if(!playerConfirmedGain){
          console.warn(`[item guard] blocked "${label}" count increase (${oldParsed.qty} -> ${newQty}) — no acquisition/ability phrase ("I bought/received/paid/looted/gifted/found/picked up/took/earned/won/claimed/used/applied...") naming this item in player's own message`);
          blockedLabels.push(label);
          continue;
        }
        // BUG FIX: extractNumbersNearKey required the item's FULL name to appear verbatim near
        // a number — fine for "Gold" but multi-word descriptive names ("Pale bone-wood
        // half-mask") almost never get repeated in full by the narration, so legitimate gains
        // were routinely blocked. extractNumbersNearItemLabel tries the full name first, then
        // falls back to the name's single most distinctive word. Scoped to playerText only (see
        // note above the loop) — a number the AI itself narrated doesn't count as grounding.
        const nearbyNumbers = extractNumbersNearItemLabel(label, playerText || '');
        const grounded = nearbyNumbers.includes(Math.round(newQty))
          || nearbyNumbers.includes(Math.round(gainDelta))
          || subsetSumMatches(gainDelta, nearbyNumbers);
        if(!grounded){
          console.warn(`[item guard] blocked "${label}" count increase (${oldParsed.qty} -> ${newQty}) — acquisition phrase present but no number in player's own message adds up to that gain or matches the new total; likely a mismatched/invented amount`);
          blockedLabels.push(label);
          continue; // drop the proposed entry — the old one stays exactly as it was
        }
      }
      if(newQty < 0) newQty = 0; // never let a stock display negative, no matter what triggered it
      // A quantity item's STATUS is gated exactly like a non-quantity item's — the qty guard
      // above only covers the number itself, so without this a status could be smuggled onto a
      // stackable item (e.g. "3 kunai" -> "3 kunai — Poisoned") riding along with an otherwise-
      // legitimate quantity update, bypassing guardInventoryEquipStatus entirely (which skips
      // every quantity-bearing entry, trusting this function to be the one that checks them).
      // BUG FIX: this used to only fire when parsed.status was non-null, so a proposed CLEAR
      // ("3 Kunai — Poisoned" -> "3 Kunai", parsed.status === null) never matched the condition
      // and finalStatus silently kept the old status forever — status could be added or swapped,
      // but never cleared, on any item that also carried a quantity. Comparing directly for
      // inequality (rather than requiring non-null) covers the clear direction too, still gated
      // on the same per-item confirmation.
      let finalStatus = oldParsed.status;
      if(parsed.status !== oldParsed.status){
        if(playerConfirmedState){ finalStatus = parsed.status; }
        else console.warn(`[item guard] blocked "${label}" status change ("${oldParsed.status||'none'}" -> "${parsed.status||'none'}") — no confirming action phrase naming this item in player's last message`);
      }
      fixedAdd.push(rebuildItemEntry(newQty, parsed.name, finalStatus));
    }
    catUpdate.list_add = fixedAdd;
    if(Array.isArray(catUpdate.list_remove) && blockedLabels.length){
      catUpdate.list_remove = catUpdate.list_remove.filter(r => !blockedLabels.includes(itemNameKey(r)));
    }
    if(catUpdate.list_add.length === 0) delete catUpdate.list_add;
    if(Array.isArray(catUpdate.list_remove) && catUpdate.list_remove.length === 0) delete catUpdate.list_remove;
  }
  return data;
}
// ---------- duplication-math backstop ----------
// ---------- hard code-level guard: pins the exact resulting number for a duplication/
// multiplication-type effect (e.g. "Tenfold Duplication Technique", "used my 10 fold
// duplication talent") to real arithmetic instead of trusting whatever the background model
// separately computed for it — and, critically, applies that correction directly even on a
// turn where the background model didn't propose any Inventory change for the item at all.
// That second half is what was actually causing the item to sit unchanged for several turns
// after the story already narrated the duplication happening: "what changed this turn?" is a
// single AI guess made from a 10-message window, and it can notice a moment was Milestone-
// worthy while still failing to also work out the matching inventory math in that same pass —
// there was previously nothing here to catch that specific kind of omission, only to fix a
// wrong number if one happened to get proposed. Without the injection half, the multiply only
// ever lands whenever a later pass (or a rewind/regenerate resync, with its wider 60-message
// window) happens to notice it — which is exactly the "why did it take so long" behavior.
const MULTIPLIER_WORD_MAP = {
  one:1, two:2, double:2, three:3, triple:3, treble:3, four:4, quadruple:4, five:5,
  quintuple:5, six:6, sextuple:6, seven:7, septuple:7, eight:8, octuple:8, nine:9,
  nonuple:9, ten:10, decuple:10, eleven:11, twelve:12, fifteen:15, twenty:20,
  fifty:50, hundred:100
};
function wordOrDigitToNumber(w){
  w = String(w||'').toLowerCase().trim();
  if(/^\d+$/.test(w)) return parseInt(w, 10);
  return MULTIPLIER_WORD_MAP[w] || null;
}
// Matches a duplicate/multiply/clone/copy/replicate verb near an "N-fold"/"Nx" multiplier
// (either order), plus a third branch for the more common narration style that never says
// "tenfold" at all — "multiplies into ten identical bundles" — which the guard used to miss
// entirely.
const DUP_MULTIPLIER_RE = /\b(?:duplicat\w*|multipl\w*|clon\w*|cop(?:y|ies|ied)|replicat\w*)\b[^.\n]{0,60}?\b(?<mult1>\d+|[a-z]+)[\s-]*(?:fold|x)\b|\b(?<mult2>\d+|[a-z]+)[\s-]*(?:fold|x)\b[^.\n]{0,60}?\b(?:duplicat\w*|multipl\w*|clon\w*|cop(?:y|ies|ied)|replicat\w*)\b|\b(?:duplicat\w*|multipl\w*|clon\w*|cop(?:y|ies|ied)|replicat\w*)\b[^.\n]{0,80}?\binto\b[^.\n]{0,30}?\b(?<mult3>\d+|[a-z]+)\b[^.\n]{0,30}?\b(?:copies|copy|duplicates?|clones?|replicas?|bundles?|stacks?|packs?|sets?|pieces?|identical)\b/i;
function guardDuplicationMath(data, panel, recentLogText){
  if(!data || !panel || !panel.categories || !recentLogText) return data;
  // Scoped to whichever single message (log line) actually contains the multiplier phrase,
  // not a fixed character radius — a narrator paragraph describing a duplication easily runs
  // several hundred characters, so a small fixed window risked missing the item name entirely.
  const lines = String(recentLogText).split('\n');
  const matchLine = lines.find(l => DUP_MULTIPLIER_RE.test(l));
  if(!matchLine) return data;
  // BUG FIX (loophole): this used to fire off ANY line matching the trigger words, including
  // pure scene-setting/NPC narration that never actually happened to the player at all — "an
  // enchanted press duplicates coins into ten identical stacks for wealthy patrons" would
  // silently multiply the PLAYER's own gold, just because "gold" happened to be nearby, even
  // though the line was describing something else's mechanic, not an effect applied to the
  // player. This engine consistently narrates the player character in second person ("you"),
  // so requiring that here is a cheap, reliable way to filter out third-person/ambient text
  // without needing a full grounding rewrite. Genuine "I use my Tenfold Duplication Technique"
  // player lines and "You watch your kunai split into ten identical copies" narration both
  // still pass this fine.
  if(!/\byou(?:r|rself)?\b/i.test(matchLine)) return data;
  const m = DUP_MULTIPLIER_RE.exec(matchLine);
  const g = m.groups || {};
  const mult = wordOrDigitToNumber(g.mult1 || g.mult2 || g.mult3);
  if(!mult || mult < 2) return data;
  // BUG FIX: this used to scope to the whole matched LINE, so a single sentence naming several
  // items near the duplication phrase ("I duplicate my kunai — there's still a chest with 900
  // gold bricks nearby") could multiply all of them, not just the one the ability was actually
  // used on. Tightened to a character window around the trigger match itself (padding beyond
  // the regex's own 60-char verb-to-multiplier gap, enough to usually catch the target item's
  // name without also catching an unrelated item mentioned elsewhere in a long narration line).
  const winStart = Math.max(0, m.index - 80);
  const winEnd = Math.min(matchLine.length, m.index + m[0].length + 80);
  const windowText = matchLine.slice(winStart, winEnd).toLowerCase();
  if(!data.categories) data.categories = {};

  // BUG FIX (loophole): this used to apply the multiply to EVERY item/currency stat whose
  // anchor word happened to appear in the trigger window, with no limit — so a single trigger
  // could multiply several unrelated things at once (worst case: two items that happen to
  // share an exact name, a pre-existing duplicate-entry situation, would BOTH get multiplied
  // by the same trigger). Pre-scanning for how many distinct things the anchor actually
  // matches lets an ambiguous case be refused outright — same "don't guess" principle as every
  // other guard here — instead of silently picking all of them.
  let matchedCurrencyCount = 0, matchedListCount = 0;
  for(const [scanCatName, scanCat] of Object.entries(panel.categories)){
    if(scanCat && scanCat.type === 'kv'){
      const scanIsCurrency = FINANCE_CATEGORY_RE.test(scanCatName);
      for(const k of Object.keys(scanCat.data || {})){
        if(!scanIsCurrency && !CURRENCY_NAME_RE.test(k)) continue;
        const anchor = k.toLowerCase();
        if(anchor.length >= 3 && windowText.includes(anchor)) matchedCurrencyCount++;
      }
    } else if(scanCat && scanCat.type === 'list'){
      for(const entry of (scanCat.data || [])){
        const parsed = splitItemEntry(entry);
        if(parsed.qty == null || isNaN(parsed.qty)) continue;
        const nameWords = parsed.name.toLowerCase().split(/\s+/).filter(Boolean);
        if(!nameWords.length) continue;
        const anchor = nameWords.reduce((a,b)=> b.length>a.length ? b : a, '');
        if(anchor && !STOPWORD_ANCHORS.has(anchor) && windowText.includes(anchor)) matchedListCount++;
      }
    }
  }
  if(matchedCurrencyCount > 1) console.warn(`[duplication math guard] skipped currency correction — ${matchedCurrencyCount} different currency stats all matched this trigger's window; target is ambiguous, refusing to guess`);
  if(matchedListCount > 1) console.warn(`[duplication math guard] skipped inventory correction — ${matchedListCount} different items all matched this trigger's window; target is ambiguous, refusing to guess`);

  for(const [catName, existingCat] of Object.entries(panel.categories)){
    // ---------- currency (kv) branch ----------
    // Mirrors the list-category branch below, computed directly instead of relying on the
    // background model to restate the exact multiplied total in its own narration. Without
    // this, a currency duplication ("10 fold duplication technique on my Gold") had no code
    // computing its result at all — it depended entirely on the model getting the math right
    // AND happening to state the new total in text, which guardCurrencyIncreases (added
    // separately) would otherwise require as grounding. Injecting the exact value here
    // satisfies that requirement the same deterministic way list items already get it.
    if(existingCat && existingCat.type === 'kv'){
      const catIsCurrency = FINANCE_CATEGORY_RE.test(catName);
      for(const [k, rawVal] of Object.entries(existingCat.data || {})){
        if(!catIsCurrency && !CURRENCY_NAME_RE.test(k)) continue; // only currency-looking kv stats
        const oldNum = parseFloat(String(rawVal).replace(/,/g,''));
        if(isNaN(oldNum)) continue;
        const anchor = k.toLowerCase();
        if(anchor.length < 3 || !windowText.includes(anchor)) continue;
        if(matchedCurrencyCount > 1) continue; // ambiguous target — already warned above, skip silently per-key
        const expected = oldNum * mult;
        if(oldNum === expected) continue;
        const catUpdate = data.categories[catName] || (data.categories[catName] = {});
        if(!catUpdate.kv || typeof catUpdate.kv !== 'object') catUpdate.kv = {};
        const proposedRaw = catUpdate.kv[k];
        const proposedNum = proposedRaw != null ? parseFloat(String(proposedRaw).replace(/,/g,'')) : null;
        if(proposedNum !== expected){
          console.warn(`[duplication math guard] ${proposedRaw==null?'injected missing':'corrected'} ${catName}.${k} -> exact ${expected} (${oldNum} x ${mult})`);
          catUpdate.kv[k] = String(expected);
        }
      }
      continue;
    }
    // ---------- inventory (list) branch ----------
    if(!existingCat || existingCat.type !== 'list') continue;
    for(const entry of existingCat.data){
      const parsed = splitItemEntry(entry);
      if(parsed.qty == null || isNaN(parsed.qty)) continue;
      // Anchor on the item name's single longest word (its most specific noun, e.g. "tags"/
      // "poison"/"bombs") rather than any short word — cuts down on two different stackable
      // items both matching on a generic word like "pack" or "vial".
      const nameWords = parsed.name.toLowerCase().split(/\s+/).filter(Boolean);
      if(!nameWords.length) continue;
      const anchor = nameWords.reduce((a,b)=> b.length>a.length ? b : a, '');
      // BUG FIX: this used to skip any item whose longest word was <=3 characters, which
      // silently excluded short-named items ("Bow", "Axe") from ever getting the duplication
      // correction at all. A stopword check (shared with extractNumbersNearItemLabel above) is
      // the actual thing worth guarding against — a short but real item name is fine to anchor on.
      if(!anchor || STOPWORD_ANCHORS.has(anchor) || !windowText.includes(anchor)) continue;
      if(matchedListCount > 1) continue; // ambiguous target — already warned above, skip silently per-item
      const expected = parsed.qty * mult;
      if(parsed.qty === expected) continue; // sheet already reflects this multiply — nothing to do

      const catUpdate = data.categories[catName] || (data.categories[catName] = {});
      const already = Array.isArray(catUpdate.list_add) && catUpdate.list_add.find(e => itemNameKey(e) === itemNameKey(entry));
      if(already){
        // The model DID propose something for this item this turn — just correct its number.
        const p = splitItemEntry(already);
        if(p.qty !== expected){
          console.warn(`[duplication math guard] corrected "${itemNameKey(entry)}" from proposed ${p.qty} to exact ${expected} (${parsed.qty} x ${mult})`);
          catUpdate.list_add = catUpdate.list_add.map(e => e===already ? rebuildItemEntry(expected, p.name, p.status!==null?p.status:parsed.status) : e);
        }
      } else {
        // The model proposed nothing for this item at all — inject the correction directly
        // rather than waiting for some future pass to notice it.
        if(!Array.isArray(catUpdate.list_remove)) catUpdate.list_remove = [];
        if(!Array.isArray(catUpdate.list_add)) catUpdate.list_add = [];
        catUpdate.list_remove.push(entry);
        catUpdate.list_add.push(rebuildItemEntry(expected, parsed.name, parsed.status));
        console.warn(`[duplication math guard] injected missing "${itemNameKey(entry)}" update -> exact ${expected} (${parsed.qty} x ${mult}) — background model didn't propose an Inventory change for it this turn`);
      }
    }
  }
  return data;
}

// ---------- ungraduated-ability backstop ----------
// ---------- hard code-level guard: the backstop for the exact bypass this hard-limit rule
// addition exists to prevent. guardSkillGraduation (above) stops a still-learning skill from
// being ADDED to "Skills & Abilities" early; listedAbilityNames (above) stops the PLAYER's own
// message from using an ungraduated skill's name to wave through an inventory guard. Neither of
// those catches the background model simply narrating an ungraduated ability succeeding on its
// own — e.g. the log describes a 14%-learned Duplication technique multiplying an item, and the
// model proposes the resulting Inventory change directly, with nothing in the player's message
// to gate against. This is that missing check: scan the recent log for a still-learning (<100%)
// ability's name sitting near a generic-effect verb (duplicate/create/multiply/transmute/
// summon/conjure/clone/copy/replicate/manifest — the same category of effect the hard-limit
// rule calls out as NOT resource-limited once actually graduated), and if found, strip any
// proposed Inventory list_add/list_remove for an item named in that same line — reverting it to
// whatever the sheet already had. This mirrors guardDuplicationMath's line-scoped, anchor-word
// matching, but instead of correcting the resulting number, it refuses the change outright,
// since an ungraduated ability isn't supposed to reliably produce a result at all yet.
const GENERIC_EFFECT_VERB_RE = /\b(duplicat\w*|creat\w*|multipl\w*|transmut\w*|summon\w*|conjur\w*|clon\w*|cop(?:y|ies|ied)|replicat\w*|manifest\w*)\b/i;
function guardUngraduatedAbilityInventory(data, panel, recentLogText){
  if(!data || !data.categories || !panel || !panel.categories || !recentLogText) return data;
  const learningKey = findExistingKey(panel.categories, 'Learning');
  const learningCat = learningKey ? panel.categories[learningKey] : null;
  if(!learningCat || learningCat.type !== 'kv') return data;
  const inProgressNames = [];
  for(const [k,v] of Object.entries(learningCat.data || {})){
    const n = parseInt(String(v).trim(), 10);
    if(!isNaN(n) && n < 100){
      const norm = normalizeSkillLabel(k);
      if(norm.length > 3) inProgressNames.push(norm);
    }
  }
  if(!inProgressNames.length) return data; // nothing still learning — nothing for this guard to do

  const lines = String(recentLogText).split('\n');
  const offendingLines = lines.filter(l=>{
    if(!GENERIC_EFFECT_VERB_RE.test(l)) return false;
    const norm = normalizeSkillLabel(l);
    return inProgressNames.some(n => norm.includes(n));
  });
  if(!offendingLines.length) return data;

  for(const [catName, catUpdate] of Object.entries(data.categories)){
    if(!/^inventory/i.test(catName.trim())) continue; // scoped to Inventory — what the hard-limit line specifically calls out
    const existingCat = panel.categories[findExistingKey(panel.categories, catName) || catName];
    if(!existingCat || existingCat.type !== 'list') continue;
    for(const field of ['list_add','list_remove']){
      if(!Array.isArray(catUpdate[field])) continue;
      catUpdate[field] = catUpdate[field].filter(entry=>{
        const words = [...itemWordSet(splitItemEntry(entry).name)].filter(w=>w.length>3);
        const hit = offendingLines.some(l=>{
          const lw = l.toLowerCase();
          return words.some(w => lw.includes(w));
        });
        if(hit){
          console.warn(`[ungraduated ability guard] blocked Inventory ${field} "${entry}" — tied to a still-learning (<100%) ability, which doesn't get reliable/unrestricted effect until it graduates into Skills & Abilities`);
          return false;
        }
        return true;
      });
      if(catUpdate[field].length === 0) delete catUpdate[field];
    }
  }
  return data;
}

// ---------- equip/status guard ----------
// ---------- hard code-level guard: an item's STATUS suffix (equipped/worn/holstered/broken/
// poisoned/sharpened/etc.) can only change if the player's own last message actually shows
// them doing something to it — putting it on, taking it off, wielding it, stowing it, dipping
// it in something, sharpening it, and so on. This is the same "delete the old text, add
// corrected text" pattern the sheet already uses for fixing a stale Milestones/Scheduled
// Events entry, so it needs the exact same protection: an unconfirmed list_remove+list_add
// pair on the same item is a silent rewrite, not a real event. Quantity-only changes are
// handled by guardStackableItems above and never reach this guard.
const ITEM_STATE_TRIGGER_RE = /\b(i\s*equip|i\s*wear(?:ing)?|i\s*wore|i\s*put(?:s|ting)?\s*on|i\s*don(?:ned|ning)?\b|i\s*strap(?:ped|ping)?|i\s*buckl(?:e|ed|ing)|i\s*holster(?:ed|ing)?|i\s*sheath(?:e|ed|ing)?|i\s*unsheath(?:e|ed|ing)?|i\s*wield(?:ed|ing)?|i\s*hold(?:ing)?|i\s*grip(?:ped|ping)?|i\s*unequip|i\s*take(?:s)?\s*off|i\s*took\s*off|i\s*remov(?:e|ed|ing)|i\s*stow(?:ed|ing)?|i\s*draw|i\s*drew|i\s*pull(?:s|ed|ing)?\s*out|i\s*slip(?:s|ped|ping)?\s*on|i\s*fasten(?:ed|ing)?|i\s*dip(?:s|ped|ping)?|i\s*coat(?:s|ed|ing)?|i\s*smear(?:s|ed|ing)?|i\s*soak(?:s|ed|ing)?|i\s*appl(?:y|ies|ied|ying)|i\s*poison(?:s|ed|ing)?|i\s*envenom(?:s|ed|ing)?|i\s*sharpen(?:s|ed|ing)?|i\s*hone(?:s|d|ing)?|i\s*dull(?:s|ed|ing)?|i\s*break(?:s|ing)?|i\s*broke|i\s*shatter(?:s|ed|ing)?|i\s*snap(?:s|ped|ping)?|i\s*burn(?:s|ed|t|ing)?|i\s*scorch(?:es|ed|ing)?|i\s*singe(?:s|d|ing)?|i\s*char(?:s|red|ring)?|i\s*rust(?:s|ed|ing)?|i\s*bless(?:es|ed|ing)?|i\s*curs(?:e|es|ed|ing)?|i\s*enchant(?:s|ed|ing)?|i\s*imbu(?:e|es|ed|ing)|i\s*seal(?:s|ed|ing)?|i\s*wet(?:s|ted|ting)?|i\s*stain(?:s|ed|ing)?|i\s*dy(?:e|es|ed|eing)|i\s*wrap(?:s|ped|ping)?|i\s*bind(?:s|ing)?|i\s*bound|i\s*chip(?:s|ped|ping)?|i\s*crack(?:s|ed|ing)?|i\s*repair(?:s|ed|ing)?|i\s*fix(?:es|ed|ing)?|i\s*clean(?:s|ed|ing)?|i\s*wash(?:es|ed|ing)?|i\s*oil(?:s|ed|ing)?|i\s*load(?:s|ed|ing)?|i\s*unload(?:s|ed|ing)?)\b/i;
// BUG FIX: every phrase above puts "I" directly in front of the verb doing the state change
// ("I poison it", "I dip it", "I apply it") — but an extremely common, equally valid way to
// describe the exact same action is "I USED <the substance> ON <the item>" ("I used paralysis
// poison on my kunai"), where "poison"/"acid"/etc. is the OBJECT being applied, not the verb,
// and "used" is the actual verb. ITEM_USE_TRIGGER_RE already recognizes "i used" — it's just
// never been treated as a valid confirmation for a STATUS change, only for consuming/depleting
// the item being used. Recognizing it here too means "I used X on/to/onto my Y" now confirms a
// status change on Y exactly like "I dip my Y in X" already did.
const ITEM_USE_ON_OTHER_RE = /\b(i\s*us(?:e|ed|ing))\b.*\b(on|onto|to|over|against)\b/i;
function guardInventoryEquipStatus(data, panel, playerText){
  if(!data || !data.categories) return data;
  // BUG FIX: this used to compute ONE global boolean from the player's whole message and, if
  // true, return the data untouched — skipping per-item checking entirely, for every category.
  // "I put on my boots" would green-light a status rewrite on a completely unrelated item in
  // the same turn. Confirmation is now checked per-item inside the loop, via itemActionConfirmed
  // (requires the trigger phrase and a distinctive word from THIS item's name in the same
  // sentence/clause of the player's message).
  for(const [catName, catUpdate] of Object.entries(data.categories)){
    if(!catUpdate || !Array.isArray(catUpdate.list_add) || !Array.isArray(catUpdate.list_remove)) continue;
    const existingCat = panel && panel.categories ? panel.categories[findExistingKey(panel.categories, catName) || catName] : null;
    if(!existingCat || existingCat.type !== 'list') continue;
    catUpdate.list_add = catUpdate.list_add.filter(entry=>{
      const parsed = splitItemEntry(entry);
      if(parsed.qty != null) return true; // a quantity entry — guardStackableItems already vetted it
      const matchRemoved = catUpdate.list_remove.find(r=>{
        const rp = splitItemEntry(r);
        return rp.qty == null && rp.name.toLowerCase() === parsed.name.toLowerCase();
      });
      if(!matchRemoved) return true; // no matching removal this turn — a genuinely new item, allow
      const confirmed = itemStatusConfirmed(playerText, parsed.name, panel);
      if(confirmed) return true;
      console.warn(`[inventory status guard] blocked "${entry}" — status change on an existing item with no confirming action phrase naming this item in player's last message`);
      catUpdate.list_remove = catUpdate.list_remove.filter(r => r !== matchRemoved); // put the old entry back
      return false;
    });
    if(catUpdate.list_add.length === 0) delete catUpdate.list_add;
    if(catUpdate.list_remove.length === 0) delete catUpdate.list_remove;
  }
  return data;
}

// ---------- rename-bypass guard ----------
// ---------- hard code-level guard, closing the obvious way around the guard above: instead of
// correctly pairing list_remove:["Blade"] + list_add:["Blade — Poisoned"], a model could just
// invent a wholly different name — list_add:["Poisoned Blade"] with no matching list_remove at
// all — which never matches anything in guardInventoryEquipStatus (different text entirely) and
// would leave BOTH "Blade" and "Poisoned Blade" sitting on the sheet as if they were two
// different objects. This scans every new item name for word-overlap with something already on
// the sheet (e.g. "poisoned blade" fully contains the existing "blade") with no matching
// removal this turn, and treats that as the same kind of unconfirmed status rewrite: blocked
// outright with no action phrase, or — if the player's message does confirm it — auto-paired
// with the old entry's removal so a rename can never leave a duplicate behind, whether or not
// the model bothered to pair it correctly itself.
function itemWordSet(name){
  return new Set(String(name).toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(w=>w.length>2));
}
function isFuzzyItemMatch(nameA, nameB){
  const wa = itemWordSet(nameA), wb = itemWordSet(nameB);
  if(!wa.size || !wb.size) return false;
  const [small, big] = wa.size <= wb.size ? [wa,wb] : [wb,wa];
  for(const w of small) if(!big.has(w)) return false; // every word of the shorter name appears in the longer one
  return true;
}
// BUG FIX (quantity-smuggled-through-rename loophole): a fuzzy rename match only proves object
// IDENTITY ("poisoned kunai" is the same object as "kunai") — it says nothing about whether an
// accompanying quantity change on that same entry is real. Because guardStackableItems (which
// runs before this) only recognizes an item by EXACT name, a proposed entry like "300 Kunai —
// Poisoned" never matches the sheet's "3 Kunai" there at all — it falls through as a "brand-new
// item" with zero quantity grounding applied. It then lands here, where a single confirmed
// status phrase ("I poison my kunai") was enough to auto-pair the rename and wave the whole
// entry through — quantity included, no matter how inflated. That let any status/rename action
// double as a free, ungrounded quantity grant riding shotgun on the same turn. This is the exact
// mirror image of the smuggling bug already closed inside guardStackableItems (a status change
// riding along on an otherwise-legitimate quantity update) — just never closed for this
// direction. Fix: once identity is confirmed via the fuzzy match, re-run the SAME
// decrease/increase grounding rules guardStackableItems applies for exact-name matches before
// trusting any quantity change that came along with the rename; if it doesn't hold up, keep the
// old quantity and only let the confirmed rename/status portion through.
function guardInventoryRenameBypass(data, panel, playerText, recentLogText){
  if(!data || !data.categories) return data;
  // BUG FIX (bugs 2+3 combined): these used to be ONE global boolean each, checked anywhere in
  // the player's whole message — so if a genuinely new, distinct item happened to fuzzy-match
  // something already owned (isFuzzyItemMatch treats any strict word-subset as the same item),
  // ANY confirming phrase anywhere in the turn would auto-pair a list_remove for the old item,
  // silently deleting it even though nothing in the story said it was renamed or lost. Both are
  // now computed per fuzzyOld/newName pair below via itemActionConfirmed, which requires the
  // trigger phrase and a word from the specific item's name to share a sentence/clause.
  const groundingHaystack = String(recentLogText || '') + ' ' + (playerText || '');
  for(const [catName, catUpdate] of Object.entries(data.categories)){
    if(!catUpdate || !Array.isArray(catUpdate.list_add)) continue;
    const existingCat = panel && panel.categories ? panel.categories[findExistingKey(panel.categories, catName) || catName] : null;
    if(!existingCat || existingCat.type !== 'list') continue;
    if(!Array.isArray(catUpdate.list_remove)) catUpdate.list_remove = [];
    const keptAdd = [];
    for(const entry of catUpdate.list_add){
      const parsedNew = splitItemEntry(entry);
      const newName = parsedNew.name;
      const alreadyPaired = catUpdate.list_remove.some(r => itemNameKey(r) === itemNameKey(entry));
      if(alreadyPaired){ keptAdd.push(entry); continue; } // exact-name rewrite — guardInventoryEquipStatus's job
      const fuzzyOld = existingCat.data.find(old => itemNameKey(old) !== itemNameKey(entry) && isFuzzyItemMatch(itemNameKey(old), newName));
      if(!fuzzyOld){ keptAdd.push(entry); continue; } // unrelated to anything already on the sheet — genuinely new
      const playerConfirmed = itemActionConfirmed(playerText, fuzzyOld, ITEM_STATE_TRIGGER_RE, panel)
        || itemActionConfirmed(playerText, fuzzyOld, ITEM_USE_ON_OTHER_RE, panel)
        || itemActionConfirmed(playerText, newName, ITEM_STATE_TRIGGER_RE, panel)
        || itemActionConfirmed(playerText, newName, ITEM_USE_ON_OTHER_RE, panel);
      if(!playerConfirmed){
        console.warn(`[inventory rename-bypass guard] blocked "${entry}" — looks like an unpaired rename/elaboration of existing "${fuzzyOld}" with no confirming action phrase naming this item in player's last message`);
        continue; // drop it — the existing entry stays exactly as it was
      }
      // Identity is confirmed — now separately validate any quantity riding along with it.
      const oldParsed = splitItemEntry(fuzzyOld);
      let finalEntry = entry;
      if(parsedNew.qty != null && oldParsed.qty != null && parsedNew.qty !== oldParsed.qty){
        const label = itemNameKey(fuzzyOld);
        let qty = parsedNew.qty;
        const playerConfirmedUse = itemActionConfirmed(playerText, fuzzyOld, ITEM_USE_TRIGGER_RE, panel)
          || itemActionConfirmed(playerText, newName, ITEM_USE_TRIGGER_RE, panel);
        if(qty < oldParsed.qty && !playerConfirmedUse){
          console.warn(`[inventory rename-bypass guard] blocked quantity decrease riding along with rename of "${fuzzyOld}" (${oldParsed.qty} -> ${qty}) — no use/spend phrase naming this item in player's last message; keeping old quantity`);
          qty = oldParsed.qty;
        } else if(qty > oldParsed.qty){
          const gainDelta = qty - oldParsed.qty;
          const nearbyNumbers = extractNumbersNearItemLabel(label, groundingHaystack);
          const grounded = nearbyNumbers.includes(Math.round(qty))
            || nearbyNumbers.includes(Math.round(gainDelta))
            || subsetSumMatches(gainDelta, nearbyNumbers);
          if(!grounded){
            console.warn(`[inventory rename-bypass guard] blocked quantity increase riding along with rename of "${fuzzyOld}" (${oldParsed.qty} -> ${qty}) — no number near "${label}" in the recent log adds up to that gain or matches the new total; keeping old quantity`);
            qty = oldParsed.qty;
          }
        }
        if(qty < 0) qty = 0;
        finalEntry = rebuildItemEntry(qty, parsedNew.name, parsedNew.status);
      }
      console.warn(`[inventory rename-bypass guard] "${entry}" was an unpaired rename of "${fuzzyOld}" — auto-pairing its removal so the sheet doesn't end up with both.`);
      if(!catUpdate.list_remove.includes(fuzzyOld)) catUpdate.list_remove.push(fuzzyOld);
      keptAdd.push(finalEntry);
    }
    catUpdate.list_add = keptAdd;
    if(catUpdate.list_add.length === 0) delete catUpdate.list_add;
    if(catUpdate.list_remove.length === 0) delete catUpdate.list_remove;
  }
  return data;
}

// ---------- discard guard ----------
// ---------- hard code-level guard: an inventory item can only be permanently DELETED from the
// sheet — a list_remove with no matching list_add for that same item, i.e. the object is gone
// for good, not just its status or count changing — if the player's own last message actually
// confirms getting rid of it. Deliberately does NOT include "remove" or "take off" — per the
// story's own convention those mean UNEQUIPPING (the item stays in Inventory, just no longer
// worn/held; guardInventoryEquipStatus above owns that case), never discarding. Only an actual
// discard phrase — threw (out/away), left behind, dropped, tossed, discarded, gave/sold/traded/
// gifted/donated away, abandoned, lost, or destroyed — clears an item off the sheet entirely. Every other
// list_remove (a status rewrite paired with its list_add, a quantity correction) is already
// handled by the guards above and never reaches this one, since it only ever looks at
// removals with NO matching addition.
//
// Deliberately removed: a generic "threw/tossed it out of my inventory/backpack/bag/pack/
// travel pack" clause used to also count as a discard trigger on its own, with no requirement
// that the message actually name the specific item — so any mention of emptying/tossing
// things out of the inventory in general could authorize deleting whatever list_remove the
// background model proposed, even something unrelated to what the player meant. Discarding
// now only fires from the player-confirmed action phrases below, which is intended to line up
// with "only delete the specific thing I actually asked to get rid of."
const DISCARD_TRIGGER_RE = /\b(i\s*threw(?:\s*(?:out|away))?|i\s*throw(?:s|ing)?\s*(?:out|away)|i\s*left(?:\s*behind)?|i\s*leave(?:s)?(?:\s*behind)?|i\s*dropp?(?:ed|ing)?|i\s*toss(?:es|ed|ing)?(?:\s*(?:out|away))?|i\s*discard(?:s|ed|ing)?|i\s*abandon(?:s|ed|ing)?|i\s*ditch(?:es|ed|ing)?|i\s*bur(?:y|ies|ied|ying)|i\s*giv(?:e|es)\s*away|i\s*gave\s*away|i\s*gift(?:s|ed|ing)?|i\s*donat(?:e|es|ed|ing)|i\s*sell|i\s*sold|i\s*trad(?:e|es|ed|ing)\s*away|i\s*exchang(?:e|es|ed|ing)(?:\s*away)?|i\s*swap(?:s|ped|ping)?\s*away|i\s*los[et]|i\s*destroy(?:s|ed|ing)?|i\s*get(?:s)?\s*rid\s*of|i\s*got\s*rid\s*of)\b/i;
function guardInventoryDiscard(data, panel, playerText){
  if(!data || !data.categories) return data;
  // BUG FIX: this used to be one global boolean, so any discard phrase anywhere in the player's
  // message authorized deleting whatever list_remove the background model proposed for ANY
  // item — checked per-item below instead, requiring the discard phrase and a word from this
  // specific item's name in the same sentence/clause.
  for(const [catName, catUpdate] of Object.entries(data.categories)){
    if(!catUpdate || !Array.isArray(catUpdate.list_remove)) continue;
    const existingCat = panel && panel.categories ? panel.categories[findExistingKey(panel.categories, catName) || catName] : null;
    if(!existingCat || existingCat.type !== 'list') continue;
    const addNames = new Set((catUpdate.list_add || []).map(a => itemNameKey(a)));
    catUpdate.list_remove = catUpdate.list_remove.filter(entry=>{
      if(addNames.has(itemNameKey(entry))) return true; // paired with an add — a rewrite, not a discard; another guard's job
      const parsed = splitItemEntry(entry);
      if(itemActionConfirmed(playerText, parsed.name, DISCARD_TRIGGER_RE, panel)) return true;
      console.warn(`[inventory discard guard] blocked permanently removing "${entry}" — no discard phrase ("I threw/left/dropped/discarded/sold/...") naming this item in player's last message`);
      return false;
    });
    if(catUpdate.list_remove.length === 0) delete catUpdate.list_remove;
  }
  return data;
}

// ============================================================================================
// #region TIMELINE-EVENTS-MODULE  ("Current Day" + "Scheduled Events")
// ============================================================================================
// Everything to do with the in-story calendar lives in this one module, split into 8 parts.
// Search for the tag in [] to jump straight to a part (e.g. ctrl/cmd-F "TL-4").
//
//   [TL-1] Time-skip detection    — how many days does the recent log actually support?
//   [TL-2] "Day N — desc" parsing — the one shared parser every part below depends on
//   [TL-3] Narration verification — was a claimed event resolution actually shown happening?
//   [TL-4] GUARD: Current Day     — blocks/caps illegitimate advances to "Current Day"
//   [TL-5] GUARD: Scheduled Events — blocks illegitimate add/remove on the events list
//   [TL-6] Rendering              — dims a past-due event chip on the full character sheet
//   [TL-7] Manual add UI          — the "system bro" tile: the ONLY legitimate way to add
//                                    a new Scheduled Events entry (never the AI narrator)
//   [TL-8] Lore seeding           — picks up "Day N — ..." lines the player wrote in a
//                                    world's own setup text, once, when the world is created
//
// Design in one sentence: the AI narrator is trusted to read this calendar and narrate a due
// event happening, but never to write to it — every write path here is deterministic,
// non-AI code, and every AI-proposed change gets run through [TL-4]/[TL-5] before it's ever
// allowed to touch the saved sheet.
// ============================================================================================

// ================= TIMELINE — DAY ADVANCEMENT & TIME-SKIPS =================
// "Current Day" can only move forward, only on a grounded time-skip, and never past a
// still-upcoming Scheduled Events day in a single jump. TL-1 through TL-4 below.

// ---------- [TL-1] TIME-SKIP DETECTION ----------
// ---------- hard code-level guard: "Current Day" can only move forward, and only on a turn
// where the log actually describes time passing (overnight, a stated number of days, a week,
// etc.) — same reasoning as the currency/skill guards above: without this the background
// model nudges the day counter up just because another turn happened, which is what made it
// race ahead of the real story. Checks the whole recent log (not just the player's message),
// since either side describing a time-skip counts per the sheet's own rules.
//
// A boolean "did *some* skip phrase appear anywhere in the window" check can't tell "one
// night" from "fifty days" apart — it only proves *a* skip happened, not how big one. That gap
// is what let the day jump from 13/14 to 64 in a single turn. So on top of the forward-only
// check, the size of the jump is capped to what the matched skip phrase(s) in the log can
// actually account for (summed, since the window covers several messages). A jump bigger than
// the text supports is blocked, not just an unexplained jump.
// Extended through twenty (not just ten) so spelled-out "Day Twelve", "Day Nineteen", etc. —
// realistic day numbers for a story arc, not just small time-skip counts — actually parse
// instead of silently failing every "Day N" regex that relies on this map (see parseDayEntry).
const WORD_NUM_MAP = {one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,
  eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20};
// Tens words, used both standalone ("Day Thirty") and combined with a ones word
// ("Day Thirty Five" / "Day Thirty-Five") — a story arc can easily run past day twenty, and a
// spelled-out day number this map can't cover used to make that entry invisible to every guard
// (parseDayEntry returning null means NO protection at all, not degraded protection — see
// parseDayEntry below), so this needs to actually cover realistic day counts, not just small
// time-skip phrases.
const TENS_WORD_MAP = {twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90};
function skipPhraseToDays(numStr, unitStr){
  const ns = String(numStr).toLowerCase().trim();
  let n;
  if(/^\d+$/.test(ns)) n = parseInt(ns, 10);
  else if(WORD_NUM_MAP[ns] != null) n = WORD_NUM_MAP[ns];
  else if(/^a\s+couple/.test(ns)) n = 2;
  else if(/^a\s+few/.test(ns)) n = 3;
  else if(ns === 'several') n = 4;
  else n = 1;
  return /week/i.test(unitStr) ? n * 7 : n;
}
const VARIABLE_SKIP_RE = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|a\s+couple(?:\s+of)?|a\s+few|several)\s+(nights?|days?|weeks?)\b/gi;
const FIXED_SKIP_RE = /\b(overnight|(?:a|the|that|this|one)\s+night(?:'s\s+(?:rest|sleep))?|night'?s\s+(?:rest|sleep)|(?:the\s+)?next\s+morning|til{1,2}\s+morning|until\s+morning|(?:the\s+)?next\s+day|a\s+week)\b/gi;
const CURRENT_DAY_KEY_RE = /^current\s*day$/i;
// A bare "N days" match can't tell a REAL elapsed time-skip ("we traveled for three days")
// apart from a COUNTDOWN reference to something that hasn't happened yet ("50 days remaining
// to the chunin exam", "in 12 days the exam starts"). Without this check, typing a countdown
// line inflated the allowed skip by the full countdown number and let Current Day silently
// jump that far with no warning (which then also silently satisfied guardScheduledEvents'
// "due" check, so removing the now-"overdue" event went through unwarned too). Look at a small
// window of text immediately before/after each numeric match for a countdown cue and exclude
// that match from the allowed-skip total if found.
// Anchored to the immediate edge of the window (\s*$ / ^\s*) so a cue separated from the
// number by an extra word or two — "in about 50 days", "50 days still remaining" — used to
// slip past both regexes and get wrongly counted as a real elapsed skip. Widened windows plus
// an allowance for up to two short filler words between the cue and the number closes that
// gap while still requiring the cue to genuinely be attached to this specific number, not just
// present somewhere in a longer sentence.
const COUNTDOWN_BEFORE_RE = /\b(?:in|until|within|since|back|after)\b(?:\s+\w{1,10}){0,2}\s*$/i;
// AFTER-cues also cover "ago"/"earlier"/"prior" style mentions — these aren't countdowns
// either, but they're the same kind of false positive (a duration that ISN'T a live time-skip
// happening right now): a backstory reference ("it's been 12 days since the incident") or a
// flashback shouldn't inflate the allowed skip any more than a countdown should. This can't
// catch every non-skip mention of "N days" (e.g. a bare aside with no adjacent cue word at
// all) — that's an inherent limit of a text-window heuristic — but it closes the known gaps.
const COUNTDOWN_AFTER_RE = /^(?:\s*\w{1,10}){0,2}\s*(?:remain(?:ing|s)?|left|to\s+go|away|before|until|from\s+now|out|ago|earlier|prior|back\b)/i;
function isCountdownContext(text, matchStart, matchEnd){
  const before = text.slice(Math.max(0, matchStart - 24), matchStart);
  const after = text.slice(matchEnd, matchEnd + 28);
  return COUNTDOWN_BEFORE_RE.test(before) || COUNTDOWN_AFTER_RE.test(after);
}
// Sums every time-skip phrase found within a single line of text into a day count.
function skipDaysInLine(text){
  let total = 0;
  let m;
  VARIABLE_SKIP_RE.lastIndex = 0;
  while((m = VARIABLE_SKIP_RE.exec(text))){
    if(isCountdownContext(text, m.index, m.index + m[0].length)) continue;
    total += skipPhraseToDays(m[1], m[2]);
  }
  FIXED_SKIP_RE.lastIndex = 0;
  while((m = FIXED_SKIP_RE.exec(text))) total += /week/i.test(m[1]) ? 7 : 1;
  return total;
}
// Sums every time-skip phrase found in the window into a day count — the maximum jump the
// text can actually justify. Not a claim about the "true" story day count, just an upper bound.
//
// Works line-by-line (the window text is always speaker-prefixed lines like "Player: ..." /
// "Story: ...", from messageToLogLine) so it can catch a specific double-counting case: the
// player proposing a trip length ("let's travel 10 days") and the very next reply restating
// that SAME length while narrating it ("the journey takes 10 days") describe one 10-day trip,
// not two — the old whole-blob regex summed both into 20 allowed days. Only an exact-match,
// adjacent, opposite-speaker restatement is deduped this way; two genuinely separate skips of
// the same size elsewhere in the window still both count.
function maxAllowedDaySkip(text){
  text = String(text || '');
  const lines = text.split('\n');
  let total = 0;
  let prevSpeaker = null, prevAmount = 0;
  for(const line of lines){
    const sm = /^(Player|Story|System):\s*/.exec(line);
    const speaker = sm ? sm[1] : null;
    const body = sm ? line.slice(sm[0].length) : line;
    const amount = skipDaysInLine(body);
    if(amount > 0 && amount === prevAmount && speaker && prevSpeaker && speaker !== prevSpeaker){
      // Same-size skip restated by the other side of the exchange — already counted once.
      prevAmount = 0; prevSpeaker = speaker;
      continue;
    }
    total += amount;
    prevAmount = amount; prevSpeaker = speaker;
  }
  return total;
}
// Small in-chat ⚠️ notice for a blocked guard action — same visual language as
// showBackgroundWarning, but for a deliberate block rather than a request failure, so the
// player can actually see when something got stopped instead of it only showing in the console.
function showGuardWarning(worldId, message){
  console.warn(message);
  if(!els.log || state.chattingId !== worldId) return;
  const w = document.createElement('div'); w.className='warn';
  w.textContent = `⚠️ ${message}`;
  els.log.appendChild(w);
  els.log.scrollTop = els.log.scrollHeight;
}
// ---------- [TL-2] "DAY N — DESCRIPTION" PARSING (shared by everything below) ----------
// ---------- shared "Day N — description" parsing, used by every guard/helper that deals with
// dated list entries (Scheduled Events, and anything else formatted this way). Centralizing
// this closes two format gaps that used to be inconsistent across the individual regexes:
//  1. Separators: only em dash/colon/hyphen were recognized — an en dash (–, U+2013), which
//     looks identical to a hyphen at a glance and is exactly the kind of thing a model
//     sometimes emits instead of an em dash, broke every one of them. Now handled everywhere.
//  2. Spelled-out day numbers ("Day Twelve — ...") broke every regex here since they all
//     required \d+ — including earliestDueEvent, so a malformed entry like that would never
//     even auto-trigger. Reuses the same one/two/three... map the time-skip parser already
//     has (WORD_NUM_MAP, defined above).
// A separator is required (matching the "Day N — desc" shape entries are actually created in,
// e.g. addScheduledEvent below) — previously guardScheduledEvents' due-day check used a bare
// `/^day\s+(\d+)/i` with NO separator requirement at all, while every other guard required one;
// that inconsistency is removed by having all of them go through this single parser.
// Number token: digits, OR exactly one spelled-out word here — a greedy 2-word match would
// wrongly swallow the first word of the DESCRIPTION too whenever that word happened to look
// like a plausible second number-word (e.g. "Day Twelve Chunin Exam" could misparse "Twelve
// Chunin" as one compound number token). The tens+ones compound case ("forty two") is instead
// resolved afterward in parseDayEntry, where it can check the second word actually IS a valid
// ones-word before consuming it. Separator is OPTIONAL ("\s*[—–:-]?\s*" — was previously
// required): a model writing "Day 12 Chunin Exam" with a plain space instead of a dash used to
// parse as null and fall through every guard completely unprotected.
// A separator or at least one whitespace char is now REQUIRED between the number/word token
// and the description (was fully optional via `\s*(?:sep)?\s*`, with nothing forcing any gap
// between them at all). That let regex backtracking misparse a description-less entry like
// bare "Day 12" — with no dash and no trailing text — by shrinking the \d+ match down to just
// "1" so the leftover "2" could be swallowed as the description, silently returning {day:1,
// desc:"2"} for an entry that should never parse as valid (no description exists to swallow).
// Every legitimate entry already has either a dash or a space here, so this closes the gap
// with no effect on any well-formed "Day N — desc" / "Day N desc" entry.
const DAY_ENTRY_RE = /^day\s+(\d+|[a-z]+)(?:\s*[—–:-]\s*|\s+)(\S.*)$/i;
// Same fix as DAY_ENTRY_RE above, for the same reason: the gap between the ones-word and the
// description now has to be a real separator or whitespace, not optional — otherwise "Day
// Forty Two" with nothing further could backtrack ("Tw" + "o") into a bogus ones-word match.
const TENS_ONES_RE = /^([a-z]+)(?:\s*[—–:-]\s*|\s+)(\S.*)$/i;
function parseDayEntry(entry){
  const m = DAY_ENTRY_RE.exec(String(entry||'').trim());
  if(!m) return null;
  const numStr = m[1].toLowerCase();
  let day, desc = m[2];
  if(/^\d+$/.test(numStr)){
    day = parseInt(numStr, 10);
  } else if(TENS_WORD_MAP[numStr] != null){
    // Might be a compound like "forty two" / "forty-two" — only consume the next word as the
    // ones part if it's actually a valid ones-word (1-9); otherwise this is just "forty" on
    // its own and the next word belongs to the description, not the number.
    const m2 = TENS_ONES_RE.exec(desc);
    const onesStr = m2 ? m2[1].toLowerCase() : null;
    if(onesStr && WORD_NUM_MAP[onesStr] != null && WORD_NUM_MAP[onesStr] < 10){
      day = TENS_WORD_MAP[numStr] + WORD_NUM_MAP[onesStr];
      desc = m2[2];
    } else {
      day = TENS_WORD_MAP[numStr];
    }
  } else if(WORD_NUM_MAP[numStr] != null){
    day = WORD_NUM_MAP[numStr];
  } else {
    return null;
  }
  return { day, desc: (desc||'').trim() };
}
function scheduledEntryDesc(s){
  const parsed = parseDayEntry(s);
  return parsed ? parsed.desc : String(s);
}
// ---------- digit-PRESERVING normalization for matching two differently-worded list entries as
// "the same entry" (reworded punctuation/spacing/dash style). Deliberately keeps every digit
// intact — commas inside a number are stripped ("1,000" -> "1000") but the digits themselves
// never are. An earlier version of this kind of normalization stripped digits entirely, which
// let two entries differing ONLY in their number (a different scheduled-event day, a different
// currency amount, a different item quantity) collapse to the identical normalized string and
// match each other — see mergePanelUpdate's list_remove handling and guardScheduledEvents below
// for where this actually matters.
function normalizeEntryLabel(s){
  return String(s||'').toLowerCase()
    .replace(/[—–:-]/g, ' ')   // any dash/colon separator style normalizes the same way
    .replace(/,/g, '')          // commas inside a number ("1,000") aren't distinguishing
    .replace(/\s+/g, ' ')
    .trim();
}
// Generic connector/template words that shouldn't count as "meaningful" content when comparing
// two pieces of text for overlap — shared by mergePanelUpdate's near-duplicate check and
// eventNarratedInLog's narration check below (both need the same "does this text actually say
// something distinctive, or just common filler" judgment).
const STOPWORDS = new Set(['the','and','for','with','from','into','onto','that','this','their','your','his','her','its','our',
  'was','were','been','are','has','have','had','not','but','you','she','him','his','them','they',
  'learned','learns','learning','gained','gains','gaining','received','receives','receiving','purchased','purchases','purchasing',
  'acquired','acquires','acquiring','obtained','obtains','obtaining','found','finds','finding','unlocked','unlocks','unlocking',
  'discovered','discovers','discovering','earned','earns','earning','granted','grants','granting','given','gives','giving',
  'bought','buys','buying','took','takes','taking','got','gets','getting','new']);
// ---------- [TL-3] NARRATION VERIFICATION (was a claimed removal actually shown happening?) ----------
// ---------- hard code-level guard: a claimed "this event resolved" removal can't be trusted
// on its own. Both the day-cap (below) and guardScheduledEvents used to exclude/allow ANY
// entry the AI listed in list_remove without checking the removal was actually earned by real
// narration — which let a skip+fake-resolution combo defeat the cap entirely: propose "skip 12
// days" together with "resolve day-12 and day-20" in the same turn, with neither event ever
// actually narrated happening, and both guards waved it through since each only looked at
// whether a removal was PROPOSED, not whether the story text backs it up. This requires a
// meaningful share of the event's own description to actually appear in the recent log before
// a removal is treated as legitimate.
// keyWords() alone only filters by length (>2 chars), so common words like "the"/"for"/"was"
// still count as "meaningful" and can pad out a match. This strips STOPWORDS on top of that —
// only used here (and not inside keyWords itself) so the unrelated fuzzy-key-matching callers
// of keyWords() elsewhere aren't affected by a behavior change.
function meaningfulWords(s){
  const words = keyWords(s);
  for(const w of words) if(STOPWORDS.has(w)) words.delete(w);
  return words;
}
// Restricts a log window down to just the narrator's own lines (Story:/System:), and only the
// most recent slice of those — a claimed event resolution being "found" anywhere in a long
// window (an earlier foreshadowing mention, a plan being discussed, or the PLAYER'S own message
// merely asserting it happened) doesn't mean the story actually narrated it happening just now.
// Scales proportionally with however many narrator lines are actually present, rather than a
// fixed count: the normal per-turn pass (updatePanel) only ever hands this ~5 turns of log,
// where "the last few lines" is the right amount of recency. The rewind/regenerate resync path
// calls this same function with a much wider window (up to 60 messages) — a small fixed count
// there would miss a resolution that was genuinely narrated mid-window, well before the
// window's own tail end, and wrongly block a legitimate removal. A fixed 50% fraction (floor 2,
// ceiling 20) keeps the short window tight while still covering the right portion of a long one.
function recentNarrationText(logText){
  const lines = String(logText||'').split('\n').filter(l => /^(Story|System):\s*/.test(l));
  const count = Math.min(20, Math.max(2, Math.ceil(lines.length * 0.5)));
  return lines.slice(-count).join('\n');
}
function eventNarratedInLog(entryText, logText){
  const words = meaningfulWords(scheduledEntryDesc(entryText));
  if(!words.size) return true; // nothing meaningful to check against -- don't block on this
  const logWords = meaningfulWords(recentNarrationText(logText));
  let hits = 0;
  for(const w of words) if(logWords.has(w)) hits++;
  // Keyword overlap can't tell "the event happened" from "the event was merely mentioned or
  // discussed" (e.g. "everyone was buzzing about the exam" hits "exam" without the exam itself
  // occurring) — that's an inherent limit of a keyword heuristic. Raising the bar closes the
  // easiest version of that gap: short descriptions (<=2 significant words) still require
  // every word, but longer ones now require most of them (75%, up from 50%) rather than just
  // half, so a passing mention sharing only a couple of incidental words no longer qualifies.
  const needed = words.size <= 2 ? words.size : Math.ceil(words.size * 0.75);
  return hits >= needed;
}
// ---------- [TL-4] GUARD — "Current Day" advancement ----------
// allowBackward gates ONLY the negative-delta block, separately from isResync (which relaxes
// the skip-amount cap for a log window that can legitimately span many days at once — the
// periodic memory-cross-check pass needs that same relaxation, since memory accumulates day-log
// bullets across far more turns than a single update's recent-log window covers). The two used
// to be the same flag, which meant that periodic pass — NOT a real rewind, just an ordinary
// background sync that runs every 4 turns during normal play — could also move Current Day
// backward on nothing more than whatever text ended up in the memory log, e.g. a player line
// like "go back 10 days" getting echoed into a memory bullet. A real backward correction should
// only ever be possible from an ACTUAL rewind (a message genuinely deleted from the chat, via
// resyncMemoryAndPanel) — never from player-authored text alone, no matter which pass reads it.
function guardTimelineDay(data, panel, recentLogText, worldId, isResync, allowBackward){
  if(!data || !data.categories) return data;
  const allowedSkip = maxAllowedDaySkip(recentLogText);
  for(const [catName, catUpdate] of Object.entries(data.categories)){
    if(!catUpdate || !catUpdate.kv || typeof catUpdate.kv !== 'object') continue;
    for(const [k, v] of Object.entries(catUpdate.kv)){
      if(!CURRENT_DAY_KEY_RE.test(k)) continue;
      let newNum = parseInt(String(v).replace(/[^\d]/g,''), 10);
      if(isNaN(newNum)) continue;
      const existingCat = panel && panel.categories ? panel.categories[findExistingKey(panel.categories, catName) || catName] : null;
      const existingRaw = existingCat && existingCat.type==='kv' ? existingCat.data[findExistingKey(existingCat.data, k) || k] : null;
      const oldNum = existingRaw != null ? parseInt(String(existingRaw).replace(/[^\d]/g,''), 10) : null;
      if(oldNum == null || isNaN(oldNum)) continue;
      const delta = newNum - oldNum;
      let reason = null;
      if(delta < 0 && !allowBackward){
        reason = 'the day can never go backwards from typed/narrated text alone — only an actual rewind (deleting a message) can move it back';
      } else if(delta > 0){
        if(!isResync){
          if(allowedSkip === 0) reason = 'no time-skip phrase found in the recent log';
          else if(delta > allowedSkip) reason = `the recent log only supports a skip of about ${allowedSkip} day${allowedSkip===1?'':'s'}, not ${delta}`;
        } else if(delta > allowedSkip){
          // A rewind/regenerate resync legitimately needs to correct the day BACKWARDS (or leave
          // it unchanged) with no skip-phrase requirement — that's the normal case allowBackward
          // exists for. But an INCREASE still needs the same narrative backing a normal forward
          // update would need. Without this check, the "no skip phrase found" / "delta exceeds
          // what the log supports" rules were skipped entirely on the resync path by design, and
          // repeatedly deleting + regenerating a reply could nudge Current Day upward across
          // resyncs with nothing in the (up-to-60-message) log ever describing time passing —
          // leaving the Scheduled Events cap below as the only brake instead of an actual guard.
          reason = `the recent log only supports a skip of about ${allowedSkip} day${allowedSkip===1?'':'s'}, not ${delta}`;
        }
      }
      if(reason){
        showGuardWarning(worldId, `Timeline — blocked Current Day change (${oldNum} → ${newNum}): ${reason}.`);
        delete catUpdate.kv[k];
        continue;
      }
      // Hard cap: Current Day can never be advanced past a still-upcoming Scheduled Events
      // day in one jump — a time-skip phrase long enough to reach further ("we traveled for
      // ten days") would otherwise let the day counter clear a dated event without the story
      // ever actually landing on it, which is what let an exam/deadline get skipped entirely
      // instead of triggering. Scans every list category (usually "Scheduled Events", but
      // tolerates whatever name the model actually used) for a "Day N — ..." entry still
      // ahead of where the sheet currently stands, and clamps to the nearest one instead of
      // rejecting the update outright — the skip still happens, just only as far as that day.
      // An entry this SAME update is already list_remove-ing (i.e. the story just showed that
      // exact event happening this turn) is excluded from the count — once an event is
      // resolved, the cap rolls forward to whichever dated entry is next, even within the
      // very turn that resolves it, rather than staying stuck on the one that just finished.
      let nearestUpcoming = null;
      const considerDatedEntry = entry => {
        const parsed = parseDayEntry(entry);
        if(!parsed) return;
        const day = parsed.day;
        // >= oldNum, not just >: an entry whose day the story has ALREADY reached but that
        // hasn't been resolved/removed yet (still sitting "due") must keep blocking further
        // advancement just as much as a still-future one — otherwise once Current Day lands
        // exactly on an event's day, the very next turn's cap check stops seeing it (since it's
        // no longer "ahead" of oldNum) and a later time-skip can sail straight past an
        // unaddressed due event with no cap and no warning.
        if(day >= oldNum && (nearestUpcoming == null || day < nearestUpcoming)) nearestUpcoming = day;
      };
      for(const [pCatName, cat] of Object.entries(panel.categories || {})){
        if(!cat || cat.type !== 'list') continue;
        const dataCatKey = findExistingKey(data.categories, pCatName) || pCatName;
        const catRemovals = data.categories[dataCatKey];
        // Only treat a claimed removal as "resolved" (and so exclude it from the cap) if the
        // event is actually backed up by the recent log text — a removal proposed with nothing
        // narrated is not enough on its own (see eventNarratedInLog above).
        const removedThisTurn = new Set(
          (catRemovals && Array.isArray(catRemovals.list_remove))
            ? catRemovals.list_remove
                .filter(x => eventNarratedInLog(x, recentLogText))
                .map(x=>String(x).trim().toLowerCase())
            : []
        );
        for(const entry of cat.data || []){
          if(removedThisTurn.has(String(entry).trim().toLowerCase())) continue;
          considerDatedEntry(entry);
        }
      }
      // NOTE: this used to also cap against a brand-new dated entry the AI was proposing to
      // list_add this same turn (a "fresh deadline revealed mid-skip"). That's now dead code
      // and was actively harmful to keep: guardScheduledEvents runs immediately after this
      // function at every call site and unconditionally strips any AI-proposed list_add into
      // a Scheduled Events-shaped category (new entries only come from the manual "system bro"
      // tile now). Considering that not-yet-stripped, about-to-be-deleted entry here would cap
      // Current Day against a "ghost" event that never actually lands on the saved sheet —
      // over-restricting the skip for no real reason. Only genuinely-established entries
      // already on the panel (the loop just above) are legitimate to cap against.
      if(nearestUpcoming != null && newNum > nearestUpcoming){
        showGuardWarning(worldId, `Timeline — capped Current Day at ${nearestUpcoming} (was about to jump to ${newNum}): a Scheduled Events entry falls on day ${nearestUpcoming}, so the story can't skip past it before that event actually happens.`);
        newNum = nearestUpcoming;
      }
      catUpdate.kv[k] = String(newNum);
    }
    if(Object.keys(catUpdate.kv).length === 0) delete catUpdate.kv;
  }
  return data;
}

// ================= SCHEDULED EVENTS =================
// Add/remove guard for dated entries, the manual "system bro" add UI, and lore-seeding
// for events/skills already stated in the world's own setup text before play begins.
// TL-5 through TL-8 below.

// ---------- [TL-5] GUARD — Scheduled Events add/remove ----------
// ---------- hard code-level guard: a dated "Scheduled Events" entry (e.g. "Day 11 — Chūnin
// Exam doors open") can only be removed once the day counter has actually reached it. The
// prompt already says not to clear one just because its due date arrived with nothing shown
// happening, but a background model still does it sometimes (that's what emptied "Scheduled
// Events" back to "(none yet)" while Current Day was still 3) — this makes the earliest-
// possible removal point a hard rule instead of a suggestion.
// Loophole closed: parseDayEntry returning null used to mean "leave this entry alone" on
// BOTH add and remove for every category, including "Scheduled Events" itself. Since every
// guard above (due-day check, narration check, overdue-on-introduction check, silent-rewrite
// check) only ever fires for entries that parse as "Day N — desc", a Scheduled Events entry
// that simply never took that shape — a stray "Chunin Exam Finals" with no day prefix, a
// stray typo, whatever — sailed onto the sheet with zero protection, and could then be
// list_remove'd later with zero protection too (no due-day check possible, no narration
// requirement, nothing). SCHED_CAT_RE identifies a category that's meant to hold dated
// entries (by name, same tolerant match the rest of this function already uses) so those two
// gaps can be closed specifically there, without touching how non-dated categories (e.g.
// Milestones) are allowed to behave.
const SCHED_CAT_RE = /scheduled\s*events?/i;
function guardScheduledEvents(data, panel, worldId, recentLogText){
  if(!data || !data.categories) return data;
  let currentDay = null;
  const readDay = obj => { for(const [k,v] of Object.entries(obj||{})) if(CURRENT_DAY_KEY_RE.test(k)){ const n = parseInt(String(v).replace(/[^\d]/g,''),10); if(!isNaN(n)) currentDay = n; } };
  for(const cat of Object.values(panel.categories||{})) if(cat.type==='kv') readDay(cat.data);
  // Also honor a day change from THIS same turn (already vetted by guardTimelineDay above),
  // so an event due the same day the counter advances to it isn't blocked as "too early".
  for(const cat of Object.values(data.categories)) if(cat && cat.kv) readDay(cat.kv);
  // Removal checks now run unconditionally (not just when currentDay != null) so a
  // schedule-like category with a still-unresolved Current Day (Timeline missing/renamed,
  // a corrupted panel, whatever) fails CLOSED — no narration, no removal — instead of the
  // old behavior of silently skipping every removal check the moment currentDay was null.
  {
    for(const [catName, catUpdate] of Object.entries(data.categories)){
      if(!catUpdate || !Array.isArray(catUpdate.list_remove)) continue;
      const isSchedCat = SCHED_CAT_RE.test(catName);
      const existingCat = panel && panel.categories ? panel.categories[findExistingKey(panel.categories, catName) || catName] : null;
      const panelList = (existingCat && existingCat.type === 'list') ? (existingCat.data || []) : [];
      catUpdate.list_remove = catUpdate.list_remove.filter(entry=>{
        // Scheduled Events entries are permanent now — there's no longer a "due day + narrated
        // in the log" path that clears one. Once added (only ever through the manual "system
        // bro" tile), an entry stays on the sheet forever; the UI is what shows it's passed
        // (dimmed) once Current Day reaches its day, per renderPanelHtml/paintSched.
        if(isSchedCat){
          showGuardWarning(worldId, `Scheduled Events — blocked removing "${entry}": entries are permanent and can't be removed, only dimmed once their day has passed.`);
          return false;
        }
        const parsed = parseDayEntry(entry);
        if(!parsed){
          if(!isSchedCat) return true; // not a dated entry, and not a schedule-shaped category — leave it alone
          // A malformed (non "Day N — desc") entry inside a Scheduled Events-shaped category:
          // no due-day to check, but it still has to be genuinely on the sheet AND actually
          // narrated happening before it can be cleared — same bar as a well-formed one, minus
          // the day-arrival check this format simply can't support.
          const entryLower = String(entry).trim().toLowerCase();
          const stillReal = panelList.some(it => String(it).trim().toLowerCase() === entryLower || normalizeEntryLabel(it) === normalizeEntryLabel(entry));
          if(!stillReal){
            showGuardWarning(worldId, `Scheduled Events — blocked removing "${entry}": no matching entry found on the sheet.`);
            return false;
          }
          if(!eventNarratedInLog(entry, recentLogText)){
            showGuardWarning(worldId, `Scheduled Events — blocked removing "${entry}": the recent log doesn't actually show this happening yet.`);
            return false;
          }
          return true;
        }
        if(currentDay == null){
          showGuardWarning(worldId, `Scheduled Events — blocked removing "${entry}": Current Day isn't tracked on the sheet yet, so a due date can't be verified.`);
          return false;
        }
        // ---- hard requirement: a claimed removal has to correspond to a REAL entry actually
        // on the sheet. Digit-preserving normalization (normalizeEntryLabel — never
        // digit-stripped) tolerates reworded punctuation/spacing, but can never treat two
        // entries with different day numbers as the same entry. Without this, a fuzzy match
        // elsewhere could otherwise be tricked into deleting a genuinely different, still-
        // upcoming entry that only happens to share the same non-numeric description text as a
        // fake, already-past day number the AI proposed removing.
        const entryLower = String(entry).trim().toLowerCase();
        let actual = panelList.find(it => String(it).trim().toLowerCase() === entryLower);
        if(!actual){
          const targetNorm = normalizeEntryLabel(entry);
          const matches = panelList.filter(it => normalizeEntryLabel(it) === targetNorm);
          if(matches.length === 1) actual = matches[0];
        }
        if(!actual){
          showGuardWarning(worldId, `Scheduled Events — blocked removing "${entry}": no matching entry found on the sheet.`);
          return false;
        }
        // Use the REAL matched entry's day number for the due-day check, never the claimed
        // string's own day number — a claimed removal's day can't be trusted on its own (that's
        // exactly the gap that let a fake, already-past day number get used to sneak past this
        // check while a different entry — the one actually matched above — got deleted).
        const actualParsed = parseDayEntry(actual) || parsed;
        const dueDay = actualParsed.day;
        if(currentDay < dueDay){
          showGuardWarning(worldId, `Scheduled Events — blocked removing "${actual}": due on day ${dueDay}, story is only on day ${currentDay}. Events can't be skipped before their day arrives.`);
          return false;
        }
        // The day has arrived, but that's necessary, not sufficient — the log also has to
        // actually show the event happening. Without this, pairing a big time-skip with a
        // claimed "resolved" removal in the same turn (with nothing ever narrated) could clear
        // an event the instant its day was reached, even if the story never depicted it.
        if(!eventNarratedInLog(actual, recentLogText)){
          showGuardWarning(worldId, `Scheduled Events — blocked removing "${actual}": day ${dueDay} has arrived, but the recent log doesn't actually show this happening yet.`);
          return false;
        }
        return true;
      });
      if(catUpdate.list_remove.length === 0) delete catUpdate.list_remove;
    }
  }
  // Scheduled Events can now only ever be ADDED through the manual "system bro" tile
  // (addScheduledEvent, deterministic, always pre-formatted "Day N — desc", never routed
  // through this AI-facing guard at all). So every AI-proposed list_add into a Scheduled
  // Events-shaped category is illegitimate by construction — there's no longer a legitimate
  // case to validate the content of (format, overdue-on-introduction, silent-rewrite), just
  // one case to reject outright. This replaces what used to be three separate passes (format
  // enforcement, overdue-on-introduction check, silent-rewrite/clash check) with a single
  // unconditional block, since none of that content-validation logic can ever be reached by
  // a legitimate add anymore.
  for(const [catName, catUpdate] of Object.entries(data.categories)){
    if(!catUpdate || !Array.isArray(catUpdate.list_add)) continue;
    if(!SCHED_CAT_RE.test(catName)) continue;
    for(const entry of catUpdate.list_add){
      showGuardWarning(worldId, `Scheduled Events — blocked adding "${entry}": new scheduled events can only be added through the system bro tile, not narrated into existence.`);
    }
    delete catUpdate.list_add;
  }
  return data;
}

// An AI-driven seed pass for Scheduled Events was tried here and removed — guardScheduledEvents
// would strip anything an AI proposed adding anyway, since a scheduled date's meaning to the
// player is too easy for a model to get subtly wrong when just inferring it from prose. What
// exists instead: the manual "system bro" tile (typed in one at a time), and — for events the
// player already knows about before the story even starts — seedScheduledEventsFromLore below,
// which is deterministic text-pattern matching against explicit "Day N — description" lines
// the player wrote themselves in the world's own setup text, not the AI inventing anything.

// ---------- [TL-7] MANUAL ADD UI — deterministic write (the "system bro" tile) ----------
// Deterministic (no AI call) write of a scheduled event straight into the Timeline/
// Scheduled Events categories, via the same mergePanelUpdate() path everything else
// uses — indistinguishable from an AI-detected event afterward, and picked up by the
// SCHEDULED EVENTS — AUTO-TRIGGER rule in worldSystemPrompt() once Current Day reaches
// it. Wrapped in queueWorldOp so it can never race a background sheet write from the
// story's own AI turn. Only reachable from the "system bro" Scheduled Events tile above
// (structured day + description fields) — never from raw chat text.
async function addScheduledEvent(worldId, parsedDay, desc){
  let day, clamped = false;
  await queueWorldOp(worldId, async ()=>{
    const panel = await getPanel(worldId);
    let currentDay = null;
    for(const cat of Object.values(panel.categories || {})){
      if(cat.type !== 'kv') continue;
      for(const [k, v] of Object.entries(cat.data)){
        if(!CURRENT_DAY_KEY_RE.test(k)) continue;
        const n = parseInt(String(v).replace(/[^\d]/g,''), 10);
        if(!isNaN(n)) currentDay = n;
      }
    }
    if(currentDay == null) currentDay = 1;
    if(parsedDay != null && parsedDay < currentDay) clamped = true;
    day = (parsedDay != null && parsedDay >= currentDay) ? parsedDay : currentDay;
    mergePanelUpdate(panel, { categories: {
      Timeline: { kv: { 'Current Day': String(currentDay) } },
      'Scheduled Events': { list_add: [`Day ${day} — ${desc}`] }
    }});
    await savePanel(worldId, panel);
  });
  return { day, clamped };
}

// ---------- [TL-8] LORE SEEDING — "Day N — ..." lines from the world's own setup text ----------
// A second, deterministic (no AI call) way to add Scheduled Events besides the manual
// "system bro" tile: a line the player types in the world-creation "lore" textarea that
// already follows the "Day N — description" shape (the exact same format the tile itself
// writes) gets picked up automatically and added the moment the world is first created —
// no need to also re-type it into the tile afterward. Purely a text-pattern match against
// what the player themselves wrote, same as parseDayEntry already parses for the tile — this
// is NOT the AI inferring or inventing a date from vague setup prose, so it doesn't reopen
// the "the story silently invents a scheduled event" gap that guardScheduledEvents exists to
// close: only an explicit "Day N — ..." (or "Day N: ...", "Day N - ...", spelled-out day
// numbers too) line the player actually wrote is ever picked up.
const LORE_DAY_EVENT_SCAN_RE = /\bday\s+(?:\d+|[a-z]+)\s*[—–:-]\s*\S.*/i;
function parseLoreScheduledEvents(loreText){
  const lines = String(loreText || '').split('\n');
  const found = [];
  const seen = new Set();
  for(const rawLine of lines){
    const line = rawLine.trim();
    if(!line) continue;
    const m = LORE_DAY_EVENT_SCAN_RE.exec(line);
    if(!m) continue;
    const parsed = parseDayEntry(m[0]);
    if(!parsed || !parsed.desc) continue;
    const key = parsed.day + '|' + normalizeEntryLabel(parsed.desc);
    if(seen.has(key)) continue; // same line-shape repeated twice in the text — only seed it once
    seen.add(key);
    found.push(parsed);
  }
  return found;
}
// Only ever called once, right after a brand-new world is first saved (see saveCardBtn.onclick)
// — editing an already-created world's lore later never re-runs this, so re-saving can't
// duplicate entries. Deliberately does its own single getPanel/savePanel round trip rather
// than calling addScheduledEvent per line (which internally queues itself) — running that
// inside this function's own queueWorldOp callback would chain a second queued op onto the
// same per-world queue entry that's still executing, deadlocking on itself.
async function seedScheduledEventsFromLore(world){
  const found = parseLoreScheduledEvents(world.lore);
  if(!found.length) return;
  await queueWorldOp(world.id, async ()=>{
    const panel = await getPanel(world.id);
    let currentDay = 1;
    for(const cat of Object.values(panel.categories || {})){
      if(cat.type !== 'kv') continue;
      for(const [k, v] of Object.entries(cat.data)){
        if(!CURRENT_DAY_KEY_RE.test(k)) continue;
        const n = parseInt(String(v).replace(/[^\d]/g,''), 10);
        if(!isNaN(n)) currentDay = n;
      }
    }
    const seCat = panel.categories['Scheduled Events'];
    const existingNorm = new Set(((seCat && seCat.type==='list') ? seCat.data : []).map(e => normalizeEntryLabel(e)));
    const toAdd = [];
    for(const {day, desc} of found){
      // Same clamp-to-today rule the manual tile uses: a date already in the past when the
      // world is first created snaps to Day 1 (today) rather than being silently dropped.
      const clampedDay = Math.max(day, currentDay);
      const entryText = `Day ${clampedDay} — ${desc}`;
      const norm = normalizeEntryLabel(entryText);
      if(existingNorm.has(norm)) continue;
      existingNorm.add(norm);
      toAdd.push(entryText);
    }
    if(!toAdd.length) return;
    mergePanelUpdate(panel, { categories: { 'Scheduled Events': { list_add: toAdd } } });
    await savePanel(world.id, panel);
  });
}

// ============================================================================================
// #endregion TIMELINE-EVENTS-MODULE
// ============================================================================================

// For the same underlying reason seedTimelineFromLore existed (see removal note above):
// anything stated in the world's own
// setup text (an inborn bloodline power, a technique the character already knows, a trained
// proficiency they start the story with) needs to land on the sheet BEFORE play begins — the
// regular per-turn updatePanel() only ever reads the actual chat log, never world.lore
// directly, so a stated starting ability that the opening scene doesn't happen to restate
// verbatim would otherwise never make it onto the sheet at all. Everything this pass finds is,
// by definition, something the character can already fully do at story start — never a
// still-in-progress skill — so it goes straight into "Skills & Abilities" and "Learning" is
// explicitly off-limits here; only actual training shown during play should ever create a
// Learning entry.
async function seedSkillsFromLore(world){
  if(!world.lore || !world.lore.trim()) return;
  const panel = await getPanel(world.id);
  const prompt = `World setup text (this world has no story log yet — nothing has happened in it):\n${world.lore}\n\nCurrent character sheet:\n${panelToText(panel)}\n\nThis pass is ONLY for "Skills & Abilities" — ignore everything else the setup text mentions (items, currency, timeline, etc.), those get picked up in their own pass or once the story actually begins. List every skill, technique, spell, bloodline trait, or innate power this setup text states the character ALREADY has at the start of the story — fully-formed, ready to use right now, whether it's innate (a bloodline, a granted power) or something they're stated to have already learned/trained/mastered before the story begins. Add each as a plain entry in "Skills & Abilities" (a list category). Do NOT create a "Learning" entry for anything here, even if the text describes the character as still improving or not yet a master at it — "Learning" is only ever for training the player actually does DURING play; only skip an ability entirely if the text explicitly says the character hasn't started learning it yet (a stated future goal, not a current ability).`;
  try{
    const bgModel = await getGeminiBgModel();
    const raw = await askAIWithRetry(PANEL_SYS_PROMPT, prompt, bgModel);
    const data = extractJsonObject(raw);
    if(!data || !data.categories) return;
    // Belt-and-suspenders: keep only Skills & Abilities list_add output from this pass — no
    // Learning entries, no other category, since there's no story log here to ground anything
    // else the model might try to add, and Learning is explicitly off-limits for this pass.
    const skillsOnly = { categories: {} };
    for(const [name, upd] of Object.entries(data.categories)){
      if(!/^skills?(\s|&|$)/i.test(name.trim())) continue;
      if(!upd || !Array.isArray(upd.list_add) || !upd.list_add.length) continue;
      skillsOnly.categories[name] = { list_add: upd.list_add };
    }
    if(Object.keys(skillsOnly.categories).length){
      mergePanelUpdate(panel, skillsOnly);
      await savePanel(world.id, panel);
    }
  }catch(e){ showBackgroundWarning(world.id, 'Skills & Abilities seed', e); }
}

// Surfaces a background (memory/records) failure the same way a failed main story reply
// already does — a small ⚠️ note in the chat log — instead of only logging to the console
// where the player has no way to notice why a skill/fact silently didn't update. Only shown
// if the player is actually looking at this story right now, so it never appears in the
// wrong chat.
function showBackgroundWarning(worldId, label, err){
  console.error(`[${label} failed]`, err);
  if(!els.log || state.chattingId !== worldId) return;
  const msg = (err && err.message) ? err.message : 'Something went wrong.';
  const w = document.createElement('div'); w.className='warn';
  w.textContent = `⚠️ ${label} update skipped — ${msg}`;
  els.log.appendChild(w);
  els.log.scrollTop = els.log.scrollHeight;
}

// ================= PANEL UPDATE & RESYNC PIPELINE =================
// Applies an AI-proposed panel update through every guard above (updatePanel), plus
// the equivalent full resync pass used to recover from a drifted sheet.

// ---------- SCHEDULED EVENTS ----------
// A due event's actual arrival is still communicated through the SCHEDULED EVENTS —
// AUTO-TRIGGER rule baked into worldSystemPrompt() (see below) — the story AI works it into
// whatever reply it's already generating in response to the player's own action. The
// JS-level "fire an extra unprompted reply on its own" mechanism that used to live here
// (earliestDueEvent + maybeAutoTriggerDueEvent, called from openStory() and updatePanel())
// has been removed by request: a reply should only ever appear because the player pressed
// Send or Forward, never as a bonus turn the app generated on its own.
async function updatePanel(world, opts){
  opts = opts || {};
  const chat = await getChat(world.id);
  // Check every full turn (2 messages: player + reply) so nothing slips past the recent-log
  // window unnoticed — inventory/currency/skill changes need to be caught reliably, not just
  // eventually, so this doesn't skip turns the way memory summarization does.
  if(chat.length < 2) return;
  const recent = chat.slice(-10).map(messageToLogLine).join('\n');
  const panel = await getPanel(world.id);
  // Cross-reference the memory log too, so the sheet ("letter of records") and the memory
  // can catch each other's drift instead of silently diverging over time.
  const memory = await getMemory(world.id);
  const prompt = `Recent story log:\n${recent}\n\nCurrent character sheet:\n${panelToText(panel)}\n\nMemory log (for consistency-checking only):\n${memory || '(none yet)'}\n\nWhat, if anything, is genuinely new or changed?`;
  try{
    const bgModel = await getGeminiBgModel();
    const raw = await askAIWithRetry(PANEL_SYS_PROMPT, prompt, bgModel);
    const data = extractJsonObject(raw);
    const lastPlayerMsg = [...chat].reverse().find(m=>m.role==='user');
    guardCurrencyDecreases(data, panel, lastPlayerMsg ? lastPlayerMsg.text : '', recent);
    guardCurrencyIncreases(data, panel, recent);
    guardSkillProgress(data, panel, lastPlayerMsg ? lastPlayerMsg.text : '');
    guardSkillGraduation(data, panel);
    guardUngraduatedAbilityInventory(data, panel, recent);
    guardStackableItems(data, panel, lastPlayerMsg ? lastPlayerMsg.text : '', recent);
    guardDuplicationMath(data, panel, recent);
    guardInventoryEquipStatus(data, panel, lastPlayerMsg ? lastPlayerMsg.text : '');
    guardInventoryRenameBypass(data, panel, lastPlayerMsg ? lastPlayerMsg.text : '', recent);
    guardInventoryDiscard(data, panel, lastPlayerMsg ? lastPlayerMsg.text : '');
    guardTimelineDay(data, panel, recent, world.id);
    guardScheduledEvents(data, panel, world.id, recent);
    guardIdentityChanges(data, panel, recent);
    if(data && data.categories && Object.keys(data.categories).length > 0){
      mergePanelUpdate(panel, data);
      await savePanel(world.id, panel);
    }
    // else: nothing new — skip the save entirely
  }catch(e){ showBackgroundWarning(world.id, 'Letter of records', e); }
}

// Rewinding (deleting a message and everything after it) changes the story's actual
// timeline, so the additive memory/panel — which only ever grow — can be left holding
// facts from a branch that no longer happened. Re-check both against the chat as it now
// stands. Important: this starts from the EXISTING sheet/memory as a baseline rather than
// a blank template — a single AI call reconstructing an entire long transcript from scratch
// is prone to missing older facts (that's what was causing stats like money to randomly
// vanish after a regenerate/rewind). Starting from what's already there and asking only
// "what does the trimmed log contradict or add" keeps everything else intact by default.
async function resyncMemoryAndPanel(world, chat){
  if(chat.length === 0){
    // Rewinding/deleting every message empties the log, but that's not the same thing as the
    // story ending — the world still exists, and Identity/Finances/Inventory/etc. are meant to
    // stay exactly as they are until the player actually deletes the world itself
    // (deleteWorldData, which clears all of this on purpose). Wiping the sheet back to blank
    // here was the one path that could permanently lose that data outside of that explicit
    // delete — a single "clear the log" moment was enough to erase everything for good. Leave
    // memory/panel untouched; whatever's next in the (now-empty) chat picks back up from them.
    return;
  }
  // Bound how much of the log this rebuild actually has to read. The existing sheet/memory
  // already hold everything established earlier, so re-deriving all of that from scratch on
  // every resync isn't needed — only whatever part of the log could actually differ from what
  // the baseline reflects (i.e. near wherever the rewind/regenerate happened) is. Sending the
  // entire, ever-growing transcript here was the real long-chat failure point: past a certain
  // length it exceeds what the background model can actually track in one pass, and it starts
  // silently dropping or garbling things — Identity, Finances, and Inventory included, since
  // this same rebuild covers all three.
  const RESYNC_LOG_WINDOW = 60;
  const windowChat = chat.slice(-RESYNC_LOG_WINDOW);
  const convo = windowChat.map(messageToLogLine).join('\n');
  // Player-only text from the same window, for the spend/practice-confirmation guards below.
  // Deliberately excludes Story/narrator lines — those can quote NPC dialogue like '"I'll pay
  // you now," the merchant says', which would otherwise falsely count as the PLAYER
  // confirming a spend they never actually made.
  const playerTextInWindow = windowChat.filter(m=>m.role==='user').map(m=>m.text||'').join('\n');
  const oldMemory = await getMemory(world.id);
  const oldPanel = await getPanel(world.id);
  const memPrompt = `Most recent part of the story log (this reflects the story after a rewind/regenerate — some previously-recorded facts may no longer have happened; anything from earlier than this excerpt is NOT included here because the memory below already has it — do not treat its absence from this excerpt as it having been undone):\n${convo}\n\nPrevious memory (everything remembered before this rewind):\n${oldMemory || '(none yet)'}\n\nUpdate the memory to match the log above. Keep every existing bullet unless this excerpt specifically contradicts it (i.e. that event no longer happened) — remove or fix only those. Add any new facts this excerpt supports that aren't already recorded. Output the full corrected bullet list, 3-5 words per bullet.`;
  const bgModel = await getGeminiBgModel();
  // Rebuild memory first, then rebuild the panel using that freshly-corrected memory as a
  // consistency reference (same cross-check as the regular update passes) — sequential
  // rather than parallel here so the panel rebuild always sees the corrected memory, not
  // a stale or half-corrected version of it.
  let freshMemory = oldMemory;
  try{
    const memResult = await askAIWithRetry('You maintain a permanent story memory log. You are correcting it after a rewind — keep every fact unless the log now contradicts it, never drop something just because this pass didn\'t re-mention it. Output only the corrected bullet list, nothing else.', memPrompt, bgModel);
    if(memResult && memResult.trim()){ freshMemory = memResult; await saveMemory(world.id, freshMemory); }
  }catch(e){ showBackgroundWarning(world.id, 'Memory resync', e); }
  const panelPrompt = `Most recent part of the story log (this reflects the story after a rewind/regenerate — some previously-recorded facts may no longer have happened; anything from earlier than this excerpt is NOT included here because the sheet below already has it — do not treat its absence from this excerpt as it having been undone):\n${convo}\n\nCurrent character sheet (from before this rewind):\n${panelToText(oldPanel)}\n\nMemory log (for consistency-checking only):\n${freshMemory || '(none yet)'}\n\nGiven this excerpt, what on the sheet is now specifically wrong (from a branch that no longer happened) and needs correcting, and what new facts (if any) should be added? Keep everything else on the sheet exactly as-is by default — only output categories that actually need a change.`;
  try{
    const raw = await askAIWithRetry(PANEL_SYS_PROMPT, panelPrompt, bgModel);
    const data = extractJsonObject(raw);
    // Resync reconstructs changes over up to RESYNC_LOG_WINDOW (60) messages at once, not
    // just the latest exchange — so, unlike the normal per-turn updatePanel() flow, a
    // legitimate spend/practice confirmation here can legitimately sit anywhere in that
    // window, not only in the very last player line. Checking only the last message (the old
    // behavior) meant a real spend from a few turns back got wrongly blocked on every
    // rewind/regenerate resync. Check all of the player's own lines in the window instead
    // (not the full convo — that also contains Story/narrator text, which can quote NPC
    // dialogue like "I'll pay you now" and would falsely count as the player's own confirmation).
    guardCurrencyDecreases(data, oldPanel, playerTextInWindow, convo);
    guardCurrencyIncreases(data, oldPanel, convo);
    guardSkillProgress(data, oldPanel, playerTextInWindow, true);
    guardSkillGraduation(data, oldPanel);
    guardUngraduatedAbilityInventory(data, oldPanel, convo);
    guardStackableItems(data, oldPanel, playerTextInWindow, convo);
    guardDuplicationMath(data, oldPanel, convo);
    guardInventoryEquipStatus(data, oldPanel, playerTextInWindow);
    guardInventoryRenameBypass(data, oldPanel, playerTextInWindow, convo);
    guardInventoryDiscard(data, oldPanel, playerTextInWindow);
    guardTimelineDay(data, oldPanel, convo, world.id, true, true);
    guardScheduledEvents(data, oldPanel, world.id, convo);
    guardIdentityChanges(data, oldPanel, convo);
    const fresh = JSON.parse(JSON.stringify(oldPanel)); // clone so a failed/empty response leaves the sheet untouched
    if(data && data.categories) mergePanelUpdate(fresh, data);
    await savePanel(world.id, fresh);
  }catch(e){ showBackgroundWarning(world.id, 'Letter of records resync', e); }
}

// ================= MERGE ENGINE — KEY MATCHING & PANEL UPDATES =================
// Fuzzy/exact matching between an AI's wording and existing sheet entries, and the
// core mergePanelUpdate() that applies a proposed update to the panel in place.

// ---------- character panel: data model helpers ----------
// Finds an existing category/key by normalized (trimmed, case-insensitive) match, so a
// name the AI phrases slightly differently between turns (e.g. "Inventory" vs "inventory",
// "Gold" vs "gold ") routes to the SAME existing entry instead of silently spawning a
// near-duplicate that leaves the original looking stale/empty and the "new" one starting
// from scratch. This is a likely cause of sections/stats appearing to randomly reset.
// Collapses ALL internal whitespace runs to a single space (not just trimming the ends) —
// without this, "Current Day" and "Current  Day" (double space) normalize to two different
// strings, so a key-matching function like findExistingKey silently fails to recognize them
// as the same field. That mismatch is what let a stray double space turn the entire Timeline
// day-guard off: CURRENT_DAY_KEY_RE's \s* still recognized the field as "Current Day", but the
// existing-value lookup below (which relies on this function) couldn't find the old value to
// compare against, so guardTimelineDay treated it as untracked and skipped every check.
function normalizeKey(s){ return String(s||'').trim().toLowerCase().replace(/\s+/g, ' '); }
function findExistingKey(obj, name){
  if(Object.prototype.hasOwnProperty.call(obj, name)) return name; // exact match, fast path
  const target = normalizeKey(name);
  return Object.keys(obj).find(k => normalizeKey(k) === target) || null;
}
// Fallback for when the AI names the same underlying stat/skill differently between turns in a
// way findExistingKey's exact/case-insensitive match won't catch — e.g. "Basic Chakra-Conduction
// Theory" vs "Basic-Conduction Theory" for the same Learning entry. Compares the meaningful
// (3+ letter) words in each key and treats a high overlap as the same key, so the AI's second
// phrasing updates the existing entry instead of spawning a duplicate that leaves the original
// looking stuck while a second bar silently tracks the real progress.
function keyWords(s){ return new Set(String(s||'').toLowerCase().replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim().split(' ').filter(w=>w.length>2)); }
function findFuzzyExistingKey(obj, name){
  const target = keyWords(name);
  if(!target.size) return null;
  let best = null, bestScore = 0;
  for(const k of Object.keys(obj)){
    const kw = keyWords(k);
    if(!kw.size) continue;
    let overlap = 0; for(const w of target) if(kw.has(w)) overlap++;
    const score = overlap / Math.min(target.size, kw.size);
    if(score > bestScore){ bestScore = score; best = k; }
  }
  return bestScore >= 0.6 ? best : null;
}
function mergePanelUpdate(panel, update){
  if(!update || !update.categories || typeof update.categories !== 'object') return panel;
  for(const [rawName, catUpdate] of Object.entries(update.categories)){
    if(!rawName || !catUpdate || typeof catUpdate !== 'object') continue;
    let existingName = findExistingKey(panel.categories, rawName);
    // BUG FIX (stray duplicate inventory category): the background model occasionally invents
    // a second, differently-worded inventory-ish category (e.g. "Inventory Description")
    // instead of writing into the real "Inventory" — findExistingKey only matches the same name
    // exactly (case/whitespace-insensitive), so it doesn't catch this and a confusing second
    // section used to form, out of sync with the one every guard/merge/delete action actually
    // governs. Once a real "Inventory" category already exists, redirect any other name that
    // merely starts with "inventory" straight into it instead.
    if(!existingName && /^inventory/i.test(String(rawName).trim())){
      existingName = findExistingKey(panel.categories, 'Inventory');
    }
    const name = existingName || rawName;
    let cat = panel.categories[name];
    if(!cat){
      // Only ever create a category here if it's one of the fixed, recognized ones (e.g.
      // "Learning", the first time training begins) — the AI is no longer allowed to invent a
      // brand-new category name (e.g. "Titles") that isn't already part of the fixed set.
      if(!isRecognizedCategory(name)) continue;
      let type = catUpdate.kv ? 'kv' : (catUpdate.list_add || catUpdate.list_remove) ? 'list' : (typeof catUpdate.text === 'string') ? 'text' : null;
      if(!type) continue;
      cat = panel.categories[name] = { type, data: type==='kv' ? {} : type==='list' ? [] : '', ids: type==='kv' ? {} : type==='list' ? [] : undefined };
    }
    if(cat.type==='kv' && catUpdate.kv && typeof catUpdate.kv==='object'){
      if(!cat.ids) cat.ids = {};
      for(const [rawK,v] of Object.entries(catUpdate.kv)){
        if(v===null || v==='') continue;
        const existingK = findExistingKey(cat.data, rawK) || findFuzzyExistingKey(cat.data, rawK);
        const targetK = existingK || rawK;
        cat.data[targetK] = String(v);
        // a resolved existing key keeps its own hidden ID (nothing to do); a genuinely new key
        // gets a fresh one, assigned once at creation and never reassigned afterward.
        if(!cat.ids[targetK]) cat.ids[targetK] = genId();
      }
    }
    if(cat.type==='list'){
      const isInv = /^inventory/i.test(String(name).trim());
      const mintId = () => isInv ? genInvId(panel) : genId();
      if(!Array.isArray(cat.ids)) cat.ids = [];
      while(cat.ids.length < cat.data.length) cat.ids.push(mintId());
      if(cat.ids.length > cat.data.length) cat.ids.length = cat.data.length;
      // Collects {text, id} pairs removed during THIS call, so a same-turn list_add that's
      // really just a correction of one of them (a status/qty/wording update — the standard
      // "remove old text, add corrected text" pattern used throughout the guards) can reuse
      // that entry's existing ID below instead of silently minting a new one. That's what
      // keeps a single physical item/skill/entry as one continuous identity across corrections
      // rather than looking, at the identity level, like the old one vanished and a brand-new
      // one appeared in its place.
      const removedThisTurn = [];
      // Remove first, then add — this correctly handles the common "replace stale amount
      // with a recalculated one" pattern (e.g. spending money) without the new entry
      // getting immediately matched/skipped by a same-normalized-text removal below.
      if(Array.isArray(catUpdate.list_remove)){
        const rm = catUpdate.list_remove.map(x=>String(x||'').trim()).filter(Boolean);
        // Entries the model didn't reproduce verbatim (e.g. reworded punctuation/spacing)
        // still need to be found, so fall back to comparing the entry's normalized label text
        // once an exact case-insensitive match fails — but normalizeEntryLabel (unlike the old
        // normLabel here) NEVER strips digits. Stripping digits let two entries differing ONLY
        // in their number — a different scheduled-event day, a different currency amount, a
        // different item quantity — normalize to the identical string and match each other,
        // which meant a claimed removal naming the WRONG number (with the right description)
        // could delete a genuinely different real entry. Also require the fallback match to be
        // unique — if more than one entry normalizes the same way, there's no safe way to tell
        // which one was actually meant, so none of them get removed by the fallback.
        rm.forEach(target=>{
          const targetLower = target.toLowerCase();
          let idx = cat.data.findIndex(it=>it.toLowerCase()===targetLower);
          if(idx === -1){
            const targetNorm = normalizeEntryLabel(target);
            if(targetNorm){
              const matchIdxs = cat.data.reduce((acc,it,i)=>{ if(normalizeEntryLabel(it)===targetNorm) acc.push(i); return acc; }, []);
              if(matchIdxs.length === 1) idx = matchIdxs[0];
            }
          }
          if(idx !== -1){
            removedThisTurn.push({ text: cat.data[idx], id: cat.ids[idx] });
            cat.data.splice(idx, 1);
            cat.ids.splice(idx, 1);
          }
        });
      }
      if(Array.isArray(catUpdate.list_add)){
        // Backstop against near-duplicate entries describing the same event in different words
        // (e.g. "Purchased X and Y", "Paid 10,000 ryo for Y", "Purchased X and Y" again) — the
        // AI is instructed not to do this, but this catches it at the code level too, since an
        // exact-string check alone (the old behavior) let reworded repeats pile up unbounded.
        // Generic connector/template words (the, and, learned, received, gained...) are stripped
        // before comparing — otherwise two genuinely DIFFERENT entries that just happen to share
        // the same template phrasing (e.g. "Learned Fire Magic" vs "Learned Ice Magic", or
        // "Received Health Potion" vs "Received Mana Potion") score as near-duplicates on their
        // shared filler words alone, and the second, real entry gets silently dropped — the sheet
        // then permanently under-reports what actually happened, with no sign anywhere that an
        // entry was skipped. Only words that actually distinguish one entry from another should
        // count toward the similarity score. (STOPWORDS is defined once, top-level, near
        // eventNarratedInLog above — shared by both, since it's the same "filter out generic
        // filler" judgment either way.)
        const wordsOf = s => new Set(String(s).toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(w => w.length>2 && !STOPWORDS.has(w)));
        // Bug: on short entries (3-4 meaningful words, common for Milestones — "First kiss
        // with Sakura", "Rescued Hinata from bandits"), two DIFFERENT events sharing 2 of 3
        // generic template words already clear the 0.6 similarity bar even though the one
        // word that actually distinguishes them (the person's name) differs. That silently
        // drops the second, genuinely-new milestone/relationship-adjacent entry as a
        // "duplicate" of the first. Fix: pull out capitalized proper-noun-looking tokens
        // (names) separately from the rest of the sentence — if the two entries name
        // different people/places (any capitalized token unique to one side), they can
        // never be treated as duplicates, no matter how similar the surrounding wording is.
        const properNounsOf = s => new Set(String(s).split(/\s+/)
          .map(w => w.replace(/[^A-Za-z]/g,''))
          .filter((w,i) => w.length>1 && /^[A-Z]/.test(w) && i>0)); // skip index 0: sentence-initial capital isn't necessarily a name
        const isNearDuplicate = (candidate, existing) => {
          // Dated entries ("Day N — desc") are never duplicates of each other unless they
          // land on the SAME day. Short day numbers (1-2 digits) fall below wordsOf's
          // length>2 filter, so without this a two-stage event with similar wording (prelims
          // day 12, finals day 40) could otherwise score as a near-duplicate on description
          // text alone and the second, genuinely-different scheduled entry would silently
          // never get added. A differing day number is exactly as distinguishing as a
          // differing proper noun, so it's checked first, the same way names are below.
          const dayA = parseDayEntry(candidate), dayB = parseDayEntry(existing);
          if(dayA && dayB) return dayA.day === dayB.day && wordsOf(dayA.desc).size>0 && (()=>{
            const a = wordsOf(dayA.desc), b = wordsOf(dayB.desc);
            if(a.size===0 || b.size===0) return false;
            let overlap=0; for(const w of a) if(b.has(w)) overlap++;
            return (overlap/Math.min(a.size,b.size)) >= 0.6;
          })();
          const pa = properNounsOf(candidate), pb = properNounsOf(existing);
          if(pa.size || pb.size){
            for(const n of pa) if(!pb.has(n)) return false; // candidate names someone/something the existing entry doesn't — distinct
            for(const n of pb) if(!pa.has(n)) return false; // vice versa
          }
          const a = wordsOf(candidate), b = wordsOf(existing);
          if(a.size===0 || b.size===0) return false;
          let overlap = 0; for(const w of a) if(b.has(w)) overlap++;
          const similarity = overlap / Math.min(a.size, b.size);
          return similarity >= 0.6; // shares most of its meaningful, distinguishing words with an existing entry
        };
        // This near-duplicate check now runs for every list category — Milestones, Scheduled
        // Events, Inventory, Skills & Abilities, and any story-invented list alike. It was
        // scoped out of Inventory/Skills in a previous pass, but that only removed protection
        // there without fixing anything; the proper-noun check above is strictly safer than
        // the old logic everywhere it runs; a paired list_remove+list_add (the normal pattern
        // for updating an item's qty/status, or renumbering a scheduled event) still removes
        // the old text from cat.data BEFORE this runs, so it never collides with its own
        // replacement.
        catUpdate.list_add.forEach(it=>{
          it=String(it||'').trim();
          if(!it) return;
          if(cat.data.includes(it)) return; // exact duplicate
          if(cat.data.some(existing => isNearDuplicate(it, existing))) return; // reworded duplicate of an existing entry
          // If this add is really a correction of something just removed in this same call
          // (same core name once quantity/status wording is stripped off — e.g. "Pneumatic
          // launcher" -> "Pneumatic launcher — Loaded"), carry that entry's existing ID
          // forward instead of minting a new one, so it stays the SAME tracked entry rather
          // than reading as a duplicate or a reset.
          // Dated entries ("Day N — desc") need their own check here: itemNameKey alone would
          // reduce them to just "day n", which two DIFFERENT events landing on the same day
          // (one being corrected, one genuinely new) would both match — wrongly handing the
          // new event the corrected one's ID. requireDatedMatch mirrors isNearDuplicate's own
          // day+description check above, so pairing only fires for dated entries when the day
          // AND the description are actually the same event.
          const newDay = parseDayEntry(it);
          const pairIdx = removedThisTurn.findIndex(r=>{
            const oldDay = parseDayEntry(r.text);
            if(newDay || oldDay){
              if(!newDay || !oldDay || newDay.day !== oldDay.day) return false;
              const a = meaningfulWords(newDay.desc), b = meaningfulWords(oldDay.desc);
              if(!a.size || !b.size) return false;
              let overlap=0; for(const w of a) if(b.has(w)) overlap++;
              return (overlap/Math.min(a.size,b.size)) >= 0.6;
            }
            return itemNameKey(r.text) === itemNameKey(it);
          });
          const reusedId = pairIdx !== -1 ? removedThisTurn.splice(pairIdx, 1)[0].id : null;
          cat.data.push(it);
          cat.ids.push(reusedId || mintId());
        });
      }
    }
    if(cat.type==='text' && typeof catUpdate.text==='string' && catUpdate.text.trim()) cat.data = catUpdate.text.trim();
  }
  promoteMasteredSkills(panel);
  return panel;
}
// ================= PANEL RENDERING (HTML OUTPUT) =================
// Category ordering, HTML rendering of the Letter of Records panel, and the
// deterministic memory-vs-panel cross-check.

// ---------- canonical section order for the Letter of Records ----------
// Identity, Finances, Inventory, Skills & Abilities, Milestones, Relationships, and Status are
// permanent — always present on every sheet. "Learning", "Timeline", and "Scheduled Events"
// still only appear once they're actually needed. This is also now the COMPLETE, fixed list of
// every category that is allowed to exist — see isRecognizedCategory below. The story/AI can no
// longer invent a new category outside this list: sanitizePanel strips any that already exist on
// a saved sheet, and mergePanelUpdate refuses to create new ones going forward.
const CATEGORY_ORDER = [
  /^identity/i,
  /^finance/i,
  /^inventory/i,
  /^skills?(\s|&|$)/i,
  /^learning$/i,
  /^timeline$/i,
  /^scheduled\s*events?/i,
  /^status$/i,
  /^relationships?$/i,
  /^milestones?$/i,
];
function categoryOrderRank(name){
  const i = CATEGORY_ORDER.findIndex(re => re.test(String(name).trim()));
  return i === -1 ? CATEGORY_ORDER.length : i;
}
// ---------- fixed category allow-list ----------
// Only the categories matched by CATEGORY_ORDER above are permitted on the Letter of Records.
// Anything else is a story/AI-invented category and is no longer allowed: sanitizePanel strips
// any that already exist on a saved sheet, and mergePanelUpdate refuses to create new ones.
function isRecognizedCategory(name){
  return categoryOrderRank(name) !== CATEGORY_ORDER.length;
}
// ---------- Letter of Records: bottom tab groups ----------
// Splits the sheet into four switch-view tabs (see #panelTabBar) instead of one long scroll.
// Tab 1: Identity, Timeline, Status, and Scheduled Events (normally hidden from the main sheet
// via SCHED_CAT_RE — renderPanelHtml's tabFilter branch below deliberately lets it back in here).
// Tab 2: Finances + Inventory. Tab 3: Skills & Abilities + Learning. Tab 4 is the catch-all —
// Relationships and Milestones (the fixed category list no longer allows anything else to exist).
function panelTabForCategory(name){
  const n = String(name || '').trim();
  if(/^identity/i.test(n) || /^timeline$/i.test(n) || /^status$/i.test(n) || SCHED_CAT_RE.test(n)) return 1;
  if(/^finance/i.test(n) || /^inventory/i.test(n)) return 2;
  if(/^skills?(\s|&|$)/i.test(n) || /^learning$/i.test(n)) return 3;
  return 4;
}
// Note: stray near-duplicate categories (e.g. "Inventory Description" alongside the real
// "Inventory", or a Milestones-style list misnamed like "Milestones (Scheduled Events)") used to
// be handled here by hiding them from display/AI context while leaving the duplicate data sitting
// untouched in storage forever. That's now handled once, at load time, by actually merging or
// deleting the stray data — see hasUnrecognizedCategories and mergeStrayInventoryCategories,
// called from getPanel — so there's nothing left to filter out here anymore.
function orderedCategoryEntries(panel){
  return Object.entries(panel.categories || {})
    .map((entry, idx) => ({ entry, idx, rank: categoryOrderRank(entry[0]) }))
    .sort((a,b) => a.rank - b.rank || a.idx - b.idx)
    .map(x => x.entry);
}
function panelToText(panel){
  return orderedCategoryEntries(panel).map(([name, cat])=>{
    if(cat.type==='kv'){
      const entries = Object.entries(cat.data);
      return `${name}: ${entries.length ? entries.map(([k,v])=>`${k}: ${v}`).join(', ') : '(none yet)'}`;
    }
    if(cat.type==='list'){
      return `${name}: ${cat.data.length ? cat.data.join(', ') : '(none yet)'}`;
    }
    return `${name}: ${cat.data || '(none yet)'}`;
  }).join('\n');
}
// ---------- deterministic (non-AI) consistency check: memory vs. panel ----------
// The panel ("letter of records") holds the exact tracked number for any kv stat (money,
// item counts, etc.) — it's the arithmetic-strict source of truth. Memory is free-text
// bullets written by the AI and can drift (e.g. still says "900 ryo" after the panel was
// correctly updated to 700). This scans memory for the same key name and, if a nearby
// number doesn't match the panel's value, rewrites it in place. Pure string/regex work —
// no AI call, no tokens spent — so it can run on every read/update for free.
function crossCheckMemoryAgainstPanel(memory, panel){
  if(!memory || !panel || !panel.categories) return memory;
  let corrected = memory;
  let changed = false;
  for(const cat of Object.values(panel.categories)){
    if(cat.type !== 'kv') continue;
    for(const [key, value] of Object.entries(cat.data)){
      const valStr = String(value);
      const numMatch = valStr.match(/-?\d[\d,]*\.?\d*/);
      if(!numMatch) continue; // only cross-check stats that are actually numeric/quantities
      const panelNum = numMatch[0].replace(/,/g, '');
      const escKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Look for "<key> ... <number>" within a short window on the same line — memory
      // bullets are short (3-5 words), so a tight window avoids matching an unrelated number.
      const re = new RegExp(`(${escKey})([^\\n\\d]{0,15})(-?\\d[\\d,]*\\.?\\d*)`, 'gi');
      corrected = corrected.replace(re, (full, k, mid, num) => {
        const cleanNum = num.replace(/,/g, '');
        if(cleanNum !== panelNum){
          changed = true;
          console.warn(`[cross-check] memory had "${k}${mid}${num}" but the letter of records says ${key}: ${valStr} — correcting to match.`);
          return `${k}${mid}${panelNum}`;
        }
        return full;
      });
    }
  }
  return changed ? corrected : memory;
}
// Display-only helper for the Letter of Records: reduces a Relationships entry's full,
// running-history value down to a short standing label (its leading clause) — the full text
// itself is never touched, just not all shown inline on the main sheet. See relInfoModal for
// where the complete text still lives, one tap away.
function relationshipShortLabel(fullText){
  const s = String(fullText||'').trim();
  if(!s) return '(none yet)';
  const firstClause = s.split(/[,;.]/)[0].trim();
  const words = firstClause.split(/\s+/).filter(Boolean);
  if(words.length && words.length <= 6) return firstClause;
  return words.slice(0, 4).join(' ') + (words.length > 4 ? '…' : '');
}
function renderPanelSection(title, innerHtml, extraHeaderHtml){
  const headerHtml = !title ? (extraHeaderHtml || '')
    : (extraHeaderHtml
      ? `<div class="panel-sec-title-row" style="display:flex;align-items:center;justify-content:space-between;gap:8px;"><div class="panel-sec-title">${title}</div>${extraHeaderHtml}</div>`
      : `<div class="panel-sec-title">${title}</div>`);
  return `<div class="panel-section">${headerHtml}${innerHtml}</div>`;
}
function renderPanelHtml(panel, opts){
  opts = opts || {};
  const invPendingMerge = opts.pendingMerge || null;
  // Once a category exists it stays visible, even with nothing in it right now — it only
  // ever shows a "(none yet)" placeholder rather than disappearing, so sections don't
  // flicker in and out as their contents change turn to turn. A category is only ever
  // absent if it was genuinely never created in the first place.
  // Scheduled Events is tracked and updated exactly as before (the AI still sees and writes
  // to it every turn, and the separate system-tool sched list still shows it in full) — it's
  // just suppressed from the Letter of Records display itself, per request, since dated
  // entries read as clutter on the character sheet. Purely a render-time filter.
  const filteredEntries = orderedCategoryEntries(panel).filter(([name])=> opts.tabFilter ? panelTabForCategory(name) === opts.tabFilter : !SCHED_CAT_RE.test(name));
  const sections = filteredEntries.map(([name, cat])=>{
    let inner;
    let headerExtra = '';
    const isInventoryCat = cat.type==='list' && /^inventory/i.test(String(name).trim());
    // On the main Letter of Records, the Inventory title gets a small "expand" button that
    // opens the dedicated, larger-size Inventory-only page (see openInventoryModal) — handy
    // once a run has enough items that the cramped panel space makes dragging-to-merge
    // fiddly. Suppressed when rendering that very page itself (opts.showInvExpandBtn===false),
    // since there's nothing further to expand to from there.
    if(isInventoryCat && opts.showInvExpandBtn !== false){
      headerExtra = `<button type="button" class="panel-inv-expand-btn" title="Expand inventory" aria-label="Expand inventory"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg></button>`;
    }
    const chipsClass = isInventoryCat
      ? `panel-chips inv-grid${opts.largeChips ? ' chips-lg' : ''}`
      : 'panel-chips';
    const isRelationshipsCat = cat.type==='kv' && /^relationships?$/i.test(String(name).trim());
    if(cat.type==='kv'){
      const entries = Object.entries(cat.data);
      inner = entries.length
        ? entries.map(([k,v])=>{
            // Relationships: the full value (often several clauses of running history) stays
            // exactly as stored — the AI still reads/writes the complete text every turn —
            // but the Letter of Records only ever shows a short one-or-two-word standing
            // (its leading clause, e.g. "Academy classmate", "Sensei") next to the name.
            // Tapping the name opens the full text in #relInfoModal. Display-only split.
            if(isRelationshipsCat){
              const label = relationshipShortLabel(v);
              return `<div class="panel-row panel-rel-row">
                <span class="panel-k panel-rel-name" data-rel-name="${escapeHtml(k)}" data-rel-full="${escapeHtml(String(v))}">${escapeHtml(k)}</span>
                <span class="panel-v panel-rel-label">${escapeHtml(label)}</span>
              </div>`;
            }
            // A skill/ability tracked as a plain "NN%" value gets a progress bar instead of
            // a flat row — this is what makes learning-progress feel like actual training
            // building toward mastery, rather than a static label.
            const m = /^(\d{1,3})\s*%$/.exec(String(v).trim());
            if(m){
              const pct = Math.max(0, Math.min(100, parseInt(m[1], 10)));
              const mastered = pct >= 100;
              return `<div class="panel-skill-row">
                <div class="panel-skill-head"><span class="panel-k">${escapeHtml(k)}</span><span class="panel-skill-pct${mastered?' is-mastered':''}">${mastered ? 'Mastered' : pct+'%'}</span></div>
                <div class="panel-skill-bar"><div class="panel-skill-fill${mastered?' is-mastered':''}" style="width:${pct}%"></div></div>
              </div>`;
            }
            return `<div class="panel-row"><span class="panel-k">${escapeHtml(k)}</span><span class="panel-v">${escapeHtml(String(v))}</span></div>`;
          }).join('')
        : `<div class="panel-empty">(none yet)</div>`;
    }else if(cat.type==='list'){
      // [TL-6] TIMELINE-EVENTS-MODULE — rendering. Scheduled Events entries are permanent —
      // never removed once added (see guardScheduledEvents/paintSched, both up in the main
      // TIMELINE-EVENTS-MODULE block) — so a passed one is only ever shown dimmed here,
      // computed purely from comparing its own "Day N" against the sheet's own Current Day,
      // never from anything the story/AI narrated or triggered. This lives here (inline,
      // not moved up with the rest of the module) because it's one small piece of a function
      // that renders every OTHER category too, not something that could be pulled out on
      // its own without splitting renderPanelHtml itself.
      const isSchedCat = SCHED_CAT_RE.test(name);
      let currentDayForSched = null;
      if(isSchedCat){
        for(const c of Object.values(panel.categories || {})){
          if(c.type !== 'kv') continue;
          for(const [k, v] of Object.entries(c.data || {})){
            if(!CURRENT_DAY_KEY_RE.test(k)) continue;
            const n = parseInt(String(v).replace(/[^\d]/g,''), 10);
            if(!isNaN(n)) currentDayForSched = n;
          }
        }
      }
      // Same long-list treatment as Inventory below — Skills & Abilities and Scheduled
      // Events are the other two categories that tend to grow long over a run.
      const isSkillsCat = /^skills\s*(&|and)\s*abilities/i.test(String(name).trim());
      // Drag-to-merge lives ONLY on the dedicated Inventory-only page now (opts.enableMerge),
      // opened via the expand button — the main Letter of Records shows Inventory as plain,
      // static chips with no data-id, no merge bar, and no drag wiring at all. Every other
      // list category (Skills, Milestones, Scheduled Events, etc.) is unaffected either way.
      const mergeActive = isInventoryCat && !!opts.enableMerge;
      // Computed unconditionally now (not just when merge is active) — the visible "#N" number
      // below is shown on the plain, static Letter of Records chips too, not only on the
      // dedicated drag-to-merge Inventory page.
      const invIds = Array.isArray(cat.ids) ? cat.ids : [];
      const mergeHintHtml = (mergeActive && !invPendingMerge && cat.data && cat.data.length > 1)
        ? `<div class="panel-merge-hint">Long-press and drag one item onto another to merge them</div>`
        : '';
      // On the main Letter of Records, a long Inventory, Skills & Abilities, or Scheduled
      // Events list is capped to its first COLLAPSE_LIMIT chips with the rest tucked behind
      // a "show more" toggle — purely a rendering split, the underlying cat.data/ids arrays
      // and every bit of merge/edit/guard logic are untouched either way. Inventory only
      // collapses on the main sheet (not the dedicated drag-to-merge Inventory page, where
      // every item needs to stay reachable for merging).
      const COLLAPSE_LIMIT = 10;
      const collapsible = isSkillsCat || isSchedCat;
      const collapseInv = collapsible && cat.data && cat.data.length > COLLAPSE_LIMIT;
      inner = mergeHintHtml + ((cat.data && cat.data.length)
        ? `<div class="${chipsClass}">${cat.data.map((it, i)=>{
            const itemId = invIds[i] || '';
            // A pending merge hides the dragged-away source item entirely, and renders the
            // confirm bar right where the DROP TARGET item used to sit — so confirming reads
            // as "this slot became the merged item" instead of a bar floating at the top of
            // the whole list, detached from where the merge actually happened.
            if(mergeActive && invPendingMerge && itemId === invPendingMerge.a.id) return '';
            if(mergeActive && invPendingMerge && itemId === invPendingMerge.b.id){
              // Two mechanical name orderings — dragged-item-first and target-item-first —
              // since which reads more naturally ("Poison Knife" vs "Knife Poison") depends
              // entirely on the two item names and isn't worth a slow AI round-trip to guess
              // at. Deduped into a single option when both orderings land on the same text.
              const optA = autoMergeName(invPendingMerge.a.label, invPendingMerge.b.label);
              const optB = autoMergeName(invPendingMerge.b.label, invPendingMerge.a.label);
              const options = (optB && optB !== optA) ? [optA, optB] : [optA];
              const selected = invPendingMerge.name || optA;
              return `<div class="panel-chip panel-merge-bar">
                   <div class="panel-merge-options">${options.map(opt=>
                     `<button type="button" class="panel-merge-option${opt===selected ? ' is-selected' : ''}" data-name="${escapeHtml(opt)}">${escapeHtml(opt)}</button>`
                   ).join('')}</div>
                   <div class="panel-merge-actions">
                     <button type="button" class="panel-merge-confirm" title="Confirm merge">✓</button>
                     <button type="button" class="panel-merge-cancel" title="Cancel">✕</button>
                   </div>
                 </div>`;
            }
            // Display-level safety net: if a stray negative quantity is already sitting in
            // saved data from before the guard existed, never show it as negative — floor it
            // at 0 on render too, not just on future writes.
            const m = /^(-[\d,]+)\s*(.*)$/.exec(String(it).trim());
            const text = m ? `0 ${m[2]}`.trim() : it;
            // An item may carry an optional " — status" suffix (equipped/worn/used up/etc.) —
            // split it into its own softer-styled span so it reads as a note on the item
            // rather than part of the item's name itself. Scheduled Events entries are
            // EXEMPT from this split: their own required "Day N — description" shape uses
            // the exact same em dash as the separator, so without this exemption every
            // scheduled event got its actual description (the important part) silently
            // demoted into a dim, italic "status" suffix while just "Day N" was left as the
            // bold main label — the opposite of what a reader actually needs to see at a
            // glance. paintSched (the system-tool sched list) already shows the full text
            // unsplit; this keeps the full letter-of-records panel consistent with that.
            const parsedDay = isSchedCat ? parseDayEntry(it) : null;
            const isPast = isSchedCat && parsedDay && currentDayForSched != null && parsedDay.day <= currentDayForSched;
            const dashIdx = isSchedCat ? -1 : findItemStatusDashIndex(text); // accepts en dash too — see splitItemEntry fix
            const label = dashIdx === -1 ? text : text.slice(0, dashIdx).trim();
            const status = dashIdx === -1 ? null : text.slice(dashIdx+1).trim();
            // Targeted by the item's own hidden ID (not its position or text), same as the
            // "system bro" tap-to-remove list, so a drag always resolves to exactly the
            // entry dragged even with duplicate wording or the list shifting underneath.
            // Only present when merge is active (the dedicated Inventory page) — on the main
            // panel, chips carry no id/drag affordance at all.
            const idAttr = mergeActive ? ` data-id="${escapeHtml(itemId)}" data-label="${escapeHtml(label)}"` : '';
            // Visible "#N" — the same permanent per-item number, derived straight from the
            // item's own hidden ID (see genInvId/numFromId). This number is fixed for the
            // life of the entry — it identifies WHICH stack this is, never how many are in
            // it. The quantity is the opposite: pulled fresh from `label` on every render, so
            // using 5 of 10, or merging units in one at a time, updates the count in place —
            // same #N, different number right next to it — instead of looking like a second,
            // conflicting "count" baked into the tag itself.
            const dispNum = isInventoryCat ? numFromId(itemId) : null;
            const numHtml = dispNum ? `<span class="panel-chip-num" style="opacity:.5;font-weight:600;margin-right:4px;">#${dispNum}</span>` : '';
            const parsedLabel = isInventoryCat ? splitItemEntry(label) : null;
            const hasQty = parsedLabel && parsedLabel.qty != null && !isNaN(parsedLabel.qty);
            const nameOnly = hasQty ? parsedLabel.name : label;
            const qtyHtml = hasQty ? `<span class="panel-chip-qty" style="opacity:.65;margin-left:5px;font-weight:600;">×${parsedLabel.qty.toLocaleString('en-US')}</span>` : '';
            // Status is still tracked/parsed (guards, the merge-name logic, and the Inventory
            // info modal's grouped "Current Items" view all still rely on it) — it's just no
            // longer shown inline on the Letter of Records chip itself for Inventory, per
            // request. Every other list category keeps showing its status suffix as before.
            const labelHtml = `${numHtml}${escapeHtml(nameOnly)}${qtyHtml}${(status && !isInventoryCat) ? `<span class="panel-chip-status">${escapeHtml(status)}</span>` : ''}`;
            // Per-item delete used to live here as a "✕" cross on the dedicated Inventory-only
            // (mergeActive) page — moved to the long-press action sheet on the main Letter of
            // Records view instead (see deleteInventoryItemById + the itemActionSheet wiring
            // further down), so it's no longer rendered on either card style.
            const delBtn = '';
            // Inventory items render as photo-backed cards (a fixed-height slot with the
            // item's own snapshot filling it, the name always visible underneath) instead
            // of flowing text pills. A permanent #N corner tag and a stack-count badge sit
            // on top of the image (the status suffix is tracked/parsed as before for guards
            // and the merge-name logic, but no longer shown on the card itself — the corner
            // is reserved for the qty badge only). Long-pressing a card (main Letter of
            // Records view only — see data-photo-editable below) opens the photo picker for
            // that item; the dedicated drag-to-merge Inventory page shows the same card
            // read-only so it never fights with its own long-press-to-drag gesture. Every
            // other list category (Skills, Scheduled Events, etc.) is untouched and keeps
            // the original plain-text chip look.
            const photoUrl = isInventoryCat && panel.photos ? panel.photos[itemId] : null;
            const photoEditable = isInventoryCat && !mergeActive;
            const chipHtml = isInventoryCat
              ? `<span class="panel-chip inv-slot${isPast ? ' is-past' : ''}"${idAttr} data-item-id="${escapeHtml(itemId)}"${photoEditable ? ' data-photo-editable="1"' : ''} data-slot-name="${escapeHtml(nameOnly)}${hasQty ? ' ×' + parsedLabel.qty.toLocaleString('en-US') : ''}" data-status="${escapeHtml(status || '')}">
                   <span class="inv-slot-main">
                     <span class="inv-slot-img${photoUrl ? ' has-photo' : ''}">
                       <img class="inv-slot-photo" alt=""${photoUrl ? ` src="${escapeHtml(photoUrl)}"` : ''}>
                       ${numHtml}
                       ${hasQty ? qtyHtml : ''}
                       <span class="inv-slot-icon">${escapeHtml(invSlotGlyph(nameOnly))}</span>
                     </span>
                     <span class="inv-slot-info">
                       <span class="inv-slot-name">${escapeHtml(nameOnly)}</span>
                     </span>
                   </span>
                   ${delBtn}
                 </span>`
              : (mergeActive
                ? `<span class="panel-chip${isPast ? ' is-past' : ''}"${idAttr}><span class="panel-chip-label">${labelHtml}</span>${delBtn}</span>`
                : `<span class="panel-chip${isPast ? ' is-past' : ''}">${labelHtml}</span>`);
            // The wrapper that tucks everything past the first page away starts right
            // before the (COLLAPSE_LIMIT+1)th chip — closed again once the map is done,
            // below.
            return (collapseInv && i === COLLAPSE_LIMIT) ? `<span class="panel-inv-hidden-chips" hidden>${chipHtml}` : chipHtml;
          }).join('')}${collapseInv ? '</span>' : ''}</div>${collapseInv ? `<button type="button" class="panel-inv-toggle-btn" data-count="${cat.data.length - COLLAPSE_LIMIT}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg><span class="panel-inv-toggle-label">Show ${cat.data.length - COLLAPSE_LIMIT} more</span></button>` : ''}`
        : `<div class="panel-empty">(none yet)</div>`);
    }else{
      inner = cat.data
        ? `<div class="panel-status">${escapeHtml(cat.data)}</div>`
        : `<div class="panel-empty">(none yet)</div>`;
    }
    return renderPanelSection(opts.hideSectionTitle ? '' : escapeHtml(name), inner, headerExtra);
  });
  // Equip compass: a read-only visual summary of Inventory's own on-body statuses (currently
  // just "Equipped" — see EQUIP_ON_BODY_STATUSES), inserted directly after the Inventory
  // section it summarizes — so on the Finances+Inventory tab the order reads Finances, then
  // the full Inventory list, then this. Skipped on the dedicated drag-to-merge Inventory-only
  // page (opts.enableMerge) and anywhere the section title itself is hidden, since there
  // Inventory is the only thing on screen and the compass would just be a second, redundant
  // Inventory display crowding an already tight layout.
  if(!opts.enableMerge && !opts.hideSectionTitle){
    const invIdx = filteredEntries.findIndex(([name, cat]) => cat.type==='list' && /^inventory/i.test(String(name).trim()));
    if(invIdx !== -1){
      const invCatForEquip = filteredEntries[invIdx][1];
      const equipHtml = renderPanelSection('Equip', renderEquipCompassHtml(invCatForEquip.data, invCatForEquip.ids, panel.photos));
      sections.splice(invIdx + 1, 0, equipHtml);
    }
  }
  const joined = sections.join('');
  return joined || `<div class="panel-empty">Nothing tracked yet — this fills in as the story continues.</div>`;
}

// lightweight markdown for the OOC "system" assistant: **bold** + "- " bullet lists + paragraphs
function renderMarkdownLite(raw){
  const escaped = escapeHtml(raw||'');
  const bolded = escaped.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  const lines = bolded.split('\n');
  let html = ''; let inList = false;
  for(const line of lines){
    const t = line.trim();
    if(/^[-•]\s+/.test(t)){
      if(!inList){ html += '<ul>'; inList = true; }
      html += `<li>${t.replace(/^[-•]\s+/, '')}</li>`;
    }else{
      if(inList){ html += '</ul>'; inList = false; }
      if(t) html += `<p>${t}</p>`;
    }
  }
  if(inList) html += '</ul>';
  return html;
}

// ================= PRE-SEND CLAIM CHECKERS =================
// Everything that scans the player's outgoing message against the sheet before it's
// sent to the story: Layer 1 deterministic regex/math checks (currency/inventory/
// ability), Layer 2's AI read step for disguised/implied claims, checkClaimAgainstRecords
// tying both together, and the composer hookup (sendMessage) that calls it.

// ---------- deterministic (non-AI) check: currency claims in a new message ----------
// Small/lite models are unreliable at exact arithmetic — asking one "is 200 more than
// 51560?" can and did come back wrong (see: false "not enough funds" warning even though
// the sheet clearly listed far more than enough). So any numeric/currency comparison is
// done here with plain math against the panel's real tracked number instead of asking the
// AI to eyeball it. Pure string/regex work, same approach as crossCheckMemoryAgainstPanel.
// ---------- number-word normalization for the pre-send checks below ----------
// checkCurrencyClaim/checkInventoryClaim only ever look for DIGITS near a key name — a player
// typing "I pay five hundred gold" with only 100 Gold on the sheet was never caught here at
// all (no digit to find), even though the exact same overspend typed as "500 gold" is caught
// immediately. This doesn't fix that by teaching those functions English number words; instead
// it rewrites recognizable spelled-out number runs into their digit form BEFORE the existing
// digit-based regexes ever see the text, so "five hundred gold" reads exactly like "500 gold"
// with no other code needing to change. Deliberately narrow — covers ones/teens/tens combined
// with "hundred"/"thousand" (the forms a player actually types), not a full language parser;
// anything more irregular ("a couple hundred", "half a dozen") still isn't caught here, same as
// before — the AI-side HARD LIMIT rule and the post-response guards remain the real backstop.
const NUMBER_WORDS_MAP = {
  zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10,
  eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16, seventeen:17,
  eighteen:18, nineteen:19, twenty:20, thirty:30, forty:40, fifty:50, sixty:60, seventy:70,
  eighty:80, ninety:90
};
function wordRunToNumber(words){
  let total = 0, current = 0;
  for(const w of words){
    if(w in NUMBER_WORDS_MAP){ current += NUMBER_WORDS_MAP[w]; }
    else if(w === 'hundred'){ current = (current || 1) * 100; }
    else if(w === 'thousand'){ total += (current || 1) * 1000; current = 0; }
    else return null; // unrecognized word in the run — bail rather than guess
  }
  return total + current;
}
const NUMBER_WORD_RUN_RE = new RegExp(
  '\\b(?:' + Object.keys(NUMBER_WORDS_MAP).join('|') + '|hundred|thousand)' +
  '(?:[\\s-]+(?:' + Object.keys(NUMBER_WORDS_MAP).join('|') + '|hundred|thousand))*\\b', 'gi'
);
function normalizeNumberWords(text){
  return String(text || '').replace(NUMBER_WORD_RUN_RE, (m) => {
    const n = wordRunToNumber(m.toLowerCase().split(/[\s-]+/));
    return n == null ? m : String(n);
  });
}

function checkCurrencyClaim(userText, panel){
  if(!panel || !panel.categories) return null;
  const spendWords = /\b(pay|paid|paying|pays|spend|spent|spending|hand(?:ed|ing)?\s*over|bought|buy|buying|purchas(?:e|ed|es|ing)|cost|charged|owe[ds]?|exchang(?:e|ed|es|ing)?|trad(?:e|ed|es|ing)|swap(?:s|ped|ping)?|convert(?:s|ed|ing)?|giv(?:e|es|ing)|gave|given|donat(?:e|ed|es|ing)|offer(?:s|ed|ing)?|tip(?:s|ped|ping)?|toss(?:es|ed|ing)?|drop(?:s|ped|ping)?|bet(?:s|ting)?|wager(?:s|ed|ing)?|gambl(?:e|ed|es|ing)|invest(?:s|ed|ing)?|deposit(?:s|ed|ing)?|withdraw(?:s|n|ing)?|withdrew)\b/i;
  if(!spendWords.test(userText)) return null; // only relevant if the message claims to spend/pay something
  for(const cat of Object.values(panel.categories)){
    if(cat.type !== 'kv') continue;
    for(const [key, value] of Object.entries(cat.data)){
      const valStr = String(value);
      const numMatch = valStr.match(/-?\d[\d,]*\.?\d*/);
      if(!numMatch) continue; // only check stats that are actually numeric amounts (money, counts)
      const trackedNum = parseFloat(numMatch[0].replace(/,/g, ''));
      const escKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Match "<key> ... <number>" or "<number> ... <key>" within a short window, in either order
      // (e.g. "paid 200 ryo" or "ryo cost of 200"). Connector text is captured separately so we
      // can tell direction apart in an exchange.
      const re = new RegExp(`(?:\\b${escKey}\\b)([^\\d\\n]{0,20})(-?\\d[\\d,]*\\.?\\d*)|(-?\\d[\\d,]*\\.?\\d*)([^\\d\\n]{0,20})(?:\\b${escKey}\\b)`, 'gi');
      let m;
      while((m = re.exec(userText))){
        const raw = m[2] || m[3];
        if(!raw) continue;
        if(m[3] != null){
          // number-before-key match (e.g. "100 gold", "100 silver for gold", "apples for
          // 200 gold"). <key> is what the player is RECEIVING, not spending, if "for" sits
          // anywhere between the number and <key> — even with another currency name in
          // between, as in a two-currency exchange sentence — OR if "for" directly
          // introduces the number itself. Either way this number is never a claim to
          // already have <key>, so it must not be checked as an overspend on <key>; only
          // the currency actually being given up should be.
          const connector = m[4] || '';
          const precedingText = userText.slice(Math.max(0, m.index - 15), m.index);
          if(/\bfor\b/i.test(connector) || /for\s*$/i.test(precedingText)) continue;
        }
        if(m[1] != null){
          // key-before-number match (e.g. "gold for 5 kunai") — the number belongs to
          // whatever comes after "for" (kunai), not to <key> (gold), so it's never a claim
          // to be spending that many <key>. Same reasoning as the block above, mirrored.
          const connector = m[1] || '';
          if(/\bfor\b/i.test(connector)) continue;
        }
        const claimedNum = parseFloat(raw.replace(/,/g, ''));
        if(!isNaN(claimedNum) && claimedNum > trackedNum){
          return `You only have ${valStr} ${key}, not ${raw}.`;
        }
      }
    }
  }
  return null;
}

// ---------- deterministic (non-AI) check: inventory claims in a new message ----------
// Same reasoning as checkCurrencyClaim — don't trust a small AI model to compare
// quantities. Inventory entries are free text like "3x Kunai", "Kunai x3", "1,000 gold
// pouch", or just "Rusty Sword" with no count at all. This pulls a count + bare name out
// of each entry where possible.
//
// Delegates to splitItemEntry (the same parser every other inventory guard uses) rather
// than parsing the raw string independently. Previously this had its own regex that never
// stripped a " — <status>" suffix (e.g. "3 kunai — Poisoned" parsed to name "kunai —
// poisoned"), which then polluted textMentionsItem's word-matching below: the status word
// itself ("poisoned") counted as a match, so a message about an entirely different
// poisoned item could wrongly be checked against this one's count. Reusing splitItemEntry
// keeps the name clean of its status, exactly like the panel display and every write-side
// guard already treat it.
function parseInventoryEntry(entry){
  const { qty, name } = splitItemEntry(entry);
  return { count: qty, name: name.toLowerCase() };
}
// True if userText plainly mentions this item (matches one of its meaningful words) — used
// both to whitelist an obviously-owned item and to find a number attached to its claimed use.
function textMentionsItem(userText, itemName){
  const stop = new Set(['the','and','of','pouch','bag','a','an']);
  const words = itemName.split(/\s+/).filter(w => w.length > 2 && !stop.has(w));
  if(!words.length) return false;
  return words.some(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`, 'i').test(userText));
}
// Returns a warning string only when a message claims to use MORE of a counted item than
// the sheet lists (plain math, e.g. "throw 5 kunai" vs a sheet that only has 3) — it never
// tries to guess whether an entirely unnamed/uncounted item is "allowed", since that's not
// something regex can safely judge; that ambiguous case is left to the AI check below.
// Verbs that mean the item is being GAINED, not spent/used — shared by both the regex check
// below and the AI-claim backstop (claimLooksAcquired) further down the file. Buying, finding,
// looting, crafting, or being given an item is never a claim to already possess it, so a
// number/name match near one of these must never be read as an overspend or "missing item".
const ACQUIRE_VERBS_SRC = 'buy[s]?|buying|bought|purchas(?:e[sd]?|ing)|find[s]?|finding|found|pick(?:s|ed|ing)?\\s*up|loot(?:s|ed|ing)?|craft(?:s|ed|ing)?|receiv(?:e[sd]?|ing)|given|handed|gifted|awarded|win[s]?|winning|won|get[s]?|getting|got|obtain(?:s|ed|ing)?|acquir(?:e[sd]?|ing)|earn(?:s|ed|ing)?|collect(?:s|ed|ing)?';
function checkInventoryClaim(userText, panel){
  if(!panel || !panel.categories) return null;
  for(const cat of Object.values(panel.categories)){
    if(cat.type !== 'list' || !Array.isArray(cat.data)) continue;
    for(const entry of cat.data){
      const { count, name } = parseInventoryEntry(entry);
      if(!name || count == null || !textMentionsItem(userText, name)) continue;
      for(const w of name.split(/\s+/).filter(w=>w.length>2)){
        const escW = w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
        const re = new RegExp(`(\\d[\\d,]*)\\s*(?:x\\s*|of\\s+(?:my|the|his|her|their|its)\\s+)?${escW}|${escW}([^\\d\\n]{0,10})(\\d[\\d,]*)`, 'gi');
        let m;
        while((m = re.exec(userText))){
          const raw = m[1] || m[3];
          if(!raw) continue;
          // Buying/finding/being given the item is gaining something new, never a claim to
          // already have it — never counted as an overspend regardless of which side of the
          // number the item name falls on. Same reasoning as the "for" exchange guards below,
          // just widened to catch acquisition phrasing specifically.
          const wideBefore = userText.slice(Math.max(0, m.index - 40), m.index + m[0].length);
          if(new RegExp(`\\b(?:${ACQUIRE_VERBS_SRC})\\b`, 'i').test(wideBefore)) continue;
          if(m[1] != null){
            // The number precedes the item name directly ("3 kunai") — but in an exchange
            // ("...exchange 50 gold for 3 kunai") that names the item as what's being
            // ACQUIRED, not something the player already has and is claiming to use. Only
            // treat it as a use/spend claim when it isn't introduced by "for".
            const precedingText = userText.slice(Math.max(0, m.index - 12), m.index);
            if(/for\s*(?:a\s+|an\s+|the\s+)?$/i.test(precedingText)) continue;
          }
          if(m[3] != null){
            // The number follows the item name ("kunai for 5 gold") — here the item name
            // isn't what the number counts at all, it's the currency named right after
            // "for". Skip when the connector text between the item name and the number
            // contains "for", same reasoning mirrored from the case above.
            const connector = m[2] || '';
            if(/\bfor\b/i.test(connector)) continue;
          }
          const claimed = parseFloat(raw.replace(/,/g,''));
          if(!isNaN(claimed) && claimed > count) return `You only have ${count} ${name}, not ${claimed}.`;
        }
      }
    }
  }
  return null;
}

// ---------- deterministic (non-AI) check: ability/item/power "claim not on the sheet" ----------
// Earlier version of this check asked a lite background model "is this claim on the sheet?"
// — reliable enough, but it's still a network call and a token spend on every single message
// sent. This replaces it with pure regex/string matching, same philosophy as
// checkCurrencyClaim/checkInventoryClaim above: compare the player's own words against the
// panel's real tracked data directly, no model in the loop at all.
//
// Deliberately conservative — same rule the rest of this file follows: when regex can't be
// sure, it stays silent rather than risk blocking a legitimate message. Concretely that means
// this only flags a claim when BOTH are true:
//   1. The player used a clear "I'm doing this right now" action verb (use, cast, invoke,
//      wield, summon, equip, etc.) immediately followed by a Title-Cased phrase — the way a
//      named jutsu/spell/item/power actually gets typed in play ("I use my Chidori", "I cast
//      Fireball Jutsu"). Lowercase, generic phrasing ("I use my hands", "I use my sword arm")
//      never matches the capture pattern at all, so it's never at risk of a false block.
//   2. None of the claimed phrase's meaningful words appear anywhere in the full letter of
//      records text — so a real, already-listed ability/item (however it's later referenced,
//      shortened, or re-cased) is never flagged just because the casing didn't line up
//      exactly.
// Currency and inventory-quantity math are still not this function's job — see
// checkCurrencyClaim / checkInventoryClaim above, which already cover those with their own
// stricter arithmetic.
const CLAIM_VERB_SRC = 'use[sd]?|using|cast[s]?|casting|activat(?:e[sd]?|ing)|unleash(?:es|ed)?|unleashing|invok(?:e[sd]?|ing)|wield[s]?|wielded|wielding|channel(?:s|ed|ling|ing)?|summon[s]?|summoned|summoning|perform[s]?|performed|performing|execut(?:e[sd]?|ing)|trigger(?:s|ed|ing)?|conjur(?:e[sd]?|ing)|equip[s]?|equipped|equipping|releas(?:e[sd]?|ing)|ignit(?:e[sd]?|ing)|detonat(?:e[sd]?|ing)|hurl(?:s|ed|ing)?|throw(?:s|ing)?|threw|brandish(?:es|ed|ing)?|materializ(?:e[sd]?|ing)|manifest(?:s|ed|ing)?|flare[sd]?|flaring|fir(?:e[sd]?|ing)|shoot[s]?|shooting|shot|draw[s]?|drawing|drew|swing[s]?|swinging|swung|strik(?:e[sd]?|ing)|struck|slash(?:es|ed)?|slashing|stab(?:s|bed|bing)?|launch(?:es|ed)?|launching|deploy(?:s|ed)?|deploying|access(?:es|ed)?|accessing|unlock(?:s|ed)?|unlocking';
// A short window of text immediately BEFORE a matched verb that means it isn't actually a
// present-tense claim at all: negation ("I don't use..."), future/conditional ("I will
// use...", "I might use..."), or an unconfirmed attempt ("I try to use..."). Any of these
// sitting right before the verb means this match gets skipped — same "when unsure, stay
// silent" rule the rest of this file follows. Without this, "I will NOT use my Rasengan"
// would get blocked for the exact opposite reason it should.
// The trailing alternative here — \b[a-z]+'(?:ll|d)\b — is a generic catch for contracted
// future/conditional tense ("I'll", "you'll", "we'd", "they'll", etc.). Without it, "I'll use
// my Rasengan" slipped through as a present-tense claim (only the spelled-out word "will" was
// covered, never the contraction), so a player just announcing future intent could get
// incorrectly flagged as claiming an ability right now.
const CLAIM_SKIP_BEFORE_SRC = "\\b(?:not|never|no|without|won'?t|wont|can'?t|cant|cannot|couldn'?t|wouldn'?t|shouldn'?t|didn'?t|doesn'?t|don'?t|will|would|could|might|may|should|try|tries|trying|tried|attempt|attempts|attempting|attempted|plan|plans|planning|planned|want|wants|wanting|wanted|about\\s+to|going\\s+to|gonna|if|imagine|imagining|consider|considering|wish|wishing|hope|hoping|pretend|pretending|think|thinks|thinking|thought)\\b|\\b[a-z]+'(?:ll|d)\\b";
// Words stripped out of a claimed phrase before checking it against the sheet — generic
// descriptors/pronouns/possessives/connectors that would otherwise make an unrelated phrase
// look "unmatched" (or, worse, look like a real name when it's really just filler — e.g. a
// capitalized sentence-leading "My" falling into the captured phrase alongside the real name).
//
// The ability/technique-category words below are deliberately genre-spanning rather than tied
// to any one fandom's vocabulary — martial-arts/anime terms (jutsu, technique, move, style,
// combo), fantasy magic terms (spell, enchantment, incantation, hex, curse, blessing, ritual),
// sci-fi/cyberpunk terms (program, protocol, routine, module, upgrade, hack, exploit), and
// generic RPG/superhero terms (skill, ability, power, perk, feat, trait, talent, buff, gift,
// mutation) all describe the SLOT/CATEGORY an ability sits in, not the ability's actual name —
// e.g. stripping "jutsu" from "Fireball Jutsu" or "spell" from "Ice Spell" still leaves the
// real name intact to check. Concrete item/weapon nouns (sword, bow, blade, wand, gun, device,
// artifact, relic, and the like) are deliberately NOT in this list, since for many sheets that
// noun IS the actual, specific inventory entry — stripping it would blind the check entirely.
const CLAIM_STRIP_WORDS = new Set([
  'jutsu','technique','techniques','skill','skills','ability','abilities','power','powers',
  'spell','spells','move','moves','attack','attacks','style','styles',
  'enchantment','enchantments','incantation','incantations','hex','hexes','curse','curses',
  'blessing','blessings','rite','rites','ritual','rituals','chant','chants',
  'program','programs','protocol','protocols','routine','routines','subroutine','subroutines',
  'algorithm','algorithms','module','modules','upgrade','upgrades','mod','mods','hack','hacks',
  'exploit','exploits','script','scripts',
  'gift','gifts','mutation','mutations','combo','combos','maneuver','maneuvers','manoeuvre','manoeuvres',
  'form','forms','stance','stances','perk','perks','feat','feats','trait','traits','talent','talents',
  'buff','buffs','trick','tricks','method','methods',
  'the','and','with','then','now','again','today','tomorrow','you','your','yours','i',"i'm",'im',
  'he','she','they','we','it','this','that','these','those','my','his','her','their','its','some','a','an'
]);
function claimPhraseWords(phrase){
  // Apostrophes are treated as separators, not kept inside tokens — otherwise a possessive
  // like "Kaito's" tokenizes to a distinct "kaito's" that never matches a sheet entry plainly
  // spelled "Kaito", producing a false "not on your sheet" flag on an already-known name.
  return phrase.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !CLAIM_STRIP_WORDS.has(w));
}
// Same word if identical, or if both are 5+ chars and share a 6-char prefix (duplicate/
// duplication) — short words stay exact-match-only so "fire" can't loosely match "dragon".
function sameWordRoot(a, b){
  if(a === b) return true;
  const minLen = Math.min(a.length, b.length);
  if(minLen < 5) return false;
  const prefixLen = Math.min(6, minLen - 1);
  return a.slice(0, prefixLen) === b.slice(0, prefixLen);
}
function claimWordKnown(word, knownWords){
  if(knownWords.has(word)) return true;
  for(const kw of knownWords){ if(sameWordRoot(word, kw)) return true; }
  return false;
}
// Every significant word typed must be traceable to something already on the sheet (with
// typo/plural tolerance via sameWordRoot). No length-based forgiveness for an unmatched word —
// that used to let a phrase of 4+ words get away with one unrecognized word no matter what it
// was, which meant a genuinely swapped-in word (e.g. "Dragon" in place of the sheet's actual
// "Breathing") was silently treated the same as a word the player simply left out. Dropping a
// word from the claim still passes fine on its own here, since a dropped word just isn't in
// `words` to begin with — it's only an unrecognized word that's actually present that now
// always fails the check, however long the phrase is.
function abilityWordsMatch(words, knownWords){
  if(!words.length) return false;
  return words.every(w => claimWordKnown(w, knownWords));
}
function checkAbilityClaim(userText, panel){
  if(!panel || !panel.categories) return null;
  const sheetText = panelToText(panel);
  if(!sheetText || !sheetText.trim()) return null; // nothing tracked yet — nothing to check against
  const knownWords = new Set(claimPhraseWords(sheetText));
  // Verb matching is case-insensitive on its own pass — a sentence-leading "Use Rasengan" or a
  // shouted "I USE RASENGAN" must still be caught, and plain case-sensitive matching missed
  // both entirely. The phrase-capture step below stays case-SENSITIVE against the ORIGINAL
  // text though: it needs real capitalization to tell a named ability apart from an ordinary
  // lowercase word, which is what keeps this whole check conservative.
  const verbRe = new RegExp(`\\b(?:${CLAIM_VERB_SRC})\\b`, 'gi');
  const skipRe = new RegExp(CLAIM_SKIP_BEFORE_SRC, 'i');
  // Phrase: optional determiner, then up to 5 lowercase filler/adjective words (non-greedy —
  // so "I unleash my ultimate forbidden ancient ruinous Rasengan" still finds "Rasengan"
  // instead of failing to match at all because of the words in between), then 1-5 Title-Case
  // words. The separator class (whitespace or light punctuation) between tokens tolerates a
  // verb followed directly by punctuation — "I use, without hesitation, my Excalibur" or
  // "I use: Excalibur" — which a bare \s+ requirement used to miss entirely.
  const SEP = '[\\s,;:\\u2013\\u2014-]+';
  const phraseRe = new RegExp(`^${SEP}(?:(?:my|a|an|the|some|his|her|their|its)${SEP})?(?:[a-z]+${SEP}){0,5}?((?:[A-Z][a-zA-Z'\u2019-]*\\s*){1,5})`);
  let vm;
  while((vm = verbRe.exec(userText))){
    const verbEnd = vm.index + vm[0].length;
    const before = userText.slice(Math.max(0, vm.index - 40), vm.index);
    if(skipRe.test(before)) continue; // negated / future / hypothetical / an attempt — not a claim
    const afterFull = userText.slice(verbEnd);
    const termIdx = afterFull.search(/[.!?\n]/);
    if(termIdx !== -1 && afterFull[termIdx] === '?') continue; // a question, not a claim
    const pm = phraseRe.exec(afterFull);
    if(!pm) continue;
    // ---------- ownership-signal gate ----------
    // Some of the newer verbs (draw, fire, launch, strike, access, unlock, ...) are common
    // in completely ordinary dialogue, and on their own a capitalized word right after one
    // is no evidence of an ability/item claim at all — it's just as likely to be an NPC's
    // name or a place ("I draw closer to Sasuke", "I launch into a story about Kaito").
    // Only treat this as a claim worth checking against the sheet when the phrasing actually
    // signals ownership: a possessive anywhere before the name ("my/his/her/their/its"), a
    // determiner sitting directly at the front with nothing else before it ("I cast A
    // Fireball spell"), or the classic bare form with nothing at all between the verb and
    // the name ("I cast Fireball Jutsu"). Everyday sentences that merely mention a
    // capitalized name after one of these verbs match none of the three and are left alone.
    const prefix = pm[0].slice(0, pm[0].length - pm[1].length);
    const prefixWords = prefix.toLowerCase().match(/[a-z]+/g) || [];
    const hasPossessive = /\b(?:my|his|her|their|its)\b/.test(prefix);
    const isBare = prefixWords.length === 0;
    const leadsWithArticle = prefixWords.length > 0 && /^(?:a|an|the|some)$/.test(prefixWords[0]);
    // A preposition or relational word anywhere in the gap ("at Kaito", "toward Sasuke",
    // "a map showing Konoha") means the article/adjectives actually belong to a different,
    // ordinary noun ("a glance", "some sarcasm", "a map") and the capitalized word is really
    // the object of that preposition — someone's name or a place, not an item being claimed.
    // "I cast a Fireball spell" has no such word in between; "I shoot a glance at Kaito" does.
    const RISKY_FILLER = /^(?:at|to|toward|towards|about|from|of|on|in|into|onto|upon|near|beside|behind|under|over|with|through|across|along|among|between|during|until|before|after|off|within|per|via|versus|vs|for|showing|featuring|depicting|mentioning|describing|involving|regarding|concerning|named|called)$/;
    const hasRiskyFiller = prefixWords.some(w => RISKY_FILLER.test(w));
    if(hasRiskyFiller || (!hasPossessive && !isBare && !leadsWithArticle)) continue;
    const phrase = pm[1].trim().replace(/\s+/g, ' ');
    const words = claimPhraseWords(phrase);
    if(!words.length) continue; // nothing specific enough left to check once filler is stripped
    const known = abilityWordsMatch(words, knownWords);
    if(!known) return `"${phrase}" isn't on your character sheet.`;
  }
  return null;
}

// ---------- AI read step: understand disguised/implied claims regex can't parse ----------
// This is the ONLY place in the whole claim-check pipeline that touches an AI model, and it
// is deliberately given no power to accept or reject anything. Its single job is to read the
// player's sentence and convert it into a plain structured list of claims — e.g. "my eyes
// turn red and start spinning" comes back the same as "I use my Sharingan":
//   {"type":"ability","name":"Sharingan"}
// That list is then handed to the small code-side checkers below (checkAbilityClaimFromAI /
// checkInventoryClaimFromAI / checkCurrencyClaimFromAI), which do the actual exact-match
// accept/reject decision against the letter of records — plain code, no AI judgment. This
// keeps the same "AI reads, code decides" split the regex checks above already use; it just
// extends coverage to phrasing regex genuinely can't catch.
//
// Returns an array of claims (possibly empty), or throws on any failure (bad key, timeout,
// unparseable reply) — the caller (checkClaimAgainstRecords) treats a throw as "couldn't scan
// this message" and blocks by default rather than silently letting an unscanned message through.
const CLAIM_READ_SYS_PROMPT = `You extract claims from a single roleplay message. A claim is the player stating, implying, or describing (however disguised) that their character is right now using or spending something they ALREADY possess: an ability/power, an item, or currency. You do NOT decide whether the claim is valid, on the character sheet, or affordable, and you do NOT match or rename it to anything on the reference sheet — extraction only, always in the player's own words exactly as they wrote them. That matching/judgment happens entirely in code afterward, not here.\n
Skip anything negated, hypothetical, future-tense, or merely a question ("I won't use it", "should I use my Sharingan?", "I might pay 50 gold").

CRITICAL for items: only extract an item claim when the player is USING, WIELDING, or SPENDING/CONSUMING an item they already have. Never extract an item claim when the player is instead ACQUIRING it for the first time — buying, purchasing, finding, picking up, looting, crafting, receiving, being given, being handed, winning, or being paid an item. Gaining something new is never a claim of prior possession and must never be checked against the inventory. "I buy a knife" / "I find a rusty key" / "the merchant hands me a potion" → skip entirely, do not extract. "I stab him with my knife" / "I use the rusty key to unlock the door" → extract, since that claims the item is already owned.

Output ONLY a raw JSON array, nothing else — no prose, no markdown fences. Each element must be one of:
  {"type":"ability","name":string}
  {"type":"item","name":string,"count":number|null}
  {"type":"currency","key":string,"amount":number}
If there are no claims in the message, output exactly: []`;

async function readClaimsFromInput(userText, sheetText){
  const prompt = `Reference sheet (for name-matching only):\n${sheetText || '(none)'}\n\nPlayer message:\n${userText}`;
  // Deliberately doesn't defer to getGeminiBgModel()/the single Settings dropdown here — this
  // check gates whether a message can be sent at all, so it tries BOTH allowed lite models in
  // order (3.5 Flash Lite first, then 3.1 Flash Lite as a fallback) before giving up. Each
  // already gets its own internal retry from askAIWithRetry, so a genuinely down/rate-limited
  // model doesn't block a message the player was actually right about. Only if both models
  // fail does this throw, which the caller treats as "couldn't scan" and blocks by default.
  let lastErr;
  for(const model of ALLOWED_BG_MODELS){
    try{
      const raw = await askAIWithRetry(CLAIM_READ_SYS_PROMPT, prompt, model);
      const claims = extractJsonArray(raw);
      return claims.filter(c => c && typeof c === 'object' && typeof c.type === 'string');
    }catch(err){
      console.error(`[claim scan] ${model} failed`, err);
      lastErr = err;
    }
  }
  throw lastErr || new Error('AI read step failed');
}

// ---------- code-side checkers for the AI-extracted claim list ----------
// Small, single-purpose, one per claim type — same "fractioned" shape as the regex checkers
// above, and called the same way from the orchestrator: each takes one claim plus the panel
// and returns either a warning string or null. No AI judgment happens in any of these.

// Backstop for the AI extraction step: even though the prompt already tells the model to
// never extract an "acquire" claim (buying, finding, being given an item, etc.), a small lite
// model can still misfire occasionally. Rather than trust the prompt alone — same "don't fully
// trust the model" rule the currency math check follows — this re-checks the ORIGINAL message
// text around the claimed item name for a plain acquisition verb before ever letting
// checkInventoryClaimFromAI flag it as missing. If an acquire verb sits nearby, the claim is
// treated as gaining something new and is silently skipped rather than blocking the message.
function claimLooksAcquired(userText, itemName){
  if(!userText || !itemName) return false;
  const words = itemName.split(/\s+/).filter(w => w.length > 2);
  if(!words.length) return false;
  const escWords = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
  const re = new RegExp(`\\b(?:${ACQUIRE_VERBS_SRC})\\b[^.!?\\n]{0,40}\\b(?:${escWords})\\b|\\b(?:${escWords})\\b[^.!?\\n]{0,10}\\b(?:from|off)\\s+(?:the|a|an)\\s+(?:merchant|shop|vendor|store|market)\\b`, 'i');
  return re.test(userText);
}

function checkAbilityClaimFromAI(claim, panel){
  if(!panel || !panel.categories || !claim.name) return null;
  const sheetText = panelToText(panel);
  if(!sheetText || !sheetText.trim()) return null;
  const knownWords = new Set(claimPhraseWords(sheetText));
  const words = claimPhraseWords(claim.name);
  if(!words.length) return null; // nothing specific enough to check
  const known = abilityWordsMatch(words, knownWords);
  if(!known) return `"${claim.name}" isn't on your character sheet.`;
  return null;
}

function checkInventoryClaimFromAI(claim, panel, userText){
  if(!panel || !panel.categories || !claim.name) return null;
  if(claimLooksAcquired(userText, claim.name)) return null; // buying/finding/being given it — never a "you don't have this" claim
  const claimedCount = claim.count != null ? Number(claim.count) : null;
  for(const cat of Object.values(panel.categories)){
    if(cat.type !== 'list' || !Array.isArray(cat.data)) continue;
    for(const entry of cat.data){
      const { count, name } = parseInventoryEntry(entry);
      if(!name || !textMentionsItem(claim.name, name)) continue;
      if(claimedCount != null && !isNaN(claimedCount) && count != null && claimedCount > count){
        return `You only have ${count} ${name}, not ${claimedCount}.`;
      }
      return null; // found on the sheet and count checks out (or item is uncounted)
    }
  }
  // Regex checkInventoryClaim above deliberately never flags this case (it only ever compares
  // counts on entries it can already find by name) — this is the AI-read step's own job to catch.
  return `"${claim.name}" isn't in your inventory.`;
}

function checkCurrencyClaimFromAI(claim, panel){
  if(!panel || !panel.categories || !claim.key) return null;
  const claimedAmt = Number(claim.amount);
  if(isNaN(claimedAmt)) return null;
  const keyLower = claim.key.toLowerCase();
  for(const cat of Object.values(panel.categories)){
    if(cat.type !== 'kv') continue;
    for(const [key, value] of Object.entries(cat.data)){
      const kl = key.toLowerCase();
      if(kl !== keyLower && !kl.includes(keyLower) && !keyLower.includes(kl)) continue;
      const numMatch = String(value).match(/-?\d[\d,]*\.?\d*/);
      if(!numMatch) continue;
      const trackedNum = parseFloat(numMatch[0].replace(/,/g, ''));
      if(claimedAmt > trackedNum) return `You only have ${value} ${key}, not ${claimedAmt}.`;
      return null;
    }
  }
  return null; // key not found on sheet at all — stay silent, same "unsure = don't block" rule
}

// Final pre-send gate: runs every deterministic check against the letter of records before a
// message is ever sent to the story. Layer 1 (below) is pure string/regex/math work — zero AI
// calls, zero tokens spent. Layer 2 adds the AI read step for disguised/implied claims regex
// can't parse, then hands its output to the plain-code checkers above — the AI never makes the
// accept/reject call itself, only Layer 1's math and Layer 2's exact-match lookups do.
async function checkClaimAgainstRecords(world, userText){
  const panel = await getPanel(world.id);
  // Spelled-out numbers ("five hundred gold") are normalized to digits ("500 gold") only for
  // THIS internal check — the original userText (with the player's own wording intact) is what
  // actually gets sent to the story and saved to chat, untouched.
  const normalizedText = normalizeNumberWords(userText);

  // ---------- Layer 1: deterministic regex checks (unchanged) ----------
  const currencyIssue = checkCurrencyClaim(normalizedText, panel);
  if(currencyIssue) return currencyIssue;
  const inventoryIssue = checkInventoryClaim(normalizedText, panel);
  if(inventoryIssue) return inventoryIssue;
  const abilityIssue = checkAbilityClaim(userText, panel);
  if(abilityIssue) return abilityIssue;

  // ---------- Layer 2: AI-read claims, checked by plain code ----------
  const sheetText = panelToText(panel);
  if(!sheetText || !sheetText.trim()) return null; // nothing tracked yet — nothing to scan for
  let claims;
  try{
    claims = await readClaimsFromInput(userText, sheetText);
  }catch(err){
    console.error('[claim scan] AI read step failed', err);
    // Input wasn't scanned at all — block by default rather than silently letting it through,
    // same "if the AI step fails, fall back to block" rule from the plan this implements.
    return "Couldn't scan this message against your sheet (AI read step failed) — check your connection/API key and try again.";
  }
  for(const c of claims){
    let issue = null;
    if(c.type === 'ability') issue = checkAbilityClaimFromAI(c, panel);
    else if(c.type === 'item') issue = checkInventoryClaimFromAI(c, panel, userText);
    else if(c.type === 'currency') issue = checkCurrencyClaimFromAI(c, panel);
    if(issue) return issue;
  }
  return null;
}

async function sendMessage(){
  if(isSending) return;
  const val = els.textInput.value.trim();
  if(!val) return;
  // Guard set immediately, before any await — otherwise a rapid double-tap can slip
  // through the gap while world/chat are still being fetched and fire twice.
  isSending = true; els.sendBtn.disabled = true;
  const world = await getWorld(state.chattingId);
  if(!world){ isSending = false; els.sendBtn.disabled = false; return; } // no story open — bail out cleanly instead of throwing and leaving the button stuck disabled
  if(!isSystemTrigger(val)){
    const claimIssue = await checkClaimAgainstRecords(world, val);
    if(claimIssue){
      // Leave the text in the input box (don't clear it, don't push it to chat) so the
      // player can just edit and resend, the same way a rate-limit warning doesn't lose
      // anything — it just stops the send and explains why.
      const w = document.createElement('div'); w.className = 'warn';
      w.textContent = `⚠️ ${claimIssue}`;
      els.log.appendChild(w); scrollLogToBottom(); pinToBottomAfterRender();
      els.sendBtn.disabled = false; isSending = false;
      return;
    }
  }
  els.textInput.value = ''; els.textInput.style.height='auto';
  let chat = await getChat(world.id);
  document.querySelectorAll('.msg-actions').forEach(a=>a.remove());
  document.querySelectorAll('.sys-tools-wrap').forEach(a=>a.remove());
  chat.push({role:'user', text:val, ts:Date.now()});
  renderMsg({role:'user', text:val}, false, chat.length-1);
  scrollLogToBottom(); pinToBottomAfterRender();
  await saveChat(world.id, chat);
  if(isSystemTrigger(val)) await systemReply(world, chat, val);
  else await continueStory(world, chat);
}
els.sendBtn.onclick = sendMessage;
// Resizing the textarea synchronously on every 'input' event forces a layout
// reflow while Android's swipe-typing keyboard is still mid-gesture/composing.
// That reflow is what corrupts glide-typed words and splits them onto separate
// lines (Gboard loses its lock on the field). Deferring the resize to the next
// animation frame lets the keystroke/composition finish untouched first.
let _taResizeRAF = null;
els.textInput.addEventListener('input', ()=>{
  if(_taResizeRAF) return;
  _taResizeRAF = requestAnimationFrame(()=>{
    _taResizeRAF = null;
    els.textInput.style.height='auto';
    els.textInput.style.height = Math.min(els.textInput.scrollHeight,120)+'px';
  });
});

// ================= INFO MODAL ("what is this section?") =================
// Tapping a Letter of Records section title shows a plain-English explanation of the
// rules that actually govern it — kept in sync with the guard patterns above.

// ---------- section info modal: tapping a Letter of Records section title explains it ----------
// Same category-matching patterns the guard logic above already uses (identity, finance/
// currency, timeline, etc.) so the explanation shown always lines up with what actually
// governs that section's behavior. Every category on the sheet is now one of this fixed set
// (see isRecognizedCategory), so the generic fallback below should no longer be reachable in
// practice — kept only as a safety net.
const CAT_INFO = [
  { test:/^identity/i, title:'Identity', what:'The character\u2019s core, established facts \u2014 things like name, age, appearance, and role in the world.', how:'It fills in and changes on its own as the story actually confirms a new or changed fact about the character on-page.', wont:'A guess, a wish, or a question asked in dialogue. Nothing is added or overwritten just because it was floated in conversation \u2014 only what the story has genuinely established.' },
  { test:/^(financ|currency|currencies|econom|treasury|coffers?|bank|wallet)/i, title:'Finances', what:'The money or currency the character actually has on hand right now. This section is permanent \u2014 it\u2019s always on the sheet, even before the story has given the character any money yet.', how:'It updates once a transaction is shown fully completing in the story \u2014 a purchase closes, payment changes hands, a reward is actually received.', wont:'Quoting a price, haggling, or discussing a deal in dialogue. Talk of a cost doesn\u2019t change anything until the exchange is shown as finished \u2014 and it will never let the character spend more than what\u2019s listed.' },
  { test:/^inventory/i, title:'Inventory',
    what:'The physical items the character is currently carrying \u2014 how many of each, whether something is equipped or worn, and where or how it\u2019s currently kept (on their person, stored away, hidden, etc.). Every item also gets a permanent \u201c#N\u201d number the moment it\u2019s added.',
    how:'Gaining an item, or more of one already owned: only happens when your own message contains an acquisition phrase naming the item \u2014 bought, received, paid, looted, found, picked up, took, earned, won, claimed, traded/exchanged/swapped for it, or were gifted/donated it \u2014 or when you use/apply a graduated ability of yours (duplication, creation, multiplication, transmutation, or similar) directly on it, written as \u201cI used/applied my <ability> on/to <item>.\u201d The ability has to already be a fully mastered entry in Skills & Abilities \u2014 one still sitting in Learning below 100% doesn\u2019t count, even if the story\u2019s own narration describes it succeeding on its own; that specific item change is blocked until the ability actually graduates. Any number you state has to match the real gain, or it\u2019s corrected or blocked. Just mentioning an ability and an item together, with no actual use/apply claim, is never enough on its own.\n\nLosing quantity (without deleting the item): only when your message shows you using, spending, throwing, consuming, dropping, or otherwise expending it \u2014 \u201cI used/threw/detonated/spent/dropped/ate/drank...\u201d A stack can never drop below zero.\n\nStatus \u2014 what it\u2019s doing or where it\u2019s kept: the note after an item\u2019s name (Equipped, Sheathed, Poisoned, Hidden under the bed, Left at the shop, etc.) only changes when your message actually shows that happening. \u201cRemove/take off\u201d only unequips \u2014 the item stays in Inventory, just no longer worn/held. If the status shows the item stored, hidden, or left away from your person, you can\u2019t use it until the story shows you physically getting it back.\n\nDeleting an item entirely: only when your message shows it actually being gotten rid of \u2014 thrown away/out, left behind, dropped, tossed, discarded, abandoned, buried, given away, gifted, donated, sold, traded/exchanged/swapped away, lost, gotten rid of, or destroyed. Unequipping is never deletion.\n\nNumbering: the \u201c#N\u201d assigned when an item is first added is permanent \u2014 it\u2019s never reassigned or reused, even after that item is deleted. The count only ever goes up.',
    wont:'Just talking about wanting, considering, haggling over, or planning to use an item \u2014 nothing changes until the story actually shows the moment happening. Mentioning a listed ability and an item in the same sentence with no actual use/apply claim doesn\u2019t grant anything either, and naming an ability that\u2019s still in Learning (not yet graduated) never grants or changes an item no matter how it\u2019s phrased.',
    use:'Tap the expand icon next to \u201cInventory\u201d on the Letter of Records to open the dedicated Inventory page \u2014 everything below happens there, immediately, and doesn\u2019t need the story to confirm it since these are actions you\u2019re taking directly rather than something narrated.\n\nMerging: long-press one item and drag it onto another to combine them into a new, single combined item.\n\nDeleting: tap the \u2715 on any item\u2019s chip to permanently remove it from the sheet.'
  },
  { test:/^skills?(\s|&|$)/i, title:'Skills & Abilities', what:'The complete, permanent record of every jutsu, technique, spell, or innate power the character can actually use right now. This is what the AI checks before letting the character use an ability.', how:'An entry is added the moment the story shows the character fully acquiring an ability \u2014 buying or being taught something complete in one scene, gaining an innate power, or a \u201cLearning\u201d entry reaching 100% and graduating in on its own.', wont:'Just talking about wanting a power, or attempting one that isn\u2019t listed yet. Something has to be shown as genuinely, fully gained before it appears here \u2014 the story treats this list as the hard limit on what the character can do.' },
  { test:/^learning$/i, title:'Learning', what:'Skills or techniques the character has started training in but hasn\u2019t fully mastered yet, tracked as a percentage toward 100%. This section only appears once training actually begins \u2014 it isn\u2019t there from the start.', how:'An entry appears the first time the story shows real practice beginning, and its percentage only rises when the story shows actual study, drilling, or training.', wont:'Simply wanting to learn something, or using a skill without training it. Once an entry reaches 100%, it moves itself out of Learning and into Skills & Abilities as a fully usable entry.' },
  { test:/^timeline$/i, title:'Timeline', what:'The story\u2019s current day count. This section is permanent \u2014 it\u2019s always on the sheet from the very start, beginning at Day 1, even before any time has passed.', how:'It only ever counts up, one confirmed step at a time \u2014 Day 1 \u2192 Day 2 \u2192 Day 5 and so on \u2014 and only when the story shows a clear time skip: phrases like \u201covernight,\u201d \u201cthe next morning,\u201d or \u201ca week later.\u201d It advances by exactly however many days that skip covers, never more.', wont:'A busy scene on its own. The day never moves backward, and it won\u2019t advance just because a lot happened \u2014 only an explicit skip forward moves it. A countdown mention like \u201c50 days remaining\u201d or \u201cin 12 days\u201d also won\u2019t move it \u2014 that describes time still ahead, not time that\u2019s actually passed, so it\u2019s not counted as a skip.', use:'You can\u2019t set the day directly, but adding a Scheduled Event (see that section below) is how you give the timeline something to count toward \u2014 open "system bro" and use the Scheduled Events tile to pin a date to the calendar.' },
  { test:/^scheduled\s*events?/i, title:'Scheduled Events', what:'Upcoming dated events already set up for this story \u2014 exams, appointments, deadlines, ceremonies \u2014 each shown as "Day N \u2014 event." This section is permanent \u2014 it\u2019s always on the sheet, even with nothing scheduled yet.', how:'You add every entry yourself \u2014 either through the tile below, or by writing a "Day N \u2014 event" line straight into the world\u2019s own setup text before the story begins. The story never adds one on its own, even if the setup text mentions a date some other way. Once Current Day reaches or passes an entry\u2019s day, the story actively brings it about on its own initiative in the very next reply \u2014 someone comes to fetch you, an announcement is made, and so on \u2014 you never need to ask for it or type anything to make a due event happen. It still only ever costs you the one reply you already get from Send or Forward, never an extra one.', wont:'An entry is never removed \u2014 not by you, not by the story, not once it\u2019s due. It\u2019s a permanent record: once its day arrives it just dims in place to show it\u2019s passed, and stays visible from then on. The story also can\u2019t add a new entry on its own \u2014 if it never got added here, it\u2019s not tracked.', use:'Open "system bro" and tap the Scheduled Events tile \u2014 fill in the description (day optional) and add it. Leave the day out and the event is due right away; give a day that\u2019s already passed and it snaps to today instead. Or, when first creating the world, write a line like "Day 12 \u2014 Ch\u016bnin Exam" directly into the setup text \u2014 it\u2019s picked up automatically the moment the world is saved. The tile lists everything already scheduled, with due entries shown dimmed.' },
  { test:/^status$/i, title:'Status', what:'The character\u2019s current condition \u2014 health, mood, or any effect currently active.', how:'It changes when the story actually shows a shift \u2014 an injury, a change in mood, an effect wearing off.', wont:'A passing mention or throwaway line that doesn\u2019t actually change the character\u2019s state.' },
  { test:/^relationships?$/i, title:'Relationships', what:'The people the character knows and how things currently stand with each of them.', how:'It updates as the story develops or shifts a relationship on-page.', wont:'An NPC simply being mentioned, or a one-off interaction that doesn\u2019t actually move the relationship.' },
  { test:/^milestones?$/i, title:'Milestones', what:'The significant turning points or achievements the character has reached in the story.', how:'An entry is added when the story marks something as a genuine milestone, not just an ordinary scene.', wont:'Routine events or minor beats that don\u2019t rise to that level.' },
];
const CAT_INFO_DEFAULT = { what:'A part of the story\u2019s Letter of Records that this particular world introduced on its own.', how:'It fills in and changes automatically as the story establishes or changes it on-page.', wont:'A mention, a plan, or a guess. It only changes once the story actually shows that change happening \u2014 it isn\u2019t something to edit directly.' };
function getCatInfo(name){
  const trimmed = String(name||'').trim();
  const match = CAT_INFO.find(c => c.test.test(trimmed));
  return { title: trimmed || 'Section', what:(match||CAT_INFO_DEFAULT).what, how:(match||CAT_INFO_DEFAULT).how, wont:(match||CAT_INFO_DEFAULT).wont, use:(match||CAT_INFO_DEFAULT).use || null };
}
// ---------- "Current Items" block (Inventory's section-info popup only) ----------
// Read-only render of the character's actual current items, grouped by their status suffix
// (Equipped, Sheathed, Hidden under the bed, ...) so carry/equip state is visible right here
// without opening the Letter of Records or the dedicated Inventory/merge page. Reuses
// sortInventoryDisplayByStatus (defined up near paintInventoryModal) purely for the grouping —
// this never touches panel.categories['Inventory'] itself, so it has zero effect on what
// panelToText sends to the AI each turn or on anything the merge/delete actions look up by ID.
function renderCatInfoInventoryItems(panel){
  const inv = panel && panel.categories ? panel.categories['Inventory'] : null;
  if(!inv || inv.type !== 'list' || !Array.isArray(inv.data) || !inv.data.length){
    return '<div class="cat-info-item-row" style="opacity:.6;">(none yet)</div>';
  }
  const sorted = sortInventoryDisplayByStatus(inv);
  let html = '';
  let lastStatus; // sentinel (undefined) so the very first group always prints its own header
  for(const entry of sorted.data){
    const parsed = splitItemEntry(entry);
    const statusLabel = parsed.status || 'Not equipped / carried';
    if(statusLabel !== lastStatus){
      html += `<div class="cat-info-status-group">${escapeHtml(statusLabel)}</div>`;
      lastStatus = statusLabel;
    }
    const qtyStr = (parsed.qty != null && !isNaN(parsed.qty)) ? ` \u00d7${parsed.qty.toLocaleString('en-US')}` : '';
    html += `<div class="cat-info-item-row">${escapeHtml(parsed.name)}${qtyStr}</div>`;
  }
  return html;
}
async function openCatInfoModal(name){
  const info = getCatInfo(name);
  document.getElementById('catInfoTitle').textContent = info.title;
  document.getElementById('catInfoWhat').textContent = info.what;
  document.getElementById('catInfoHow').textContent = info.how;
  document.getElementById('catInfoWont').textContent = info.wont;
  const useBlock = document.getElementById('catInfoUseBlock');
  if(info.use){ document.getElementById('catInfoUse').textContent = info.use; useBlock.style.display = ''; }
  else { useBlock.style.display = 'none'; }
  // Inventory only: fetch the live panel fresh (this modal can be reopened many times without
  // the page reloading, so a stale cached copy would drift from what's actually on the sheet)
  // and populate the Current Items block. Hidden for every other section.
  const itemsBlock = document.getElementById('catInfoItemsBlock');
  const isInvSection = /^inventory/i.test(String(name||'').trim());
  if(isInvSection && state.chattingId){
    const panel = await getPanel(state.chattingId);
    document.getElementById('catInfoItems').innerHTML = renderCatInfoInventoryItems(panel);
    itemsBlock.style.display = '';
  } else {
    itemsBlock.style.display = 'none';
  }
  els.catInfoModal.style.display = 'flex';
  pushNavState('modal');
}
els.panelContent.addEventListener('click', (e)=>{
  const expandBtn = e.target.closest('.panel-inv-expand-btn');
  if(expandBtn){ openInventoryModal(); return; }
  // Purely a display toggle for a long Inventory list on the Letter of Records — reveals/
  // re-hides the chips already sitting in the DOM past the first page, nothing is
  // re-fetched or re-rendered from data.
  const toggleBtn = e.target.closest('.panel-inv-toggle-btn');
  if(toggleBtn){
    const hiddenWrap = toggleBtn.previousElementSibling && toggleBtn.previousElementSibling.querySelector
      ? toggleBtn.previousElementSibling.querySelector('.panel-inv-hidden-chips')
      : null;
    if(hiddenWrap){
      const nowExpanded = hiddenWrap.hasAttribute('hidden');
      if(nowExpanded){ hiddenWrap.removeAttribute('hidden'); } else { hiddenWrap.setAttribute('hidden',''); }
      toggleBtn.classList.toggle('is-expanded', nowExpanded);
      const label = toggleBtn.querySelector('.panel-inv-toggle-label');
      const count = toggleBtn.getAttribute('data-count');
      if(label) label.textContent = nowExpanded ? 'Show less' : `Show ${count} more`;
    }
    return;
  }
  const relName = e.target.closest('.panel-rel-name');
  if(relName){
    els.relInfoName.textContent = relName.getAttribute('data-rel-name') || '';
    els.relInfoContent.textContent = relName.getAttribute('data-rel-full') || '(none yet)';
    showOverlayModal(els.relInfoModal);
    pushNavState('modal');
    return;
  }
  if(handleInvSlotTap(e)) return;
  const t = e.target.closest('.panel-sec-title');
  if(!t) return;
  openCatInfoModal(t.textContent);
});
// Inventory cards show their full name on the card itself now (see .inv-slot-info in the
// CSS), so a plain tap has nothing left to reveal — this just swallows taps that land on a
// card so they don't fall through to the section-info-open handler below it. A long-press
// on an editable card opens the photo picker instead (see the pointer wiring further down).
function handleInvSlotTap(e){
  const slot = e.target.closest('.panel-chip.inv-slot');
  if(!slot) return false;
  if(e.target.closest('.panel-chip-del')) return false;
  return true;
}
// ---------- inventory item long-press action sheet (Equip/Unequip, Delete, Change Photo) ----------
// Long-pressing an inventory card opens a bottom-up action sheet for that item — its full
// name, current status, an Equip/Unequip toggle (paired with Delete in the same row), and a
// Change Photo action — instead of jumping straight to the photo picker as before. Deliberately
// scoped to cards carrying data-photo-editable (set only on the main Letter of Records view —
// see renderPanelHtml) so this never competes with the dedicated Inventory page's own
// long-press-to-drag gesture. There's no separate Cancel button — tapping the backdrop
// dismisses the sheet, same as every other overlay in the app.
(function(){
  const LONG_PRESS_MS = 550;
  const fileInput = document.getElementById('invItemPhotoInput');
  const sheet = document.getElementById('itemActionSheet');
  if(!fileInput || !sheet) return;
  const nameEl = document.getElementById('itemActionName');
  const statusEl = document.getElementById('itemActionStatus');
  const equipBtn = document.getElementById('itemActionEquipBtn');
  const deleteBtn = document.getElementById('itemActionDeleteBtn');
  const photoBtn = document.getElementById('itemActionPhotoBtn');
  const backdrop = sheet.querySelector('.item-action-backdrop');
  let pressTimer = null;
  let pressingCard = null;
  let activeItemId = null;
  let activeStatus = '';

  function clearPress(){
    if(pressTimer){ clearTimeout(pressTimer); pressTimer = null; }
    if(pressingCard){ pressingCard.classList.remove('is-photo-pressing'); pressingCard = null; }
  }
  function closeSheet(){ sheet.classList.remove('is-open'); }
  function openSheetFor(card){
    activeItemId = card.getAttribute('data-item-id') || '';
    activeStatus = card.getAttribute('data-status') || '';
    if(nameEl) nameEl.textContent = card.getAttribute('data-slot-name') || '';
    if(statusEl) statusEl.textContent = 'Status: ' + (activeStatus || 'None');
    if(equipBtn) equipBtn.textContent = isOnBodyStatus(activeStatus) ? 'Unequip' : 'Equip';
    sheet.classList.add('is-open');
  }
  document.addEventListener('pointerdown', (e)=>{
    if(e.pointerType === 'mouse' && e.button !== 0) return;
    const card = e.target.closest('.panel-chip.inv-slot[data-photo-editable="1"]');
    if(!card) return;
    clearPress();
    pressTimer = setTimeout(()=>{
      card.classList.remove('is-photo-pressing');
      pressingCard = null;
      pressTimer = null;
      if(navigator.vibrate) navigator.vibrate(12);
      openSheetFor(card);
    }, LONG_PRESS_MS);
    // Delay the visible hint slightly so a normal tap never flashes it.
    pressingCard = card;
    setTimeout(()=>{ if(pressTimer && pressingCard===card) card.classList.add('is-photo-pressing'); }, 120);
  });
  document.addEventListener('pointerup', clearPress);
  document.addEventListener('pointerleave', clearPress, true);
  document.addEventListener('pointercancel', clearPress);

  // Equip/Unequip toggles the item's status in place and updates the sheet's own status line
  // and button label right away — it deliberately does NOT close the sheet, so tapping it
  // repeatedly flips Equip <-> Unequip live and the person can still reach Delete/Change
  // Photo afterward without reopening the sheet.
  if(equipBtn) equipBtn.addEventListener('click', async ()=>{
    if(!activeItemId || !state.chattingId) return;
    const nowEquipping = !isOnBodyStatus(activeStatus);
    const newStatus = nowEquipping ? 'Equipped' : null;
    await setInventoryItemStatus(state.chattingId, activeItemId, newStatus);
    activeStatus = newStatus || '';
    if(statusEl) statusEl.textContent = 'Status: ' + (activeStatus || 'None');
    equipBtn.textContent = nowEquipping ? 'Unequip' : 'Equip';
  });
  if(deleteBtn) deleteBtn.addEventListener('click', async ()=>{
    if(!activeItemId || !state.chattingId){ closeSheet(); return; }
    const label = nameEl ? nameEl.textContent : '';
    const deleted = await deleteInventoryItemById(state.chattingId, activeItemId, label);
    if(deleted) closeSheet();
  });
  if(photoBtn) photoBtn.addEventListener('click', ()=>{
    closeSheet();
    fileInput.click();
  });
  if(backdrop) backdrop.addEventListener('click', closeSheet);

  fileInput.addEventListener('change', ()=>{
    const file = fileInput.files && fileInput.files[0];
    const itemId = activeItemId;
    fileInput.value = '';
    if(!file || !itemId || !state.chattingId) return;
    const reader = new FileReader();
    reader.onload = async ()=>{
      await setInventoryItemPhoto(state.chattingId, itemId, reader.result);
    };
    reader.readAsDataURL(file);
  });
})();
document.addEventListener('click', (e)=>{
  const invContent = document.getElementById('invContent');
  if(invContent && invContent.contains(e.target) && !els.panelContent.contains(e.target)){
    handleInvSlotTap(e);
  }
});
els.closeCatInfoBtn.onclick = ()=> els.catInfoModal.style.display = 'none';
els.catInfoModal.onclick = (e)=>{ if(e.target===els.catInfoModal) els.catInfoModal.style.display='none'; };
els.closeRelInfoBtn.onclick = ()=> hideOverlayModal(els.relInfoModal);
els.relInfoModal.onclick = (e)=>{ if(e.target===els.relInfoModal) hideOverlayModal(els.relInfoModal); };

// Tap-to-upload handlers for the two frozen equip-hub sections (top figure slot, bottom blank slot).
// The picker inputs live once in the page; the target elements are looked up fresh on each change
// since the equip section's inner HTML is re-rendered every time the Holding tab is opened.
(function initEquipHubPickers(){
  const topInput = document.getElementById('equipHubTopFile');
  const bottomInput = document.getElementById('equipHubBottomFile');
  if(!topInput || !bottomInput) return;

  topInput.addEventListener('change', (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const icon = document.getElementById('equipHubTopIcon');
      if(icon) icon.outerHTML = `<img class="equip-hub-img" id="equipHubTopIcon" src="${reader.result}">`;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  });

  bottomInput.addEventListener('change', (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const placeholder = document.getElementById('equipHubBottomPlaceholder');
      if(placeholder) placeholder.outerHTML = `<img class="equip-hub-img" id="equipHubBottomPlaceholder" src="${reader.result}">`;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  });
})();
