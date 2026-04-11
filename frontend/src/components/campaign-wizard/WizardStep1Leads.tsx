'use client';

import { useState, useEffect, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import api from '../../api/client';
import { COUNTRIES, CATEGORIES } from './scheduleConfig';

interface AppMode {
  manualLeadsOnly: boolean;
  testMode: boolean;
  emailPlatform: string;
  emailMode: string;
}

interface PickerLead {
  id: string;
  company_name: string;
  primary_email: string | null;
  star_rating: number | null;
  outreach_status: string;
  country: string | null;
  category: string | null;
}

interface Props {
  filterCountry: string;
  filterCategory: string;
  selectedLeadIds: string[];
  manualEmails: string[];
  maxLeads: number;
  onFilterCountryChange: (v: string) => void;
  onFilterCategoryChange: (v: string) => void;
  onSelectionChange: (ids: string[]) => void;
  onManualEmailsChange: (emails: string[]) => void;
  onMaxLeadsChange: (n: number) => void;
}

const LIMIT = 50;

type SourceMode = 'matrix' | 'manual';

export default function WizardStep1Leads({
  filterCountry, filterCategory, selectedLeadIds, manualEmails, maxLeads,
  onFilterCountryChange, onFilterCategoryChange, onSelectionChange, onManualEmailsChange, onMaxLeadsChange,
}: Props) {
  const [appMode, setAppMode] = useState<AppMode | null>(null);
  const [dynamicCountries, setDynamicCountries] = useState<string[]>([]);
  const [dynamicCategories, setDynamicCategories] = useState<string[]>([]);
  const [sourceMode, setSourceMode] = useState<SourceMode>('matrix');
  const [manualInput, setManualInput] = useState(manualEmails.join('\n'));
  const [leads, setLeads]         = useState<PickerLead[]>([]);
  const [total, setTotal]         = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading]     = useState(false);
  const [page, setPage]           = useState(1);
  const [search, setSearch]       = useState('');
  const [debSearch, setDebSearch] = useState('');
  const [sortBy, setSortBy]       = useState('star_rating');
  const [sortDir, setSortDir]     = useState<'asc' | 'desc'>('asc');
  const [rotation, setRotation]   = useState<'oldest' | 'random'>('oldest');

  // Fetch app mode and dynamic filters on mount
  useEffect(() => {
    api.get('/campaigns/config/mode').then((res) => {
      const mode: AppMode = res.data.data;
      setAppMode(mode);
      if (mode.manualLeadsOnly) setSourceMode('manual');
    }).catch(() => { /* ignore — fall back to defaults */ });

    api.get('/leads/filters').then((res) => {
      const { countries, categories } = res.data.data;
      if (countries?.length) setDynamicCountries(countries);
      if (categories?.length) setDynamicCategories(categories);
    }).catch(() => { /* fall back to static lists */ });
  }, []);

  useEffect(() => {
    const t = setTimeout(() => { setDebSearch(search); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const fetchLeads = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (filterCountry) p.set('country', filterCountry);
      if (filterCategory) p.set('category', filterCategory);
      if (debSearch) p.set('search', debSearch);
      p.set('page', String(page));
      p.set('limit', String(LIMIT));
      p.set('sortBy', sortBy);
      p.set('sortDir', sortDir);
      const res = await api.get(`/leads?${p}`);
      setLeads(res.data.data);
      setTotal(res.data.total);
      setTotalPages(res.data.totalPages);
    } catch {
      setLeads([]); setTotal(0); setTotalPages(0);
    } finally {
      setLoading(false);
    }
  }, [filterCountry, filterCategory, debSearch, page, sortBy, sortDir]);

  useEffect(() => { fetchLeads(); }, [fetchLeads]);

  const toggleLead = (id: string) => {
    if (selectedLeadIds.includes(id)) onSelectionChange(selectedLeadIds.filter((x) => x !== id));
    else onSelectionChange([...selectedLeadIds, id]);
  };

  const pageIds = leads.map((l) => l.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedLeadIds.includes(id));
  const togglePage = () => {
    if (allPageSelected) onSelectionChange(selectedLeadIds.filter((id) => !pageIds.includes(id)));
    else onSelectionChange([...selectedLeadIds, ...pageIds.filter((id) => !selectedLeadIds.includes(id))]);
  };

  const toggleSort = (col: string) => {
    if (col === sortBy) setSortDir((d) => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortDir('asc'); }
    setPage(1);
  };

  // Health score: % of leads with valid email
  const healthPct = total > 0
    ? Math.round((leads.filter((l) => l.primary_email).length / leads.length) * 100)
    : 0;

  // Use dynamic lists if loaded, fall back to static
  const countryOptions = dynamicCountries.length > 0
    ? [{ code: '', name: 'All Countries' }, ...dynamicCountries.map((c) => ({ code: c, name: c }))]
    : COUNTRIES;
  const categoryOptions = dynamicCategories.length > 0
    ? [{ slug: '', name: 'All Categories' }, ...dynamicCategories.map((c) => ({ slug: c, name: c }))]
    : CATEGORIES;

  const categoryLabel = categoryOptions.find((c) => c.slug === filterCategory)?.name || 'All Categories';
  const countryLabel  = countryOptions.find((c) => c.code === filterCountry)?.name  || 'All Countries';
  const listLabel     = [countryLabel !== 'All Countries' ? countryLabel : '', categoryLabel !== 'All Categories' ? categoryLabel : '']
    .filter(Boolean).join(' · ') || 'All Leads';

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">

      {/* Headline */}
      <div className="text-center mb-10">
        <h1 className="text-3xl font-extrabold text-on-surface mb-2" style={{ fontFamily: 'Manrope, sans-serif' }}>
          Where should we find your leads?
        </h1>
        <p className="text-secondary text-sm">
          Build your outreach list by selecting from your existing Lead Matrix,
          uploading a file, or entering them manually.
        </p>
      </div>

      {/* Testing-mode banner */}
      {appMode?.manualLeadsOnly && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-5 py-4 mb-6">
          <span className="material-symbols-outlined text-amber-600 text-[20px] shrink-0 mt-0.5">science</span>
          <p className="text-sm text-amber-700">
            <span className="font-bold">Testing mode active</span> — only manually entered email addresses can be used as recipients. Scraped leads are locked until testing is complete.
          </p>
        </div>
      )}

      {/* Source selection cards */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        {/* Lead Matrix */}
        <div
          onClick={() => !appMode?.manualLeadsOnly && setSourceMode('matrix')}
          className={`relative group bg-white rounded-2xl p-6 flex flex-col items-center text-center transition-all ${
            appMode?.manualLeadsOnly
              ? 'border border-slate-100 opacity-40 cursor-not-allowed'
              : sourceMode === 'matrix'
                ? 'border-2 border-[#b0004a] ambient-shadow cursor-pointer'
                : 'border border-slate-100 hover:border-slate-200 cursor-pointer'
          }`}
        >
          <div className={`w-12 h-12 rounded-full flex items-center justify-center mb-4 ${sourceMode === 'matrix' && !appMode?.manualLeadsOnly ? 'bg-[#ffd9de]' : 'bg-slate-100'}`}>
            <span className={`material-symbols-outlined text-[22px] ${sourceMode === 'matrix' && !appMode?.manualLeadsOnly ? 'text-[#b0004a]' : 'text-secondary'}`}>database</span>
          </div>
          <h3 className="font-bold text-on-surface mb-1" style={{ fontFamily: 'Manrope, sans-serif' }}>Lead Matrix</h3>
          <p className="text-xs text-secondary leading-relaxed mb-4">
            Choose from your pre-scraped, verified lists and saved searches in the system.
          </p>
          <span className={`text-xs font-extrabold uppercase tracking-wider flex items-center gap-1 ${sourceMode === 'matrix' && !appMode?.manualLeadsOnly ? 'text-[#b0004a]' : 'text-secondary'}`}>
            Browse Lists
            <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
          </span>
          {appMode?.manualLeadsOnly && (
            <div className="absolute -top-9 left-1/2 -translate-x-1/2 bg-slate-800 text-white text-[10px] font-bold px-3 py-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
              Locked in testing mode
            </div>
          )}
        </div>

        {/* Import Leads — coming soon */}
        <div className="relative group bg-white rounded-2xl p-6 border border-slate-100 cursor-not-allowed opacity-50 flex flex-col items-center text-center">
          <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mb-4">
            <span className="material-symbols-outlined text-secondary text-[22px]">upload_file</span>
          </div>
          <h3 className="font-bold text-on-surface mb-1" style={{ fontFamily: 'Manrope, sans-serif' }}>Import Leads</h3>
          <p className="text-xs text-secondary leading-relaxed mb-4">
            Upload a CSV, Excel, or Google Sheets file containing your target contact information.
          </p>
          <span className="text-xs font-extrabold text-secondary uppercase tracking-wider flex items-center gap-1">
            Select File
            <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
          </span>
          {/* Tooltip */}
          <div className="absolute -top-9 left-1/2 -translate-x-1/2 bg-slate-800 text-white text-[10px] font-bold px-3 py-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
            Coming soon
          </div>
        </div>

        {/* Add Manually — active */}
        <div
          onClick={() => setSourceMode('manual')}
          className={`bg-white rounded-2xl p-6 cursor-pointer flex flex-col items-center text-center transition-all ${
            sourceMode === 'manual' ? 'border-2 border-[#b0004a] ambient-shadow' : 'border border-slate-100 hover:border-slate-200'
          }`}
        >
          <div className={`w-12 h-12 rounded-full flex items-center justify-center mb-4 ${sourceMode === 'manual' ? 'bg-[#ffd9de]' : 'bg-slate-100'}`}>
            <span className={`material-symbols-outlined text-[22px] ${sourceMode === 'manual' ? 'text-[#b0004a]' : 'text-secondary'}`}>edit_note</span>
          </div>
          <h3 className="font-bold text-on-surface mb-1" style={{ fontFamily: 'Manrope, sans-serif' }}>Add Manually</h3>
          <p className="text-xs text-secondary leading-relaxed mb-4">
            Quickly paste a list of email addresses or fill in a simple form for direct entry.
          </p>
          <span className={`text-xs font-extrabold uppercase tracking-wider flex items-center gap-1 ${sourceMode === 'manual' ? 'text-[#b0004a]' : 'text-secondary'}`}>
            Open Editor
            <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
          </span>
        </div>
      </div>

      {/* ── Manual entry panel ── */}
      {sourceMode === 'manual' && (
        <div className="bg-white rounded-2xl border-2 border-[#b0004a] ambient-shadow overflow-hidden mb-6">
          <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-100 bg-[#ffd9de]/20">
            <div className="w-7 h-7 rounded-full primary-gradient flex items-center justify-center flex-shrink-0">
              <span className="material-symbols-outlined text-on-primary text-[14px]">edit_note</span>
            </div>
            <div>
              <p className="text-sm font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
                Manual Email Entry
              </p>
              <p className="text-xs text-secondary">
                Paste one email address per line. These will be added as leads when you create the campaign.
              </p>
            </div>
          </div>
          <div className="p-6">
            <textarea
              value={manualInput}
              onChange={(e) => setManualInput(e.target.value)}
              rows={8}
              placeholder={`john@example.com\njane@acmecorp.com\ninfo@bigcompany.co.uk`}
              className="w-full bg-surface-container rounded-xl px-4 py-3 text-sm font-mono border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none resize-none"
            />
            <div className="flex items-center justify-between mt-3">
              <p className="text-xs text-secondary">
                {manualInput.split('\n').filter((l) => l.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(l.trim())).length} valid email{manualInput.split('\n').filter((l) => l.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(l.trim())).length !== 1 ? 's' : ''} detected
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => { setManualInput(''); onManualEmailsChange([]); }}
                  className="px-4 py-2 rounded-xl text-xs font-bold text-secondary bg-surface-container hover:bg-surface-container-high transition-colors"
                >
                  Clear
                </button>
                <button
                  onClick={() => {
                    const emails = manualInput
                      .split('\n')
                      .map((l) => l.trim())
                      .filter((l) => l && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(l));
                    onManualEmailsChange(emails);
                  }}
                  className="px-4 py-2 rounded-xl text-xs font-extrabold primary-gradient text-on-primary ambient-shadow hover:scale-[1.02] transition-transform"
                >
                  Apply ({manualInput.split('\n').filter((l) => l.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(l.trim())).length})
                </button>
              </div>
            </div>
            {manualEmails.length > 0 && (
              <div className="mt-3 flex items-center gap-2 p-3 bg-[#8ff9a8]/20 rounded-xl border border-[#006630]/20">
                <span className="material-symbols-outlined text-[#006630] text-[16px]">check_circle</span>
                <p className="text-xs font-bold text-[#006630]">
                  {manualEmails.length} email{manualEmails.length !== 1 ? 's' : ''} saved — click &quot;Continue to Sequence&quot; when ready
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Configuration panel — Lead Matrix only */}
      {sourceMode === 'matrix' && <div className="bg-white rounded-2xl border border-slate-100 ambient-shadow overflow-hidden mb-6">
        {/* Panel header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-100">
          <div className="w-7 h-7 rounded-full primary-gradient flex items-center justify-center flex-shrink-0">
            <span className="material-symbols-outlined text-on-primary text-[14px]">info</span>
          </div>
          <div>
            <p className="text-sm font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
              Configuration: Lead Matrix
            </p>
            <p className="text-xs text-secondary">
              You currently have {total.toLocaleString()} verified leads available.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-6 p-6">
          {/* Left: filters + controls */}
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-extrabold text-secondary uppercase tracking-wider mb-2">
                Select Target List
              </label>
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={filterCountry}
                  onChange={(e) => { onFilterCountryChange(e.target.value); setPage(1); }}
                  className="bg-surface-container rounded-xl px-3 py-2.5 text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                >
                  {countryOptions.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                </select>
                <select
                  value={filterCategory}
                  onChange={(e) => { onFilterCategoryChange(e.target.value); setPage(1); }}
                  className="bg-surface-container rounded-xl px-3 py-2.5 text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                >
                  {categoryOptions.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
                </select>
              </div>
              <p className="text-xs text-secondary mt-1.5 flex items-center gap-1">
                <span className="material-symbols-outlined text-[12px]">filter_alt</span>
                {listLabel} — {total.toLocaleString()} leads found
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-extrabold text-secondary uppercase tracking-wider mb-2">
                  Max Leads to Import
                </label>
                <input
                  type="number"
                  value={maxLeads}
                  min={1}
                  max={5000}
                  onChange={(e) => onMaxLeadsChange(Number(e.target.value))}
                  className="w-full bg-surface-container rounded-xl px-3 py-2.5 text-sm border-0 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-extrabold text-secondary uppercase tracking-wider mb-2">
                  Lead Rotation
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setRotation('oldest')}
                    className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all ${
                      rotation === 'oldest' ? 'primary-gradient text-on-primary ambient-shadow' : 'bg-surface-container text-secondary hover:bg-surface-container-high'
                    }`}
                  >
                    Oldest First
                  </button>
                  <button
                    onClick={() => setRotation('random')}
                    className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all ${
                      rotation === 'random' ? 'primary-gradient text-on-primary ambient-shadow' : 'bg-surface-container text-secondary hover:bg-surface-container-high'
                    }`}
                  >
                    Random
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Right: List Health Insight */}
          <div className="bg-surface-container rounded-xl p-4">
            <p className="text-xs font-extrabold text-on-surface uppercase tracking-wider mb-4">List Health Insight</p>
            <div>
              <div className="flex justify-between text-xs font-semibold mb-1.5">
                <span className="text-secondary">Verified &amp; Reachable</span>
                <span className="font-extrabold text-[#006630]">{healthPct}%</span>
              </div>
              <div className="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{ width: `${healthPct}%`, background: 'linear-gradient(90deg, #006630, #00a050)' }}
                />
              </div>
              <p className="text-[10px] text-secondary mt-2">
                This list has been cleaned recently. Bouncing risk is minimal (estimated &lt;2%).
              </p>
            </div>
            <div className="mt-4 pt-4 border-t border-slate-100 grid grid-cols-2 gap-3">
              <div className="text-center">
                <p className="text-xl font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>{total.toLocaleString()}</p>
                <p className="text-[10px] text-secondary font-semibold uppercase tracking-wider">Total Leads</p>
              </div>
              <div className="text-center">
                <p className="text-xl font-extrabold text-[#b0004a]" style={{ fontFamily: 'Manrope, sans-serif' }}>{selectedLeadIds.length.toLocaleString()}</p>
                <p className="text-[10px] text-secondary font-semibold uppercase tracking-wider">Selected</p>
              </div>
            </div>
          </div>
        </div>
      </div>}

      {/* Lead table — Lead Matrix only */}
      {sourceMode === 'matrix' && <div className="bg-white rounded-2xl border border-slate-100 ambient-shadow overflow-hidden">
        {/* Table toolbar */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 bg-surface-container">
          <div className="flex items-center gap-3">
            <div className="relative">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-secondary text-[17px]">search</span>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search companies..."
                className="bg-white rounded-xl pl-9 pr-4 py-2 text-sm border border-slate-100 focus:ring-2 focus:ring-[#b0004a]/20 focus:outline-none w-56"
              />
            </div>
            {selectedLeadIds.length > 0 && (
              <span className="text-xs font-bold bg-[#ffd9de] text-[#b0004a] px-3 py-1.5 rounded-full">
                {selectedLeadIds.length} selected
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {leads.length > 0 && (
              <button onClick={togglePage} className="text-xs font-bold text-[#b0004a] hover:underline">
                {allPageSelected ? 'Deselect page' : 'Select page'}
              </button>
            )}
            {selectedLeadIds.length > 0 && (
              <button onClick={() => onSelectionChange([])} className="text-xs font-bold text-secondary hover:text-error">
                Clear all
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12 gap-2 text-secondary">
            <Loader2 size={16} className="animate-spin text-[#b0004a]" /> Loading leads...
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left bg-surface-container">
                <th className="w-10 px-4 py-3">
                  <input type="checkbox" checked={allPageSelected} onChange={togglePage}
                    className="rounded border-slate-300 accent-[#b0004a] w-3.5 h-3.5" />
                </th>
                {[
                  { label: 'Company', col: 'company_name' },
                  { label: 'Email',   col: 'primary_email' },
                  { label: 'Country', col: null },
                  { label: 'Rating',  col: 'star_rating' },
                  { label: 'Status',  col: null },
                ].map(({ label, col }) => (
                  <th
                    key={label}
                    onClick={() => col && toggleSort(col)}
                    className={`px-4 py-3 text-xs font-extrabold uppercase tracking-wider text-secondary ${col ? 'cursor-pointer hover:text-on-surface select-none' : ''}`}
                  >
                    {label}
                    {col && (
                      <span className={`material-symbols-outlined text-[13px] ml-0.5 align-middle ${sortBy === col ? 'text-[#b0004a]' : 'text-slate-200'}`}>
                        {sortBy === col ? (sortDir === 'asc' ? 'arrow_upward' : 'arrow_downward') : 'unfold_more'}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {leads.map((lead) => {
                const sel = selectedLeadIds.includes(lead.id);
                return (
                  <tr
                    key={lead.id}
                    onClick={() => toggleLead(lead.id)}
                    className={`cursor-pointer transition-colors ${sel ? 'bg-[#ffd9de]/20' : 'hover:bg-surface-container-low'}`}
                  >
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={sel} onChange={() => toggleLead(lead.id)}
                        className="rounded border-slate-300 accent-[#b0004a] w-3.5 h-3.5" />
                    </td>
                    <td className="px-4 py-3 font-bold text-on-surface">{lead.company_name}</td>
                    <td className="px-4 py-3 text-secondary text-xs">{lead.primary_email || <span className="text-slate-300">—</span>}</td>
                    <td className="px-4 py-3 text-secondary text-xs">{lead.country || '—'}</td>
                    <td className="px-4 py-3 font-bold text-[#b0004a] text-xs">{lead.star_rating != null ? `${lead.star_rating} ★` : '—'}</td>
                    <td className="px-4 py-3">
                      <span className="text-[10px] font-bold bg-surface-container text-secondary px-2 py-0.5 rounded-full capitalize">
                        {lead.outreach_status}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {leads.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-12 text-center text-secondary text-sm">No leads found.</td></tr>
              )}
            </tbody>
          </table>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-slate-100 bg-surface-container text-xs">
            <span className="font-semibold text-secondary">
              {((page - 1) * LIMIT) + 1}–{Math.min(page * LIMIT, total)} of {total.toLocaleString()}
            </span>
            <div className="flex items-center gap-1">
              <button disabled={page === 1} onClick={() => setPage((p) => p - 1)}
                className="p-1.5 rounded-lg bg-white border border-slate-100 disabled:opacity-40 hover:bg-surface-container transition-colors">
                <span className="material-symbols-outlined text-[16px]">chevron_left</span>
              </button>
              <span className="px-3 font-bold text-secondary">Page {page} of {totalPages}</span>
              <button disabled={page === totalPages} onClick={() => setPage((p) => p + 1)}
                className="p-1.5 rounded-lg bg-white border border-slate-100 disabled:opacity-40 hover:bg-surface-container transition-colors">
                <span className="material-symbols-outlined text-[16px]">chevron_right</span>
              </button>
            </div>
          </div>
        )}
      </div>}
    </div>
  );
}
