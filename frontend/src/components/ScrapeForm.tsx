import { useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { ScrapeParams } from '../types/scrape';

const COUNTRIES = [
  { code: 'US', name: 'United States' }, { code: 'GB', name: 'United Kingdom' },
  { code: 'AU', name: 'Australia' }, { code: 'CA', name: 'Canada' },
  { code: 'DE', name: 'Germany' }, { code: 'FR', name: 'France' },
  { code: 'NL', name: 'Netherlands' }, { code: 'DK', name: 'Denmark' },
  { code: 'SE', name: 'Sweden' }, { code: 'NO', name: 'Norway' },
  { code: 'FI', name: 'Finland' }, { code: 'IT', name: 'Italy' },
  { code: 'ES', name: 'Spain' }, { code: 'BR', name: 'Brazil' },
];

const CATEGORIES = [
  // ── Gambling ─────────────────────────────────────────────────
  'gambling',                      // Gambling (parent — broadest)
  'casino',                        // Casino
  'online_casino_or_bookmaker',    // Online Casino or Bookmaker
  'online_sports_betting',         // Online Sports Betting Vendor
  'betting_agency',                // Betting Agency
  'bookmaker',                     // Bookmaker
  'gambling_service',              // Gambling Service
  'gambling_house',                // Gambling House
  'off_track_betting_shop',        // Off-Track Betting Shop
  'lottery_vendor',                // Lottery Vendor
  'online_lottery_ticket_vendor',  // Online Lottery Ticket Vendor
  'lottery_retailer',              // Lottery Retailer
  'lottery_shop',                  // Lottery Shop
  'gambling_instructor',           // Gambling Instructor
  // ── Gaming ───────────────────────────────────────────────────
  'gaming',                        // Gaming (parent)
  'gaming_service_provider',       // Gaming Service Provider
  'bingo_hall',                    // Bingo Hall
  'video_game_store',              // Video Game Store
  'game_store',                    // Game Store
];

interface Props {
  onSubmit: (params: ScrapeParams) => void;
  loading?: boolean;
}

export default function ScrapeForm({ onSubmit, loading }: Props) {
  const [country, setCountry] = useState('US');
  const [category, setCategory] = useState('casino');
  const [minRating, setMinRating] = useState(1.0);
  const [maxRating, setMaxRating] = useState(3.5);
  const [enrich, setEnrich] = useState(false);
  const [verify, setVerify] = useState(false);
  const [forceRescrape, setForceRescrape] = useState(false);
  // Synchronous click-lock so a burst of clicks can't queue up multiple POSTs
  // before the parent `loading` prop has propagated from status='running'.
  const submittingRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current || loading) return;
    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      onSubmit({ country, category, minRating, maxRating, enrich, verify, forceRescrape });
    } finally {
      // Release after one tick so quick double-clicks are absorbed but the button
      // re-enables as soon as the POST is in flight and `loading` takes over.
      setTimeout(() => {
        submittingRef.current = false;
        setIsSubmitting(false);
      }, 1500);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="bg-white rounded-lg border border-gray-200 p-6">
      <h2 className="text-lg font-semibold mb-4">Scrape Trustpilot</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Country</label>
          <select value={country} onChange={(e) => setCountry(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm">
            {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm">
            {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Star Rating: {minRating} - {maxRating}
          </label>
          <div className="flex gap-2 items-center">
            <input type="number" min={1} max={5} step={0.5} value={minRating}
              onChange={(e) => setMinRating(parseFloat(e.target.value))}
              className="w-20 border border-gray-300 rounded-md px-2 py-2 text-sm" />
            <span className="text-gray-400">to</span>
            <input type="number" min={1} max={5} step={0.5} value={maxRating}
              onChange={(e) => setMaxRating(parseFloat(e.target.value))}
              className="w-20 border border-gray-300 rounded-md px-2 py-2 text-sm" />
          </div>
        </div>
      </div>

      <div className="flex gap-6 mt-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enrich} onChange={(e) => setEnrich(e.target.checked)}
            className="rounded border-gray-300" />
          Enrich from websites
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)}
            className="rounded border-gray-300" />
          Verify emails
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={forceRescrape} onChange={(e) => setForceRescrape(e.target.checked)}
            className="rounded border-gray-300" />
          Force re-scrape
        </label>
      </div>

      <button type="submit" disabled={loading || isSubmitting}
        className="mt-4 inline-flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
        <Search size={16} />
        {loading || isSubmitting ? 'Scraping...' : 'Start Scrape'}
      </button>
    </form>
  );
}
