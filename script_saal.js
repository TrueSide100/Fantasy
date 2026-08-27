/* script_saal.js — Skills & Abilities and Learning: the deterministic guards
   that keep those two sections of the Letter of Records honest.

   This is one quarter of what used to be a single script_letter-of-records.js, later
   split into script_tsal.js (Timeline/Scheduled Events/Skills & Abilities/Learning) and
   script_fieb.js (Finances/Inventory/Equip Box). This file is the Skills & Abilities +
   Learning half of script_tsal.js — split again so it can be read and edited
   independently of the Timeline + Scheduled Events half (script_tase.js).
   Depends on globals from index.html's inline Section 1 (load that file first); load
   order relative to script_chatroom.js, script_fieb.js, and script_tase.js
   doesn't matter — all share one global scope.

   The data model/schema, merge engine, panel rendering, pre-send claim checks, and the
   Relationships short-label helper all live in script_chatroom.js, which calls many
   functions defined here (guardSkillProgress, guardSkillGraduation, seedSkillsFromLore,
   etc.) from its own schema/migration/merge-pipeline code.

   One cross-file dependency worth flagging: normalizeSkillLabel and guardSkillGraduation
   (both in the Skills & Abilities section below) are called from script_fieb.js's
   Inventory section, so an ability referenced from an Inventory item is checked against
   the same normalized name and graduation state Skills & Abilities itself uses. Safe
   across the file split since all files share one global scope and are loaded together.

   Organized into 2 numbered sections below, in this order:
     3. SKILLS & ABILITIES  — the permanent, definitive record: legacy schema
                              migration (migrateSkillCategoryNames), mastery
                              graduation out of Learning (promoteMasteredSkills),
                              its duplicate-cleanup repair (repairDuplicateSkills),
                              the graduation backstop (guardSkillGraduation via
                              normalizeSkillLabel), and lore-seeding for starting
                              abilities (seedSkillsFromLore).
     4. LEARNING            — in-progress percentage tracking: its own
                              duplicate-cleanup repair (repairDuplicateLearningKeys),
                              the study/practice trigger patterns, and the
                              percentage-progress guard (guardSkillProgress). Skills
                              graduate OUT of here into section 3 above at 100%.

   Sections 1 (TIMELINE) and 2 (SCHEDULED EVENTS) — the day-advancement and dated-entry
   halves of the original script_tsal.js — now live in script_tase.js.

   Order is for readability only — every top-level binding is a function
   declaration or a plain const assigned at load time, so nothing above is
   order-sensitive at runtime.
   ################################################################################ */


// ################################################################################
// SECTION 3 — SKILLS & ABILITIES
// The permanent, definitive record of what the character can actually use. Legacy
// schema migration, mastery graduation out of Learning (100% -> a plain owned entry),
// duplicate cleanup, the graduation backstop guard, and lore-seeding for starting
// abilities. Learning — the in-progress percentage tracker these graduate FROM — has
// its own section (7) right below.
// ################################################################################


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


// A "Learning" entry that reaches 100% graduates automatically: it's removed from Learning
// and added to Skills & Abilities as a normal, permanently-usable entry.
function promoteMasteredSkills(panel){
  if(!panel || !panel.categories) return false;
  const learningKey = findExistingKey(panel.categories, 'Learning');
  if(!learningKey) return false;
  const learningCat = panel.categories[learningKey];
  if(!learningCat || learningCat.type !== 'kv') return false;
  if(!learningCat.ids) learningCat.ids = {};
  // Numeric >=100 rather than an exact "100%" string match — a slightly different but
  // equivalent value (e.g. "100.0%", or anything that rounds/clamps to 100 or above) must
  // still graduate. This is the only path that moves an entry out of Learning, so a strict
  // string match here was a single point of failure for the "stuck at 100%, never graduates"
  // symptom.
  const masteredKeys = Object.keys(learningCat.data).filter(k => {
    const n = parseFloat(String(learningCat.data[k]).replace('%','').trim());
    return !isNaN(n) && n >= 100;
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
    ? skillsCatExisting.data.map(normalizeSkillLabel).filter(Boolean)
    : [];
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
      const alreadyOnSheet = alreadyOwned.some(k => norm===k || norm.includes(k) || k.includes(norm));
      if(alreadyOnSheet) return true; // not actually new — leave it alone
      // Brand-new entry that was never in Learning at all (this turn or before), and isn't
      // already owned. Training always has to pass through Learning first during play — the
      // only other legitimate way to own a skill is world-creation seeding (seedSkillsFromLore),
      // which never runs through this guard, so anything reaching here is the AI trying to grant
      // an ability directly (e.g. "buying the book grants the power"). Block it.
      const everPassedThroughLearning = everInLearning.some(k => norm===k || norm.includes(k) || k.includes(norm));
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


// ---------- lore seeding: starting abilities filled in before play begins ----------
// For the same underlying reason seedTimelineFromLore existed (see that module below):
// anything stated in the world's own setup text (an inborn bloodline power, a technique the
// character already knows, a trained proficiency they start the story with) needs to land on
// the sheet BEFORE play begins — the regular per-turn updatePanel() only ever reads the actual
// chat log, never world.lore directly, so a stated starting ability that the opening scene
// doesn't happen to restate verbatim would otherwise never make it onto the sheet at all.
// Everything this pass finds is, by definition, something the character can already fully do
// at story start — never a still-in-progress skill — so it goes straight into "Skills &
// Abilities" and "Learning" is explicitly off-limits here; only actual training shown during
// play should ever create a Learning entry.
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


// ################################################################################
// SECTION 4 — LEARNING
// In-progress percentage tracking for skills not yet mastered. Duplicate-key cleanup,
// the study/practice trigger patterns, and the percentage-progress guard (a confirmed
// study phrase naming the skill = a flat +10%, capped at 100 and never trusted from the
// AI's own guessed increment). A skill graduates OUT of here via promoteMasteredSkills
// in the Skills & Abilities section (6) above once it hits 100%.
// ################################################################################


// One-time repair for saves affected by a past bug where the AI could name the same Learning
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
function guardSkillProgress(data, panel, playerText, isResync, groundingText){
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

// ================= PRE-SEND CLAIM CHECKS — MOVED =================
// checkClaimAgainstRecords (and its Layer 1 deterministic checkCurrencyClaim/
// checkInventoryClaim/checkAbilityClaim, plus Layer 2's readClaimsFromInput and the
// check*ClaimFromAI functions) now live in script_chatroom.js. Still called from that
// file's sendMessage() composer hookup, same as before the move — global scope, so file
// load order between the two doesn't matter.

// ================= RELATIONSHIPS — SHORT-LABEL DISPLAY HELPER — MOVED =================
// relationshipShortLabel now lives in script_chatroom.js, right next to renderPanelHtml
// which calls it. Same as before the move — global scope, so file load order between the
// two doesn't matter.
