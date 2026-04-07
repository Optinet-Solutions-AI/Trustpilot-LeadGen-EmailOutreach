import { useEffect } from 'react';
import { useScrape } from '../hooks/useScrape';
import ScrapeForm from '../components/ScrapeForm';
import ScrapeProgress from '../components/ScrapeProgress';
import type { ScrapeParams } from '../types/scrape';

export default function Scrape() {
  const { status, progress, error, jobs, startScrape, fetchJobs } = useScrape();

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  const handleSubmit = (params: ScrapeParams) => {
    startScrape(params);
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Scrape Trustpilot</h1>
      <ScrapeForm onSubmit={handleSubmit} loading={status === 'running'} />
      <ScrapeProgress status={status as 'running' | 'completed' | 'failed' | null} progress={progress} error={error} />

      {/* Recent Jobs */}
      {jobs.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h2 className="font-semibold mb-3">Recent Scrape Jobs</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-left py-2">Category</th>
                <th className="text-left py-2">Country</th>
                <th className="text-left py-2">Rating</th>
                <th className="text-left py-2">Status</th>
                <th className="text-right py-2">Found</th>
                <th className="text-right py-2">Date</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id} className="border-b">
                  <td className="py-2">{job.category}</td>
                  <td className="py-2">{job.country}</td>
                  <td className="py-2">{job.min_rating}-{job.max_rating}</td>
                  <td className="py-2">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      job.status === 'completed' ? 'bg-green-100 text-green-700' :
                      job.status === 'running' ? 'bg-blue-100 text-blue-700' :
                      job.status === 'failed' ? 'bg-red-100 text-red-700' :
                      'bg-gray-100 text-gray-700'
                    }`}>{job.status}</span>
                  </td>
                  <td className="text-right py-2">{job.total_found}</td>
                  <td className="text-right py-2 text-gray-500">
                    {new Date(job.created_at).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
