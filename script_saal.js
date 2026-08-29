/* script_saal.js — Skills & Abilities and Learning: the deterministic guards
   that keep those two sections of the Letter of Records honest.

   This is one quarter of what used to be a single script_letter_of_records.js,
   later split out into this file (Skills & Abilities + Learning) and three
   siblings: script_finance.js (Finances), script_inventory_equip.js
   (Inventory/Equip Box), and script_tase.js (Timeline/Scheduled Events) —
   split so each pair of sections can be read and edited independently of the
   others.
   Depends on globals from index.html's inline Section 1 (load that file first); load
   order relative to script_chatroom.js, script_finance.js, script_inventory_equip.js,
   and script_tase.js doesn't matter — all share one global scope.

   The data model/schema, merge engine, panel rendering, most of the pre-send claim
   checks, and the Relationships short-label helper all live in
   script_letter_of_records.js, which calls many functions defined here
   (guardSkillProgress, guardSkillGraduation, seedSkillsFromLore, etc.) from its own
   schema/migration/merge-pipeline code. The one piece of the pre-send claim checks
   that lives here instead is the ability/skill claim checker (Section 5 below) —
   it's ability-specific, so it moved here rather than staying with the
   currency/inventory checkers in script_letter_of_records.js.

   One cross-file dependency worth flagging: normalizeSkillLabel and guardSkillGraduation
   (both in the Skills & Abilities section below) are called from
   script_inventory_equip.js's Inventory section, so an ability referenced from an
   Inventory item is checked against the same normalized name and graduation state
   Skills & Abilities itself uses. Safe across the file split since all files share one
   global scope and are loaded together.

   Organized into 4 numbered sections below, each broken into lettered subsections for
   quick scanning (search for e.g. "3.4" to jump straight to a subsection):

     3. SKILLS & ABILITIES  — the permanent, definitive record.
          3.1  Numbered "#N" id scheme shared with Learning
               (genSkillId, numFromSkillId)
          3.2  Display-only lowercase-roman formatter
               (SKILL_ROMAN_TABLE, toSkillRoman)
          3.3  Legacy id migration
               (migrateLegacySkillIds)
          3.4  Per-entry delete
               (deleteSkillEntryById)
          3.5  Legacy schema migration
               (migrateSkillCategoryNames)
          3.6  Mastery graduation out of Learning
               (promoteMasteredSkills)
          3.7  Duplicate-cleanup repair
               (repairDuplicateSkills)
          3.8  Graduation backstop guard
               (normalizeSkillLabel, guardSkillGraduation)
          3.9  Item-vs-power routing backstop
               (SKILL_ITEM_NOUN_SET, skillEntryLooksLikeItem, guardItemVsPowerRouting)
          3.10 Lore-seeding for starting abilities
               (seedSkillsFromLore)
          3.11 Fusion — combining two owned entries into a new one, named by the player via
               an in-chat picker rather than an AI-guessed name
               (FUSE_TRIGGER_RE, isFusedSkillKey, skillFullNameInText, namedOwnedSkillsInText,
               skillBaseName, buildFusionNameOptions, guardSkillFusion — sets
               panel.pendingFusion, consumed by attachFusionPromptIfPending/resolveFusionChoice
               in script_chatroom.js)
          3.12 Innate Power / Affinity — world-creation only, never chat-created
               (RESERVED_SKILL_TAG_RE, guardInnateAffinityChatRestriction)

     4. LEARNING            — in-progress percentage tracking. Skills graduate OUT of
                              here into section 3 above once they pass 90%.
          4.1  Duplicate-key cleanup repair
               (repairDuplicateLearningKeys)
          4.2  Percentage-progress guard — also where a "(Fusion)" entry's halved
               step (+5 instead of +10) and creation-on-fuse exception live
               (SKILL_PCT_RE, PRACTICE_TRIGGER_RE, skillLabelWords,
               skillMentionedInText, guardSkillProgress)

     5. PRE-SEND CLAIM CHECK — ABILITY / SKILL — moved from script_letter_of_records.js.
                              Called from checkClaimAgainstRecords in that file.
          5.1  Claim-phrase vocabulary & tokenizing helpers
               (CLAIM_VERB_SRC, CLAIM_SKIP_BEFORE_SRC, CLAIM_STRIP_WORDS,
               claimPhraseWords, sameWordRoot)
          5.2  Sheet word-set matching
               (panelEntryWordSets, sequenceMatches, phraseMatchesEntry, abilityWordsMatch)
          5.3  Layer 1 — deterministic regex check
               (checkAbilityClaim)
          5.4  Layer 2 — checker for the AI read step's extracted claims
               (panelHasEntryId, checkAbilityClaimFromAI)

     6. INFO MODAL ENTRIES  — CAT_INFO_SAAL (moved from script_letter_of_records.js'
                              CAT_INFO): the "what is this section?" text for Skills
                              & Abilities and Learning. getCatInfo in
                              script_letter_of_records.js checks this array right
                              after its own CAT_INFO.

   Timeline and Scheduled Events — the day-advancement and dated-entry sections that
   used to sit alongside these two — now live in script_tase.js.

   Order is for readability only — every top-level binding is a function
   declaration or a plain const assigned at load time, so nothing above is
   order-sensitive at runtime.
   ################################################################################ */


// ################################################################################
// SECTION 3 — SKILLS & ABILITIES
// The permanent, definitive record of what the character can actually use. Legacy
// schema migration, mastery graduation out of Learning (passing 90% -> a plain owned entry),
// duplicate cleanup, the graduation backstop guard, and lore-seeding for starting
// abilities. Learning — the in-progress percentage tracker these graduate FROM — has
// its own section (7) right below.
// ################################################################################


// ---------- 3.1 — numbered "#N" id scheme for Skills & Abilities / Learning ----------
// Same design as Inventory's genInvId/numFromId in script_inventory_equip.js: an entry's
// hidden identity encodes its visible "#N" number directly, so there's exactly one source
// of truth instead of a separate id-to-number lookup table that could drift out of sync.
// Skills & Abilities and Learning share ONE counter/prefix rather than each getting its
// own, because a Learning entry keeps the exact same id when it graduates into Skills &
// Abilities (see promoteMasteredSkills) — it's a state change, not a new entry, so its
// visible number has to survive the move unchanged too.
// The prefix is "s" (as in "s1_x7k2p9q"), deliberately different from Inventory's "n"
// prefix, so a Skills/Learning id and an Inventory id can never collide as strings even
// on saves large enough that both counters reach the same number — panelHasEntryId and any
// other cross-category id lookup can trust the prefix alone to tell the two apart.
// panel.skillNumSeq is the running "next number to hand out" counter, persisted at the
// panel's top level next to Inventory's panel.numSeq (see sanitizePanel/defaultPanel/
// migrateOldPanel in script_chatroom.js — that's also where new list_add/kv entries get
// their ids assigned via ensureCategoryIds, so it needs a branch calling genSkillId for
// the Skills & Abilities / Learning categories the same way it already calls genInvId for
// Inventory).
function genSkillId(panel){
  if(typeof panel.skillNumSeq !== 'number' || isNaN(panel.skillNumSeq)) panel.skillNumSeq = 0;
  panel.skillNumSeq += 1;
  return 's' + panel.skillNumSeq + '_' + Math.random().toString(36).slice(2, 9);
}
function numFromSkillId(id){
  const m = /^s(\d+)_/.exec(String(id||''));
  return m ? parseInt(m[1], 10) : null;
}
// ---------- 3.2 — display-only lowercase-roman-numeral formatter for Skills & Abilities / Learning ----------
// Inventory shows its permanent hidden number as "#N" (see numFromId in
// script_inventory_equip.js). Skills & Abilities and Learning share the exact same
// id-encodes-number scheme (numFromSkillId above) but get their own visible face here —
// "(i)", "(ii)", "(iii)", ... — so the two id schemes stay visually distinct on the sheet
// even though the underlying mechanism (hidden id -> permanent number, never reassigned)
// is identical. Called from renderPanelHtml in script_letter_of_records.js the same way
// that file already calls numFromId/numFromSkillId directly.
const SKILL_ROMAN_TABLE = [
  [1000,'m'],[900,'cm'],[500,'d'],[400,'cd'],
  [100,'c'],[90,'xc'],[50,'l'],[40,'xl'],
  [10,'x'],[9,'ix'],[5,'v'],[4,'iv'],[1,'i']
];
function toSkillRoman(num){
  let n = parseInt(num, 10);
  if(!n || n < 1) return '';
  let out = '';
  for(const [value, sym] of SKILL_ROMAN_TABLE){
    while(n >= value){ out += sym; n -= value; }
  }
  return out;
}
// ---------- 3.3 — one-time upgrade path for legacy (pre-numbered-scheme) ids ----------
// Any Skills & Abilities or Learning id that predates this scheme
// (a plain genId() string, carrying no number of its own) gets replaced in place with a
// proper numbered id. Learning is walked first and Skills & Abilities second so that, on
// the very first load after this upgrade ships, entries are numbered in a deterministic,
// repeatable order — order has no semantic meaning here since numbers are never
// reassigned once handed out.
function migrateLegacySkillIds(panel){
  if(!panel || !panel.categories) return false;
  let changed = false;
  const learningKey = findExistingKey(panel.categories, 'Learning');
  const learningCat = learningKey ? panel.categories[learningKey] : null;
  // Bug fix: previously assumed .data existed the moment .type matched, with no fallback — a
  // corrupted or partially-migrated save (type correct, data missing/undefined) threw here
  // instead of degrading gracefully. Same fix mirrored below for Skills & Abilities' .data/.ids.
  if(learningCat && learningCat.type === 'kv'){
    if(!learningCat.data || typeof learningCat.data !== 'object') learningCat.data = {};
    if(!learningCat.ids) learningCat.ids = {};
    for(const k of Object.keys(learningCat.data)){
      const id = learningCat.ids[k];
      if(id && numFromSkillId(id) != null) continue; // already a proper numbered id
      learningCat.ids[k] = genSkillId(panel);
      changed = true;
    }
  }
  const skillsKey = findExistingKey(panel.categories, 'Skills & Abilities');
  const skillsCat = skillsKey ? panel.categories[skillsKey] : null;
  if(skillsCat && skillsCat.type === 'list'){
    if(!Array.isArray(skillsCat.data)) skillsCat.data = [];
    if(!Array.isArray(skillsCat.ids)) skillsCat.ids = [];
    for(let i=0;i<skillsCat.data.length;i++){
      const id = skillsCat.ids[i];
      if(id && numFromSkillId(id) != null) continue; // already a proper numbered id
      skillsCat.ids[i] = genSkillId(panel);
      changed = true;
    }
  }
  return changed;
}

// ---------- 3.4 — per-entry delete for Skills & Abilities (the ✕ on a chip) ----------
// Removes exactly one entry, matched by its own permanent hidden id (never by position or
// text) — same targeting approach as every other id-based lookup in this file, and mirrors
// deleteInventoryItemById in script_inventory_equip.js. Learning entries are untouched by
// this (they haven't graduated yet, so there's nothing permanent there to delete); this only
// ever removes from the permanent Skills & Abilities list itself.
// Caller (the panelContent click handler in script_letter_of_records.js) is responsible for
// calling savePanel and repainting afterward — this function only mutates the in-memory panel.
function deleteSkillEntryById(panel, id){
  if(!panel || !panel.categories || !id) return false;
  const skillsKey = findExistingKey(panel.categories, 'Skills & Abilities');
  const skillsCat = skillsKey ? panel.categories[skillsKey] : null;
  if(!skillsCat || skillsCat.type !== 'list' || !Array.isArray(skillsCat.ids)) return false;
  const idx = skillsCat.ids.indexOf(id);
  if(idx === -1) return false;
  // Bug fix: ids and data are two parallel arrays kept in sync by convention only — nothing
  // enforced that. If they were ever to drift out of sync (a partial migration, an earlier bug,
  // a hand-edited save), blindly splicing data at the same idx silently deleted the WRONG entry
  // instead of failing loudly. Refuse rather than guess.
  if(!Array.isArray(skillsCat.data) || idx >= skillsCat.data.length){
    console.warn(`[skill delete] ids/data out of sync for Skills & Abilities (id index ${idx}, data length ${skillsCat.data ? skillsCat.data.length : 'n/a'}) — refusing to delete to avoid removing the wrong entry`);
    return false;
  }
  skillsCat.ids.splice(idx, 1);
  skillsCat.data.splice(idx, 1);
  return true;
}


// ---------- 3.5 — one-time structural migration for older saves ----------
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
        // one, so its identity survives the schema change intact. A freshly-minted id here
        // uses the numbered Skills/Learning scheme (genSkillId), not the old bare genId(),
        // so an old-style save gets its first "#N" number the moment it's touched by this
        // migration rather than needing a second pass from migrateLegacySkillIds.
        learningCat.ids[targetK] = learningCat.ids[targetK] || (oldCat.ids && oldCat.ids[k]) || genSkillId(panel);
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
          skillsCat.ids.push((jutsuCat.ids && jutsuCat.ids[i]) || genSkillId(panel));
        }
      });
    }else if(jutsuCat.type === 'kv'){
      Object.entries(jutsuCat.data||{}).forEach(([k,v])=>{
        const entry = `${k}: ${v}`;
        if(!skillsCat.data.includes(entry)){
          skillsCat.data.push(entry);
          skillsCat.ids.push((jutsuCat.ids && jutsuCat.ids[k]) || genSkillId(panel));
        }
      });
    }
    delete panel.categories[jutsuKey];
    changed = true;
  }
  return changed;
}


// ---------- 3.6 — mastery graduation out of Learning ----------
// A "Learning" entry that PASSES 90% graduates automatically: it's removed from Learning
// and added to Skills & Abilities as a normal, permanently-usable entry. "Passes" means
// strictly greater than 90 — landing exactly on 90% (e.g. after 9 practice reps at a flat
// +10% each) is not enough yet; the very next confirmed rep (→100%) or anything else that
// pushes it above 90 is what triggers graduation.
function promoteMasteredSkills(panel){
  if(!panel || !panel.categories) return false;
  const learningKey = findExistingKey(panel.categories, 'Learning');
  if(!learningKey) return false;
  const learningCat = panel.categories[learningKey];
  if(!learningCat || learningCat.type !== 'kv') return false;
  if(!learningCat.ids) learningCat.ids = {};
  // Numeric >90 rather than an exact "100%" string match — ANY value that ends up above 90,
  // however it got there (a normal +10% step landing on 100, a resync correction, a migration,
  // or a bug that overshoots past 100), must graduate. This is the only path that moves an
  // entry out of Learning, so a strict ">=100 only" check here was a single point of failure:
  // a value that overshot 100 from some other code path, or one that was intentionally allowed
  // to graduate as soon as it clears 90, would otherwise get stuck in Learning forever.
  const masteredKeys = Object.keys(learningCat.data).filter(k => {
    const n = parseFloat(String(learningCat.data[k]).replace('%','').trim());
    return !isNaN(n) && n > 90;
  });
  if(masteredKeys.length === 0) return false;
  const skillsKey = findExistingKey(panel.categories, 'Skills & Abilities') || 'Skills & Abilities';
  if(!panel.categories[skillsKey]) panel.categories[skillsKey] = { type:'list', data:[], ids:[] };
  const skillsCat = panel.categories[skillsKey];
  if(!Array.isArray(skillsCat.ids)) skillsCat.ids = [];
  masteredKeys.forEach(k=>{
    const carriedId = learningCat.ids[k];
    delete learningCat.data[k];
    delete learningCat.ids[k];
    // Identity-preserving comparison (see normalizeSkillIdentity above) — a fused/tagged
    // variant of an owned skill (e.g. "Fireball (Fusion)" graduating while plain "Fireball" is
    // already owned) must NOT be treated as the same entry and silently dropped here.
    const already = skillsCat.data.some(it => normalizeSkillIdentity(it) === normalizeSkillIdentity(k));
    if(!already){
      skillsCat.data.push(k);
      // the graduated skill keeps the SAME hidden ID it had while it was a Learning entry —
      // graduating from a percentage bar to a plain owned ability is a state change, not a
      // new entry, so nothing downstream should treat it as having reset. A missing
      // carriedId (only possible for a pre-numbered-scheme legacy save that skipped the
      // migration) falls back to a fresh genSkillId rather than the old bare genId(), so
      // it still comes out with a proper "#N" number.
      skillsCat.ids.push(carriedId || genSkillId(panel));
    }
  });
  return true;
}


// ---------- 3.7 — duplicate-cleanup repair ----------
// One-time repair for saves affected by a past bug where a skill could get added to Skills &
// Abilities while still sitting at 90% or below in Learning (guardSkillGraduation now prevents
// this going forward — see its comment above). Removes any Skills & Abilities entry that still
// has a matching not-yet-passed-90% Learning entry, so a skill in progress no longer also shows
// up as already mastered. Uses the same loose-label matching as the guard itself.
function repairDuplicateSkills(panel){
  if(!panel || !panel.categories) return false;
  const learningKey = findExistingKey(panel.categories, 'Learning');
  const learningCat = learningKey ? panel.categories[learningKey] : null;
  if(!learningCat || learningCat.type !== 'kv') return false;
  const inProgress = Object.entries(learningCat.data)
    .filter(([,v]) => { const n = parseInt(String(v).trim(), 10); return !isNaN(n) && n <= 90; })
    .map(([k]) => normalizeSkillIdentity(k))
    .filter(Boolean);
  if(!inProgress.length) return false;
  let changed = false;
  const skillsKey = findExistingKey(panel.categories, 'Skills & Abilities');
  const skillsCat = skillsKey ? panel.categories[skillsKey] : null;
  if(!skillsCat || skillsCat.type !== 'list') return false;
  if(!Array.isArray(skillsCat.ids)) skillsCat.ids = [];
  const keptData = [], keptIds = [];
  skillsCat.data.forEach((it, i)=>{
    // Identity-preserving comparison (see normalizeSkillIdentity above) — an owned, mastered
    // "Ice Spike" must never be deleted just because an unrelated, still-in-progress
    // "Ice Spike (Fusion)" happens to share a base name in Learning.
    const norm = normalizeSkillIdentity(it);
    const stillLearning = inProgress.some(k => norm===k);
    if(stillLearning){ changed = true; return; }
    keptData.push(it);
    keptIds.push(skillsCat.ids[i]);
  });
  if(changed){ skillsCat.data = keptData; skillsCat.ids = keptIds; }
  return changed;
}


// ---------- 3.8 — graduation backstop guard ----------
// Hard code-level guard: a skill can only enter "Skills & Abilities" once it has
// actually graduated (PASSED 90% in "Learning" — strictly greater than 90, not merely reached
// it) — never the moment training starts, and never just because the AI decided to add it
// directly. The system prompt already tells the model not to do this, but the background model
// does it anyway from time to time, which is what causes the same technique to show up both as
// a 10%/16%/44%/90% bar in "Learning" AND as a fully-usable entry in "Skills & Abilities" at
// the same time. This strips any proposed list_add to "Skills & Abilities" that names something
// still at 90% or below in "Learning" — checking BOTH the sheet as it stood before this turn
// AND this turn's own proposed Learning changes (a skill can be added to Learning at, say, 10%
// and to Skills & Abilities in the very same response — the old panel alone wouldn't catch
// that, since the entry didn't exist yet before this turn). promoteMasteredSkills() is the only
// thing allowed to move an entry across once it actually passes 90%.
// (normalizeSkillLabel is also relied on by listedAbilityNames in the Inventory section above,
// which is why this whole guard block sits after Inventory rather than before it.)
function normalizeSkillLabel(s){
  return String(s||'')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ') // drop parenthetical notes like "(Innate Power)"
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
// ---------- identity-preserving comparator (bug fix) ----------
// normalizeSkillLabel is intentionally loose — it strips ALL parenthetical content so that
// mention/graduation checks aren't thrown off by a tag the player would never type themselves.
// That looseness is wrong, though, for any check that's deciding whether two SHEET ENTRIES are
// the same entry: "Fireball" and "Fireball (Fusion)" are two genuinely different abilities (one
// never consumes the other — see 3.11), but normalizeSkillLabel collapses them to the identical
// string. Used against normalizeSkillLabel, that collision previously caused two separate bugs:
// a freshly-graduated entry silently vanishing because it looked like a pre-existing duplicate
// (promoteMasteredSkills, 3.6), and a legitimately-owned entry getting deleted because an
// unrelated, still-in-progress Learning entry merely shared a base name (repairDuplicateSkills,
// 3.7). This keeps parentheses in place (only lowercasing/trimming/collapsing whitespace) so a
// reserved or fusion tag remains part of an entry's identity, while still tolerating harmless
// case/punctuation/whitespace drift between turns. Any check comparing two SHEET entries for
// sameness should use this; normalizeSkillLabel stays reserved for "does the player's own text
// mention this skill" style loose matching, where stripping the tag is correct.
function normalizeSkillIdentity(s){
  return String(s||'')
    .toLowerCase()
    .replace(/[^a-z0-9()\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function guardSkillGraduation(data, panel){
  if(!data || !data.categories) return data;
  // Bug fix — cross-guard dependency: this guard's "everInLearning"/"inProgress" picture is
  // built from THIS TURN'S OWN proposed Learning kv update, which is only trustworthy once
  // guardSkillProgress (4.2) has already screened it — that's the guard that strips a bogus,
  // un-earned percentage (no genuine study/practice phrase behind it) out of the same `data`
  // object. Every call site in this codebase happens to invoke guardSkillProgress immediately
  // before guardSkillGraduation, but nothing enforced that ordering — a future or third-party
  // call site invoking this guard on its own would let an unearned Learning percentage (e.g.
  // Learning:{"X":"95%"} with no practice phrase behind it, proposed in the same response as
  // Skills & Abilities:{list_add:["X"]}) sail through as "already passed 90%, so not still
  // learning" and "has come through Learning", graduating a brand-new ability with zero actual
  // training. Rather than trust caller ordering, screen it here too if it hasn't been already
  // (guardSkillProgress marks `data` once it has run, so this is a no-op — not a double
  // application — on every normal call site).
  if(data && !data.__skillProgressScreened){
    console.warn('[skill guard] guardSkillGraduation ran before guardSkillProgress had screened this update — screening now defensively');
    guardSkillProgress(data, panel, '', false);
  }
  const learningKey = panel && panel.categories ? findExistingKey(panel.categories, 'Learning') : null;
  const learningCat = learningKey ? panel.categories[learningKey] : null;
  // Start from the sheet as it stood before this turn.
  // Identity-preserving keys (see normalizeSkillIdentity above) throughout this guard — a
  // proposed plain "Fireball" must never be blocked or waved through just because an unrelated
  // "Fireball (Fusion)" happens to sit in Learning or Skills & Abilities under the same base name.
  const merged = {}; // identity-normalized label -> percentage number
  if(learningCat && learningCat.type === 'kv'){
    for(const [k,v] of Object.entries(learningCat.data)){
      const n = parseInt(String(v).trim(), 10);
      if(!isNaN(n)) merged[normalizeSkillIdentity(k)] = n;
    }
  }
  // Overlay this turn's own proposed Learning changes (new entries and updates alike) — these
  // take precedence since they reflect what the sheet will actually be after this update.
  const dataLearningKey = findExistingKey(data.categories, 'Learning');
  const dataLearningUpdate = dataLearningKey ? data.categories[dataLearningKey] : null;
  if(dataLearningUpdate && dataLearningUpdate.kv && typeof dataLearningUpdate.kv === 'object'){
    for(const [k,v] of Object.entries(dataLearningUpdate.kv)){
      const n = parseInt(String(v).trim(), 10);
      if(!isNaN(n)) merged[normalizeSkillIdentity(k)] = n;
    }
  }
  const inProgress = Object.entries(merged).filter(([,n]) => n <= 90).map(([k]) => k).filter(Boolean);
  // Everything that has EVER existed in Learning — in-progress and already-mastered alike,
  // this turn or before. A skill has to show up here to count as having "come through"
  // Learning at some point in play.
  const everInLearning = Object.keys(merged).filter(Boolean);
  // Anything already sitting in Skills & Abilities is pre-existing/legitimate (world seeding
  // via seedSkillsFromLore, or something that graduated correctly in the past) — this guard
  // only needs to catch BRAND-NEW proposed entries, not re-flag ones already on the sheet.
  const skillsKeyExisting = panel && panel.categories ? findExistingKey(panel.categories, 'Skills & Abilities') : null;
  const skillsCatExisting = skillsKeyExisting ? panel.categories[skillsKeyExisting] : null;
  const alreadyOwned = (skillsCatExisting && skillsCatExisting.type === 'list' && Array.isArray(skillsCatExisting.data))
    ? skillsCatExisting.data.map(normalizeSkillIdentity).filter(Boolean)
    : [];
  for(const [catName, catUpdate] of Object.entries(data.categories)){
    if(!/^skills?(\s|&|$)/i.test(catName.trim())) continue;
    if(!catUpdate || !Array.isArray(catUpdate.list_add)) continue;
    catUpdate.list_add = catUpdate.list_add.filter(it=>{
      const norm = normalizeSkillIdentity(it);
      const stillLearning = inProgress.some(k => norm===k);
      if(stillLearning){
        console.warn(`[skill guard] blocked "${it}" from entering Skills & Abilities — still in Learning at 90% or below`);
        return false;
      }
      const alreadyOnSheet = alreadyOwned.some(k => norm===k);
      if(alreadyOnSheet) return true; // not actually new — leave it alone
      // Brand-new entry that was never in Learning at all (this turn or before), and isn't
      // already owned. Training always has to pass through Learning first during play — the
      // only other legitimate way to own a skill is world-creation seeding (seedSkillsFromLore),
      // which never runs through this guard, so anything reaching here is the AI trying to grant
      // an ability directly (e.g. "buying the book grants the power"). Block it.
      const everPassedThroughLearning = everInLearning.some(k => norm===k);
      if(!everPassedThroughLearning){
        console.warn(`[skill guard] blocked "${it}" from entering Skills & Abilities — never appeared in Learning first`);
        return false;
      }
      return true;
    });
    if(catUpdate.list_add.length === 0) delete catUpdate.list_add;
  }
  return data;
}


// ---------- 3.9 — item-vs-power backstop: keeps physical objects out of Skills & Abilities ----------
// Hard code-level guard: "Skills & Abilities" is only for something the character's
// own body or mind can do — a power, jutsu, spell, technique, invocable mark/rune/sigil, or a
// superhuman trait (strength, regeneration, elemental control, a "system"-granted ability, and
// so on). A physical object — a magic sword, an enchanted ring, a scroll, a potion, a wand, a
// "system"-granted device — belongs in Inventory instead, no matter how supernatural its
// effect: the power lives in the object, not in the character. The system prompt already tells
// the model this (see ITEM VS POWER in PANEL_SYS_PROMPT), but the background model still slips
// an item-shaped entry into Skills & Abilities from time to time, especially right after the
// player acquires something magical. This is the backstop: strips any proposed Skills &
// Abilities list_add that reads like a physical object rather than a power. It never touches
// Inventory itself — an item that's genuinely magical still belongs there and this guard leaves
// it alone; it only ever blocks the WRONG category, never the item's existence.
//
// Deliberately conservative and narrow, same philosophy as the claim-checker below: only flags
// an entry on a strong signal, never a guess. Two independent signals, either one is enough:
//   1. A leading quantity ("1 Ring of Flame", "3 Scrolls of Binding") — a genuine power is never
//      counted this way; only a stackable Inventory-style entry carries a leading number.
//   2. The entry's own LAST significant word is a concrete, wearable/carryable object noun
//      (ring, sword, wand, scroll, potion, ...) — real item names are built noun-last in English
//      ("Ring of Flame", "Flame Amulet", "Healing Potion"), so this catches the common naming
//      pattern without needing to actually understand the entry's meaning. A genuine power/skill
//      name that happens to end in a different word is never touched by this at all.
const SKILL_ITEM_NOUN_SET = new Set([
  'sword','blade','dagger','knife','axe','hammer','spear','lance','bow','crossbow','gun','pistol',
  'rifle','staff','wand','rod','scepter','sceptre','shield','armor','armour','helmet','helm',
  'gauntlet','gauntlets','glove','gloves','boot','boots','cloak','cape','robe','ring','amulet',
  'pendant','necklace','talisman','charm','bracelet','earring','earrings','crown','tiara','mask',
  'orb','gem','gemstone','crystal','stone','tablet','scroll','tome','grimoire','codex','manual',
  'book','vial','potion','elixir','tonic','brew','draught','flask','bottle',
  'device','gadget','contraption','machine','relic','artifact','trinket','seal','sigil','totem',
  'card','key','coin','token',
  // Anime/ninja-genre weapon and gear nouns — same reasoning as the Western fantasy set above:
  // these are physical objects a technique might be used WITH or ON, never a power themselves,
  // so a proposed Skills & Abilities entry ending in one of these belongs in Inventory instead.
  'kunai','shuriken','shurikens','katana','wakizashi','tanto','naginata','nunchaku','nunchuck',
  'nunchucks','sai','sais','kama','tonfa','tonfas','tessen','senbon','needle','needles',
  'vambrace','vambraces','protector'
]);
function skillEntryLooksLikeItem(entry){
  const s = String(entry||'').trim();
  if(!s) return false;
  if(/^[\d,]+\s+\S/.test(s)) return true; // leading quantity, same shape splitItemEntry parses for Inventory
  const words = s.toLowerCase().replace(/[^a-z0-9\s]/g,' ').trim().split(/\s+/).filter(Boolean);
  if(!words.length) return false;
  // Signal 3 (bug fix): the extremely common "[Item] of [Descriptor]" naming pattern — "Ring of
  // Flame", "Sword of Shadows", "Crown of Thorns", "Amulet of Vigor" — puts the actual item noun
  // FIRST, not last, so the trailing-word check below (signal 2) never catches it: "Ring of
  // Flame" ends in "flame", and "flame" isn't a physical-object noun. Checked narrowly (item
  // noun immediately followed by the literal word "of") so a genuine power name that merely
  // starts with an object-shaped word is never falsely caught.
  const first = words[0];
  const firstSingular = first.replace(/s$/,'');
  if(words.length >= 3 && words[1] === 'of' && (SKILL_ITEM_NOUN_SET.has(first) || SKILL_ITEM_NOUN_SET.has(firstSingular))){
    return true;
  }
  const last = words[words.length-1];
  const lastSingular = last.replace(/s$/,''); // loose singular fold for a trailing plural (Scrolls -> Scroll)
  return SKILL_ITEM_NOUN_SET.has(last) || SKILL_ITEM_NOUN_SET.has(lastSingular);
}
function guardItemVsPowerRouting(data){
  if(!data || !data.categories) return data;
  for(const [catName, catUpdate] of Object.entries(data.categories)){
    if(!/^skills?(\s|&|$)/i.test(catName.trim())) continue;
    if(!catUpdate || !Array.isArray(catUpdate.list_add)) continue;
    catUpdate.list_add = catUpdate.list_add.filter(it=>{
      if(skillEntryLooksLikeItem(it)){
        console.warn(`[item-vs-power guard] blocked "${it}" from entering Skills & Abilities — reads like a physical object, not a power; items belong in Inventory instead`);
        return false;
      }
      return true;
    });
    if(catUpdate.list_add.length === 0) delete catUpdate.list_add;
  }
  return data;
}


// ---------- 3.10 — lore seeding: starting abilities filled in before play begins ----------
// For the same underlying reason seedTimelineFromLore existed (see that module below):
// anything stated in the world's own setup text (an inborn bloodline power, a technique the
// character already knows, a trained proficiency they start the story with, or an AI/game-like
// "system" — status window, cultivation system, power system, daily check-in system, etc. —
// already bound to the character) needs to land on the sheet BEFORE play begins — the regular
// per-turn updatePanel() only ever reads the actual chat log, never world.lore directly, so a
// stated starting ability that the opening scene doesn't happen to restate verbatim would
// otherwise never make it onto the sheet at all. A "system" mechanic is treated the same as any
// other starting ability here (see PANEL_SYS_PROMPT's SKILL & ABILITY PROGRESS section in
// script_chatroom.js, which already treats a system-granted power the same way during live
// play — this pass just extends that same recognition to world-creation text).
// Everything this pass finds is, by definition, something the character can already fully do
// at story start — never a still-in-progress skill — so it goes straight into "Skills &
// Abilities" and "Learning" is explicitly off-limits here; only actual training shown during
// play should ever create a Learning entry.
async function seedSkillsFromLore(world){
  if(!world.lore || !world.lore.trim()) return;
  const panel = await getPanel(world.id);
  const prompt = `World setup text (this world has no story log yet — nothing has happened in it):\n${world.lore}\n\nCurrent character sheet:\n${panelToText(panel)}\n\nThis pass is ONLY for "Skills & Abilities" — ignore everything else the setup text mentions (items, currency, timeline, etc.), those get picked up in their own pass or once the story actually begins. List every skill, technique, spell, bloodline trait, innate power, elemental/magical affinity, or "system"/status-window mechanic this setup text states the character ALREADY has at the start of the story — fully-formed, ready to use right now, whether it's innate (a bloodline, a granted power, a natural affinity), an AI-like system bound to the character (a status window, an interface, a cultivation system, a power system, a daily check-in system, a tenfold-amplification-style system, or any other novel/game-style system already active on the character), or something they're stated to have already learned/trained/mastered before the story begins. A stated system counts here even if the text only says the character HAS or IS BOUND TO it and doesn't spell out what it does yet — add it as its own entry (e.g. "Cultivation System") rather than skipping it for being vague. Add each as a plain entry in "Skills & Abilities" (a list category), EXCEPT: an entry that's innate/inborn and not something trained or granted-as-a-technique (a bloodline power, a natural gift the character was simply born with) must be suffixed " (Innate Power)", and an entry describing an elemental/magical/spiritual affinity or natural aptitude (e.g. "Fire Affinity", "Water Affinity") must be suffixed " (Affinity)" — exact wording, parentheses included, nothing else gets either suffix. This is the ONLY point in the whole app where an "(Innate Power)" or "(Affinity)" entry may ever be created — the live story AI is never allowed to add one later during play, no matter what the story narrates, so get every one of them here. Do NOT create a "Learning" entry for anything here, even if the text describes the character as still improving or not yet a master at it — "Learning" is only ever for training the player actually does DURING play; only skip an ability entirely if the text explicitly says the character hasn't started learning it yet (a stated future goal, not a current ability). Strict scope — an entry must be a genuine innate trait, inborn/bloodline power, superpower, superhuman ability, skill, technique, jutsu, spell, art, form, style, elemental/spiritual/magical affinity, special/mutated organ, mental or psychic power, unique physiology or constitution, martial-arts style, granted blessing or curse, or an AI/game-like "system" mechanic in the novel/anime sense described above. It must NOT be: a mundane real-world skill or hobby with no fictional/superhuman element (cooking, driving, a language, small talk, playing an instrument), a personality trait or ordinary physical trait (brave, tall, fast reflexes on their own with no named technique), a job/role/title (blacksmith, knight, student), a piece of backstory or relationship, a possession or piece of equipment (that belongs in Inventory, never here), or any other stray word or phrase from the setup text that isn't actually naming a power/technique/system. If nothing in the text meets this bar, it is completely correct to add nothing at all — do not stretch ordinary text into an entry just to have something to list. The test that matters most: could the character actually DO something with this during play — invoke it, activate it, fight with it, be empowered by it? If an entry is just flavor/descriptive text with nothing the character can actually use or act on, it does not belong here. A few examples of the line: "the character was born with the Ember Bloodline, letting them summon and control small flames" → ADD "Ember Bloodline (Innate Power)"; "she has trained for years and is a master swordfighter" → ADD "Swordsmanship"; "he is bound to the Hunter System, an interface that tracks his stats" → ADD "Hunter System"; "her left eye is a mutated Sharingan-like organ that lets her copy techniques she sees" → ADD "Mutated Copy Eye"; "he was born clumsy but kind-hearted" → DO NOT ADD (personality/physical trait, no actual power); "she works as a baker in the village" → DO NOT ADD (a job, not a power); "he owns a sword passed down from his father" → DO NOT ADD (belongs in Inventory, not a power the character's own body/mind has); "the kingdom has stood for 200 years" → DO NOT ADD (worldbuilding, not a character ability); a lone unexplained word or name with nothing describing what it does or where it came from → DO NOT ADD (nothing to actually list as a usable ability).`;
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


// ---------- 3.11 — Fusion: combining two owned entries into a new one ----------
// Fusion never consumes its sources — fusing two Skills & Abilities entries (or one Innate
// Power/Affinity entry with a regular skill) leaves both fully intact and just produces a
// brand-new entry alongside them. That new entry always starts life in "Learning", never
// straight in "Skills & Abilities", and — per guardSkillProgress's isFusedSkillKey check in
// Section 4.2 below — climbs at a flat +5% per confirmed study session instead of the normal
// +10% a fresh Learning entry gets, for the rest of its training. It's tagged " (Fusion)" (an
// exact suffix, same convention as "(Innate Power)"/"(Affinity)") so that reduced rate is
// recognizable from the name alone, with no separate flag needed anywhere on the sheet, and it
// gets its own freshly-minted "#N"/"(i)" id via genSkillId, same as any other new Learning entry.
// Hard code-level guard: fusion only ever fires when the player's OWN last message both shows
// genuine combine/fuse intent AND names, in full (not a fuzzy word-overlap match — the real,
// exact name), at least two of the character's own already-owned Skills & Abilities entries.
// Anything short of that — a vague "let's see what these two powers could do together", or
// naming only one entry, or naming two entries with no fuse/combine word at all — never creates
// a "(Fusion)" entry; guardSkillProgress's own gate (Section 4.2) independently blocks a
// brand-new fused entry from being created without this being armed, so this function's real
// job is everything else: recognizing a genuine fusion attempt, redirecting a misrouted attempt
// to drop a fused result straight into "Skills & Abilities" back where it belongs, protecting
// the source entries from being removed in that same turn's update — and, notably, NEVER trusting
// the background model's own guessed name for the result. Instead it queues panel.pendingFusion
// (sources + a handful of name options built from those sources' own names, see
// buildFusionNameOptions below) for the chat UI to present as an inline picker (see
// attachFusionPromptIfPending/resolveFusionChoice in script_chatroom.js) — the actual Learning
// entry, under whichever name the player picks or types, is only ever created once they answer.
const FUSE_TRIGGER_RE = /\b(fuse|fusing|fused|fusion|combin(?:e|ing|ed)|merg(?:e|ing|ed))\b/i;
// Bug fix: was a strictly end-anchored `...\)\s*$` — any stray trailing character (a period, a
// bit of punctuation the model tacks on) defeated detection entirely, since `$` requires the
// closing paren (plus whitespace) to be the literal last thing in the string. Now tolerates
// trailing punctuation after the tag as well as trailing whitespace, so "X (Fusion)." still
// matches. (A stray trailing WORD, as opposed to punctuation, is a rarer case this alone won't
// catch — see isFusedSkillKey's own backstop at 3.8's "never appeared in Learning" check, which
// still applies regardless.)
function isFusedSkillKey(k){
  return /\(\s*fusion\s*\)[\s.,!?;:]*$/i.test(String(k||'').trim());
}
// Full, exact-name match (parenthetical tags stripped via normalizeSkillLabel) rather than the
// looser word-set matching the claim-checker in Section 5 uses — fusion is a rarer, more
// consequential action, so it asks for the skill's real full name to actually appear in the
// player's own text, not just a handful of overlapping words.
function skillFullNameInText(label, text){
  const name = normalizeSkillLabel(label);
  if(!name) return false;
  return String(text||'').toLowerCase().replace(/\s+/g,' ').includes(name);
}
// Which of the character's already-owned Skills & Abilities entries (never a still-in-progress
// Learning entry — fusion sources have to be fully graduated/owned already) the player's own
// message names in full. Returns the matching entries' exact on-sheet labels.
function namedOwnedSkillsInText(panel, text){
  const skillsKey = panel && panel.categories ? findExistingKey(panel.categories, 'Skills & Abilities') : null;
  const skillsCat = skillsKey ? panel.categories[skillsKey] : null;
  if(!skillsCat || skillsCat.type !== 'list' || !Array.isArray(skillsCat.data)) return [];
  return skillsCat.data.filter(label => skillFullNameInText(label, text));
}
// Strips a source entry's own reserved/fusion suffix (if any) to get its plain display name,
// for combining into a NEW fused name — a fused ability made from "Ice Spike" and "Fire
// Affinity (Affinity)" should suggest "Ice Spike Fire Affinity", not "Ice Spike Fire Affinity
// (Affinity)" (the tag belongs to the source's own identity, not the new entry's).
function skillBaseName(label){
  return String(label||'').trim().replace(/\s*\(\s*(?:fusion|innate\s*power|affinity)\s*\)\s*$/i, '').trim();
}
// ---------- fusion naming — build player-facing name options for a new fused entry ----------
// Rather than trust whatever name the background model guesses for a fused result (which is
// invisible to the player until it's already on the sheet), the player is asked to pick the new
// entry's name themselves — see guardSkillFusion below and the chat-bubble picker wired up in
// script_chatroom.js's renderMsg/attachFusionPromptIfPending. Every option offered here is built
// directly from the two (or more) source names the player actually named, so every option
// genuinely "contains both of their names" as requested, rather than being an unrelated
// invented name. Only the first two named sources drive the permutations below — fusion only
// ever requires two, and more than that would produce an unwieldy number of combinations — but
// every named source still appears, spelled out in full, in the picker's own heading text.
function buildFusionNameOptions(sourceLabels){
  const bases = (sourceLabels||[]).map(skillBaseName).filter(Boolean);
  if(bases.length < 2) return [];
  const [a, b] = bases;
  const wordsA = a.split(/\s+/).filter(Boolean);
  const wordsB = b.split(/\s+/).filter(Boolean);
  const firstA = wordsA[0], lastB = wordsB[wordsB.length-1];
  const options = [
    `${a} ${b}`,
    `${b} ${a}`,
    `${firstA} ${lastB}`,
    `${a}-${b}`
  ];
  // De-dupe (short source names can make two of the templates above collide) while keeping order.
  const seen = new Set();
  return options.filter(o=>{
    const key = o.toLowerCase();
    if(seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 4);
}
// isResync: during a rewind/regenerate resync (see script_chatroom.js's resync path) a genuinely
// NEW fusion can never be armed from that pass — same conservative "never invent" stance
// guardSkillProgress's own fusionArmed already takes for the identical reason (a resync log
// window can easily contain an old fuse/combine phrase describing something that already
// happened and was already resolved, not a fresh request) — this guard still runs during a
// resync purely to redirect/strip anything mis-shaped the resync pass proposed.
function guardSkillFusion(data, panel, playerText, isResync){
  if(!data || !data.categories) return data;
  const named = namedOwnedSkillsInText(panel, playerText);
  const armed = !isResync && FUSE_TRIGGER_RE.test(String(playerText||'')) && named.length >= 2;
  let fusionRequested = false;
  for(const [catName, catUpdate] of Object.entries(data.categories)){
    if(!catUpdate || !/^skills?(\s|&|$)/i.test(String(catName).trim())) continue;
    // A fused result never lands directly in Skills & Abilities, and — per the player-naming
    // flow below — never lands automatically in Learning under the AI's own guessed name either.
    // This loop's job now is just (a) recognizing that a fusion was attempted, so the player can
    // be prompted to name it themselves, and (b) stripping the AI's guessed name out of the
    // proposed update so it can never land on the sheet under a name the player never chose.
    if(Array.isArray(catUpdate.list_add)){
      catUpdate.list_add = catUpdate.list_add.filter(it=>{
        if(!isFusedSkillKey(it)) return true;
        if(!armed){
          console.warn(`[fusion guard] blocked new Skills & Abilities entry "${it}" — tagged (Fusion) but no combine/fuse phrase naming two full existing Skills & Abilities entries was found in the player's last message`);
        }else{
          fusionRequested = true;
        }
        return false;
      });
      if(catUpdate.list_add.length === 0) delete catUpdate.list_add;
    }
    // Fusion never consumes its sources: strip any list_remove this same turn that targets one
    // of the exact entries the player just named to fuse — a source stays fully owned and
    // usable no matter how many times it goes into a fusion.
    if(armed && Array.isArray(catUpdate.list_remove)){
      catUpdate.list_remove = catUpdate.list_remove.filter(it=>{
        const isSource = named.some(n => normalizeSkillLabel(n) === normalizeSkillLabel(it));
        if(isSource) console.warn(`[fusion guard] blocked removal of "${it}" — fusion sources are never consumed`);
        return !isSource;
      });
      if(catUpdate.list_remove.length === 0) delete catUpdate.list_remove;
    }
    if(Object.keys(catUpdate).length === 0) delete data.categories[catName];
  }
  // Fusion is considered requested from the player's own message alone — the AI doesn't have to
  // have echoed a (Fusion)-tagged list_add this turn at all for the player's intent to register;
  // relying on that would only ever show the naming prompt when the background model happened to
  // notice the fuse attempt on its own, instead of every time the player actually asks for one.
  if(armed) fusionRequested = true;
  // Never overwrite an already-pending fusion request that the player hasn't answered yet — one
  // outstanding naming prompt at a time. panel is mutated directly (not via `data`/mergePanelUpdate)
  // since this is UI-facing state, not a sheet category; every caller already persists `panel`
  // via savePanel right after these guards run, so this rides along with that same save.
  if(fusionRequested && panel && !panel.pendingFusion){
    panel.pendingFusion = {
      id: 'fuse_' + Math.random().toString(36).slice(2, 9),
      sources: named.slice(),
      nameOptions: buildFusionNameOptions(named),
      ts: Date.now()
    };
  }
  return data;
}


// ---------- 3.12 — Innate Power / Affinity: world-creation only, never chat-created ----------
// Hard code-level guard: "(Innate Power)" and "(Affinity)" are reserved tags handed out exactly
// once, at world creation, by seedSkillsFromLore above, from the world's own setup text — the
// live story AI never gets to hand out either one mid-play, no matter what the story narrates
// (a mid-story "awakening" still logs as a normal, untagged Skills & Abilities entry instead).
// Strips any proposed Skills & Abilities entry carrying either reserved tag from every normal
// per-turn/resync/memory-sync update. seedSkillsFromLore itself calls mergePanelUpdate directly
// and never passes through this guard (or any of the others in this pipeline), so world-creation
// time is the only path that can ever actually add one of these.
// Bug fix: was strictly end-anchored (`...\)\s*$`), so a malformed tag with any stray trailing
// character — "Shadow Manipulation (Innate Power)." with just a trailing period — slipped past
// undetected, with no backstop equivalent to isFusedSkillKey's. Now tolerates trailing
// punctuation after the closing paren, same fix as isFusedSkillKey above.
const RESERVED_SKILL_TAG_RE = /\(\s*(innate\s*power|affinity)\s*\)[\s.,!?;:]*$/i;
function guardInnateAffinityChatRestriction(data){
  if(!data || !data.categories) return data;
  for(const [catName, catUpdate] of Object.entries(data.categories)){
    if(!catUpdate || !Array.isArray(catUpdate.list_add) || !/^skills?(\s|&|$)/i.test(String(catName).trim())) continue;
    catUpdate.list_add = catUpdate.list_add.filter(it=>{
      if(RESERVED_SKILL_TAG_RE.test(String(it||'').trim())){
        console.warn(`[innate/affinity guard] blocked "${it}" — Innate Power and Affinity entries can only be set at world creation, never by the story AI mid-chat`);
        return false;
      }
      return true;
    });
    if(catUpdate.list_add.length === 0) delete catUpdate.list_add;
    if(Object.keys(catUpdate).length === 0) delete data.categories[catName];
  }
  return data;
}


// ################################################################################
// SECTION 4 — LEARNING
// In-progress percentage tracking for skills not yet mastered. Duplicate-key cleanup,
// the study/practice trigger patterns, and the percentage-progress guard (a confirmed
// study phrase naming the skill = a flat +10%, capped at 100 and never trusted from the
// AI's own guessed increment). A skill graduates OUT of here via promoteMasteredSkills
// in the Skills & Abilities section (6) above once it passes 90%.
// ################################################################################


// ---------- 4.1 — one-time repair for duplicate Learning keys ----------
// Repair for saves affected by a past bug where the AI could name the same Learning
// entry slightly differently between turns ("Basic Chakra-Conduction Theory" vs
// "Basic-Conduction Theory") and end up with two separate bars for what's really one skill —
// mergePanelUpdate's kv merge now catches this going forward via fuzzy key matching (see
// findFuzzyExistingKey, defined in script_chatroom.js), but this cleans up any duplicate pair
// already sitting on the sheet: keeps the higher of the two percentages (the more advanced one
// reflects real progress) under the more descriptive of the two names, and drops the other.
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
      if(!(k in cat.data)) break; // k itself got merged away into an earlier k2 this pass —
      // stop comparing against it, or a later fuzzy match could reassign cat.data[k] and
      // resurrect the very entry that was just deleted.
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


// ---------- 4.2 — percentage-progress guard ----------
// Hard code-level guard: a skill/ability percentage can only go UP (or be created)
// if the player's own last message actually shows them studying/practicing/learning it. Same
// reasoning as the currency guard above — without this, the background model tends to nudge
// skill percentages up on its own just because the story is continuing, even on turns where
// the player didn't actually do anything to earn the progress.
// Matches any percentage-shaped value the background model might send — a clean "45%", a
// decimal like "45.5%", or a bare number with no "%" at all like "45". Previously required
// an exact "\d{1,3}\s*%" shape, and anything that didn't match wasn't rejected — it was just
// let through with no check at all (see guardSkillProgress below), which made a slightly
// off-format value the easiest way to skip every safeguard in this section entirely.
const SKILL_PCT_RE = /^\d{1,3}(?:\.\d+)?\s*%?$/;
// Was requiring "i" to sit immediately next to the verb (only whitespace allowed between them),
// so "I started learning", "I began training", "I keep practicing", "I decided to study" all
// failed to match — the verb has to be the very next word. That silently blocked brand-new
// "Learning" entries (and progress on existing ones) any time the player phrased it with so
// much as one word in between. Fix: allow up to 3 intervening words between "i" and the verb,
// with a negative lookahead so a negation word in that gap (not/never/refuse/avoid/stop/quit/
// skip/can't/won't/wouldn't/don't/didn't) correctly blocks the match instead of "I refuse to
// train" or "I decided not to study" false-triggering progress.
// "'d" is deliberately NOT in the ve/m contraction group below — "I'd" is ambiguous between
// "I had" and "I would", and letting it stand in for "I did" let a wish/hypothetical like
// "I'd love to study Fireball Jutsu" wrongly count as confirmed practice.
const PRACTICE_TRIGGER_RE = /\bi\b(?:'|’)?(?:ve|m)?(?:\s+(?!(?:not|never|n't|refuse\w*|avoid\w*|stop\w*|quit\w*|skip\w*|can'?t|won'?t|wouldn'?t|don'?t|didn'?t)\b)\w+){0,3}\s*\b(?:stud(?:y|ied|ying)|open(?:ed|ing)?|read(?:ing)?|learn(?:ed|t|ing)?|practic(?:e|ed|ing)|train(?:ed|ing)?|drill(?:ed|ing)?|rehears(?:e|ed|ing)|work(?:ed|ing)?\s*on|review(?:ed|ing)?|go(?:es)?\s*over)\b/i;
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
function guardSkillProgress(data, panel, playerText, isResync, groundingText){
  if(!data || !data.categories) return data;
  const playerConfirmedPractice = PRACTICE_TRIGGER_RE.test(playerText || '');
  // Fusion (see Section 3.11 above): a brand-new "(Fusion)" entry is allowed to be CREATED this
  // turn in place of the normal study/practice-phrase gate below, but only when the player's own
  // message shows genuine fuse/combine intent and names, in full, at least two of the
  // character's own existing Skills & Abilities entries. This never applies during a resync
  // (isResync's own mention-based check already governs that path) and never grants ongoing
  // progress on a fused entry that already exists — once created, a fused entry climbs only via
  // the same confirmed study/practice phrase every other Learning entry needs, just at half the
  // normal step (see `step` below).
  const fusionArmed = !isResync && FUSE_TRIGGER_RE.test(String(playerText||'')) && namedOwnedSkillsInText(panel, playerText).length >= 2;
  for(const [catName, catUpdate] of Object.entries(data.categories)){
    if(!catUpdate || !catUpdate.kv || typeof catUpdate.kv !== 'object') continue;
    for(const [k, v] of Object.entries(catUpdate.kv)){
      if(!SKILL_PCT_RE.test(String(v).trim())) continue; // only gate percentage-style skill progress
      const existingCat = panel && panel.categories ? panel.categories[findExistingKey(panel.categories, catName) || catName] : null;
      const existingRaw = existingCat && existingCat.type==='kv' ? existingCat.data[findExistingKey(existingCat.data, k) || k] : null;
      const oldNum = existingRaw != null ? parseInt(String(existingRaw).trim(), 10) : null;
      // A "(Fusion)" entry always climbs at half the normal flat step — 5 instead of 10 — for
      // every turn of its life, including the turn it's first created.
      const step = isFusedSkillKey(k) ? 5 : 10;
      // During a rewind/regenerate resync this is correcting the sheet to match a branch that
      // no longer happened — that correction (often a DEcrease, undoing progress from a message
      // that just got deleted) has no reason to be backed by a fresh "I studied/practiced"
      // phrase in the post-rewind log, and forcing the flat +10%-per-practice-phrase rule here
      // would actively fight the correction instead of allowing it. Only the normal per-turn
      // forward-progress path needs the practice-phrase gate and the flat +10% step.
      // Still, a resync must not just trust whatever number the background pass proposed with
      // NO grounding at all — that let an unrelated periodic sync (which isn't actually
      // correcting a rewind) invent or bump progress out of thin air. Require the skill's own
      // name to actually appear somewhere in the resync's own log/memory text before accepting
      // the change; groundingText falls back to playerText when the caller doesn't pass one.
      if(isResync){
        const ground = groundingText != null ? groundingText : playerText;
        if(!skillMentionedInText(k, ground)){
          console.warn(`[skill guard] blocked resync change to ${catName}.${k} (${oldNum==null?'new entry':oldNum+'%'} -> ${v}) — "${k}" isn't mentioned anywhere in the resync's own log`);
          delete catUpdate.kv[k];
          continue;
        }
        catUpdate.kv[k] = String(Math.max(0, Math.min(100, isNaN(parseInt(String(v).trim(),10)) ? (oldNum||0) : parseInt(String(v).trim(),10)))) + '%';
        continue;
      }
      const mentionedThisSkill = playerConfirmedPractice && skillMentionedInText(k, playerText);
      // A brand-new "(Fusion)" entry (nothing existing on the sheet yet under this key) is
      // allowed through here even without a study/practice phrase, as long as fusion itself was
      // armed this turn (see fusionArmed above) — the fuse/combine action IS its creation event,
      // not a study session. Once it exists, though, it needs the normal study phrase like
      // anything else in Learning; this only ever bypasses the gate on the turn of creation.
      const isNewFusionCreation = oldNum == null && isFusedSkillKey(k) && fusionArmed;
      if(!mentionedThisSkill && !isNewFusionCreation){
        // Either no study/practice phrase this turn, or the phrase didn't name this particular
        // skill — either way this entry cannot move, no matter what the background model
        // proposed. Drop the proposed change entirely rather than trusting it.
        console.warn(`[skill guard] blocked ${catName}.${k} progress (${oldNum==null?'new entry':oldNum+'%'} -> ${v}) — ${playerConfirmedPractice ? `player's message didn't name "${k}"` : 'no study/practice phrase ("I studied/opened/read/learned/practiced/trained/...") in player\'s last message'}`);
        delete catUpdate.kv[k];
        continue;
      }
      // A confirmed study/practice phrase naming this exact skill was found (or this is a
      // brand-new fused entry being created) — force a flat, deterministic step for this turn
      // (+10 normally, +5 for a "(Fusion)" entry — see `step` above), capped at 100. Deliberately
      // never trusts the AI's own guessed increment (which drifted/varied), so one confirmed
      // study/fuse action for X always means exactly the same step for X, and nothing else.
      const base = (oldNum != null && !isNaN(oldNum)) ? oldNum : 0;
      catUpdate.kv[k] = Math.min(100, base + step) + '%';
    }
    if(Object.keys(catUpdate.kv).length === 0) delete catUpdate.kv;
  }
  // Marks this update object as having been screened, so guardSkillGraduation (3.8) can trust
  // its own view of this turn's Learning changes instead of re-deriving/duplicating this
  // guard's logic — see the bug-fix comment at the top of guardSkillGraduation.
  if(data) data.__skillProgressScreened = true;
  return data;
}

// ################################################################################
// SECTION 5 — PRE-SEND CLAIM CHECK: ABILITY / SKILL
// The ability/skill half of the pre-send claim-check pipeline that runs before a
// message is sent to the story: checkAbilityClaim (Layer 1, pure regex — no AI call)
// and checkAbilityClaimFromAI (Layer 2, the code-side checker for the AI read step's
// extracted claims), plus the claim-phrase helpers used only by these two
// (CLAIM_VERB_SRC, CLAIM_SKIP_BEFORE_SRC, CLAIM_STRIP_WORDS, claimPhraseWords,
// sameWordRoot, claimWordKnown, abilityWordsMatch). Moved here from
// script_letter_of_records.js since they exist only to check Skills & Abilities
// claims, same reasoning as everything else in this file.
//
// The rest of the pipeline — checkClaimAgainstRecords (the orchestrator), Layer 1's
// checkCurrencyClaim/checkInventoryClaim, Layer 2's readClaimsFromInput, and the
// checkInventoryClaimFromAI/checkCurrencyClaimFromAI checkers — stays in
// script_letter_of_records.js, and calls straight into the two functions below the
// same way it always has (global scope, so load order between the files doesn't
// matter).
// ################################################################################

// ---------- 5.1 — claim-phrase vocabulary & tokenizing helpers ----------
// Deterministic (non-AI) check: ability/item/power "claim not on the sheet"
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
//   2. The claimed phrase's words don't line up with any SINGLE entry already on the sheet, in
//      that entry's own word order — either the whole name, or a contiguous chunk chopped off
//      its front or back (real shorthand: "Fireball" for "The Great Fireball"). A word missing
//      from the MIDDLE of an entry's name (e.g. claiming "Fire Dragon Jutsu" when the sheet
//      only has "Fire Twin Dragon Jutsu") does not count as shorthand and is flagged, and words
//      borrowed from two different entries never combine into a false match.
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
// Same word if identical, or if both are 5+ chars and share a prefix — up to 6 characters,
// capped by the shorter word's length, so 5-6 letter words compare on a shorter 4-5 char
// prefix and only 7+ letter words get the full 6-char prefix (duplicate/duplication) — short
// words stay exact-match-only so "fire" can't loosely match "dragon".
function sameWordRoot(a, b){
  if(a === b) return true;
  const minLen = Math.min(a.length, b.length);
  if(minLen < 5) return false;
  const prefixLen = Math.min(6, minLen - 1);
  return a.slice(0, prefixLen) === b.slice(0, prefixLen);
}
// ---------- 5.2 — sheet word-set matching ----------
// Builds one ORDERED word list PER SHEET ENTRY (each list item, each kv key) instead of one
// flat bag over the whole sheet. Order is kept (not turned into a Set) because the match below
// needs to check where in an entry's own name the claimed words fall — see phraseMatchesEntry.
// SCOPED to Skills & Abilities and Learning only — this is an ability/skill claim checker, not
// a general "does this word exist anywhere on the sheet" check. Inventory, Relationships,
// Milestones, Finances, etc. never feed a claim check: an NPC's name, an item, or a milestone
// title has no business validating "I use X". Each entry is tagged with `where` ('skills' or
// 'learning') so callers can tell a still-in-training match apart from a genuinely usable one.
function panelEntryWordSets(panel){
  const sets = [];
  if(!panel || !panel.categories) return sets;
  const skillsKey = findExistingKey(panel.categories, 'Skills & Abilities');
  const skillsCat = skillsKey ? panel.categories[skillsKey] : null;
  if(skillsCat && skillsCat.type === 'list' && Array.isArray(skillsCat.data)){
    skillsCat.data.forEach(it => {
      const ws = claimPhraseWords(String(it));
      if(ws.length) sets.push({ words: ws, where: 'skills' });
    });
  }
  const learningKey = findExistingKey(panel.categories, 'Learning');
  const learningCat = learningKey ? panel.categories[learningKey] : null;
  if(learningCat && learningCat.type === 'kv' && learningCat.data){
    Object.keys(learningCat.data).forEach(k => {
      const ws = claimPhraseWords(String(k));
      if(ws.length) sets.push({ words: ws, where: 'learning' });
    });
  }
  return sets;
}
// True if claimWords line up, in order (typo/plural tolerant via sameWordRoot), against
// chunk — same length, position by position.
function sequenceMatches(claimWords, chunk){
  if(claimWords.length !== chunk.length) return false;
  return claimWords.every((w,i) => w === chunk[i] || sameWordRoot(w, chunk[i]));
}
// A claim matches one sheet entry only if its words line up with that entry's OWN word order —
// either the whole name, or a contiguous chunk chopped off the front or back of it (real
// shorthand: "Chidori" for "Chidori: The Thousand Birds", "Fireball" for "The Great Fireball").
// Deliberately NOT a scattered/unordered match anymore: dropping a word out of the MIDDLE of a
// name is not shorthand, it's a different name — e.g. a sheet with "Fire Twin Dragon Jutsu"
// must NOT validate a claim of "Fire Dragon Jutsu" just because "fire" and "dragon" both show
// up in that entry; the missing "Twin" sits in the middle, not at either end, so neither the
// prefix chunk ("fire twin") nor the suffix chunk ("twin dragon") lines up with the claim.
function phraseMatchesEntry(claimWords, entryWords){
  if(!claimWords.length || claimWords.length > entryWords.length) return false;
  if(claimWords.length === entryWords.length) return sequenceMatches(claimWords, entryWords);
  const prefix = entryWords.slice(0, claimWords.length);
  const suffix = entryWords.slice(entryWords.length - claimWords.length);
  return sequenceMatches(claimWords, prefix) || sequenceMatches(claimWords, suffix);
}
// Every significant word typed must be traceable to something already on the sheet (with
// typo/plural tolerance via sameWordRoot) — AND all of those words must come from the SAME
// sheet entry, in that entry's own order, not stitched together from different entries or from
// scattered positions within one entry. See phraseMatchesEntry for exactly what "matches"
// means. Checking against one flat, unordered bag of every word on the whole sheet used to let
// a made-up ability pass just because each of its words happened to appear SOMEWHERE on the
// sheet (possibly in a completely different entry, or in the wrong position of the right one) —
// e.g. a real "Mouth Fire Ball Jutsu" skill and an unrelated entry containing "dragon" elsewhere
// on the sheet were enough to wrongly pass a typed "Fire Dragon Jutsu" that isn't actually
// anything the character has.
// No length-based forgiveness for an unmatched word — that used to let a phrase of 4+ words
// get away with one unrecognized word no matter what it was, which meant a genuinely
// swapped-in word (e.g. "Dragon" in place of the sheet's actual "Breathing") was silently
// treated the same as a word the player simply left out. Dropping a word from the claim still
// passes fine on its own here, since a dropped word just isn't in `words` to begin with — it's
// only an unrecognized word that's actually present that now always fails the check, however
// long the phrase is.
// Returns the matching entry object ({ words, where }) so callers can tell a Learning-only
// match apart from a genuinely usable Skills & Abilities one — or null if nothing matches.
function abilityWordsMatch(words, entryWordLists){
  if(!words.length) return null;
  return entryWordLists.find(entry => phraseMatchesEntry(words, entry.words)) || null;
}
// ---------- 5.3 — Layer 1: deterministic regex claim check ----------
function checkAbilityClaim(userText, panel){
  if(!panel || !panel.categories) return null;
  const entryWordSets = panelEntryWordSets(panel);
  if(!entryWordSets.length) return null; // nothing tracked yet — nothing to check against
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
    // Look back up to 100 chars, but stop at the start of the current sentence if one is found
    // sooner — a negation/future word from an earlier sentence shouldn't leak into this one,
    // and 40 chars was too short to catch a negation/future word sitting further back in a
    // longer sentence ("I really, honestly, after everything, don't think I'd ever use X").
    const searchStart = Math.max(0, vm.index - 100);
    const priorText = userText.slice(searchStart, vm.index);
    const lastTerm = Math.max(priorText.lastIndexOf('.'), priorText.lastIndexOf('!'), priorText.lastIndexOf('?'), priorText.lastIndexOf('\n'));
    const before = lastTerm !== -1 ? priorText.slice(lastTerm + 1) : priorText;
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
    const known = abilityWordsMatch(words, entryWordSets);
    if(!known) return `"${phrase}" isn't on your character sheet.`;
    if(known.where === 'learning') return `"${phrase}" is still in Learning — not usable yet.`;
  }
  return null;
}

// ---------- 5.4 — Layer 2: checker for the AI read step's extracted claims ----------
// Looks for id anywhere among every list/kv entry's hidden ID on the sheet (Skills & Abilities,
// Learning, and anything else tracked) — a plain existence check, no name matching at all.
function panelHasEntryId(panel, id){
  if(!panel || !panel.categories || !id) return false;
  for(const cat of Object.values(panel.categories)){
    if(!cat) continue;
    if(cat.type === 'list' && Array.isArray(cat.ids) && cat.ids.includes(id)) return true;
    if(cat.type === 'kv' && cat.ids && Object.values(cat.ids).includes(id)) return true;
  }
  return false;
}
function checkAbilityClaimFromAI(claim, panel){
  if(!panel || !panel.categories || !claim.name) return null;
  // If the upstream read-step already resolved this claim to a specific sheet entry's hidden
  // ID (requires that step to be given the panel's IDs and asked to return one — not yet wired
  // up as of this file), trust that directly: an exact ID lookup can't confuse "Fire Dragon
  // Jutsu" with "Fire Twin Dragon Jutsu" the way any name-based matching risks, since the AI
  // resolving it had the real, full sheet in front of it. No ID supplied falls through to the
  // same name-matching checkAbilityClaim (Layer 1) uses.
  if(claim.id){
    return panelHasEntryId(panel, claim.id) ? null : `"${claim.name}" isn't on your character sheet.`;
  }
  const entryWordSets = panelEntryWordSets(panel);
  if(!entryWordSets.length) return null;
  const words = claimPhraseWords(claim.name);
  if(!words.length) return null; // nothing specific enough to check
  const known = abilityWordsMatch(words, entryWordSets);
  if(!known) return `"${claim.name}" isn't on your character sheet.`;
  if(known.where === 'learning') return `"${claim.name}" is still in Learning — not usable yet.`;
  return null;
}


// ################################################################################
// SECTION 6 — INFO MODAL ENTRIES: SKILLS & ABILITIES / LEARNING
// The two CAT_INFO entries for these sections, moved out of script_letter_of_records.js'
// CAT_INFO array so this pair's "what is this section?" text sits alongside the rest of
// its guard/migration/claim-check logic instead of in the generic rendering file.
// getCatInfo (still in script_letter_of_records.js, since it also serves every other
// category) checks this array right after its own CAT_INFO — same matching approach
// (a regex `test` against the trimmed category name), so the lookup itself didn't change,
// only where these two entries' text lives.
// ################################################################################
const CAT_INFO_SAAL = [
  { test:/^skills?(\s|&|$)/i, title:'Skills & Abilities', what:'The complete, permanent record of every jutsu, technique, spell, or power the character can actually use right now \u2014 anything the character\u2019s own body or mind can do. This is what the AI checks before letting the character use an ability. A physical object with a magical effect (a magic sword, an enchanted ring, a scroll, a potion) is never listed here, no matter how powerful \u2014 it stays in Inventory instead, since the power belongs to the object, not the character. An entry tagged "(Innate Power)" or "(Affinity)" is a bloodline gift or natural aptitude set once at world creation \u2014 the story can never add, retag, or remove one of these mid-play, even for something narrated as awakening or being discovered later; anything gained during play always logs as a normal, untagged entry instead. An entry tagged "(Fusion)" arrived here the normal way, by graduating out of Learning past 90%, after being created by fusing two already-owned entries together \u2014 see Learning for how fusion itself works. Every entry here also carries a permanent lowercase-roman code \u2014 (i), (ii), (iii), and so on \u2014 shown right next to it.', how:'An entry is added the moment the story shows the character fully acquiring an ability \u2014 buying or being taught something complete in one scene, or a "Learning" entry passing 90% and graduating in on its own (including a fused entry, once it graduates). "(Innate Power)"/"(Affinity)" entries only ever come from world creation.', wont:'Just talking about wanting a power, or attempting one that isn\u2019t listed yet. Something has to be shown as genuinely, fully gained before it appears here \u2014 the story treats this list as the hard limit on what the character can do. A skill book, scroll, or other item merely being bought or owned doesn\u2019t add anything here either \u2014 that item sits in Inventory until the story actually shows the character starting to learn from it. A brand-new "(Innate Power)" or "(Affinity)" entry appearing mid-story is never legitimate \u2014 those are world-creation only.', use:'The "(i)", "(ii)", "(iii)"... next to each entry is a permanent reference code, handed out in the order entries are created. It\u2019s shared with Learning \u2014 both sections draw from the same running sequence, so no two entries between them ever carry the same code. A code is permanent once assigned: it\u2019s never reused or reassigned, even if the entry is later deleted, and a Learning entry keeps the exact same code when it graduates into Skills & Abilities \u2014 graduating is a state change, not a new entry. It\u2019s an identifying label only \u2014 the story always needs the entry\u2019s actual full name to use, train, or fuse it; a bare code on its own doesn\u2019t work.' },
  { test:/^learning$/i, title:'Learning', what:'Skills or techniques the character has started training in but hasn\u2019t fully mastered yet, tracked as a percentage toward 100%. This section only appears once training actually begins \u2014 it isn\u2019t there from the start. An entry named "... (Fusion)" is the result of fusing two already-owned Skills & Abilities entries together \u2014 both sources stay fully intact, and the fused entry trains at half speed (+5% instead of +10% per confirmed session). Every entry here also carries a permanent lowercase-roman code \u2014 (i), (ii), (iii), and so on \u2014 shown right next to it.', how:'An entry appears the first time the story shows real practice beginning (including starting to study from a bought/found skill book or scroll, which itself stays put in Inventory), and its percentage only rises \u2014 by a flat +10% per confirmed practice/study message (+5% for a fused entry) \u2014 when the story shows actual study, drilling, or training. A fused entry is created by naming, in full, two owned Skills & Abilities entries together with a clear intent to fuse/combine them.', wont:'Simply wanting to learn something, or using a skill without training it. Once an entry passes 90% (91% or higher \u2014 landing exactly on 90% isn\u2019t quite enough), it moves itself out of Learning and into Skills & Abilities as a fully usable entry.', use:'The "(i)", "(ii)", "(iii)"... next to each entry is a permanent reference code, handed out in the order entries are created, from the SAME running sequence Skills & Abilities uses \u2014 the two sections never share a code between different entries. A code is permanent once assigned: never reused or reassigned, even after the entry graduates into Skills & Abilities (it keeps the identical code \u2014 graduating is a state change, not a new entry) or is otherwise deleted. It\u2019s an identifying label only \u2014 the story always needs the entry\u2019s actual full name to train it or fuse it; a bare code on its own doesn\u2019t work.' },
];


// ================= RELATIONSHIPS — SHORT-LABEL DISPLAY HELPER — MOVED =================
// relationshipShortLabel now lives in script_chatroom.js, right next to renderPanelHtml
// which calls it. Same as before the move — global scope, so file load order between the
// two doesn't matter.
