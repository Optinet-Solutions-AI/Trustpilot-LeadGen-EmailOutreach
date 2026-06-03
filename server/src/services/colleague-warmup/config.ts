/**
 * Static configuration for the colleague-network warmup.
 *
 * Single source of truth for the colleague recipient list, the neutral
 * admin-style subject bank, and the canonical body template. Inlined as
 * TS constants rather than JSON files so the build pipeline doesn't need
 * to copy assets into dist/ for `node dist/server.js` to find them.
 *
 * Edit and redeploy to change the list.
 */

export interface Recipient {
  email: string;
  first_name: string;
}

export const RECIPIENTS: Recipient[] = [
  { email: 'lkkolokoy@gmail.com', first_name: 'Leo' },
  { email: 'ianjaybilagantol@gmail.com', first_name: 'Ian Jay' },
  { email: 'pedrazarap901@gmail.com', first_name: 'Raphael' },
  { email: 'cathylynmaybilagantolsolano@gmail.com', first_name: 'Cathylyn' },
  { email: 'polpolroell@gmail.com', first_name: 'Roell' },
  { email: 'devotion0073@yahoo.com', first_name: 'Alberto' },
  { email: 'jenzjavelona0911@gmail.com', first_name: 'Jenelyn' },
  { email: 'Kristilleanncalimpusan@gmail.com', first_name: 'Kristille Ann' },
  { email: 'jayra.nmellomida@gmail.com', first_name: 'Kimberly' },
  { email: 'Scrapecoco23@gmail.com', first_name: 'Khent' },
  { email: 'jhonquilly@gmail.com', first_name: 'John' },
  { email: 'rootsjahirie@gmail.com', first_name: 'Khristian' },
  { email: 'cirilosere51@gmail.com', first_name: 'Cirilo' },
  { email: 'faviola.edradan@gmail.com', first_name: 'Faviola' },
  { email: 'yourdesignspecialistph@gmail.com', first_name: 'Mario' },
  { email: 'kailegilbero@gmail.com', first_name: 'Kaile' },
  { email: 'raed_khoury87@hotmail.com', first_name: 'Raed' },
  { email: 'czlailani@gmail.com', first_name: 'Lailani' },
  { email: 'abanganfel@gmail.com', first_name: 'Fel' },
  { email: 'sonethzanoria10@gmail.com', first_name: 'Soneth' },
  { email: 'libradillarandyjames@gmail.com', first_name: 'Randy James' },
  { email: 'irb.rabasto@gmail.com', first_name: 'Iziah-Revo' },
  { email: 'karenpamonag@yahoo.com', first_name: 'Karen' },
  { email: 'conchamichelle00@gmail.com', first_name: 'Michelle' },
  { email: 'andalescaren05@gmail.com', first_name: 'Caren' },
  { email: 'anascojas@gmail.com', first_name: 'Ana' },
];

export const SUBJECTS: string[] = [
  'Welcome to your new account',
  'Account Activation Update',
  'Review your recent account activity',
  'Important: Notification regarding your account',
  'New Account Activity Details',
  'Confirm your account registration',
  'Security notice: Account login review',
  'Status update on your account',
  'Your account setup is complete',
  'Profile review summary',
  'Account verification required',
  'Recent activity on your account',
  'Notification: Account settings updated',
  'Your sign-up was successful',
  'Action needed: Confirm your account',
  'Weekly account activity report',
  'Account access summary',
  'Your account is ready',
  'Recent login activity review',
  'Account confirmation pending',
  'Activity report for your account',
  'Notification: New session detected',
  'Please review your account preferences',
  'Account update notification',
  'Your account: latest updates',
  'Sign-in activity review',
  'Account dashboard reminder',
  'Notification regarding sign-up',
  'Your account at a glance',
  'Reminder: Review your activity',
];

export const BODY_TEMPLATE =
  '<p>Hi {{recipient_name}},</p>\n' +
  '<p>Thank you for signing up with us. Please log in to your account and review your activity.</p>\n' +
  '<p>Regards,<br>{{sender_from_name}}</p>';

/** Notifier recipient — receives the daily plan preview. */
export const CATHY_NOTIFICATION_EMAIL = 'cathylyn@optinetsolutions.com';

/** Notifier sender — must exist in email_accounts with valid creds. */
export const NOTIFIER_FROM_EMAIL = 'jhonquillycampilanan@gmail.com';

/** Manila workday window. 24h clock, inclusive start, exclusive end. */
export const WORKDAY = {
  timeZone: 'Asia/Manila',
  startHour: 15, // 3pm
  endHourExclusive: 22, // 10pm
} as const;

/** Per-sender cadence between sends (uniformly jittered in this range, ms). */
export const SENDER_CADENCE_MS = {
  min: 45 * 60 * 1000,
  max: 50 * 60 * 1000,
} as const;

/**
 * Daily volume ramp per sender.
 *
 * Day 1 = base sends per sender. Each subsequent Mon-Fri WORKDAY adds `step`
 * to the daily target until `max` is reached.
 *
 * Workday 1 = first workday on or after COLLEAGUE_WARMUP_START_DATE.
 * If today is before COLLEAGUE_WARMUP_START_DATE (or it's unset), the
 * scheduler does NOT plan or dispatch.
 *
 * Example with base=5, step=1, max=20:
 *   Workday 1: 5,  Workday 2: 6, ..., Workday 16+: 20
 */
export const VOLUME_RAMP = {
  base: 5,
  step: 1,
  max: 20,
} as const;
