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
   here) from its own schema/migration/merge-pipeline code. guardCurrencyIncreases now
   takes a 4th argument, playerText — see its own comment for why.

   Cross-file dependencies worth flagging (both directions — this file and
   script_inventory_equip.js lean on each other):
     - CURRENCY_NAME_RE, FINANCE_CATEGORY_RE, and extractNumbersNearKey (all defined
       below) are called from script_inventory_equip.js's Inventory guards, so a
       currency-looking kv stat that ended up outside the Finance category is still
       recognized the same way there.
     - subsetSumMatches and splitItemEntry, both defined in script_inventory_equip.js,
       are now called from this file (subsetSumMatches by guardCurrencyDecreases/
       guardCurrencyIncreases as before; splitItemEntry by the new
       inventoryDecreasedThisTurn helper, which the sell/trade-for-money path in
       guardCurrencyIncreases uses). Both calls go through a small safe-wrapper
       (safeSubsetSumMatches / safeSplitItemEntry below) that degrades gracefully
       instead of throwing if script_inventory_equip.js isn't loaded for some reason.
   Safe across the file split since all files share one global scope and are loaded
   together — load order between this file and script_inventory_equip.js doesn't matter.

   Inventory and Equip Box now live in script_inventory_equip.js.

   ---- TABLE OF CONTENTS (sections appear in this order below) ----
     1. CONSTANTS & CURRENCY-DETECTION PATTERNS
        Currency word list, Finance/Inventory category matchers, and the shared
        negation/intent word list + gap-word builders used by the confirmation
        regexes further down.
     2. IDENTITY GUARD
        guardIdentityChanges + normalizeForGrounding. Lives here (not its own file)
        because it reuses the same grounding helper as the currency guards.
     3. KEY MATCHING, NORMALIZATION & TEXT HELPERS
        keyFlexibleSrc, normalizeCurrencyKey, keyMatchRegex, stripQuotedSpeech, and
        the safe wrappers around script_inventory_equip.js's subsetSumMatches/
        splitItemEntry.
     4. CONFIRMATION REGEX BUILDERS
        DECREASE_VERB_SRC / TRADE_ITEM_VERB_SRC and the decreaseConfirmRegexForKey /
        increaseConfirmRegexForKey builders, plus inventoryDecreasedThisTurn (the
        trade/sell path's Inventory-side check).
     5. GROUNDING LOOKUP HELPERS
        findCurrencyOldValue, knownCurrencyKeyNames, extractNumbersNearKey — read
        the panel/log to find a currency's current value and the numbers grounding
        a proposed change.
     6. POST-RESPONSE GUARDS
        guardCurrencyDecreases, guardCurrencyRenameBypass, guardCurrencyIncreases —
        the guards script_chatroom.js calls after each story reply to keep Finances
        honest.
     7. PRE-SEND CLAIM CHECKS
        checkCurrencyClaim, checkCurrencyClaimFromAI — moved here from
        script_letter_of_records.js so both halves of currency policing (pre-send
        claim checks and post-response guards) live in one file.
        checkClaimAgainstRecords in script_letter_of_records.js still calls straight
        into both (global scope, so load order doesn't matter). checkCurrencyClaim
        now also runs checkCurrencyClaimCompleteness (blocks a spend claim missing
        its verb, amount, or currency name) and checkUntrackedCurrencyClaim (blocks
        a named currency that isn't on the sheet at all) before its original
        overspend check; checkCurrencyClaimFromAI now blocks on an untracked
        currency too instead of silently passing — see FIX(15) below.

   Order is for readability only — every top-level binding is a function
   declaration or a plain const assigned at load time, so nothing above is
   order-sensitive at runtime.

   ---- CHANGE LOG (this pass) — every fix tagged FIX(n) inline below ----
   FIX(1)  DECREASE_VERB_SRC now carries the same idiom exclusions the old, unused
           SPEND_TRIGGER_RE had ("pay attention/respects/homage/tribute/no mind",
           "spend + time-word") — the regex that actually runs never had these before.
   FIX(2)  Gap words between "I" and the verb, and between the verb and the number,
           now also exclude intent/conditional/future words (want to, would, should,
           could, might, plan to, going to, ...) so "I want to pay 100 gold" no longer
           confirms a completed spend.
   FIX(3)  Negation word list now also covers couldn't/shouldn't/mightn't/wasn't/isn't
           (previously only had can't/won't/wouldn't/don't/didn't — "couldn't" was
           missing entirely).
   FIX(4)  Trade/exchange/swap/sell are pulled OUT of the decrease-verb bucket
           entirely (trading was never really "money going down," it's an item
           being converted into money — a currency INCREASE) and moved into a
           dedicated increase-only path (TRADE_ITEM_VERB_SRC / increaseConfirmRegexForKey)
           that additionally requires an actual Inventory decrease in the SAME turn
           (inventoryDecreasedThisTurn) before it will confirm the gain. Give/hand
           over/donate/repay/pay/spend/buy/purchase/invest/convert stay in the
           ordinary decrease bucket, completely separate from trade/swap/sell, per
           request — they never share a code path or a regex.
   FIX(5)  Player-authored quoted speech (inside "...") is stripped out of the text
           before either confirmation regex runs, so a player quoting an NPC or a lie
           ('I say "I already paid you 100 gold!" — but that was a lie') can no longer
           masquerade as the player's own real confirmation.
   FIX(6)  Currency detection is no longer purely per-turn/per-category: before
           scanning a turn's proposed update, we now also build a set of currency key
           names that ALREADY exist under a Finance-style category anywhere on the
           panel. A kv key matching one of those known names is treated as currency
           even if this turn's update proposes it under a differently-named category —
           closes the "rename the category to dodge the guard" gap for currencies that
           already exist. (A wholly invented currency's very first appearance outside
           a Finance-style category is still a real, documented limitation — no fixed
           list or existing-name check can catch a name that's never been seen before.)
   FIX(7)  A brand-new currency key (never tracked before) that starts at a NEGATIVE
           value used to skip both guards entirely (too new for the decrease guard,
           not technically bigger than 0 so not an "increase" either). Now
           guardCurrencyDecreases explicitly grounds a negative first appearance too.
   FIX(8)  New guardCurrencyRenameBypass: if a currency-looking key appears for the
           first time this turn while a differently-spelled (but clearly the same,
           once normalized) currency key already exists on the sheet, the new key is
           blocked unless the change is actually grounded — mirrors the protection
           Inventory already has (guardInventoryRenameBypass) that Finance never had.
   FIX(9)  DECREASE_NUMBER_SRC now also accepts spelled-out numbers ("one hundred
           gold"), not only digits.
   FIX(10) (Applied in script_chatroom.js, see that file) — the normal per-turn
           updatePanel() path used to check ONLY the single last player message for a
           spend confirmation, even though the grounding window spans 10 messages.
           It now checks every player message in that same window.
   FIX(11) extractNumbersNearKey's grounding window widened from ±25 to ±45
           characters — 25 was clipping legitimate, slightly wordier price phrasing.
   FIX(12) The old SPEND_TRIGGER_RE / SPEND_GAP_SRC dead code (never called from
           anywhere) has been removed outright rather than left as a misleading,
           unused "global switch" — the negation-word logic it pioneered now lives in
           one shared, actually-used constant (NEGATION_WORDS_SRC) instead.
   FIX(13) subsetSumMatches and splitItemEntry (both defined in
           script_inventory_equip.js) are now called through safe wrappers that fall
           back to a simpler equivalent instead of throwing if that file isn't loaded.
   FIX(14) decreaseConfirmRegexForKey / increaseConfirmRegexForKey now anchor the verb
           group with explicit \b boundaries instead of relying on an adjacent \s* to
           imply one.
   FIX(15) Pre-send currency claim checks (Section 7) now catch more than just
           overspend: checkCurrencyClaimCompleteness blocks a first-person spend
           claim that's missing its verb ("I 100 gold for the potion"), its amount
           ("I pay ryo for the potion"), or its currency name ("I pay 100 for the
           potion") — each with a warning explaining exactly what's missing.
           checkUntrackedCurrencyClaim blocks a named currency that never appears
           anywhere on the sheet ("I pay 50 diamonds..." when nothing tracks
           diamonds), separately from the existing overspend check (which only ever
           compares amounts for currencies that already exist on the sheet).
           checkCurrencyClaimFromAI (Layer 2) now also blocks on an untracked
           currency instead of silently letting an unrecognized claim.key through.
   FIX(16) checkCurrencyClaim's "for" heuristic was skipping the overspend check for the
           single most common spend phrasing there is: "I buy a sword for 200 gold" has the
           same "<number> for <key>" shape as "apples for 200 gold" (a sale, where the number
           belongs to what's being received, not <key>). The heuristic couldn't tell them
           apart and treated both as receiving, so a real overspend claim ("buy X for 500
           gold" with only 100 gold tracked) sailed through unchecked. The "for" skip now
           only applies when no spend-type verb (buy/pay/purchase/spend/invest/repay/cost/
           charged/owe) governs the clause; see SPEND_VERB_BEFORE_FOR_RE below.
   FIX(17) New checkCurrencyClaimInflatedPossession pre-send checker, mirroring
           guardCurrencyIncreases' grounding requirement (Section 6) but on the player's own
           claim text instead of the AI's proposed update: blocks a first-person "I have/I've
           got/I own/I possess N <currency>" claim when N is larger than what's actually
           tracked and the message isn't itself a spend/decrease claim, catching an inflated
           balance asserted as fact ("I have 5000 gold" when the sheet says 50) before it
           ever reaches the story model.
   FIX(18) New checkCurrencyClaimZeroBalance: a currency sitting at 0 (or negative) now blocks
           ANY spend claim that names it, without needing to parse the sentence for exactly
           where the claimed amount sits — closes the gap where a zero balance still wasn't
           being caught in phrasings the number-position regex handles poorly.
   FIX(19) "wallet" and "purse" removed outright from CURRENCY_WORDS_SRC (and "wallet" from
           FINANCE_CATEGORY_RE) per request. Also removes a standing asymmetry bug: "purse" was
           listed as a currency WORD but was never in FINANCE_CATEGORY_RE, so a category
           literally titled "Purse" was never recognized as Finance at all.
   FIX(23) Editing World Lore mid-story (after the first story turn) silently never touched
           Finances at all — seedFinancesFromLore only ever ran once, gated on !hadStory at the
           index.html call site, and nothing filled that gap for a later edit. New
           updateFinancesFromLoreEdit (Section 8b) now runs on every mid-story lore save instead:
           a currency amount that's new or increased in the lore text gets ADDED on top of the
           current balance (never overwritten), tracked via a new world.financeLoreSnapshot field
           so re-saving unchanged lore can't re-add the same amount twice.
   FIX(20) FINANCE_CATEGORY_RE, INVENTORY_CATEGORY_RE, and IDENTITY_CAT_RE were all bare
           "^prefix" regexes with nothing anchoring where the prefix ends — "Bankside Quests"
           matched FINANCE_CATEGORY_RE and "Geared Up" matched INVENTORY_CATEGORY_RE just
           because they started with the same letters as "bank"/"gear". Every alternative now
           ends in \w* (or is a fixed whole word) plus a trailing \b, so the match has to
           consume a real word, not just a shared prefix of a longer, unrelated one.
   ################################################################################ */

// ##############################################################################
// SECTION 1 — CONSTANTS & CURRENCY-DETECTION PATTERNS
// Currency word list, Finance/Inventory category matchers, and the shared
// negation/intent word list + gap-word builders used by the confirmation
// regexes in Section 4.
// ##############################################################################

// ================= FINANCES — CURRENCY GUARDS =================
// Currency can only move if the player's own message (decreases) or the recent log
// (increases) actually grounds the change — spend-confirmation detection, per-key
// matching, and the up/down guards themselves. (The Identity guard sits in the middle
// of this block since it reuses the same grounding helper — see the note below.)

// FIX(19): "wallet" and "purse" removed outright (both from the word list and the category
// regex below) per request — neither container word is a currency amount itself, and "purse"
// in particular was an asymmetry bug (listed as a currency word but never recognized as a
// Finance category name — see FIX(20)'s changelog entry). Dropping both sidesteps that
// asymmetry entirely instead of patching it.
const CURRENCY_WORDS_SRC = 'gold|money|cash|coin|coins|currency|credit|credits|gil|ryo|dollars?|yen|yuan|pounds?|euros?|roubles?|rubles?|silver|iron|funds|gem|gems|token|tokens|points?|chips?|bits?|rupees?|zenny|zeni|bells?|shekels?|drachma|denarii|florins?|coppers?|bronze|platinum|diamonds?|crystals?|shards?|marks?|crowns?';
const CURRENCY_NAME_RE = new RegExp('\\b(?:' + CURRENCY_WORDS_SRC + ')\\b', 'i');
// A story can invent ANY currency name ("Belruit", "Trade Bars", whatever fits its setting) —
// no fixed word list above can ever be exhaustive. So the real, general-purpose signal is
// the CATEGORY the stat lives in: anything tracked under a Finance/Currency/Treasury-style
// category is currency, regardless of what the individual stat is called. CURRENCY_NAME_RE
// above stays only as a fallback for a currency-looking key that ended up outside that
// category (e.g. folded into Identity or Inventory as a kv). FIX(6) below adds a second,
// stronger fallback: a key matching an ALREADY-TRACKED currency name anywhere on the sheet.
// FIX(20): every alternative is now a fully enumerated whole word (or small, explicit set of
// inflections) followed by \b, instead of a bare prefix with nothing after it. Previously
// "Bankside Quests" or "Currencylessness" matched just because they STARTED with "bank"/
// "currency" — the regex never checked where that prefix actually ended. A plain trailing \w*
// isn't a safe fix on its own either: "gear\w*" still swallows the real inflection "Geared" whole
// ("Geared Up" would still false-positive) since \w* only stops at the next non-word character.
// So each root here is spelled out to its known real forms (financ-e/es/ial, currenc-y/ies,
// econom-y/ies/ic/ics, invent-ory, gear, equip-ment, ...) rather than left open-ended.
const FINANCE_CATEGORY_RE = /^(financ(?:e|es|ial)?|currenc(?:y|ies)?|econom(?:y|ies|ic|ics)?|treasury|coffers?|bank)\b/i;
// FIX(6): matches the category Inventory items live under, so the trade/sell-for-money path
// below (inventoryDecreasedThisTurn) can find it regardless of exactly what it's named.
// FIX(20): same fix as FINANCE_CATEGORY_RE above, enumerated rather than open-ended — "Geared
// Up" and "Inventive Solutions" no longer misclassify as Inventory just because they start with
// the same letters as "gear"/"invent".
const INVENTORY_CATEGORY_RE = /^(inventory|holdings?|gear|equip(?:ment)?)\b/i;

// ---------- shared negation/intent word list (FIX(2), FIX(3), FIX(12)) ----------
// Any of these words appearing as a "gap" word between "I" and a decrease/increase verb, or
// between the verb and the number, stops that alternative from matching — both genuine
// negations (not/never/couldn't/...) AND intent/conditional/future phrasing (want to, would,
// should, might, plan to, ...), since neither describes a transaction that actually happened.
// FIX(3): added couldn't/shouldn't/mightn't/wasn't/isn't/hasn't/hadn't (previously missing —
// "I couldn't pay 100 gold" used to incorrectly confirm a spend it explicitly denied).
// FIX(2): added the intent/modal words so "I want to pay 100 gold" / "I should give him 100
// gold" / "I might spend 100 gold" no longer confirm a transaction that hasn't happened yet.
// FIX(21): "aim to pay" / "aspire to pay" were bypassing the intent guard entirely — same
// meaning as "want to"/"plan to" (already blocked) but the words themselves weren't in the
// list. Added as unambiguous future-intent verbs.
// NOT added: "maybe"/"probably"/"guess"/"mean"/"figure" — these hedge the AMOUNT or read as
// conversational filler on a real completed action ("I guess I paid too much"), not whether
// the transaction happened at all; adding them risks blocking genuine spend confirmations.
const NEGATION_WORDS_SRC = 'not|never|n\'?t|refuse\\w*|avoid\\w*|stop\\w*|quit\\w*|skip\\w*|' +
  'can\'?t|won\'?t|wouldn\'?t|don\'?t|didn\'?t|couldn\'?t|shouldn\'?t|mightn\'?t|wasn\'?t|isn\'?t|hasn\'?t|hadn\'?t|' +
  'want\\w*|wish\\w*|hop(?:e|es|ed|ing)|plan\\w*|tr(?:y|ies|ied|ying)|attempt\\w*|consider\\w*|intend\\w*|aim\\w*|aspir\\w*|' +
  'going|gonna|would|should|could|might|may|will|thinking';
// Builds a negation/intent-aware gap of up to `maxWords` words. Each intervening word must
// individually fail to be one of NEGATION_WORDS_SRC, or the whole alternative fails to match —
// same mechanism the file always used, just consolidated into one place (FIX(12)) instead of
// being duplicated inline wherever a gap was needed.
function gapSrc(maxWords){
  return '(?:\\s+(?!(?:' + NEGATION_WORDS_SRC + ')\\b)\\w+){0,' + maxWords + '}\\s*';
}
// Up to 3 words between "I" and the verb — covers "I end up paying", "I decide to purchase".
const DECREASE_I_GAP_SRC = gapSrc(3);
// Up to 6 words between the verb and the number — covers "my loan of", "him with", "him or her".
const DECREASE_VERB_TO_NUM_GAP_SRC = gapSrc(6);
// Up to 2 words between the number and the currency name — covers a scale word ("1 million
// dollars") or a small connector ("100 in gold"). No negation check needed here in practice
// (a negation this late essentially never appears between a number and its unit), left simple.
const DECREASE_NUM_TO_CUR_GAP_SRC = '(?:\\s+\\w+){0,2}\\s*';

// Deliberately does NOT include "I have (enough) money" or "I owe" — those describe
// checking a balance or taking on a future debt, not an actual completed transaction, and
// matching them was letting the background model justify decreases the player never
// actually confirmed (a merely-mentioned balance was enough to "unlock" a spend).
const TIME_WORD_RE_SRC = '(?:a\\s*few|a\\s*couple(?:\\s*of)?|several|many|\\d+|one|two|three|four|five|six|seven|eight|nine|ten|a|an|the)?\\s*(?:night|day|days|evening|evenings|hour|hours|week|weeks|month|months|moment|moments|while)';

// ##############################################################################
// SECTION 2 — IDENTITY GUARD
// guardIdentityChanges + normalizeForGrounding. Lives here (not its own file)
// because it reuses the same grounding helper as the currency guards below.
// ##############################################################################

// ---- Identity guard (lives here because it shares normalizeForGrounding() with the
// currency spend-confirmation logic above, not because it's currency itself) ----
// FIX(20): same enumerated-word fix as FINANCE_CATEGORY_RE/INVENTORY_CATEGORY_RE — a category
// like "Identityless Wanderer" (hypothetical, but the same class of bug) no longer misclassifies
// just because it starts with "identity".
const IDENTITY_CAT_RE = /^identit(?:y|ies)\b/i;
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

// ##############################################################################
// SECTION 3 — KEY MATCHING, NORMALIZATION & TEXT HELPERS
// keyFlexibleSrc, normalizeCurrencyKey, keyMatchRegex, stripQuotedSpeech, and the
// safe wrappers around script_inventory_equip.js's subsetSumMatches/splitItemEntry.
// ##############################################################################

// Builds the "flexible" regex source for a currency key name — tolerates a missing/extra
// trailing "s" ("Dollars" on the sheet vs. player typing "100 dollar"). Shared by
// keyMatchRegex below and the stricter decrease-confirmation regex further down.
function keyFlexibleSrc(key){
  const esc = String(key || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return esc.replace(/s$/i, '') + 's?'; // "Dollars"->"Dollars?", "Gold"->"Golds?"
}
// Normalizes a currency key name for fuzzy same-currency comparison (FIX(8)): lowercase,
// strip all whitespace, drop one trailing "s". "Gold Coins" / "gold coin" / "GoldCoin" all
// normalize to the same string, so a lightly-renamed key can still be recognized as the same
// currency it used to be.
function normalizeCurrencyKey(key){
  return String(key || '').toLowerCase().replace(/\s+/g, '').replace(/s$/,'');
}
// Builds a matcher for a specific currency key name that tolerates a missing/extra trailing
// "s" and matches on a real word boundary rather than a raw substring (so "Gil" doesn't
// accidentally match inside an unrelated longer word). Cached per key since guardCurrencyDecreases
// can run this for the same key across multiple categories/turns.
const _keyMatchReCache = new Map();
function keyMatchRegex(key){
  const cacheKey = String(key || '');
  if(_keyMatchReCache.has(cacheKey)) return _keyMatchReCache.get(cacheKey);
  const re = new RegExp('\\b' + keyFlexibleSrc(key) + '\\b', 'i');
  _keyMatchReCache.set(cacheKey, re);
  return re;
}

// FIX(5): strips player-authored quoted speech before either confirmation regex runs, so a
// quoted lie or a quoted NPC line inside the PLAYER's own message ('I say "I already paid you
// 100 gold!" — but that was a lie') can't masquerade as the player's own real confirmation.
// Handles straight and curly double quotes. Not a perfect fix (a legitimately-quoted nickname
// like 'I paid the merchant "Big Joe" 100 gold' also gets its quoted span stripped — harmless
// here since "Big Joe" isn't a number or currency word) but closes the realistic abuse case.
function stripQuotedSpeech(text){
  return String(text || '').replace(/["\u201c\u201d][^"\u201c\u201d]*["\u201c\u201d]/g, ' ');
}

// FIX(13): safe wrappers around the two helpers this file borrows from
// script_inventory_equip.js. If that file isn't loaded for some reason, these degrade to a
// simpler equivalent instead of throwing and aborting the whole guard pass.
function safeSubsetSumMatches(target, numbers){
  if(typeof subsetSumMatches === 'function') return subsetSumMatches(target, numbers);
  console.warn('[money guard] subsetSumMatches unavailable (script_inventory_equip.js not loaded?) — falling back to direct-match-only grounding');
  return numbers.includes(Math.round(target));
}
function safeSplitItemEntry(raw){
  if(typeof splitItemEntry === 'function') return splitItemEntry(raw);
  // Minimal fallback: strip a leading "<qty> " if present, no status-dash parsing.
  const s = String(raw || '').trim();
  const qm = /^([\d,]+)\s+(.*)$/.exec(s);
  return { qty: qm ? parseInt(qm[1].replace(/,/g,''),10) : null, name: (qm?qm[2]:s).trim(), status: null };
}

// ##############################################################################
// SECTION 4 — CONFIRMATION REGEX BUILDERS
// DECREASE_VERB_SRC / TRADE_ITEM_VERB_SRC and the decreaseConfirmRegexForKey /
// increaseConfirmRegexForKey builders, plus inventoryDecreasedThisTurn (the
// trade/sell path's Inventory-side check).
// ##############################################################################

// ---------- stricter decrease confirmation: verb + number + THIS currency's own name ----------
// A currency can only go down if the player's own message contains all three, anchored to the
// same phrase: a recognized spend/decrease verb, an actual number, and the specific currency's
// own name (not just any generic currency word). "I paid 100" (no currency named) and "I paid
// ryo" (no number) don't confirm anything; "I paid 100 ryo" does.
//
// FIX(4): trade/exchange/swap/sell are deliberately NOT in this list anymore — see
// TRADE_ITEM_VERB_SRC / increaseConfirmRegexForKey below. This list is only ever about money
// leaving the player directly (paying, spending, buying, giving/handing away, donating,
// repaying, converting one currency into another) — never about trading an item for money,
// which is a separate, increase-only path that additionally requires an Inventory item to have
// actually gone down the same turn.
// FIX(1): "pay"/"spend" get their idiom exclusions back (previously only the dead
// SPEND_TRIGGER_RE had these — this, the regex that actually runs, never did).
const DECREASE_VERB_SRC =
  'pa(?:y|ys|id|ying)(?!\\s*(?:my\\s*)?(?:respects?|attention|homage|tribute|no\\s*mind))' + '|' +
  'bu(?:y|ys|ying|ought)' + '|' +
  'spen(?:d|ds|t|ding)(?!\\s*' + TIME_WORD_RE_SRC + ')' + '|' +
  'purchas(?:e|es|ed|ing)' + '|' +
  'invest(?:s|ed|ing)?' + '|' +
  'repa(?:y|ys|id|ying)' + '|' +
  'donat(?:e|es|ed|ing)' + '|' +
  '(?:gi(?:ve|ves|ving)|gave|given)' + '|' +
  'hand(?:s|ed|ing)?\\s*(?:it\\s*|them\\s*)?over' + '|' +
  'convert(?:s|ed|ing)?';

// FIX(4): the trade/sell-item-for-money bucket, kept in its own separate constant/regex/
// function so it never shares a code path with DECREASE_VERB_SRC above. This is only ever
// used to confirm a currency INCREASE, and only once inventoryDecreasedThisTurn also holds —
// i.e. "I swap my dagger for 100 gold" only counts once an actual Inventory item is leaving
// the sheet this same turn, not just because the word "swap" and a number/currency co-occur.
const TRADE_ITEM_VERB_SRC =
  'sell(?:s|ing)?|sold' + '|' +
  'trad(?:e|es|ed|ing)' + '|' +
  'exchang(?:e|es|ed|ing)' + '|' +
  'swap(?:s|ped|ping)?';

// FIX(9): also accepts spelled-out numbers ("one hundred", "twelve thousand") — this is only
// ever used to detect THAT a number-like phrase is present, never to parse its value (the
// actual value comes from the model's proposed kv), so a rough word-number list is enough.
const NUMBER_WORD_SRC = '(?:(?:a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)[\\s-]*)+';
const DECREASE_NUMBER_SRC = '(?:[\\d,]+(?:\\.\\d+)?|' + NUMBER_WORD_SRC + ')';

const _decreaseConfirmReCache = new Map();
// FIX(14): verb group now explicitly \b-bounded on both sides instead of relying on an
// adjacent \s* to imply a boundary.
function decreaseConfirmRegexForKey(key){
  const cacheKey = String(key || '');
  if(_decreaseConfirmReCache.has(cacheKey)) return _decreaseConfirmReCache.get(cacheKey);
  const re = new RegExp(
    // FIX(22): "ll" dropped from this optional suffix — it was silently swallowing the "'ll" in
    // "I'll pay 50 gold", so the future-tense marker never actually appeared as its own word for
    // the negation/intent-aware gap right after to catch. Without "ll" here, "I'll ..." simply
    // fails to match this confirm-regex at all (same as "I won't ..." already does), so a stated
    // future promise can never ground/confirm a currency decrease. Spelled-out "I will pay ..."
    // was always caught correctly since "will" is its own word inside NEGATION_WORDS_SRC.
    "\\bi\\b(?:'|\u2019)?(?:ve|d)?" + DECREASE_I_GAP_SRC +
    "\\b(?:" + DECREASE_VERB_SRC + ")\\b" + DECREASE_VERB_TO_NUM_GAP_SRC +
    DECREASE_NUMBER_SRC + DECREASE_NUM_TO_CUR_GAP_SRC +
    "\\b(?:" + keyFlexibleSrc(key) + ")\\b",
    'i'
  );
  _decreaseConfirmReCache.set(cacheKey, re);
  return re;
}

// FIX(4): the increase-side mirror of decreaseConfirmRegexForKey, built from
// TRADE_ITEM_VERB_SRC instead of DECREASE_VERB_SRC. Confirms "verb + number + this currency's
// name" for a sell/trade/exchange/swap phrase. On its own this is NOT enough to authorize a
// currency increase — guardCurrencyIncreases below only accepts it once
// inventoryDecreasedThisTurn also holds, so trading has to actually cost the player an item.
const _increaseConfirmReCache = new Map();
function increaseConfirmRegexForKey(key){
  const cacheKey = String(key || '');
  if(_increaseConfirmReCache.has(cacheKey)) return _increaseConfirmReCache.get(cacheKey);
  const re = new RegExp(
    // FIX(22): same "ll" removal as decreaseConfirmRegexForKey above, for the same reason.
    "\\bi\\b(?:'|\u2019)?(?:ve|d)?" + DECREASE_I_GAP_SRC +
    "\\b(?:" + TRADE_ITEM_VERB_SRC + ")\\b" + DECREASE_VERB_TO_NUM_GAP_SRC +
    DECREASE_NUMBER_SRC + DECREASE_NUM_TO_CUR_GAP_SRC +
    "\\b(?:" + keyFlexibleSrc(key) + ")\\b",
    'i'
  );
  _increaseConfirmReCache.set(cacheKey, re);
  return re;
}

// FIX(4): true if this turn's proposed update actually takes an Inventory item away (a plain
// removal with no matching re-add, or a stackable quantity reduction on the same item) —
// required alongside increaseConfirmRegexForKey before a trade/sell/swap/exchange phrase is
// allowed to confirm a currency gain. Uses safeSplitItemEntry (FIX(13)) so this never throws
// if script_inventory_equip.js isn't loaded — it just can't confirm any trade in that case,
// which is the safe direction to fail in (blocks the gain rather than allowing an ungrounded one).
function inventoryDecreasedThisTurn(data){
  if(!data || !data.categories) return false;
  for(const [catName, catUpdate] of Object.entries(data.categories)){
    const looksLikeInventory = INVENTORY_CATEGORY_RE.test(catName) || catName.toLowerCase() === 'inventory';
    if(!catUpdate || !looksLikeInventory) continue;
    if(!Array.isArray(catUpdate.list_remove) || !catUpdate.list_remove.length) continue;
    const adds = Array.isArray(catUpdate.list_add) ? catUpdate.list_add.map(safeSplitItemEntry) : [];
    for(const removedRaw of catUpdate.list_remove){
      const removed = safeSplitItemEntry(removedRaw);
      const matchingAdd = adds.find(a => a.name.toLowerCase() === removed.name.toLowerCase());
      if(!matchingAdd) return true; // straight removal, no offsetting re-add — a real decrease
      // Same item re-added — only a decrease if it's a stackable quantity reduction.
      if(removed.qty != null && matchingAdd.qty != null && matchingAdd.qty < removed.qty) return true;
    }
  }
  return false;
}

// ##############################################################################
// SECTION 5 — GROUNDING LOOKUP HELPERS
// findCurrencyOldValue, knownCurrencyKeyNames, extractNumbersNearKey — read the
// panel/log to find a currency's current value and the numbers grounding a
// proposed change.
// ##############################################################################

// FIX(6): collects every currency key name already tracked under a Finance-style category
// anywhere on the current panel, normalized for fuzzy matching. Lets guardCurrencyDecreases/
// guardCurrencyIncreases recognize an EXISTING currency even if this turn's update proposes it
// under a differently-named category (closes the "rename the category to dodge the guard" gap
// for currencies that already exist — a wholly new invented currency's very first appearance
// outside a Finance-style category remains a documented, unavoidable limitation).
// FIX(6) continued: resolves a currency key's CURRENT value on the panel even if this turn's
// proposed update files it under a different category name than where it actually lives. Tries
// the same category name first (the normal, fast path); if that finds nothing, falls back to
// scanning every Finance-style category on the panel for a matching key — otherwise a known
// currency that got relocated to a mismatched category would look like a brand-new key with no
// history (oldNum null), which skips the decrease guard entirely.
function findCurrencyOldValue(panel, catName, k){
  const sameCat = panel && panel.categories ? panel.categories[findExistingKey(panel.categories, catName) || catName] : null;
  if(sameCat && sameCat.type === 'kv'){
    const foundKey = findExistingKey(sameCat.data, k);
    if(foundKey != null) return parseFloat(String(sameCat.data[foundKey]).replace(/,/g,''));
  }
  if(panel && panel.categories){
    for(const [pc, pcData] of Object.entries(panel.categories)){
      if(!pcData || pcData.type !== 'kv' || !FINANCE_CATEGORY_RE.test(pc)) continue;
      const fk = findExistingKey(pcData.data, k);
      if(fk != null) return parseFloat(String(pcData.data[fk]).replace(/,/g,''));
    }
  }
  return null;
}

function knownCurrencyKeyNames(panel){
  const names = new Set();
  if(panel && panel.categories){
    for(const [catName, cat] of Object.entries(panel.categories)){
      if(!cat || cat.type !== 'kv' || !cat.data) continue;
      if(!FINANCE_CATEGORY_RE.test(catName)) continue;
      for(const k of Object.keys(cat.data)) names.add(normalizeCurrencyKey(k));
    }
  }
  return names;
}

// Finds every number that appears near an occurrence of `key` (singular/plural tolerant,
// same matcher as keyMatchRegex) anywhere in `haystack`, within a small character window —
// e.g. "for 10,000 ryo" or "Paid 3,500 ryo administrative fee". Commas are stripped before
// parsing so "10,000" reads as 10000. Deduplicated, capped at 8 distinct numbers (plenty for
// even a busy multi-purchase turn) to keep the subset-sum check below cheap.
// FIX(11): window widened from ±25 to ±45 characters — 25 was clipping legitimate, slightly
// wordier price phrasing ("a grand total of exactly twelve thousand five hundred ryo").
function extractNumbersNearKey(key, haystack){
  const src = keyMatchRegex(key).source; // already \b...s?\b, case-insensitive
  const globalRe = new RegExp(src, 'gi');
  const found = new Set();
  let m;
  while((m = globalRe.exec(haystack))){
    const start = Math.max(0, m.index - 45);
    const end = Math.min(haystack.length, m.index + m[0].length + 45);
    const window = haystack.slice(start, end).replace(/,/g, '');
    const nums = window.match(/\d+(?:\.\d+)?/g) || [];
    for(const n of nums){ found.add(Math.round(parseFloat(n))); if(found.size >= 8) break; }
    if(found.size >= 8) break;
  }
  return [...found];
}

// ##############################################################################
// SECTION 6 — POST-RESPONSE GUARDS
// guardCurrencyDecreases, guardCurrencyRenameBypass, guardCurrencyIncreases — the
// guards script_chatroom.js calls after each story reply to keep Finances honest.
// ##############################################################################

function guardCurrencyDecreases(data, panel, playerText, recentLogText){
  if(!data || !data.categories) return data;
  // FIX(5): quoted speech stripped before the confirmation regex ever sees the text.
  const text = stripQuotedSpeech(playerText || '');
  const groundingHaystack = String(recentLogText || '') + ' ' + text;
  const knownCurrencies = knownCurrencyKeyNames(panel);

  for(const [catName, catUpdate] of Object.entries(data.categories)){
    if(!catUpdate || !catUpdate.kv || typeof catUpdate.kv !== 'object') continue;
    const catIsCurrency = FINANCE_CATEGORY_RE.test(catName) || CURRENCY_NAME_RE.test(catName);
    for(const [k, v] of Object.entries(catUpdate.kv)){
      // FIX(6): also gate a key whose normalized name matches an already-tracked currency,
      // even if this category/key combo doesn't look like currency on its own.
      const isKnownCurrency = knownCurrencies.has(normalizeCurrencyKey(k));
      if(!catIsCurrency && !CURRENCY_NAME_RE.test(k) && !isKnownCurrency) continue;
      const newNum = parseFloat(String(v).replace(/,/g,''));
      if(isNaN(newNum)) continue;
      const oldNumRaw = findCurrencyOldValue(panel, catName, k); // FIX(6): checks other categories too
      const oldNum = (oldNumRaw != null && !isNaN(oldNumRaw)) ? oldNumRaw : null;

      // FIX(7): a brand-new key (oldNum null) that starts NEGATIVE used to skip both guards
      // entirely (too new for this decrease guard, and not > 0 so not an "increase" either).
      // Ground it here directly, treating its absolute value like a delta that needs support.
      if((oldNum == null || isNaN(oldNum)) && newNum < 0){
        const absDelta = Math.abs(newNum);
        const nearbyNumbers = extractNumbersNearKey(k, groundingHaystack);
        const grounded = nearbyNumbers.includes(Math.round(absDelta)) || safeSubsetSumMatches(absDelta, nearbyNumbers);
        if(!grounded){
          console.warn(`[money guard] blocked ${catName}.${k} — new currency key introduced already negative (${newNum}) with no grounding for that amount in the recent log`);
          delete catUpdate.kv[k];
        }
        continue;
      }

      if(oldNum == null || isNaN(oldNum) || newNum >= oldNum) continue; // not a decrease — nothing to gate

      // FIX(8): rename-bypass check — if this key doesn't already exist under this exact name,
      // but a differently-spelled currency key that's clearly the SAME currency once normalized
      // does exist (and this one doesn't), treat this as a rename attempt on that other balance,
      // not a fresh decrease with no history. Block until it's independently grounded like any
      // other decrease would be (the check just below already requires that regardless).
      // (No separate action needed here beyond documenting the intent — findExistingKey already
      // resolves exact/plural variants; this block only matters for the case findExistingKey
      // does NOT resolve, i.e. existingRaw came back null for a key that normalizeCurrencyKey
      // says already exists elsewhere. That path is naturally already caught above by
      // "oldNum == null" not applying here since existingRaw is what's used for oldNum. See
      // guardCurrencyRenameBypass below for the complementary explicit case.)

      // ALWAYS require a verb + a number + THIS currency's own name together in the player's
      // own message. "I paid 100" (no currency named) and "I paid ryo" (no number) never
      // confirm a spend; "I paid 100 ryo" does.
      const confirmed = decreaseConfirmRegexForKey(k).test(text);
      if(!confirmed){
        console.warn(`[money guard] blocked ${catName}.${k} decrease (${oldNum} -> ${newNum}) — no "<verb> ... <number> ... ${k}" phrase (e.g. "I paid 100 ${k}") found in player's recent messages`);
        delete catUpdate.kv[k];
        continue;
      }
      // A confirmed spend phrase only proves A transaction happened, not that THIS proposed
      // new total is arithmetically right. Accept the drop if EITHER (a) the new total is
      // itself stated somewhere in the log, OR (b) the exact delta (old − new) matches a
      // number stated near this currency's name in the log, OR (c) the delta matches the sum
      // of several such nearby numbers (a turn buying more than one priced item at once).
      const delta = oldNum - newNum;
      const nearbyNumbers = extractNumbersNearKey(k, groundingHaystack);
      const grounded = nearbyNumbers.includes(Math.round(newNum))
        || nearbyNumbers.includes(Math.round(delta))
        || safeSubsetSumMatches(delta, nearbyNumbers);
      if(!grounded){
        console.warn(`[money guard] blocked ${catName}.${k} decrease (${oldNum} -> ${newNum}, drop of ${delta}) — no number near "${k}" in the recent log adds up to that drop or matches the new total; likely bad arithmetic from the background model`);
        delete catUpdate.kv[k];
      }
    }
    if(Object.keys(catUpdate.kv).length === 0) delete catUpdate.kv;
  }
  return data;
}

// FIX(8): dedicated rename-bypass guard for currency, mirroring guardInventoryRenameBypass's
// protection for items. If a currency-looking key shows up for the FIRST time this turn (no
// existing entry under its own name anywhere) while a normalized-equivalent name already exists
// elsewhere on the sheet with a different value, this is very likely a rename/reshuffle rather
// than a genuine brand-new currency — require the same grounding a normal decrease/increase
// would need for the difference between the two, rather than letting it through as a "new key"
// with no history to compare against.
function guardCurrencyRenameBypass(data, panel, recentLogText){
  if(!data || !data.categories) return data;
  const haystack = String(recentLogText || '');
  // Map of normalized-name -> {catName, key, value} for every currency-looking kv entry
  // already on the panel under a Finance-style category.
  const existingByNorm = new Map();
  if(panel && panel.categories){
    for(const [catName, cat] of Object.entries(panel.categories)){
      if(!cat || cat.type !== 'kv' || !cat.data || !FINANCE_CATEGORY_RE.test(catName)) continue;
      for(const [k, v] of Object.entries(cat.data)){
        existingByNorm.set(normalizeCurrencyKey(k), { catName, key: k, value: parseFloat(String(v).replace(/,/g,'')) });
      }
    }
  }
  for(const [catName, catUpdate] of Object.entries(data.categories)){
    if(!catUpdate || !catUpdate.kv || typeof catUpdate.kv !== 'object') continue;
    const catIsCurrency = FINANCE_CATEGORY_RE.test(catName) || CURRENCY_NAME_RE.test(catName);
    for(const [k, v] of Object.entries(catUpdate.kv)){
      if(!catIsCurrency && !CURRENCY_NAME_RE.test(k)) continue;
      const existingCat = panel && panel.categories ? panel.categories[findExistingKey(panel.categories, catName) || catName] : null;
      const existingRawForThisKey = existingCat && existingCat.type==='kv' ? existingCat.data[findExistingKey(existingCat.data, k) || k] : null;
      if(existingRawForThisKey != null) continue; // this exact key already exists — not a rename, handled by the normal guards
      const norm = normalizeCurrencyKey(k);
      const priorEntry = existingByNorm.get(norm);
      if(!priorEntry || priorEntry.key === k) continue; // no fuzzy-equivalent prior name found
      const newNum = parseFloat(String(v).replace(/,/g,''));
      if(isNaN(newNum) || isNaN(priorEntry.value)) continue;
      if(newNum === priorEntry.value) continue; // same value under a new spelling — harmless, let it through
      const delta = Math.abs(newNum - priorEntry.value);
      const nearbyNumbers = extractNumbersNearKey(k, haystack);
      const grounded = nearbyNumbers.includes(Math.round(newNum)) || nearbyNumbers.includes(Math.round(delta)) || safeSubsetSumMatches(delta, nearbyNumbers);
      if(!grounded){
        console.warn(`[money guard] blocked ${catName}.${k} — looks like a renamed/reshuffled version of existing "${priorEntry.catName}.${priorEntry.key}" (${priorEntry.value} -> ${newNum}) with no grounding for that change in the recent log`);
        delete catUpdate.kv[k];
      }
    }
    if(Object.keys(catUpdate.kv).length === 0) delete catUpdate.kv;
  }
  return data;
}

// ---------- hard code-level guard: currency can only go UP if the gain is grounded ----------
// Same grounding logic as guardCurrencyDecreases, mirrored: accept the gain if EITHER (a) the
// new total itself is stated somewhere in the log, OR (b) the exact delta matches a number
// stated near this currency's name, OR (c) the delta matches the sum of several such nearby
// numbers. A brand-new currency key is treated as old value 0, so its very first amount must
// also be grounded.
//
// FIX(4): now also takes `playerText` as a 4th argument (all 3 live call sites in
// script_chatroom.js updated to pass it) — needed so a sell/trade/exchange/swap phrase can be
// checked against increaseConfirmRegexForKey. That path only fires when BOTH the phrase is
// present in the player's own text AND inventoryDecreasedThisTurn(data) is true this same turn
// — trading only counts as a grounded gain if it actually cost the player an item.
function guardCurrencyIncreases(data, panel, recentLogText, playerText){
  if(!data || !data.categories) return data;
  const haystack = String(recentLogText || '');
  const text = stripQuotedSpeech(playerText || ''); // FIX(5)
  const tradedItemAway = inventoryDecreasedThisTurn(data); // FIX(4)
  const knownCurrencies = knownCurrencyKeyNames(panel); // FIX(6)

  for(const [catName, catUpdate] of Object.entries(data.categories)){
    if(!catUpdate || !catUpdate.kv || typeof catUpdate.kv !== 'object') continue;
    const catIsCurrency = FINANCE_CATEGORY_RE.test(catName) || CURRENCY_NAME_RE.test(catName);
    for(const [k, v] of Object.entries(catUpdate.kv)){
      const isKnownCurrency = knownCurrencies.has(normalizeCurrencyKey(k));
      if(!catIsCurrency && !CURRENCY_NAME_RE.test(k) && !isKnownCurrency) continue;
      const newNum = parseFloat(String(v).replace(/,/g,''));
      if(isNaN(newNum)) continue;
      const oldNumRaw = findCurrencyOldValue(panel, catName, k); // FIX(6): checks other categories too
      const oldNum = (oldNumRaw != null && !isNaN(oldNumRaw)) ? oldNumRaw : 0;
      if(isNaN(oldNum) || newNum <= oldNum) continue; // not an increase — nothing to gate

      const delta = newNum - oldNum;
      const nearbyNumbers = extractNumbersNearKey(k, haystack);

      // FIX(4): a sell/trade/exchange/swap phrase naming this currency, combined with an
      // actual Inventory item leaving the sheet this same turn, is its own valid grounding for
      // the gain — separate from (and in addition to) the numeric-grounding checks below.
      const tradeConfirmed = tradedItemAway && increaseConfirmRegexForKey(k).test(text);

      const grounded = tradeConfirmed
        || nearbyNumbers.includes(Math.round(newNum))
        || nearbyNumbers.includes(Math.round(delta))
        || safeSubsetSumMatches(delta, nearbyNumbers);
      if(!grounded){
        console.warn(`[money guard] blocked ${catName}.${k} increase (${oldNum} -> ${newNum}, gain of ${delta}) — no number near "${k}" in the recent log adds up to that gain, no matching total, and no confirmed item-for-money trade this turn; likely an ungrounded/invented grant`);
        delete catUpdate.kv[k];
      }
    }
    if(Object.keys(catUpdate.kv).length === 0) delete catUpdate.kv;
  }
  return data;
}

// ##############################################################################
// SECTION 7 — PRE-SEND CLAIM CHECKS
// checkCurrencyClaim, checkCurrencyClaimFromAI — moved here from
// script_letter_of_records.js so both halves of currency policing (pre-send claim
// checks and post-response guards) live in one file. checkClaimAgainstRecords in
// script_letter_of_records.js still calls straight into both (global scope, so
// load order doesn't matter).
// ##############################################################################

// ---------- pre-send currency claim checks — MOVED from script_letter_of_records.js ----------
// checkCurrencyClaim (Layer 1, deterministic regex/math) and checkCurrencyClaimFromAI (Layer 2,
// code-side check of the AI-extracted claim list) now live here next to the rest of the Finance
// guards, since both exist only to police currency claims. checkClaimAgainstRecords in
// script_letter_of_records.js still calls straight into both the same way as before (global
// scope, so load order doesn't matter) — see its own comments for how Layer 1/Layer 2 fit
// together and for checkInventoryClaim/checkInventoryClaimFromAI, which stayed behind since
// they're Inventory's job, not Finance's. normalizeNumberWords (spelled-out number -> digit
// normalization) also stayed behind in script_letter_of_records.js, since checkClaimAgainstRecords
// runs it once and reuses the result for both the currency AND inventory checks.
//
// Small/lite models are unreliable at exact arithmetic — asking one "is 200 more than 51560?"
// can and did come back wrong (see: false "not enough funds" warning even though the sheet
// clearly listed far more than enough). So any numeric/currency comparison here is done with
// plain math against the panel's real tracked number instead of asking the AI to eyeball it.

// Verbs that indicate the player is claiming to complete a currency transaction (pay, spend,
// buy, trade, ...). Hoisted to a shared constant (previously declared inline inside
// checkCurrencyClaim only) so checkCurrencyClaimCompleteness below can reuse the exact same
// verb list instead of drifting out of sync with a second copy.
const SPEND_WORDS_RE = /\b(pay|paid|paying|pays|spend|spent|spending|hand(?:ed|ing)?\s*over|bought|buy|buying|purchas(?:e|ed|es|ing)|cost|charged|owe[ds]?|exchang(?:e|ed|es|ing)?|trad(?:e|ed|es|ing)|swap(?:s|ped|ping)?|convert(?:s|ed|ing)?|giv(?:e|es|ing)|gave|given|donat(?:e|ed|es|ing)|offer(?:s|ed|ing)?|tip(?:s|ped|ping)?|toss(?:es|ed|ing)?|drop(?:s|ped|ping)?|bet(?:s|ting)?|wager(?:s|ed|ing)?|gambl(?:e|ed|es|ing)|invest(?:s|ed|ing)?|deposit(?:s|ed|ing)?|withdraw(?:s|n|ing)?|withdrew)\b/i;

// FIX(16): true if a genuine SPENDING verb (money leaving the player) governs the clause —
// as opposed to a trade/sell-type verb or no verb at all, where "<key> ... for ..." really does
// mean the player is on the RECEIVING end. Deliberately a narrower list than SPEND_WORDS_RE:
// excludes sell/trade/exchange/swap (those genuinely are the receiving side of a "for" phrase)
// and excludes give/donate/tip/drop/bet/etc. (rare right before "for" and not worth the false-
// positive risk). Used only to decide whether the "for" skip below still applies.
const SPEND_VERB_BEFORE_FOR_RE = /\b(?:pa(?:y|ys|id|ying)|bu(?:y|ys|ying|ought)|spen(?:d|ds|t|ding)|purchas(?:e|es|ed|ing)|invest(?:s|ed|ing)?|repa(?:y|ys|id|ying)|cost|charged|ow(?:e|es|ed))\b/i;

// True if a first-person pronoun ("I", "I'm", "I've", "I'd", "I'll") appears anywhere in the
// text — used to scope the completeness/untracked-currency checks below to the player's OWN
// claims, never a third-party price mention ("the sword costs 200 gold" describing a
// merchant's price is never a claim the PLAYER is spending anything).
const FIRST_PERSON_RE = /\bi(?:'|\u2019)?(?:m|ve|d|ll)?\b/i;

function textMentionsAnyNumber(text){
  return /-?\d[\d,]*\.?\d*/.test(text);
}
// True if the text names a currency at all — either a generic currency word (CURRENCY_NAME_RE)
// or the exact/flexible name of a currency already tracked on the sheet.
function textMentionsAnyCurrencyName(text, panel){
  if(CURRENCY_NAME_RE.test(text)) return true;
  if(!panel || !panel.categories) return false;
  for(const cat of Object.values(panel.categories)){
    if(cat.type !== 'kv') continue;
    for(const key of Object.keys(cat.data)){
      if(keyMatchRegex(key).test(text)) return true;
    }
  }
  return false;
}

// ---------- completeness check: catches a malformed/partial spend claim ----------
// A well-formed spend claim needs three things together: a verb (pay/spend/buy/...), an
// amount, and the currency's name. The main overspend loop further down only ever compares
// numbers it can already find sitting next to a currency name — on its own it silently lets a
// message through if the phrasing is missing a piece entirely (no verb at all, a bare number
// with nothing naming what it's counting, or a currency named with no amount attached). This
// check runs first and blocks those malformed claims outright, always scoped to a first-person
// ("I ...") phrase so a third-party price mention is never mistaken for the player's own claim.
// Requires at least 2 of the 3 signals (verb/number/currency-name) before treating the message
// as a spend attempt at all — a single stray signal (e.g. "gold" mentioned in passing with no
// number anywhere) isn't enough to assume a transaction is even being claimed.
function checkCurrencyClaimCompleteness(userText, panel){
  if(!panel || !panel.categories) return null;
  if(!FIRST_PERSON_RE.test(userText)) return null; // not a first-person claim — nothing to check

  const hasVerb = SPEND_WORDS_RE.test(userText);
  const hasNumber = textMentionsAnyNumber(userText);
  const hasCurrencyName = textMentionsAnyCurrencyName(userText, panel);

  const signalCount = [hasVerb, hasNumber, hasCurrencyName].filter(Boolean).length;
  if(signalCount < 2) return null; // not enough here to look like a spend attempt at all

  if(!hasVerb){
    return `That doesn't read as a completed transaction — you mentioned an amount/currency but no action (pay, spend, buy, give, trade, ...). Say what you're doing with it.`;
  }
  if(!hasNumber){
    return `You said you're paying/spending but didn't give an amount. Say how much.`;
  }
  if(!hasCurrencyName){
    return `You said you're paying/spending an amount but didn't say which currency. Say what you're paying with.`;
  }
  return null; // verb + number + currency name all present — fall through to the checks below
}

// ---------- untracked-currency check: claims spending a currency that isn't on the sheet ----------
// Runs after completeness but before the per-key overspend loop: if the player names a specific
// currency word/key that never appears anywhere on the panel (not even a fuzzy/plural match),
// they don't have any of it at all — block regardless of the amount claimed, rather than
// silently letting the overspend loop skip it (that loop only ever iterates keys that already
// exist on the sheet, so a wholly unknown currency name would otherwise sail through unchecked).
function checkUntrackedCurrencyClaim(userText, panel){
  if(!panel || !panel.categories) return null;
  const trackedKeys = [];
  for(const cat of Object.values(panel.categories)){
    if(cat.type !== 'kv') continue;
    trackedKeys.push(...Object.keys(cat.data));
  }
  if(!trackedKeys.length) return null; // Finances untracked/empty entirely — not a "wrong currency" case

  const globalCurrencyRe = new RegExp(CURRENCY_NAME_RE.source, 'gi');
  let m;
  while((m = globalCurrencyRe.exec(userText))){
    const word = m[0];
    // Skip if this specific word already matches (or fuzzy-matches) a tracked key — it's a
    // real currency on the sheet, just possibly not spelled exactly like its key name.
    const alreadyTracked = trackedKeys.some(k => keyMatchRegex(k).test(word) || normalizeCurrencyKey(k) === normalizeCurrencyKey(word));
    if(alreadyTracked) continue;
    // Require a number somewhere nearby (same short window the overspend loop below uses) so a
    // bare currency mention with no amount isn't flagged here — that's
    // checkCurrencyClaimCompleteness's job instead.
    const start = Math.max(0, m.index - 20);
    const end = Math.min(userText.length, m.index + word.length + 20);
    const window = userText.slice(start, end);
    if(/-?\d[\d,]*\.?\d*/.test(window)){
      return `You don't have any "${word}" — it's not tracked on your sheet.`;
    }
  }
  return null;
}

// ---------- FIX(17): inflated-possession check — claims to HAVE more than the sheet tracks ----------
// Mirrors guardCurrencyIncreases' grounding requirement (Section 6), but on the player's own
// message before it ever reaches the story model: "I have 5000 gold" / "I've got 5000 gold" /
// "I own 5000 gold" asserted as plain fact, when the sheet only tracks a fraction of that, is an
// ungrounded gain the same way an AI-proposed jump would be — the difference is just which side
// of the conversation is trying to inject it. Deliberately scoped OFF whenever SPEND_WORDS_RE
// already matches (a real spend/decrease claim is checkCurrencyClaim's job, not this one) so the
// two checks never fight over the same message.
const _possessionConfirmReCache = new Map();
function possessionConfirmRegexForKey(key){
  const cacheKey = String(key || '');
  if(_possessionConfirmReCache.has(cacheKey)) return _possessionConfirmReCache.get(cacheKey);
  const re = new RegExp(
    "\\bi\\b(?:'|\u2019)?(?:ve|m)?" + gapSrc(2) +
    "\\b(?:have(?!\\s*to\\b)|has(?!\\s*to\\b)|got|own(?:s)?|possess(?:es)?|hold(?:s)?|carr(?:y|ies|ying))\\b" + gapSrc(4) +
    "(" + DECREASE_NUMBER_SRC + ")" + DECREASE_NUM_TO_CUR_GAP_SRC +
    "\\b(?:" + keyFlexibleSrc(key) + ")\\b",
    'i'
  );
  _possessionConfirmReCache.set(cacheKey, re);
  return re;
}
function checkCurrencyClaimInflatedPossession(userText, panel){
  if(!panel || !panel.categories) return null;
  if(!FIRST_PERSON_RE.test(userText)) return null;
  if(SPEND_WORDS_RE.test(userText)) return null; // a spend/decrease claim — not this checker's job
  for(const cat of Object.values(panel.categories)){
    if(cat.type !== 'kv') continue;
    for(const [key, value] of Object.entries(cat.data)){
      const numMatch = String(value).match(/-?\d[\d,]*\.?\d*/);
      if(!numMatch) continue; // only check stats that are actually numeric amounts
      const trackedNum = parseFloat(numMatch[0].replace(/,/g, ''));
      const m = possessionConfirmRegexForKey(key).exec(userText);
      if(!m || !m[1]) continue;
      // m[1] may be a spelled-out number (FIX(9)-style) rather than digits — only act when it
      // parses cleanly as digits; a spelled-out amount is left alone rather than risk a bad parse.
      if(!/^[\d,]+(?:\.\d+)?$/.test(m[1].trim())) continue;
      const claimedNum = parseFloat(m[1].replace(/,/g, ''));
      if(!isNaN(claimedNum) && claimedNum > trackedNum){
        return `You only have ${value} ${key}, not ${m[1].trim()}.`;
      }
    }
  }
  return null;
}

// ---------- FIX(18): zero/negative-balance check — you can't spend currency you don't have ----------
// The overspend loop below only fires once it can pin down exactly which number in the sentence
// is the claimed amount — fragile for real phrasing ("buy the potion for 50 gold" needs the "for"
// logic above to even reach it). This check sidesteps all of that for the one case that matters
// most: if a tracked currency is already at 0 (or negative) and the player's message both spends
// and names that currency at all, block it outright — no amount-parsing required, since ANY spend
// of a currency you don't have is invalid regardless of how much is claimed.
function checkCurrencyClaimZeroBalance(userText, panel){
  if(!panel || !panel.categories) return null;
  if(!SPEND_WORDS_RE.test(userText)) return null;
  for(const cat of Object.values(panel.categories)){
    if(cat.type !== 'kv') continue;
    for(const [key, value] of Object.entries(cat.data)){
      const numMatch = String(value).match(/-?\d[\d,]*\.?\d*/);
      if(!numMatch) continue; // not a numeric stat — not a balance to check
      const trackedNum = parseFloat(numMatch[0].replace(/,/g, ''));
      if(trackedNum > 0) continue; // they have some — let the overspend loop check the exact amount
      if(keyMatchRegex(key).test(userText)){
        return `You have ${value} ${key} — you can't spend any.`;
      }
    }
  }
  return null;
}

// ---------- FIX(22): stated-intent spend claims ("I will pay", "I wish to pay", "I figure
// I'll pay you later") are not a completed transaction — nothing has actually left the
// player's hands yet, so none of the checks below should block the message OR treat it as a
// claim to check at all. This mirrors the "skip anything negated, hypothetical, future-tense"
// rule readClaimsFromInput's own prompt already gives the AI-read step (Layer 2) — Layer 1's
// deterministic regex checks below never had that exemption, so a plain "I'll pay you
// tomorrow" was being blocked exactly like a real, already-happened overspend. Reuses
// NEGATION_WORDS_SRC (the same intent/negation word list the post-reply grounding guards use)
// rather than a new list, so "will/would/should/might/want/wish/plan/hope/aim/intend/going/
// gonna/thinking" and real negations (won't/can't/didn't/...) are all recognized identically
// everywhere in this file.
const SPEND_INTENT_PRECEDER_RE = new RegExp('\\b(?:' + NEGATION_WORDS_SRC + ')\\b', 'i');
// "I'll pay ..." never contains the literal word "will" — the contraction needs its own check
// alongside SPEND_INTENT_PRECEDER_RE above (same reasoning as the "ll" removal from
// decreaseConfirmRegexForKey/increaseConfirmRegexForKey's pronoun suffix below).
const CONTRACTION_LL_RE = /(?:'|\u2019)ll\b/i;
// True only when EVERY spend-verb occurrence in the message is itself preceded (within a few
// words) by an intent/negation word — a message that ALSO contains one real, unqualified spend
// verb elsewhere still gets checked normally, so "I'll pay you later, but here, take my ring"
// (an actual item hand-off) isn't accidentally waved through by the "later" framing on "pay".
function isIntentOnlySpendClaim(userText){
  const verbRe = new RegExp(SPEND_WORDS_RE.source, 'gi');
  let m, sawVerb = false;
  while((m = verbRe.exec(userText))){
    sawVerb = true;
    const start = Math.max(0, m.index - 40);
    const beforeSlice = userText.slice(start, m.index);
    const beforeWords = beforeSlice.trim().split(/\s+/).slice(-5).join(' ');
    if(!SPEND_INTENT_PRECEDER_RE.test(beforeWords) && !CONTRACTION_LL_RE.test(beforeSlice)) return false; // a real, unqualified spend verb here — not intent-only
  }
  return sawVerb;
}

function checkCurrencyClaim(userText, panel){
  if(!panel || !panel.categories) return null;
  if(isIntentOnlySpendClaim(userText)) return null; // FIX(22): stated future intent, not a completed spend — nothing to check

  const completenessIssue = checkCurrencyClaimCompleteness(userText, panel);
  if(completenessIssue) return completenessIssue;

  const zeroBalanceIssue = checkCurrencyClaimZeroBalance(userText, panel); // FIX(18)
  if(zeroBalanceIssue) return zeroBalanceIssue;

  const possessionIssue = checkCurrencyClaimInflatedPossession(userText, panel); // FIX(17)
  if(possessionIssue) return possessionIssue;

  if(!SPEND_WORDS_RE.test(userText)) return null; // only relevant if the message claims to spend/pay something

  const untrackedIssue = checkUntrackedCurrencyClaim(userText, panel);
  if(untrackedIssue) return untrackedIssue;

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
          if(/\bfor\b/i.test(connector) || /for\s*$/i.test(precedingText)){
            // FIX(16): "for" alone is ambiguous — "apples for 200 gold" (a sale, <key> is
            // received) and "buy a sword for 200 gold" (a spend, <key> is paid) have the exact
            // same shape. Only actually skip when no spend-type verb governs this clause; a
            // buy/pay/purchase/... verb means the player IS spending <key>, so fall through to
            // the overspend check instead of silently letting it pass.
            const clauseContext = userText.slice(Math.max(0, m.index - 60), m.index);
            if(!SPEND_VERB_BEFORE_FOR_RE.test(clauseContext)) continue;
          }
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
  // Previously stayed silent here ("key not found on sheet at all — unsure = don't block").
  // Updated policy: an AI-extracted claim naming a currency that doesn't fuzzy-match anything
  // tracked IS a "currency you don't have" claim (same case checkUntrackedCurrencyClaim handles
  // for Layer 1) — block it rather than letting it through. Trade-off: if the AI's extracted
  // claim.key is phrased very differently from the sheet's actual key name, this can also fire
  // on a currency the player really does have; loosen back to `return null` here if that proves
  // too aggressive in practice.
  return `You don't have any "${claim.key}" — it's not tracked on your sheet.`;
}

// ##############################################################################
// SECTION 8 — LORE-SEEDED STARTING FINANCES
// seedFinancesFromLore — new. Mirrors seedSkillsFromLore/seedScheduledEventsFromLore
// (script_saal.js / index.html): reads whatever starting money the player wrote
// directly into the world's own setup text and writes it onto the sheet ONCE, at
// world creation.
//
// WHY THIS WAS MISSING: Finances starts genuinely empty (defaultPanel(), no default
// balance) by design, and PANEL_SYS_PROMPT explicitly tells the per-turn model to
// "never invent a starting balance ... until the story actually gives the character
// money" — correct for stopping a MID-STORY gain from being invented out of dialogue,
// but it also silently applied to a balance the player declared up front in the
// world's own lore, since updatePanel()'s prompt never even includes the lore text
// (only the recent chat log). And even if the model proposed it anyway,
// guardCurrencyIncreases' grounding check only searches the chat log/player text for
// the number — never the lore — so it would just get stripped back out. Net effect:
// typing "I start with 500 gold" into the World Lore field could never reach the
// sheet on its own; only an opening line that RE-NARRATES the amount as visible story
// text would ground it. This function closes that gap directly, deliberately
// bypassing guardCurrencyIncreases entirely — a starting balance the player themselves
// declared in the world's own founding lore is a legitimate initial condition, not an
// ungrounded invented gain, so it shouldn't have to fight the guard that exists to
// catch the latter.
//
// Only ever WRITES the initial balance once, for a brand-new world with no story yet (same
// !hadStory gate as seedSkillsFromLore at the call site in index.html) — refuses to write over
// a Finances category that already has ANY tracked currency, as a second, belt-and-braces check
// independent of that gate. A LATER lore edit to an already-running world no longer falls
// through the cracks either: index.html routes that case to updateFinancesFromLoreEdit below
// instead, which adds on top rather than re-writing from scratch.
//
// Also stamps world.financeLoreSnapshot (a plain {currencyName: numericAmount} map of exactly
// what was just extracted from lore) onto the world record before returning. That snapshot is
// the baseline updateFinancesFromLoreEdit compares future lore edits against — without stamping
// it here, a world's very first mid-story lore edit would see no snapshot at all, treat the
// still-unchanged original lore amount as "brand new," and add it a second time on top of the
// balance this function already wrote.
async function seedFinancesFromLore(world){
  if(!world || !world.lore || !world.lore.trim()) return;
  const panel = await getPanel(world.id);
  const finCat = panel.categories['Finances'];
  if(finCat && finCat.data && Object.keys(finCat.data).length > 0) return;
  try{
    const { kv, parsed } = await extractLoreFinanceAmounts(world.lore);
    if(!kv) return;
    // Re-fetch and re-check right before writing: queueWorldOp already serializes this against
    // other world ops for the same world, but the AI call above took real time, and getPanel's
    // own backfill/migration passes can still have touched the panel meanwhile.
    const freshPanel = await getPanel(world.id);
    const freshFin = freshPanel.categories['Finances'];
    if(freshFin && freshFin.data && Object.keys(freshFin.data).length > 0) return;
    mergePanelUpdate(freshPanel, { categories: { Finances: { kv } } });
    await savePanel(world.id, freshPanel);
    world.financeLoreSnapshot = parsed;
    await saveWorld(world);
  }catch(e){ console.warn('[finances lore seed] failed', e); }
}

// ---------- shared: pull stated currency amounts out of lore text ----------
// Same extraction prompt/output shape seedFinancesFromLore always used — factored out so
// updateFinancesFromLoreEdit (below) can reuse it instead of duplicating the prompt. Returns
// `kv` (the original {"Gold":"500 gold"}-shaped strings, ready to hand to mergePanelUpdate) and
// `parsed` (the same keys with a bare numeric amount, for comparing against a snapshot/balance).
// `kv` is null when the lore states no explicit numeric amount at all.
async function extractLoreFinanceAmounts(lore){
  const prompt = `World setup text:\n${lore}\n\nDoes this text explicitly state a starting amount of money/currency the player character possesses right at the very start of the story? A stated number is required — e.g. "you start with 500 gold" or "she has 20,000 yen saved up" counts; a vague wealth description with no number, like "his family is wealthy" or "she's broke", does NOT count and should be ignored.\n\nIf yes, output ONLY a raw JSON object, no preamble, no markdown fences, in this exact shape: {"categories":{"Finances":{"kv":{"<currency name>":"<amount> <unit>"}}}} — one key per distinct currency/unit if more than one is stated. Write each value as the amount followed by its unit, spelled out the way the text names it, not a bare number, e.g. {"Gold":"500 gold"}, {"Dollars":"20,000 dollars"}, {"Ryo":"1,200 ryo"}.\n\nIf no explicit starting amount is stated anywhere in the text, output exactly {"categories":{}}.`;
  const bgModel = await getGeminiBgModel();
  const raw = await askAIWithRetry('You extract a single fact — an explicitly stated starting money amount, if any — from a piece of world-setup text. Output only the raw JSON object described, nothing else.', prompt, bgModel);
  const data = extractJsonObject(raw);
  const kv = data && data.categories && data.categories['Finances'] && data.categories['Finances'].kv;
  if(!kv || Object.keys(kv).length === 0) return { kv: null, parsed: {} };
  const parsed = {};
  for(const [name, val] of Object.entries(kv)){
    const m = String(val).match(/-?\d[\d,]*\.?\d*/);
    if(m) parsed[name] = parseFloat(m[0].replace(/,/g, ''));
  }
  return { kv, parsed };
}

// ##############################################################################
// SECTION 8b — MID-STORY LORE EDIT: ADD STATED AMOUNTS ON TOP, NEVER OVERWRITE
// updateFinancesFromLoreEdit — the mid-story counterpart to seedFinancesFromLore. Called
// instead of it, from index.html, whenever the world being saved already has story turns
// (hadStory === true). Per request: editing World Lore mid-story to state a new or larger
// currency amount ADDS that amount on top of whatever the sheet currently holds — it never
// replaces the balance outright, since the story may have already spent or grown it well past
// whatever the lore originally said.
//
// Duplicate-add protection: world.financeLoreSnapshot (stamped by both this function and
// seedFinancesFromLore) records the numeric amount last extracted from lore for each currency
// name. On every save this re-extracts the CURRENT lore's amounts and only treats a currency as
// something to add for if it's new to the snapshot (never seen in lore before) or its stated
// number went UP since the snapshot — and even then only the DELTA is added for an
// already-known currency, not the whole new figure. Re-saving with unchanged lore text produces
// the same extraction every time, so nothing new clears that bar and nothing is re-added. A
// lore number that went down (or a currency mention removed) is intentionally left alone: we
// only ever add here, never claw back a balance the story has since moved on from.
async function updateFinancesFromLoreEdit(world){
  if(!world || !world.lore || !world.lore.trim()) return;
  try{
    const { kv, parsed } = await extractLoreFinanceAmounts(world.lore);
    if(!kv){
      // Nothing numeric stated this time — leave both the sheet and the snapshot untouched
      // rather than clearing a snapshot that a later edit might still want to compare against.
      return;
    }

    const snapshot = (world.financeLoreSnapshot && typeof world.financeLoreSnapshot === 'object') ? world.financeLoreSnapshot : {};
    const toAdd = {};
    for(const [name, amt] of Object.entries(parsed)){
      const prev = snapshot[name];
      if(prev == null) toAdd[name] = amt;          // brand-new currency named in lore
      else if(amt > prev) toAdd[name] = amt - prev; // stated amount increased — add just the gap
      // amt <= prev: unchanged or decreased in the lore text -> intentionally a no-op
    }

    if(Object.keys(toAdd).length > 0){
      const freshPanel = await getPanel(world.id);
      const finCat = freshPanel.categories['Finances'];
      const finData = (finCat && finCat.data) || {};
      const kvUpdate = {};
      for(const [name, addAmt] of Object.entries(toAdd)){
        const existingRaw = finData[name];
        const existingMatch = existingRaw != null ? String(existingRaw).match(/-?\d[\d,]*\.?\d*/) : null;
        const existingBalance = existingMatch ? parseFloat(existingMatch[0].replace(/,/g, '')) : 0;
        const newBalance = existingBalance + addAmt;
        // Keep whatever unit text the lore used ("gold", "yen", ...) so the written value still
        // reads naturally, e.g. "620 gold" rather than a bare number with no unit.
        const unitMatch = String(kv[name]).match(/[a-zA-Z].*$/);
        const unitLabel = unitMatch ? unitMatch[0].trim() : name;
        kvUpdate[name] = `${newBalance} ${unitLabel}`;
      }
      mergePanelUpdate(freshPanel, { categories: { Finances: { kv: kvUpdate } } });
      await savePanel(world.id, freshPanel);
    }

    // Always refresh the snapshot to what lore says NOW, whether or not anything was added this
    // time, so the next save compares against the current text rather than a stale one.
    world.financeLoreSnapshot = parsed;
    await saveWorld(world);
  }catch(e){ console.warn('[finances lore mid-story update] failed', e); }
}

// ##############################################################################
// SECTION 9 — HOLDINGS (property: land/houses/shops) — LORE SEED + GROUNDED ACQUISITION
// guardHoldingsAcquisition + seedHoldingsFromLore. Holdings (script_letter_of_records.js's
// defaultPanel/CATEGORY_ORDER) is a permanent list category, same shape as Milestones.
// UPDATED PER REQUEST: Holdings now ALSO accepts new entries the story itself narrates — the
// player buying a piece of real property — same "require it to be grounded in the recent text"
// stance guardCurrencyIncreases already takes for a money gain. What it still never allows,
// from any story turn: removing, renaming, or otherwise editing a holding already on the sheet
// (losing a shop in a fire, etc.) — only a brand-new list_add, and only when grounded, gets
// through guardHoldingsAcquisition.
//
// UPDATED AGAIN PER REQUEST: a grounded acquisition verb + property noun is no longer enough on
// its own — the deal now also has to check out against Finances. The PLAYER'S OWN message has
// to name a specific tracked currency together with a quantity, and that quantity can't exceed
// what's actually on the sheet for that currency (holdingAffordabilityIssue below). This is the
// same "you only have X, not Y" stance checkCurrencyClaim already takes pre-send for an ordinary
// spend — reapplied here post-response since the Holdings list_add and any matching Finances kv
// decrease are two independent pieces of the same AI-proposed update, and only the latter had
// ever been price-checked before.
//
// Grouped in this file next to the Finances lore-seed above since both are "asset section
// seeded once from world lore, then guarded going forward" in the same shape.
// ##############################################################################

// Acquisition verbs that indicate the player has just come into possession of real property —
// mirrors SPEND_WORDS_RE's role for currency gains, but scoped to ownership-transfer verbs
// rather than plain spending (spending gold on a meal shouldn't ground a new Holdings entry).
const HOLDING_ACQUIRE_VERB_RE = /\b(bought|buy|buying|buys|purchas(?:e|ed|es|ing)|acquir(?:e|ed|es|ing)|accru(?:e|ed|es|ing)|inherit(?:s|ed|ing)?|paid|pay(?:s|ing)?\s*(?:off|for)|won|win(?:s|ning)?|(?:was|were|is|are|got)\s*given|gift(?:ed|s|ing)?|receiv(?:e|ed|es|ing)|built|build(?:s|ing)?|claim(?:s|ed|ing)?|sign(?:s|ed|ing)?\s*(?:the\s*)?deed|took\s*ownership|took\s*possession)\b/i;

// Property-type nouns — a bare acquisition verb ("I bought it") isn't enough on its own; the
// grounding text also has to name the kind of thing being acquired, so an unrelated purchase
// (buying bread, buying a sword) can't slip a new Holdings entry through on the verb alone.
const HOLDING_PROPERTY_NOUN_RE = /\b(propert(?:y|ies)|houses?|homes?|shops?|stores?|lands?|estates?|apartments?|flats?|farms?|buildings?|business(?:es)?|plots?|manors?|mansions?|cottages?|warehouses?|acreage|inns?|taverns?|residence(?:s)?|villas?|ranch(?:es)?|deeds?|lots?|parcels?)\b/i;

// ---------- guard: a Holdings purchase also has to check out against Finances ----------
// Requires, in the PLAYER'S OWN message (not narration — the deal has to be something the
// player themselves actually stated a price for): a tracked currency name, a quantity, and
// that quantity not exceeding what's currently on the sheet for that currency. Reuses
// FINANCE_CATEGORY_RE/CURRENCY_NAME_RE/keyMatchRegex/textMentionsAnyNumber — all already
// defined above for the currency guards. Returns null when the deal checks out, otherwise a
// short reason for the console warning.
//
// Deliberately does NOT reuse extractNumbersNearKey here: that helper collects every number
// within a wide (±45 char) window of a key, which is the right call for a plain "is this gain
// grounded at all" check, but wrong for "what price did the player attach to THIS currency" —
// on a short sentence naming two currencies ("I pay 5000 ryo and 8 gold for it"), a ±45 window
// around "gold" also catches "5000" (which belongs to ryo), and comparing that borrowed number
// against gold's own balance produces a false "you only have 10 Gold, not 5000" block even
// though the actual gold price (8) is perfectly affordable. closestNumberNearKey instead picks
// the single number with the smallest character distance to a given currency mention, so each
// currency is only ever checked against the number actually attached to it.
function closestNumberNearKey(key, text){
  const keyRe = new RegExp(keyMatchRegex(key).source, 'gi');
  const numRe = /-?\d[\d,]*\.?\d*/g;
  let best = null, bestDist = Infinity;
  let km;
  while((km = keyRe.exec(text))){
    const keyStart = km.index, keyEnd = km.index + km[0].length;
    numRe.lastIndex = 0;
    let nm;
    while((nm = numRe.exec(text))){
      const numStart = nm.index, numEnd = nm.index + nm[0].length;
      const dist = numStart >= keyEnd ? (numStart - keyEnd) : (numEnd <= keyStart ? (keyStart - numEnd) : 0);
      if(dist < bestDist){
        bestDist = dist;
        best = Math.round(parseFloat(nm[0].replace(/,/g, '')));
      }
    }
  }
  return best;
}
function holdingAffordabilityIssue(playerText, panel){
  const text = String(playerText || '');
  if(!textMentionsAnyNumber(text)) return 'no quantity found in your own message';
  if(!panel || !panel.categories) return 'no currency tracked on the sheet yet — nothing to check the price against';

  const tracked = [];
  for(const [catName, cat] of Object.entries(panel.categories)){
    if(!cat || cat.type !== 'kv' || !FINANCE_CATEGORY_RE.test(catName)) continue;
    for(const [key, value] of Object.entries(cat.data)){
      const numMatch = String(value).match(/-?\d[\d,]*\.?\d*/);
      if(!numMatch) continue; // only a numeric balance is something to check a price against
      tracked.push({ key, balance: parseFloat(numMatch[0].replace(/,/g,'')) });
    }
  }
  if(!tracked.length) return 'no currency tracked on the sheet yet — nothing to check the price against';

  const namedKeys = tracked.filter(t => keyMatchRegex(t.key).test(text));
  if(!namedKeys.length){
    // A generic currency word ("gold") that isn't actually one of the tracked keys still counts
    // as "named a currency" for the completeness half of this check — it's just one the player
    // doesn't have any of, same stance checkUntrackedCurrencyClaim takes for an ordinary spend.
    if(CURRENCY_NAME_RE.test(text)) return `named a currency that isn't tracked on the sheet`;
    return 'no currency name found in your own message';
  }

  for(const { key, balance } of namedKeys){
    const claimed = closestNumberNearKey(key, text);
    if(claimed != null && claimed > balance) return `you only have ${balance} ${key}, not ${claimed}`;
  }
  return null;
}

// ---------- guard: Holdings can only GAIN via a grounded, affordable in-story acquisition ----------
// Called from every place script_chatroom.js runs the other Finance/Inventory guards (the live
// per-turn pass, the every-4-turn memory<->panel reconciliation, and the rewind/regenerate
// resync). Any list_remove/kv/rename the AI proposed for Holdings is stripped unconditionally —
// those never had a valid story-side path and still don't. A list_add is allowed through only
// when BOTH halves check out: (1) the recent text (log + player message, whichever this call
// site has) contains an acquisition verb and a property-type noun, AND (2) the player's own
// message names an affordable, tracked currency + quantity (holdingAffordabilityIssue above).
// Failing either strips it, same as an ungrounded currency gain would be.
function guardHoldingsAcquisition(data, panel, recentLogText, playerText){
  if(!data || !data.categories) return data;
  const haystack = String(recentLogText || '') + ' ' + String(playerText || '');
  const verbAndNounGrounded = HOLDING_ACQUIRE_VERB_RE.test(haystack) && HOLDING_PROPERTY_NOUN_RE.test(haystack);
  const affordabilityIssue = verbAndNounGrounded ? holdingAffordabilityIssue(playerText, panel) : null;
  const acquisitionGrounded = verbAndNounGrounded && !affordabilityIssue;

  for(const catName of Object.keys(data.categories)){
    if(!/^holdings?/i.test(catName)) continue;
    const catUpdate = data.categories[catName];
    if(!catUpdate) continue;

    if(catUpdate.list_remove){
      console.warn(`[holdings guard] blocked ${catName}.list_remove — an existing Holdings entry can never be removed by a story turn`);
      delete catUpdate.list_remove;
    }
    if(catUpdate.kv){
      console.warn(`[holdings guard] blocked ${catName}.kv — Holdings is a list-only section, never key/value`);
      delete catUpdate.kv;
    }
    if(catUpdate.rename){
      console.warn(`[holdings guard] blocked ${catName}.rename — an existing Holdings entry can never be renamed by a story turn`);
      delete catUpdate.rename;
    }

    if(Array.isArray(catUpdate.list_add) && catUpdate.list_add.length > 0){
      if(!acquisitionGrounded){
        const reason = !verbAndNounGrounded
          ? 'no grounded acquisition (bought/inherited/given/... + property/house/land/shop/...) found in the recent text'
          : `failed the Finances check — ${affordabilityIssue}`;
        console.warn(`[holdings guard] blocked ${catName}.list_add (${JSON.stringify(catUpdate.list_add)}) — ${reason}`);
        delete catUpdate.list_add;
      }
    }

    if(Object.keys(catUpdate).length === 0) delete data.categories[catName];
  }
  return data;
}

// ---------- one-time lore seed: property stated in the world's own setup text ----------
// Same shape and same call-site pattern as seedFinancesFromLore right above, and the same
// !hadStory gate at the call site in index.html — only ever runs once, for a brand-new world
// with no story yet. This is still the only path allowed to write Holdings retroactively for
// what the world's lore already declares owned; a story-driven acquisition after that point
// goes through guardHoldingsAcquisition's list_add path instead, not this function.
async function seedHoldingsFromLore(world){
  if(!world || !world.lore || !world.lore.trim()) return;
  const panel = await getPanel(world.id);
  const holdCat = panel.categories['Holdings'];
  if(holdCat && Array.isArray(holdCat.data) && holdCat.data.length > 0) return;
  const prompt = `World setup text:\n${world.lore}\n\nDoes this text explicitly state that the player character owns any real property \u2014 land, a house, an apartment, a shop, an estate, or similar? Only count property explicitly stated as already owned/possessed by the player character right at the start of the story \u2014 not a place they merely live near, work at without owning, or might inherit/acquire later.\n\nIf yes, output ONLY a raw JSON object, no preamble, no markdown fences, in this exact shape: {"categories":{"Holdings":{"list_add":["<short property description>", "..."]}}} \u2014 one entry per distinct property, each a short phrase naming what it is and any defining detail the text gives (e.g. "Family estate in the Uchiha district", "Small tea shop on Main Street", "40 acres of rice paddy outside the village").\n\nIf no property is explicitly stated as owned, output exactly {"categories":{}}.`;
  try{
    const bgModel = await getGeminiBgModel();
    const raw = await askAIWithRetry('You extract a single fact — real property explicitly stated as owned by the player character, if any — from a piece of world-setup text. Output only the raw JSON object described, nothing else.', prompt, bgModel);
    const data = extractJsonObject(raw);
    const listAdd = data && data.categories && data.categories['Holdings'] && data.categories['Holdings'].list_add;
    if(!Array.isArray(listAdd) || listAdd.length === 0) return;
    // Re-fetch and re-check right before writing, same reasoning as seedFinancesFromLore above.
    const freshPanel = await getPanel(world.id);
    const freshHold = freshPanel.categories['Holdings'];
    if(freshHold && Array.isArray(freshHold.data) && freshHold.data.length > 0) return;
    mergePanelUpdate(freshPanel, { categories: { Holdings: { list_add: listAdd } } });
    await savePanel(world.id, freshPanel);
  }catch(e){ console.warn('[holdings lore seed] failed', e); }
}
