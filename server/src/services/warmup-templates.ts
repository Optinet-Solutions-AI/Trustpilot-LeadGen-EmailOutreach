/**
 * Warmup email template bank.
 * Realistic business conversations that look like normal human exchanges.
 * Each template has a starter (A→B) and a reply (B→A).
 * Varied enough that Google sees natural conversation diversity.
 */

export interface WarmupTemplate {
  subject: string;
  body: string;          // sent by A
  replyBody: string;     // sent by B in response
}

export const WARMUP_TEMPLATES: WarmupTemplate[] = [
  {
    subject: 'Quick question about the proposal',
    body: `Hi,\n\nHope you're doing well. I wanted to follow up on the proposal we discussed last week — have you had a chance to look it over?\n\nLet me know if you need any clarifications. Happy to jump on a call if easier.\n\nThanks,`,
    replyBody: `Hi,\n\nYes, I had a look — it looks solid overall. I have a couple of minor points I'll send over by end of day.\n\nThanks for following up!\n\nBest,`,
  },
  {
    subject: 'Re: Project update',
    body: `Hey,\n\nJust a quick update — the first phase wrapped up yesterday and everything's on track. We're moving into phase two next week.\n\nAnything from your side I should be aware of before we kick off?\n\nCheers,`,
    replyBody: `Great to hear, thanks for the update! Nothing urgent from my side. Looking forward to seeing phase two progress.\n\nKeep me posted.\n\nBest,`,
  },
  {
    subject: 'Following up on our last conversation',
    body: `Hi there,\n\nI wanted to follow up on what we talked about last time. Have you had a chance to think it over?\n\nNo rush at all — just wanted to check in and see if there's anything I can help move forward.\n\nBest regards,`,
    replyBody: `Thanks for checking in! I've been meaning to get back to you. Let's catch up later this week — does Thursday work for a quick call?\n\nTalk soon,`,
  },
  {
    subject: 'Checking in',
    body: `Hi,\n\nHope things are going well on your end. I just wanted to check in and see how everything's been progressing.\n\nFeel free to reach out if there's anything you need from me.\n\nWarm regards,`,
    replyBody: `Things are going well, thanks for asking! It's been a busy few weeks but we're making good progress. How about on your end?\n\nTalk soon,`,
  },
  {
    subject: 'Quick thought on the timeline',
    body: `Hey,\n\nI was going over the timeline and wanted to flag something — the mid-month deadline might be tight given the current workload. Would it be possible to push it by a few days?\n\nLet me know your thoughts.\n\nThanks,`,
    replyBody: `That makes sense — pushing a few days is fine. Let's say the 18th instead of the 15th. Does that work for you?\n\nCheers,`,
  },
  {
    subject: 'Thanks for the meeting yesterday',
    body: `Hi,\n\nJust wanted to say thanks for taking the time yesterday — it was a really useful session. I came away with a lot of clarity on the next steps.\n\nI'll send over the notes and action items by tomorrow morning.\n\nBest,`,
    replyBody: `Likewise, it was a great conversation! Looking forward to the notes. Let me know if you need anything from my side in the meantime.\n\nBest,`,
  },
  {
    subject: 'Feedback on the draft',
    body: `Hi,\n\nI've had a chance to go through the draft and overall it looks really good. A few small suggestions attached — nothing major, mostly just wording tweaks.\n\nGreat work on this.\n\nBest,`,
    replyBody: `Really appreciate the detailed feedback — those tweaks make a lot of sense. I'll incorporate them and send over the updated version by end of day.\n\nThanks again,`,
  },
  {
    subject: 'Quick question on the numbers',
    body: `Hey,\n\nI was reviewing the figures and had a question on the Q3 projection — the growth rate looks a bit optimistic compared to Q2. Is that accounting for the new market entry?\n\nJust want to make sure we're aligned before the presentation.\n\nThanks,`,
    replyBody: `Good catch — yes, that projection includes the new market. I can add a footnote to make it clearer. Will send the updated slide over shortly.\n\nAppreciate you flagging it.\n\nBest,`,
  },
  {
    subject: 'Touching base',
    body: `Hi,\n\nIt's been a while since we connected — hope all is well. I've been meaning to reach out and see if there's anything new on your end worth catching up on.\n\nLet me know if you'd like to set up a quick call.\n\nBest regards,`,
    replyBody: `Great to hear from you! Yes, it has been a while. Things are moving well here. A quick catch-up call sounds good — I'll send over a few slots that work for me.\n\nLooking forward to it,`,
  },
  {
    subject: 'Update on the deliverable',
    body: `Hi,\n\nWanted to give you a heads up that the deliverable is almost ready — should be with you by end of week. We ran into a small snag earlier but it's resolved now.\n\nLet me know if the timeline still works.\n\nThanks,`,
    replyBody: `Thanks for the heads up — end of week works perfectly. No worries at all on the delay. Looking forward to reviewing it.\n\nTalk soon,`,
  },
  {
    subject: 'Can you review this before I send?',
    body: `Hey,\n\nBefore I send this out, would you mind giving it a quick once-over? Just want to make sure the tone is right and I haven't missed anything obvious.\n\nWon't take more than a few minutes. Appreciate it.\n\nThanks,`,
    replyBody: `Of course! Just had a look — it reads really well. One minor thing: the second paragraph could be a bit shorter but it's not critical. Go ahead and send it.\n\nGood luck!`,
  },
  {
    subject: 'Confirming for next week',
    body: `Hi,\n\nJust confirming we're still on for next week. Same time and place as before?\n\nLet me know if anything's changed on your end.\n\nBest,`,
    replyBody: `Yes, still on! Same time works. Looking forward to it. I'll send a calendar invite to lock it in.\n\nSee you then,`,
  },
  {
    subject: 'Small update',
    body: `Hey,\n\nNothing urgent — just wanted to flag a small change on our end. We've shifted the internal deadline slightly so the handoff to you will now be Wednesday instead of Monday.\n\nHope that doesn't cause any issues?\n\nThanks,`,
    replyBody: `Wednesday works just fine — thanks for the heads up. That actually gives us a bit more breathing room on our side too.\n\nAppreciate it,`,
  },
  {
    subject: 'Sharing a resource you might find useful',
    body: `Hi,\n\nI came across this piece earlier and thought you might find it useful given what we discussed last time. Nothing to action — just thought it was worth sharing.\n\nLet me know what you think.\n\nBest,`,
    replyBody: `Thanks for sharing — this is actually really relevant. I'll pass it along to the team as well. Always appreciate you thinking of me.\n\nCheers,`,
  },
  {
    subject: 'One more thing',
    body: `Hi,\n\nSorry to follow up again so soon, but I realised I forgot to mention one thing in my last message — we'll need the signed copy back before the end of the month for our records.\n\nThanks for bearing with me!\n\nBest,`,
    replyBody: `Not at all — good reminder! I'll get that sorted and send it over by Friday at the latest.\n\nThanks,`,
  },
];

/** Pick a random template from the bank */
export function randomTemplate(): WarmupTemplate {
  return WARMUP_TEMPLATES[Math.floor(Math.random() * WARMUP_TEMPLATES.length)];
}

/** Generate a short unique warmup UID (8 chars, alphanumeric) */
export function generateWarmupUid(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Random delay in ms between 5 and 30 minutes */
export function randomPhaseDelay(): number {
  const minMs = 5  * 60 * 1000;
  const maxMs = 30 * 60 * 1000;
  return minMs + Math.floor(Math.random() * (maxMs - minMs));
}
