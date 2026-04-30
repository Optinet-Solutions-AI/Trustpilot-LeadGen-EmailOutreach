// Curated list of the most-trafficked disposable / temp-mail / honeypot domains.
// Anything matched here is rejected at Stage 2 — they are not legitimate
// businesses and any reply is statistically a spam-trap or honeypot.

export const DISPOSABLE_DOMAINS = new Set<string>([
  // Mailinator family
  'mailinator.com', 'mailinator.net', 'mailinator2.com',
  // Guerrilla Mail
  'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org',
  'guerrillamail.biz', 'guerrillamail.de', 'sharklasers.com',
  'grr.la', 'pokemail.net', 'spam4.me',
  // 10MinuteMail family
  '10minutemail.com', '10minutemail.net', '10minutemail.org',
  '10minutemail.de', '20minutemail.com',
  // Throwaway / Yopmail
  'yopmail.com', 'yopmail.net', 'yopmail.fr',
  'throwawaymail.com', 'throwawaymails.com',
  'temp-mail.org', 'temp-mail.io', 'tempmail.com', 'tempmail.net',
  'tempmailaddress.com', 'tempmailo.com', 'tempinbox.com',
  // Dispostable / Mohmal
  'dispostable.com', 'mohmal.com', 'mohmal.tech',
  // Mailnesia / Mintemail / Spamgourmet
  'mailnesia.com', 'mintemail.com', 'spamgourmet.com',
  'spamgourmet.net', 'spamgourmet.org',
  // Trash-mail / Maildrop
  'trash-mail.com', 'trashmail.com', 'trashmail.net',
  'maildrop.cc', 'maildrop.zone', 'mail-temp.com',
  // EmailOnDeck / GetNada / Inboxbear
  'emailondeck.com', 'getnada.com', 'inboxbear.com',
  // FakeMail
  'fakeinbox.com', 'fakemailgenerator.com', 'fake-mail.net',
  // Other prevalent free disposable
  'tempr.email', 'discard.email', 'discardmail.com',
  'mailcatch.com', 'mt2014.com', 'mvrht.net',
  'nada.email', 'nwytg.net', 'opayq.com',
  'rcpt.at', 'rmqkr.net', 'shitmail.org',
  'spambog.com', 'spambog.de', 'spambog.ru',
  'thedirhq.info', 'tutye.com', 'wegwerfemail.de',
  'wegwerfmail.de', 'wegwerfmail.info', 'wegwerfmail.net',
  'wegwerfmail.org', 'zoemail.com', 'zoemail.org',
]);

export function isDisposableDomain(domain: string): boolean {
  return DISPOSABLE_DOMAINS.has(domain.toLowerCase());
}
