'use client';

import { useEffect, useState } from 'react';
import { useScrape } from '../hooks/useScrape';
import ScrapeForm from '../components/ScrapeForm';
import ScrapeProgress from '../components/ScrapeProgress';
import type { ScrapeParams } from '../types/scrape';
import api from '../api/client';

export default function Scrape() {
  const {
    jobId, status, progress, error, jobs, failedCount,
    startScrape, cancelJob, retryFailed, fetchJobs, deleteJob, cleanupEmptyJobs,
  } = useScrape();
  const [apiReady, setApiReady] = useState<boolean | null>(null);
  const [cleaning, setCleaning] = useState(false);

  const handleCleanup = async () => {
    if (!confirm('Delete all completed/failed scrape jobs whose country + category has zero leads in the Lead Matrix?')) return;
    setCleaning(true);
    const removed = await cleanupEmptyJobs();
    setCleaning(false);
    alert(removed > 0 ? `Removed ${removed} stale job${removed === 1 ? '' : 's'}.` : 'No stale jobs found.');
  };

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  useEffect(() => {
    api.get('/health').then(() => setApiReady(true)).catch(() => setApiReady(false));
  }, []);

  const handleSubmit = (params: ScrapeParams) => startScrape(params);

  return (
    <div className="px-10 py-10 space-y-8">
      {/* Header */}
      <div className="flex justify-between items-end">
        <div>
          <h2
            className="text-4xl font-extrabold tracking-tight text-on-surface"
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            Lead Scraping <span className="text-[#b0004a]">Dashboard</span>
          </h2>
          <p className="text-secondary mt-1 font-medium">
            Configure and execute high-performance lead extraction from Trustpilot.
          </p>
        </div>
        <span className="px-3 py-1.5 bg-[#ffd9de] text-[#b0004a] text-[10px] font-black rounded-full uppercase tracking-wide">
          Powered by Cloud Run
        </span>
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-12 gap-6">
        {/* Scrape Config */}
        <div className="col-span-8 bg-surface-container-lowest rounded-xl ambient-shadow p-8">
          <div className="flex items-center justify-between mb-8">
            <h3
              className="text-xl font-extrabold text-on-surface"
              style={{ fontFamily: 'Manrope, sans-serif' }}
            >
              Scrape Trustpilot
            </h3>
            <span className={`flex items-center gap-2 text-xs font-bold px-3 py-1.5 rounded-full ${
              status === 'running'
                ? 'bg-[#ffd9de] text-[#b0004a]'
                : status === 'completed'
                  ? 'bg-[#8ff9a8]/30 text-[#006630]'
                  : 'bg-surface-container text-secondary'
            }`}>
              {status === 'running' && (
                <span className="w-1.5 h-1.5 rounded-full bg-[#b0004a] animate-pulse inline-block" />
              )}
              {status === 'running' ? 'Running' : status === 'completed' ? 'Completed' : 'Ready'}
            </span>
          </div>
          <ScrapeForm onSubmit={handleSubmit} loading={status === 'running'} />
        </div>

        {/* Stats Panel */}
        <div className="col-span-4 space-y-4">
          {/* Total scraped */}
          <div className="bg-surface-container-lowest rounded-xl ambient-shadow p-6">
            <div className="flex items-center justify-between mb-4">
              <span className="p-2 bg-[#ffd9de] text-[#b0004a] rounded-lg material-symbols-outlined text-[20px]">
                group
              </span>
            </div>
            <p className="text-slate-500 text-xs font-bold uppercase tracking-wider">Total Jobs Run</p>
            <h4
              className="text-2xl font-black text-on-surface mt-1"
              style={{ fontFamily: 'Manrope, sans-serif' }}
            >
              {jobs.length}
            </h4>
          </div>

          {/* Last job */}
          {jobs.length > 0 && (
            <div className="bg-surface-container-lowest rounded-xl ambient-shadow p-6">
              <div className="flex items-center justify-between mb-4">
                <span className="p-2 bg-[#ffd9de] text-[#b0004a] rounded-lg material-symbols-outlined text-[20px]">
                  history
                </span>
              </div>
              <p className="text-slate-500 text-xs font-bold uppercase tracking-wider">Last Scrape</p>
              <h4
                className="text-base font-black text-on-surface mt-1"
                style={{ fontFamily: 'Manrope, sans-serif' }}
              >
                {jobs[0].category} — {jobs[0].country}
              </h4>
              <p className="text-xs text-secondary mt-1">{jobs[0].total_found} leads found</p>
            </div>
          )}

          {/* Cloud status */}
          <div className="bg-surface-container-lowest rounded-xl ambient-shadow p-6">
            <div className="flex items-center gap-2 mb-2">
              <span className={`w-2 h-2 rounded-full inline-block ${
                apiReady === null ? 'bg-slate-300 animate-pulse' :
                apiReady ? 'bg-[#006630]' : 'bg-[#b0004a]'
              }`} />
              <span className={`text-xs font-bold uppercase tracking-wide ${
                apiReady === null ? 'text-secondary' :
                apiReady ? 'text-[#006630]' : 'text-[#b0004a]'
              }`}>
                Infrastructure {apiReady === null ? 'Checking…' : apiReady ? 'Online' : 'Offline'}
              </span>
            </div>
            <p className="text-xs text-secondary">
              {apiReady === false
                ? 'Cannot reach the API server. Check your connection.'
                : 'Cloud Run container is ready to accept scrape jobs.'}
            </p>
          </div>
        </div>
      </div>

      {/* Progress */}
      {(status || error) && (
        <div className="bg-surface-container-lowest rounded-xl ambient-shadow p-8">
          <h3
            className="text-lg font-bold text-on-surface mb-4"
            style={{ fontFamily: 'Manrope, sans-serif' }}
          >
            Scrape Progress
          </h3>
          <ScrapeProgress
            status={status as 'running' | 'completed' | 'failed' | null}
            progress={progress}
            error={error}
            failedCount={failedCount}
            jobId={jobId}
            startedAt={jobId ? jobs.find((j) => j.id === jobId)?.started_at ?? null : null}
            completedAt={jobId ? jobs.find((j) => j.id === jobId)?.completed_at ?? null : null}
            liveJob={jobId ? (() => {
              const j = jobs.find((jj) => jj.id === jobId);
              return j ? { total_found: j.total_found, total_scraped: j.total_scraped } : null;
            })() : null}
            onCancel={jobId ? () => cancelJob(jobId) : undefined}
            onRetryFailed={jobId ? () => retryFailed(jobId) : undefined}
          />
        </div>
      )}

      {/* Recent Jobs Table */}
      {jobs.length > 0 && (
        <div className="bg-surface-container-lowest rounded-xl ambient-shadow overflow-hidden">
          <div className="px-8 py-6 border-b border-slate-50 flex justify-between items-center">
            <h3
              className="font-bold text-on-surface"
              style={{ fontFamily: 'Manrope, sans-serif' }}
            >
              Recent Scrape Jobs
            </h3>
            <div className="flex items-center gap-4">
              <button
                onClick={handleCleanup}
                disabled={cleaning}
                className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-[#b0004a] hover:text-[#8a003a] disabled:text-slate-300 disabled:cursor-not-allowed transition-colors"
                title="Delete jobs with no leads in the Lead Matrix"
              >
                <span className="material-symbols-outlined text-[16px]">cleaning_services</span>
                {cleaning ? 'Cleaning…' : 'Clean Stale Jobs'}
              </button>
              <span className="text-xs text-secondary font-medium">
                Showing {jobs.length} job{jobs.length !== 1 ? 's' : ''}
              </span>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="bg-slate-50/50">
                  {['Category', 'Country', 'Rating', 'Status', 'Found', 'Scraped', 'Failed', 'Date', ''].map((h, i) => (
                    <th
                      key={h || `col-${i}`}
                      className="px-6 py-4 text-[11px] font-bold uppercase tracking-widest text-slate-400"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {jobs.map((job) => (
                  <tr key={job.id} className="hover:bg-surface-container/40 transition-colors">
                    <td className="px-6 py-4 font-bold text-sm text-on-surface">{job.category}</td>
                    <td className="px-6 py-4 text-sm text-secondary">{job.country}</td>
                    <td className="px-6 py-4 text-sm text-secondary">{job.min_rating}–{job.max_rating}★</td>
                    <td className="px-6 py-4">
                      <span className={`px-2.5 py-1 rounded-full text-[10px] font-black uppercase ${
                        job.status === 'completed' ? 'bg-[#8ff9a8]/30 text-[#006630]' :
                        job.status === 'running'   ? 'bg-[#ffd9de] text-[#b0004a]' :
                        job.status === 'failed'    ? 'bg-error-container text-error' :
                        'bg-surface-container text-secondary'
                      }`}>
                        {job.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm font-medium">{job.total_found}</td>
                    <td className="px-6 py-4 text-sm font-medium">{job.total_scraped}</td>
                    <td className={`px-6 py-4 text-sm font-medium ${job.total_failed ? 'text-error' : 'text-secondary'}`}>
                      {job.total_failed || 0}
                    </td>
                    <td className="px-6 py-4 text-xs text-secondary">
                      {new Date(job.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-4 text-right">
                      {job.status !== 'running' && (
                        <button
                          onClick={() => {
                            if (confirm(`Delete this ${job.category} / ${job.country} scrape job from the list? Leads already saved are kept.`)) {
                              deleteJob(job.id);
                            }
                          }}
                          className="material-symbols-outlined text-[18px] text-slate-300 hover:text-[#b0004a] transition-colors"
                          title="Delete job"
                        >
                          delete
                        </button>
                      )}
                    </td>
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
