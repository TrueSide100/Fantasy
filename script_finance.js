/* script_finance.js — Finances: the deterministic currency guards that keep that
   section of the Letter of Records honest, plus the Identity-fact guard which rides
   along here since it reuses the same grounding helper.

   This is one third of what used to be a single script_letter_of_records.js,
   later split out into this file (Finances) and two siblings:
   script_inventory_equip.js (Inventory/Equip Box) and script_tase.js
   (Timeline/Scheduled Events) — split so this file can be read and edited
   independently of the item-tracking half (script_inventory_equip.js).
   Depends on globals from index.html's inline Section 1 (load that file first);
   load order relative to script_chatroom.js, script_inventory_equip.js,
   script_tase.js, and script_saal.js doesn't matter — all share one global scope.

   The data model/schema, merge engine, panel rendering, pre-send claim checks, and the
   Relationships short-label helper all live in script_chatroom.js, which calls
   guardCurrencyDecreases, guardCurrencyIncreases, and guardIdentityChanges (all defined
   here) from its own schema/migration/merge-pipeline code.

   Two real cross-file dependencies worth flagging (both directions — this file and
   script_inventory_equip.js lean on each other):
     - CURRENCY_NAME_RE, FINANCE_CATEGORY_RE, and extractNumbersNearKey (all defined
       below) are called from script_inventory_equip.js's Inventory guards, so a
       currency-looking kv stat that ended up outside the Finance category is still
       recognized the same way there.
     - subsetSumMatches, used by guardCurrencyDecreases/guardCurrencyIncreases below,
       is defined in script_inventory_equip.js (shared duplication-math helper).
   Safe across the file split since all files share one global scope and are loaded
   together — load order between this file and script_inventory_equip.js doesn't matter.

   Contains what used to be Section 1 of a larger merged file:
     1. FINANCES  — currency guards: spend/gain confirmation, per-key matching,
                    grounding against the recent log, plus the Identity-fact guard.

   Inventory and Equip Box now live in script_inventory_equip.js.

   Order is for readability only — every top-level binding is a function
   declaration or a plain const assigned at load time, so nothing above is
   order-sensitive at runtime.
   ################################################################################ */


// ################################################################################
// SECTION 1 — FINANCES
// Currency guards: spend/gain confirmation, per-key matching, grounding against the
// recent log. The Identity-fact guard rides along here since it reuses the same
// normalizeForGrounding() helper.
// ################################################################################


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


