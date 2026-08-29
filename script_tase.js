/* script_tase.js — Timeline and Scheduled Events: the deterministic guards
   that keep those two sections of the Letter of Records honest.

   This is one quarter of what used to be a single script_letter_of_records.js,
   later split out into this file (Timeline + Scheduled Events) and three
   siblings: script_finance.js (Finances), script_inventory_equip.js
   (Inventory/Equip Box), and script_saal.js (Skills & Abilities/Learning) —
   split so each pair of sections can be read and edited independently of the
   others. Depends on globals from index.html's inline Section 1 (load that
   file first); load order relative to script_chatroom.js, script_finance.js,
   script_inventory_equip.js, and script_saal.js doesn't matter — all share one
   global scope.

   The data model/schema, merge engine, panel rendering, pre-send claim checks, and the
   Relationships short-label helper all live in script_chatroom.js, which calls many
   functions defined here (guardTimelineDay, guardScheduledEvents, etc.) from its own
   schema/migration/merge-pipeline code.

   STOPWORDS (defined in the Timeline section below) is relied on by the near-duplicate-
   entry check in script_chatroom.js's mergePanelUpdate. Safe across the file split
   since all files share one global scope and are loaded together.

   Organized into 2 numbered sections below, in this order:
     1. TIMELINE            — "Current Day" advancement: time-skip detection, the
                              shared "Day N — desc" parser, narration verification,
                              and the Current Day guard.
     2. SCHEDULED EVENTS    — the dated-entry add/remove guard, the manual "system
                              bro" add UI, and lore-seeding for events already
                              stated in a world's setup text.

   Skills & Abilities and Learning — the permanent-record and in-progress-percentage
   sections that used to sit alongside these two — now live in script_saal.js.

   Order is for readability only — every top-level binding is a function
   declaration or a plain const assigned at load time, so nothing above is
   order-sensitive at runtime.
   ################################################################################ */


// ################################################################################
// SECTION 1 — TIMELINE
// "Current Day" advancement: time-skip detection (how many days the recent log
// actually supports), "Day N — desc" parsing, narration verification, and the
// Current Day guard itself (forward-only, capped at the next Scheduled Events day).
// Scheduled Events has its own section (5) right below — this part only owns the day
// counter.
// ################################################################################


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
  return /month/i.test(unitStr) ? n * 30 : /week/i.test(unitStr) ? n * 7 : n;
}
const VARIABLE_SKIP_RE = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|a\s+couple(?:\s+of)?|a\s+few|several)\s+(nights?|days?|weeks?|months?)\b/gi;
const FIXED_SKIP_RE = /\b(overnight|(?:a|the|that|this|one)\s+night(?:'s\s+(?:rest|sleep))?|night'?s\s+(?:rest|sleep)|(?:the\s+)?next\s+morning|til{1,2}\s+morning|until\s+morning|(?:the\s+)?next\s+day|a\s+week|a\s+month)\b/gi;
// NOTE: there used to be a fixed ceiling here (MAX_SINGLE_SKIP_DAYS, 31) blocking any single
// skip bigger than "about a month" outright, regardless of the Scheduled Events list. Removed
// on purpose — it fought with the nearestUpcoming clamp in guardTimelineDay below instead of
// cooperating with it: a skip past a due event got the useful "day N — event name" message
// when it was small enough to duck under the ceiling, but a bigger skip (two months, half a
// year — same destination, same due event in the way) tripped this instead and blocked with an
// unrelated "can't exceed 31 days" message that never mentioned the event at all. Scheduled
// Events is meant to be the only brake on a forward skip; how far past it someone tries to jump
// shouldn't change which guard answers. The recent log still has to support the days claimed
// (maxAllowedDaySkip, right below) and the day still can't sail past a Scheduled Events entry
// uncontested (nearestUpcoming clamp) — those two are what should actually stop an ungrounded
// or over-eager skip, not an arbitrary day count.
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
const COUNTDOWN_BEFORE_RE = /\b(?:in|until|within|since|back)\b(?:\s+\w{1,10}){0,2}\s*$/i;
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
  while((m = FIXED_SKIP_RE.exec(text))) total += /month/i.test(m[1]) ? 30 : /week/i.test(m[1]) ? 7 : 1;
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
// ---------- (removed) EXPLICIT SKIP override ----------
// There used to be a helper here (explicitlySkipsEvent / SKIP_INTENT_RE) that let a player
// deliberately skip past a due Scheduled Events entry by saying so ("I'm skipping the exam"),
// with the story narrating it as missed. Removed — see the comment above the nearestUpcoming
// check in guardTimelineDay: a Scheduled Events entry is now an unconditional wall with no
// opt-out, so nothing in this file needs to detect "did the player ask to skip this one".
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
      }
      // Scheduled Events is an absolute ceiling, checked before anything else below: no
      // wording, no claimed amount, and no path (live turn or resync) gets to cross it. There
      // used to be a "the player explicitly says they're skipping this one" override here
      // (explicitlySkipsEvent) that let Current Day move past a due entry on request, with the
      // system prompt narrating it as a missed event with consequences. Removed by design —
      // a Scheduled Events entry is now a hard wall with no bypass of any kind: the only way
      // past one is for Current Day to actually reach it first (which auto-triggers it per
      // worldSystemPrompt's AUTO-TRIGGER rule), at which point it stops counting as "upcoming"
      // on its own (see the '<=' check below) and the next entry becomes the new ceiling.
      //
      // This check also now runs BEFORE the phrase-support checks that used to gate it, and
      // unconditionally overrides them: a due date already fixes the correct destination no
      // matter how the player phrased the request ("after fifty years", "next season", a wildly
      // unsupported jump, whatever) or whether the recent log describes the skip at all — once
      // a Scheduled Events entry sets the real ceiling there's nothing left to validate. The
      // phrase-support checks still apply in full for any skip that doesn't cross a scheduled
      // day (or when there's no upcoming entry at all) — that's the original, unrelated
      // protection against a background model just nudging the day up on its own.
      //
      // "Nearest still-upcoming" uses strictly '>' (day > oldNum), not '>=': once Current Day
      // has actually reached an entry's day, that entry stops counting as "upcoming" starting
      // the very next turn on its own, without needing to be resolved/removed first (entries
      // are permanent — see guardScheduledEvents below — so '>=' would lock Current Day at that
      // day forever with nothing able to clear it).
      if(!reason && delta > 0){
        let nearestUpcoming = null;
        for(const cat of Object.values(panel.categories || {})){
          if(!cat || cat.type !== 'list') continue;
          for(const entry of cat.data || []){
            const parsed = parseDayEntry(entry);
            if(!parsed || parsed.day <= oldNum) continue;
            if(nearestUpcoming == null || parsed.day < nearestUpcoming) nearestUpcoming = parsed.day;
          }
        }
        if(nearestUpcoming != null && newNum > nearestUpcoming){
          showGuardWarning(worldId, `Timeline — capped Current Day at ${nearestUpcoming} (was about to jump to ${newNum}): a Scheduled Events entry falls on day ${nearestUpcoming}, so the story can't skip past it until that event actually happens.`);
          newNum = nearestUpcoming;
        } else if(!isResync){
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
          // leaving the Scheduled Events ceiling above as the only brake instead of an actual guard.
          reason = `the recent log only supports a skip of about ${allowedSkip} day${allowedSkip===1?'':'s'}, not ${delta}`;
        }
      }
      if(reason){
        showGuardWarning(worldId, `Timeline — blocked Current Day change (${oldNum} → ${newNum}): ${reason}.`);
        delete catUpdate.kv[k];
        continue;
      }
      // Not blocked (and, if it crossed a scheduled day, already clamped down to it above) —
      // write the value back.
      catUpdate.kv[k] = String(newNum);
    }
    if(Object.keys(catUpdate.kv).length === 0) delete catUpdate.kv;
  }
  return data;
}


// ################################################################################
// SECTION 2 — SCHEDULED EVENTS
// Add/remove guard for dated entries (permanent once added, only ever removable once
// their day has arrived AND the log shows them resolved), the manual "system bro"
// add UI, and lore-seeding for events already stated in a world's own setup text.
// ################################################################################


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

