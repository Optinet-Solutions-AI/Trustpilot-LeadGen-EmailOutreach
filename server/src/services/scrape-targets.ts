// Mirrors the COUNTRIES and CATEGORIES arrays in
// frontend/src/components/ScrapeForm.tsx. Single source of truth for
// the nightly scheduler. Keep these two lists in sync when adding new
// targets (manual UI and nightly batch share this matrix).

export const COUNTRIES: string[] = [
  'AU', 'AT', 'BR', 'CA', 'DK', 'FI', 'FR', 'DE',
  'IT', 'NL', 'NO', 'ES', 'SE', 'AE', 'GB', 'US',
];

export const CATEGORIES: string[] = [
  // Gambling
  'gambling',
  'casino',
  'online_casino_or_bookmaker',
  'online_sports_betting',
  'betting_agency',
  'bookmaker',
  'gambling_service',
  'gambling_house',
  'off_track_betting_shop',
  'lottery_vendor',
  'online_lottery_ticket_vendor',
  'lottery_retailer',
  'lottery_shop',
  'gambling_instructor',
  // Gaming
  'gaming',
  'gaming_service_provider',
  'bingo_hall',
  'video_game_store',
  'game_store',
  // Finance
  'money_insurance',
  'investing_wealth',
  'investment_service',
];
