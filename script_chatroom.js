/* ================================================================================
   script_chatroom.js — chat screen + chatroom-to-Letter-of-Records wiring

   This file merges what used to be two separate files:
     - script_outside-the-chatroom.js's Section 2 (the chat screen)
     - script_inside-the-chatroom.js's sub-sections 2.1 and 2.2 (the system
       prompt/update-resync pipeline, and the chat composer)
   The Letter of Records data model, merge engine, rendering, and pre-send claim
   checks (formerly sub-section 2.3 here) have been split out into their own file,
   script_letter_of_records.js — see that file for the categories it models
   (Identity, Milestones, Relationships, Status) and the generic machinery
   (mergePanelUpdate, renderPanelHtml, CAT_INFO, etc.) that every category,
   including the ones in the guard files below, renders and validates through.

   Kept separate on purpose, and still required alongside this file:
     - index.html's inline <script> (formerly Section 1 of
       script_outside-the-chatroom.js): storage helpers, els, screen
       navigation, the world editor, and the core AI-calling layer
       (askAI, askAIWithRetry, getGeminiBgModel, extractJsonObject,
       messageToLogLine, pushNavState, showOverlayModal/hideOverlayModal,
       etc). This must still load BEFORE this file — it defines the globals
       both parts below depend on.
     - script_letter_of_records.js: the Letter of Records data model, merge
       engine, panel rendering, and pre-send claim checks (checkClaimAgainstRecords
       and the check*ClaimFromAI functions) that sendMessage() below gates on.
     - script_finance.js / script_inventory_equip.js: Finances, Inventory, and
       Equip Box — the deterministic guards for those (guardCurrencyDecreases/
       Increases, guardStackableItems, etc.), called throughout Part 2 below.
     - script_tase.js / script_saal.js: Timeline, Scheduled Events, Skills &
       Abilities, and Learning — the deterministic guards for those
       (guardSkillProgress, guardSkillGraduation, guardItemVsPowerRouting, guardSkillFusion,
       guardInnateAffinityChatRestriction, guardTimelineDay, guardScheduledEvents, etc.), also
       called throughout Part 2 below.
       Load order between this file and any of the four guard files, or
       script_letter_of_records.js, does not matter — none of them define
       anything another needs at load time, only at call time, by which point
       all have finished loading.

   Recommended <script> order in index.html:
     1. (inline Section 1 — already in index.html)
     2. script_chatroom.js          (this file)
     3. script_letter_of_records.js
     4. script_finance.js
     5. script_inventory_equip.js
     6. script_tase.js
     7. script_saal.js

   No function, const, or top-level `let` name in this file collides with any in
   script_letter_of_records.js or the four guard files above, so nothing was
   renamed during the split.

   Organized into 2 parts below:
     PART 1 — THE CHAT SCREEN (was script_outside-the-chatroom.js's Section 2)
     PART 2 — CONNECTING THE CHATROOM TO THE LETTER OF RECORDS (was
              script_inside-the-chatroom.js's 2.1 and 2.2), split into 2
              sub-sections: 2.1 connecting the chatroom to the outside, and
              2.2 inside the chatroom (the composer).

   The one place load order actually matters — els.sendBtn's long-press-to-
   attach-media listener (Part 1) must be registered before sendMessage is wired
   to els.sendBtn.onclick (Part 2.2), so a long-press's synthetic click gets
   suppressed via stopImmediatePropagation() before it can also trigger a send —
   is preserved automatically by keeping Part 1 before Part 2, exactly as before.
   ================================================================================ */


/* ################################################################################
   PART 1 — THE CHAT SCREEN (story chat UI/flow)
   The actual chat screen and its moment-to-moment behavior: building the
   system prompt and rendering messages, sending/regenerating/continuing a
   turn, the "system bro" OOC tools panel, message long-press (copy/rewind),
   media attach (photo/gif/video), the memory-log updater, and chat-specific
   UI plumbing (log scroll padding, pinned background, composer-above-
   keyboard). This is the layer the player directly interacts with each turn.
   Reads and writes the Letter of Records via Part 2 below, and via
   script_finance.js, script_inventory_equip.js, script_tase.js, and
   script_saal.js, and uses index.html's inline storage/AI helpers (Section 1
   of the original app shell).
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
    // This is a periodic memory<->panel consistency check, NOT a rewind/regenerate resync — it
    // runs every 4 turns with nothing actually rewound. It was wrongly passing isResync=true,
    // which made guardSkillProgress skip the study/practice check entirely and trust whatever
    // percentage the background pass proposed (e.g. inferring "bought a book" implies training).
    // isResync=false here means the normal path applies: with no player text, PRACTICE_TRIGGER_RE
    // can't match, so no skill progress is ever invented or bumped by this pass — exactly the
    // "block the gain without an explicit confirmation" behavior the other guards below already
    // follow when given empty playerText.
    guardSkillProgress(data, panel, '', false);
    guardSkillGraduation(data, panel);
    guardItemVsPowerRouting(data);
    // No player action backs this pass (playerText is deliberately empty above), so fusion can
    // never be armed here — guardSkillFusion still runs to redirect/strip anything mis-shaped,
    // and guardInnateAffinityChatRestriction always runs regardless of player text, since those
    // two reserved tags are never chat-creatable no matter what triggered this update pass.
    guardSkillFusion(data, panel, '');
    guardInnateAffinityChatRestriction(data);
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
  // Splits into alternating narration / quoted-speech segments (straight or curly quotes)
  // first, same as before — but now also breaks the result into actual <p> paragraphs
  // instead of one flat run of text, which is what was making longer replies read as one
  // congested block:
  //  - narration is grouped into paragraphs of a handful of sentences at a time (a break
  //    only ever lands after a sentence actually finishes, never mid-sentence)
  //  - a spoken line always gets its own paragraph, with its own spacing above/below, so
  //    dialogue visually stands apart from the narration around it instead of running
  //    straight into it
  const parts = s.split(/("(?:[^"\\]|\\.)*"|“[^”]*”)/g).filter(p => p !== '');
  const SENTENCES_PER_PARA = 5; // ~5-6 sentences ("lines") before starting a new paragraph
  const paragraphs = [];
  let sentenceBuf = [];

  function flushNarration(){
    if(sentenceBuf.length === 0) return;
    paragraphs.push(`<p>${sentenceBuf.join(' ')}</p>`);
    sentenceBuf = [];
  }

  parts.forEach(part=>{
    const isDialogue = (part.startsWith('"') && part.endsWith('"') && part.length>=2) || (part.startsWith('“') && part.endsWith('”'));
    if(isDialogue){
      // A spoken line breaks whatever narration paragraph was building, gets its own
      // paragraph, and narration afterward starts counting fresh — dialogue is never
      // folded into the 5-6-sentence narration count.
      flushNarration();
      paragraphs.push(`<p class="dialogue-line"><span class="dialogue">${escapeHtml(part)}</span></p>`);
      return;
    }
    // Narration: split on sentence-ending punctuation (keeping it attached to its
    // sentence) so a paragraph break only ever falls between two complete sentences.
    const sentences = part.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) || [part];
    sentences.forEach(sentence=>{
      const trimmed = sentence.trim();
      if(!trimmed) return;
      sentenceBuf.push(escapeHtml(trimmed));
      if(sentenceBuf.length >= SENTENCES_PER_PARA) flushNarration();
    });
  });
  flushNarration();
  return paragraphs.join('');
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
  const scheduledEventTriggerRule = panel ? `\n\n=== SCHEDULED EVENTS — AUTO-TRIGGER ===\nThe character sheet above has a Timeline (a "Current Day" number) and a Scheduled Events list, formatted "Day N — event name". Check them on every reply:\n\n- If Current Day lands EXACTLY on an entry's day this turn (arrives there, rather than skipping past it), that event is due right now — it must actively start happening in THIS reply, on your own initiative, no matter what the player was doing or talking about. Don't wait for the player to ask, bring it up, or go looking for it — the story comes to them instead: someone arrives to fetch them, a name gets called, a bell rings, a door opens, whatever fits the event and the scene. Work it in naturally even if it interrupts or redirects what the player was mid-action on.\n\n- A Scheduled Events entry can never be skipped past, by any amount, for any stated reason — the app's own code enforces this at the data level and will not let Current Day cross a still-upcoming entry's day; a time-skip requested far beyond it (a week, a month, a year, however it's phrased) still lands exactly on that entry's day instead of wherever was asked for. So never narrate a bigger jump than that, and never narrate an entry as "missed" or skipped — it always actually happens, right when Current Day reaches it.\n\n- If more than one entry is due on the same day, surface the most pressing one first. This all happens inside the one reply you're already writing right now, in response to the player's own message or Forward tap — never as a separate, additional reply of your own; you only ever get to speak once per player turn, exactly like any other reply. A Scheduled Events entry is permanent and never something you remove — once it happens, just keep narrating forward; the entry itself stays on the sheet (the app dims it automatically once its day has passed).` : '';
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
    // The very first thing shown for a brand-new world is a recap of what the player set
    // up at creation (the "World & characters" lore text) — a plain scenario card, not a
    // story beat — so they can see exactly what's been established before the AI starts
    // narrating from it. UI-only: never saved into chat[], so it doesn't shift message
    // indices, isn't sent to the AI as part of the log, and delete/regenerate/resync all
    // work exactly as before.
    renderScenarioBubble(world);
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

// Plain, non-interactive recap card shown once, right before a brand-new world's opening
// story message. Sourced straight from world.lore (whatever the player entered under
// "World & characters" at creation) — the same text worldSystemPrompt() itself uses as the
// story's ground truth — so what the player sees matches what the AI was actually given.
// Not part of chat[]: no long-press menu, no chat index, never reaches the AI as a log line.
function renderScenarioBubble(world){
  const wrap = document.createElement('div');
  wrap.className = 'msg system scenario-intro';
  const loreHtml = (world.lore && world.lore.trim())
    ? formatStoryText(world.lore)
    : '<em>No setup details were given for this world — the AI will invent something fitting the name.</em>';
  wrap.innerHTML = `<div class="sys-label">📜 Scenario</div><div class="bubble">${loreHtml}</div>`;
  els.log.appendChild(wrap);
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
  // Fusion naming prompt (see 3.11 in script_saal.js): checked on whichever message renders
  // last, regardless of role — a fusion can become pending right after a normal story ('ai')
  // reply, not only after summoning the System, so this can't be gated to role==='system' the
  // way attachSystemToolsPanel is above.
  if(isLast) attachFusionPromptIfPending(wrap);
  if(pin) pinToBottomAfterRender();
}

// ---------- Fusion naming — in-chat picker for a newly-fused Skills & Abilities entry ----------
// guardSkillFusion (script_saal.js, 3.11) never trusts the background model's own guessed name
// for a freshly fused ability — it queues panel.pendingFusion (the sources + a few name options
// built from those sources' own names) instead of writing anything to the sheet. This is the UI
// half: render that queued request as a small interactive box inside the latest message bubble
// (same placement pattern as attachSystemToolsPanel's tool tiles above), and commit the player's
// choice via resolveFusionChoice once they tap an option or type their own.
async function attachFusionPromptIfPending(wrap){
  if(!state.chattingId) return;
  const worldId = state.chattingId;
  const panel = await getPanel(worldId);
  if(!panel || !panel.pendingFusion) return;
  // Never stack a second prompt (e.g. a re-render while one is already showing).
  if(document.querySelector('.fusion-prompt-wrap')) return;
  const bubble = wrap.querySelector('.bubble');
  if(!bubble) return;
  const pf = panel.pendingFusion;
  const box = document.createElement('div');
  box.className = 'fusion-prompt-wrap';
  box.style.marginTop = '10px';
  const optsHtml = (pf.nameOptions||[]).map(name =>
    `<button type="button" class="fusion-opt-btn" data-name="${escapeHtml(name)}" style="display:block;width:100%;text-align:left;margin:4px 0;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.25);background:rgba(255,255,255,0.06);cursor:pointer;">${escapeHtml(name)}</button>`
  ).join('');
  box.innerHTML = `
    <div class="fusion-prompt" style="border:1px solid rgba(255,255,255,0.2);border-radius:10px;padding:10px;">
      <div class="fusion-prompt-title" style="font-weight:600;margin-bottom:6px;">🔀 Fusing ${pf.sources.map(s=>escapeHtml(s)).join(' + ')} — name the new ability:</div>
      <div class="fusion-opt-list">${optsHtml}</div>
      <div class="fusion-custom-row" style="display:flex;gap:6px;margin-top:8px;">
        <input type="text" class="fusion-custom-input" placeholder="Or type your own name..." style="flex:1;padding:6px 8px;border-radius:8px;border:1px solid rgba(255,255,255,0.25);background:transparent;">
        <button type="button" class="fusion-custom-btn" style="padding:6px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.25);background:rgba(255,255,255,0.06);cursor:pointer;">Use this</button>
      </div>
    </div>
  `;
  bubble.appendChild(box);
  box.querySelectorAll('.fusion-opt-btn').forEach(btn=>{
    btn.onclick = ()=> resolveFusionChoice(worldId, btn.dataset.name, box);
  });
  const customInput = box.querySelector('.fusion-custom-input');
  const customBtn = box.querySelector('.fusion-custom-btn');
  const submitCustom = ()=>{
    const v = customInput.value.trim();
    if(v) resolveFusionChoice(worldId, v, box);
  };
  customBtn.onclick = submitCustom;
  customInput.addEventListener('keydown', e=>{ if(e.key === 'Enter') submitCustom(); });
}

// Commits the player's chosen name for a pending fusion: creates the actual Learning entry
// (never Skills & Abilities directly — same rule every other fused/new entry follows) tagged
// " (Fusion)", with its own freshly-minted id (genSkillId — same numbered "#N"/"(i)" scheme
// every other Skills/Learning entry uses), clears panel.pendingFusion, and swaps the picker box
// for a short confirmation in place — no new chat-log message is created, so this never touches
// story/log parsing (messageToLogLine and friends) at all.
async function resolveFusionChoice(worldId, chosenName, boxEl){
  const panel = await getPanel(worldId);
  if(!panel || !panel.pendingFusion) return; // already resolved elsewhere, or a stale/duplicate tap
  const sources = (panel.pendingFusion.sources || []).slice();
  const base = String(chosenName||'').trim().replace(/\s*\(\s*fusion\s*\)\s*$/i, '').trim();
  if(!base) return;
  const label = base + ' (Fusion)';
  if(!panel.categories) panel.categories = {};
  const learningKey = findExistingKey(panel.categories, 'Learning') || 'Learning';
  if(!panel.categories[learningKey]) panel.categories[learningKey] = { type:'kv', data:{}, ids:{} };
  const learningCat = panel.categories[learningKey];
  if(!learningCat.data || typeof learningCat.data !== 'object') learningCat.data = {};
  if(!learningCat.ids) learningCat.ids = {};
  const existingLabelKey = findExistingKey(learningCat.data, label);
  const targetLabel = existingLabelKey || label;
  // Guards against double-granting progress if this ever fires twice for the same request
  // (e.g. a stale reload racing a fresh tap) — keep whatever's already there instead of
  // resetting a real in-progress bar back down to the flat fusion starting point.
  learningCat.data[targetLabel] = learningCat.data[targetLabel] || '5%';
  learningCat.ids[targetLabel] = learningCat.ids[targetLabel] || genSkillId(panel);
  delete panel.pendingFusion;
  await savePanel(worldId, panel);
  if(boxEl){
    boxEl.innerHTML = `<div class="fusion-prompt fusion-prompt-done" style="border:1px solid rgba(255,255,255,0.2);border-radius:10px;padding:10px;">🔀 Fused ${sources.map(s=>escapeHtml(s)).join(' + ')} into <strong>${escapeHtml(targetLabel)}</strong> — now training in Learning at 5%.</div>`;
  }
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
  // longer exists — revert both against the trimmed chat before the next reply,
  // so the story doesn't contradict itself (and so anything a now-deleted message
  // added — a practiced skill's % bump, a fusion entry in Learning, an item, ... —
  // doesn't survive the delete). See revertOrResyncAfterDelete below.
  if(world) showTyping();
  try{ if(world) await queueWorldOp(world.id, ()=>revertOrResyncAfterDelete(world, chat)); }
  catch(e){ console.error('[revert after delete failed]', e); }
  finally{ if(world) hideTyping(); }
};

// Deleting a message (or regenerating, which discards the last reply) rewinds the story.
// Prefer restoring the exact pre-rewind sheet/memory from panel history (deterministic —
// see restorePanelHistoryTo in script_letter_of_records.js) over asking a background model
// to reconstruct what's still true; that history only goes as far back as this feature does,
// so fall back to the older AI-based resyncMemoryAndPanel for anything from before it existed.
async function revertOrResyncAfterDelete(world, chat){
  if(chat.length === 0){
    // Same intentional exception resyncMemoryAndPanel documents: wiping the sheet back to
    // blank here was the one path that could permanently lose Identity/Finances/Inventory/
    // etc. data outside of an explicit world delete. Leave memory/panel untouched.
    return;
  }
  const reverted = await restorePanelHistoryTo(world.id, chat.length);
  if(reverted) return;
  await resyncMemoryAndPanel(world, chat);
  // Backstop for the fallback path ONLY, run right here rather than after the queueWorldOp
  // call site — restorePanelHistoryTo (the branch above) is now exact and deterministic (see
  // the floor-snapshot fix in getPanel), so it already correctly keeps or drops every
  // Relationships entry with zero guesswork; adding a substring heuristic on top of an
  // already-correct revert would risk a false positive (someone referred to only by a
  // nickname or pronoun in what remains getting wrongly dropped even though they're still
  // legitimately on the sheet). Only reachable here, after resyncMemoryAndPanel — the actual
  // imprecise, AI-guess path this backstop exists to patch (this chat predates panel history,
  // or reached further back than the retained cap).
  try{
    const panelAfterResync = await getPanel(world.id);
    if(pruneOrphanedRelationships(panelAfterResync, chat)){
      await savePanel(world.id, panelAfterResync);
    }
  }catch(e){ console.error('[prune orphaned relationships failed]', e); }
}

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
    // batch boundary — revert against the trimmed chat so the new reply doesn't
    // generate alongside facts from the version we just threw away.
    try{ await queueWorldOp(world.id, ()=>revertOrResyncAfterDelete(world, chat)); }
    catch(e){ console.error('[revert before regenerate failed]', e); }
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

// ---------- media drawer close (kept as a safe no-op) ----------
// The send-button long-press that used to open this drawer (photo/gif/video attach) has
// been removed. This function is kept only because index.html's hardware-back-button
// handler still calls it defensively (`if(els.mediaDrawer.classList.contains('open'))
// closeMediaDrawer()`) — that branch can now never actually be true since nothing sets
// the 'open' class anymore, but keeping this here means that check stays harmless instead
// of throwing on an undefined function if it's ever reached.
function closeMediaDrawer(){
  els.mediaDrawerOverlay.style.display = 'none';
  els.mediaDrawer.classList.remove('open');
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

// ================= DEDICATED INVENTORY-ONLY PAGE — MOVED =================
// sortInventoryDisplayByStatus, paintInventoryModal, openInventoryModal, invPendingMerge,
// and the Inventory modal's open/close wiring now live in script_inventory_equip.js
// (SECTION 2 — INVENTORY), next to wireInventoryChipDrag which they call. Still reachable
// the same way (global scope) — openInventoryModal is still wired to the Inventory
// "expand" button via the click handler in renderPanelHtml/paintPanel above.


/* ################################################################################
   PART 2 — CONNECTING THE CHATROOM TO THE LETTER OF RECORDS
   Everything below is the cord between the live chat and the persistent
   character-sheet tracker: the system prompt, the update/resync pipeline, and
   the chat composer that gates a send on the pre-send claim checks. The Letter
   of Records itself — data model & schema, the merge engine, panel rendering,
   and the pre-send claim checks (checkClaimAgainstRecords etc.) sendMessage()
   below calls into — now lives in script_letter_of_records.js. Finances,
   Inventory, Equip Box, Timeline, Scheduled Events, Skills & Abilities, and
   Learning live in script_finance.js, script_inventory_equip.js, script_tase.js,
   and script_saal.js. Load order between this file and any of those doesn't
   matter. Depends on globals defined in Part 1 above and in index.html's inline
   Section 1 (storage helpers, els, askAI).

   Split into 2 sub-sections, in this order:
     2.1 CONNECTING THE CHATROOM TO THE OUTSIDE — the system prompt sent to
         the background AI model, and the update/resync pipeline
         (updatePanel, resyncMemoryAndPanel) that calls askAI after each
         turn and applies what comes back through every guard.
     2.2 INSIDE THE CHATROOM — the actual chat composer: sendMessage()
         (which gates on checkClaimAgainstRecords, defined in
         script_letter_of_records.js, before ever sending), its Send-button
         hookup, the textarea auto-resize handler, and showBackgroundWarning.
################################################################################ */

// ================================================================================
// 2.1 — CONNECTING THE CHATROOM TO THE OUTSIDE
// The system prompt sent to the background AI model on every panel update, and the
// pipeline (updatePanel, resyncMemoryAndPanel) that calls out to askAI (defined in
// Part 1 above / index.html's inline Section 1), runs the result through every
// guard, and saves the panel. This is the actual cord between the live chat and
// the Letter of Records.
// ================================================================================


const PANEL_SYS_PROMPT = `You maintain a persistent character-sheet tracker for an interactive fiction story, organized into named categories. Each category is one of: "kv" (named stat/value pairs), "list" (a growing collection), or "text" (a single free-text value). Given the recent story log and the current sheet, output ONLY a raw JSON object — no preamble, no markdown fences — describing what's genuinely new or changed since the current sheet, in this exact shape:
{"categories":{"Category Name":{"kv":{"key":"value"}},"Another Category":{"list_add":["thing"],"list_remove":["thing"]},"Status":{"text":"..."}}}

Before creating a new key within a category, always check whether an existing one already represents the same thing, and reuse its exact existing name instead of inventing a fresh synonym (e.g. if the sheet already tracks a currency as "Gold", don't later create "Money" or "Coins" for the same thing — update "Gold"). This matters most for the same countable resource being referenced repeatedly (a story's money, health, a relationship meter, etc.) — the same real-world thing must always live under one consistent name for the whole story, never split across near-duplicate keys.

You are strictly limited to the sheet's fixed set of categories — never invent a new category name, no matter what the player learns, gains, or becomes. The sheet always has these permanent categories available — Identity, Finances, Inventory, Skills & Abilities, Milestones, Relationships, Status — plus "Learning", "Timeline", and "Scheduled Events", which the app itself manages. Whatever the player learns, gains, or becomes must be filed into one of these existing categories, using the closest fit:
- A special skill, technique, spell, or innate power the character has FULLY learned or acquired and can genuinely use right now → goes straight into "Skills & Abilities" (a permanent list category, always on the sheet) — this is the definitive, ready-to-use record; nothing the character can actually do should be missing from it. "Skills & Abilities" is ONLY for powers the character's own body/mind can do — see ITEM VS POWER below for the line between this and Inventory.
- A skill or technique the character is still IN THE PROCESS of learning, not yet usable at full strength → track its progress in "Learning" (a kv category, created the moment real training begins) as a percentage — see SKILL & ABILITY PROGRESS below. Once it PASSES 90% (i.e. 91% or higher — landing exactly on 90% is not enough yet), it moves itself into "Skills & Abilities" automatically — never add it there yourself while it's still at 90% or below in Learning.
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
  - Every time the log shows the character actually practicing, studying, training, drilling, or otherwise doing focused work on an entry already in "Learning", increase it by a flat 10 percentage points (a fixed step, not a judgment call): (1) read that skill's exact current percentage on the sheet, (2) add exactly 10, (3) cap the sum at 100, (4) output that exact new total formatted as "NN%". Never invent an increase for a skill the log didn't show being practiced this turn, and never use any amount other than exactly 10. Each separate practice/study session the log shows counts once — a single log line describing several repetitions at once ("I studied it ten times over") is still only ONE session and still only a flat +10%, not +10% per repetition claimed. EXCEPTION — a "(Fusion)" entry (see FUSION above) uses exactly 5 instead of exactly 10 at every one of these steps, including the very first one that creates it — everything else about this bullet applies to it unchanged.
  - Percentages only ever go up, never down.
  - Once an entry PASSES 90% (91% or higher — reaching exactly 90% is not enough on its own), it's fully mastered — the app itself moves it out of "Learning" and into "Skills & Abilities" as a normal, permanently-usable entry. You never need to add it to "Skills & Abilities" yourself or keep re-outputting it in "Learning" afterward.
  - A skill can be actively used by the character at any percentage while it's still in "Learning" — write the story so its power, reliability, and control genuinely reflect that percentage (low: weak, clumsy, unreliable, or costly to pull off; mid: workable but imperfect; near 100%: nearly full power). This is guidance for how you narrate the skill being used, not something you output on the sheet.
  - A power, jutsu, or technique the character gains fully-formed all at once — no training montage, e.g. something granted by a "system"/status-window mechanic, something taught and mastered in a single explicit scene — skips "Learning" entirely and goes straight into "Skills & Abilities" as a normal, untagged entry.
  - INNATE POWER / AFFINITY — world-creation only: entries suffixed " (Innate Power)" or " (Affinity)" are reserved and are set exactly once, at world creation, from the world's own setup text. You never add, rename, retag, or remove one of these during live play, no matter what the story narrates — not even a bloodline power "awakening" or a dormant affinity being "discovered" partway through the story. If the story shows something like that happening, log it as a normal Skills & Abilities entry with no tag (or route it through "Learning" first if it's shown being trained into, per SKILL & ABILITY PROGRESS above) — never with " (Innate Power)" or " (Affinity)" attached.
  - FUSION — combining two owned entries into a new one: if the player's own message both (a) clearly asks to fuse/combine/merge something and (b) names, in full, two of the character's own already-owned "Skills & Abilities" entries (this includes an "(Innate Power)" or "(Affinity)" entry combined with a regular skill — those can be a fusion INPUT even though they can never be created mid-play), create a new "Learning" entry for the fused result at "5%" (fused entries start and grow at half the normal rate — see the EXCEPTION in SKILL & ABILITY PROGRESS below), named to reflect what the fusion actually produces, suffixed " (Fusion)" (exact wording, parentheses included). Fusion NEVER consumes its sources — never list_remove either source entry; both stay exactly as they were, fully owned and usable, alongside the new fused entry. A "(Fusion)" entry is still just a "Learning" entry in every other respect (it graduates into "Skills & Abilities" the same way once it passes 90%), except that it trains twice as slowly — see the next bullet.
- ITEM VS POWER — where a supernatural thing goes: "Skills & Abilities"/"Learning" are ONLY for something the character's own body or mind can do — a power, jutsu, spell, technique, magic circle/rune/mark/sigil the character can invoke, superhuman strength/speed/senses, regeneration, elemental control, or any other ability that still belongs to the character even with empty hands. A physical object — a magic sword, an enchanted ring, a scroll, a potion, a wand, a rune-inscribed tablet, a "system"-granted device — is an ITEM and belongs in "Inventory" instead, no matter how supernatural or powerful its effect is; the power lives in the object, not in the character, so it stays an Inventory entry (optionally with a status suffix noting what it does, e.g. "Ring of Flame — grants fire resistance while worn") rather than a Skills & Abilities entry. This split holds even when the item is what's teaching the character a power:
  - Buying, finding, or receiving a skill book, scroll, manual, or any other item that merely describes or contains a power → that's an ACQUISITION, handled exactly like any other item: it goes into "Inventory" as a normal entry (per COMPLETED TRANSACTIONS ONLY / cross-category rules above). Do NOT add anything to "Learning" or "Skills & Abilities" just because the item was acquired.
  - Only once the log shows the character actually starting to use/study/train with that item (reading it, following its instructions, beginning practice) does a "Learning" entry get created for the power itself, per SKILL & ABILITY PROGRESS above — a brand-new entry, at "10%", named after the power/skill, not after the book. The book/scroll itself stays in Inventory throughout, completely unaffected — studying from it doesn't consume it, change its entry, or transfer any identity to the Learning/Skills & Abilities entry it produces. They are two separate sheet entries, in two separate categories, for as long as both exist.
- If a memory log is provided below the current sheet, it's given only so you can catch things the recent-log window might have missed or spot a sheet value that's gone stale (e.g. the memory mentions a currency change the sheet never applied). Use it only to correct or fill in a fact that's genuinely supported by the story so far — never invent or add something sourced only from the memory summary that isn't itself grounded in an explicit event.
- TIME & DATED EVENTS: track elapsed time with a "Timeline" category: a kv entry {"Current Day":"N"} that only ever counts UP. Scheduled Events (the list of upcoming dated entries, formatted "Day N — event name") is a READ-ONLY list as far as you're concerned — you never add a new entry to it yourself, no matter how clearly the world's setup text or the log names a date for something, and you never remove one either, even after it's happened; the player manages that list entirely through their own tool, and an entry is meant to stay on the sheet permanently (the app itself dims it once its day has passed). A still-upcoming entry can never be skipped past — the app's own code clamps any "Current Day" value you propose so it never crosses one, no matter how far ahead a time-skip is requested. Your only job with an existing Scheduled Events entry is to notice when Current Day reaches it and narrate it actually happening (see SCHEDULED EVENTS — AUTO-TRIGGER below) — never to list_add or list_remove anything in that category.
  - A time-skip counts no matter which side of the conversation states it — the player saying it ("I rest for the night", "let's skip ahead two days", "after two days, I go back") counts exactly the same as the narrator/story text saying it. Don't only watch the narrator's lines.
  - Read the actual phrase for its real length and convert it precisely: "a night" / "overnight" / "the next morning" / "til morning" = +1 day. "the next day" = +1 day. "two days" / "two days later" / "a couple days" = +2 days. "a few days" = +3 days (unless a more specific number is given, in which case use that number instead). "a week" = +7 days. Always prefer an explicit number stated in the log over any default above.
  - Every time the log shows time passing this way, work out exactly how many days passed and increase "Current Day" by that exact amount — the same strict arithmetic requirement as currency, not a vibe. Never leave "Current Day" unchanged when the log shows time passing, and never invent days passing that the log doesn't support.
  - Once "Current Day" reaches an entry's day exactly, that event is due, and this reply must show it actually happening (see SCHEDULED EVENTS — AUTO-TRIGGER). A time-skip can never carry "Current Day" past a still-upcoming entry — the app clamps it to that entry's day instead, however far ahead the skip was requested — so you will never see a reason to narrate one as missed or skipped; treat the clamped day as what actually happened and narrate the event starting, not the bigger jump that was asked for. The entry itself is never removed from Scheduled Events once it happens — it's a permanent record, so just narrate the outcome and move on.
- INVENTORY ITEM STATUS: an inventory item may optionally carry its current state as a suffix, using an em dash specifically — " — " — never a plain hyphen (item names can legitimately contain hyphens, e.g. "bone-wood half-mask", so a bare "-" can't be trusted as a separator). Format: "<item>" or "<item> — <status>", e.g. "Pale bone-wood half-mask — Equipped", "0 explosive tags — All used", "Steel kunai — Sheathed", "Blade — Poisoned" (the log showed the blade being dipped in poison). Only attach a status when the log actually shows that state (put on, worn, drawn, holstered, broken, emptied, hidden, sealed, poisoned, sharpened, etc.) — most items don't need one and should stay as plain entries; don't invent a status just to have one. When an item's state changes, ALWAYS use the same list_remove(old exact text)+list_add(corrected text) pattern as any other sheet correction, keeping the item's name itself exactly as it already appears on the sheet — never invent a differently-worded new name for the same physical item (e.g. never add "Poisoned Blade" as if it were a separate object from the existing "Blade"; correct "Blade" itself to "Blade — Poisoned"). A quantity dropping to 0 is not automatically "used up" — only add that wording if the log itself shows the last one being used.
  - "Remove" and "take off" mean UNEQUIPPING, never discarding — the item stays in Inventory (just no longer worn/held), so this is a status change: list_remove the old entry + list_add the same item with an appropriate status (e.g. "Boots — Removed" or drop the status back to none if that fits better).
  - An item leaves Inventory ENTIRELY — list_remove with NO matching list_add — only when the log shows it actually being gotten rid of: thrown away/out, left behind, dropped, tossed, discarded, given away, sold, traded away, abandoned, lost, or destroyed. That's a different action from unequipping and must never be confused with it.
- RELATIONSHIPS: a kv category — key is the person's name, value is their CURRENT standing, kept short.
  - Only create an entry once that character has actually appeared or been named on-page in the log itself — someone showing up, speaking, being addressed, or being directly interacted with. Never create an entry off the world's setup/lore text alone before the character has actually appeared in the story, and never off a passing reference by someone else (a bystander mentioning a name in dialogue doesn't count — the named person must actually appear/act on-page themselves).
  - The value's LEADING clause (everything before the first comma/semicolon/period) must always be a short standing/nature label ONLY — 1-4 words, e.g. "Friendly", "Enemy", "Distrustful", "Father", "Father (Friendly)", "Brother (Enemy)" — never a sentence, and never how the relationship started or a narrated description. This leading clause is the only part shown on the character sheet at a glance; put any further context, history, or detail AFTER the first comma if you want it recorded (e.g. "Friendly, warmed up after she treated his wound") — never let the short label itself run long or turn into prose.
  - Update the SAME key's value (never add a duplicate key for the same person) whenever the story shows the relationship's standing actually shift — the leading label changes to reflect the new standing, and new detail can be appended after the comma; don't keep restating the old label as history text.
- CROSS-CATEGORY CONSISTENCY: categories are not independent — if one update implies a change to another, both MUST be included in the SAME response. Concretely: if you add a Milestones entry describing an item being purchased/received/looted/gifted, that exact item must also get a list_add in Inventory (or wherever such items are tracked) in this same JSON output — never one without the other. The same applies to a skill/technique being learned (Milestones + Skills & Abilities), a title being granted (Milestones + Identity/Titles), a currency amount being earned, paid, or received (Milestones + Finances — and if it's a purchase, the Inventory list_add for the item bought too), a time-skip or day passing (Milestones + Timeline's "Current Day", per TIME & DATED EVENTS above), and a dated Scheduled Events entry actually occurring in the log (add a Milestones entry for it — never a list_remove in Scheduled Events itself, per TIME & DATED EVENTS above). Before finalizing your output, re-read every new Milestones entry you're about to add and check: does the thing it describes (an item, skill, title, relationship change, currency change, day advancing, or scheduled event occurring) already have — or now get — a matching entry in its own category in this same response (Scheduled Events itself excepted, since that category is never written to by you)? If not, add it now. A milestone recording an acquisition, payment, or time-skip with no matching entry anywhere else on the sheet is an incomplete, invalid update.

If truly nothing new or changed happened in the recent log, output exactly {"categories":{}} and nothing else.`;


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
    guardItemVsPowerRouting(data);
    guardSkillFusion(data, panel, lastPlayerMsg ? lastPlayerMsg.text : '');
    guardInnateAffinityChatRestriction(data);
    guardUngraduatedAbilityInventory(data, panel, recent);
    guardStackableItems(data, panel, lastPlayerMsg ? lastPlayerMsg.text : '', recent);
    guardDuplicationMath(data, panel, recent);
    guardInventoryEquipStatus(data, panel, lastPlayerMsg ? lastPlayerMsg.text : '');
    guardInventoryRenameBypass(data, panel, lastPlayerMsg ? lastPlayerMsg.text : '', recent);
    guardInventoryDiscard(data, panel, lastPlayerMsg ? lastPlayerMsg.text : '');
    ensureTimelineDayFallback(data, panel, recent, world.id);
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
  const panelPrompt = `Most recent part of the story log (this reflects the story after a rewind/regenerate — some previously-recorded facts may no longer have happened; anything from earlier than this excerpt is NOT included here because the sheet below already has it — do not treat its absence from this excerpt as it having been undone):\n${convo}\n\nCurrent character sheet (from before this rewind):\n${panelToText(oldPanel)}\n\nMemory log (for consistency-checking only):\n${freshMemory || '(none yet)'}\n\nGiven this excerpt, what on the sheet is now specifically wrong (from a branch that no longer happened) and needs correcting, and what new facts (if any) should be added? This explicitly includes removing (via list_remove) a Milestones entry, or a Relationships entry, whose triggering event or introduction is gone from this rewound story and isn't otherwise corroborated by the memory log above — a milestone or relationship that only ever existed on a branch that no longer happened must not survive the rewind just because it's already sitting on the sheet. Keep everything else on the sheet exactly as-is by default — only output categories that actually need a change.`;
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
    // Grounding text is the full resync log window (convo), not just the player's own lines —
    // a legitimate post-rewind correction to a skill's percentage should be traceable to
    // *something* in the recent story text (player or narration) naming that skill, even
    // though it doesn't need an explicit "I studied X" phrase the way normal forward progress
    // does. This stops the resync path from accepting a percentage with zero textual basis.
    guardSkillProgress(data, oldPanel, playerTextInWindow, true, convo);
    guardSkillGraduation(data, oldPanel);
    guardItemVsPowerRouting(data);
    // isResync=true: a genuinely new fusion can never be armed mid-resync (see guardSkillFusion's
    // own comment) — same conservative "never invent" stance guardSkillProgress's fusionArmed
    // already takes for the identical reason. guardSkillFusion still runs to redirect/strip
    // anything mis-shaped in what the resync proposed.
    guardSkillFusion(data, oldPanel, playerTextInWindow, true);
    guardInnateAffinityChatRestriction(data);
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


// ================================================================================
// 2.2 — INSIDE THE CHATROOM
// The actual chat composer: sendMessage() (gates on checkClaimAgainstRecords, defined
// in THIS file, before a message is ever sent), its Send-button
// hookup, the textarea auto-resize handler, and showBackgroundWarning — the one place
// here that reaches into the live chat log DOM. Currency, inventory, ability, timeline,
// and scheduled-events logic all live in script_finance.js, script_inventory_equip.js,
// script_tase.js, and script_saal.js (see the MOVED banners in 2.3 below), including the
// claim-checking pipeline sendMessage() gates on.
// ================================================================================


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
