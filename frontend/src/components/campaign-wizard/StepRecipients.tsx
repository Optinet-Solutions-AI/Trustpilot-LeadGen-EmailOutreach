import { useEffect, useState } from 'react';
import { Loader2, AlertTriangle, Users } from 'lucide-react';
import { COUNTRIES, CATEGORIES } from './StepSetup';

interface Props {
  filterCountry: string;
  filterCategory: string;
  previewRecipients: (filters: { country?: string; category?: string }) => Promise<{
    count: number;
    sample: Array<{ id: string; company_name: string; primary_email: string; star_rating: number }>;
  }>;
}

export default function StepRecipients({ filterCountry, filterCategory, previewRecipients }: Props) {
  const [loading, setLoading] = useState(true);
  const [count, setCount] = useState(0);
  const [sample, setSample] = useState<Array<{ id: string; company_name: string; primary_email: string; star_rating: number }>>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');
    previewRecipients({
      country: filterCountry || undefined,
      category: filterCategory || undefined,
    })
      .then((result) => {
        setCount(result.count);
        setSample(result.sample);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to preview recipients'))
      .finally(() => setLoading(false));
  }, [filterCountry, filterCategory, previewRecipients]);

  const countryName = COUNTRIES.find((c) => c.code === filterCountry)?.name;
  const categoryName = CATEGORIES.find((c) => c.slug === filterCategory)?.name;
  const filterLabel = [countryName, categoryName].filter(Boolean).join(' + ') || 'All leads';

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-400 gap-2">
        <Loader2 size={18} className="animate-spin" /> Loading recipients...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-16 text-red-500 gap-2">
        <AlertTriangle size={18} /> {error}
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-2xl mx-auto">
      <div>
        <h3 className="text-lg font-semibold mb-1">Recipients</h3>
        <p className="text-sm text-gray-500">Review the leads that will be included in this campaign.</p>
      </div>

      {/* Count card */}
      <div className={`p-6 rounded-xl border text-center ${
        count > 0 ? 'bg-blue-50 border-blue-200' : 'bg-yellow-50 border-yellow-200'
      }`}>
        <div className="flex items-center justify-center gap-2 mb-2">
          <Users size={20} className={count > 0 ? 'text-blue-600' : 'text-yellow-600'} />
          <span className={`text-3xl font-bold ${count > 0 ? 'text-blue-700' : 'text-yellow-700'}`}>{count}</span>
        </div>
        <p className={`text-sm font-medium ${count > 0 ? 'text-blue-600' : 'text-yellow-700'}`}>
          {count > 0
            ? `leads matching "${filterLabel}" with a valid email`
            : `No leads found matching "${filterLabel}"`}
        </p>
        {count === 0 && (
          <p className="text-xs text-yellow-600 mt-2">
            Go back to Step 1 and adjust your filters, or scrape more leads first.
          </p>
        )}
      </div>

      {/* Sample table */}
      {sample.length > 0 && (
        <div>
          <p className="text-xs text-gray-500 mb-2 font-medium">Sample leads (first {sample.length} of {count}):</p>
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b text-left text-xs text-gray-500">
                  <th className="px-4 py-2.5 font-medium">Company</th>
                  <th className="px-4 py-2.5 font-medium">Email</th>
                  <th className="px-4 py-2.5 font-medium text-right">Rating</th>
                </tr>
              </thead>
              <tbody>
                {sample.map((lead) => (
                  <tr key={lead.id} className="border-b last:border-b-0 hover:bg-gray-50">
                    <td className="px-4 py-2.5 font-medium text-gray-800">{lead.company_name}</td>
                    <td className="px-4 py-2.5 text-gray-500 text-xs">{lead.primary_email}</td>
                    <td className="px-4 py-2.5 text-right text-gray-600">{lead.star_rating} ★</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
