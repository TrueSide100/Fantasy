/* script_inventory_equip.js — Inventory and Equip Box: the stackable-items engine and
   its guards, Inventory's own ID scheme, item write helpers, its two UI surfaces (the
   dedicated Inventory-only page and its drag-to-merge wiring), plus the visual equip
   compass and its tap-to-upload picker wiring.

   This is two thirds of what used to be a single script_letter_of_records.js,
   later split out into this file (Inventory + Equip Box) and two siblings:
   script_finance.js (Finances) and script_tase.js (Timeline/Scheduled Events)
   — split so this file can be read and edited independently of the
   currency-tracking half (script_finance.js: Finances). Depends on globals
   from index.html's inline Section 1 (load that file first); load order
   relative to script_chatroom.js, script_finance.js, script_tase.js, and
   script_saal.js doesn't matter — all share one global scope.

   The data model/schema, merge engine, panel rendering, pre-send claim checks, and the
   Relationships short-label helper all live in script_chatroom.js, which calls many
   functions defined here (guardStackableItems, splitItemEntry, genInvId,
   paintInventoryModal, renderEquipCompassHtml, initEquipHubPickers, etc.) from its own
   schema/migration/merge-pipeline code, its pre-send claim-check composer hookup, and
   its Inventory-"expand"-button click handler.

   Two real cross-file dependencies worth flagging (both directions — this file and
   script_finance.js lean on each other):
     - guardStackableItems and its helpers below use CURRENCY_NAME_RE,
       FINANCE_CATEGORY_RE, and extractNumbersNearKey, all defined in script_finance.js,
       so a currency-looking kv stat that ended up outside the Finance category is
       still recognized the same way here.
     - subsetSumMatches, defined below, is called from script_finance.js's
       guardCurrencyDecreases/guardCurrencyIncreases (shared duplication-math helper).
   Also, guardStackableItems and its helpers call normalizeSkillLabel and
   guardSkillGraduation, both defined in script_saal.js's Skills & Abilities section —
   needed so an ability referenced from an Inventory item is checked against the same
   normalized name and graduation state Skills & Abilities itself uses.
   Safe across the file split since all files share one global scope and are loaded
   together — load order between this file, script_finance.js, and script_saal.js
   doesn't matter.

   Contains what used to be Sections 2 and 3 of a larger merged file, in this order:
     2. INVENTORY   — the stackable-items engine: entry parsing, the ability
                      cross-reference helpers, drag-to-merge naming, and the
                      quantity/duplication-math/ungraduated-ability/equip-status/
                      rename-bypass/discard guards; plus the numbered-ID scheme
                      (genInvId/numFromId), stray-category cleanup, single-item write
                      helpers (photo/status/delete), the dedicated Inventory-only page,
                      and its drag-to-merge interaction wiring.
     3. EQUIP BOX   — the visual equip compass (display-only summary of Inventory's
                      on-body statuses) and its tap-to-upload picker wiring. Split out
                      from Inventory above so the rendering layer sits apart from the
                      data guards.

   Finances — the currency-guard section that used to sit alongside these two — now
   lives in script_finance.js.

   Order is for readability only — every top-level binding is a function
   declaration or a plain const assigned at load time, so nothing above is
   order-sensitive at runtime.
   ################################################################################ */


// ################################################################################
// SECTION 2 — INVENTORY
// Stackable-items engine: entry parsing ("<item> — <status>"), the ability
// cross-reference helpers, drag-to-merge naming, and the quantity / duplication-math /
// ungraduated-ability / equip-status / rename-bypass / discard guards. The visual equip
// compass and its tap-to-upload wiring live in their own EQUIP BOX section (3) below —
// everything here is the underlying Inventory data and its guards.
// ################################################################################


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
// `trigger` may be a RegExp (tested via .test(chunk), as before) OR a plain function
// (chunk:string) => boolean — added so callers can pass a structural/semantic detector
// (e.g. systemGrantDetected below) instead of being forced to express every case as one
// regex. Behavior for existing RegExp callers is unchanged.
function itemMentionedNear(text, itemLabel, trigger){
  const norm = String(text || '');
  if(!norm) return false;
  const words = [...itemWordSet(itemLabel)].filter(w => w.length > 2 && !STOPWORD_ANCHORS.has(w));
  if(!words.length) return false;
  const testChunk = (typeof trigger === 'function') ? trigger : (chunk => trigger.test(chunk));
  const chunks = norm.split(/(?<=[.!?\n])/);
  for(const chunk of chunks){
    if(!testChunk(chunk)) continue;
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
// recentLogText (optional, 4th arg — the last several turns, player + story) is only ever
// consulted for the System-grant path (systemGrantDetected) above — it can never satisfy the
// plain ITEM_GAIN_TRIGGER_RE/abilityMentionedNear checks, which stay scoped to playerText
// exactly as before. Passing '' or omitting it entirely reproduces the old player-only
// behavior unchanged.
function itemGainConfirmed(playerText, itemLabel, panel, recentLogText){
  return itemMentionedNear(playerText, itemLabel, ITEM_GAIN_TRIGGER_RE)
    || abilityMentionedNear(playerText, itemLabel, panel, true)
    || (recentLogText ? itemMentionedNear(recentLogText, itemLabel, systemGrantDetected) : false);
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
const FIRST_PERSON_RE_INV = /\bi\b/i;
function itemStatusConfirmed(playerText, itemLabel, panel){
  return itemActionConfirmed(playerText, itemLabel, ITEM_STATE_TRIGGER_RE, panel)
    || itemActionConfirmed(playerText, itemLabel, ITEM_USE_ON_OTHER_RE, panel)
    || itemMentionedNear(playerText, itemLabel, FIRST_PERSON_RE_INV);
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
// FIX(23): added "i obtained/obtain(s/ing)" (was missing entirely — only ACQUIRE_VERBS_SRC in
// script_letter_of_records.js had it, this list didn't) and "i was donated" / "donated ... me"
// (also missing). Also widened the passive "i was given/gifted/handed" branch to a general
// "i was <acquire-ish past participle>" so a third party as the grammatical subject ("she
// donated me a cloak", "the merchant gifted me a ring") is recognized too, not just the exact
// three original participles.
const ITEM_GAIN_TRIGGER_RE = /\b(i\s*bought|i\s*buy(?:s|ing)?|i\s*purchas(?:e|ed|ing)|i\s*paid|i\s*pay(?:s|ing)?|i\s*receiv(?:e|ed|ing)|i\s*obtain(?:ed|s|ing)?|i\s*got|i\s*get(?:s|ting)?|i\s*loot(?:ed|s|ing)?|i\s*found|i\s*find(?:s|ing)?|i\s*pick(?:ed|s|ing)?\s*up|i\s*took|i\s*take|i\s*was\s*(?:given|gifted|handed|donated|awarded|granted)|donat(?:ed|es|ing)?\s*(?:to\s*)?me\b|i\s*gift(?:ed)?|i\s*earn(?:ed|s|ing)?|i\s*won|i\s*win(?:s|ning)?|i\s*claim(?:ed|s|ing)?|i\s*collect(?:ed|s|ing)?|i\s*trad(?:e|ed|ing)|i\s*exchang(?:e|ed|ing)|i\s*swap(?:s|ped|ping)?|i\s*us(?:e|ed|ing)|i\s*appl(?:y|ied|ying))\b/i;
// ---------- FIX(23): narration-side gain confirmation — "System"/status-window item grants ----------
// The player-only scoping above is deliberate for ordinary narration (an NPC's dialogue or the
// story's own prose naming a number is not authorization to grant it — see the note above
// guardStackableItems). But in "status window"/LitRPG-style stories, the game's own System is
// the one narrating the grant ("[System]: You have obtained a Steel Blade") — the player never
// typed an acquisition phrase because there was nothing for THEM to claim; the System handed it
// over as a game-mechanic event, same conceptual role a shopkeeper's "here's your item" plays in
// a normal purchase. This is a narrow, separate allowance for exactly that recognizable pattern —
// not a general license for any narration that merely mentions handing the player something (an
// NPC saying "here, take this sword" in plain prose still requires the player's own acquisition
// phrase, same as before this fix).
// STRUCTURAL grant markers: things that are never going to vary in wording because they're
// a fixed UI/narration convention this engine's stories use for a system-style notification
// (a "[System]" tag, an explicit "added to inventory" line, etc.) — safe to keep as an exact
// regex since these ARE fixed strings, not natural-language sentences the narrator rephrases.
const SYSTEM_GRANT_STRUCTURAL_RE = /\[?\s*system\s*\]?\s*(?:notification)?\s*[:\-]|\bthe\s+system\b[^.\n]{0,40}\b(?:grants?|gives?|awards?|notifies?|announces?)\b|\b(?:loot|quest\s+reward|item)\s*(?:obtained|acquired|received)\b|\bnew\s+item\s+added\b|\badded\s+to\s+(?:your\s+)?inventory\b|\bstatus\s+window\b|\bnotification\s+chimes?\b/i;
// VERB-STEM grant markers: everything that IS ordinary natural language ("you have obtained",
// "you obtained", "You've successfully obtained", "you were finally granted", "you now
// receive"...) keeps getting missed by exact-phrase regexes because the AI narrator freely
// varies tense, adverbs, contractions, and punctuation around the same underlying claim: the
// player (2nd person) was given something. Rather than adding another regex alternative every
// time a new phrasing shows up, this checks structurally instead: does the word "you" appear
// within a few words of ANY grant-verb stem, in either order, regardless of what's between
// them? That's tense/adverb/punctuation-proof by construction — "successfully", "have",
// "finally", "now", "'ve", a colon, a comma... none of it matters, because none of those
// filler words happen to start with one of these stems.
const GRANT_VERB_STEMS = ['obtain','receiv','acquir','gain','grant','award','earn','unlock','loot','claim'];
const YOU_WORD_RE = /^(?:you|your|you're|youve|you've)$/i;
function systemGrantDetected(text){
  const s = String(text || '');
  if(!s) return false;
  if(SYSTEM_GRANT_STRUCTURAL_RE.test(s)) return true;
  const tokens = s.match(/[A-Za-z']+/g) || [];
  const WINDOW = 6; // words of slack in either direction — covers "you have successfully
                     // obtained", "you were finally awarded", etc. without needing to know
                     // in advance which filler words the narrator will choose
  for(let i = 0; i < tokens.length; i++){
    if(!YOU_WORD_RE.test(tokens[i])) continue;
    for(let j = Math.max(0, i - WINDOW); j <= Math.min(tokens.length - 1, i + WINDOW); j++){
      if(j === i) continue;
      const w = tokens[j].toLowerCase();
      if(GRANT_VERB_STEMS.some(stem => w.startsWith(stem))) return true;
    }
  }
  return false;
}
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
        const playerConfirmedNewItem = itemGainConfirmed(playerText, label, panel, recentLogText);
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
        const playerConfirmedGain = itemGainConfirmed(playerText, label, panel, recentLogText);
        if(!playerConfirmedGain){
          console.warn(`[item guard] blocked "${label}" count increase (${oldParsed.qty} -> ${newQty}) — no acquisition/ability phrase ("I bought/received/paid/looted/gifted/found/picked up/took/earned/won/claimed/used/applied...") naming this item in player's own message, and no System-style grant notification naming it in the recent story log`);
          blockedLabels.push(label);
          continue;
        }
        // BUG FIX: extractNumbersNearKey required the item's FULL name to appear verbatim near
        // a number — fine for "Gold" but multi-word descriptive names ("Pale bone-wood
        // half-mask") almost never get repeated in full by the narration, so legitimate gains
        // were routinely blocked. extractNumbersNearItemLabel tries the full name first, then
        // falls back to the name's single most distinctive word. Scoped to playerText only (see
        // note above the loop) — a number the AI itself narrated doesn't count as grounding —
        // UNLESS this gain was only authorized via the System-grant path (FIX(23)) with nothing
        // in the player's own message at all, in which case playerText has no number to find by
        // definition, so the amount has to come from that same System narration instead.
        const grantedByPlayerOwnText = itemMentionedNear(playerText, label, ITEM_GAIN_TRIGGER_RE) || abilityMentionedNear(playerText, label, panel, true);
        const numberSource = grantedByPlayerOwnText ? (playerText || '') : (recentLogText || '');
        const nearbyNumbers = extractNumbersNearItemLabel(label, numberSource);
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
// to gate against. This is that missing check: scan the recent log for a still-learning (at or
// below 90%, i.e. not yet passed the graduation threshold)
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
    if(!isNaN(n) && n <= 90){
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
          console.warn(`[ungraduated ability guard] blocked Inventory ${field} "${entry}" — tied to a still-learning (90% or below) ability, which doesn't get reliable/unrestricted effect until it graduates into Skills & Abilities`);
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


// ---------- info-modal "Current Items" block + long-press action sheet (moved from
// script_chatroom.js) ----------
// Read-only Current-Items render for the Inventory section-info popup (renderCatInfoInventoryItems),
// the inv-slot tap swallow (handleInvSlotTap), and the long-press action sheet (Equip/Unequip,
// Delete, Change Photo) for inventory cards on the main Letter of Records view — plus its trailing
// #invContent click listener. Still called from openCatInfoModal and the panelContent click
// handler in script_chatroom.js, same as before the move.
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

// ================= INVENTORY — ID MANAGEMENT =================
// The numbered "#N" inventory-id scheme (an item's hidden identity encodes its visible
// number directly, so there's exactly one source of truth for both) and its one-time
// legacy-id upgrade. Moved here from script_chatroom.js's data-model section — still
// used by ensureCategoryIds/mergePanelUpdate and getPanel there, same as before the move
// (global scope, so file load order doesn't matter).
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

// ================= INVENTORY — STRAY CATEGORY CLEANUP =================
// One-time migration: folds a stray, differently-worded inventory-ish category the
// background model sometimes invents (e.g. "Inventory Description") into the real
// "Inventory" category, then deletes it. Called from getPanel in
// script_chatroom.js, same as before the move.
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

// ================= INVENTORY — ITEM WRITE HELPERS =================
// Single-item writes used by the long-press action sheet below (Equip/Unequip, Delete,
// Change Photo): setInventoryItemPhoto, setInventoryItemStatus, and
// deleteInventoryItemById. Each goes through the same savePanel choke point as every
// other panel write, so it repaints live if either Inventory-facing view is open.
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
// Persists one of the two Equip Box "hub" images (the frozen top figure slot and the blank
// bottom slot rendered by renderEquipCompassHtml) — these aren't tied to a specific inventory
// item like setInventoryItemPhoto above, so they're kept on their own top-level panel.equipHub
// field instead of the itemId-keyed photos map. Goes through the same savePanel choke point as
// every other panel write, so it persists to IndexedDB and repaints live the same way.
async function setEquipHubPhoto(worldId, slot, dataUrl){
  if(slot !== 'top' && slot !== 'bottom') return;
  const panel = await getPanel(worldId);
  if(!panel.equipHub || typeof panel.equipHub !== 'object') panel.equipHub = { top:null, bottom:null };
  panel.equipHub[slot] = dataUrl || null;
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
// delete affordance at all — see wireInventoryChipDrag below). Same per-world
// op queue as every other Letter of Records write (queueWorldOp, defined in index.html's
// inline script but globally available since none of these files are modules), so a delete
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

// ================= INVENTORY — DEDICATED INVENTORY-ONLY PAGE =================
// Opened via the small "expand" button next to the Inventory title on the main Letter of
// Records (see the headerExtra branch in renderPanelHtml above) — same paper theme, same
// modal size/shape as the Letter of Records itself, just scoped to Inventory alone and
// rendered with bigger chips (opts.largeChips). This is the ONLY place long-press, drag,
// drop, and the merge confirm/cancel name bar exist at all (opts.enableMerge) — nothing
// about how Inventory itself is stored, guarded, or updated changes; this is a
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

// ================= INVENTORY — DRAG-TO-MERGE WIRING =================
// The interaction layer for the dedicated Inventory-only page above: long-press-then-drag
// pickup, auto-scroll near the list edges, and dropping one chip onto another to open the
// merge confirm/cancel bar. Long-press-drag-to-merge (and the resulting confirm/cancel
// name bar), plus each chip's own delete cross, live ONLY on this dedicated,
// larger-size Inventory-only page (openInventoryModal above) — the main Letter of Records
// shows Inventory as plain, non-interactive chips. Kept as its own function (rather than
// inlined into paintInventoryModal) purely so the pointer-event plumbing doesn't clutter
// the modal's own open/paint/close logic.
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
      // BUG FIX (orphaned photos on drag-merge): whichever side's id doesn't win — i.e. isn't
      // reused as mergedId — but got fully consumed (its stack hit 0 here) is genuinely gone
      // from Inventory once the splices below run. Its stored snapshot photo, if any, would
      // otherwise sit in fresh.photos forever with nothing left to show it on. The side that
      // DOES win (mergedId) needs no cleanup — that id stays in the array (now labeling the
      // merged item), so its existing photo, if any, correctly carries over automatically.
      if(idA !== mergedId && remainA <= 0 && fresh.photos && fresh.photos[idA] != null) delete fresh.photos[idA];
      if(idB !== mergedId && remainB <= 0 && fresh.photos && fresh.photos[idB] != null) delete fresh.photos[idB];
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
  // on the main Letter of Records view (see deleteInventoryItemById above). No
  // .panel-chip-del crosses are rendered here anymore, so there's nothing left to wire up
  // for it on this container.

  const mergeConfirmBtn = container.querySelector('.panel-merge-confirm');
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



// ################################################################################
// SECTION 3 — EQUIP BOX
// Display-only visual summary of Inventory's on-body ('Equipped') statuses — the
// person-shaped slot grid — plus the tap-to-upload handlers for its two frozen hub
// images. Reads Inventory's own entries/statuses; writes nothing back to the sheet.
// ################################################################################


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
  { slot:'full-body', icon:'🥋', label:'Full body', group:'Body', kws:['bodysuit','jumpsuit','onesie','full-body','full body'] },
  { slot:'head', icon:'🪖', label:'Head / forehead', group:'Head & Face', kws:['helmet','helm','bascinet','barbute','sallet','kabuto','armet','morion','crown','coronet','circlet','diadem','tiara','halo','hat','fedora','derby','sombrero','cap','beanie','turban','dastar','pagri','hood','balaclava','forehead guard','forehead plate','headpiece','forehead'] },
  // NOTE ON ORDER: 'face' is checked BEFORE 'hair' below (deliberately out of pure
  // head-to-foot order) so that "wig beard" / "wig moustache" — matched explicitly by face's
  // keyword list — get first crack, since they'd otherwise be swallowed by the bare 'wig'
  // keyword in hair's catch-all.
  // Face split into three regions (full face, eyes, below-eyes) instead of one catch-all —
  // lets an eye item (goggles) and a lower-face item (mouth guard) show as separately equipped
  // instead of overwriting each other in a single 'face' slot. 'ears' is a new slot too, split
  // out of the old unmatched-accessory bucket. All four checked BEFORE 'hair' below so
  // "wig beard" / "wig moustache" get claimed by face-lower before hair's bare 'wig' can grab
  // them.
  { slot:'face-full', icon:'🎭', label:'Full face', group:'Head & Face', kws:['mask','veil','face shield','face cage','face armor','face covering','face cover'] },
  { slot:'eyes', icon:'🥽', label:'Eyes', group:'Head & Face', kws:['goggles','glasses','monocle','blindfold','visor','eye patch','eye shield','eye cover'] },
  { slot:'face-lower', icon:'😷', label:'Lower face', group:'Head & Face', kws:['nose guard','mouth guard','mouthpiece','chin guard','jaw guard','fake beard','false beard','wig beard','wig moustache','fake moustache','false moustache'] },
  { slot:'ears', icon:'💎', label:'Ears', group:'Head & Face', kws:['earring','ear cuff','ear chain','ear petal'] },
  // Broad 'hair' catch-all — any item whose name contains "hair" anywhere (hair clip, hair
  // tie, fake hair, hair ornament, etc.) routes here without needing every phrasing spelled
  // out. Named accessory kws still listed for items that don't literally say "hair" (headband,
  // barrette, scrunchie) or use non-English/compound terms.
  { slot:'hair', icon:'🎀', label:'Hair', group:'Head & Face', kws:['hair','wig','headband','hairband','hair band','hair tie','hair bow','barrette','scrunchie','hair comb','hair stick','hair claw','hair pin'] },
  { slot:'neck', icon:'📿', label:'Neck', group:'Neck & Shoulders', kws:['amulet','necklace','pendant','torc','choker','medallion','neckpiece','locket','neck chain'] },
  // shoulder-left/-right: unlike the other left/right pairs below, shoulder items DO get
  // auto-guessed now — see SHOULDER_KWS + the special-case handling in computeEquipSlots.
  // Their own kws stay empty here on purpose (matching happens before the generic per-rule
  // loop reaches them, and before it could otherwise mis-route e.g. "Shoulder Armor" to Chest
  // via the bare 'armor' keyword there).
  { slot:'shoulder-left', icon:'🔰', label:'Left shoulder', group:'Neck & Shoulders', kws:[] },
  { slot:'shoulder-right', icon:'🔰', label:'Right shoulder', group:'Neck & Shoulders', kws:[] },
  { slot:'chest', icon:'🛡️', label:'Chest', group:'Torso', kws:['armor','cuirass','robe','coat','jacket','vest','kimono','plate','breastplate'] },
  { slot:'back', icon:'🎒', label:'Back', group:'Torso', kws:['cloak','cape','mantle','backpack','quiver','satchel'] },

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
  { slot:'upper-arm-left', icon:'💪', label:'Left upper arm', group:'Arms', kws:[] },
  { slot:'upper-arm-right', icon:'💪', label:'Right upper arm', group:'Arms', kws:[] },
  { slot:'forearm-left', icon:'🦾', label:'Left forearm', group:'Arms', kws:[] },
  { slot:'forearm-right', icon:'🦾', label:'Right forearm', group:'Arms', kws:[] },
  { slot:'wrist-upper-left', icon:'⌚', label:'Left wrist — front', group:'Wrists', kws:[] },
  { slot:'wrist-lower-left', icon:'🔗', label:'Left wrist — back', group:'Wrists', kws:[] },
  { slot:'wrist-front-right', icon:'⌚', label:'Right wrist — front', group:'Wrists', kws:[] },
  { slot:'wrist-back-right', icon:'🔗', label:'Right wrist — back', group:'Wrists', kws:[] },
  { slot:'hand-left-wearing', icon:'💍', label:'Left hand — worn', group:'Hands', kws:[] },
  { slot:'hand-left-action', icon:'🗡️', label:'Left hand — held', group:'Hands', kws:[] },
  { slot:'hand-right-wearing', icon:'💍', label:'Right hand — worn', group:'Hands', kws:[] },
  { slot:'hand-right-action', icon:'🗡️', label:'Right hand — held', group:'Hands', kws:[] },

  // --- auto-guessed, resumed here to keep the whole array in head-to-foot order ---
  { slot:'waist', icon:'🪢', label:'Waist', group:'Waist', kws:['belt','sash','girdle','waistband'] },
  { slot:'legs', icon:'👖', label:'Legs', group:'Legs', kws:['greaves','trousers','pants','leggings','hakama'] },
  { slot:'thigh-left', icon:'🦵', label:'Left thigh', group:'Thighs', kws:[] },
  { slot:'thigh-right', icon:'🦵', label:'Right thigh', group:'Thighs', kws:[] },
  { slot:'foot', icon:'👢', label:'Feet / ankles', group:'Feet', kws:['boot','tabi','shoe','sandal','geta','anklet'] },
];
// Shoulder items (pauldrons, epaulettes, etc.) are checked separately from the generic
// per-rule loop in computeEquipSlots below, for two reasons: (1) there's no way to tell left
// vs right from an item's name, so matching here just means "this is A shoulder item" and the
// left/right split happens by equip order instead of by keyword; (2) checking it first also
// keeps something like "Shoulder Armor" from being grabbed by Chest's bare 'armor' keyword
// before it ever gets a chance to be recognized as a shoulder piece.
const SHOULDER_KWS = ['pauldron','spaulder','shoulder guard','shoulder pad','shoulder plate','shoulder piece','shoulder protector','shoulder collar','shoulder board','aiguillette','shoulder insignia','shoulder patch','shoulder flash','epaulet','epaulette','shoulder cape','shoulder harness','shoulder holster','shoulder'];
function isShoulderItem(name){
  const n = String(name||'').toLowerCase();
  return SHOULDER_KWS.some(k => n.includes(k));
}
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
// A full-face covering physically rules out separately equipping something in Lower face or
// Ears underneath it (you can't also have a mouth guard or earrings on while a full face
// mask/shield/cage is on) — DISABLED_BY maps a slot to the list of slots it blocks. Display-only,
// same as the rest of this compass: it doesn't stop the Inventory long-press sheet from setting
// an item's status to "Equipped", it just stops that item from being shown as filled here while
// the blocking slot is occupied.
const EQUIP_SLOT_DISABLED_BY = { 'face-full': ['eyes', 'face-lower', 'ears'] };
function computeEquipSlots(items, ids){
  const bySlot = {};
  const accessories = [];
  (items||[]).forEach((raw, i)=>{
    const it = splitItemEntry(raw);
    if(!isOnBodyStatus(it.status)) return;
    const id = (ids && ids[i]) || null;
    // Shoulder items fill Left first, then Right, purely by the order they're encountered
    // here (i.e. Inventory's own list order) — same idea as buying/equipping one at a time in
    // a game: whichever one you equipped first lands in Left, the next one in Right. A third
    // simultaneously-equipped shoulder item (both slots already taken) falls back to Accessory
    // rather than being dropped silently.
    if(isShoulderItem(it.name)){
      const openSlot = !bySlot['shoulder-left'] ? 'shoulder-left' : (!bySlot['shoulder-right'] ? 'shoulder-right' : null);
      if(openSlot){
        const rule = EQUIP_SLOT_RULES.find(r => r.slot === openSlot);
        bySlot[openSlot] = Object.assign({}, it, rule, { id });
      } else {
        accessories.push(Object.assign({}, it, { slot:'accessory', icon:'🏷️', label:'Accessory' }, { id }));
      }
      return;
    }
    const rule = guessEquipSlot(it.name);
    const withId = Object.assign({}, it, rule, { id });
    if(rule.slot === 'accessory'){ accessories.push(withId); return; }
    if(!bySlot[rule.slot]) bySlot[rule.slot] = withId;
  });
  const disabledSlots = new Set();
  for(const [blocker, blocked] of Object.entries(EQUIP_SLOT_DISABLED_BY)){
    if(bySlot[blocker]) blocked.forEach(s => disabledSlots.add(s));
  }
  return { bySlot, accessories, disabledSlots };
}
// Renders the equip hub (two tap-to-upload avatar images) followed by every slot as a single
// plain list, one row per slot, grouped under its `group` header (Body, Head & Face, Neck &
// Shoulders, ...) — no boxed grid, no per-slot thumbnails, just an icon + label + whatever's
// currently equipped there ("Empty" if nothing is). Slots are wired live to the long-press
// action sheet's Equip/Unequip toggle: a slot whose guessed item is currently "Equipped" shows
// that item's name; every other slot just shows "Empty" (or "Blocked" if a covering item like a
// full face mask rules it out). Still fully display-only here — no data-id, no click handling —
// the actual equip/unequip action lives on the Inventory card itself (see the itemActionSheet
// wiring further down); this just reflects whatever that toggle last set. Items that DID get
// matched but don't map to any of the fixed body slots (computeEquipSlots' `accessories`
// bucket) are listed as a small chip row underneath instead of being silently dropped.
function renderEquipCompassHtml(items, ids, photos, equipHub){
  const { bySlot, accessories, disabledSlots } = computeEquipSlots(items, ids);
  let lastGroup = null;
  let sectionsHtml = '';
  let rowsBuf = '';
  const flushSection = () => {
    if(lastGroup !== null) sectionsHtml += `<div class="equip-legend-section"><div class="equip-legend-section-title">${escapeHtml(lastGroup)}</div>${rowsBuf}</div>`;
    rowsBuf = '';
  };
  EQUIP_SLOT_RULES.forEach(rule=>{
    if(rule.group !== lastGroup){ flushSection(); lastGroup = rule.group; }
    const isDisabled = disabledSlots.has(rule.slot);
    // A disabled slot never shows a filled item, even if that item's own status still says
    // "Equipped" in Inventory — the blocking item (e.g. a full face mask) physically covers it.
    const item = isDisabled ? null : bySlot[rule.slot];
    const isFilled = !!item;
    const label = isDisabled ? `${rule.label} — blocked` : rule.label;
    const nameHtml = isFilled
      ? `<div class="equip-legend-name">${escapeHtml(item.name)}</div>`
      : `<div class="equip-legend-name is-empty">${isDisabled ? 'Blocked' : 'Empty'}</div>`;
    rowsBuf += `<div class="equip-legend-row${isFilled ? ' is-filled' : ''}">
      <div class="equip-legend-icon${isFilled ? ' is-filled' : ''}">${rule.icon}</div>
      <div class="equip-legend-text">
        <div class="equip-legend-label${isFilled ? ' is-filled' : ''}">${escapeHtml(label)}</div>
        ${nameHtml}
      </div>
    </div>`;
  });
  flushSection();
  const accessoriesHtml = accessories.length
    ? `<div class="equip-accessories-title">Accessories</div><div class="equip-accessories">${accessories.map(a => `<span class="equip-accessory-chip">${escapeHtml(a.name)}</span>`).join('')}</div>`
    : '';
  // The "+ Add image" hub row (two tap-to-upload avatar slots above the slot list) has been
  // removed by request — the Equip screen now starts directly with the slot legend below.
  return `<div class="equip-compass-wrap">
    <div class="equip-legend">${sectionsHtml}</div>
    ${accessoriesHtml}
  </div>`;
}

// ---------- equip-box tap-to-upload handlers ----------
// REMOVED by request: the "+ Add image" hub (two tap-to-upload avatar slots at the top of the
// Equip screen) no longer renders (see renderEquipCompassHtml above), so there's nothing left
// for these listeners to attach to. setEquipHubPhoto (further up this file) is left in place
// but is now unused/dead code — harmless to keep in case the hub is ever brought back, but
// nothing calls it anymore.


