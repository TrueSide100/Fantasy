/* ================================================================================
   script_letter_of_records.js — the Letter of Records data model, merge engine,
   rendering, and pre-send claim checks (Identity, Milestones, Relationships, Status)

   This is sub-section 2.3 of what used to be part of script_chatroom.js (itself a
   merge of script_outside-the-chatroom.js's Section 2 and script_inside-the-
   chatroom.js). Split out into its own file so it can be read and edited
   independently of the chat screen (Part 1) and the chatroom-to-outside/composer
   wiring (2.1/2.2), which remain in script_chatroom.js.

   Contains: panel data model & schema (defaultPanel, sanitizePanel, migrateOldPanel,
   ensureCategoryIds/ensurePermanentCategories), legacy save migrations, the
   pre-send claim-check pipeline (checkClaimAgainstRecords, Layer 1's deterministic
   checkInventoryClaim, Layer 2's readClaimsFromInput and its
   checkInventoryClaimFromAI checker), the merge engine
   (key matching + mergePanelUpdate — generic, shared by every category), panel
   rendering (HTML output, relationshipShortLabel), and the info modal (CAT_INFO/
   getCatInfo). The currency half of that same pipeline — checkCurrencyClaim,
   checkCurrencyClaimFromAI — now lives in script_finance.js, next to the rest of
   the Finance guards; the ability/skill half — checkAbilityClaim,
   checkAbilityClaimFromAI, and their shared claim-phrase helpers — lives in
   script_saal.js; checkClaimAgainstRecords below still calls straight into all of
   them (global scope, so load order doesn't matter). The info modal's own Skills &
   Abilities and Learning entries have likewise moved into CAT_INFO_SAAL in
   script_saal.js; getCatInfo below checks that array too, right after this
   file's own CAT_INFO, so every other category's lookup is untouched.

   The categories actually modeled/rendered here are Identity, Milestones,
   Relationships, and Status. Finances, Inventory, Equip Box (script_finance.js,
   script_inventory_equip.js) and Timeline, Scheduled Events, Skills & Abilities,
   Learning (script_tase.js, script_saal.js) are tracked in their own files — this
   file's merge engine and panel renderer are still the shared, generic machinery
   those categories render through, so they call into functions here
   (findExistingKey, mergePanelUpdate, panelToText, renderPanelHtml, genId, etc.)
   same as script_chatroom.js does. The CAT_INFO modal itself is now split the
   same way: this file's CAT_INFO array covers its own four categories, and
   Skills & Abilities / Learning's entries live in script_saal.js's
   CAT_INFO_SAAL — getCatInfo below reads both.

   Depends on globals from index.html's inline <script> (storage helpers, els,
   askAI, pushNavState, showOverlayModal/hideOverlayModal, etc.) and from
   script_chatroom.js's Part 1 (state, els.panelContent, etc.) and 2.1
   (PANEL_SYS_PROMPT, updatePanel — referenced by comments/callers, not by this
   file itself). Must load AFTER index.html's inline script; load order relative
   to script_chatroom.js, script_finance.js, script_inventory_equip.js,
   script_tase.js, and script_saal.js does not matter — none of these define
   anything another needs at load time, only at call time, by which point all
   have finished loading.

   Recommended <script> order in index.html:
     1. (inline Section 1 — already in index.html)
     2. script_chatroom.js
     3. script_letter_of_records.js   (this file)
     4. script_finance.js
     5. script_inventory_equip.js
     6. script_tase.js
     7. script_saal.js

   No function, const, or top-level `let` name in this file collides with any in
   script_chatroom.js or the four guard files above, so nothing was renamed during
   the split.
   ================================================================================ */


// ================================================================================
// 2.3 — LETTER OF RECORDS
// Data model & schema, legacy save migrations, the merge engine (key matching +
// mergePanelUpdate — generic, shared by every category), panel rendering (HTML
// output), and the info modal. The categories that actually live in this part are
// Identity, Milestones, Relationships, and Status; Finances, Inventory, Skills &
// Abilities, Timeline, and Scheduled Events (plus their pre-send claim checks) are
// all in script_finance.js (Finances), script_inventory_equip.js (Inventory),
// script_tase.js (Timeline, Scheduled Events), and script_saal.js (Skills & Abilities,
// Learning, plus the ability/skill half of the pre-send claim checks AND that pair's
// two CAT_INFO entries, in CAT_INFO_SAAL) — see the MOVED banners below.
// ================================================================================


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
    const isSkill = (cat.type==='list' && /^skills?(\s|&|$)/i.test(String(catName).trim())) || (cat.type==='kv' && /^learning$/i.test(String(catName).trim()));
    const mintId = () => isInv ? genInvId(panel) : isSkill ? genSkillId(panel) : genId();
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
// ================= INVENTORY ID MANAGEMENT — MOVED =================
// genInvId, numFromId, and migrateLegacyInventoryIds (the numbered "#N" inventory-id
// scheme and its one-time legacy-id upgrade) now live in script_inventory_equip.js
// (SECTION 2 — INVENTORY). Still called from ensureCategoryIds/mergePanelUpdate below and
// from getPanel further down, same as before the move.
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
  const legacySkillIdsMigrated = migrateLegacySkillIds(panel);
  if(!p || purged || migrated || strayMerged || ensured || dedupedLearning || promoted || repaired || idsBackfilled || legacyIdsMigrated || legacySkillIdsMigrated) await savePanel(id, panel);

  // BUG FIX (early milestones/relationships/etc. surviving a delete): savePanel only ever
  // writes a history snapshot when there's an actual change to save, so a world that has
  // never had ANY change yet has no snapshot at all — including no record of the genuinely
  // blank state before its first-ever change. If that first change (e.g. a Day 1 milestone)
  // is later deleted, restorePanelHistoryTo has nothing old enough to revert to and silently
  // falls back to the far less reliable AI-guess resync, which can leave the entry stuck.
  // Backfilled here on ANY getPanel call whose history is missing this floor — not just a
  // brand-new panel's first call — since "0 messages existed" was always genuinely blank,
  // regardless of when this particular record of that fact gets written; this also repairs
  // worlds that already hit the bug before this fix existed. Tagged at chat length 0: a
  // true, always-valid floor so every later delete/rewind, no matter how far back, now
  // always has at least this to land on instead of ever needing the imprecise fallback for
  // a from-day-one revert.
  try{
    const history = await getPanelHistory(id);
    if(!history.some(h => h.atIndex === 0)){
      await savePanelHistorySnapshot(id, 0, defaultPanel(), '');
    }
  }catch(e){ console.error('[floor panel snapshot failed]', e); }

  return panel;
}
async function savePanel(id, panel){
  await kvSet('wc_panel_'+id, panel);
  // Record a history snapshot of this exact sheet (+ matching memory) tagged with how many
  // chat messages exist right now — see savePanelHistorySnapshot/restorePanelHistoryTo below.
  // Hooked here (the single choke point for every panel write) rather than at each call site
  // so a Learning entry added by practicing/fusing — no matter which code path wrote it —
  // can always be reverted deterministically if the message that caused it gets deleted.
  try{
    const chat = await getChat(id);
    await savePanelHistorySnapshot(id, chat.length, panel, await getMemory(id));
  }catch(e){ console.error('[panel history snapshot failed]', e); }
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
// ================= PANEL/MEMORY SNAPSHOT HISTORY (for deterministic delete/rewind) =================
// Deleting a chat message rewinds the story, and anything the Letter of Records or memory
// picked up from a message that's now gone (a skill bumped from practice, a fusion added to
// Learning, an item gained, ...) shouldn't survive the delete. Rather than asking a background
// model to re-guess what's still true (resyncMemoryAndPanel — kept as a fallback below for
// saves from before this history existed), every savePanel() call above snapshots the sheet
// exactly as it was, tagged with how many chat messages existed at that moment. Reverting after
// a delete just restores the latest snapshot at or before the trimmed chat's new length —
// exact, not a guess. Capped so a very long story can't grow this without bound.
const PANEL_HISTORY_CAP = 400;
async function getPanelHistory(id){
  const h = await kvGet('wc_panelhist_'+id);
  return Array.isArray(h) ? h : [];
}
async function savePanelHistorySnapshot(id, atIndex, panel, memory){
  const history = await getPanelHistory(id);
  history.push({ atIndex, panel: JSON.parse(JSON.stringify(panel)), memory: memory || '' });
  while(history.length > PANEL_HISTORY_CAP) history.shift();
  await kvSet('wc_panelhist_'+id, history);
}
// Restores the sheet + memory to exactly how they looked once `cutIndex` messages existed,
// using the most recent snapshot at or before that point (any later snapshot belonged to a
// message that no longer exists, so it's skipped). Returns true if a snapshot was found and
// applied; false if this story predates the history feature, so the caller should fall back
// to the AI-based resyncMemoryAndPanel instead.
async function restorePanelHistoryTo(id, cutIndex){
  const history = await getPanelHistory(id);
  // BUG FIX: this used to scan backward through the array and take the FIRST entry with
  // atIndex <= cutIndex, which only picks the right one if history[] happens to already be
  // sorted by atIndex in insertion order. That's true for snapshots taken during normal play
  // (each turn's save is naturally later than the last), but the floor snapshot getPanel()
  // backfills for pre-existing worlds (see the "BUG FIX (early milestones/relationships/etc.
  // surviving a delete)" comment there) is appended at atIndex:0 AFTER those later, higher-
  // atIndex entries already exist — so a straight backward scan hit that floor entry FIRST
  // and returned it even when a much more specific, more recent qualifying snapshot (e.g.
  // atIndex:5, cutIndex:6) also existed earlier in the array. That wrongly reverted a delete
  // all the way back to blank instead of to the correct nearer point, discarding real
  // progress that should have survived. Explicitly comparing atIndex values (highest one not
  // exceeding cutIndex wins) is correct regardless of array order.
  let match = null;
  for(const h of history){
    if(h.atIndex <= cutIndex && (!match || h.atIndex > match.atIndex)) match = h;
  }
  if(!match) return false;
  await kvSet('wc_panel_'+id, JSON.parse(JSON.stringify(match.panel)));
  await saveMemory(id, match.memory);
  if(state.chattingId === id){
    if(els.invModal.style.display === 'flex') await paintInventoryModal();
    if(els.panelModal.style.display === 'flex') await paintPanel();
  }
  // Drop snapshots from the branch that no longer exists, so a later delete/regenerate can't
  // land on a "future" snapshot that isn't real anymore.
  const trimmed = history.filter(h => h.atIndex <= cutIndex);
  await kvSet('wc_panelhist_'+id, trimmed);
  return true;
}
// ================= INVENTORY ITEM WRITE HELPERS — MOVED =================
// setInventoryItemPhoto, setInventoryItemStatus, and deleteInventoryItemById now live in
// script_inventory_equip.js (SECTION 2 — INVENTORY), right next to the
// long-press action sheet that calls them. Still reachable the same way (global scope),
// same as before the move.

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
// ---------- one-time migration: merge stray duplicate inventory categories — MOVED ----------
// mergeStrayInventoryCategories now lives in script_inventory_equip.js
// (SECTION 2 — INVENTORY). Still called from getPanel below, same as before the move.
// ---------- one-time structural migration for older saves — MOVED ----------
// migrateSkillCategoryNames now lives in script_saal.js
// (SECTION 3 — SKILLS & ABILITIES). Still called from getPanel below,
// same as before the split — global scope, so file load order between the two doesn't matter.
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
// promoteMasteredSkills, repairDuplicateSkills, and repairDuplicateLearningKeys — MOVED —
// now live in script_saal.js (SECTIONS 3 & 4 — SKILLS & ABILITIES / LEARNING). Still
// called from getPanel above and from mergePanelUpdate below, same as before the split.

// ================= FINANCES — MOVED =================
// The Finances currency guards (guardCurrencyDecreases/Increases), the Identity-fact
// guard (guardIdentityChanges — grouped with Finance since it reuses the same grounding
// helper), and their shared regex/helpers now live in
// script_finance.js. Load that file alongside this one;
// functions defined there (see that file's own header comment) are still called from
// the merge pipeline and rendering code below, same as before the split.

// ================= SKILLS & ABILITIES — LEARNING GUARDS — MOVED =================
// Percentage-progress guard for in-training skills (SKILL_PCT_RE, PRACTICE_TRIGGER_RE,
// skillLabelWords, skillMentionedInText, guardSkillProgress), mastery graduation into the
// permanent Skills & Abilities list (normalizeSkillLabel, guardSkillGraduation), and the
// backstop that blocks using an ability that was never actually granted, now all live in
// script_saal.js. Load that file alongside this one;
// functions defined there are still called from the merge pipeline below, same as before
// the split.

// ================= INVENTORY — MOVED =================
// The entire Inventory stackable-items engine (parsing, the equip compass, drag-to-merge
// naming, the ability cross-reference helpers, the quantity/duplication-math/
// ungraduated-ability guards, and the equip-status/rename-bypass/discard guards) now
// lives in script_inventory_equip.js. Load that file alongside
// this one; functions defined there (splitItemEntry, guardStackableItems,
// renderEquipCompassHtml, etc.) are still called from the merge pipeline, panel
// rendering, and the UI wiring below, same as before the split.

// ================= TIMELINE & SCHEDULED EVENTS — MOVED =================
// The entire Timeline + Scheduled Events module ("Current Day" advancement, time-skip
// detection, the day-N-entry parser, the Scheduled Events add/remove guard, the manual
// add UI, and lore seeding — originally one self-contained #region/#endregion block) now
// lives in script_tase.js. Load that file alongside
// this one; functions defined there (guardTimelineDay, guardScheduledEvents,
// parseDayEntry, normalizeEntryLabel, etc.) are still called from the merge pipeline
// and panel rendering below, same as before the split.


// seedSkillsFromLore — MOVED — now lives in script_saal.js
// (SECTION 3 — SKILLS & ABILITIES). Still called from the world-save handler
// above (queueWorldOp(id, ...)), same as before the split.

// ================= PRE-SEND CLAIM CHECKS =================
// The pre-send claim-check pipeline lives here except for its currency half
// (checkCurrencyClaim, checkCurrencyClaimFromAI — moved to script_finance.js) and
// its ability/skill half (checkAbilityClaim, checkAbilityClaimFromAI — moved to
// script_saal.js; see the MOVED notes further down for exactly where each one
// went). Still here: Layer 1's deterministic checkInventoryClaim, Layer 2's AI
// read step for disguised/implied claims (readClaimsFromInput) and its
// non-currency/non-ability code-side checker (checkInventoryClaimFromAI), and
// checkClaimAgainstRecords, which ties every layer together and calls straight
// into the moved currency/ability functions same as before (global scope). Still
// called from sendMessage() in Section 2 above, same as before the move.

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

// ---------- currency claim checker — MOVED ----------
// checkCurrencyClaim (the deterministic regex/math check) and checkCurrencyClaimFromAI
// (the code-side checker for the AI-extracted claim list, further down this file) now
// live in script_finance.js, right next to the rest of the Finance guards
// (guardCurrencyDecreases/Increases/RenameBypass), since all of these exist only to
// police currency. checkClaimAgainstRecords below still calls straight into both the
// same way as before (global scope, so load order doesn't matter). normalizeNumberWords
// just above stays here, since checkClaimAgainstRecords runs it once and reuses the
// result for both the currency check (now in script_finance.js) and checkInventoryClaim
// (still here) below.

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

// ---------- ability/item/power claim checker — MOVED ----------
// checkAbilityClaim (the deterministic regex check) and its shared claim-phrase helpers
// (CLAIM_VERB_SRC, CLAIM_SKIP_BEFORE_SRC, CLAIM_STRIP_WORDS, claimPhraseWords,
// sameWordRoot, claimWordKnown, abilityWordsMatch) now live in script_saal.js
// (SKILLS & ABILITIES — PRE-SEND CLAIM CHECK section), next to checkAbilityClaimFromAI
// (also moved there) since all of these exist only to check ability/skill claims
// specifically. checkCurrencyClaim/checkInventoryClaim directly above are unrelated and
// stay here. Still called from checkClaimAgainstRecords below the same way (global
// scope), same as before the split.

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

// checkAbilityClaimFromAI — MOVED — now lives in script_saal.js (SKILLS & ABILITIES
// — PRE-SEND CLAIM CHECK section), alongside checkAbilityClaim and their shared
// claim-phrase helpers. Still called from checkClaimAgainstRecords below the same way
// (global scope), same as before the split.

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

// checkCurrencyClaimFromAI — MOVED — now lives in script_finance.js, next to
// checkCurrencyClaim and the rest of the Finance guards. Still called from
// checkClaimAgainstRecords below the same way (global scope), same as before the move.

// ---------- pre-send guard: player-requested time-skip that would jump past a still-upcoming
// Scheduled Events entry. This is deliberately a BLOCK, not the clamp guardTimelineDay does —
// guardTimelineDay runs after the story has already replied and just caps the number silently;
// this stops the request before it's ever sent, so the player gets an immediate, specific
// reason instead of the story narrating a smaller skip than what was typed. Reuses the exact
// same phrase detection (maxAllowedDaySkip) and "Day N — desc" parsing (parseDayEntry) the
// post-hoc guard already uses, so the two can never disagree about what counts as a skip.
function checkScheduleSkipClaim(userText, panel){
  if(!panel || !panel.categories) return null;
  const allowedSkip = maxAllowedDaySkip(userText);
  if(allowedSkip <= 0) return null; // no time-skip phrase in this message at all
  let oldNum = null;
  for(const cat of Object.values(panel.categories)){
    if(cat.type !== 'kv' || !cat.data) continue;
    for(const [k, v] of Object.entries(cat.data)){
      if(!CURRENT_DAY_KEY_RE.test(k)) continue;
      const n = parseInt(String(v).replace(/[^\d]/g,''), 10);
      if(!isNaN(n)) oldNum = n;
    }
  }
  if(oldNum == null) return null; // Timeline untracked — nothing to check against
  let nearestUpcoming = null, nearestDesc = null;
  for(const cat of Object.values(panel.categories)){
    if(cat.type !== 'list') continue;
    for(const entry of cat.data || []){
      const parsed = parseDayEntry(entry);
      if(!parsed || parsed.day <= oldNum) continue;
      if(nearestUpcoming == null || parsed.day < nearestUpcoming){
        nearestUpcoming = parsed.day; nearestDesc = parsed.desc;
      }
    }
  }
  if(nearestUpcoming == null) return null; // nothing scheduled ahead — no wall to hit
  if(oldNum + allowedSkip > nearestUpcoming){
    return `You can't skip past Day ${nearestUpcoming} — ${nearestDesc || 'that scheduled event'} hasn't happened yet. Try a smaller time-skip that lands on or before Day ${nearestUpcoming}.`;
  }
  return null;
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
  const scheduleSkipIssue = checkScheduleSkipClaim(userText, panel);
  if(scheduleSkipIssue) return scheduleSkipIssue;
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

// ================= INVENTORY INFO-MODAL & LONG-PRESS ACTION SHEET — MOVED =================
// The Inventory-only pieces of the info modal — renderCatInfoInventoryItems (the
// "Current Items" block), handleInvSlotTap, the inventory item long-press action sheet
// (Equip/Unequip, Delete, Change Photo), and its trailing #invContent click listener —
// now live in script_inventory_equip.js, right next to the rest of the Inventory
// section. Still called from openCatInfoModal and the panelContent click handler below,
// same as before the split.


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
      const isSkillKv = /^learning$/i.test(String(name).trim());
      for(const [rawK,v] of Object.entries(catUpdate.kv)){
        if(v===null || v==='') continue;
        const existingK = findExistingKey(cat.data, rawK) || findFuzzyExistingKey(cat.data, rawK);
        const targetK = existingK || rawK;
        cat.data[targetK] = String(v);
        // a resolved existing key keeps its own hidden ID (nothing to do); a genuinely new key
        // gets a fresh one, assigned once at creation and never reassigned afterward.
        if(!cat.ids[targetK]) cat.ids[targetK] = isSkillKv ? genSkillId(panel) : genId();
      }
    }
    if(cat.type==='list'){
      const isInv = /^inventory/i.test(String(name).trim());
      const isSkillList = /^skills?(\s|&|$)/i.test(String(name).trim());
      const mintId = () => isInv ? genInvId(panel) : isSkillList ? genSkillId(panel) : genId();
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
        // FIX (Milestones false-positive drops): two problems compounded on short, name-less
        // entries — (1) a single shared meaningful word between two 2-3-word entries already
        // hits a 100% overlap ratio (min size 1-2), and (2) Milestones entries routinely have
        // no proper noun at all ("Confessed true feelings", "Made a difficult choice"), so the
        // proper-noun escape hatch above never kicks in to save them. Two fixes: require an
        // ABSOLUTE minimum of 2 overlapping words (a ratio alone can't fire on just one shared
        // word), and use a stricter ratio specifically for Milestones (a category where a false
        // "duplicate" permanently and silently erases a real story beat, so it should err
        // heavily toward keeping the new entry) rather than the 0.6 bar tuned for categories
        // like Inventory/Scheduled Events where near-duplicates are a bigger practical risk.
        const isMilestoneCat = /^milestones?$/i.test(String(name).trim());
        const DUPLICATE_THRESHOLD = isMilestoneCat ? 0.8 : 0.6;
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
            return overlap>=2 && (overlap/Math.min(a.size,b.size)) >= DUPLICATE_THRESHOLD;
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
          // Both conditions must hold: sharing "most of the words" is meaningless if that's
          // only one word total (e.g. two 2-word entries sharing a single generic term) —
          // absolute overlap count guards against exactly that on short entries.
          return overlap>=2 && similarity >= DUPLICATE_THRESHOLD;
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
          const dupOf = cat.data.find(existing => isNearDuplicate(it, existing));
          if(dupOf){
            // Visible now instead of silent — if a genuinely new entry is ever wrongly caught
            // here, this is the first place to look.
            console.warn(`[${name}] dropped as near-duplicate of existing entry`, {new: it, existing: dupOf});
            return;
          }
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
// ================= RELATIONSHIPS — ORPHAN CLEANUP ON MESSAGE DELETE =================
// restorePanelHistoryTo (called from revertOrResyncAfterDelete in script_chatroom.js) already
// reverts the whole sheet to its exact pre-delete snapshot, which normally drops a Relationships
// entry on its own if the deleted message was what introduced that person. This is a deterministic
// backstop for the cases that revert doesn't fully cover — a chat saved before panel history
// existed, a delete reaching further back than the PANEL_HISTORY_CAP retains, or the AI-based
// resyncMemoryAndPanel fallback missing it. After ANY delete, drop a Relationships entry whenever
// that person's name no longer appears anywhere in the remaining chat's text at all — plain
// substring text search, no AI involved. Returns true if anything was actually removed, so the
// caller knows whether to persist the change.
function pruneOrphanedRelationships(panel, chat){
  if(!panel || !panel.categories) return false;
  const relName = findExistingKey(panel.categories, 'Relationships');
  const cat = relName ? panel.categories[relName] : null;
  if(!cat || cat.type !== 'kv' || !cat.data) return false;
  const fullText = (chat||[]).map(m => String((m && m.text) || '')).join('\n').toLowerCase();
  let changed = false;
  for(const key of Object.keys(cat.data)){
    const nameLower = key.toLowerCase().trim();
    if(!nameLower) continue;
    // A name with no remaining mention anywhere in the chat can no longer be considered
    // "on-page" per the Relationships rule (see CAT_INFO below) — the person who introduced
    // them is gone from the record, so the entry shouldn't linger on the sheet either.
    if(!fullText.includes(nameLower)){
      delete cat.data[key];
      if(cat.ids) delete cat.ids[key];
      changed = true;
    }
  }
  return changed;
}

// ================= RELATIONSHIPS — SHORT-LABEL DISPLAY HELPER =================
// Reduces a Relationships entry's full, running-history value down to a short standing
// label (its leading clause) — the full text itself is never touched, just not all shown
// inline on the main sheet. See relInfoModal for where the complete text still lives, one
// tap away. Called from renderPanelHtml below.
function relationshipShortLabel(fullText){
  const s = String(fullText||'').trim();
  if(!s) return '(none yet)';
  // The leading clause is meant to BE the short nature/standing tag (see the Relationships
  // rule in PANEL_SYS_PROMPT — "Friendly", "Father (Friendly)", "Brother (Enemy)", etc.), with
  // any longer history/detail living after the first comma/semicolon/period. Find that split
  // point while tracking paren depth, so a parenthetical standing like "(Friendly)" is never
  // cut in half just because it happens to contain no punctuation of its own.
  let depth = 0, cut = -1;
  for(let i=0;i<s.length;i++){
    const ch = s[i];
    if(ch==='(') depth++;
    else if(ch===')') depth = Math.max(0, depth-1);
    else if((ch===','||ch===';'||ch==='.') && depth===0){ cut = i; break; }
  }
  const firstClause = (cut===-1 ? s : s.slice(0, cut)).trim();
  const words = firstClause.split(/\s+/).filter(Boolean);
  // Generous safety-net cap (older/off-model entries may still be full sentences) — but the
  // cut point itself is picked at a word boundary, and never lands inside an open "(...)",
  // so a standing tag like "Brother (Enemy)" is never sliced into "Brother (Enemy…" or worse.
  if(words.length <= 8) return firstClause;
  let end = 0, wordCount = 0, parenDepth = 0;
  for(let i=0;i<firstClause.length;i++){
    const ch = firstClause[i];
    if(ch==='(') parenDepth++;
    else if(ch===')') parenDepth = Math.max(0, parenDepth-1);
    if(/\s/.test(ch) && parenDepth===0){
      wordCount++;
      if(wordCount>=6){ end = i; break; }
    }
    end = i+1;
  }
  const truncated = firstClause.slice(0, end).trim();
  return truncated + (truncated.length < firstClause.length ? '…' : '');
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
      // Learning shares Skills & Abilities' hidden numbered-id scheme (see genSkillId/
      // numFromSkillId in script_saal.js) — surfaced here as the same "(i)", "(ii)" roman
      // tag Skills & Abilities shows below, so a Learning entry keeps a visibly-stable tag
      // across the exact moment it graduates into Skills & Abilities (same id, same number).
      const isLearningCat = /^learning$/i.test(String(name).trim());
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
              // Same permanent hidden id Skills & Abilities uses (genSkillId), just read off
              // Learning's own cat.ids map by key instead of by list index.
              const learnId = (isLearningCat && cat.ids) ? cat.ids[k] : null;
              const learnNum = learnId ? numFromSkillId(learnId) : null;
              const learnNumHtml = learnNum ? `<span class="panel-chip-num panel-chip-num-skill" style="opacity:.5;font-weight:600;margin-right:4px;">(${toSkillRoman(learnNum)})</span>` : '';
              return `<div class="panel-skill-row">
                <div class="panel-skill-head"><span class="panel-k">${learnNumHtml}${escapeHtml(k)}</span><span class="panel-skill-pct${mastered?' is-mastered':''}">${mastered ? 'Mastered' : pct+'%'}</span></div>
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
            // Skills & Abilities gets the same permanent-number treatment as Inventory, just
            // with its own visible face — "(i)", "(ii)", ... — since it shares Learning's
            // hidden genSkillId/numFromSkillId scheme (see script_saal.js) rather than
            // Inventory's genInvId/numFromId. A Learning entry graduating into this list keeps
            // its exact id (and therefore its exact roman tag) unchanged across the move.
            const skillNum = isSkillsCat ? numFromSkillId(itemId) : null;
            const skillNumHtml = skillNum ? `<span class="panel-chip-num panel-chip-num-skill" style="opacity:.5;font-weight:600;margin-right:4px;">(${toSkillRoman(skillNum)})</span>` : '';
            const parsedLabel = isInventoryCat ? splitItemEntry(label) : null;
            const hasQty = parsedLabel && parsedLabel.qty != null && !isNaN(parsedLabel.qty);
            const nameOnly = hasQty ? parsedLabel.name : label;
            const qtyHtml = hasQty ? `<span class="panel-chip-qty" style="opacity:.65;margin-left:5px;font-weight:600;">×${parsedLabel.qty.toLocaleString('en-US')}</span>` : '';
            // Status is still tracked/parsed (guards, the merge-name logic, and the Inventory
            // info modal's grouped "Current Items" view all still rely on it) — it's just no
            // longer shown inline on the Letter of Records chip itself for Inventory, per
            // request. Every other list category keeps showing its status suffix as before.
            const labelHtml = `${numHtml}${skillNumHtml}${escapeHtml(nameOnly)}${qtyHtml}${(status && !isInventoryCat) ? `<span class="panel-chip-status">${escapeHtml(status)}</span>` : ''}`;
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
                : isSkillsCat
                  // Skills & Abilities gets its own always-on delete cross (not tucked behind
                  // a long-press action sheet like Inventory) — reuses the exact .panel-chip
                  // [data-id] / .panel-chip-del look the dedicated Inventory merge page
                  // already defines, just wired to a plain delete instead of a drag.
                  ? `<span class="panel-chip${isPast ? ' is-past' : ''}" data-id="${escapeHtml(itemId)}"><span class="panel-chip-label">${labelHtml}</span><button type="button" class="panel-chip-del" data-skill-del="${escapeHtml(itemId)}" title="Remove">✕</button></span>`
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

// ================= INVENTORY DRAG-TO-MERGE — MOVED =================
// wireInventoryChipDrag (the long-press-then-drag pickup, auto-scroll, and drop-to-merge
// wiring for the dedicated Inventory-only page) now lives in
// script_inventory_equip.js (SECTION 2 — INVENTORY). Still called from
// paintInventoryModal, same as before the move.

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
    how:'Gaining an item, or more of one already owned: only happens when your own message contains an acquisition phrase naming the item \u2014 bought, received, paid, looted, found, picked up, took, earned, won, claimed, traded/exchanged/swapped for it, or were gifted/donated it \u2014 or when you use/apply a graduated ability of yours (duplication, creation, multiplication, transmutation, or similar) directly on it, written as \u201cI used/applied my <ability> on/to <item>.\u201d The ability has to already be a fully mastered entry in Skills & Abilities \u2014 one still sitting in Learning at 90% or below doesn\u2019t count, even if the story\u2019s own narration describes it succeeding on its own; that specific item change is blocked until the ability actually graduates. Any number you state has to match the real gain, or it\u2019s corrected or blocked. Just mentioning an ability and an item together, with no actual use/apply claim, is never enough on its own.\n\nLosing quantity (without deleting the item): only when your message shows you using, spending, throwing, consuming, dropping, or otherwise expending it \u2014 \u201cI used/threw/detonated/spent/dropped/ate/drank...\u201d A stack can never drop below zero.\n\nStatus \u2014 what it\u2019s doing or where it\u2019s kept: the note after an item\u2019s name (Equipped, Sheathed, Poisoned, Hidden under the bed, Left at the shop, etc.) only changes when your message actually shows that happening. \u201cRemove/take off\u201d only unequips \u2014 the item stays in Inventory, just no longer worn/held. If the status shows the item stored, hidden, or left away from your person, you can\u2019t use it until the story shows you physically getting it back.\n\nDeleting an item entirely: only when your message shows it actually being gotten rid of \u2014 thrown away/out, left behind, dropped, tossed, discarded, abandoned, buried, given away, gifted, donated, sold, traded/exchanged/swapped away, lost, gotten rid of, or destroyed. Unequipping is never deletion.\n\nNumbering: the \u201c#N\u201d assigned when an item is first added is permanent \u2014 it\u2019s never reassigned or reused, even after that item is deleted. The count only ever goes up.',
    wont:'Just talking about wanting, considering, haggling over, or planning to use an item \u2014 nothing changes until the story actually shows the moment happening. Mentioning a listed ability and an item in the same sentence with no actual use/apply claim doesn\u2019t grant anything either, and naming an ability that\u2019s still in Learning (not yet graduated) never grants or changes an item no matter how it\u2019s phrased.',
    use:'Tap the expand icon next to \u201cInventory\u201d on the Letter of Records to open the dedicated Inventory page \u2014 everything below happens there, immediately, and doesn\u2019t need the story to confirm it since these are actions you\u2019re taking directly rather than something narrated.\n\nMerging: long-press one item and drag it onto another to combine them into a new, single combined item.\n\nDeleting: tap the \u2715 on any item\u2019s chip to permanently remove it from the sheet.'
  },
  // Skills & Abilities and Learning entries — MOVED — now live in CAT_INFO_SAAL in
  // script_saal.js, right next to the rest of that pair's guard/migration/claim-check logic.
  // getCatInfo below falls through to CAT_INFO_SAAL after this array, so the lookup behavior
  // for every other category here is unchanged.
  { test:/^timeline$/i, title:'Timeline', what:'The story\u2019s current day count. This section is permanent \u2014 it\u2019s always on the sheet from the very start, beginning at Day 1, even before any time has passed.', how:'It only ever counts up, one confirmed step at a time \u2014 Day 1 \u2192 Day 2 \u2192 Day 5 and so on \u2014 and only when the story shows a clear time skip: phrases like \u201covernight,\u201d \u201cthe next morning,\u201d or \u201ca week later.\u201d It advances by exactly however many days that skip covers, never more.', wont:'A busy scene on its own. The day never moves backward, and it won\u2019t advance just because a lot happened \u2014 only an explicit skip forward moves it. A countdown mention like \u201c50 days remaining\u201d or \u201cin 12 days\u201d also won\u2019t move it \u2014 that describes time still ahead, not time that\u2019s actually passed, so it\u2019s not counted as a skip.', use:'You can\u2019t set the day directly, but adding a Scheduled Event (see that section below) is how you give the timeline something to count toward \u2014 open "system bro" and use the Scheduled Events tile to pin a date to the calendar.' },
  { test:/^scheduled\s*events?/i, title:'Scheduled Events', what:'Upcoming dated events already set up for this story \u2014 exams, appointments, deadlines, ceremonies \u2014 each shown as "Day N \u2014 event." This section is permanent \u2014 it\u2019s always on the sheet, even with nothing scheduled yet.', how:'You add every entry yourself \u2014 either through the tile below, or by writing a "Day N \u2014 event" line straight into the world\u2019s own setup text before the story begins. The story never adds one on its own, even if the setup text mentions a date some other way. Once Current Day reaches or passes an entry\u2019s day, the story actively brings it about on its own initiative in the very next reply \u2014 someone comes to fetch you, an announcement is made, and so on \u2014 you never need to ask for it or type anything to make a due event happen. It still only ever costs you the one reply you already get from Send or Forward, never an extra one.', wont:'An entry is never removed \u2014 not by you, not by the story, not once it\u2019s due. It\u2019s a permanent record: once its day arrives it just dims in place to show it\u2019s passed, and stays visible from then on. The story also can\u2019t add a new entry on its own \u2014 if it never got added here, it\u2019s not tracked.', use:'Open "system bro" and tap the Scheduled Events tile \u2014 fill in the description (day optional) and add it. Leave the day out and the event is due right away; give a day that\u2019s already passed and it snaps to today instead. Or, when first creating the world, write a line like "Day 12 \u2014 Ch\u016bnin Exam" directly into the setup text \u2014 it\u2019s picked up automatically the moment the world is saved. The tile lists everything already scheduled, with due entries shown dimmed.' },
  { test:/^status$/i, title:'Status', what:'The character\u2019s current condition \u2014 health, mood, or any effect currently active.', how:'It changes when the story actually shows a shift \u2014 an injury, a change in mood, an effect wearing off.', wont:'A passing mention or throwaway line that doesn\u2019t actually change the character\u2019s state.' },
  { test:/^relationships?$/i, title:'Relationships', what:'The people the character has actually met and how things currently stand with each of them \u2014 shown here as a short standing (e.g. \u201cFriendly,\u201d \u201cEnemy,\u201d \u201cFather\u201d). Tap a name to see the full detail behind it.', how:'An entry appears only once that person has actually shown up and appeared on-page in the story \u2014 never just from the world\u2019s setup text before they\u2019ve appeared, and never from someone else merely mentioning their name. The short standing shown here updates whenever the story actually shifts it on-page.', wont:'An NPC being named in passing by someone else, a person mentioned only in the world\u2019s lore/setup before they\u2019ve appeared, or a one-off interaction that doesn\u2019t actually move the relationship.' },
  { test:/^milestones?$/i, title:'Milestones', what:'The significant turning points or achievements the character has reached in the story.', how:'An entry is added when the story marks something as a genuine milestone, not just an ordinary scene.', wont:'Routine events or minor beats that don\u2019t rise to that level.' },
];
const CAT_INFO_DEFAULT = { what:'A part of the story\u2019s Letter of Records that this particular world introduced on its own.', how:'It fills in and changes automatically as the story establishes or changes it on-page.', wont:'A mention, a plan, or a guess. It only changes once the story actually shows that change happening \u2014 it isn\u2019t something to edit directly.' };
function getCatInfo(name){
  const trimmed = String(name||'').trim();
  // Skills & Abilities and Learning live in CAT_INFO_SAAL (script_saal.js) instead of this
  // array now — checked second, so nothing about the lookup for any other category changes.
  const match = CAT_INFO.find(c => c.test.test(trimmed)) || CAT_INFO_SAAL.find(c => c.test.test(trimmed));
  return { title: trimmed || 'Section', what:(match||CAT_INFO_DEFAULT).what, how:(match||CAT_INFO_DEFAULT).how, wont:(match||CAT_INFO_DEFAULT).wont, use:(match||CAT_INFO_DEFAULT).use || null };
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
  // Skills & Abilities per-chip delete — tapping the ✕ removes just that entry (matched by
  // its own permanent hidden id, never by position) after a confirm, then saves and repaints
  // the sheet in place. Checked first so the tap never also falls through to opening the
  // Skills & Abilities info modal underneath it.
  const skillDelBtn = e.target.closest('[data-skill-del]');
  if(skillDelBtn){
    e.stopPropagation();
    const id = skillDelBtn.getAttribute('data-skill-del');
    if(id && state.chattingId && confirm('Remove this from Skills & Abilities? This can\'t be undone.')){
      (async ()=>{
        const panel = await getPanel(state.chattingId);
        if(deleteSkillEntryById(panel, id)){
          await savePanel(state.chattingId, panel);
          await paintPanel();
        }
      })();
    }
    return;
  }
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

els.closeCatInfoBtn.onclick = ()=> els.catInfoModal.style.display = 'none';
els.catInfoModal.onclick = (e)=>{ if(e.target===els.catInfoModal) els.catInfoModal.style.display='none'; };
els.closeRelInfoBtn.onclick = ()=> hideOverlayModal(els.relInfoModal);
els.relInfoModal.onclick = (e)=>{ if(e.target===els.relInfoModal) hideOverlayModal(els.relInfoModal); };

// Equip-box tap-to-upload handlers (initEquipHubPickers) — MOVED — now live in
// script_inventory_equip.js, right next to the equip-box HTML they
// wire up (renderEquipCompassHtml). Runs the same way — a plain top-level IIFE — global
// scope, so it still wires up these listeners once the page loads, same as before the split.
