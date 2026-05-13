'use client';

import { useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { ScrapeParams } from '../types/scrape';
import CountryPicker from './CountryPicker';
import CategoryPicker from './CategoryPicker';
import Button from '../ui/Button';
import Toggle from '../ui/Toggle';
import RangeInput from '../ui/RangeInput';

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
  // Synchronous click-lock so a burst of clicks can't queue multiple POSTs
  // before the parent's loading state has propagated.
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
      setTimeout(() => {
        submittingRef.current = false;
        setIsSubmitting(false);
      }, 1500);
    }
  };

  const busy = !!(loading || isSubmitting);

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-medium text-on-surface mb-1.5" htmlFor="scrape-country">
            Country
          </label>
          <CountryPicker id="scrape-country" value={country} onChange={setCountry} disabled={busy} />
        </div>
        <div>
          <label className="block text-sm font-medium text-on-surface mb-1.5" htmlFor="scrape-category">
            Category
          </label>
          <CategoryPicker id="scrape-category" value={category} onChange={setCategory} disabled={busy} />
        </div>
        <RangeInput
          label="Star rating"
          suffix="★"
          value={[minRating, maxRating]}
          onChange={([lo, hi]) => {
            setMinRating(lo);
            setMaxRating(hi);
          }}
          min={1}
          max={5}
          step={0.5}
          disabled={busy}
        />
      </div>

      <div className="flex flex-col sm:flex-row sm:flex-wrap gap-3 sm:gap-6">
        <Toggle
          checked={enrich}
          onChange={(e) => setEnrich(e.target.checked)}
          disabled={busy}
          label="Enrich from websites"
          description="Visit each company's site to find a primary email"
        />
        <Toggle
          checked={verify}
          onChange={(e) => setVerify(e.target.checked)}
          disabled={busy}
          label="Verify emails"
          description="Run ZeroBounce on each discovered email"
        />
        <Toggle
          checked={forceRescrape}
          onChange={(e) => setForceRescrape(e.target.checked)}
          disabled={busy}
          label="Force re-scrape"
          description="Bypass the duplicate-job guard"
        />
      </div>

      <div className="pt-1">
        <Button
          type="submit"
          variant="primary"
          size="md"
          loading={busy}
          leadingIcon={<Search size={16} />}
        >
          {busy ? 'Scraping…' : 'Start scrape'}
        </Button>
      </div>
    </form>
  );
}
