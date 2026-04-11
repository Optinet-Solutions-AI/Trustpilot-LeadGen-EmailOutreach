export const COUNTRIES = [
  { code: '', name: 'All Countries' },
  { code: 'US', name: 'United States' }, { code: 'GB', name: 'United Kingdom' },
  { code: 'AU', name: 'Australia' }, { code: 'CA', name: 'Canada' },
  { code: 'DE', name: 'Germany' }, { code: 'FR', name: 'France' },
  { code: 'NL', name: 'Netherlands' }, { code: 'DK', name: 'Denmark' },
  { code: 'SE', name: 'Sweden' }, { code: 'NO', name: 'Norway' },
  { code: 'FI', name: 'Finland' }, { code: 'IT', name: 'Italy' },
  { code: 'ES', name: 'Spain' }, { code: 'BR', name: 'Brazil' },
];

export const CATEGORIES = [
  { slug: '', name: 'All Categories' },
  { slug: 'gambling', name: 'Gambling (all)' },
  { slug: 'casino', name: 'Casino' },
  { slug: 'online_casino_or_bookmaker', name: 'Online Casino / Bookmaker' },
  { slug: 'online_sports_betting', name: 'Online Sports Betting' },
  { slug: 'betting_agency', name: 'Betting Agency' },
  { slug: 'bookmaker', name: 'Bookmaker' },
  { slug: 'gambling_service', name: 'Gambling Service' },
  { slug: 'gambling_house', name: 'Gambling House' },
  { slug: 'off_track_betting_shop', name: 'Off-Track Betting Shop' },
  { slug: 'lottery_vendor', name: 'Lottery Vendor' },
  { slug: 'online_lottery_ticket_vendor', name: 'Online Lottery Vendor' },
  { slug: 'lottery_retailer', name: 'Lottery Retailer' },
  { slug: 'lottery_shop', name: 'Lottery Shop' },
  { slug: 'gambling_instructor', name: 'Gambling Instructor' },
  { slug: 'gaming', name: 'Gaming (all)' },
  { slug: 'gaming_service_provider', name: 'Gaming Service Provider' },
  { slug: 'bingo_hall', name: 'Bingo Hall' },
  { slug: 'video_game_store', name: 'Video Game Store' },
  { slug: 'game_store', name: 'Game Store' },
  { slug: 'bank', name: 'Bank' },
  { slug: 'insurance_agency', name: 'Insurance Agency' },
  { slug: 'money_transfer_service', name: 'Money Transfer' },
  { slug: 'electronics_technology', name: 'Electronics & Technology' },
  { slug: 'travel_vacation', name: 'Travel & Vacation' },
];

// Only Instantly-accepted IANA timezones
export const TIMEZONES = [
  { value: 'America/Detroit',     label: 'US Eastern — New York, Miami (EST/EDT)' },
  { value: 'America/Chicago',     label: 'US Central — Chicago, Dallas (CST/CDT)' },
  { value: 'America/Boise',       label: 'US Mountain — Denver, Phoenix (MST/MDT)' },
  { value: 'America/Anchorage',   label: 'US Alaska (AKST/AKDT)' },
  { value: 'America/Bogota',      label: 'Colombia / Lima (UTC-5, no DST)' },
  { value: 'America/Sao_Paulo',   label: 'Brazil / Buenos Aires (UTC-3)' },
  { value: 'Europe/Belfast',      label: 'UK / Ireland — London, Dublin (GMT/BST)' },
  { value: 'Europe/Belgrade',     label: 'Central Europe — Paris, Berlin, Amsterdam (CET/CEST)' },
  { value: 'Europe/Bucharest',    label: 'Eastern Europe — Athens, Kyiv (EET/EEST)' },
  { value: 'Asia/Dubai',          label: 'Gulf — Dubai, Abu Dhabi (UTC+4)' },
  { value: 'Asia/Kolkata',        label: 'India (IST, UTC+5:30)' },
  { value: 'Asia/Hong_Kong',      label: 'Philippines / Hong Kong (UTC+8)' },
  { value: 'Asia/Brunei',         label: 'Singapore / Malaysia (UTC+8)' },
  { value: 'Australia/Melbourne', label: 'Sydney / Melbourne (AEST/AEDT)' },
  { value: 'Pacific/Auckland',    label: 'New Zealand (NZST/NZDT)' },
];

export const HOURS = [
  '06:00','07:00','08:00','09:00','10:00','11:00',
  '12:00','13:00','14:00','15:00','16:00','17:00',
  '18:00','19:00','20:00',
];

export const DAY_LABELS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

export interface SendingSchedule {
  timezone: string;
  startHour: string;
  endHour: string;
  days: number[];
  dailyLimit: number;
}

export const DEFAULT_SCHEDULE: SendingSchedule = {
  timezone: 'America/Detroit',
  startHour: '09:00',
  endHour: '17:00',
  days: [1, 2, 3, 4, 5],
  dailyLimit: 50,
};
