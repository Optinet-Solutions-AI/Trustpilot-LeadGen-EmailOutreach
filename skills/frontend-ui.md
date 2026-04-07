# Skill: Professional Frontend UI — Trustpilot LeadGen CRM

## Purpose
When building or improving any frontend component or page in this project, follow these design rules exactly. The goal is a clean, data-dense CRM that feels like a professional SaaS tool — not a generic template.

---

## Design Principles

1. **Data-dense, not spacious** — This is a CRM. Show more data, not whitespace.
2. **Consistent sidebar layout** — All pages live inside `<Layout>` with `<Sidebar>`. Never full-page without sidebar.
3. **Dark indigo primary** — `indigo-600` for buttons, active states, badges.
4. **Status colors are sacred** — Never change the color mapping for `outreach_status`.
5. **Tables over cards** — Prefer tables for leads/campaigns. Cards only for summary stats.
6. **Mobile-aware but desktop-first** — CRM users are on desktop. Optimize for 1440px.

---

## Color System

```
Primary:      indigo-600 (#4F46E5)
Primary hover: indigo-700
Primary light: indigo-50 (backgrounds, hover rows)

Status — New:        gray-100 text-gray-600
Status — Contacted:  blue-100 text-blue-700
Status — Replied:    yellow-100 text-yellow-700
Status — Converted:  green-100 text-green-700
Status — Lost:       red-100 text-red-600

Danger:       red-600
Warning:      amber-500
Success:      emerald-500
Neutral bg:   gray-50
Card bg:      white
Border:       gray-200
Text primary: gray-900
Text muted:   gray-500
```

---

## Typography

```
Page title:    text-2xl font-bold text-gray-900
Section title: text-lg font-semibold text-gray-900
Table header:  text-xs font-medium text-gray-500 uppercase tracking-wider
Body text:     text-sm text-gray-700
Muted text:    text-xs text-gray-400
Badge text:    text-xs font-medium px-2.5 py-0.5 rounded-full
```

---

## Component Patterns

### Page Layout
```tsx
<div className="flex h-screen bg-gray-50">
  <Sidebar />
  <div className="flex-1 overflow-auto">
    <div className="p-6 max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Page Title</h1>
      {/* content */}
    </div>
  </div>
</div>
```

### Stat Cards (StatsRow)
```tsx
<div className="grid grid-cols-4 gap-4 mb-6">
  <div className="bg-white rounded-lg border border-gray-200 p-4">
    <p className="text-sm text-gray-500">Label</p>
    <p className="text-3xl font-bold text-gray-900 mt-1">{value}</p>
    <p className="text-xs text-gray-400 mt-1">subtitle</p>
  </div>
</div>
```

### Table
```tsx
<div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
  <table className="w-full text-sm">
    <thead className="bg-gray-50 border-b border-gray-200">
      <tr>
        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
          Column
        </th>
      </tr>
    </thead>
    <tbody className="divide-y divide-gray-100">
      <tr className="hover:bg-indigo-50 transition-colors cursor-pointer">
        <td className="px-4 py-3 text-gray-900">value</td>
      </tr>
    </tbody>
  </table>
</div>
```

### Filter Bar
```tsx
<div className="flex gap-3 mb-4 flex-wrap">
  <input
    className="border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
    placeholder="Search..."
  />
  <select className="border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500">
    <option value="">All Countries</option>
  </select>
</div>
```

### Primary Button
```tsx
<button className="bg-indigo-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-indigo-700 transition-colors">
  Action
</button>
```

### Secondary Button
```tsx
<button className="border border-gray-300 text-gray-700 px-4 py-2 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors">
  Action
</button>
```

### Danger Button
```tsx
<button className="bg-red-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-red-700">
  Delete
</button>
```

### Status Badge (StatusBadge.tsx)
```tsx
const STATUS_STYLES = {
  new:        'bg-gray-100 text-gray-600',
  contacted:  'bg-blue-100 text-blue-700',
  replied:    'bg-yellow-100 text-yellow-700',
  converted:  'bg-green-100 text-green-700',
  lost:       'bg-red-100 text-red-600',
};
<span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[status]}`}>
  {status}
</span>
```

### Category Pill
```tsx
<span className="bg-gray-100 text-gray-600 text-xs px-2 py-0.5 rounded-full">
  {category.replace(/_/g, ' ')}
</span>
```

### Form Input Group
```tsx
<div className="mb-4">
  <label className="block text-sm font-medium text-gray-700 mb-1">Label</label>
  <input className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
</div>
```

### Card Panel (for sections)
```tsx
<div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
  <h2 className="text-lg font-semibold text-gray-900 mb-4">Section</h2>
  {/* content */}
</div>
```

### AI Generate Button
```tsx
<button
  onClick={handleGeminiGenerate}
  disabled={generating}
  className="flex items-center gap-2 border border-indigo-300 text-indigo-700 bg-indigo-50 px-4 py-2 rounded-md text-sm font-medium hover:bg-indigo-100 transition-colors disabled:opacity-50"
>
  <Sparkles className="w-4 h-4" />
  {generating ? 'Generating...' : 'Generate with AI'}
</button>
```

---

## Kanban Board

5 columns, equal width, horizontal scroll on overflow.

```tsx
<div className="flex gap-4 overflow-x-auto pb-4">
  {COLUMNS.map(col => (
    <div key={col.id} className="flex-shrink-0 w-72">
      <div className="bg-gray-100 rounded-lg p-3">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">{col.label}</h3>
        <div className="space-y-2">
          {/* cards */}
        </div>
      </div>
    </div>
  ))}
</div>
```

Kanban card:
```tsx
<div className="bg-white rounded-md border border-gray-200 p-3 shadow-sm hover:shadow-md cursor-grab transition-shadow">
  <p className="font-medium text-sm text-gray-900 truncate">{lead.company_name}</p>
  <p className="text-xs text-gray-400 mt-1">{lead.country} · ★{lead.star_rating}</p>
  {lead.primary_email && (
    <p className="text-xs text-gray-500 mt-1 truncate">{lead.primary_email}</p>
  )}
</div>
```

---

## Loading States

```tsx
// Skeleton row
<tr className="animate-pulse">
  <td className="px-4 py-3"><div className="h-4 bg-gray-200 rounded w-32" /></td>
  <td className="px-4 py-3"><div className="h-4 bg-gray-200 rounded w-16" /></td>
</tr>

// Spinner
<div className="flex items-center justify-center p-8">
  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
</div>
```

---

## Rules When Editing UI

1. **Never hardcode colors** — use Tailwind classes from the color system above
2. **Never add margin to Layout** — padding is inside each page component
3. **Always use `text-sm` for table content** — consistent density
4. **Always handle loading + error + empty states** in any data-fetching component
5. **Recharts only** for charts — already installed, use `ResponsiveContainer` for all
6. **Lucide React only** for icons — already installed
7. **Never add `useEffect` for derived state** — compute it inline from existing state
8. **Forms submit via hook** — never call `fetch()` directly from a component

---

## Gemini AI in CampaignBuilder

The "Generate with AI" button calls `frontend/src/lib/gemini.ts`.

Provide context: target country, target category, star rating range, and brand name (OptiRate).  
Expected output: professional HTML email body with `{{company_name}}`, `{{star_rating}}`, `{{review_count}}` tokens.  
On success: populate the body textarea. On error: show toast "AI generation failed, try again."
